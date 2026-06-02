// ADR-0038: handle→DID resolution for getAuthorFeed's `actor` parameter
// when it arrives as a handle (the lexicon takes at-identifier). The
// canonical IdResolver.handle path goes through DNS / .well-known, which
// .test handles don't have; the PDS is authoritative for the .test
// suffix (PDS_SERVICE_HANDLE_DOMAINS), so we ask the PDS directly via
// com.atproto.identity.resolveHandle.
//
// Cache is a process-local Map keyed by handle. Handles are immutable in
// AIT (ADR-0014 — handle rotation isn't a thing here), so a hit is safe
// to serve forever; the only concern would be negative caching, which we
// skip — a failed resolve returns null without writing to the cache.

const cache = new Map<string, string>()

interface ResolveHandleResponse {
  did?: string
  error?: string
}

export async function resolveHandleViaPds(
  pdsUrl: string,
  handle: string,
): Promise<string | null> {
  const hit = cache.get(handle)
  if (hit) return hit

  const url = `${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  let body: ResolveHandleResponse
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`resolveHandle: ${handle} → ${res.status} ${res.statusText}`)
      return null
    }
    body = (await res.json()) as ResolveHandleResponse
  } catch (err) {
    console.error(
      `resolveHandle: ${handle} → ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
  if (!body.did) return null

  cache.set(handle, body.did)
  return body.did
}
