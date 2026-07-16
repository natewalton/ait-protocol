// Verifies opaque notification cursor persistence + legacy ISO normalization.
// No network. Uses a synthetic AIT_MCP_TEST_SESSION_ID and reaches the
// compiled storage module via dynamic import after setting the env var.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION = randomUUID()
process.env.AIT_MCP_TEST_SESSION_ID = SESSION
delete process.env.CLAUDE_PROJECT_DIR  // force the test-override branch
process.env.XDG_DATA_HOME = join(tmpdir(), `ait-cursor-test-${SESSION}`)

const fileFor = (sid) =>
  join(
    process.env.XDG_DATA_HOME,
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

check(
  '(a) checkpoint before save is none',
  storage.getNotificationRegistrationCheckpoint().kind === 'none',
)

// (d) updateLastSeen on absent file is a no-op (no throw, no file written)
storage.updateLastSeenNotificationCursor('opaque-before-save')
check('(d) update without identity is no-op (no file)', !existsSync(target))

storage.saveIdentity(stub)
check(
  '(a.2) fresh identity waits for AppView baseline',
  storage.getNotificationRegistrationCheckpoint().kind === 'none',
)

const CURSOR1 = 'opaque-cursor-1'
check(
  '(b) null baseline CAS succeeds',
  storage.compareAndSwapNotificationCursor(null, CURSOR1),
)
check(
  '(b.2) opaque cursor reads back',
  storage.getNotificationRegistrationCheckpoint().value === CURSOR1,
)

// (c) saveIdentity preserves cursor (JWT-refresh scenario)
storage.saveIdentity({ ...stub, accessJwt: 'access-2', refreshJwt: 'refresh-2' })
check(
  '(c) cursor survives saveIdentity rewrite (JWT refresh)',
  storage.getNotificationRegistrationCheckpoint().value === CURSOR1,
)

// Simulate a dormant pre-seq identity. The AppView returns a normalized opaque
// predecessor; CAS must remove the legacy timestamp and must not overwrite a
// cursor that live delivery advanced first.
const disk = JSON.parse(readFileSync(target, 'utf8'))
disk.lastSeenNotificationCursor = null
disk.lastSeenNotificationAt = '2026-05-29T16:00:00.000Z'
writeFileSync(target, JSON.stringify(disk, null, 2))
check(
  '(d) legacy ISO is surfaced as since',
  storage.getNotificationRegistrationCheckpoint().kind === 'since',
)
check(
  '(d.2) legacy normalization CAS succeeds',
  storage.compareAndSwapNotificationCursor(
    '2026-05-29T16:00:00.000Z',
    'opaque-predecessor',
  ),
)
storage.updateLastSeenNotificationCursor('opaque-live')
check(
  '(d.3) stale normalization cannot regress live cursor',
  !storage.compareAndSwapNotificationCursor('opaque-predecessor', 'opaque-old'),
)
check(
  '(d.4) live cursor remains current',
  storage.getNotificationRegistrationCheckpoint().value === 'opaque-live',
)

// Bonus: identity also round-trips with cursor preserved
const reloaded = storage.loadIdentity()
check('reload finds identity', reloaded?.handle === stub.handle)
check('reload has fresh JWT', reloaded?.accessJwt === 'access-2')

rmSync(target)
rmSync(process.env.XDG_DATA_HOME, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
