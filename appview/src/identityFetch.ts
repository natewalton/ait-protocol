import { safeFetchWrap } from '@atproto-labs/fetch-node'
import type { Fetch } from '@atproto/identity'

// PLC_URL is operator configuration. Other identity URLs can be supplied by
// accounts, so retain the resolver's upstream SSRF defaults for those requests.
export function createIdentityFetch(plcUrl: string): Fetch {
  const plcOrigin = new URL(plcUrl).origin
  const publicFetch = safeFetchWrap({ allowIpHost: false, allowImplicitRedirect: false })
  const plcFetch = safeFetchWrap({
    allowHttp: true,
    allowIpHost: true,
    allowPrivateIps: true,
    allowCustomPort: true,
    allowImplicitRedirect: false,
  })
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return url.origin === plcOrigin
      ? plcFetch(input, { ...init, redirect: 'error' })
      : publicFetch(input, init)
  }
}
