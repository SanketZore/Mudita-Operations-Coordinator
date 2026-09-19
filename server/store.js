/**
 * store.js - file-based persistence with per-session isolation.
 *
 *   data/sessions/<sessionId>/session.json
 *   data/sessions/<sessionId>/runs/<runId>.json
 *
 * ISOLATION: every read/write goes through (sessionId, runId). `getRun` refuses
 * to return a run whose stored session_id differs from the caller's, and ids are
 * validated against strict hex patterns (no path traversal). Nothing in the app
 * ever lists or reads across sessions except startup recovery/pruning.
 *
 * Runs are cached in memory and written through atomically (tmp file + rename)
 * after every change, so a crash never leaves a half-written JSON file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { newId } from './core/hash.js';

const SID_RE = /^[a-f0-9]{32}$/;
const RID_RE = /^[a-f0-9]{16}$/;

export function createStore(dataDir) {
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const cache = new Map(); // "sid/rid" -> run object (the live object the orchestrator mutates)

  const sDir = (sid) => path.join(sessionsDir, sid);
  const rFile = (sid, rid) => path.join(sDir(sid), 'runs', `${rid}.json`);

  function writeAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }

  const api = {
    isSessionId: (s) => typeof s === 'string' && SID_RE.test(s),
    isRunId: (s) => typeof s === 'string' && RID_RE.test(s),

    createSession({ ephemeral = false } = {}) {
      const id = newId(16);
      writeAtomic(path.join(sDir(id), 'session.json'), { id, created_at: new Date().toISOString(), ephemeral });
      return id;
    },
    sessionExists(sid) {
      return api.isSessionId(sid) && fs.existsSync(path.join(sDir(sid), 'session.json'));
    },

    newRunId: () => newId(8),

    saveRun(run) {
      run.updated_at = new Date().toISOString();
      cache.set(`${run.session_id}/${run.id}`, run);
      writeAtomic(rFile(run.session_id, run.id), run);
    },

    /** Returns the run only if it belongs to `sid`. Otherwise null (indistinguishable from "not found"). */
    getRun(sid, rid) {
      if (!api.isSessionId(sid) || !api.isRunId(rid)) return null;
      const key = `${sid}/${rid}`;
      if (cache.has(key)) return cache.get(key);
      const file = rFile(sid, rid);
      if (!fs.existsSync(file)) return null;
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (run.session_id !== sid) return null;
      cache.set(key, run);
      return run;
    },

    listRuns(sid) {
      if (!api.sessionExists(sid)) return [];
      const dir = path.join(sDir(sid), 'runs');
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => api.getRun(sid, f.replace('.json', '')))
        .filter(Boolean)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    deleteRun(sid, rid) {
      if (!api.getRun(sid, rid)) return false;
      cache.delete(`${sid}/${rid}`);
      fs.rmSync(rFile(sid, rid), { force: true });
      return true;
    },

    deleteAllRuns(sid) {
      const runs = api.listRuns(sid);
      runs.forEach((r) => api.deleteRun(sid, r.id));
      return runs.length;
    },

    deleteSession(sid) {
      if (!api.isSessionId(sid)) return;
      for (const k of [...cache.keys()]) if (k.startsWith(sid + '/')) cache.delete(k);
      fs.rmSync(sDir(sid), { recursive: true, force: true });
    },

    /**
     * Crash recovery (called once at startup, before serving requests):
     * a run left in "running" means the process died mid-flight. Mark it
     * "interrupted" and its running steps "failed" so the user can press Resume.
     */
    recoverInterrupted() {
      let n = 0;
      for (const sid of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
        if (!api.isSessionId(sid)) continue;
        for (const run of api.listRuns(sid)) {
          if (run.status !== 'running') continue;
          run.status = 'interrupted';
          run.error = { message: 'The server restarted while this run was executing. Press Resume - completed steps will be reused.', step: null, simulated: false, at: new Date().toISOString() };
          for (const s of Object.values(run.steps)) {
            if (s.status === 'running') {
              s.status = 'failed';
              s.error = { message: 'Interrupted by server restart', simulated: false, at: new Date().toISOString() };
            }
          }
          api.saveRun(run);
          n += 1;
        }
      }
      return n;
    },

    /** Delete sessions untouched for `days` days (0 disables). */
    prune(days) {
      if (!days || days <= 0 || !fs.existsSync(sessionsDir)) return 0;
      const cutoff = Date.now() - days * 86400000;
      let n = 0;
      for (const sid of fs.readdirSync(sessionsDir)) {
        if (!api.isSessionId(sid)) continue;
        const latest = Math.max(...[sDir(sid), path.join(sDir(sid), 'session.json'), ...api.listRuns(sid).map((r) => rFile(sid, r.id))].map((p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0)));
        if (latest < cutoff) {
          api.deleteSession(sid);
          n += 1;
        }
      }
      return n;
    },
  };
  return api;
}
