import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Agent, buildConnector, request } from 'undici';
import { start } from './iroh-tcp-tunnel.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-private-peer-tls-test-'));
process.umask(0o077);
const hostname = 'pds.pds-proof.example.com';
const payload = randomBytes(1024 * 1024);
const payloadHash = createHash('sha256').update(payload).digest('hex');
const hosts = [], servernames = [], pass = [];
let front, wss, tunnel, undici, keepalive;
const agents = [], clients = new Set(), targetSockets = new Set();
const log = value => { console.log(JSON.stringify(value)); fs.appendFileSync(path.join(root, 'test.jsonl'), `${JSON.stringify(value)}\n`); };
const ok = check => { pass.push(check); log({ type: 'PASS', check }); };
async function within(promise, label, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`timeout ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function lookup(name, options, cb) {
  assert(name.endsWith('.pds-proof.example.com'));
  cb(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', ...(options.all ? [] : [4]));
}
function makeAgent(ca) {
  const agent = new https.Agent({ ca });
  agent.createConnection = (options, cb) => https.Agent.prototype.createConnection.call(agent,
    { ...options, port: tunnel.entryPort, lookup }, cb);
  agents.push(agent); return agent;
}
async function httpsEcho(agent, name = hostname, bytes = payload) {
  return within(new Promise((resolve, reject) => {
    const req = https.request({ host: name, path: '/echo', method: 'POST', agent,
      headers: { 'content-length': bytes.length } }, response => {
      const chunks = []; response.on('data', c => chunks.push(c));
      response.on('error', reject); response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    (async () => {
      for (let i = 0; i < bytes.length; i += 8192) {
        if (!req.write(bytes.subarray(i, i + 8192))) await once(req, 'drain');
      }
      req.end();
    })().catch(reject);
  }), `HTTPS ${name}`);
}
async function openWs(agent) {
  const ws = new WebSocket(`wss://${hostname}/events`, { agent, perMessageDeflate: false });
  clients.add(ws); ws.once('close', () => clients.delete(ws)); ws.on('error', () => {});
  await within(once(ws, 'open'), 'WSS open'); return ws;
}
async function wsEcho(ws, bytes) {
  const received = within(once(ws, 'message'), 'WSS echo'); ws.send(bytes);
  const [actual] = await received; assert.deepEqual(actual, Buffer.from(bytes));
}
async function closeWs(ws) {
  const ended = once(ws, 'close'); ws.close(1000, 'proof done'); await within(ended, 'WSS close');
}

