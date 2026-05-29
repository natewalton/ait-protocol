// Verifies the lastSeenNotificationAt cursor field added in step 2 of
// specs/notification-push.md. Four assertions:
//   (a) initial getLastSeenNotificationAt returns null on a fresh identity
//   (b) updateLastSeenNotificationAt persists and is readable
//   (c) saveIdentity preserves the cursor across rewrite (JWT-refresh case)
//   (d) updateLastSeenNotificationAt on an absent identity file is a no-op
// No network. Uses a synthetic AIT_MCP_TEST_SESSION_ID and reaches the
// compiled storage module via dynamic import after setting the env var.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSION = randomUUID()
process.env.AIT_MCP_TEST_SESSION_ID = SESSION
delete process.env.CLAUDE_PROJECT_DIR  // force the test-override branch

const fileFor = (sid) =>
  join(
    homedir(),
    '.local',
    'share',
    'ait-mcp',
    `identity-${createHash('sha256').update(sid).digest('hex').slice(0, 16)}.json`,
  )

const target = fileFor(SESSION)
if (existsSync(target)) rmSync(target)

const storage = await import('../dist/storage.js')

const stub = {
  did: 'did:plc:test',
  handle: 'cursortest.test',
  password: 'pw',
  accessJwt: 'access-1',
  refreshJwt: 'refresh-1',
}

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`ok    ${label}`)
  } else {
    console.error(`FAIL  ${label} ${detail}`)
    failures++
  }
}

// (a) absent file → null cursor
check('(a) getLastSeen before save returns null', storage.getLastSeenNotificationAt() === null)

// (d) updateLastSeen on absent file is a no-op (no throw, no file written)
storage.updateLastSeenNotificationAt('2026-01-01T00:00:00.000Z')
check('(d) update without identity is no-op (no file)', !existsSync(target))

storage.saveIdentity(stub)
check('(a.2) freshly-saved identity has null cursor', storage.getLastSeenNotificationAt() === null)

// (b) update + read round-trip
const STAMP1 = '2026-05-29T16:00:00.000Z'
storage.updateLastSeenNotificationAt(STAMP1)
check('(b) cursor reads back what we wrote', storage.getLastSeenNotificationAt() === STAMP1)

// (c) saveIdentity preserves cursor (JWT-refresh scenario)
storage.saveIdentity({ ...stub, accessJwt: 'access-2', refreshJwt: 'refresh-2' })
check(
  '(c) cursor survives saveIdentity rewrite (JWT refresh)',
  storage.getLastSeenNotificationAt() === STAMP1,
)

// Bonus: identity also round-trips with cursor preserved
const reloaded = storage.loadIdentity()
check('reload finds identity', reloaded?.handle === stub.handle)
check('reload has fresh JWT', reloaded?.accessJwt === 'access-2')

rmSync(target)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
