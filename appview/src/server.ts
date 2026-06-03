import 'dotenv/config'
import { Firehose, MemoryRunner, type Event } from '@atproto/sync'
import { IdResolver, MemoryCache } from '@atproto/identity'
import {
  AuthRequiredError,
  InvalidRequestError,
  createServer as createXrpcServer,
  parseReqNsid,
  type AuthVerifier,
  type XRPCHandler,
} from '@atproto/xrpc-server'
import { AIT_LEXICONS } from './aitLexicons.js'
import { openDb } from './db.js'
import { handleEvent } from './indexer.js'
import { getAuthorFeed } from './queries/getAuthorFeed.js'
import { getProfile } from './queries/getProfile.js'
import { getTimeline } from './queries/getTimeline.js'
import { getPostThread } from './queries/getPostThread.js'
import { listNotifications } from './queries/listNotifications.js'
import { resolveActorToDid } from './queries/resolveHandle.js'
import { makeVerifyViewer } from './xrpc/auth.js'
import { isValidPushUrl, registerAndReplay } from './pushRegistry.js'

const PORT = parseInt(process.env.APPVIEW_PORT ?? '2585', 10)
const DB_PATH = process.env.APPVIEW_DB_PATH ?? './data/appview.sqlite'
const PDS_WS_URL = process.env.APPVIEW_PDS_WS_URL ?? 'ws://localhost:2583'
const PDS_URL = process.env.APPVIEW_PDS_URL ?? 'http://localhost:2583'
const PLC_URL = process.env.APPVIEW_PLC_URL ?? 'http://localhost:2582'
const APPVIEW_DID = process.env.APPVIEW_DID
if (!APPVIEW_DID) {
  throw new Error('APPVIEW_DID env var required for JWT aud verification')
}

