// Focused offline test for the push registry added in step 3 of
// specs/notification-push.md. Verifies, without standing up the firehose:
//   (a) isValidPushUrl accepts only http://127.0.0.1:<port>/... URLs
//   (b) registerAndReplay POSTs backlog notifications oldest-first
//   (c) registerAndReplay with since=null skips replay
//   (d) registerAndReplay on POST failure removes the registration
//   (e) notifyInsert pushes a freshly-inserted row to the registered URL
//   (f) notifyInsert on POST failure removes the registration

import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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

// Tiny mock MCP listener. Records every POST body; can be set to fail on demand.
let received = []
let failNext = false
const listener = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  received.push(body)
  if (failNext) {
    res.writeHead(500)
    res.end()
    return
  }
  res.writeHead(200)
  res.end('ok')
})
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
const URL_OK = `http://127.0.0.1:${port}/notify`

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
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, '2026-05-29T10:30:00.000Z')
check('(b) replay delivered exactly 2 events', received.length === 2)
check('(b) oldest first', received[0]?.uri === 'at://b/p/2' && received[1]?.uri === 'at://b/p/3')
check('(b) registration still live', registry._registeredUrl(DID_A) === URL_OK)

// (c) since=null skips replay
received = []
registry._clear()
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, null)
check('(c) since=null delivers 0 events', received.length === 0)
check('(c) registration live', registry._registeredUrl(DID_A) === URL_OK)

// (d) POST failure during replay removes registration and bails
received = []
registry._clear()
failNext = true
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, '2026-05-29T09:00:00.000Z')
failNext = false
check('(d) replay attempted at least one POST', received.length >= 1)
check('(d) registration removed after failure', registry._registeredUrl(DID_A) === undefined)

// (e) notifyInsert pushes the freshly-inserted row
received = []
registry._clear()
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, null)
seedPost('at://b/p/4', DID_AUTHOR, 'four', '2026-05-29T13:00:00.000Z')
seedNotification('at://b/p/4', DID_A, DID_AUTHOR, '2026-05-29T13:00:00.000Z')
registry.notifyInsert(db, idResolver, DID_A, 'at://b/p/4')
await delay(100)
check('(e) live push delivered 1 event', received.length === 1)
check('(e) live push has expected uri', received[0]?.uri === 'at://b/p/4')

// (f) notifyInsert POST failure removes registration
received = []
registry._clear()
await registry.registerAndReplay(db, idResolver, DID_A, URL_OK, null)
failNext = true
registry.notifyInsert(db, idResolver, DID_A, 'at://b/p/4')
await delay(100)
failNext = false
check('(f) live push attempted', received.length === 1)
check('(f) registration removed after live-push failure', registry._registeredUrl(DID_A) === undefined)

listener.close()
db.close()
rmSync(tmp, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall ok')
