// Local account and stopped-maintenance fixtures only. Never opens installed
// env files, databases, network listeners, or shared process/socket state.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { parse } from 'dotenv'
import { resolveLocalOperator, planOperatorPreparation, applyOperatorPreparation,
  prepareOperatorIdentity } from '../src/operatorIdentity.mjs'
import { installationPaths, needsPreparation, prepareInstallation } from '../src/peerPrepare.mjs'
import { loadState } from '../src/peerState.mjs'

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const machine = 'a'.repeat(52)
const canonical = `terminal-observer.${machine}.aitproto.com`

test('binding uses the PDS wrapper effective inherited and shell-expanded account store', t => {
  const { root, accountFile: stale } = fixture(t)
  const pds = path.join(root, 'pds'), appview = path.join(root, 'appview')
  fs.mkdirSync(pds); fs.mkdirSync(appview)
  const actual = path.join(root, 'actual.sqlite')
  const db = new Database(actual)
  db.exec('CREATE TABLE actor (did TEXT PRIMARY KEY, handle TEXT)')
  db.prepare('INSERT INTO actor VALUES (?, ?)').run(B, 'terminal-observer.test'); db.close()
  fs.writeFileSync(path.join(pds, '.env'), 'PDS_DATA_DIRECTORY=.pds/\n')
  fs.writeFileSync(path.join(appview, '.env'), 'APPVIEW_DB_PATH=./data/file.sqlite\n')
  const previous = Object.fromEntries(['HOME', 'PDS_ACCOUNT_DB_LOCATION', 'APPVIEW_DB_PATH'].map(key => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  } })
  process.env.PDS_ACCOUNT_DB_LOCATION = actual
  process.env.APPVIEW_DB_PATH = path.join(root, 'runtime/projection.sqlite')
  let paths = installationPaths(root)
  assert.equal(paths.accountFile, actual)
  assert.equal(resolveLocalOperator(paths.accountFile, 'terminal-observer.test').did, B)
  assert.equal(paths.directory, path.join(root, 'runtime/peers'))
  process.env.HOME = root
  process.env.PDS_ACCOUNT_DB_LOCATION = stale
  fs.writeFileSync(path.join(pds, '.env'), 'PDS_ACCOUNT_DB_LOCATION="$HOME/actual.sqlite"\nPDS_JWT_SECRET=fixture-secret\n')
  paths = installationPaths(root)
  assert.equal(paths.accountFile, actual, 'PDS sourced file overrides inherited path and expands HOME')
  assert.equal(resolveLocalOperator(paths.accountFile, 'terminal-observer.test').did, B)
  fs.writeFileSync(path.join(pds, '.env'), 'PDS_JWT_SECRET="fixture-secret-with-broken-quote\n')
  assert.throws(() => installationPaths(root), error => !error.message.includes('fixture-secret') && /PDS environment/.test(error.message))
})
function fixture(t, actors = [{ did: A, handle: canonical }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-operator-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const accountFile = path.join(root, 'account.sqlite'), envFile = path.join(root, '.env')
  const db = new Database(accountFile)
  db.exec('CREATE TABLE actor (did TEXT PRIMARY KEY, handle TEXT)')
  for (const actor of actors) db.prepare('INSERT INTO actor VALUES (?, ?)').run(actor.did, actor.handle)
  db.close()
  fs.writeFileSync(envFile, '# fixture\nAPPVIEW_OPERATOR=terminal-observer.test\nKEEP="not printed"\n', { mode: 0o600 })
  return { root, accountFile, envFile }
}

test('binds only a unique local principal, independently of peer/projection state', t => {
  const { accountFile } = fixture(t)
  for (const reference of [A, ` @${A} `, 'terminal-observer', 'terminal-observer.test',
    'terminal-observer.aitproto.com', canonical, ` @${canonical.toUpperCase()} `]) {
    const bound = resolveLocalOperator(accountFile, reference)
    assert.equal(bound.did, A, reference)
    assert.match(bound.diagnostic, /bound to the local PDS account/)
  }
  for (const reference of [undefined, '', ' ', B, 'missing.test', 'did:not-an-identity',
    'did:PLC:broken', 'terminal-observer.other.example', 'https://bad.example', 'bad handle']) {
    const bound = resolveLocalOperator(accountFile, reference)
    assert.equal(bound.did, null, reference)
    assert.match(bound.diagnostic, /self-retirement remains available/)
  }
  const duplicate = new Database(accountFile)
  duplicate.prepare('INSERT INTO actor VALUES (?, ?)').run(B, 'terminal-observer.other.example')
  duplicate.close()
  assert.equal(resolveLocalOperator(accountFile, 'terminal-observer.test').did, null)
  assert.match(resolveLocalOperator(accountFile, 'terminal-observer').diagnostic, /multiple local accounts/)
  assert.equal(resolveLocalOperator(accountFile, canonical).did, A)
  assert.equal(resolveLocalOperator(accountFile, 'terminal-observer.other.example').did, B)
  assert.equal(resolveLocalOperator(accountFile, A).did, A)
})

test('missing, unreadable, or invalid account stores disable the role without creating files', t => {
  const { root, accountFile } = fixture(t)
  const absent = path.join(root, 'absent.sqlite')
  assert.equal(resolveLocalOperator(absent, 'terminal-observer.test').did, null)
  assert.equal(fs.existsSync(absent), false)
  const invalid = path.join(root, 'not-sqlite')
  fs.writeFileSync(invalid, 'fixture invalid database')
  assert.equal(resolveLocalOperator(invalid, A).did, null)
  fs.chmodSync(accountFile, 0o000)
  assert.equal(resolveLocalOperator(accountFile, A).did, null)
  fs.chmodSync(accountFile, 0o600)
  const malformed = new Database(accountFile)
  malformed.prepare('UPDATE actor SET did = ?').run('did:not-an-identity')
  malformed.close()
  assert.equal(resolveLocalOperator(accountFile, 'terminal-observer.test').did, null)
})

test('dry run and atomic conversion preserve unrelated dotenv values and private rollback', t => {
  const { root, accountFile, envFile } = fixture(t)
  const original = '# keep header\nexport APPVIEW_OPERATOR="wrong.test" # old assignment\n' +
    'KEEP="first\\nsecond"\n  export APPVIEW_OPERATOR = " @terminal-observer.test "\nOTHER=literal\n'
  fs.writeFileSync(envFile, original)
  const plan = planOperatorPreparation(accountFile, envFile)
  assert.equal(plan.changed, true)
  assert.equal(plan.binding.did, A)
  assert.equal(fs.readFileSync(envFile, 'utf8'), original, 'planning is read-only')
  assert.deepEqual(fs.readdirSync(root).sort(), ['.env', 'account.sqlite'])
  const result = applyOperatorPreparation(plan)
  assert.equal(result.changed, true)
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original)
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600)
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600)
  const actual = fs.readFileSync(envFile, 'utf8')
  assert.equal((actual.match(new RegExp(`APPVIEW_OPERATOR=${A}`, 'g')) ?? []).length, 2)
  assert.deepEqual(parse(actual), { APPVIEW_OPERATOR: A, KEEP: 'first\nsecond', OTHER: 'literal' })
  const files = fs.readdirSync(root).sort()
  assert.equal(prepareOperatorIdentity(accountFile, envFile).changed, false)
  assert.deepEqual(fs.readdirSync(root).sort(), files, 'rerun creates no additional rollback/temp files')
})