async function main() {
  const db = openDb(DB_PATH)

  // ADR-0038: handle hydration moves from a maintained `actors.handle`
  // column to a lazy `IdResolver` lookup at query time. The MemoryCache
  // makes the steady-state case a hash-map hit; first-touch DIDs pay one
  // PLC roundtrip. The same cache also accelerates JWT signature
  // verification through `resolveAtprotoKey` for free.
  const idCache = new MemoryCache()
  const idResolver = new IdResolver({ plcUrl: PLC_URL, didCache: idCache })
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
        // idResolver carries the cache for #identity invalidation AND is
        // needed for hydrating notification pushes; idCache passed
        // explicitly because the resolver's internal cache field isn't
        // part of the typed public surface.
        await handleEvent(db, evt, idResolver, idCache)
      } catch (err) {
        console.error('indexer error:', err)
      }
    },
    onError: (err: Error) => {
      const cause = (err as Error & { cause?: unknown }).cause
      console.error('firehose error:', err.message, cause instanceof Error ? cause.message : cause)
    },
    filterCollections: ['ait.feed.post', 'ait.graph.follow', 'ait.actor.profile'],
    unauthenticatedCommits: true,
    unauthenticatedHandles: true,
  })

  firehose.start()
  console.log(`firehose subscribed to ${PDS_WS_URL}`)

  // Lexicon-driven XRPC. `xrpc.router` IS the Express app; routes mount on
  // `xrpc.routes` (a Router added to the app before the constructor's
  // `/xrpc/:methodId` catchall), so the health probe registered below
  // matches before the catchall's MethodNotImplementedError fires.
  const xrpc = createXrpcServer([...AIT_LEXICONS])

  // Minimal callback typing keeps @types/express out of the project's
  // devDependencies — the only direct express touchpoint in user code is
  // this one route handler.
  xrpc.routes.get(
    '/xrpc/_health',
    (_req: unknown, res: { json: (body: unknown) => void }) => {
      res.json({ status: 'ok' })
    },
  )

  // viewerAuth wraps the existing JWT verifier. parseReqNsid resolves the
  // route NSID from req.originalUrl||req.url so the verifier can bind it as
  // the JWT's lxm claim, matching the per-route nsid passed to
  // makeVerifyViewer in the old hand-rolled dispatch.
  const viewerAuth: AuthVerifier = async ({ req }) => {
    const lxm = parseReqNsid(req)
    const viewer = await verifyViewer(req.headers.authorization, lxm)
    if (!viewer) {
      throw new AuthRequiredError(`${lxm} requires an authenticated caller`)
    }
    return { credentials: { did: viewer } }
  }

  type ViewerAuth = { credentials: { did: string } }

  // Handle→DID resolution lives at the handler boundary (ADR-0038): the PDS is
  // canonical for .test handles and the lexicon takes at-identifier per
  // ADR-0028's "stay canonical" rule. The queries only ever see a DID.
  const getAuthorFeedHandler: XRPCHandler = async (ctx) => {
    const actor = ctx.params.actor as string
    const limit = ctx.params.limit as number | undefined
    const cursor = ctx.params.cursor as string | undefined
    const did = await resolveActorToDid(PDS_URL, actor)
    if (!did) {
      return { encoding: 'application/json', body: { feed: [] } }
    }
    const body = await getAuthorFeed(db, idResolver, { did, limit, cursor })
    return { encoding: 'application/json', body }
  }

  const getProfileHandler: XRPCHandler = async (ctx) => {
    const actor = ctx.params.actor as string
    // An unresolvable handle is ProfileNotFound (declared in the lexicon). A
    // DID that resolves to no identity surfaces from getProfile as a 5xx,
    // matching getAuthorFeed/getTimeline — we don't mask resolver outages.
    const did = await resolveActorToDid(PDS_URL, actor)
    if (!did) {
      throw new InvalidRequestError('profile not found', 'ProfileNotFound')
    }
    const profile = await getProfile(db, idResolver, { did, pdsUrl: PDS_URL })
    return { encoding: 'application/json', body: profile }
  }

  const getTimelineHandler: XRPCHandler = async (ctx) => {
    const viewer = (ctx.auth as ViewerAuth).credentials.did
    const limit = ctx.params.limit as number | undefined
    const cursor = ctx.params.cursor as string | undefined
    const body = await getTimeline(db, idResolver, { viewer, limit, cursor })
    return { encoding: 'application/json', body }
  }

  const getPostThreadHandler: XRPCHandler = async (ctx) => {
    const uri = ctx.params.uri as string
    const result = await getPostThread(db, idResolver, { uri })
    if (!result) {
      // Canonical bsky-style "not found in this AppView": InvalidRequestError
      // carries a customErrorName which surfaces as the body's `error` field.
      // Status drops from the previous hand-rolled 404 to 400 (XRPCError's
      // mapping for InvalidRequest), but the wire envelope keeps
      // `{error: "NotFound", message: "..."}` so a properly-coded XrpcClient
      // can still discriminate on the error name. Declared in the lexicon's
      // `errors:` array so the name is part of the contract.
      throw new InvalidRequestError(
        'post not found in this AppView',
        'NotFound',
      )
    }
    return { encoding: 'application/json', body: result }
  }

  const listNotificationsHandler: XRPCHandler = async (ctx) => {
    const viewer = (ctx.auth as ViewerAuth).credentials.did
    const limit = ctx.params.limit as number | undefined
    const cursor = ctx.params.cursor as string | undefined
    const body = await listNotifications(db, idResolver, { viewer, limit, cursor })
    return { encoding: 'application/json', body }
  }

  const registerPushTargetHandler: XRPCHandler = async (ctx) => {
    const viewer = (ctx.auth as ViewerAuth).credentials.did
    const input = ctx.input?.body as
      | { url?: unknown; since?: unknown }
      | undefined
    const url = input?.url
    // Lexicon already enforces `url` is a string (required). The runtime
    // hostname/protocol check is policy-side, not shape-side, so it stays
    // here rather than being expressed in the lexicon.
    if (typeof url !== 'string' || !isValidPushUrl(url)) {
      throw new InvalidRequestError(
        'url must be a string of the form http://127.0.0.1:<port>/...',
      )
    }
    // The lexicon types `since` as nullable string with format datetime. The
    // MCP sends `null` on first registration (mcp/src/push.ts:71-78). Either
    // undefined (omitted) or null collapses to null for registerAndReplay —
    // both mean "no backlog replay".
    const since = (input?.since as string | null | undefined) ?? null
    await registerAndReplay(db, idResolver, viewer, url, since)
    return { encoding: 'application/json', body: { status: 'ok' as const } }
  }

  xrpc.method('ait.feed.getAuthorFeed', getAuthorFeedHandler)
  xrpc.method('ait.actor.getProfile', {
    auth: viewerAuth,
    handler: getProfileHandler,
  })
  xrpc.method('ait.feed.getTimeline', {
    auth: viewerAuth,
    handler: getTimelineHandler,
  })
  xrpc.method('ait.feed.getPostThread', getPostThreadHandler)
  xrpc.method('ait.notification.listNotifications', {
    auth: viewerAuth,
    handler: listNotificationsHandler,
  })
  xrpc.method('ait.notification.registerPushTarget', {
    auth: viewerAuth,
    handler: registerPushTargetHandler,
  })

  const httpServer = xrpc.router.listen(PORT, () => {
    console.log(`appview listening on http://localhost:${PORT}`)
  })

  const shutdown = async () => {
    console.log('appview stopping')
    await firehose.destroy().catch(() => {})
    httpServer.close()
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
