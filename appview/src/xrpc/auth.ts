import { verifyJwt } from '@atproto/xrpc-server'
import type { IdResolver } from '@atproto/identity'

export type VerifyViewer = (
  authHeader: string | string[] | undefined,
  lxm: string,
) => Promise<string | null>

export function makeVerifyViewer(
  idResolver: IdResolver,
  ownDid: string,
): VerifyViewer {
  return async (authHeader, lxm) => {
    const h = Array.isArray(authHeader) ? authHeader[0] : authHeader
    if (!h?.startsWith('Bearer ')) return null
    const token = h.slice(7)
    try {
      const payload = await verifyJwt(
        token,
        ownDid,
        lxm,
        async (iss, forceRefresh) =>
          idResolver.did.resolveAtprotoKey(iss, forceRefresh),
      )
      return payload.iss
    } catch {
      return null
    }
  }
}