try {
  fs.writeFileSync(path.join(root, 'root.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=root\nprompt=no\n[dn]\nCN=Iroh transport proof CA\n[root]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:.pds-proof.example.com\n');
  fs.writeFileSync(path.join(root, 'leaf.ext'), `basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n`);
  const openssl = (...args) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'root.key', '-out', 'root.pem', '-config', 'root.cnf');
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Iroh raw tunnel proof', '-keyout', 'leaf.key', '-out', 'leaf.csr');
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-set_serial', '2', '-days', '1', '-extfile', 'leaf.ext', '-out', 'leaf.pem');
  const ca = fs.readFileSync(path.join(root, 'root.pem'));
  front = https.createServer({ key: fs.readFileSync(path.join(root, 'leaf.key')), cert: fs.readFileSync(path.join(root, 'leaf.pem')) }, (req, res) => {
    hosts.push(req.headers.host); servernames.push(req.socket.servername);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': req.headers['content-length'] });
    req.pipe(res);
  });
  front.on('connection', socket => { targetSockets.add(socket); socket.once('close', () => targetSockets.delete(socket)); });
  wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  front.on('upgrade', (req, socket, head) => {
    hosts.push(req.headers.host); servernames.push(socket.servername);
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      ws.on('message', (bytes, binary) => ws.send(bytes, { binary }));
    });
  });
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  tunnel = await start(front.address().port);
  log({ type: 'tunnel-ready', root, entryPort: tunnel.entryPort, targetPort: front.address().port,
    clientId: tunnel.clientId, serverId: tunnel.serverId, guard: tunnel.guard, transportLog: tunnel.logPath });
  const agent = makeAgent(ca);
  assert.deepEqual(await httpsEcho(agent), payload);
  ok('standard HTTPS validates private CA/hostname and streams 1 MiB through Iroh');

  const connector = buildConnector({ ca, lookup });
  undici = new Agent({ connect(options, cb) {
    assert.equal(options.hostname, hostname);
    connector({ ...options, port: String(tunnel.entryPort) }, cb);
  } });
  const response = await request(`https://${hostname}/echo`, { method: 'POST', dispatcher: undici,
    body: payload, headers: { 'content-length': payload.length } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Buffer.from(await response.body.arrayBuffer()), payload);
  await undici.close(); undici = undefined;
  ok('Undici buildConnector routes original HTTPS name through the same entry port');

  const ws = await openWs(agent);
  await wsEcho(ws, payload.subarray(0, 512 * 1024));
  const pong = within(once(ws, 'pong'), 'WSS pong'); ws.ping('heartbeat'); await pong;
  await Promise.all([wsEcho(ws, Buffer.from('second websocket message')), httpsEcho(agent).then(x => assert.deepEqual(x, payload))]);
  await closeWs(ws);
  assert(hosts.every(x => x === hostname)); assert(servernames.every(x => x === hostname));
  ok('WSS binary/text/ping-pong and concurrent HTTPS preserve end-to-end Host and TLS SNI');

  await assert.rejects(httpsEcho(agent, 'wrong.pds-proof.example.com', Buffer.from('wrong name')),
    error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
  await assert.rejects(httpsEcho(makeAgent([]), hostname, Buffer.from('wrong CA')),
    error => /certificate|issuer|self.signed/i.test(error.message));
  assert.deepEqual(await httpsEcho(agent), payload);
  ok('wrong TLS name and untrusted CA fail normally; subsequent valid HTTPS still works');

  for (const a of agents) a.destroy();
  let evidence;
  for (let i = 0; i < 100; i++) {
    evidence = await tunnel.transportEvidence();
    if (evidence.activeConnections === 0) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(evidence.activeConnections, 0, 'completed TCP streams must release their Iroh connections');
  const clientStreams = evidence.streams.filter(s => s.side === 'client');
  const serverStreams = evidence.streams.filter(s => s.side === 'server');
  assert(clientStreams.length >= 7);
  // Node Agents may destroy completed TLS sockets without a TCP half-close.
  // Require identical bytes on both sides regardless of that close style.
  for (const c of clientStreams.filter(s => s.socketToIrohBytes > 100000)) {
    assert(serverStreams.some(s => s.irohToSocketSha256 === c.socketToIrohSha256 &&
      s.socketToIrohSha256 === c.irohToSocketSha256));
    assert(c.socketReadChunks > 1 && c.irohReadChunks > 1);
  }
  assert(clientStreams.filter(s => s.socketToIrohBytes > 100000).length >= 5);
  assert(evidence.streams.every(s => s.paths.some(p => p.isSelected && p.isIp && !p.isRelay)));
  fs.writeFileSync(path.join(root, 'transport-evidence.json'), JSON.stringify(evidence, null, 2));
  ok('ciphertext stream hashes agree in both directions across peers; reads are incremental and paths are direct');

  keepalive = await openWs(makeAgent(ca)); await wsEcho(keepalive, Buffer.from('live at shutdown'));
  const wsClosed = within(once(keepalive, 'close'), 'active WSS terminated by tunnel close');
  const entryPort = tunnel.entryPort;
  const closed = await tunnel.close(); await wsClosed; keepalive = undefined;
  assert.deepEqual(closed.nativeClosed, [true, true]); assert(closed.workerExited);
  assert.equal(closed.activeSockets, 0); assert.equal(closed.activeConnections, 0);
  tunnel = undefined;
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: entryPort });
    socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); });
  }), error => error.code === 'ECONNREFUSED');
  fs.writeFileSync(path.join(root, 'closed-evidence.json'), JSON.stringify(closed, null, 2));
  ok('close terminates active WSS, closes both native endpoints, exits only owned worker, and removes TCP entry');
  log({ type: 'RESULT', passed: pass.length, root, payloadHash });
} finally {
  for (const ws of clients) ws.terminate();
  await undici?.close();
  for (const agent of agents) agent.destroy();
  if (tunnel) await tunnel.close();
  for (const socket of targetSockets) socket.destroy();
  if (wss) await new Promise(resolve => wss.close(resolve));
  if (front) await new Promise(resolve => front.close(resolve));
}
