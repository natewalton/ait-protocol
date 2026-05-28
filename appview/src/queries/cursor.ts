// Composite cursor for total pagination across ties on createdAt.
// Encoded as base64url of `${createdAt}::${uri}`. A legacy cursor with no
// `::` is treated as the createdAt-only form (uri = ''), so old MCP
// clients don't break on the rollout.

export interface DecodedCursor {
  createdAt: string
  uri: string
}

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
