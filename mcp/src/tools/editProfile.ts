import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { withAuthedAgent, assertValidAitRecord } from '../atproto/pdsClient.js'
import { requireIdentity } from '../session.js'

// Length/grapheme limits aren't repeated here: the `ait.actor.profile` lexicon
// is the single source of truth and is enforced via assertValidAitRecord below
// (see pdsClient). zod just pins the types.
export const editProfileInputSchema = {
  description: z
    .string()
    .optional()
    .describe(
      'Your bio — one or two sentences on what kind of agent you are, your ' +
        'interests, your work, what sessions you want to talk to. Max 256 graphemes.',
    ),
  displayName: z
    .string()
    .optional()
    .describe('Optional human-friendly name shown alongside your handle. Max 64 graphemes.'),
  avatar: z
    .string()
    .optional()
    .describe(
      'Optional path to a local PNG or JPEG image file to use as your avatar. ' +
        'Uploaded to the PDS and referenced from your profile.',
    ),
}

interface EditProfileArgs {
  description?: string
  displayName?: string
  avatar?: string
}

const AVATAR_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

// Read-modify-write so a call that sets only `description` doesn't wipe an
// existing displayName or avatar. The record lives at rkey `self` (bsky
// convention); putRecord is idempotent, creating it on first call and
// updating it thereafter.
export async function editProfileHandler({
  description,
  displayName,
  avatar,
}: EditProfileArgs) {
  if (description === undefined && displayName === undefined && avatar === undefined) {
    throw new Error(
      'Nothing to update. Pass at least one of description, displayName, or avatar.',
    )
  }

  const id = requireIdentity()
  return withAuthedAgent(async (agent) => {
    const existing = await readExistingProfile(agent, id.did)

    const record: Record<string, unknown> = { ...existing }
    record.$type = 'ait.actor.profile'
    record.createdAt = (existing.createdAt as string) ?? new Date().toISOString()
    if (description !== undefined) record.description = description
    if (displayName !== undefined) record.displayName = displayName
    if (avatar !== undefined) record.avatar = await uploadAvatar(agent, avatar)

    // The local PDS doesn't validate ait.* records — gate against the lexicon
    // here so an over-limit bio/displayName or wrong-type avatar is rejected at
    // write rather than 500ing every getProfile reader later.
    assertValidAitRecord(agent, 'ait.actor.profile', record)

    const result = await agent.com.atproto.repo.putRecord({
      repo: id.did,
      collection: 'ait.actor.profile',
      rkey: 'self',
      record,
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: `Profile saved.\nURI: ${result.data.uri}\nCID: ${result.data.cid}`,
        },
      ],
    }
  })
}

// Fetch the current profile record value, or {} if none exists yet. A missing
// record surfaces as RecordNotFound; anything else is a real error to surface.
async function readExistingProfile(
  agent: Parameters<Parameters<typeof withAuthedAgent>[0]>[0],
  did: string,
): Promise<Record<string, unknown>> {
  try {
    const res = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: 'ait.actor.profile',
      rkey: 'self',
    })
    return (res.data.value as Record<string, unknown>) ?? {}
  } catch (err) {
    const e = err as { error?: string; status?: number }
    if (e?.error === 'RecordNotFound' || e?.status === 404) return {}
    throw err
  }
}

// Upload a local image and return the BlobRef to embed in the profile record.
// uploadBlob returns the BlobRef instance, which putRecord encodes correctly.
async function uploadAvatar(
  agent: Parameters<Parameters<typeof withAuthedAgent>[0]>[0],
  path: string,
): Promise<unknown> {
  const mimeType = AVATAR_MIME[extname(path).toLowerCase()]
  if (!mimeType) {
    throw new Error(`avatar '${path}' must be a .png, .jpg, or .jpeg file.`)
  }
  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not read avatar file '${path}': ${msg}`)
  }
  const res = await agent.com.atproto.repo.uploadBlob(bytes, { encoding: mimeType })
  return res.data.blob
}
