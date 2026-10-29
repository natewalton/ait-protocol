// PROOF ONLY. One fixed loopback target, no TLS handling or general proxy API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function deadline(promise, label, ms = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`tunnel timeout: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
export async function start(targetPort, { inheritSandbox = false } = {}) {
  assert(Number.isInteger(targetPort) && targetPort > 0 && targetPort < 65536);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-private-peer-tunnel-'));
  const logPath = path.join(runDir, 'transport.jsonl');
  const record = event => fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  const stderr = fs.openSync(path.join(runDir, 'worker.log'), 'a');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(runDir, 'config'),
    XDG_CACHE_HOME: path.join(runDir, 'cache'), XDG_DATA_HOME: path.join(runDir, 'data'),
    TMPDIR: runDir, RUST_LOG: 'warn' };
  for (const key of Object.keys(env)) if (/proxy|IROH_SERVICES|SSLKEYLOGFILE/i.test(key)) delete env[key];
  const executable = inheritSandbox ? process.execPath : '/usr/bin/sandbox-exec';
  const args = inheritSandbox ? [path.join(here, 'tunnel-worker.mjs')] :
    ['-f', path.join(here, 'loopback.sb'), process.execPath, path.join(here, 'tunnel-worker.mjs')];
  const child = spawn(executable, args, { cwd: here, env, stdio: ['ignore', stderr, stderr, 'ipc'] });
  fs.closeSync(stderr);
  record({ type: 'owned-process-start', pid: child.pid, executable, args });
  const waiting = new Map();
  let requestId = 0, closing;
  child.on('message', message => {
    if (message.event) { record(message.event); return; }
    const pending = waiting.get(message.requestId);
    if (!pending) return;
    waiting.delete(message.requestId);
    message.error ? pending.reject(Error(message.error)) : pending.resolve(message.value);
  });
  child.once('exit', (code, signal) => {
    record({ type: 'owned-process-exit', pid: child.pid, code, signal });
    for (const p of waiting.values()) p.reject(Error(`tunnel worker exited ${code}/${signal}`));
    waiting.clear();
  });
  const rpc = (op, values = {}) => deadline(new Promise((resolve, reject) => {
    const id = ++requestId;
    waiting.set(id, { resolve, reject });
    child.send({ requestId: id, op, ...values }, error => error && reject(error));
  }), op);
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('tunnel worker exited before clean close');
      const exited = once(child, 'exit');
      const result = await rpc('close');
      const [code, signal] = await deadline(exited, 'worker exit', 5000);
      assert.equal(code, 0); assert.equal(signal, null);
      assert.deepEqual(result.nativeClosed, [true, true]);
      const closed = { ...result, workerExited: true, ownedPid: child.pid, runDir, logPath };
      record({ type: 'closed', nativeClosed: result.nativeClosed, workerExited: true, pid: child.pid });
      return closed;
    })();
    return closing;
  }
  try {
    const ready = await rpc('start', { targetPort });
    return { ...ready, ownedPid: child.pid, runDir, logPath,
      transportEvidence: ({ waitForIdle = false } = {}) => rpc('evidence', { waitForIdle }), close };
  } catch (error) {
    // This handle was created above and its PID is recorded. No broad cleanup.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      await deadline(exited, 'failed startup cleanup', 5000).catch(() => {});
    }
    throw error;
  }
}
