// PROOF ONLY. This process never imports TLS, HTTPS, HTTP or WebSocket code.
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Endpoint, EndpointAddr, RelayMode, SecretKey, presetMinimal } from '@number0/iroh';

const ALPN = [...Buffer.from('ait-proof-raw-tcp-over-iroh/1')];
const endpoints = [], connections = new Set(), sockets = new Set(), tasks = new Set(), records = [];
let entry, targetPort, stopping = false, closePromise, client, server, clientId, serverId;
let sequence = 0, acceptTask;
const emit = event => process.connected && process.send({ event });

async function networkGuard() {
  const udp = dgram.createSocket('udp4');
  const udpError = await new Promise(resolve => udp.send(Buffer.from('guard'), 9, '192.0.2.1', resolve));
  udp.close();
  assert(udpError && ['EPERM', 'EACCES'].includes(udpError.code), 'external UDP must be sandbox-denied');
  const tcpError = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '192.0.2.1', port: 9 });
    socket.setTimeout(1000, () => { socket.destroy(); reject(Error('TCP guard timed out')); });
    socket.once('error', resolve);
    socket.once('connect', () => { socket.destroy(); reject(Error('TCP escaped sandbox')); });
  });
  assert(['EPERM', 'EACCES'].includes(tcpError.code), 'external TCP must be sandbox-denied');
  return { externalTcpDenied: tcpError.code, externalUdpDenied: udpError.code };
}

function track(task) {
  tasks.add(task);
  task.then(() => tasks.delete(task), () => tasks.delete(task));
  return task;
}
function trackSocket(socket) {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  return socket;
}
async function bind(key) {
  const builder = Endpoint.builder(); presetMinimal(builder);
  builder.secretKey([...key]); builder.alpns([ALPN]);
  builder.bindAddr('127.0.0.1:0'); builder.bindAddr('[::1]:0');
  builder.relayMode(RelayMode.disabled());
  const endpoint = await builder.bind(); endpoints.push(endpoint);
  assert(endpoint.boundSockets().every(a => a.startsWith('127.0.0.1:') || a.startsWith('[::1]:')));
  assert.equal(endpoint.id().toString(), SecretKey.fromBytes([...key]).public().toString());
  return endpoint;
}
function checkPeer(connection, expected) {
  assert.equal(connection.remoteId().toString(), expected);
  assert.deepEqual(connection.alpn(), ALPN);
  const paths = connection.paths();
  assert(paths.some(p => p.isSelected && p.isIp && !p.isRelay));
  connections.add(connection);
  emit({ type: 'authenticated', expectedPeer: expected, remoteId: connection.remoteId().toString(), paths });
}

async function bridge(socket, stream, connection, side) {
  const record = { id: ++sequence, side, remoteId: connection.remoteId().toString(),
    status: 'open', socketToIrohBytes: 0, irohToSocketBytes: 0, socketReadChunks: 0,
    irohReadChunks: 0, paths: connection.paths(), upHash: createHash('sha256'), downHash: createHash('sha256') };
  records.push(record);
  const up = (async () => {
    // Readable EOF must leave the independent TCP writer usable.
    for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
      await stream.send.writeAll([...chunk]);
      record.socketToIrohBytes += chunk.length; record.socketReadChunks++;
      record.upHash.update(chunk);
    }
    await stream.send.finish();
    record.sendStopped = await stream.send.stopped();
    assert.equal(record.sendStopped, null, 'STOP_SENDING is an abort, not successful delivery');
  })();
  const down = (async () => {
    for (;;) {
      const bytes = await stream.recv.read(64 * 1024);
      if (!bytes.length) break;
      const chunk = Buffer.from(bytes);
      await new Promise((resolve, reject) => socket.write(chunk, error => error ? reject(error) : resolve()));
      record.irohToSocketBytes += chunk.length; record.irohReadChunks++;
      record.downHash.update(chunk);
    }
    // Observe destruction as well as finish: end(callback) registered after
    // destroy() can remain pending forever on an otherwise unended writer.
    const drained = finished(socket, { readable: false, cleanup: true });
    socket.end();
    await drained;
  })();
  try {
    await Promise.all([up, down]);
    record.status = 'finished';
  } catch (error) {
    record.status = stopping ? 'shutdown' :
      ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code) ? 'aborted' : 'error';
    record.error = String(error);
    // An actual failure aborts the pair; normal FIN never takes this path.
    socket.destroy();
    connection.close(1n, [...Buffer.from('proof transfer aborted')]);
  } finally {
    await Promise.allSettled([up, down]);
    record.paths = connection.paths();
    emit({ type: 'stream-summary', ...snapshot(record) });
  }
  return record.status;
}

