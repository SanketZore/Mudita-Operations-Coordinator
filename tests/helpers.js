/** Shared test helpers: isolated config/data dir, LLM call counters, sample loader. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, ROOT } from '../server/config.js';
import { createLLM } from '../server/llm/index.js';
import { build } from '../server/index.js';

export const sample = (name = 'beacon_launch') => JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', `${name}.json`), 'utf8'));

export function makeApp(envOverrides = {}, wrapLLM) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));
  const config = readConfig({ LLM_PROVIDER: 'mock', DATA_DIR: dataDir, LLM_RETRY_BASE_DELAY_MS: '1', ...envOverrides });
  const base = createLLM(config);
  const calls = { intake: 0, planning: 0, review: 0, total: 0 };
  const counted = {
    ...base,
    async call(req) {
      calls[req.agent] += 1;
      calls.total += 1;
      return wrapLLM ? wrapLLM(base, req) : base.call(req);
    },
  };
  const built = build({ config, llm: counted });
  return { ...built, calls, dataDir, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

/** Create a session + run from a sample and wait for it to stop. */
export async function runSample({ orchestrator, store }, { name, faults, sid } = {}) {
  const session = sid || store.createSession();
  const run = orchestrator.createRun(session, { ...sample(name), faults });
  await orchestrator.start(run);
  return { run, session };
}
