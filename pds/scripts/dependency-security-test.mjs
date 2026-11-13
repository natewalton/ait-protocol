// Candidate-bound proofs for the declared PDS consumers, not library-wide repairs.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';

const script = fileURLToPath(import.meta.url);
const candidateArg = process.argv.indexOf('--candidate');
const candidate = path.resolve(candidateArg < 0 ? path.join(path.dirname(script), '../..') : process.argv[candidateArg + 1]);
const require = createRequire(path.join(candidate, 'pds/package.json'));
const asf = Buffer.from('3026b2758e66cf11a6d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000', 'hex');
const checks = ['file-type-stream', 'elliptic-public-key'];

if (process.argv.includes('--buffer-control')) {
  // This deliberately vulnerable API must never execute on the HTTP event loop.
  process.stdout.write('buffer-control-started\n');
  await require('file-type').fromBuffer(asf);
  throw new Error('buffer positive control unexpectedly completed');
} else if (process.argv.includes('--fixture-child')) {
  await fixture(process.argv.at(-1));
} else {
  const report = { schemaVersion: 1, candidateCommit: '', status: 'blocked', checks: checks.map(id => ({ id, status: 'blocked' })), errors: [] };
  let home;
  try {
    report.candidateCommit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Run with Node 24+');
    home = await mkdtemp(path.join(tmpdir(), 'ait-dependency-test-'));
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_DATA_HOME: path.join(home, 'xdg'), LOG_ENABLED: 'false', NODE_ENV: 'test' };
    const control = spawnSync(process.execPath, ['--max-old-space-size=256', script, '--candidate', candidate, '--buffer-control'], { env, encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.match(control.stdout, /buffer-control-started\n/, 'positive control must reach the parser before its deadline');
    assert.equal(control.error?.code, 'ETIMEDOUT', 'underlying buffer vulnerability positive control must reach its bounded deadline');
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', script, '--candidate', candidate, '--fixture-child', home], { env, encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `fixture failed: ${child.stderr} ${child.stdout}`);
    assert.equal(child.stdout.trim(), 'consumer checks passed');
    report.status = 'passed'; report.checks.forEach(check => { check.status = 'passed'; });
  } catch (error) { report.errors.push(error.message); }
  finally {
    if (home) {
      try { await rm(home, { recursive: true, force: true }); await assert.rejects(access(home)); }
      catch (error) { report.status = 'blocked'; report.checks.forEach(check => { check.status = 'blocked'; }); report.errors.push(`cleanup: ${error.message}`); }
    }
  }
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

async function javascriptFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await javascriptFiles(full));
    else if (entry.name.endsWith('.js')) result.push(full);
  }
  return result;
}

