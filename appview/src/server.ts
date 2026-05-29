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
import { InvalidRequestError, parseLimit } from './xrpc/params.js'
import { makeVerifyViewer } from './xrpc/auth.js'
import { isValidPushUrl, registerAndReplay } from './pushRegistry.js'

const PORT = parseInt(process.env.APPVIEW_PORT ?? '2585', 10)
const DB_PATH = process.env.APPVIEW_DB_PATH ?? './data/appview.sqlite'
const PDS_WS_URL = process.env.APPVIEW_PDS_WS_URL ?? 'ws://localhost:2583'
const PLC_URL = process.env.APPVIEW_PLC_URL ?? 'http://localhost:2582'
const APPVIEW_DID = process.env.APPVIEW_DID
if (!APPVIEW_DID) {
  throw new Error('APPVIEW_DID env var required for JWT aud verification')
}

async function main() {
  const db = openDb(DB_PATH)

  const idResolver = new IdResolver({ plcUrl: PLC_URL })
  const verifyViewer = makeVerifyViewer(idResolver, APPVIEW_DID!)

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

  const sendJson = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const sendInvalidRequest = (res: http.ServerResponse, message: string) =>
    sendJson(res, 400, { error: 'InvalidRequest', message })

  const sendAuthRequired = (res: http.ServerResponse, message: string) =>
    sendJson(res, 401, { error: 'AuthRequired', message })

  const sendInternal = (res: http.ServerResponse) =>
    sendJson(res, 500, { error: 'InternalServerError', message: 'query failed' })

  const handleQuery = async (
    res: http.ServerResponse,
    name: string,
    fn: () => void | Promise<void>,
  ) => {
    try {
      await fn()
    } catch (err) {
      if (err instanceof InvalidRequestError) {
        sendInvalidRequest(res, err.message)
        return
      }
      console.error(`${name} error:`, err)
      sendInternal(res)
    }
  }

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400)
      res.end()
      return
    }

    const url = new URL(req.url, `http://localhost:${PORT}`)
    const segments = url.pathname.split('/')
    const nsid =
      segments.length === 3 && segments[1] === 'xrpc' ? segments[2] : null

    if (nsid === null) {
      sendJson(res, 404, { error: 'NotFound', message: 'no such endpoint' })
      return
    }

    if (req.method === 'POST') {
      if (nsid === 'ait.notification.registerPushTarget') {
        handleQuery(res, 'registerPushTarget', async () => {
          const viewer = await verifyViewer(
            req.headers['authorization'],
            'ait.notification.registerPushTarget',
          )
          if (!viewer) {
            sendAuthRequired(
              res,
              'registerPushTarget requires an authenticated caller',
            )
            return
          }
          let body: { url?: unknown; since?: unknown }
          try {
            body = JSON.parse(await readBody(req)) as typeof body
          } catch {
            sendInvalidRequest(res, 'body must be valid JSON')
            return
          }
          if (typeof body.url !== 'string' || !isValidPushUrl(body.url)) {
            sendInvalidRequest(
              res,
              'url must be a string of the form http://127.0.0.1:<port>/...',
            )
            return
          }
          // since must be either null (first registration) or a non-empty
          // ISO timestamp. An empty string slips past `typeof === 'string'`
          // and the `since == null` early-exit in registerAndReplay, then
          // `n.indexedAt > ''` matches every row — replaying the recipient's
          // entire notification history in one burst.
          if (
            body.since !== null &&
            (typeof body.since !== 'string' || body.since.length === 0)
          ) {
            sendInvalidRequest(res, 'since must be a non-empty string or null')
            return
          }
          await registerAndReplay(db, viewer, body.url, body.since)
          sendJson(res, 200, { status: 'ok' })
        })
        return
      }
      sendJson(res, 404, { error: 'NotFound', message: 'no such endpoint' })
      return
    }

    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }

    switch (nsid) {
      case 'ait.feed.getAuthorFeed':
        handleQuery(res, 'getAuthorFeed', () => {
          const actor = url.searchParams.get('actor')
          if (!actor) {
            sendInvalidRequest(res, 'actor parameter required')
            return
          }
          const limit = parseLimit(url.searchParams.get('limit'))
          const cursor = url.searchParams.get('cursor')
          const result = getAuthorFeed(db, {
            actor,
            limit,
            cursor: cursor ?? undefined,
          })
          sendJson(res, 200, result)
        })
        return

      case 'ait.feed.getTimeline':
        handleQuery(res, 'getTimeline', async () => {
          const viewer = await verifyViewer(
            req.headers['authorization'],
            'ait.feed.getTimeline',
          )
          if (!viewer) {
            sendAuthRequired(res, 'getTimeline requires an authenticated caller')
            return
          }
          const limit = parseLimit(url.searchParams.get('limit'))
          const cursor = url.searchParams.get('cursor')
          const result = getTimeline(db, {
            viewer,
            limit,
            cursor: cursor ?? undefined,
          })
          sendJson(res, 200, result)
        })
        return

      case 'ait.feed.getPostThread':
        handleQuery(res, 'getPostThread', () => {
          const uri = url.searchParams.get('uri')
          if (!uri) {
            sendInvalidRequest(res, 'uri parameter required')
            return
          }
          const result = getPostThread(db, { uri })
          if (!result) {
            sendJson(res, 404, {
              error: 'NotFound',
              message: 'post not found in this AppView',
            })
            return
          }
          sendJson(res, 200, result)
        })
        return

      case 'ait.notification.listNotifications':
        handleQuery(res, 'listNotifications', async () => {
          const viewer = await verifyViewer(
            req.headers['authorization'],
            'ait.notification.listNotifications',
          )
          if (!viewer) {
            sendAuthRequired(
              res,
              'listNotifications requires an authenticated caller',
            )
            return
          }
          const limit = parseLimit(url.searchParams.get('limit'))
          const cursor = url.searchParams.get('cursor')
          const result = listNotifications(db, {
            viewer,
            limit,
            cursor: cursor ?? undefined,
          })
          sendJson(res, 200, result)
        })
        return

      case '_health':
        sendJson(res, 200, { status: 'ok' })
        return

      default:
        sendJson(res, 404, { error: 'NotFound', message: 'no such endpoint' })
    }
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
