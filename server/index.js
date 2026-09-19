/**
 * index.js - process entry point.
 *   npm start  ->  http://localhost:3000
 */
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig, llmStatus } from './config.js';
import { createStore } from './store.js';
import { createLLM } from './llm/index.js';
import { createOrchestrator } from './core/orchestrator.js';
import { createApp } from './routes.js';

const HOST = '127.0.0.1';

export function findAvailablePort(startPort, maxAttempts = 20, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attempts) => {
      const server = net.createServer();
      server.unref();

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
          tryPort(port + 1, attempts + 1);
          return;
        }
        reject(err);
      });

      server.listen(port, host, () => {
        const actualPort = server.address().port;
        server.close(() => resolve(actualPort));
      });
    };

    tryPort(startPort, 0);
  });
}

export function build({ config = defaultConfig, llm } = {}) {
  const store = createStore(config.dataDir);
  const model = llm || createLLM(config); // one facade => one shared concurrency limiter
  const orchestrator = createOrchestrator({ store, llm: model, config });
  const app = createApp({ config, store, orchestrator, llm: model });
  return { app, store, orchestrator, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, store, config } = build();
  const recovered = store.recoverInterrupted();
  const pruned = store.prune(config.retentionDays);
  const status = llmStatus(config);

  const startServer = async () => {
    const port = await findAvailablePort(config.port, 20, HOST).catch((err) => {
      console.error(`Unable to bind to port ${config.port}: ${err.message}`);
      process.exit(1);
    });

    if (port !== config.port) {
      console.warn(`Port ${config.port} is busy; starting on ${port} instead.`);
      config.port = port;
    }

    app.listen(config.port, HOST, () => {
      console.log(`Ops Coordinator listening on http://${HOST}:${config.port}`);
      console.log(`LLM provider: ${config.provider} | models: intake=${config.models.intake} planning=${config.models.planning} review=${config.models.review}`);
      if (!status.ready) console.warn(`WARNING: ${status.reason}`);
      if (config.provider === 'mock') console.warn('WARNING: LLM_PROVIDER=mock - outputs are NOT from a real language model.');
      if (recovered) console.log(`Recovered ${recovered} interrupted run(s) - users can press Resume.`);
      if (pruned) console.log(`Pruned ${pruned} old session(s).`);
    });
  };

  startServer();
}
