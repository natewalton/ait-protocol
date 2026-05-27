import 'dotenv/config'
import * as http from 'node:http'
import { Firehose, MemoryRunner, type Event } from '@atproto/sync'
import { IdResolver } from '@atproto/identity'
import { openDb } from './db.js'
import { handleEvent } from './indexer.js'
import { getAuthorFeed } from './queries/getAuthorFeed.js'
import { getTimeline } from './queries/getTimeline.js'
import { getPostThread } from './queries/getPostThread.js'
import { listNotifications } from './queries/listNotifications.js'

const PORT = parseInt(process.env.APPVIEW_PORT ?? '2585', 10)
const DB_PATH = process.env.APPVIEW_DB_PATH ?? './data/appview.sqlite'
const PDS_WS_URL = process.env.APPVIEW_PDS_WS_URL ?? 'ws://localhost:2583'
const PLC_URL = process.env.APPVIEW_PLC_URL ?? 'http://localhost:2582'

// Extract the caller's DID from the Bearer JWT's `iss` claim.
// The PDS service-proxy signs JWTs *as the user* (the PDS holds the user's
// signing keys), so the issuer field carries the viewer DID. The `aud`
// field is the target service (our AppView).
// For local-only dev we trust the PDS-signed JWT without verifying its
// signature — the AppView only listens on localhost and the PDS is the
// only thing forwarding to it.
function viewerDidFromAuth(authHeader: string | string[] | undefined): string | null {
  const h = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (!h?.startsWith('Bearer ')) return null
  const token = h.slice(7)
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      iss?: string
    }
    return decoded.iss ?? null
  } catch {
    return null
  }
}

async function main() {
  const db = openDb(DB_PATH)

  const idResolver = new IdResolver({ plcUrl: PLC_URL })

  // Always subscribe from seq 0. Without a cursor, @atproto/sync's
  // Subscription sends no `cursor` param, which subscribeRepos treats as
  // "start at the live head" — meaning a wiped-and-restarted AppView never
  // replays pre-restart records. The indexer's upserts are idempotent, so
  // replaying from 0 on every restart is safe; durability/persistence of a
  // cursor can come later if replay time becomes meaningful.
  //
  // We pass a MemoryRunner (with startCursor: 0) rather than the bare
  // `getCursor: () => 0` option because @atproto/sync@0.1.40's getParams
  // builder returns the getCursor *function itself* (not its result) when
  // no runner is set, which fails query-param encoding.
  const runner = new MemoryRunner({ startCursor: 0 })
  const firehose = new Firehose({
    idResolver,
    service: PDS_WS_URL,
    runner,
    handleEvent: async (evt: Event) => {
      try {
        handleEvent(db, evt)
      } catch (err) {
        console.error('indexer error:', err)
      }
    },
    onError: (err: Error) => {
      const cause = (err as Error & { cause?: unknown }).cause
      console.error('firehose error:', err.message, cause instanceof Error ? cause.message : cause)
    },
    filterCollections: ['ait.feed.post', 'ait.graph.follow'],
    unauthenticatedCommits: true,
    unauthenticatedHandles: true,
  })

  firehose.start()
  console.log(`firehose subscribed to ${PDS_WS_URL}`)

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url.startsWith('/xrpc/ait.feed.getAuthorFeed')) {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`)
        const actor = url.searchParams.get('actor')
        if (!actor) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: 'InvalidRequest',
              message: 'actor parameter required',
            }),
          )
          return
        }
        const limitParam = url.searchParams.get('limit')
        const cursor = url.searchParams.get('cursor')
        const result = getAuthorFeed(db, {
          actor,
          limit: limitParam ? parseInt(limitParam, 10) : undefined,
          cursor: cursor ?? undefined,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('getAuthorFeed error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ error: 'InternalServerError', message: 'query failed' }),
        )
      }
      return
    }

    if (req.method === 'GET' && req.url.startsWith('/xrpc/ait.feed.getTimeline')) {
      try {
        const viewer = viewerDidFromAuth(req.headers['authorization'])
        if (!viewer) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: 'AuthRequired',
              message: 'getTimeline requires an authenticated caller',
            }),
          )
          return
        }
        const url = new URL(req.url, `http://localhost:${PORT}`)
        const limitParam = url.searchParams.get('limit')
        const cursor = url.searchParams.get('cursor')
        const result = getTimeline(db, {
          viewer,
          limit: limitParam ? parseInt(limitParam, 10) : undefined,
          cursor: cursor ?? undefined,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('getTimeline error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ error: 'InternalServerError', message: 'query failed' }),
        )
      }
      return
    }

    if (req.method === 'GET' && req.url.startsWith('/xrpc/ait.feed.getPostThread')) {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`)
        const uri = url.searchParams.get('uri')
        if (!uri) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: 'InvalidRequest',
              message: 'uri parameter required',
            }),
          )
          return
        }
        const result = getPostThread(db, { uri })
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: 'NotFound',
              message: 'post not found in this AppView',
            }),
          )
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('getPostThread error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ error: 'InternalServerError', message: 'query failed' }),
        )
      }
      return
    }

    if (
      req.method === 'GET' &&
      req.url.startsWith('/xrpc/ait.notification.listNotifications')
    ) {
      try {
        const viewer = viewerDidFromAuth(req.headers['authorization'])
        if (!viewer) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: 'AuthRequired',
              message: 'listNotifications requires an authenticated caller',
            }),
          )
          return
        }
        const url = new URL(req.url, `http://localhost:${PORT}`)
        const limitParam = url.searchParams.get('limit')
        const cursor = url.searchParams.get('cursor')
        const result = listNotifications(db, {
          viewer,
          limit: limitParam ? parseInt(limitParam, 10) : undefined,
          cursor: cursor ?? undefined,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('listNotifications error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ error: 'InternalServerError', message: 'query failed' }),
        )
      }
      return
    }

    if (req.method === 'GET' && req.url === '/xrpc/_health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'NotFound', message: 'no such endpoint' }))
  })

  server.listen(PORT, () => {
    console.log(`appview listening on http://localhost:${PORT}`)
  })

  const shutdown = async () => {
    console.log('appview stopping')
    await firehose.destroy().catch(() => {})
    server.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('appview failed to start:', err)
  process.exit(1)
})
