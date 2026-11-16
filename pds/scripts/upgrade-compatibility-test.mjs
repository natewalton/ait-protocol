// Migrate only owned, quiescent fixture data from the immutable released PDS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const candidate = path.resolve(path.dirname(script), '../..');
const baselineArg = process.argv.indexOf('--baseline');
const baseline = baselineArg < 0 ? null : process.argv[baselineArg + 1];
const baselineHashes = {
  'package.json': '74892ac4cc7d29d8721f1535bd8d9c340ece468b7e79b0dbe6487ef5a1978d48',
  'package-lock.json': 'e3f9ae4bdc8690186400619cc408d1e1a40206a273ba4959f5bda279a82fa649',
}; // v0.1.48, b4ea412c50caf3a21f5e270f65b20906dc76f0de
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const handle = 'upgrade-fixture.test';
const email = 'upgrade-fixture@example.test';
const password = 'Upgrade-fixture-password-123456';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');

if (process.argv.includes('--phase')) {
  await phase(...process.argv.slice(process.argv.indexOf('--phase') + 1));
} else {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Run with Node 24+');
  assert.ok(baseline, 'Provide --baseline <isolated v0.1.48 source root with npm ci in pds>');
  const old = await realpath(baseline);
  assert.notEqual(old, await realpath(candidate));
  for (const [file, expected] of Object.entries(baselineHashes)) {
    assert.equal(hash(await readFile(path.join(old, 'pds', file))), expected, `baseline ${file} must match immutable v0.1.48`);
  }
  await checkInstalledPds(old, '0.4.226');
  await checkInstalledPds(candidate, '0.5.59');
  const home = await mkdtemp(path.join(tmpdir(), 'ait-pds-upgrade-'));
  try {
    process.umask(0o077);
    await writeFile(path.join(home, 'config.json'), JSON.stringify({
      jwtSecret: randomBytes(32).toString('hex'), adminPassword: randomBytes(32).toString('hex'),
      plcRotationKeyK256PrivateKeyHex: randomBytes(32).toString('hex'),
    }));
    const run = (name, root, data) => {
      const result = spawnSync(process.execPath, ['--max-old-space-size=256', script, '--phase', name, root, home, data], {
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_DATA_HOME: path.join(home, 'xdg'), LOG_ENABLED: 'false', NODE_ENV: 'test' },
        encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${name} failed: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.stdout.trim(), `${name} passed`);
      console.log(`PASS ${name}`);
    };
    const original = path.join(home, 'old-data');
    run('seed-old', old, original);
    const before = await directoryHashes(original);
    const brokenCopy = path.join(home, 'failed-migration-copy');
    await cp(original, brokenCopy, { recursive: true, errorOnExist: true });
    const currentRequire = createRequire(path.join(candidate, 'pds/package.json'));
    const Sqlite = currentRequire('better-sqlite3');
    const conflict = new Sqlite(path.join(brokenCopy, 'account.sqlite'));
    conflict.exec('CREATE TABLE account_email_auth_factor (fixture_conflict INTEGER)');
    conflict.close();
    run('reject-migration', candidate, brokenCopy);
    assert.deepEqual(await directoryHashes(original), before, 'failed upgrade changed the rollback source');
    const migrated = path.join(home, 'migration-copy');
    await cp(original, migrated, { recursive: true, errorOnExist: true });
    assert.deepEqual(await directoryHashes(migrated), before, 'backup copy differs before migration');
    run('migrate-new', candidate, migrated);
    assert.deepEqual(await directoryHashes(original), before, 'upgrade changed the rollback source');
    run('reopen-new', candidate, migrated);
    assert.deepEqual(await directoryHashes(original), before, 'reopen changed the rollback source');
    const rollback = path.join(home, 'rollback-copy');
    await cp(original, rollback, { recursive: true, errorOnExist: true });
    run('rollback-old', old, rollback);
    assert.deepEqual(await directoryHashes(original), before, 'rollback rehearsal changed the original');
    console.log('PASS immutable old fixture retained; copied upgrade, restart and old-code rollback verified');
  } finally {
    await rm(home, { recursive: true, force: true });
    await assert.rejects(lstat(home));
  }
}

