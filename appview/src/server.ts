import 'dotenv/config'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { ensureValidDid } from '@atproto/syntax'
import { once } from 'node:events'
import { schemas } from '@atproto/api'
import { safeFetchWrap } from '@atproto-labs/fetch-node'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AuthRequiredError,
  InvalidRequestError,
  NotEnoughResourcesError,
  createServer as createXrpcServer,
  parseReqNsid,
  type MethodAuthContext,
  type MethodHandler,
} from '@atproto/xrpc-server'
import { AIT_LEXICONS } from './aitLexicons.js'
import { openDb } from './db.js'
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
import { getRecord } from './queries/getRecord.js'
import { startPeerNetwork, stateDirectory } from './peerNetwork.mjs'
import { installationPaths } from './peerPrepare.mjs'
import { createVerifiedFeed } from './peerFeed.mjs'
import { resolveLocalOperator } from './operatorIdentity.mjs'

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

export async function main(peerOptions: { assistanceRelay?: string; bindAddress?: string; directAddress?: string } = {}) {
  const db = openDb(DB_PATH)
  let peers: Pick<Awaited<ReturnType<typeof startPeerNetwork>>, 'resolver' | 'getPresence' | 'close'> | undefined
  let firehose: ReturnType<typeof createVerifiedFeed> | undefined
  let httpServer: import('node:http').Server | undefined
  const close = async () => {
    const failures: unknown[] = []
    await firehose?.destroy().catch(() => {})
    try { await peers?.close() } catch (error) { failures.push(error) }
    try {
      if (httpServer?.listening) {
        httpServer.closeAllConnections()
        await new Promise<void>((resolve, reject) => httpServer!.close(error => error ? reject(error) : resolve()))
      }
    } catch (error) { failures.push(error) }
    try { if (db.open) db.close() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'AppView cleanup failed')
  }
  try {
    // ADR-0038: handle hydration moves from a maintained `actors.handle`
    // column to a lazy `IdResolver` lookup at query time. The MemoryCache
    // makes the steady-state case a hash-map hit; first-touch DIDs pay one
    // PLC roundtrip. The same cache also accelerates JWT signature
    // verification through `resolveAtprotoKey` for free.
    const idCache = new MemoryCache()
    const localResolver = new IdResolver({ plcUrl: PLC_URL, didCache: idCache,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input), origin = new URL(PLC_URL)
        if (url.origin !== origin.origin || !/^did:plc:[a-z2-7]{24}$/.test(decodeURIComponent(url.pathname.slice(1)))) {
          throw new Error('local identity request outside the configured PLC')
        }
        return fetch(url, { ...init, redirect: 'error' })
      } })
    localResolver.handle.resolve = async () => undefined
    // run-appview.sh makes the installation's appview directory the cwd.
    const repo = path.resolve(process.cwd(), '..')
    const { accountFile } = installationPaths(repo)
    const operator = resolveLocalOperator(accountFile, OPERATOR)
    console.log(operator.diagnostic)
    try {
      peers = await startPeerNetwork({ directory: stateDirectory(DB_PATH), db,
        pdsUrl: PDS_URL, plcUrl: PLC_URL, localResolver, accountFile,
        // Reuse AppView's configured port for UDP, so approved direct addresses
        // survive an ordinary restart without a discovery service or new setting.
        bindAddress: peerOptions.bindAddress ?? `0.0.0.0:${PORT}`,
        // Explicit development relay, no discovery preset. Empty disables
        // assistance for LAN-only operation and isolated wrapper tests.
        assistanceRelay: peerOptions.assistanceRelay ?? (process.env.APPVIEW_PEER_RELAY ?? 'https://use1-1.relay.n0.iroh.link./'),
        directAddress: peerOptions.directAddress,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'AIT_PEER_POLICY_UNAVAILABLE') throw error
      console.error((error as Error).message)
      peers = { resolver: localResolver, async getPresence() { return undefined }, async close() {} }
    }
    const idResolver = peers.resolver as IdResolver
    // Service-auth JWTs come from this installation's PDS. Reuse its existing
    // cached resolver, including the upstream signature-failure forceRefresh.
    // Display/source routing must not turn retained names into authentication.
    const verifyViewer = makeVerifyViewer(localResolver, APPVIEW_DID!)

    // Open the official subscription before verified repository backfill. The
    // shared driver acknowledges each message only after projection succeeds.
    const localTransport = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init), url = new URL(request.url)
      if (url.origin !== new URL(PDS_URL).origin || request.method !== 'GET' ||
        !['/xrpc/com.atproto.sync.listRepos', '/xrpc/com.atproto.sync.getRepo'].includes(url.pathname)) {
        throw new Error('local repository read outside the configured PDS')
      }
      return fetch(request, { redirect: 'error' })
    }
    // The inner transport already pins the configured local PDS and two routes.
    const smallRead = safeFetchWrap({ fetch: localTransport, allowHttp: true, allowPrivateIps: true, allowCustomPort: true })
    const repoRead = safeFetchWrap({ fetch: localTransport, allowHttp: true, allowPrivateIps: true, allowCustomPort: true,
      responseMaxSize: 100 * 1024 * 1024 })
    firehose = createVerifiedFeed({ db, idResolver: localResolver, service: PDS_WS_URL, agent: undefined,
      getJson: async (route: string, signal: AbortSignal) => {
        const response = await smallRead(new URL(route, PDS_URL), { redirect: 'error', signal })
        if (!response.ok) throw new Error(`local repository listing failed: ${response.status}`)
        return response.json()
      },
      getRepo: async (did: string, signal: AbortSignal) => {
        const response = await repoRead(new URL(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`, PDS_URL), { redirect: 'error', signal })
        if (!response.ok) throw new Error(`local repository download failed: ${response.status}`)
        return new Uint8Array(await response.arrayBuffer())
      },
    })
    void firehose.start().catch((error: unknown) => console.error('local indexing stopped; restart AppView after fixing the reported error:', error))
    console.log(`local indexing starting from ${PDS_WS_URL}`)

    // Lexicon-driven XRPC. `xrpc.router` IS the Express app; routes mount on
    // `xrpc.routes` (a Router added to the app before the constructor's
    // `/xrpc/:methodId` catchall), so the health probe registered below
    // matches before the catchall's MethodNotImplementedError fires.
    const standard = schemas.filter(doc => ['com.atproto.repo.getRecord', 'com.atproto.identity.resolveHandle'].includes(doc.id))
    const xrpc = createXrpcServer([...AIT_LEXICONS, ...standard])
    // Only a ready local projection can answer a name authoritatively. Explicit
    // DIDs still identify retained history when indexing is unavailable.
    const resolvePublicActor = async (actor: string) => {
      if (actor.startsWith('did:')) {
        ensureValidDid(actor)
        return actor
      }
      if (firehose!.getStatus().state !== 'running') {
        throw new NotEnoughResourcesError(
          'Local actor projection is unavailable; inspect ait status or use an explicit DID.',
          'ProjectionUnavailable',
        )
      }
      return resolveActorToDid(db, actor)
    }

    xrpc.method('com.atproto.identity.resolveHandle', async ctx => {
      const did = await resolvePublicActor(ctx.params.handle as string)
      if (!did) throw new InvalidRequestError('actor not found', 'HandleNotFound')
      return { encoding: 'application/json', body: { did } }
    })
    xrpc.method('com.atproto.repo.getRecord', async ctx => {
      const params = ctx.params as { repo: string; collection: string; rkey: string; cid?: string }
      const did = await resolvePublicActor(params.repo)
      const record = did ? await getRecord(db, { ...params, repo: did }) : null
      if (!record) throw new InvalidRequestError('record not found', 'RecordNotFound')
      return { encoding: 'application/json', body: record }
    })

    // Minimal callback typing keeps @types/express out of the project's
    // devDependencies — the only direct express touchpoint in user code is
    // this one route handler.
    xrpc.routes.get(
      '/xrpc/_health',
      (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
        const indexing = firehose!.getStatus()
        const ready = indexing.state === 'running'
        res.status(ready ? 200 : 503).json({
          status: ready ? 'ok' : indexing.state === 'starting' ? 'starting' : 'degraded',
          indexing,
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

    // Names resolve from the verified projection at the handler boundary. The
    // canonical lexicon still takes an at-identifier; queries only see a DID.
    const getAuthorFeedHandler: MethodHandler = async (ctx) => {
      const actor = ctx.params.actor as string
      const limit = ctx.params.limit as number | undefined
      const cursor = ctx.params.cursor as string | undefined
      const did = await resolvePublicActor(actor)
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
      const did = await resolvePublicActor(actor)
      if (!did) {
        throw new InvalidRequestError('profile not found', 'ProfileNotFound')
      }
      const profile = await getProfile(db, idResolver, { did, pdsUrl: PDS_URL,
        getPresence: ctx.params.includePresence === true ? peers!.getPresence : undefined })
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

      const subjectDid = await resolvePublicActor(subject)
      if (!subjectDid) {
        throw new InvalidRequestError(`no actor for ${subject}`, 'ActorNotFound')
      }

      if (subjectDid !== viewer) {
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

    httpServer = xrpc.router.listen(PORT, '127.0.0.1')
    await once(httpServer!, 'listening')
    console.log(`appview listening on http://localhost:${PORT}`)

    const shutdown = async () => {
      process.off('SIGTERM', shutdown)
      process.off('SIGINT', shutdown)
      console.log('appview stopping')
      try { await close(); process.exit(0) }
      catch (error) { console.error('appview shutdown failed:', error); process.exit(1) }
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  } catch (error) {
    await close().catch(cleanupError => console.error('appview startup cleanup failed:', cleanupError))
    throw error
  }
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) main().catch((err) => {
  console.error('appview failed to start:', err)
  process.exit(1)
})