test('multiline quoted assignments and colon assignments follow dotenv interpretation', t => {
  const { accountFile, envFile } = fixture(t)
  fs.writeFileSync(envFile, 'APPVIEW_OPERATOR: "terminal-observer.test\n"\r\nKEEP=value\r\n')
  const result = prepareOperatorIdentity(accountFile, envFile)
  assert.equal(result.did, A)
  assert.deepEqual(parse(fs.readFileSync(envFile)), { APPVIEW_OPERATOR: A, KEEP: 'value' })
})

test('configuration precondition and private backup failures leave configuration unchanged', t => {
  const { accountFile, envFile } = fixture(t)
  const plan = planOperatorPreparation(accountFile, envFile)
  fs.appendFileSync(envFile, 'CONCURRENT=edit\n')
  assert.throws(() => applyOperatorPreparation(plan), /environment changed/)
  assert.equal(parse(fs.readFileSync(envFile)).CONCURRENT, 'edit')
  fs.writeFileSync(envFile, plan.original)
  const result = applyOperatorPreparation(plan)
  // An insecure or conflicting rollback file must not be reused on a retry.
  fs.writeFileSync(envFile, plan.original)
  fs.chmodSync(result.backup, 0o644)
  assert.throws(() => applyOperatorPreparation(plan), /rollback copy must be private/)
  assert.equal(fs.readFileSync(envFile, 'utf8'), plan.original)
  fs.chmodSync(result.backup, 0o600)
  fs.writeFileSync(result.backup, 'unrelated fixture backup')
  assert.throws(() => applyOperatorPreparation(plan), /rollback copy does not match/)
  assert.equal(fs.readFileSync(envFile, 'utf8'), plan.original)
})