async function checkInstalledPds(root, version) {
  const dir = path.join(root, 'pds');
  const lock = JSON.parse(await readFile(path.join(dir, 'package-lock.json')));
  const metadata = JSON.parse(await readFile(path.join(dir, 'node_modules/.package-lock.json')));
  const locations = new Set();
  async function visit(modules) {
    assert.equal(await realpath(modules), modules, 'fixture dependencies must not be symlinks');
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      assert.ok(entry.isDirectory(), 'fixture dependency is not a real directory');
      const full = path.join(modules, entry.name);
      if (entry.name.startsWith('@')) {
        for (const child of await readdir(full)) await pkg(path.join(full, child));
      } else await pkg(full);
    }
  }
  async function pkg(full) {
    assert.equal(await realpath(full), full, 'fixture package must not be a symlink');
    const location = path.relative(dir, full);
    const expected = lock.packages[location], installed = metadata.packages[location];
    assert.ok(expected && installed && !expected.link && !installed.link, `unrecorded or linked package: ${location}`);
    for (const field of ['version', 'resolved', 'integrity']) assert.equal(installed[field], expected[field], `stale installed ${location}:${field}`);
    assert.equal(JSON.parse(await readFile(path.join(full, 'package.json'))).version, expected.version);
    locations.add(location);
    const nested = path.join(full, 'node_modules');
    if (await lstat(nested).catch(() => null)) await visit(nested);
  }
  await visit(path.join(dir, 'node_modules'));
  assert.deepEqual([...locations].sort(), Object.keys(metadata.packages).sort(), 'installed metadata has missing packages');
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location && !entry.optional) assert.ok(locations.has(location), `required package missing: ${location}`);
  }
  const require = createRequire(path.join(dir, 'package.json'));
  assert.equal(require('@atproto/pds/package.json').version, version);
}

async function directoryHashes(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'fixture data must not contain a symlink');
      if (entry.isDirectory()) await visit(full);
      else result[path.relative(root, full)] = hash(await readFile(full));
    }
  }
  await visit(root);
  return result;
}

