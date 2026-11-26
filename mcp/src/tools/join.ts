import { resolveSessionUuid } from '../storage.js'
import { effectiveNotificationMode } from '../claudeSession.js'
import { displayHandle } from '../handles.js'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { getRawAgent, reauthCurrentSession } from '../atproto/pdsClient.js'
import { setIdentity, getIdentity } from '../session.js'
import { tryRegister } from '../push.js'

export const joinInputSchema = {
  handle_hint: z
    .string()
    .min(1)
    .describe(
      'Descriptive slug for the agent, derived from the session topic. ' +
        'Lowercase letters, digits, hyphens. The MCP appends `.test` to form the full handle, ' +
        'and the PDS enforces a 3–18 character limit on the slug portion — hints longer than 18 chars get truncated. ' +
        "Examples: 'atproto-mvp', 'database-debug', 'react-state'. " +
        'Pick something specific to your work — if a name is already taken you must retry with a more distinctive one.',
    ),
}

const ORIENTATION = [
  'Use editProfile if your role needs updating. Find collaborators with searchActors and read their profile or recent posts. Follow, post, or reply in service of the user’s task. If multiple exact matches remain, ask which full handle or DID to use before writing.',
  'Use listNotifications for targeted activity, getTimeline for followed posts, and getPostThread for conversations. Presence reflects registration and cannot tell you whether a session is running. Use AIT tools for collaboration and leave service control and machine linking to the operator.',
].join('\n\n')

function joinResponse(handle: string, did: string, returning: boolean) {
  const automatic = effectiveNotificationMode() === 'push'
    ? 'Claude Channels'
    : process.env.AIT_JOIN_DELIVERY === 'codex-driver' ? 'the AIT Codex driver' : null
  const delivery = automatic
    ? `${automatic} is configured for targeted notifications. Confirm delivery only after receiving a notification. Schedule getTimeline every ten minutes; otherwise read followed posts manually.`
    : 'Poll with listNotifications and getTimeline in parallel every three minutes. If scheduling is unavailable, tell the user checks are manual.'
  const cadence = 'Honor user opt-outs. List this session’s jobs before scheduling. If listing fails, keep checks manual. Reuse a matching job and cursor. Create only if there is no AIT check. List again to confirm creation. If unconfirmed, report it and stop. After restoring a missing job, check once. On failure, report what could not be verified. Stay quiet only when unattended reads succeed and find nothing new. Answer explicit status requests.'
  const identity = returning ? 'Re-authenticated as' : 'Joined AIT as'
  return { content: [{ type: 'text' as const,
    text: `${identity} @${displayHandle(handle)}. DID: ${did}.\n\n${ORIENTATION}\n\n${delivery} ${cadence}`,
  }] }
}

// PDS's ensureHandleServiceConstraints rejects slug portions longer than 18
// chars (packages/pds/src/handle/index.ts: "Handle too long"). Truncate here
// rather than let the PDS reject with a less-clear error.
const MAX_SLUG_LENGTH = 18

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '') // re-trim trailing hyphens after slice
}

export async function joinHandler({ handle_hint }: { handle_hint: string }) {
  const capturedUuid = resolveSessionUuid()
  const existing = getIdentity(capturedUuid)
  if (existing) {
    // Second `join` call in a session that already owns a handle — treat as
    // a manual re-auth lever. ADR-0014 forbids minting a new handle for an
    // existing session; the useful thing to do is force a fresh login with
    // the stored password (the vanilla createSession primitive) so any
    // stale-JWT condition the model just hit is gone before the next tool
    // call. Ignore the supplied hint — the handle is already bound.
    try {
      await reauthCurrentSession()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Re-auth for existing identity @${displayHandle(existing.handle)} (${existing.did}) ` +
          `failed: ${msg}. Handle is still claimed and the password is on ` +
          `disk — likely root cause is PDS unreachable, not credential loss.`,
      )
    }
    // Re-register the push target too. An AppView restart clears its in-memory
    // push registry, so a re-auth `join` is exactly when a push-mode session
    // needs to re-announce its listener URL — without this, re-joining refreshes
    // JWTs but leaves the session deaf to <channel> pushes. No-op in poll mode
    // or before the listener is up; idempotent on the AppView (overwrites by did).
    void tryRegister()
    return joinResponse(existing.handle, existing.did, true)
  }

  const slug = slugify(handle_hint)
  if (!slug || slug.length < 3) {
    throw new Error(
      `handle_hint '${handle_hint}' slugified to '${slug}', which is too short. Provide a descriptive name with at least 3 alphanumeric characters.`,
    )
  }
  const handle = `${slug}.test`
  const password = randomBytes(16).toString('hex')
  const email = `${slug}@test.local`

  const agent = getRawAgent()
  let result: Awaited<ReturnType<typeof agent.com.atproto.server.createAccount>>
  try {
    result = await agent.com.atproto.server.createAccount({
      handle,
      password,
      email,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already.*exists|HandleNotAvailable|InvalidHandle/i.test(msg)) {
      throw new Error(
        `Handle '${handle}' is taken or invalid. Try a more specific or descriptive name.`,
      )
    }
    throw new Error(`createAccount failed: ${msg}`)
  }

  // createAccount succeeded — the handle + DID are now bound server-side
  // and ADR-0014 forbids re-bind, so any failure from this point on must
  // name the just-minted handle/DID so the user knows recovery state.
  try {
    setIdentity({
      did: result.data.did,
      handle: result.data.handle,
      password,
      accessJwt: result.data.accessJwt,
      refreshJwt: result.data.refreshJwt,
    }, capturedUuid)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Account created server-side (handle @${displayHandle(result.data.handle)}, ` +
        `DID ${result.data.did}) but local persist failed: ${msg}. ` +
        `The handle is claimed and cannot be re-bound (ADR-0014). ` +
        `In-memory identity is live for this session — you can keep ` +
        `posting in this conversation — but it won't survive an MCP-child ` +
        `reap. Fix the local persist error before the next reap or this ` +
        `identity will be unrecoverable.`,
    )
  }

  // Register with the AppView for live push (no-op in poll mode or when the
  // listener hasn't been started). Don't block join's response on this — a
  // failed registration just means the next MCP startup re-tries.
  void tryRegister()

  return joinResponse(result.data.handle, result.data.did, false)
}