test('durable DID survives a namespace mutation and a disk-only retry', t => {
  const { accountFile, envFile } = fixture(t, [{ did: A, handle: 'terminal-observer.old.example' }])
  fs.writeFileSync(envFile, 'APPVIEW_OPERATOR=terminal-observer.old.example\nKEEP=old\n')
  const { backup } = prepareOperatorIdentity(accountFile, envFile)
  // This is the account change performed after the config commit by real
  // preparation. Simulate losing all in-memory binding state immediately after.
  const db = new Database(accountFile)
  db.prepare('UPDATE actor SET handle = ? WHERE did = ?').run(canonical, A)
  db.close()
  assert.equal(resolveLocalOperator(accountFile, parse(fs.readFileSync(envFile)).APPVIEW_OPERATOR).did, A)
  assert.equal(prepareOperatorIdentity(accountFile, envFile).changed, false)
  assert.equal(resolveLocalOperator(accountFile, parse(fs.readFileSync(backup)).APPVIEW_OPERATOR).did, null,
    'restoring an obsolete full handle would not restore authority after rename')
})

test('preparation detects convertible settings but not invalid settings once peer preparation is current', t => {
  const { root, accountFile } = fixture(t)
  const repo = path.join(root, 'repo'), pds = path.join(repo, 'pds'), appview = path.join(repo, 'appview')
  fs.mkdirSync(pds, { recursive: true }); fs.mkdirSync(appview)
  const state = loadState(path.join(appview, 'data/peers'))
  const namespace = `.${state.hostname.split('.')[0]}.aitproto.com`
  fs.writeFileSync(path.join(pds, '.env'), `PDS_ACCOUNT_DB_LOCATION=${accountFile}\nPDS_HOSTNAME=${state.hostname}\nPDS_SERVICE_DID=did:web:pds.localhost\nPDS_SERVICE_HANDLE_DOMAINS=${namespace}\n`)
  const appviewEnv = path.join(appview, '.env')
  fs.writeFileSync(appviewEnv, 'APPVIEW_OPERATOR=terminal-observer.test\n')
  assert.equal(needsPreparation(repo), true)
  prepareOperatorIdentity(accountFile, appviewEnv)
  assert.equal(needsPreparation(repo), false)
  fs.writeFileSync(appviewEnv, 'APPVIEW_OPERATOR=did:not-an-identity\n')
  assert.equal(needsPreparation(repo), false, 'invalid config warns at startup without a preparation loop')
})

test('real preparation commits the operator before later preparation failure', async t => {
  const { root, accountFile } = fixture(t, [{ did: A, handle: 'terminal-observer.old.example' }])
  const repo = path.join(root, 'repo'), pds = path.join(repo, 'pds'), appview = path.join(repo, 'appview')
  fs.mkdirSync(pds, { recursive: true }); fs.mkdirSync(appview)
  fs.writeFileSync(path.join(pds, '.env'), `PDS_ACCOUNT_DB_LOCATION=${accountFile}\n`)
  const envFile = path.join(appview, '.env')
  fs.writeFileSync(envFile, 'APPVIEW_OPERATOR=terminal-observer.old.example\n')
  // The fixture intentionally has no PDS package/dependencies, so preparation
  // fails before starting any maintenance service. Its DID commit is already on disk.
  await assert.rejects(prepareInstallation(repo))
  assert.equal(parse(fs.readFileSync(envFile)).APPVIEW_OPERATOR, A)
  assert.equal(resolveLocalOperator(accountFile, A).did, A)
})