async function phase(name, root, home, data) {
  process.umask(0o077);
  const require = createRequire(path.join(root, 'pds/package.json'));
  const ports = new Set();
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = typeof first === 'object' ? first : { port: first, host: args[1] };
    assert.equal(opts.host ?? 'localhost', '127.0.0.1', 'unowned network host');
    assert.ok(ports.has(Number(opts.port)), `unowned network port ${opts.port}`);
    return connect.apply(this, args);
  };
  const { PDS, envToCfg, envToSecrets } = require('@atproto/pds');
  const env = {
    ...JSON.parse(await readFile(path.join(home, 'config.json'))),
    port: 0, hostname: 'pds.localhost', serviceDid: 'did:web:pds.localhost',
    dataDirectory: data, blobstoreDiskLocation: path.join(data, 'blobs'),
    didPlcUrl: 'http://127.0.0.1:1', serviceHandleDomains: ['.test'],
    inviteRequired: false, rateLimitsEnabled: false, crawlers: [],
  };
  await mkdir(data, { recursive: true });
  if (name === 'reject-migration') {
    await assert.rejects(PDS.create(envToCfg(env), envToSecrets(env)), /account_email_auth_factor.*already exists/);
    console.log(`${name} passed`);
    // Like the launcher failure path, terminate this owned process. An opening
    // failure can leave only this child's partial resources, never live services.
    process.exit(0);
  }
  const pds = await PDS.create(envToCfg(env), envToSecrets(env));
  pds.ctx.idResolver.did.resolve = async requested => {
    assert.equal(requested, did); return { id: did, alsoKnownAs: [`at://${handle}`], service: [] };
  };
  const listen = pds.app.listen.bind(pds.app);
  pds.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args);
  const server = await pds.start();
  const port = server.address().port;
  assert.ok(![2582, 2583, 2585].includes(port)); ports.add(port);
  const origin = `http://127.0.0.1:${port}`;
  async function rpc(method, body, token) {
    const response = await fetch(`${origin}/xrpc/${method}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body == null ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body == null ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${name} ${method}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  try {
    let state;
    if (name === 'seed-old') {
      const { Secp256k1Keypair } = require('@atproto/crypto');
      const key = await Secp256k1Keypair.create({ exportable: true });
      await pds.ctx.actorStore.create(did, key);
      const commit = await pds.ctx.actorStore.transact(did, store => store.repo.createRepo([]));
      const session = await pds.ctx.accountManager.createAccountAndSession({ did, handle, email, password, repoCid: commit.cid, repoRev: commit.rev });
      const response = await fetch(`${origin}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${session.accessJwt}` }, body: png, signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200); const { blob } = await response.json();
      const record = { $type: 'app.bsky.feed.post', text: 'Preserve this pre-upgrade post', createdAt: new Date().toISOString(), embed: { $type: 'app.bsky.embed.images', images: [{ image: blob, alt: 'fixture image' }] } };
      const written = await rpc('com.atproto.repo.createRecord', { repo: did, collection: 'app.bsky.feed.post', rkey: '3jzfcijpj2z2a', record }, session.accessJwt);
      await rpc('com.atproto.server.requestEmailConfirmation', null, session.accessJwt);
      const emailToken = await pds.ctx.accountManager.db.db.selectFrom('email_token').selectAll().where('did', '=', did).where('purpose', '=', 'confirm_email').executeTakeFirstOrThrow();
      state = { ...session, signingKeyDid: key.did(), record, written, blob, emailToken: emailToken.token, root: await rpc(`com.atproto.sync.getLatestCommit?did=${did}`) };
      await writeFile(path.join(home, 'state.json'), JSON.stringify(state));
    } else {
      state = JSON.parse(await readFile(path.join(home, 'state.json')));
      assert.equal((await pds.ctx.actorStore.keypair(did)).did(), state.signingKeyDid, 'actor signing key changed');
      const upgraded = name !== 'rollback-old';
      assert.equal(require('@atproto/pds/package.json').version, upgraded ? '0.5.59' : '0.4.226');
      assert.equal((await rpc('com.atproto.server.getSession', undefined, state.accessJwt)).did, did, 'old access token lost identity');
      const session = await rpc('com.atproto.server.createSession', { identifier: handle, password });
      assert.equal(session.did, did); assert.equal(session.handle, handle);
      const record = await rpc(`com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.feed.post&rkey=3jzfcijpj2z2a`);
      assert.deepEqual(record.value, state.record); assert.equal(record.cid, state.written.cid);
      const blobResponse = await fetch(`${origin}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${state.blob.ref.$link}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(blobResponse.status, 200); assert.deepEqual(Buffer.from(await blobResponse.arrayBuffer()), png);
      if (name === 'migrate-new' || name === 'rollback-old') {
        assert.deepEqual(await rpc(`com.atproto.sync.getLatestCommit?did=${did}`), state.root, 'opening changed repository root');
        const refreshed = await rpc('com.atproto.server.refreshSession', null, state.refreshJwt);
        assert.equal(refreshed.did, did, 'old refresh token no longer works');
        await rpc('com.atproto.server.confirmEmail', { email, token: state.emailToken }, session.accessJwt);
        assert.equal((await rpc('com.atproto.server.getSession', undefined, session.accessJwt)).emailConfirmed, true);
        if (name === 'migrate-new') {
          const next = await rpc('com.atproto.repo.createRecord', { repo: did, collection: 'app.bsky.feed.post', rkey: '3jzfcijpj2z2b', record: { $type: 'app.bsky.feed.post', text: 'Written after upgrade', createdAt: new Date().toISOString() } }, session.accessJwt);
          await writeFile(path.join(home, 'new-write.json'), JSON.stringify(next));
          const tables = await pds.ctx.accountManager.db.db.introspection.getTables();
          assert.ok(tables.some(table => table.name === 'account_email_auth_factor'), 'new migration did not run');
          const factors = await pds.ctx.accountManager.db.db.selectFrom('account_email_auth_factor').selectAll().execute();
          assert.equal(factors.length, 0, 'upgrade enabled a new factor for an existing account');
        }
      } else if (name === 'reopen-new') {
        const expected = JSON.parse(await readFile(path.join(home, 'new-write.json')));
        const next = await rpc(`com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.feed.post&rkey=3jzfcijpj2z2b`);
        assert.equal(next.cid, expected.cid); assert.equal(next.value.text, 'Written after upgrade');
        assert.equal((await rpc('com.atproto.server.getSession', undefined, session.accessJwt)).emailConfirmed, true);
      } else throw new Error(`unknown fixture phase ${name}`);
    }
  } finally {
    for (const transport of [pds.ctx.mailer.transporter, pds.ctx.moderationMailer.transporter]) transport.close();
    await pds.ctx.didCache.destroy(); await pds.destroy();
    await pds.ctx.didCache.db.db.destroy(); await pds.ctx.sequencer.db.db.destroy();
    net.Socket.prototype.connect = connect;
  }
  console.log(`${name} passed`);
}
