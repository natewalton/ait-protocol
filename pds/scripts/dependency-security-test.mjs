// Candidate-bound regressions for the actual upgraded PDS parser/key consumers.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, ECDH, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const script = fileURLToPath(import.meta.url);
const candidateArg = process.argv.indexOf('--candidate');
const candidate = path.resolve(candidateArg < 0 ? path.join(path.dirname(script), '../..') : process.argv[candidateArg + 1]);
const require = createRequire(path.join(candidate, 'pds/package.json'));
const asf = Buffer.from('3026b2758e66cf11a6d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000', 'hex');
const checks = ['file-type-stream', 'elliptic-public-key', 'telemetry-unused-glob'];

if (process.argv.includes('--fixture-child')) {
  await fixture(process.argv.at(-1));
} else {
  const report = { schemaVersion: 1, candidateCommit: '', status: 'blocked', checks: checks.map(id => ({ id, status: 'blocked' })), errors: [] };
  let home;
  try {
    report.candidateCommit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Run with Node 24+');
    home = await mkdtemp(path.join(tmpdir(), 'ait-dependency-test-'));
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_DATA_HOME: path.join(home, 'xdg'), LOG_ENABLED: 'false', NODE_ENV: 'test' };
    // Both the buffer advisory shapes and actual HTTP consumer run against the
    // fixed upstream parser. They must complete; a timeout is never success.
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
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) result.push(full);
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
  assert.equal(require('@atproto/pds/package.json').version, '0.5.59');
  const lock = JSON.parse(await readFile(path.join(candidate, 'pds/package-lock.json')));
  assert.ok(!Object.keys(lock.packages).some(name => /node_modules\/(elliptic|key-encoder)$/.test(name)), 'upgraded graph restored the old key encoder');
  assert.equal(lock.packages['node_modules/file-type'].version, '22.3.0');
  // Gaxios is the sole declared entrance to this unused dependency chain.
  // Bind both runtime formats (including util.cjs) and the export map to the
  // reviewed source, rather than executing known Glob/Minimatch vulnerabilities.
  for (const [dependency, parent] of [
    ['rimraf', 'node_modules/gaxios'],
    ['glob', 'node_modules/rimraf'],
    ['minimatch', 'node_modules/rimraf/node_modules/glob'],
  ]) {
    const parents = Object.entries(lock.packages).filter(([, pkg]) =>
      pkg.dependencies?.[dependency] || pkg.optionalDependencies?.[dependency] || pkg.peerDependencies?.[dependency]).map(([name]) => name).sort();
    assert.deepEqual(parents, [parent], `reviewed telemetry parent changed: ${dependency}`);
  }
  const gaxiosRoot = path.resolve(path.dirname(require.resolve('gaxios')), '../../..');
  const sources = [path.join(gaxiosRoot, 'package.json')];
  for (const format of ['cjs', 'esm']) sources.push(...await javascriptFiles(path.join(gaxiosRoot, 'build', format, 'src')));
  const reviewedSources = await Promise.all(sources.sort().map(async file =>
    [path.relative(gaxiosRoot, file).split(path.sep).join('/'), await readFile(file, 'utf8')]));
  assert.equal(createHash('sha256').update(JSON.stringify(reviewedSources)).digest('hex'),
    'c4f53a7081a7fe18b5ef775e98dd3a8957ebf15e092157ca139daf07438253de',
    'reviewed Gaxios runtime source or export map changed');

  const parserCallers = [];
  for (const root of [pdsRoot, awsRoot]) {
    for (const file of await javascriptFiles(path.join(root, 'dist'))) {
      const source = await readFile(file, 'utf8');
      if (/from ['"]file-type['"]/.test(source)) parserCallers.push(path.relative(root, file));
      assert.ok(!/from ['"]key-encoder['"]|from ['"]elliptic['"]/.test(source), 'legacy public-key caller restored');
    }
  }
  assert.deepEqual(parserCallers, ['dist/actor-store/blob/transactor.js']);
  const transactorPath = path.join(pdsRoot, parserCallers[0]);
  const transactor = await readFile(transactorPath, 'utf8');
  assert.match(transactor, /new FileTypeParser\(options\)/);
  assert.match(transactor, /parser\.fromTokenizer\(tokenizer\)/);
  assert.equal(createRequire(transactorPath).resolve('file-type'), require.resolve('file-type'));
  const { fileTypeFromBuffer } = await import(pathToFileURL(require.resolve('file-type')));
  const samples = [];
  for (const size of [0n, 1n, 23n, 24n, 0xffffffffffffffffn, null]) {
    const bytes = Buffer.from(asf); if (size !== null) bytes.writeBigUInt64LE(size, 46);
    const body = size === null ? bytes.subarray(0, 43) : bytes;
    const type = await fileTypeFromBuffer(body);
    assert.deepEqual(type, size === 0n || size === 1n || size === 23n ? undefined : { ext: 'asf', mime: 'application/vnd.ms-asf' });
    // The PDS tokenizes a stream of unknown length; these truncated inputs
    // deliberately fall back to opaque bytes rather than the buffer classifier.
    samples.push([body, 'application/octet-stream']);
  }

  const { createPublicKeyObject, AuthVerifier } = await import(pathToFileURL(path.join(pdsRoot, 'dist/auth-verifier.js')));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const formatted = createPublicKeyObject(raw.toString('hex'));
  assert.deepEqual(formatted.export({ format: 'der', type: 'spki' }), der);
  assert.deepEqual(createPublicKeyObject(ECDH.convertKey(raw, 'secp256k1', undefined, undefined, 'compressed').toString('hex')).export({ format: 'der', type: 'spki' }), der);
  assert.throws(() => createPublicKeyObject('00'.repeat(33)));
  const payload = { sub: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', aud: 'did:web:pds.localhost', scope: 'com.atproto.access', exp: Math.floor(Date.now() / 1000) + 60 };
  const unsigned = [{ alg: 'ES256K', typ: 'JWT' }, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const token = unsigned + '.' + sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const options = { scopes: ['com.atproto.access'], algorithms: ['ES256K'], audience: payload.aud };
  const verified = await AuthVerifier.prototype.verifyBearerJwt.call({ _jwtKey: formatted }, { headers: { authorization: `Bearer ${token}` } }, options);
  assert.equal(verified.sub, payload.sub);
  const forged = token.slice(0, token.lastIndexOf('.') + 1) + Buffer.alloc(64).toString('base64url');
  await assert.rejects(AuthVerifier.prototype.verifyBearerJwt.call({ _jwtKey: formatted }, { headers: { authorization: `Bearer ${forged}` } }, options), /Token could not be verified/);
  const aws = require('@aws-sdk/client-kms');
  const originalGet = aws.KMS.prototype.getPublicKey;
  let kmsCalls = 0;
  aws.KMS.prototype.getPublicKey = async function (input) { assert.deepEqual(input, { KeyId: 'fixture-key' }); kmsCalls++; return { PublicKey: der }; };
  try {
    const { KmsKeypair } = await import(pathToFileURL(path.join(awsRoot, 'dist/kms.js')));
    const key = await KmsKeypair.load({ keyId: 'fixture-key', region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    assert.deepEqual(Buffer.from(key.publicKey), raw); assert.equal(kmsCalls, 1);
  } finally { aws.KMS.prototype.getPublicKey = originalGet; }

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
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
    for (const [body, mime] of [...samples, [png, 'image/png'], [Buffer.from('unrecognized fixture content'), 'application/octet-stream']]) {
      // Upstream now handles the old ASF shapes finitely as opaque/ASF uploads;
      // arbitrary blob bytes are permitted. Record validation is a separate gate.
      const response = await upload(body); assert.equal(response.status, 200);
      assert.equal(response.json.blob.mimeType, mime); assert.equal(response.json.blob.size, body.length);
      const cid = cidForRawHash(createHash('sha256').update(body).digest()).toString();
      assert.equal(response.json.blob.ref.$link, cid);
      const row = (await rows()).find(row => row.cid === cid); assert.ok(row); assert.equal(row.mimeType, mime);
      assert.deepEqual(await readFile(pds.ctx.blobstore(did).getTmpPath(row.tempKey)), body);
      const available = await fetch(origin + '/xrpc/com.atproto.server.getSession', { headers: { authorization: auth }, signal: AbortSignal.timeout(3000) });
      assert.equal(available.status, 200); assert.equal((await available.json()).did, did);
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
