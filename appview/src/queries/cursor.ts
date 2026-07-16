// Opaque pagination/replay cursors. Two shapes live here because the AppView
// has two kinds of ordering to expose, and neither can use the other's:
//
//   - Post feeds (getTimeline, getAuthorFeed) read `posts`, which has no
//     sequence, so they order on (createdAt, uri) — a keyset tuple in the shape
//     of atproto's own GenericKeyset/TimeCidKeyset (`primary::secondary`), which
//     is internal to @atproto/pds and can't be imported.
//   - Notifications read `notifications`, which owns a monotonic `seq`, so they
//     order on that alone. seq is already total and unique, making a tiebreaker
//     redundant.
//
// Both encode to an opaque base64url string. Callers never inspect the contents:
// what's inside is the AppView's business, and the wire contract is "hand this
// back to me unchanged" — the same contract bsky's listNotifications cursor has.

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
