// Migrate only owned, quiescent fixture data from the immutable released PDS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    await checkActualPathContract(candidate, home);
    const run = (name, root, data, blobs = path.join(data, 'blobs')) => {
      const result = spawnSync(process.execPath, ['--max-old-space-size=256', script, '--phase', name, root, home, data, blobs], {
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_DATA_HOME: path.join(home, 'xdg'), LOG_ENABLED: 'false', NODE_ENV: 'test' },
        encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${name} failed: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.stdout.trim(), `${name} passed`);
      console.log(`PASS ${name}`);
    };
    const original = path.join(home, 'old-data');
    const originalBlobs = path.join(home, 'old-blobs');
    run('seed-old', old, original, originalBlobs);
    const installer = await checkTargetInstaller(candidate, home, original, originalBlobs);
    const installerBackup = installer.backup;
    const before = await directoryHashes(original);
    const blobsBefore = await directoryHashes(originalBlobs);
    const brokenCopy = path.join(home, 'failed-migration-copy');
    await cp(original, brokenCopy, { recursive: true, errorOnExist: true });
    const currentRequire = createRequire(path.join(candidate, 'pds/package.json'));
    const Sqlite = currentRequire('better-sqlite3');
    const conflict = new Sqlite(path.join(brokenCopy, 'account.sqlite'));
    conflict.exec('CREATE TABLE account_email_auth_factor (fixture_conflict INTEGER)');
    conflict.close();
    run('reject-migration', candidate, brokenCopy, originalBlobs);
    assert.deepEqual(await directoryHashes(original), before, 'failed upgrade changed the rollback source');
    const migrated = path.join(home, 'migration-copy');
    const migratedBlobs = path.join(home, 'migration-blobs');
    await cp(original, migrated, { recursive: true, errorOnExist: true });
    await cp(originalBlobs, migratedBlobs, { recursive: true, errorOnExist: true });
    assert.deepEqual(await directoryHashes(migrated), before, 'backup copy differs before migration');
    run('migrate-new', candidate, migrated, migratedBlobs);
    assert.deepEqual(await directoryHashes(original), before, 'upgrade changed the rollback source');
    assert.deepEqual(await directoryHashes(originalBlobs), blobsBefore, 'upgrade changed the rollback blobs');
    const migratedRetry = await installer.fixture('migrated-retry', 'migrated-retry', false, { data: migrated, blobs: migratedBlobs, backup: installerBackup });
    assert.equal(migratedRetry.result.status, 0, migratedRetry.result.stderr);
    assert.match(migratedRetry.result.stdout, /current data is already on PDS 0\.5/);
    assert.ok((await readFile(migratedRetry.npmLog, 'utf8')).includes('--prefix'));
    console.log('PASS migrated PDS with missing installed metadata preserves the old copy and rebuilds fix-forward');
    run('reopen-new', candidate, migrated, migratedBlobs);
    assert.deepEqual(await directoryHashes(original), before, 'reopen changed the rollback source');
    const rollback = path.join(home, 'rollback-copy');
    const rollbackBlobs = path.join(home, 'rollback-blobs');
    await cp(path.join(installerBackup, 'data'), rollback, { recursive: true, errorOnExist: true });
    await cp(path.join(installerBackup, 'external-blobs'), rollbackBlobs, { recursive: true, errorOnExist: true });
    run('rollback-old', old, rollback, rollbackBlobs);
    assert.deepEqual(await directoryHashes(original), before, 'rollback rehearsal changed the original');
    console.log('PASS immutable old fixture retained; copied upgrade, restart and old-code rollback verified');
  } finally {
    await rm(home, { recursive: true, force: true });
    await assert.rejects(lstat(home));
  }
}

