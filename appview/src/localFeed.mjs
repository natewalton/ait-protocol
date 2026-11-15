// Local PDS subscription: bounded decode and serial projection. Existing AT
// Protocol parsers retain local unauthenticated-commit/handle behavior.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { schemas } from '@atproto/api'
import { cborDecode } from '@atproto/common'
import { AtUri } from '@atproto/syntax'
import { Lexicons, jsonToLex, ipldToLex } from '@atproto/lexicon'
import { parseCommitUnauthenticated, parseAccount, parseIdentity, parseSync } from '@atproto/sync'
import { ensureChunkIsMessage } from '@atproto/xrpc-server'
import { boundedStream } from './boundedStream.mjs'
import { assertFrameBounds, assertRepoCarBounds, assertJsonBounds, INPUT_BOUNDS } from './inputBounds.mjs'
import { AIT_LEXICONS } from './aitLexicons.js'

const METHOD = 'com.atproto.sync.subscribeRepos'
const collections = new Set(['ait.feed.post', 'ait.graph.follow', 'ait.actor.profile'])
const lexicons = new Lexicons([...schemas, ...AIT_LEXICONS])
export function createLocalFeed({ service, pdsUrl, idResolver, handleEvent, handleSnapshotEvent, onError }) {
  const controller = new AbortController()
  let cursor = 0, running
  let status = { state: 'starting' }
  let revisions = new Map()
  const fail = error => {
    if (status.state !== 'stopped') status = { state: 'failed', error: error.message ?? String(error) }
    onError(error)
  }
  const ready = () => {
    if (status.state === 'starting' && [...revisions.values()].every(value => value.target === null)) status = { state: 'running' }
  }
  const origin = new URL(pdsUrl)
  const json = async (method, params) => {
    const url = new URL(`/xrpc/${method}`, origin)
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
    const timeout = new AbortController()
    const abort = () => timeout.abort(controller.signal.reason)
    controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => timeout.abort(new DOMException('local bootstrap request timed out', 'TimeoutError')), 10_000)
    const max = method === 'com.atproto.repo.listRecords' ? 8 * 1024 * 1024 : 512 * 1024
    let response
    try {
      controller.signal.throwIfAborted()
      response = await fetch(url, { signal: timeout.signal, redirect: 'error' })
      if (response.status >= 500) throw Object.assign(Error(`local bootstrap ${method} failed: ${response.status}`), { status: response.status })
      const length = Number(response.headers.get('content-length'))
      if (length > max) throw Error('local bootstrap response byte limit exceeded')
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > max) throw Error('local bootstrap response byte limit exceeded')
        chunks.push(chunk)
      }
      const result = JSON.parse(assertJsonBounds(Buffer.concat(chunks, size)).toString('utf8'))
      if (!response.ok) throw Object.assign(Error(`local bootstrap ${method} failed: ${response.status}`), { status: response.status, error: result.error })
      lexicons.assertValidXrpcOutput(method, result)
      return result
    } finally {
      clearTimeout(timer)
      await response?.body?.cancel().catch(() => {})
      controller.signal.removeEventListener('abort', abort)
    }
  }
  async function currentAccount(did) {
    try {
      const current = await json('com.atproto.sync.getRepoStatus', { did })
      assert.equal(current.did, did, 'local account status DID mismatch')
      return current
    } catch (error) {
      if (error.status !== 400 || error.error !== 'RepoNotFound') throw error
      return { did, active: false, status: 'deleted' }
    }
  }
  async function* pages(method, params, field) {
    const seen = new Set(); let pageCursor
    do {
      const page = await json(method, { ...params, cursor: pageCursor })
      yield* page[field]
      if (page.cursor && seen.has(page.cursor)) throw Error('local bootstrap pagination did not advance')
      if (page.cursor) seen.add(page.cursor)
      pageCursor = page.cursor
    } while (pageCursor)
  }
  async function bootstrap() {
    if (status.state !== 'failed') status = { state: 'starting' }
    revisions = new Map()
    for await (const repo of pages('com.atproto.sync.listRepos', { limit: 1000 }, 'repos')) {
      const account = parseAccount({ did: repo.did, active: repo.active !== false, status: repo.status, seq: cursor, time: new Date().toISOString() })
      if (account) await handleSnapshotEvent(account)
      if (repo.active === false) continue
      revisions.set(repo.did, { snapshot: repo.rev, target: repo.rev, uris: new Set() })
      let after
      try {
        for (const collection of collections) {
          for await (const item of pages('com.atproto.repo.listRecords', { repo: repo.did, collection, limit: 1 }, 'records')) {
            const uri = new AtUri(item.uri)
            assert(uri.host === repo.did && uri.collection === collection, 'local bootstrap record scope mismatch')
            const record = jsonToLex(item.value)
            lexicons.assertValidRecord(collection, record)
            const cid = jsonToLex({ $link: item.cid })
            // Projection fields only; no invented signed commit/revision metadata.
            await handleSnapshotEvent({ event: 'create', did: repo.did, uri, collection, rkey: uri.rkey, cid, record })
            revisions.get(repo.did).uris.add(item.uri)
          }
        }
      } catch (error) {
        if (error.status !== 400 || !['RepoNotFound', 'RepoDeactivated', 'RepoTakendown'].includes(error.error)) throw error
        after = await currentAccount(repo.did)
        // A concurrent deactivate/reactivate invalidated this read. Retry the
        // existing attempt rather than treating a valid state change as corruption.
        if (after.active) throw Object.assign(error, { code: 'ESTALE' })
      }
      after ??= await currentAccount(repo.did)
      const current = parseAccount({ ...after, seq: cursor, time: new Date().toISOString() })
      assert(current, 'unsupported current local account status')
      await handleSnapshotEvent(current)
      if (!after.active) revisions.delete(repo.did)
      else if (after.rev === repo.rev) revisions.get(repo.did).target = null
      else {
        assert(after.rev && after.rev >= repo.rev, 'local bootstrap revision went backwards')
        revisions.get(repo.did).target = after.rev
      }
    }
    ready()
  }
  async function processChunk(chunk, initialGapCovered = false) {
    const message = ensureChunkIsMessage(assertFrameBounds(chunk))
    const body = message.body
    assert(body && typeof body === 'object' && !Array.isArray(body), 'Invalid subscription body')
    const type = message.header.t
    const value = type === undefined ? body : { ...body, $type: type.startsWith('#') ? METHOD + type : type }
    if (value.blocks instanceof Uint8Array) assertRepoCarBounds(value.blocks)
    lexicons.assertValidXrpcMessage(METHOD, value)
    if (value.$type === METHOD + '#info') {
      if (value.name === 'OutdatedCursor' && !initialGapCovered) await bootstrap()
      return
    }
    if (value.$type === METHOD + '#sync' || value.tooBig === true) {
      await bootstrap()
      cursor = Math.max(cursor, value.seq ?? cursor)
      return
    }
    let events = []
    if (value.$type === METHOD + '#commit') {
      const parsed = await parseSync({ ...value, did: value.repo })
      assert.equal(parsed.cid.toString(), value.commit.toString(), 'local commit root CID mismatch')
      const root = cborDecode(parsed.blocks.get(parsed.cid))
      assert.equal(root.did, value.repo, 'local commit root DID mismatch')
      assert.equal(root.rev, value.rev, 'local commit root revision mismatch')
      events = await parseCommitUnauthenticated(value, collection => collections.has(collection))
      const selected = value.ops.filter(op => collections.has(op.path.split('/')[0]))
      assert.equal(events.length, selected.length, 'Selected commit operation is missing its record or CID')
    }
    else if (value.$type === METHOD + '#identity') events = [await parseIdentity(idResolver, value, true)]
    else if (value.$type === METHOD + '#account') {
      // Account events have no commit revision. Read current local authority
      // rather than applying an old active flag after the bootstrap.
      const current = await currentAccount(value.did)
      const account = parseAccount({ ...value, active: current.active, status: current.status })
      assert(account, 'unsupported current local account status')
      if (current.active && !revisions.has(value.did)) await bootstrap()
      events = [account]
    }
    // Validate the full selected commit before any earlier valid record writes.
    for (const event of events) if (event?.event === 'create' || event?.event === 'update') {
      // Current sync returns raw IPLD blobs; the legacy Lexicons validator
      // expects its own BlobRef representation, just like bootstrap above.
      event.record = ipldToLex(event.record)
      lexicons.assertValidRecord(event.collection, event.record)
    }
    const revision = revisions.get(value.repo)
    // The snapshot already contains this revision or newer record values.
    // Validate historical input, but never replay its writes over that snapshot.
    if (value.$type === METHOD + '#commit' && revision && value.rev <= revision.snapshot) {
      // Preserve native delete semantics for stale rows absent from the
      // snapshot, while an older delete must not remove a recreated record.
      for (const event of events) if (event.event === 'delete' && !revision.uris.has(event.uri.toString())) {
        await handleEvent(event)
      }
      cursor = Math.max(cursor, value.seq ?? cursor)
      return
    }
    for (const event of events) if (event) {
      controller.signal.throwIfAborted()
      await handleEvent(event)
    }
    cursor = Math.max(cursor, value.seq ?? cursor)
    if (value.$type === METHOD + '#commit' && revision?.target && value.rev >= revision.target) revision.target = null
    if (value.$type === METHOD + '#account' && events[0]?.active === false) revisions.delete(value.did)
    ready()
  }
  async function consume() {
    while (!controller.signal.aborted) {
      const attempt = new AbortController()
      const abort = () => attempt.abort(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      let opened
      const connected = new Promise(resolve => { opened = resolve })
      const iterator = boundedStream({ signal: attempt.signal,
        getUrl: async () => `${service}/xrpc/${METHOD}?cursor=${cursor}`,
        finishRequest(request, socket) { socket.once('open', opened); request.end() },
      })[Symbol.asyncIterator]()
      const first = iterator.next()
      // Settle startup failure as well as a quiet, successfully opened stream.
      void first.catch(() => {})
      try {
        await Promise.race([connected, first])
        await bootstrap()
        let next = await first
        // A first OutdatedCursor describes the cursor requested BEFORE this
        // bootstrap. Its gap is already covered; later reconnect gaps bootstrap.
        if (!next.done) {
          try { await processChunk(next.value, true) }
          catch (error) { if (retryable(error)) throw error; report(error) }
          next = await iterator.next()
        }
        while (!next.done) {
          try { await processChunk(next.value) } catch (error) { if (retryable(error)) throw error; report(error) }
          next = await iterator.next()
        }
        if (!controller.signal.aborted) {
          if (status.state !== 'failed') status = { state: 'starting' }
          onError(Error('local subscription ended; reconnecting'))
        }
      } catch (error) { report(error) }
      finally {
        attempt.abort()
        await first.catch(() => {})
        await iterator.return()
        controller.signal.removeEventListener('abort', abort)
      }
      if (!controller.signal.aborted) await delay(3000, undefined, { signal: controller.signal }).catch(() => {})
    }
  }
  function retryable(error) {
    const attemptCodes = ['ESTALE', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ECANCELED', 'UND_ERR_SOCKET']
    const cause = error.cause ?? error
    const network = attemptCodes.includes(cause.code) ||
      (cause instanceof AggregateError && cause.errors.length > 0 && cause.errors.every(item => attemptCodes.includes(item.code)))
    return error.error === 'ConsumerTooSlow' || error.name === 'TimeoutError' || network || error.status >= 500
  }
  function report(error) {
    if (controller.signal.aborted) return
    if (retryable(error)) {
      if (status.state !== 'failed') status = { state: 'starting' }
      onError(error)
    } else fail(error)
  }

  return {
    start() { return running ??= consume() },
    async destroy() { status = { state: 'stopped' }; controller.abort(); await running },
    getStatus() { return { ...status } },
    getCursor() { return cursor },
  }
}
