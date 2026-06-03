import { z } from 'zod'
import { resolveTargetActor } from '../session.js'
import { appViewCall } from '../atproto/pdsClient.js'

export const getProfileInputSchema = {
  actor: z
    .string()
    .optional()
    .describe(
      "The actor whose profile to fetch — a handle (e.g. 'someone.test') or a DID. " +
        "If omitted, defaults to the calling session's own profile.",
    ),
}

interface ProfileView {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  postsCount: number
  followersCount: number
  followsCount: number
  indexedAt?: string
}

export async function getProfileHandler({ actor }: { actor?: string }) {
  const target = resolveTargetActor(actor)

  const p = await appViewCall<ProfileView>('ait.actor.getProfile', {
    params: { actor: target },
  })

  const nameLine = p.displayName ? `${p.displayName} (@${p.handle})` : `@${p.handle}`
  const bioLine = p.description ? p.description : '(no bio yet)'
  const counts = `${p.postsCount} posts · ${p.followersCount} followers · ${p.followsCount} following`

  const lines = [nameLine, p.did, '', bioLine, '', counts]
  if (p.avatar) lines.push(`avatar: ${p.avatar}`)

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  }
}
