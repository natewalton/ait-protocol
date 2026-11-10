import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { parse } from 'dotenv'
import { Secp256k1Keypair } from '@atproto/crypto'
import { Client, validateOperationLog } from '@did-plc/lib'
import { SecretKey } from '@natewalton/iroh-direct'
import { base32 } from 'multiformats/bases/base32'
import { loadState, writePrivate } from './peerState.mjs'
import { planOperatorPreparation, prepareOperatorIdentity } from './operatorIdentity.mjs'

export function installationPaths(repo) {
  const pdsDirectory = path.join(repo, 'pds'), appviewDirectory = path.join(repo, 'appview')
  const envFile = path.join(pdsDirectory, '.env')
  // PDS runs from this directory with inherited env plus a sourced, exported
  // .env. dotenv alone would ignore inherited paths and preserve shell syntax
  // literally, letting the operator bind a different store from the PDS.
  // This is the same trusted local shell config already executed by run-pds;
  // capture its values internally and never put credentials in diagnostics.
  let env
  try {
    env = JSON.parse(execFileSync('/bin/bash', ['-c',
      'set -euo pipefail; cd "$1"; set -a; source ./.env >/dev/null 2>&1; set +a; exec "$2" -e "$3"',
      'ait-pds-environment', pdsDirectory, process.execPath,
      "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PDS_')))))",
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch {
    throw Error('PDS environment could not be loaded with its service wrapper rules; inspect the local env file')
  }
  const appviewEnv = { ...parse(fs.readFileSync(path.join(appviewDirectory, '.env'))), ...process.env }
  // Match envToCfg: without DATA_DIRECTORY, the database is in the PDS cwd.
  const data = env.PDS_DATA_DIRECTORY || '.'
  const directory = path.join(path.dirname(path.resolve(appviewDirectory, appviewEnv.APPVIEW_DB_PATH || './data/appview.sqlite')), 'peers')
  return { env, envFile, directory, accountFile: path.resolve(pdsDirectory, env.PDS_ACCOUNT_DB_LOCATION || path.join(data, 'account.sqlite')) }
}
function handleDomain(hostname) {
  const label = hostname.split('.')[0]
  assert.match(label, /^[a-z2-7]{52}$/)
  return `.${label}.aitproto.com`
}

export function needsPreparation(repo) {
  const { env, directory, accountFile } = installationPaths(repo), file = path.join(directory, 'machine.json')
  const operator = planOperatorPreparation(accountFile, path.join(repo, 'appview', '.env'))
  if (operator.changed) return true
  // Never call loadState here: even an existing state causes chmod writes.
  if (!['machine.json', 'ca.pem', 'ca.key', 'tls.pem', 'tls.key'].every(name => fs.existsSync(path.join(directory, name)))) return true
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.match(state.secret, /^[a-f0-9]{64}$/)
  const id = SecretKey.fromBytes([...Buffer.from(state.secret, 'hex')]).public()
  const hostname = `${base32.baseEncode(Uint8Array.from(id.toBytes()))}.localhost`
  return env.PDS_HOSTNAME !== hostname || !env.PDS_SERVICE_DID ||
    env.PDS_SERVICE_HANDLE_DOMAINS !== handleDomain(hostname)
}

// Upstream readEnv reads process.env only. Keep this synchronous scope isolated
// from caller PDS settings and restore it before any await or service startup.
function readInstallationEnv(readEnv, env) {
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PDS_')))
  try {
    for (const key of Object.keys(previous)) delete process.env[key]
    for (const [key, value] of Object.entries(env)) if (key.startsWith('PDS_')) process.env[key] = value
    return readEnv()
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith('PDS_')) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

function readAccounts(accountFile) {
  if (!fs.existsSync(accountFile)) return []
  const accounts = new Database(accountFile, { readonly: true, fileMustExist: true })
  try { return accounts.prepare('SELECT did, handle FROM actor ORDER BY did').all() }
  finally { accounts.close() }
}

function loopback(service) {
  const listen = service.app.listen.bind(service.app)
  service.app.listen = (port, ...args) => listen(port, '127.0.0.1', ...args)
}

async function destroyPds(pds) {
  // Upstream destroy omits both Kysely handles and the DID cache queue.
  const errors = []
  for (const close of [
    () => pds.ctx.didCache.destroy(),
    () => pds.destroy(),
    () => pds.ctx.didCache.db.db.destroy(),
    () => pds.ctx.sequencer.db.db.destroy(),
  ]) {
    try { await close() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'temporary PDS cleanup failed')
}

// Update calls this only after session exclusion, while services are stopped.
// The temporary canonical PLC uses the installation's existing database and an
// ephemeral loopback listener, never the live fixed service ports.
export async function prepareInstallation(repo) {
  const { env, envFile, directory, accountFile } = installationPaths(repo)
  const originalEnv = fs.readFileSync(envFile, 'utf8')
  // Persist the local operator DID before any account handle can change. A
  // later crash leaves a durable reference that the next run can still bind.
  const operator = prepareOperatorIdentity(accountFile, path.join(repo, 'appview', '.env'))
  console.log(operator.diagnostic)
  const machine = loadState(directory), accounts = readAccounts(accountFile)
  const endpoint = `https://${machine.hostname}`
  const domain = handleDomain(machine.hostname)
  const pdsDirectory = path.join(repo, 'pds')
  const pdsRequire = createRequire(path.resolve(pdsDirectory, 'package.json'))
  const { PDS, readEnv, envToCfg, envToSecrets } = await import(pathToFileURL(pdsRequire.resolve('@atproto/pds')).href)
  const pdsEnv = readInstallationEnv(readEnv, env)
  const cfg = envToCfg(pdsEnv)
  // Capture the prior effective audience before changing the public hostname.
  const serviceDid = cfg.service.did
  if (accounts.length) {
    if (cfg.entryway) throw Error('private preparation requires the local PDS to own PLC handle updates, not an entryway')
    const targets = new Set()
    for (const account of accounts) {
      assert.equal(typeof account.handle, 'string', `actor has no handle: ${account.did}`)
      account.target = `${account.handle.split('.')[0]}${domain}`
      assert(!targets.has(account.target), `private handle collision: ${account.target}`)
      targets.add(account.target)
    }
    const secrets = envToSecrets(pdsEnv)
    const rotation = await Secp256k1Keypair.import(env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX)
    // Resolve the very same stores as the ordinary PDS launched from pds/.
    for (const key of ['accountDbLoc', 'sequencerDbLoc', 'didCacheDbLoc']) cfg.db[key] = path.resolve(pdsDirectory, cfg.db[key])
    cfg.actorStore.directory = path.resolve(pdsDirectory, cfg.actorStore.directory)
    if (cfg.blobstore.provider === 'disk') {
      cfg.blobstore.location = path.resolve(pdsDirectory, cfg.blobstore.location)
      if (cfg.blobstore.tempLocation) cfg.blobstore.tempLocation = path.resolve(pdsDirectory, cfg.blobstore.tempLocation)
    }
    assert.equal(cfg.db.accountDbLoc, accountFile)
    cfg.service = { ...cfg.service, port: 0, hostname: machine.hostname, publicUrl: endpoint, did: serviceDid }
    cfg.identity.serviceHandleDomains = [domain]
    // This owned maintenance instance must not announce to public crawlers.
    cfg.crawlers = []
    const require = createRequire(path.resolve(repo, 'plc', 'package.json'))
    const { Database: PlcDatabase, PlcServer } = require('@did-plc/server')
    const plcEnv = parse(fs.readFileSync(path.join(repo, 'plc', '.env')))
    if (!plcEnv.DATABASE_URL) throw Error('PLC DATABASE_URL is required; no mock identity directory may prepare existing actors')
    const database = PlcDatabase.postgres({ url: plcEnv.DATABASE_URL })
    let plc, pds, failure
    try {
      plc = PlcServer.create({ db: database, port: 0 })
      loopback(plc)
      const server = await plc.start(), address = server.address()
      const client = new Client(`http://127.0.0.1:${address.port}`)
      cfg.identity.plcUrl = client.url
      // Validate every signed log before opening the existing stores for writes.
      for (const { did } of accounts) {
        if (!await validateOperationLog(did, await client.getOperationLog(did))) throw Error(`cannot prepare tombstoned actor ${did}`)
      }
      pds = await PDS.create(cfg, secrets)
      loopback(pds)
      const pdsServer = await pds.start()
      const adminUrl = `http://127.0.0.1:${pdsServer.address().port}/xrpc/com.atproto.admin.updateAccountHandle`
      for (const { did, handle, target } of accounts) {
        const before = await validateOperationLog(did, await client.getOperationLog(did))
        if (!before) throw Error(`cannot prepare tombstoned actor ${did}`)
        if (handle !== target) {
          const response = await fetch(adminUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`admin:${secrets.adminPassword}`).toString('base64')}` },
            body: JSON.stringify({ did, handle: target }),
          })
          if (!response.ok) throw Error(`canonical handle preparation failed for ${did} (${response.status}): ${await response.text()}`)
          await response.arrayBuffer()
        }
        if (before.services.atproto_pds?.endpoint !== endpoint) await client.updatePds(did, rotation, endpoint)
        const after = await validateOperationLog(did, await client.getOperationLog(did))
        if (after?.services.atproto_pds?.endpoint !== endpoint) throw Error(`endpoint preparation failed: ${did}`)
        assert.equal(after.alsoKnownAs.find(alias => alias.startsWith('at://')), `at://${target}`, `handle preparation failed: ${did}`)
        assert.deepEqual(after.verificationMethods, before.verificationMethods, `actor keys changed: ${did}`)
        assert.deepEqual(after.rotationKeys, before.rotationKeys, `rotation keys changed: ${did}`)
      }
      const actual = readAccounts(accountFile)
      assert.deepEqual(actual.map(({ did, handle }) => ({ did, handle })), accounts.map(({ did, target }) => ({ did, handle: target })))
    } catch (error) { failure = error }
    finally {
      // Attempt every owned close even if an earlier close failed. PlcServer's
      // destroy owns database.close; close directly only if destroy failed.
      const errors = failure ? [failure] : []
      if (pds) { try { await destroyPds(pds) } catch (error) { errors.push(error) } }
      try { if (plc) await plc.destroy(); else await database.close() }
      catch (error) {
        errors.push(error)
        try { await database.close() } catch (closeError) { errors.push(closeError) }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '))
    }
  }
  let text = originalEnv
  for (const [key, value] of Object.entries({ PDS_HOSTNAME: machine.hostname, PDS_SERVICE_DID: serviceDid, PDS_SERVICE_HANDLE_DOMAINS: domain })) {
    const line = `${key}=${value}`
    // dotenv accepts exported, indented and repeated assignments. Replace all
    // parsed assignments so a later duplicate cannot override the final value.
    const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'gm')
    text = assignment.test(text) ? text.replace(assignment, () => line) : `${text.trimEnd()}\n${line}\n`
  }
  // Actual configuration is the completion condition, written only after all
  // signed operations succeed. Reruns inspect it, not a completion marker.
  assert.equal(fs.readFileSync(envFile, 'utf8'), originalEnv, 'PDS environment changed during preparation; rerun while stopped')
  if (text !== originalEnv) writePrivate(envFile, text)
  return { hostname: machine.hostname, actors: accounts.length }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [operation, repo] = process.argv.slice(2)
  try {
    if (!repo || !['check', 'prepare'].includes(operation)) throw Error('expected check|prepare and an installation path')
    if (operation === 'check') process.exitCode = needsPreparation(repo) ? 1 : 0
    else console.log(`Private peers prepared: ${JSON.stringify(await prepareInstallation(repo))}; no machines are linked`)
  } catch (error) { console.error(`Private-peer preparation failed: ${error.message}; rerun ait update`); process.exitCode = 1 }
}
