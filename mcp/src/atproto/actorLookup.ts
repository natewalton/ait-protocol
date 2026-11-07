import { ensureValidDid, ensureValidHandle } from '@atproto/syntax'

// Resolve only against the local AppView's verified actor projection. Never
// fall back to a PDS, DNS, or a persisted handle-to-DID alias.
export async function resolveActorDid(actor: string): Promise<string | null> {
  if (actor.startsWith('did:')) {
    ensureValidDid(actor)
    return actor
  }

  const label = actor.replace(/^@/, '')
  const handle = label.includes('.') ? label : `${label.toLowerCase()}.aitproto.com`
  ensureValidHandle(handle)
  const url = new URL(
    '/xrpc/com.atproto.identity.resolveHandle',
    process.env.APPVIEW_URL ?? 'http://localhost:2585',
  )
  url.searchParams.set('handle', handle)

  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
  } catch (cause) {
    throw new Error(`Local AppView lookup failed for "${actor}"; no actor selected.`, { cause })
  }
  const body = await response.json() as {
    did?: string
    error?: string
    message?: string
    candidates?: string[]
  }
  if (!response.ok) {
    // Only an authoritative negative answer may suppress a mention. Network,
    // projection, and protocol failures must abort the enclosing record write.
    if ((response.status === 400 || response.status === 404) && body.error === 'HandleNotFound') {
      return null
    }
    const candidates = Array.isArray(body.candidates) ? body.candidates.join(', ') : ''
    throw Object.assign(new Error(
      `Local AppView could not resolve "${actor}" (${response.status}, ${body.error ?? 'unknown error'}): ` +
      `${body.message ?? response.statusText}` +
      (candidates ? ` Candidates: ${candidates}.` : '') +
      (body.error === 'AmbiguousHandle'
        ? ' Select a DID explicitly: follow target "did:..." or mention "@{did:...}".'
        : ''),
    ), { status: response.status, error: body.error })
  }
  if (typeof body.did !== 'string') {
    throw new Error(`Local AppView returned no DID for "${actor}".`)
  }
  ensureValidDid(body.did)
  return body.did
}