async function fixture(home) {
  process.umask(0o077);
  const ports = new Set();
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = typeof first === 'object' ? first : { port: first, host: args[1] };
    assert.equal(opts.host ?? 'localhost', '127.0.0.1', 'unowned network host');
    assert.ok(ports.has(Number(opts.port)), `unowned port ${opts.port}`);
    return originalConnect.apply(this, args);
  };
  const pdsRoot = path.dirname(require.resolve('@atproto/pds/package.json'));
  const awsRoot = path.dirname(path.dirname(require.resolve('@atproto/aws')));
  assert.equal(require('@atproto/pds/package.json').version, '0.4.226');
  assert.equal(require('file-type/package.json').version, '16.5.4');
  assert.equal(require('elliptic/package.json').version, '6.6.1');
  // Fail closed on a new caller: this is deliberately scoped to inspected source.
  const parserCallers = [], encoderCallers = [];
  for (const root of [pdsRoot, awsRoot]) {
    for (const file of await javascriptFiles(path.join(root, 'dist'))) {
      const source = await readFile(file, 'utf8');
      const name = path.relative(root, file);
      if (/from ['"]file-type['"]/.test(source)) parserCallers.push(name);
      if (/from ['"]key-encoder['"]/.test(source)) {
        encoderCallers.push(path.basename(root) + '/' + name);
        assert.equal((source.match(/\.encodePublic\(/g) || []).length, 1);
        assert.ok(!/\.encodePrivate\(/.test(source));
      }
    }
  }
  assert.deepEqual(parserCallers, ['dist/actor-store/blob/transactor.js']);
  assert.deepEqual(encoderCallers.sort(), ['aws/dist/kms.js', 'pds/dist/auth-verifier.js']);
  const transactor = await readFile(path.join(pdsRoot, parserCallers[0]), 'utf8');
  assert.match(transactor, /fromStream: fileTypeFromStream/);
  assert.ok(!/fromBuffer|fromTokenizer/.test(transactor));
  await assert.rejects(require('file-type').fromStream(Readable.from([asf])), RangeError);

  // Disable the vulnerable primitive BEFORE loading the real key-encoder callers.
  for (const root of [pdsRoot, awsRoot]) {
    const consumerRequire = createRequire(path.join(root, 'dist/index.js'));
    const encoderRequire = createRequire(consumerRequire.resolve('key-encoder'));
    assert.equal(encoderRequire.resolve('elliptic'), require.resolve('elliptic'), 'signing guard must cover the actual encoder dependency');
  }
  assert.equal(createRequire(path.join(pdsRoot, parserCallers[0])).resolve('file-type'), require.resolve('file-type'));
  const elliptic = require('elliptic'); let signingCalls = 0;
  const blocked = () => { signingCalls++; throw new Error('fixture elliptic signing disabled'); };
  elliptic.ec.prototype.sign = blocked;
  Object.getPrototypeOf(new elliptic.ec('secp256k1').keyFromPrivate('01')).sign = blocked;
  assert.throws(() => new elliptic.ec('secp256k1').sign(Buffer.alloc(32), '01'), /signing disabled/);
  assert.throws(() => new elliptic.ec('secp256k1').keyFromPrivate('01').sign(Buffer.alloc(32)), /signing disabled/);
  signingCalls = 0;
  const { createPublicKeyObject, AuthVerifier } = await import(pathToFileURL(path.join(pdsRoot, 'dist/auth-verifier.js')));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const formatted = createPublicKeyObject(raw.toString('hex'));
  const der = publicKey.export({ format: 'der', type: 'spki' });
  assert.deepEqual(formatted.export({ format: 'der', type: 'spki' }), der);
  const payload = { sub: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', aud: 'did:web:pds.localhost', scope: 'com.atproto.access', exp: Math.floor(Date.now() / 1000) + 60 };
  const unsigned = [ { alg: 'ES256K', typ: 'JWT' }, payload ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const token = unsigned + '.' + sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const verified = await AuthVerifier.prototype.verifyBearerJwt.call({ _jwtKey: formatted }, { headers: { authorization: `Bearer ${token}` } }, { scopes: ['com.atproto.access'], algorithms: ['ES256K'], audience: payload.aud });
  assert.equal(verified.sub, payload.sub);
  const forged = token.slice(0, token.lastIndexOf('.') + 1) + Buffer.alloc(64).toString('base64url');
  await assert.rejects(AuthVerifier.prototype.verifyBearerJwt.call({ _jwtKey: formatted }, { headers: { authorization: `Bearer ${forged}` } }, { scopes: ['com.atproto.access'], algorithms: ['ES256K'], audience: payload.aud }), /Token could not be verified/);
  const aws = require('@aws-sdk/client-kms');
  const originalGet = aws.KMS.prototype.getPublicKey;
  let kmsCalls = 0;
  aws.KMS.prototype.getPublicKey = async function (input) { assert.deepEqual(input, { KeyId: 'fixture-key' }); kmsCalls++; return { PublicKey: der }; };
  try {
    const { KmsKeypair } = await import(pathToFileURL(path.join(awsRoot, 'dist/kms.js')));
    const key = await KmsKeypair.load({ keyId: 'fixture-key', region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    assert.deepEqual(Buffer.from(key.publicKey), raw); assert.equal(kmsCalls, 1);
  } finally { aws.KMS.prototype.getPublicKey = originalGet; }
  assert.equal(signingCalls, 0, 'public-key consumers invoked disabled signing');

  const { PDS, envToCfg, envToSecrets } = require('@atproto/pds');
  const { Secp256k1Keypair } = require('@atproto/crypto');
  const { cidForRawHash } = require('@atproto/lex-data');
  const data = path.join(home, 'data'); await mkdir(data);
  const env = { port: 0, hostname: 'pds.localhost', serviceDid: 'did:web:pds.localhost', dataDirectory: data, blobstoreDiskLocation: path.join(data, 'blobs'), didPlcUrl: 'http://127.0.0.1:1', serviceHandleDomains: ['.test'], inviteRequired: false, rateLimitsEnabled: false, crawlers: [], jwtSecret: randomBytes(32).toString('hex'), adminPassword: randomBytes(32).toString('hex'), plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex') };
  const pds = await PDS.create(envToCfg(env), envToSecrets(env));
  const did = payload.sub;
  pds.ctx.idResolver.did.resolve = async requested => { assert.equal(requested, did); return { id: did, alsoKnownAs: ['at://fixture.test'], service: [] }; };
  const server = http.createServer(pds.app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; assert.ok(![2582, 2583, 2585].includes(port)); ports.add(port);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const key = await Secp256k1Keypair.create({ exportable: true }); await pds.ctx.actorStore.create(did, key);
    const commit = await pds.ctx.actorStore.transact(did, store => store.repo.createRepo([]));
    const session = await pds.ctx.accountManager.createAccountAndSession({ did, handle: 'fixture.test', email: 'fixture@example.test', password: 'fixture-password-123', repoCid: commit.cid, repoRev: commit.rev });
    const auth = `Bearer ${session.accessJwt}`;
    const rows = () => pds.ctx.actorStore.read(did, store => store.db.db.selectFrom('blob').selectAll().execute());
    const upload = async body => {
      const response = await fetch(origin + '/xrpc/com.atproto.repo.uploadBlob', { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: auth }, body, signal: AbortSignal.timeout(3000) });
      return { status: response.status, json: await response.json() };
    };
    for (const size of [0n, 1n, 23n, 24n, 0xffffffffffffffffn, null]) {
      const body = Buffer.from(asf); if (size !== null) body.writeBigUInt64LE(size, 46);
      const before = await rows(); const response = await upload(size === null ? body.subarray(0, 43) : body);
      assert.equal(response.status, 500); assert.equal(response.json.error, 'InternalServerError');
      assert.deepEqual(await rows(), before, 'malformed input admitted blob metadata');
      const available = await fetch(origin + '/xrpc/com.atproto.server.getSession', { headers: { authorization: auth }, signal: AbortSignal.timeout(3000) });
      assert.equal(available.status, 200); assert.equal((await available.json()).did, did);
    }
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
    for (const [body, mime] of [[png, 'image/png'], [Buffer.from('unrecognized fixture content'), 'application/octet-stream']]) {
      const response = await upload(body); assert.equal(response.status, 200);
      assert.equal(response.json.blob.mimeType, mime); assert.equal(response.json.blob.size, body.length);
      const cid = cidForRawHash(createHash('sha256').update(body).digest()).toString();
      assert.equal(response.json.blob.ref.$link, cid);
      const row = (await rows()).find(row => row.cid === cid); assert.ok(row); assert.equal(row.mimeType, mime);
      // Untethered uploads are temporary until a record references them. Read the
      // actual candidate blobstore's temp object, rather than inventing admission.
      const bytes = await readFile(pds.ctx.blobstore(did).getTmpPath(row.tempKey));
      assert.deepEqual(bytes, body);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const transport of [pds.ctx.mailer.transporter, pds.ctx.moderationMailer.transporter]) transport.close();
    await pds.ctx.didCache.destroy(); await pds.destroy();
    await pds.ctx.didCache.db.db.destroy(); await pds.ctx.sequencer.db.db.destroy();
    net.Socket.prototype.connect = originalConnect;
  }
  console.log('consumer checks passed');
}
