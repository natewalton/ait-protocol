import 'dotenv/config'
import * as http from 'node:http'
import { Firehose, type Event } from '@atproto/sync'
import { IdResolver } from '@atproto/identity'
import { openDb } from './db.js'
import { handleEvent } from './indexer.js'
import { getAuthorFeed } from './queries/getAuthorFeed.js'

const PORT = parseInt(process.env.APPVIEW_PORT ?? '2585', 10)
const DB_PATH = process.env.APPVIEW_DB_PATH ?? './data/appview.sqlite'
const PDS_WS_URL = process.env.APPVIEW_PDS_WS_URL ?? 'ws://localhost:2583'
const PLC_URL = process.env.APPVIEW_PLC_URL ?? 'http://localhost:2582'

async function main() {
  const db = openDb(DB_PATH)

  const idResolver = new IdResolver({ plcUrl: PLC_URL })

  const firehose = new Firehose({
    idResolver,
    service: PDS_WS_URL,
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
    filterCollections: ['ait.feed.post'],
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
