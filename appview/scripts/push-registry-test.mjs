// Focused offline test for the push registry added in step 3 of
// specs/notification-push.md. Verifies, without standing up the firehose:
//   (a) isValidPushUrl accepts only http://127.0.0.1:<port>/... URLs
//   (b) registerAndReplay POSTs backlog notifications oldest-first
//   (c) registerAndReplay from current seq skips replay
//   (d) registerAndReplay on POST failure removes the registration
//   (e) notifyInsert pushes a freshly-inserted row to the registered URL
//   (f) notifyInsert on POST failure removes the registration

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'push-registry-test-'))

const { openDb } = await import('../dist/db.js')
const registry = await import('../dist/pushRegistry.js')

const db = openDb(join(tmp, 'test.sqlite'))

const DID_A = 'did:plc:alice'
const DID_AUTHOR = 'did:plc:bob'

// Stub idResolver. ADR-0038 push hydration calls
// idResolver.did.resolveAtprotoData(did) to fill in author.handle on each
// pushed NotificationView. We're offline (no PLC reachable for the
// placeholder DIDs above), so return a canned handle keyed by DID.
const HANDLES = {
  [DID_A]: 'alice.test',
  [DID_AUTHOR]: 'bob.test',
}
const idResolver = {
  did: {
    resolveAtprotoData: async (did) => ({
      did,
      handle: HANDLES[did] ?? 'unknown.test',
      signingKey: '',
      pds: '',
    }),
  },
}

function seedActor(did) {
  db.prepare(
    `INSERT INTO actors (did, active, indexedAt) VALUES (?, 1, ?)
     ON CONFLICT(did) DO NOTHING`,
  ).run(did, '2026-05-29T00:00:00.000Z')
}
function seedPost(uri, did, text, createdAt) {
  db.prepare(
    `INSERT INTO posts (uri, cid, did, text, facets, replyRootUri, replyParentUri, replyRootCid, replyParentCid, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(uri, `cid-${uri}`, did, text, createdAt, createdAt)
}
function seedNotification(uri, recipientDid, authorDid, createdAt) {
  db.prepare(
    `INSERT INTO notifications (uri, cid, recipientDid, authorDid, reason, reasonSubject, createdAt, indexedAt)
     VALUES (?, ?, ?, ?, 'mention', ?, ?, ?)`,
  ).run(uri, `cid-${uri}`, recipientDid, authorDid, uri, createdAt, createdAt)
}

seedActor(DID_AUTHOR)
seedActor(DID_A)

// Mock fetch transport. Records every POST body; can be set to fail on demand.
let received = []
let failNext = false
let onFetch = null
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  received.push(body)
  const hook = onFetch
  onFetch = null
  if (hook) hook()
  if (failNext) {
    return new Response('', { status: 500 })
  }
  return new Response('ok', { status: 200 })
}
const URL_OK = 'http://127.0.0.1:9999/notify'

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`ok    ${label}`)
  } else {
    console.error(`FAIL  ${label} ${detail}`)
    failures++
  }
}

// (a) URL validation
check('(a) accepts http://127.0.0.1:8000/x', registry.isValidPushUrl('http://127.0.0.1:8000/notify'))
check('(a) rejects https scheme', !registry.isValidPushUrl('https://127.0.0.1:8000/notify'))
check('(a) rejects localhost hostname', !registry.isValidPushUrl('http://localhost:8000/notify'))
check('(a) rejects external host', !registry.isValidPushUrl('http://10.0.0.1:8000/notify'))
check('(a) rejects ipv6 loopback', !registry.isValidPushUrl('http://[::1]:8000/notify'))
check('(a) rejects garbage', !registry.isValidPushUrl('not a url'))

// (b) registerAndReplay replays backlog oldest-first
seedPost('at://b/p/1', DID_AUTHOR, 'one', '2026-05-29T10:00:00.000Z')
seedPost('at://b/p/2', DID_AUTHOR, 'two', '2026-05-29T11:00:00.000Z')
seedPost('at://b/p/3', DID_AUTHOR, 'three', '2026-05-29T12:00:00.000Z')
seedNotification('at://b/p/1', DID_A, DID_AUTHOR, '2026-05-29T10:00:00.000Z')
seedNotification('at://b/p/2', DID_A, DID_AUTHOR, '2026-05-29T11:00:00.000Z')
seedNotification('at://b/p/3', DID_A, DID_AUTHOR, '2026-05-29T12:00:00.000Z')

received = []
registry._clear()
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, 1)
check('(b) replay delivered exactly 2 events', received.length === 2)
check('(b) oldest first', received[0]?.uri === 'at://b/p/2' && received[1]?.uri === 'at://b/p/3')
check('(b) registration still live', registry._registeredUrl(DID_A) === URL_OK)

// (c) current seq skips replay
received = []
registry._clear()
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, 3)
check('(c) current seq delivers 0 events', received.length === 0)
check('(c) registration live', registry._registeredUrl(DID_A) === URL_OK)

// (d) POST failure during replay removes registration and bails
received = []
registry._clear()
failNext = true
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, 0)
failNext = false
check('(d) replay attempted at least one POST', received.length >= 1)
check('(d) registration removed after failure', registry._registeredUrl(DID_A) === undefined)

// (e) notifyInsert pushes the freshly-inserted row
received = []
registry._clear()
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, 3)
seedPost('at://b/p/4', DID_AUTHOR, 'four', '2026-05-29T13:00:00.000Z')
seedNotification('at://b/p/4', DID_A, DID_AUTHOR, '2026-05-29T13:00:00.000Z')
registry.notifyInsert(db, idResolver, DID_A, 'at://b/p/4')
await registry._processAll()
check('(e) live push delivered 1 event', received.length === 1)
check('(e) live push has expected uri', received[0]?.uri === 'at://b/p/4')

// (f) notifyInsert POST failure removes registration
received = []
registry._clear()
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, 4)
failNext = true
registry.notifyInsert(db, idResolver, DID_A, 'at://b/p/4')
await registry._processAll()
failNext = false
check('(f) live push attempted', received.length === 1)
check('(f) registration removed after live-push failure', registry._registeredUrl(DID_A) === undefined)

// (g) A live insert racing the first backlog POST queues behind replay. This is
// the cutover that used to deliver [live, backlog] and let the cursor jump.
received = []
registry._clear()
seedPost('at://b/p/5', DID_AUTHOR, 'five', '2026-05-29T14:00:00.000Z')
seedNotification('at://b/p/5', DID_A, DID_AUTHOR, '2026-05-29T14:00:00.000Z')
onFetch = () => {
  seedPost('at://b/p/6', DID_AUTHOR, 'six', '2026-05-29T15:00:00.000Z')
  seedNotification('at://b/p/6', DID_A, DID_AUTHOR, '2026-05-29T15:00:00.000Z')
  registry.notifyInsert(db, idResolver, DID_A, 'at://b/p/6')
}
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, 4)
await registry._processAll()
check(
  '(g) replay/live cutover stays ordered',
  received.map((v) => v.uri).join(',') === 'at://b/p/5,at://b/p/6',
  received.map((v) => v.uri).join(','),
)

db.close()
rmSync(tmp, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
