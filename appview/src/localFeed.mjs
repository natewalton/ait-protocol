// Local PDS subscription: bounded decode and serial projection. Existing AT
// Protocol parsers retain local unauthenticated-commit/handle behavior.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { schemas } from '@atproto/api'
import { AtUri } from '@atproto/syntax'
import { Lexicons, jsonToLex } from '@atproto/lexicon'
import { parseCommitUnauthenticated, parseAccount, parseIdentity } from '@atproto/sync'
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
  let targets = new Map()
  const fail = error => {
    if (status.state !== 'stopped') status = { state: 'failed', error: error.message ?? String(error) }
    onError(error)
  }
  const ready = () => {
    if (targets.size === 0 && status.state === 'starting') status = { state: 'running' }
  }
  const origin = new URL(pdsUrl)
  const json = async (method, params) => {
    const url = new URL(`/xrpc/${method}`, origin)
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
    const timeout = new AbortController()
    const abort = () => timeout.abort(controller.signal.reason)
    controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => timeout.abort(Error('local bootstrap request timed out')), 10_000)
    const max = method === 'com.atproto.repo.listRecords' ? 8 * 1024 * 1024 : 512 * 1024
    let response
    try {
      controller.signal.throwIfAborted()
      response = await fetch(url, { signal: timeout.signal, redirect: 'error' })
      if (!response.ok) throw Error(`local bootstrap ${method} failed: ${response.status}`)
      const length = Number(response.headers.get('content-length'))
      if (length > max) throw Error('local bootstrap response byte limit exceeded')
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > max) throw Error('local bootstrap response byte limit exceeded')
        chunks.push(chunk)
      }
      const result = JSON.parse(assertJsonBounds(Buffer.concat(chunks, size)).toString('utf8'))
      lexicons.assertValidXrpcOutput(method, result)
      return result
    } finally {
      clearTimeout(timer)
      await response?.body?.cancel().catch(() => {})
      controller.signal.removeEventListener('abort', abort)
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
    targets = new Map()
    for await (const repo of pages('com.atproto.sync.listRepos', { limit: 1000 }, 'repos')) {
      const account = parseAccount({ did: repo.did, active: repo.active !== false, status: repo.status, seq: cursor, time: new Date().toISOString() })
      if (account) await handleSnapshotEvent(account)
      if (repo.active === false) continue
      targets.set(repo.did, repo.rev)
      for (const collection of collections) {
        for await (const item of pages('com.atproto.repo.listRecords', { repo: repo.did, collection, limit: 1 }, 'records')) {
          const uri = new AtUri(item.uri)
          assert(uri.host === repo.did && uri.collection === collection, 'local bootstrap record scope mismatch')
          const record = jsonToLex(item.value)
          lexicons.assertValidRecord(collection, record)
          const cid = jsonToLex({ $link: item.cid })
          // Projection fields only; no invented signed commit/revision metadata.
          await handleSnapshotEvent({ event: 'create', did: repo.did, uri, collection, rkey: uri.rkey, cid, record })
        }
      }
      const after = await json('com.atproto.sync.getRepoStatus', { did: repo.did })
      assert.equal(after.did, repo.did, 'local bootstrap status DID mismatch')
      if (!after.active || after.rev === repo.rev) targets.delete(repo.did)
      else {
        assert(after.rev && after.rev >= repo.rev, 'local bootstrap revision went backwards')
        targets.set(repo.did, after.rev)
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
      events = await parseCommitUnauthenticated(value, collection => collections.has(collection))
      const selected = value.ops.filter(op => collections.has(op.path.split('/')[0]))
      assert.equal(events.length, selected.length, 'Selected commit operation is missing its record or CID')
    }
    else if (value.$type === METHOD + '#identity') events = [await parseIdentity(idResolver, value, true)]
    else if (value.$type === METHOD + '#account') events = [parseAccount(value)]
    // Validate the full selected commit before any earlier valid record writes.
    for (const event of events) if (event?.event === 'create' || event?.event === 'update') {
      lexicons.assertValidRecord(event.collection, event.record)
    }
    for (const event of events) if (event) {
      controller.signal.throwIfAborted()
      await handleEvent(event)
    }
    cursor = Math.max(cursor, value.seq ?? cursor)
    const target = targets.get(value.repo)
    if (value.$type === METHOD + '#commit' && target && value.rev >= target) targets.delete(value.repo)
    if (value.$type === METHOD + '#account' && !value.active) targets.delete(value.did)
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
          catch (error) { report(error) }
          next = await iterator.next()
        }
        while (!next.done) {
          try { await processChunk(next.value) } catch (error) { report(error) }
          next = await iterator.next()
        }
        if (!controller.signal.aborted) {
          if (status.state !== 'failed') status = { state: 'starting' }
          onError(Error('local subscription ended; reconnecting'))
        }
      } catch (error) { if (!controller.signal.aborted) fail(error) }
      finally {
        attempt.abort()
        await first.catch(() => {})
        await iterator.return()
        controller.signal.removeEventListener('abort', abort)
      }
      if (!controller.signal.aborted) await delay(3000, undefined, { signal: controller.signal }).catch(() => {})
    }
  }
  function report(error) {
    if (controller.signal.aborted) return
    if (error.error === 'ConsumerTooSlow') {
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
