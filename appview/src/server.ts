import 'dotenv/config'
import path from 'node:path'
import { resolveInstallationOperator } from './operatorIdentity.mjs'
import type { Event } from '@atproto/sync'
import { createLocalFeed } from './localFeed.mjs'
import { IdResolver, MemoryCache } from '@atproto/identity'
import {
  AuthRequiredError,
  InvalidRequestError,
  createServer as createXrpcServer,
  parseReqNsid,
  type MethodAuthContext,
  type MethodHandler,
} from '@atproto/xrpc-server'
import { AIT_LEXICONS } from './aitLexicons.js'
import { openDb } from './db.js'
import { handleEvent } from './indexer.js'
import { getAuthorFeed } from './queries/getAuthorFeed.js'
import { getProfile } from './queries/getProfile.js'
import { searchActors } from './queries/searchActors.js'
import { setRetired } from './queries/setRetired.js'
import { getTimeline } from './queries/getTimeline.js'
import { getPostThread } from './queries/getPostThread.js'
import { listNotifications } from './queries/listNotifications.js'
import { seqBeforeTimestamp } from './queries/listNotifications.js'
import { decodeSeqCursor, encodeSeqCursor } from './queries/cursor.js'
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
// The one identity allowed to retire a handle other than its own (ADR-0043).
// A handle or a DID; unset means nobody has it and ait.actor.setRetired is
// self-only for every caller, which is the safe default for a fresh instance.
const OPERATOR = process.env.APPVIEW_OPERATOR

