import assert from 'node:assert/strict'
import { schemas } from '@atproto/api'
import { Lexicons } from '@atproto/lexicon'
import { cborToLexRecord, parseDataKey, verifyRepoCar } from '@atproto/repo'
import { parseAccount, parseCommitAuthenticated, parseIdentity } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import { ensureChunkIsMessage } from '@atproto/xrpc-server'
import { WebSocketKeepAlive } from '@atproto/ws-client'
import { assertRepoCarBounds, assertFrameBounds } from './inputBounds.mjs'
import { handleEvent } from './indexer.js'
import { AIT_LEXICONS } from './aitLexicons.js'

const METHOD = 'com.atproto.sync.subscribeRepos'
const LIST = 'com.atproto.sync.listRepos'
const lexicons = new Lexicons([...schemas, ...AIT_LEXICONS])
const collections = new Set(['ait.feed.post', 'ait.graph.follow', 'ait.actor.profile'])

// idResolver and both readers must be bound to this approved source. The
// source resolver verifies its DID genesis and PDS endpoint before returning.
export function createVerifiedFeed({ db, idResolver, service, agent, getJson, getRepo,
  source = 'local', isApprovedSource = () => true,
  onError = error => console.error(`feed ${source}:`, error) }) {
  let cursor = 0
  let running
  let status = { state: 'starting' }
  // Consumer lifecycle and its current WebSocket connection are independent.
  // An open stream does not establish that its cursor has caught up.
  let activeSocket, connection = 'connecting'
  const updateConnection = state => {
    if (status.state === 'failed' || status.state === 'stopped') return
    connection = state
  }
  const controller = new AbortController()
  const opened = Promise.withResolvers()
  const stream = new WebSocketKeepAlive({ agent, signal: controller.signal,
    getUrl: async () => `${service}/xrpc/${METHOD}?cursor=${cursor}`,
    // Public ws option, forwarded by the official WebSocketKeepAlive. Let the
    // upstream reconnect an asleep peer before issuing any snapshot reads.
    finishRequest(request, websocket) {
      activeSocket = websocket
      websocket.once('open', () => {
        if (activeSocket !== websocket) return
        updateConnection('connected'); opened.resolve()
      })
      websocket.once('close', () => {
        if (activeSocket === websocket && connection === 'connected') updateConnection('reconnecting')
      })
      request.end()
    } })
  async function* boundedMessages() {
    for await (const chunk of stream) {
      assertFrameBounds(chunk)
      const message = ensureChunkIsMessage(chunk)
      const body = message.body
      assert(body && typeof body === 'object' && !Array.isArray(body), 'Invalid subscription body')
      const type = message.header.t
      const value = type === undefined ? body : { ...body, $type: type.startsWith('#') ? METHOD + type : type }
      yield lexicons.assertValidXrpcMessage(METHOD, value)
    }
  }

  async function boundDocument(did, refresh = false) {
    controller.signal.throwIfAborted()
    const doc = await idResolver.did.resolve(did, refresh)
    assert(doc && doc.id === did, `Unresolved source DID: ${did}`)
    const previous = db.prepare('SELECT source FROM actors WHERE did = ?').get(did)?.source
    // A replacement machine key needs fresh approval and a signed endpoint
    // update. Old attribution may change only after the old peer is unlinked;
    // never let a peer overwrite a local or still-approved source.
    assert(previous == null || previous === source ||
      (previous !== 'local' && !isApprovedSource(previous)),
    `Source ${source} cannot overwrite ${did} from ${previous}`)
    controller.signal.throwIfAborted()
    return doc
  }

  async function project(event) {
    controller.signal.throwIfAborted()
    await handleEvent(db, event, idResolver, undefined, source)
  }

  async function account(did, doc, active, status, meta) {
    const event = parseAccount({ ...meta, did, active, status })
    assert(event, `Unsupported account status for ${did}: ${status}`)
    await project({ ...meta, event: 'identity', did, didDocument: doc })
    await project(event)
  }

  async function reconcile(did, meta, doc) {
    doc ??= await boundDocument(did)
    const key = await idResolver.did.resolveAtprotoKey(did)
    const { creates, commit } = await verifyRepoCar(assertRepoCarBounds(await getRepo(did, controller.signal)), did, key)
    const base = { ...meta, did, commit: commit.cid, blocks: commit.newBlocks, rev: commit.rev }
    const present = new Set()
    // Authenticate and validate every selected record before admitting this
    // snapshot, including its identity/account metadata.
    const records = []
    for (const entry of creates) {
      if (!collections.has(entry.collection)) continue
      const uri = AtUri.make(did, entry.collection, entry.rkey)
      present.add(uri.toString())
      const bytes = commit.newBlocks.get(entry.cid)
      assert(bytes, `Verified snapshot is missing ${uri}`)
      const record = cborToLexRecord(bytes)
      lexicons.assertValidRecord(entry.collection, record)
      records.push({ ...base, ...entry, uri, event: 'create', record })
    }
    await account(did, doc, true, undefined, meta)
    for (const record of records) await project(record)
    const previous = db.prepare(
      'SELECT uri FROM posts WHERE did = ? UNION SELECT uri FROM follows WHERE did = ? UNION SELECT uri FROM follow_duplicates WHERE did = ?',
    ).all(did, did, did)
    if (db.prepare('SELECT did FROM profiles WHERE did = ?').get(did)) {
      previous.push({ uri: AtUri.make(did, 'ait.actor.profile', 'self').toString() })
    }
    for (const row of previous) {
      if (present.has(row.uri)) continue
      const uri = new AtUri(row.uri)
      await project({ ...base, event: 'delete', uri, collection: uri.collection, rkey: uri.rkey })
    }
  }

  async function backfill() {
    let pageCursor
    do {
      controller.signal.throwIfAborted()
      const query = new URLSearchParams({ limit: '1000' })
      if (pageCursor) query.set('cursor', pageCursor)
      const page = await getJson(`/xrpc/${LIST}?${query}`, controller.signal)
      lexicons.assertValidXrpcOutput(LIST, page)
      for (const repo of page.repos) {
        const doc = await boundDocument(repo.did)
        const meta = { seq: cursor, time: new Date().toISOString() }
        if (repo.active === false) await account(repo.did, doc, false, repo.status, meta)
        else await reconcile(repo.did, meta, doc)
      }
      assert(!page.cursor || page.cursor !== pageCursor, 'listRepos pagination did not advance')
      pageCursor = page.cursor
    } while (pageCursor)
  }

  async function processMessage(message) {
    if (message.$type === `${METHOD}#info`) {
      if (message.name === 'OutdatedCursor') await backfill()
      return
    }
    const did = message.repo ?? message.did
    const doc = await boundDocument(did, message.$type === `${METHOD}#identity`)
    if (message.$type === `${METHOD}#sync` || message.tooBig === true) {
      await reconcile(did, message, doc)
    } else if (message.$type === `${METHOD}#commit`) {
      if (message.blocks?.length) assertRepoCarBounds(message.blocks)
      const events = await parseCommitAuthenticated(idResolver, message, col => collections.has(col))
      const expected = message.ops.filter(op => collections.has(parseDataKey(op.path).collection))
      assert.equal(events.length, expected.length, `Incomplete authenticated commit for ${did}`)
      for (const event of events) {
        if (event.event === 'create' || event.event === 'update') lexicons.assertValidRecord(event.collection, event.record)
      }
      for (const event of events) await project(event)
    } else if (message.$type === `${METHOD}#identity`) {
      const event = await parseIdentity(idResolver, message)
      assert(event, `Identity parsing failed for ${did}`)
      await project({ ...event, didDocument: doc })
    } else if (message.$type === `${METHOD}#account`) {
      await account(did, doc, message.active, message.status, message)
    } else {
      throw new Error(`Unsupported subscription message: ${message.$type}`)
    }
    // A partial message may have idempotent writes, but is never acknowledged.
    cursor = Math.max(cursor, message.seq)
  }

  async function consume() {
    const iterator = boundedMessages()[Symbol.asyncIterator]()
    const first = iterator.next() // Open the official stream before taking snapshots.
    void first.catch(error => controller.abort(error))
    try {
      // A quiet but open stream must backfill too. The read also propagates
      // cancellation/terminal errors if no connection ever opens.
      await Promise.race([opened.promise, first])
      await backfill()
      controller.signal.throwIfAborted()
      status = { state: 'running' }
      let next = await first
      while (!next.done) {
        await processMessage(next.value)
        next = await iterator.next()
      }
    } finally {
      controller.abort()
      await first.catch(() => {}) // Settle the one pending read before iterator cleanup.
      await iterator.return()
    }
  }

  return {
    start() {
      if (status.state === 'stopped') return running ?? Promise.resolve()
      return running ??= (async () => {
        try {
          await consume()
          if (status.state !== 'stopped') throw Error('subscription ended unexpectedly')
        } catch (error) {
          if (status.state === 'stopped') return
          status = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
          onError(error)
          throw error
        }
      })()
    },
    async destroy() {
      if (status.state !== 'failed') status = { state: 'stopped' }
      controller.abort()
      await running
    },
    getStatus() {
      return status.state === 'failed' || status.state === 'stopped'
        ? { ...status } : { ...status, connection }
    },
    getCursor() { return cursor },
  }
}
