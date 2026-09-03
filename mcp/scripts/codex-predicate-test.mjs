#!/usr/bin/env node

// Proves the shared heartbeat predicate: while Codex has no active sink, no
// registration is attempted; reconnecting attempts immediately. An
// unreachable local port makes an attempt observable without a host call.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PDS_URL = 'http://127.0.0.1:1'
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ait-codex-predicate-'))
const dist = process.argv[2]
const { setIdentity } = await import(join(dist, 'session.js'))
const { startPushListener, tryRegister } = await import(join(dist, 'push.js'))

setIdentity({
  did: 'did:plc:fake',
  handle: 'fake.test',
  password: 'x',
  accessJwt: 'a',
  refreshJwt: 'r',
})

let attempts = 0
const realError = console.error
console.error = (...args) => {
  if (String(args[0]).includes('registerPushTarget error')) attempts += 1
}

let activeSink = null
const canRegister = () => activeSink !== null
await startPushListener(async () => {}, canRegister)
await tryRegister(canRegister)
const beforeReconnect = attempts
activeSink = async () => {}
await tryRegister(canRegister)
const afterReconnect = attempts
await tryRegister()
console.error = realError

console.log(
  `attempts while inactive: ${beforeReconnect}; ` +
    `after reconnect: ${afterReconnect}; default predicate: ${attempts}`,
)
const passed = beforeReconnect === 0 && afterReconnect === 1 && attempts === 2
console.log(passed
  ? 'ok - predicate skips while inactive and attempts when active'
  : 'NOT OK - predicate behavior')
process.exit(passed ? 0 : 1)