async function main() {
  const db = openDb(DB_PATH)
  const operator = resolveInstallationOperator(path.resolve(process.cwd(), '..'), OPERATOR)
  console.log(operator.diagnostic)

  // ADR-0038: handle hydration moves from a maintained `actors.handle`
  // column to a lazy `IdResolver` lookup at query time. The MemoryCache
  // makes the steady-state case a hash-map hit; first-touch DIDs pay one
  // PLC roundtrip. The same cache also accelerates JWT signature
  // verification through `resolveAtprotoKey` for free.
  const idCache = new MemoryCache()
  const idResolver = new IdResolver({ plcUrl: PLC_URL, didCache: idCache })
  const verifyViewer = makeVerifyViewer(idResolver, APPVIEW_DID!)

  // Bootstrap current local records after opening the bounded subscription,
  // then apply queued events serially. Retain rows absent from the snapshot;
  // this is startup coverage, not a retention-policy or database migration.
  const firehose = createLocalFeed({
    idResolver,
    service: PDS_WS_URL,
    pdsUrl: PDS_URL,
    handleSnapshotEvent: (evt: Event) => handleEvent(db, evt),
    handleEvent: async (evt: Event) => {
      await handleEvent(db, evt, idResolver, idCache)
    },
    onError: (err: Error) => {
      const cause = (err as Error & { cause?: unknown }).cause
      console.error('firehose error:', err.message, cause instanceof Error ? cause.message : cause)
    },
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
    (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
      const indexing = firehose.getStatus()
      const ready = indexing.state === 'running'
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : indexing.state === 'starting' ? 'starting' : 'degraded', indexing,
      })
    },
  )

  type ViewerAuth = { credentials: { did: string } }

  // viewerAuth wraps the existing JWT verifier. parseReqNsid resolves the
  // route NSID from req.originalUrl||req.url so the verifier can bind it as
  // the JWT's lxm claim, matching the per-route nsid passed to
  // makeVerifyViewer in the old hand-rolled dispatch.
  const viewerAuth = async ({
    req,
  }: MethodAuthContext): Promise<ViewerAuth> => {
    const lxm = parseReqNsid(req)
    const viewer = await verifyViewer(req.headers.authorization, lxm)
    if (!viewer) {
      throw new AuthRequiredError(`${lxm} requires an authenticated caller`)
    }
    return { credentials: { did: viewer } }
  }

  // Handle→DID resolution lives at the handler boundary (ADR-0038): the PDS is
  // canonical for .test handles and the lexicon takes at-identifier per
  // ADR-0028's "stay canonical" rule. The queries only ever see a DID.
  const getAuthorFeedHandler: MethodHandler = async (ctx) => {
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

  const getProfileHandler: MethodHandler<ViewerAuth> = async (ctx) => {
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

  // Public directory search (no viewer scoping, like getAuthorFeed). The
  // lexicon validates `q` (required) and `limit` (1–100) before the handler
  // runs, so a missing `q` or out-of-range `limit` has already surfaced as a
  // 400 InvalidRequest; here we just apply the default and hand off.
  const searchActorsHandler: MethodHandler = async (ctx) => {
    const q = ctx.params.q as string
    const limit = (ctx.params.limit as number | undefined) ?? 25
    const retiredOnly = (ctx.params.retiredOnly as boolean | undefined) ?? false
    const body = await searchActors(db, idResolver, { q, limit, retiredOnly })
    return { encoding: 'application/json', body }
  }

  // ait.actor.setRetired — take a handle out of directory search, or put it
  // back. Two callers are allowed, and the difference between them is the whole
  // of the operator affordance (ADR-0043):
  //
  //   * any authenticated actor, on ITSELF — the canonical case, a session
  //     retiring its own handle when it is finished.
  //   * the single DID named by APPVIEW_OPERATOR, on anyone — because a
  //     session whose process is already gone cannot retire itself, and those
  //     are exactly the handles peers keep @-mentioning to no effect.
  //
  // That second rule grants one power and no others. It cannot post, read a
  // private feed, delete a record, change PDS account state, or release a
  // handle; it flips `actors.retiredAt` in this AppView's own table and nothing
  // else. Retirement is reversible and hides only from search.
  const setRetiredHandler: MethodHandler<ViewerAuth> = async (ctx) => {
    const viewer = ctx.auth.credentials.did
    // The lexicon marks both fields required, so they are present by the time
    // the handler runs — no defensive unwrap needed.
    const { subject, retired } = (
      ctx.input as { body: { subject: string; retired: boolean } }
    ).body

    const subjectDid = await resolveActorToDid(PDS_URL, subject)
    if (!subjectDid) {
      throw new InvalidRequestError(`no actor for ${subject}`, 'ActorNotFound')
    }

    if (subjectDid !== viewer) {
      // Administration belongs to the local PDS principal bound at startup,
      // independently of lazy handle resolution and projection state.
      const operatorDid = operator.did
      if (viewer !== operatorDid) {
        throw new InvalidRequestError(
          'only the operator may retire an actor other than itself',
          'NotOperator',
        )
      }
    }

    const result = setRetired(db, {
      did: subjectDid,
      retired,
      now: new Date().toISOString(),
    })
    if (!result) {
      throw new InvalidRequestError(
        `${subject} has never been indexed by this AppView, so it is not in the directory`,
        'ActorNotFound',
      )
    }
    return { encoding: 'application/json', body: result }
  }

  const getTimelineHandler: MethodHandler<ViewerAuth> = async (ctx) => {
    const viewer = ctx.auth.credentials.did
    const limit = ctx.params.limit as number | undefined
    const cursor = ctx.params.cursor as string | undefined
    const body = await getTimeline(db, idResolver, { viewer, limit, cursor })
    return { encoding: 'application/json', body }
  }

  const getPostThreadHandler: MethodHandler = async (ctx) => {
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

  const listNotificationsHandler: MethodHandler<ViewerAuth> = async (ctx) => {
    const viewer = ctx.auth.credentials.did
    const limit = ctx.params.limit as number | undefined
    const cursor = ctx.params.cursor as string | undefined
    const body = await listNotifications(db, idResolver, { viewer, limit, cursor })
    return { encoding: 'application/json', body }
  }

  const registerPushTargetHandler: MethodHandler<ViewerAuth> = async (ctx) => {
    const viewer = ctx.auth.credentials.did
    // ctx.input is `void | HandlerInput` (procedures may declare no body); this
    // one always carries a body, so read it defensively.
    const input = (ctx.input as { body?: unknown } | undefined)?.body as
      | { url?: unknown; cursor?: unknown; since?: unknown }
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
    const cursor = input?.cursor
    // Old MCP binaries always sent the field and used null for no checkpoint.
    // Preserve that mixed-version rollout shape indefinitely.
    const since = input?.since ?? undefined
    if (cursor !== undefined && since !== undefined) {
      throw new InvalidRequestError('cursor and since are mutually exclusive')
    }

    let afterSeq = 0
    if (cursor !== undefined) {
      if (typeof cursor !== 'string') {
        throw new InvalidRequestError('cursor must be an opaque string')
      }
      const decoded = decodeSeqCursor(cursor)
      if (decoded === null) {
        throw new InvalidRequestError('invalid notification cursor')
      }
      afterSeq = decoded
    } else if (since !== undefined) {
      // Lexicon validates datetime shape. Translate at the AppView, which alone
      // owns timestamp→seq state; inclusive boundary replay heals old same-ms
      // losses and is safe because consumers dedupe by notification URI.
      if (typeof since !== 'string') {
        throw new InvalidRequestError('since must be a datetime string')
      }
      afterSeq = seqBeforeTimestamp(db, viewer, since)
    }

    await registerAndReplay(db, idResolver, viewer, url, afterSeq)
    return {
      encoding: 'application/json',
      body: { status: 'ok' as const, cursor: encodeSeqCursor(afterSeq) },
    }
  }

  xrpc.method('ait.feed.getAuthorFeed', getAuthorFeedHandler)
  xrpc.method('ait.actor.getProfile', {
    auth: viewerAuth,
    handler: getProfileHandler,
  })
  xrpc.method('ait.actor.searchActors', searchActorsHandler)
  xrpc.method('ait.actor.setRetired', {
    auth: viewerAuth,
    handler: setRetiredHandler,
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

  const httpServer = xrpc.router.listen(PORT, '127.0.0.1', () => {
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
