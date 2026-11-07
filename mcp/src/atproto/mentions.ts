import type { AtpAgent } from '@atproto/api'
import { displayHandle, resolveActor, UnknownActorError } from '../handles.js'

// Exclude email/URL/package fragments; periods and other punctuation after a
// complete label stay outside the facet. Code is literal, never an address.
const MENTION_RE = /(?<![\p{L}\p{N}_@/.:=?&#%+-])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?![\p{L}\p{N}_@/-]|\.[a-z0-9])/giu

export interface MentionFacet {
  index: { byteStart: number; byteEnd: number }
  features: [{ $type: 'app.bsky.richtext.facet#mention'; did: string }]
}

export async function buildMentionFacets(
  agent: AtpAgent,
  text: string,
): Promise<MentionFacet[]> {
  const code: [number, number][] = []
  const fences = /^ {0,3}(`{3,})[^\n]*(?:\n|$)/gm
  let fence
  while ((fence = fences.exec(text))) {
    const closing = new RegExp('^ {0,3}`{' + fence[1].length + ',}[ \\t]*(?:\\n|$)', 'gm')
    closing.lastIndex = fences.lastIndex
    const end = closing.exec(text)
    const until = end ? closing.lastIndex : text.length
    code.push([fence.index, until])
    fences.lastIndex = until
  }
  // A stray backtick does not consume later lines. Match complete, equal
  // delimiters only; an unclosed fenced block above remains code through EOF.
  for (const span of text.matchAll(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g)) {
    if (!code.some(([start, end]) => span.index! >= start && span.index! < end)) {
      code.push([span.index!, span.index! + span[0].length])
    }
  }
  const matches = [...text.matchAll(MENTION_RE)].filter((match) =>
    !code.some(([start, end]) => match.index! >= start && match.index! < end) &&
    (!match[1].includes('.') || displayHandle(match[1]) !== match[1]),
  )
  if (matches.length === 0) return []

  // Resolve each unique handle once, then map back to facets per occurrence.
  // Each occurrence gets its own facet (bsky behavior); the AppView dedupes
  // per (uri, recipientDid) when emitting notifications.
  const uniqueHandles = [...new Set(matches.map((m) => m[1].toLowerCase()))]
  const didByHandle = new Map<string, string>()
  for (const handle of uniqueHandles) {
    try {
      const actor = await resolveActor(agent, handle)
      didByHandle.set(handle, actor.did)
    } catch (error) {
      if (error instanceof UnknownActorError) continue
      // A known negative answer is plain text; transport failures and
      // ambiguous names must stop the write, preserving notification intent.
      throw error
    }
  }

  const encoder = new TextEncoder()
  const facets: MentionFacet[] = []
  for (const m of matches) {
    const handle = m[1].toLowerCase()
    const did = didByHandle.get(handle)
    if (!did) continue
    const charStart = m.index ?? 0
    const charEnd = charStart + m[0].length
    const byteStart = encoder.encode(text.slice(0, charStart)).length
    const byteEnd = encoder.encode(text.slice(0, charEnd)).length
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
    })
  }
  return facets
}