function snapshot(record) {
  const { upHash, downHash, ...rest } = record;
  return { ...rest, socketToIrohSha256: upHash.copy().digest('hex'), irohToSocketSha256: downHash.copy().digest('hex') };
}

async function receiveConnection(incoming) {
  let connection, socket;
  try {
    connection = await (await incoming.accept()).connect();
    checkPeer(connection, clientId);
    const stream = await connection.acceptBi();
    // Authentication is checked before dialing the one fixed target.
    assert.equal(connection.remoteId().toString(), clientId);
    socket = trackSocket(net.connect({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true }));
    await once(socket, 'connect');
    await bridge(socket, stream, connection, 'server');
    // The initiator owns normal connection close, after its two copies finish.
    await connection.closed();
  } catch (error) {
    socket?.destroy(); connection?.close(1n, [...Buffer.from('proof target failure')]);
    if (connection) connections.delete(connection);
    if (!stopping) emit({ type: 'connection-error', side: 'server', error: String(error) });
  } finally {
    socket?.destroy();
    if (connection) connections.delete(connection);
  }
}
async function acceptLoop() {
  while (!stopping) {
    const incoming = await server.acceptNext(); if (!incoming) return;
    track(receiveConnection(incoming)); // A failed handshake cannot end the accept loop.
  }
}
async function sendConnection(socket) {
  let connection;
  try {
    const addresses = server.boundSockets().filter(a => a.startsWith('127.0.0.1:'));
    connection = await client.connect(new EndpointAddr(server.id(), null, addresses), ALPN);
    checkPeer(connection, serverId);
    const stream = await connection.openBi();
    const status = await bridge(socket, stream, connection, 'client');
    if (status === 'finished') connection.close(0n, [...Buffer.from('proof stream done')]);
    await connection.closed();
  } catch (error) {
    socket.destroy(); connection?.close(1n, [...Buffer.from('proof source failure')]);
    if (connection) connections.delete(connection);
    if (!stopping) emit({ type: 'connection-error', side: 'client', error: String(error) });
  } finally {
    socket.destroy();
    if (connection) connections.delete(connection);
  }
}

function evidence() {
  return { mode: 'proof-only-loopback-direct', clientId, serverId,
    boundSockets: endpoints.map(ep => ep.boundSockets()), relayMode: 'disabled',
    publicDiscoveryPreset: 'minimal-no-providers', targetPort,
    streams: records.map(snapshot), activeSockets: sockets.size, activeConnections: connections.size };
}
async function close() {
  if (closePromise) return closePromise;
  closePromise = (async () => {
    stopping = true;
    const entryClosed = entry ? new Promise(resolve => entry.close(resolve)) : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    for (const connection of connections) connection.close(0n, [...Buffer.from('proof tunnel shutdown')]);
    await Promise.all(endpoints.map(ep => ep.close()));
    await Promise.allSettled([acceptTask, ...tasks]);
    await entryClosed;
    return { ...evidence(), nativeClosed: endpoints.map(ep => ep.isClosed()) };
  })();
  return closePromise;
}
async function start(port) {
  assert(Number.isInteger(port) && port > 0 && port < 65536);
  const guard = await networkGuard(); targetPort = port;
  client = await bind(randomBytes(32)); server = await bind(randomBytes(32));
  clientId = client.id().toString(); serverId = server.id().toString();
  assert.notEqual(clientId, serverId);
  acceptTask = acceptLoop();
  acceptTask.catch(error => { if (!stopping) emit({ type: 'accept-error', error: String(error) }); });
  entry = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => {
    trackSocket(socket); track(sendConnection(socket));
  });
  entry.listen(0, '127.0.0.1'); await once(entry, 'listening');
  const ready = { entryPort: entry.address().port, clientId, serverId, guard };
  emit({ type: 'ready', ...ready, targetPort }); return ready;
}

process.on('message', async message => {
  try {
    const value = message.op === 'start' ? await start(message.targetPort) :
      message.op === 'evidence' ? (message.waitForIdle && await Promise.allSettled([...tasks]), evidence()) : message.op === 'close' ? await close() :
      (() => { throw Error('unknown operation'); })();
    process.send({ requestId: message.requestId, value }, () => message.op === 'close' && process.disconnect());
  } catch (error) { process.send({ requestId: message.requestId, error: String(error.stack || error) }); }
});
process.once('SIGTERM', () => close().then(() => process.exit(0), () => process.exit(1)));
process.once('disconnect', () => { close().catch(() => {}); });
