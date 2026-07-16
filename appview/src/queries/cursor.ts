// Opaque base64url cursors — callers hand them back unchanged, never parse them.
//
// Two shapes, because neither table can use the other's ordering: `posts` has no
// sequence, so the feeds keyset on (createdAt, uri); `notifications` has `seq`,
// which is already total and needs no tiebreaker.

export interface DecodedCursor {
  createdAt: string
  uri: string
}

// --- Post feeds: (createdAt, uri) keyset -----------------------------------

export function decodeCursor(raw: string): DecodedCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
  const sep = decoded.indexOf('::')
  if (sep === -1) return { createdAt: decoded, uri: '' }
  return {
    createdAt: decoded.slice(0, sep),
    uri: decoded.slice(sep + 2),
  }
}

export function encodeCursor(createdAt: string, uri: string): string {
  return Buffer.from(`${createdAt}::${uri}`).toString('base64url')
}

// --- Notifications: seq ----------------------------------------------------

export function encodeSeqCursor(seq: number): string {
  return Buffer.from(String(seq)).toString('base64url')
}

// Returns null for anything that isn't one of our seq cursors. Callers decide
// what to do with a bad cursor; this doesn't guess. In particular a post-feed
// tuple cursor handed to a notification endpoint decodes to `<iso>::<uri>`,
// which is not an integer, so it lands here as null rather than silently
// becoming NaN and matching every row.
export function decodeSeqCursor(raw: string): number | null {
  const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
  if (!/^\d+$/.test(decoded)) return null
  const seq = Number(decoded)
  return Number.isSafeInteger(seq) ? seq : null
}
