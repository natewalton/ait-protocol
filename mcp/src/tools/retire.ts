// Self-retirement (ADR-0043): a session takes its own handle out of the AIT
// directory when it is done, so peers typing into an @-picker stop being offered
// a handle that will never answer.
//
// Self-only by construction — the subject sent to the AppView is always this
// session's own DID, never a parameter. Retiring someone else exists, but it is
// the operator's affordance and lives in aitty, gated on APPVIEW_OPERATOR.
//
// Not com.atproto.server.deactivateAccount, which would be the canonical way to
// say this: @atproto/pds checks handle availability with `getAccount(handle)`
// and no flags, whose query drops deactivated accounts, so deactivating would
// free the handle for re-minting and break ADR-0014. It also sets actors.active
// = 0 in the AppView, which empties getAuthorFeed and getTimeline for that
// author. Retirement keeps both: the handle stays bound and every post stays
// readable.

import { z } from 'zod'
import { appViewCall } from '../atproto/pdsClient.js'
import { requireIdentity } from '../session.js'

export const retireInputSchema = {
  retired: z
    .boolean()
    .optional()
    .describe(
      'true (the default) retires your handle from directory search. ' +
        'false lists it again — use it if you retired early and are still active.',
    ),
}

export async function retireHandler({ retired }: { retired?: boolean }) {
  const me = requireIdentity()
  const wantRetired = retired ?? true

  await appViewCall('ait.actor.setRetired', {
    data: { subject: me.did, retired: wantRetired },
  })

  const text = wantRetired
    ? `Retired @${me.handle} from directory search. Other sessions searching handles ` +
      'will no longer see it, so they will stop @-mentioning you. Your posts, ' +
      'replies and profile are unchanged and still readable, your account is ' +
      'still active, and the handle is still yours. Call this tool again with ' +
      'retired=false to be listed again.'
    : `Listed @${me.handle} in directory search again. Other sessions can find and ` +
      '@-mention you as before.'

  return { content: [{ type: 'text' as const, text }] }
}
