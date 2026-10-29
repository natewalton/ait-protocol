// Event-driven FIN regressions. Timers are failure deadlines, never ordering.
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-private-peer-half-close-'));
const oldIterator = process.argv.includes('--old-iterator');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function assertBytes(actual, expected) {
  assert.equal(actual.length, expected.length, 'exact byte length');
  assert.equal(hash(actual), hash(expected), 'exact byte hash');
}
const log = value => {
  console.log(JSON.stringify(value));
  fs.appendFileSync(path.join(root, 'results.jsonl'), `${JSON.stringify(value)}\n`);
};
function within(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`deadline: ${label}`)), 10000);
  })]).finally(() => clearTimeout(timer));
}
async function readAll(socket) {
  const chunks = [];
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) chunks.push(chunk);
  return Buffer.concat(chunks);
}

let adapter = path.join(here, 'iroh-tcp-tunnel.mjs');
if (oldIterator) {
  // Only the iterator changes; connection ownership, oracle and native package
  // stay identical. No source or historical file is modified by this control.
  const fixture = path.join(root, 'old-iterator');
  fs.mkdirSync(fixture);
  const source = fs.readFileSync(path.join(here, 'tunnel-worker.mjs'), 'utf8');
  const needle = 'socket.iterator({ destroyOnReturn: false })';
  assert.equal(source.split(needle).length, 2);
  fs.writeFileSync(path.join(fixture, 'tunnel-worker.mjs'), source.replace(needle, 'socket'));
  for (const file of ['iroh-tcp-tunnel.mjs', 'loopback.sb']) {
    fs.copyFileSync(path.join(here, file), path.join(fixture, file));
  }
  fs.symlinkSync(path.join(here, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  adapter = path.join(fixture, 'iroh-tcp-tunnel.mjs');
}
const { start } = await import(pathToFileURL(adapter));

async function exchange(direction) {
  const request = Buffer.alloc(256 * 1024, 0x51);
  const response = Buffer.alloc(1024 * 1024, 0xa7);
  const prelude = Buffer.from('open-stream');
  const sockets = new Set();
  let tunnel, client, targetTask;
  const target = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    targetTask = (async () => {
      if (direction === 'client-request-FIN') {
        assertBytes(await readAll(socket), request);
        // This write is causally after receiving request EOF.
        socket.end(response);
      } else {
        const reader = socket.iterator({ destroyOnReturn: false });
        assertBytes((await reader.next()).value, prelude);
        await reader.return();
        socket.end(request);
        assertBytes(await readAll(socket), response);
      }
    })();
    targetTask.catch(() => {});
  });
  try {
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    tunnel = await start(target.address().port, { inheritSandbox: true });
    log({ type: 'owned-worker', direction, ownedPid: tunnel.ownedPid, runDir: tunnel.runDir });
    client = net.connect({ host: '127.0.0.1', port: tunnel.entryPort, allowHalfOpen: true });
    client.on('error', () => {});
    await once(client, 'connect');
    await within((async () => {
      if (direction === 'client-request-FIN') {
        client.end(request);
        assertBytes(await readAll(client), response);
      } else {
        client.write(prelude);
        assertBytes(await readAll(client), request);
        // This write is causally after receiving the responder's FIN.
        client.end(response);
      }
      await targetTask;
      const evidence = await tunnel.transportEvidence({ waitForIdle: true });
      fs.writeFileSync(path.join(root, `${direction}-evidence.json`), JSON.stringify(evidence, null, 2));
      assert.equal(evidence.activeConnections, 0);
      assert.equal(evidence.streams.length, 2);
      for (const stream of evidence.streams) {
        assert.equal(stream.status, 'finished', JSON.stringify(stream));
        assert.equal(stream.sendStopped, null);
      }
      const c = evidence.streams.find(s => s.side === 'client');
      const s = evidence.streams.find(s => s.side === 'server');
      const up = direction === 'client-request-FIN' ? request : Buffer.concat([prelude, response]);
      const down = direction === 'client-request-FIN' ? response : request;
      assert.equal(c.socketToIrohSha256, hash(up));
      assert.equal(s.irohToSocketSha256, hash(up));
      assert.equal(s.socketToIrohSha256, hash(down));
      assert.equal(c.irohToSocketSha256, hash(down));
      log({ type: 'PASS', direction, upBytes: up.length, downBytes: down.length });
    })(), direction);
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (tunnel) {
      const closed = await tunnel.close();
      assert(closed.workerExited);
      assert.deepEqual(closed.nativeClosed, [true, true]);
      log({ type: 'owned-worker-exited', direction, ownedPid: closed.ownedPid });
    }
    await new Promise(resolve => target.close(resolve));
    await Promise.allSettled([targetTask]);
  }
}

async function deliberateAbort() {
  const sockets = new Set();
  const target = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', () => socket.write('ready-to-abort'));
  });
  let tunnel, client;
  try {
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    tunnel = await start(target.address().port, { inheritSandbox: true });
    log({ type: 'owned-worker', direction: 'deliberate-abort', ownedPid: tunnel.ownedPid, runDir: tunnel.runDir });
    client = net.connect({ host: '127.0.0.1', port: tunnel.entryPort });
    client.on('error', () => {});
    await once(client, 'connect');
    const ready = once(client, 'data');
    client.write('open-stream');
    await within(ready, 'abort rendezvous');
    const closed = once(client, 'close');
    client.resetAndDestroy();
    await within(closed, 'deliberate TCP reset');
    const evidence = await tunnel.transportEvidence({ waitForIdle: true });
    fs.writeFileSync(path.join(root, 'deliberate-abort-evidence.json'), JSON.stringify(evidence, null, 2));
    assert.equal(evidence.activeConnections, 0);
    assert.equal(evidence.streams.length, 2);
    assert(evidence.streams.some(s => s.status === 'aborted'));
    assert(evidence.streams.every(s => ['aborted', 'error'].includes(s.status)));
    log({ type: 'PASS', direction: 'deliberate-abort', statuses: evidence.streams.map(s => s.status) });
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (tunnel) {
      const closed = await tunnel.close();
      assert(closed.workerExited);
      assert.deepEqual(closed.nativeClosed, [true, true]);
      log({ type: 'owned-worker-exited', direction: 'deliberate-abort', ownedPid: closed.ownedPid });
    }
    await new Promise(resolve => target.close(resolve));
  }
}

const failed = [];
for (const direction of ['client-request-FIN', 'server-request-FIN']) {
  try { await exchange(direction); }
  catch (error) {
    failed.push(direction);
    log({ type: 'FAIL', direction, error: String(error.stack || error) });
  }
}
if (!oldIterator) {
  try { await deliberateAbort(); }
  catch (error) {
    failed.push('deliberate-abort');
    log({ type: 'FAIL', direction: 'deliberate-abort', error: String(error.stack || error) });
  }
}
log({ type: 'RESULT', root, oldIterator, failed });
// The negative control deliberately exits nonzero and must fail both directions.
if (oldIterator) assert.equal(failed.length, 2, 'old iterator must fail both FIN fixtures');
if (failed.length) process.exitCode = 1;
