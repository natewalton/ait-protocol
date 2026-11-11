// Local PDS subscription: bounded decode and serial projection. Existing AT
// Protocol parsers retain local unauthenticated-commit/handle behavior.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { schemas } from '@atproto/api'
import { Lexicons } from '@atproto/lexicon'
import { parseCommitUnauthenticated, parseAccount, parseIdentity, parseSync } from '@atproto/sync'
import { ensureChunkIsMessage } from '@atproto/xrpc-server'
import { boundedStream } from './boundedStream.mjs'
import { assertFrameBounds, assertRepoCarBounds } from './inputBounds.mjs'
import { AIT_LEXICONS } from './aitLexicons.js'

const METHOD = 'com.atproto.sync.subscribeRepos'
const collections = new Set(['ait.feed.post', 'ait.graph.follow', 'ait.actor.profile'])
const lexicons = new Lexicons([...schemas, ...AIT_LEXICONS])
export function createLocalFeed({ service, idResolver, handleEvent, onError }) {
  const controller = new AbortController()
  let cursor = 0, running
  async function processChunk(chunk) {
    const message = ensureChunkIsMessage(assertFrameBounds(chunk))
    const body = message.body
    assert(body && typeof body === 'object' && !Array.isArray(body), 'Invalid subscription body')
    const type = message.header.t
    const value = type === undefined ? body : { ...body, $type: type.startsWith('#') ? METHOD + type : type }
    if (value.blocks instanceof Uint8Array) assertRepoCarBounds(value.blocks)
    lexicons.assertValidXrpcMessage(METHOD, value)
    let events = []
    if (value.$type === METHOD + '#commit') {
      events = await parseCommitUnauthenticated(value, collection => collections.has(collection))
      const selected = value.ops.filter(op => collections.has(op.path.split('/')[0]))
      assert.equal(events.length, selected.length, 'Selected commit operation is missing its record or CID')
    }
    else if (value.$type === METHOD + '#identity') events = [await parseIdentity(idResolver, value, true)]
    else if (value.$type === METHOD + '#account') events = [parseAccount(value)]
    else if (value.$type === METHOD + '#sync') events = [await parseSync(value)]
    // Validate the full selected commit before any earlier valid record writes.
    for (const event of events) if (event?.event === 'create' || event?.event === 'update') {
      lexicons.assertValidRecord(event.collection, event.record)
    }
    for (const event of events) if (event) {
      controller.signal.throwIfAborted()
      await handleEvent(event)
    }
    cursor = Math.max(cursor, value.seq ?? cursor)
  }
  async function consume() {
    while (!controller.signal.aborted) {
      try {
        for await (const chunk of boundedStream({ signal: controller.signal,
          getUrl: async () => `${service}/xrpc/${METHOD}?cursor=${cursor}` })) {
          try { await processChunk(chunk) } catch (error) {
            if (controller.signal.aborted) return
            onError(error)
          }
        }
        if (!controller.signal.aborted) onError(Error('local subscription ended; reconnecting'))
      } catch (error) { if (!controller.signal.aborted) onError(error) }
      if (!controller.signal.aborted) await delay(3000, undefined, { signal: controller.signal }).catch(() => {})
    }
  }
  return {
    start() { return running ??= consume() },
    async destroy() { controller.abort(); await running },
    getCursor() { return cursor },
  }
}