async function checkActualPathContract(root, home) {
  const require = createRequire(path.join(root, 'pds/package.json'));
  const { envToCfg } = require('@atproto/pds');
  const Sqlite = require('better-sqlite3');
  const { ActorStore } = await import(pathToFileURL(path.join(root, 'pds/node_modules/@atproto/pds/dist/actor-store/actor-store.js')));
  const { DiskBlobStore } = await import(pathToFileURL(path.join(root, 'pds/node_modules/@atproto/pds/dist/disk-blobstore.js')));
  const base = path.join(home, 'actual-path-contract'), outside = path.join(home, 'actual-path-outside');
  await mkdir(path.join(base, 'real'), { recursive: true });
  await mkdir(path.join(outside, 'child'), { recursive: true });
  await symlink(path.join(outside, 'child'), path.join(base, 'link'));
  const raw = `${base}/link/../real`;
  const cfg = envToCfg({ dataDirectory: raw, blobstoreDiskLocation: raw });
  const account = new Sqlite(cfg.db.accountDbLoc); account.close();
  assert.ok(await lstat(path.join(base, 'real/account.sqlite')), 'default DB did not use PDS path.join semantics');
  const explicitRaw = `${base}/link/../explicit.sqlite`;
  const explicitCfg = envToCfg({ dataDirectory: raw, accountDbLocation: explicitRaw, actorStoreDirectory: `${base}/link/../actors`, blobstoreDiskLocation: raw });
  const explicit = new Sqlite(explicitCfg.db.accountDbLoc); explicit.close();
  assert.ok(await lstat(path.join(outside, 'explicit.sqlite')), 'explicit DB did not preserve raw kernel path semantics');
  const actor = new ActorStore(explicitCfg.actorStore, {});
  const actorLocation = await actor.getLocation(did);
  assert.ok(actorLocation.directory.startsWith(path.join(base, 'actors') + path.sep), 'actor store did not normalize with path.join');
  const blobs = new DiskBlobStore(did, raw, path.join(base, 'tmp'), path.join(base, 'quarantine'));
  await blobs.putPermanent({ toString: () => 'fixture-cid' }, png);
  assert.deepEqual(await readFile(path.join(base, 'real', did, 'fixture-cid')), png, 'blob store did not normalize with path.join');
  console.log('PASS actual PDS DB, actor and blob paths establish the ambiguity guard');
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

async function checkTargetInstaller(root, home, realData, realBlobs) {
  const targetRequire = createRequire(path.join(root, 'pds/package.json'));
  const FixtureSqlite = targetRequire('better-sqlite3');
  async function fixture(name, mode = 'quiet', existingBackup = false, supplied = {}) {
    const checkout = path.join(home, name === 'quoted-checkout' ? "installer-quote'" : `installer-${name}`);
    const backup = path.join(checkout, 'pds/data/pds-0.4.226-before-0.5.59');
    const stage = `${backup}.tmp`;
    let data = supplied.data ?? (name === 'old-updater' ? realData : mode === 'overlap' ? path.join(checkout, 'pds/data') : mode === 'stage-data' ? stage : mode === 'stage-nested' ? path.join(stage, 'nested') : path.join(home, `data-${name}`));
    let blobs = supplied.blobs ?? (name === 'old-updater' ? realBlobs : mode === 'stage-blobs' ? stage : path.join(home, `blobs-${name}`));
    let dataValue = data, blobValue = blobs;
    const externalAccount = path.join(home, `account-${name}.sqlite`);
    const state = path.join(home, `state-${name}`);
    const shim = path.join(home, `bin-${name}`);
    const npmLog = path.join(home, `npm-${name}.log`);
    for (const dir of ['bin', 'plc', 'pds', 'appview', 'mcp', 'pds/node_modules/@atproto/pds']) {
      await mkdir(path.join(checkout, dir), { recursive: true });
    }
    const preservedRoots = [];
    if (mode === 'parent-relative') {
      data = path.join(checkout, 'data-parent'); dataValue = '../data-parent';
      blobs = path.join(checkout, 'blobs-parent'); blobValue = '../blobs-parent';
    } else if (mode === 'plain-symlink') {
      data = path.join(home, 'plain-data-target'); blobs = path.join(home, 'plain-blob-target');
      dataValue = 'plain-data-link'; blobValue = 'plain-blob-link';
      await symlink(data, path.join(checkout, 'pds', dataValue));
      await symlink(blobs, path.join(checkout, 'pds', blobValue));
    } else if (mode === 'ambiguous-data') {
      const outside = path.join(home, 'ambiguous-data-outside');
      await mkdir(path.join(outside, 'child'), { recursive: true });
      await symlink(path.join(outside, 'child'), path.join(checkout, 'pds/data-link'));
      data = path.join(checkout, 'pds/real'); dataValue = 'data-link/../real';
      preservedRoots.push(path.join(outside, 'real'));
    } else if (mode === 'ambiguous-blobs') {
      const outside = path.join(home, 'ambiguous-blob-outside');
      await mkdir(path.join(outside, 'child'), { recursive: true });
      await symlink(path.join(outside, 'child'), path.join(checkout, 'pds/blob-link'));
      blobs = path.join(checkout, 'pds/real-blobs'); blobValue = 'blob-link/../real-blobs';
      preservedRoots.push(path.join(outside, 'real-blobs'));
    } else if (mode === 'case-data') {
      data = path.join(checkout, 'pds/data'); dataValue = path.join(checkout, 'pds/Data');
    } else if (mode === 'case-stage') {
      data = stage; dataValue = stage.replace('/pds/data/', '/pds/Data/').replace('/pds-', '/PDS-').replace(/\.tmp$/, '.TMP');
    } else if (mode === 'case-blobs') {
      blobs = stage; blobValue = stage.replace('/pds/data/', '/pds/Data/').replace('/pds-', '/PDS-').replace(/\.tmp$/, '.TMP');
    } else if (mode === 'late-case-blob') {
      blobs = backup.replace('/pds/data/', '/pds/DATA/'); blobValue = blobs;
    }
    if (['ambiguous-account', 'ambiguous-actor'].includes(mode)) {
      const outside = path.join(home, `ambiguous-override-${mode}`);
      await mkdir(path.join(outside, 'child'), { recursive: true });
      await symlink(path.join(outside, 'child'), path.join(checkout, 'pds/override-link'));
      await mkdir(path.join(outside, mode === 'ambiguous-actor' ? 'actors' : 'account.sqlite'), { recursive: mode === 'ambiguous-actor' });
      preservedRoots.push(outside);
    }
    if (mode === 'dangling-root') await symlink(path.join(home, 'missing-rollback-root'), path.join(checkout, 'pds/data'));
    await mkdir(data, { recursive: true });
    if (mode !== 'late-case-blob') await mkdir(blobs, { recursive: true });
    await mkdir(shim, { recursive: true });
    for (const root of preservedRoots) { await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'preserve'), `preserve ${mode}\n`, { mode: 0o640 }); }
    if (['overlap', 'stage-data', 'stage-nested'].includes(mode)) await chmod(data, 0o755);
    if (mode === 'stage-blobs') await chmod(blobs, 0o755);
    const copies = [
      'bin/install.sh', 'bin/lib-service-pids.sh',
      'plc/package.json', 'plc/package-lock.json', 'pds/package.json', 'pds/package-lock.json',
      'appview/package.json', 'appview/package-lock.json', 'mcp/package.json', 'mcp/package-lock.json',
    ];
    for (const file of copies) await writeFile(path.join(checkout, file), await readFile(path.join(root, file)));
    for (const file of ['ait', 'bin/status.sh', 'bin/start-all.sh', 'bin/claude-session.sh', 'bin/codex-session.sh']) {
      await writeFile(path.join(checkout, file), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    }
    await chmod(path.join(checkout, 'bin/install.sh'), 0o755);
    await writeFile(path.join(checkout, 'bin/check-single-lexicon.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    if (!['unknown-version', 'unknown-external-account', 'fresh', 'migrated-retry'].includes(mode)) {
      await writeFile(path.join(checkout, 'pds/node_modules/@atproto/pds/package.json'), '{"version":"0.4.226"}\n');
    }
    if (!supplied.data && !['fresh', 'unknown-external-account'].includes(mode) && name !== 'old-updater') {
      if (mode === 'corrupt-account') await writeFile(path.join(data, 'account.sqlite'), 'not a sqlite database');
      else {
        const account = new FixtureSqlite(path.join(data, 'account.sqlite'));
        account.exec("CREATE TABLE kysely_migration(name varchar(255), timestamp varchar(255)); INSERT INTO kysely_migration VALUES ('007', 'fixture')");
        account.close();
      }
      await mkdir(path.join(data, 'actors', did), { recursive: true });
      await writeFile(path.join(data, 'actors', did, 'key'), 'old-actor-signing-key');
      if (mode !== 'late-case-blob') await writeFile(path.join(blobs, 'fixture.png'), png);
    }
    const envPath = path.join(checkout, 'pds/.env');
    const envLines = [
      ...(mode === 'missing-data' ? [] : [`PDS_DATA_DIRECTORY=${dataValue}`]), `PDS_BLOBSTORE_DISK_LOCATION=${blobValue}`,
      ...(mode === 'external-temp' ? [`PDS_BLOBSTORE_DISK_TMP_LOCATION=${path.join(home, 'external-temp')}`] : []),
      ...(['external-account', 'unknown-external-account'].includes(mode) ? [`PDS_ACCOUNT_DB_LOCATION=${externalAccount}`] : []),
      ...(mode === 'ambiguous-account' ? ['PDS_ACCOUNT_DB_LOCATION=override-link/../account.sqlite'] : []),
      ...(mode === 'ambiguous-actor' ? ['PDS_ACTOR_STORE_DIRECTORY=override-link/../actors'] : []),
      'PDS_JWT_SECRET=old-jwt-secret', 'PDS_ADMIN_PASSWORD=old-admin-password',
      'PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=old-plc-rotation-key', '',
    ];
    if (mode === 'case-env') {
      const physicalEnv = path.join(checkout, 'pds/Data/env-source');
      await mkdir(path.dirname(physicalEnv), { recursive: true });
      await writeFile(physicalEnv, envLines.join('\n'), { mode: 0o600 });
      await symlink(physicalEnv, envPath);
      preservedRoots.push(path.dirname(physicalEnv));
    } else await writeFile(envPath, envLines.join('\n'), { mode: 0o600 });
    if (['external-account', 'unknown-external-account'].includes(mode)) await writeFile(externalAccount, 'external account database', { mode: 0o640 });
    for (const service of ['plc', 'appview', 'mcp']) await writeFile(path.join(checkout, service, '.env'), '', { mode: 0o600 });
    await writeFile(path.join(shim, 'npm'), `#!/bin/bash\n[ "$EXPECT_COPY" = 0 ] || [ -f "$EXPECTED_BACKUP/COMPLETE" ] || exit 91\nprintf '%s\\n' "$*" >> "$NPM_LOG"\n`, { mode: 0o755 });
    await writeFile(path.join(shim, 'lsof'), `#!/bin/bash\ncase "$MODE:$*" in\n  listener:*iTCP:2583*) echo 424242 ;;\n  prebind:*'-p 424242 '*) echo "n$FIXTURE_ROOT/pds" ;;\nesac\n`, { mode: 0o755 });
    await writeFile(path.join(shim, 'pgrep'), `#!/bin/bash\n[ "$MODE" != prebind ] || echo 424242\n`, { mode: 0o755 });
    await writeFile(path.join(shim, 'ps'), `#!/bin/bash\n[ "$MODE" != prebind ] || echo 'node launcher.js'\n`, { mode: 0o755 });
    await writeFile(path.join(shim, 'cp'), `#!/bin/bash\n[ "$MODE" != copy-fail ] || exit 77\nexec /bin/cp "$@"\n`, { mode: 0o755 });
    await writeFile(path.join(shim, 'mv'), `#!/bin/bash\n[ "$MODE" != mv-fail ] || exit 77\nexec /bin/mv "$@"\n`, { mode: 0o755 });
    const lock = path.join(state, 'ait-protocol/update.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'pid'), `${mode === 'other-lock' ? process.ppid : process.pid}\n`);
    if (existingBackup) {
      await mkdir(backup, { recursive: true });
      await writeFile(path.join(backup, 'COMPLETE'), 'foreign rollback copy\n');
    }
    if (supplied.backup) {
      await mkdir(path.dirname(backup), { recursive: true });
      await cp(supplied.backup, backup, { recursive: true, errorOnExist: true });
    }
    const preservedBefore = Object.fromEntries(await Promise.all(preservedRoots.map(async root => [root, await directoryHashes(root)])));
    const dataBefore = await directoryHashes(data), blobStat = await lstat(blobs).catch(() => null);
    const blobsBefore = blobStat ? await directoryHashes(blobs) : null;
    const dataMode = (await stat(data)).mode & 0o777, blobsMode = blobStat && (blobStat.mode & 0o777);
    if (mode === 'unreadable-data') await chmod(data, 0o000);
    if (mode === 'unreadable-account') await chmod(path.join(data, 'account.sqlite'), 0o000);
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: state, PATH: `${shim}:${process.env.PATH}`, MODE: mode, FIXTURE_ROOT: checkout, EXPECTED_BACKUP: backup, EXPECT_COPY: ['fresh', 'parent-relative', 'plain-symlink'].includes(mode) ? '0' : '1', NPM_LOG: npmLog };
    const result = spawnSync('/bin/bash', [path.join(checkout, 'bin/install.sh'), '--rebuild-only'], {
      cwd: checkout,
      env,
      encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    if (mode === 'unreadable-data') await chmod(data, dataMode);
    if (mode === 'unreadable-account') await chmod(path.join(data, 'account.sqlite'), 0o600);
    const externalAccountStat = await lstat(externalAccount).catch(() => null);
    return {
      checkout, data, blobs, backup, npmLog, env, result, externalAccount,
      dataBefore, blobsBefore, dataMode, blobsMode, preservedBefore,
      externalAccountMode: externalAccountStat && (externalAccountStat.mode & 0o777),
    };
  }

  const good = await fixture('old-updater');
  assert.equal(good.result.status, 0, good.result.stderr);
  assert.match(good.result.stdout, /PDS rollback copy:/);
  assert.deepEqual(await directoryHashes(path.join(good.backup, 'data')), await directoryHashes(good.data));
  assert.deepEqual(await directoryHashes(path.join(good.backup, 'external-blobs')), await directoryHashes(good.blobs));
  assert.deepEqual(await readFile(path.join(good.backup, 'pds.env')), await readFile(path.join(good.checkout, 'pds/.env')));
  assert.equal((await stat(good.backup)).mode & 0o077, 0, 'rollback directory is not private');
  assert.equal((await stat(path.join(good.backup, 'pds.env'))).mode & 0o077, 0, 'rollback environment is not private');
  assert.ok((await readFile(good.npmLog, 'utf8')).includes('--prefix'), 'dependency command did not run after the copy');
  console.log('PASS old updater invokes target rebuild only after private PDS rollback copy');
  const quoted = await fixture('quoted-checkout');
  assert.equal(quoted.result.status, 0, quoted.result.stderr);
  assert.match(quoted.result.stdout, /PDS rollback copy:/);
  assert.ok((await readFile(quoted.npmLog, 'utf8')).includes('--prefix'));
  console.log('PASS quoted checkout still crosses through the rollback copy');
  const retry = spawnSync('/bin/bash', [path.join(good.checkout, 'bin/install.sh'), '--rebuild-only'], {
    cwd: good.checkout, env: good.env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /existing verified copy/);
  console.log('PASS exact completed rollback copy supports a rebuild retry');
  await rm(path.join(good.checkout, 'pds/node_modules/@atproto/pds/package.json'));
  const interruptedRetry = spawnSync('/bin/bash', [path.join(good.checkout, 'bin/install.sh'), '--rebuild-only'], {
    cwd: good.checkout, env: good.env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  assert.equal(interruptedRetry.status, 0, interruptedRetry.stderr);
  assert.match(interruptedRetry.stdout, /existing verified copy/);
  console.log('PASS interrupted dependency install reuses only the exact completed rollback copy');
  const originalEnv = await readFile(path.join(good.checkout, 'pds/.env'));
  const npmBeforeMismatch = await readFile(good.npmLog, 'utf8');
  await writeFile(path.join(good.checkout, 'pds/.env'), Buffer.concat([originalEnv, Buffer.from('# changed after copy\n')]));
  const mismatchedRetry = spawnSync('/bin/bash', [path.join(good.checkout, 'bin/install.sh'), '--rebuild-only'], {
    cwd: good.checkout, env: good.env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  assert.equal(mismatchedRetry.status, 1);
  assert.match(mismatchedRetry.stderr, /cannot prove the installed PDS version/);
  assert.equal(await readFile(good.npmLog, 'utf8'), npmBeforeMismatch, 'mismatched retry reached dependency command');
  await writeFile(path.join(good.checkout, 'pds/.env'), originalEnv);
  console.log('PASS interrupted dependency retry refuses a rollback copy that no longer matches');

  const fresh = await fixture('fresh', 'fresh');
  assert.equal(fresh.result.status, 0, fresh.result.stderr);
  await assert.rejects(lstat(fresh.backup));
  assert.ok((await readFile(fresh.npmLog, 'utf8')).includes('--prefix'));
  console.log('PASS fresh 0.5 install with no payload needs no rollback copy');
  for (const mode of ['parent-relative', 'plain-symlink']) {
    const supported = await fixture(mode, mode);
    assert.equal(supported.result.status, 0, supported.result.stderr);
    assert.ok((await readFile(supported.npmLog, 'utf8')).includes('--prefix'));
    console.log(`PASS ${mode} configured storage remains supported`);
  }

  for (const [name, needle] of [
    ['listener', 'PDS port 2583 is held'], ['prebind', 'still active before listener bind'],
    ['other-lock', 'another AIT update is running'], ['unknown-version', 'cannot prove the installed PDS version'],
    ['overlap', 'overlaps.*rollback|rollback.*overlaps'], ['stage-data', 'overlaps.*rollback|rollback.*overlaps'],
    ['stage-blobs', 'overlaps.*rollback|rollback.*overlaps'], ['stage-nested', 'overlaps.*rollback|rollback.*overlaps'],
    ['external-account', 'PDS_ACCOUNT_DB_LOCATION resolves outside PDS_DATA_DIRECTORY'],
    ['unknown-external-account', 'PDS_ACCOUNT_DB_LOCATION resolves outside PDS_DATA_DIRECTORY'],
    ['missing-data', 'PDS_DATA_DIRECTORY must be set'],
    ['ambiguous-data', 'PDS_DATA_DIRECTORY resolves differently'],
    ['ambiguous-blobs', 'PDS_BLOBSTORE_DISK_LOCATION resolves differently'],
    ['ambiguous-account', 'PDS_ACCOUNT_DB_LOCATION resolves differently'],
    ['ambiguous-actor', 'PDS_ACTOR_STORE_DIRECTORY resolves differently'],
    ['case-data', 'overlaps.*rollback|rollback.*overlaps'], ['case-blobs', 'overlaps.*rollback|rollback.*overlaps'],
    ['case-stage', 'overlaps.*rollback|rollback.*overlaps'], ['case-env', 'overlaps.*rollback|rollback.*overlaps'],
    ['late-case-blob', 'overlaps.*rollback|rollback.*overlaps'],
    ['external-temp', 'PDS_BLOBSTORE_DISK_TMP_LOCATION resolves outside PDS_BLOBSTORE_DISK_LOCATION'],
    ['dangling-root', 'could not resolve PDS rollback root'],
    ['corrupt-account', 'could not inspect PDS account migration state'],
    ['unreadable-account', 'could not inspect PDS account migration state'],
    ['unreadable-data', 'could not resolve PDS account database|could not inspect configured PDS storage'],
    ['copy-fail', 'could not copy PDS environment'], ['mv-fail', 'could not publish PDS rollback copy'],
  ]) {
    const blocked = await fixture(name, name);
    assert.equal(blocked.result.status, 1, `${name} unexpectedly passed: ${blocked.result.stdout}`);
    assert.match(blocked.result.stderr, new RegExp(needle));
    await assert.rejects(lstat(blocked.npmLog));
    assert.deepEqual(await directoryHashes(blocked.data), blocked.dataBefore, `${name} refusal changed data bytes`);
    if (blocked.blobsBefore === null) await assert.rejects(lstat(blocked.blobs));
    else assert.deepEqual(await directoryHashes(blocked.blobs), blocked.blobsBefore, `${name} refusal changed blob bytes`);
    assert.equal((await stat(blocked.data)).mode & 0o777, blocked.dataMode, `${name} refusal changed data mode`);
    if (blocked.blobsMode !== null) assert.equal((await stat(blocked.blobs)).mode & 0o777, blocked.blobsMode, `${name} refusal changed blob mode`);
    for (const [root, before] of Object.entries(blocked.preservedBefore)) {
      assert.deepEqual(await directoryHashes(root), before, `${name} refusal changed alternate physical tree ${root}`);
    }
    assert.doesNotMatch(blocked.result.stdout, /PDS rollback copy:/);
    if (['external-account', 'unknown-external-account'].includes(name)) {
      assert.equal(await readFile(blocked.externalAccount, 'utf8'), 'external account database');
      assert.equal((await stat(blocked.externalAccount)).mode & 0o777, blocked.externalAccountMode);
    }
    console.log(`PASS ${name} refuses before dependency command`);
  }
  const collision = await fixture('collision', 'quiet', true);
  assert.equal(collision.result.status, 1);
  assert.match(collision.result.stderr, /existing PDS rollback copy differs/);
  assert.equal(await readFile(path.join(collision.backup, 'COMPLETE'), 'utf8'), 'foreign rollback copy\n');
  await assert.rejects(lstat(collision.npmLog));
  console.log('PASS existing rollback copy is preserved and refuses replacement');
  return { backup: good.backup, fixture };
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

async function phase(name, root, home, data, blobs) {
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
    dataDirectory: data, blobstoreDiskLocation: blobs,
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
