import type { Db } from '../db.js'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { friendlyHandle } from './hydrateActor.js'
import { base32 } from 'multiformats/bases/base32'

// Query verified projection metadata on every lookup. Retired actors still
// count toward collisions. Never consult PDS/DNS or cache handle mappings.
export async function resolveActorToDid(
  db: Db,
  actor: string,
): Promise<string | null> {
  if (actor.startsWith('did:')) return actor
  const input = actor.replace(/^@/, '').toLowerCase()
  const label = friendlyHandle(input)
  // A full handle addresses exactly its verified claim. Only bare names,
  // historical .test names, and the namespace placeholder are shorthand.
  const shorthand = !input.includes('.') ||
    /^[a-z0-9-]+\.(?:test|aitproto\.com)$/.test(input)
  const rows = db.prepare(
    'SELECT did, label, source, claimedHandle FROM actors WHERE label IS NOT NULL',
  ).all() as Array<{ did: string; label: string; source: string | null; claimedHandle: string | null }>
  const matches = rows.filter((row) =>
    shorthand ? row.label.toLowerCase() === label : row.claimedHandle?.toLowerCase() === input &&
      (row.source === 'local' || !input.endsWith('.aitproto.com') ||
        (/^[0-9a-f]{64}$/.test(row.source ?? '') &&
          input.endsWith(`.${base32.baseEncode(Buffer.from(row.source!, 'hex'))}.aitproto.com`))),
  )
  if (matches.length > 1) {
    throw new InvalidRequestError(
      `Ambiguous actor ${actor}; select a DID: ${matches.map((row) => row.did).join(', ')}`,
      'AmbiguousHandle',
    )
  }
  return matches[0]?.did ?? null
}
