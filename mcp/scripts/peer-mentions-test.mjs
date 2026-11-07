// Hermetic handler test: node --import tsx scripts/peer-mentions-test.mjs
// Only the ephemeral HTTP fixture receives traffic. Tool session/storage is
// mocked; routing checks use real AtpAgent session and XRPC request handling.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { AtpAgent } from '@atproto/api'
import { ensureValidHandle } from '@atproto/syntax'

const { registerAitLexicons, assertValidAitRecord, localPdsFetch } = await import('../src/atproto/aitClient.ts')
const A = `did:plc:${'a'.repeat(24)}`
const B = `did:plc:${'b'.repeat(24)}`
const SELF = `did:plc:${'s'.repeat(24)}`
const machine = 'a'.repeat(52)
const domain = `.${machine}.aitproto.com`
const wireHandle = `luna${domain}`
const parentUri = `at://${B}/ait.feed.post/parent`
const cid = 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const requests = []
const writes = []
const validated = []
const validator = new AtpAgent({
  service: 'http://unused.invalid',
  fetch: () => { throw new Error('Unexpected PDS call') },
})
registerAitLexicons(validator)
const agent = {
  lex: validator.lex,
  com: { atproto: {
    identity: { resolveHandle: () => { throw new Error('PDS resolution forbidden') } },
    repo: {
      getRecord: async () => ({ data: { uri: parentUri, cid, value: {} } }),
      createRecord: async (input) => {
        assert.equal(validated.at(-1), input.record, 'lexicon validation must precede write')
        writes.push(input)
        return { data: { uri: `at://${SELF}/${input.collection}/fixture`, cid } }
      },
    },
  } },
}
globalThis.__aitPeerFixture = {
  agent,
  identity: { did: SELF, handle: 'luna.test', password: 'fixture', accessJwt: 'old-access', refreshJwt: 'old-refresh' },
  validate: (a, nsid, record) => {
    assertValidAitRecord(a, nsid, record)
    validated.push(record)
  },
}
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = new URL(specifier, context.parentURL ?? import.meta.url).href
    let source
    if (resolved.endsWith('/src/atproto/pdsClient.js')) {
      source = `
        export const withAuthedAgent = async fn => fn(globalThis.__aitPeerFixture.agent);
        export const assertValidAitRecord = (...args) => globalThis.__aitPeerFixture.validate(...args);
        export const getRawAgent = () => globalThis.__aitPeerFixture.agent;
        export const reauthCurrentSession = () => globalThis.__aitPeerFixture.reauth();
        export const appViewCall = (...args) => globalThis.__aitPeerFixture.appViewCall(...args);
      `
    } else if (resolved.endsWith('/src/session.js')) {
      source = `
        export const requireIdentity = () => {
          if (!globalThis.__aitPeerFixture.identity) throw new Error('No fixture identity');
          return globalThis.__aitPeerFixture.identity;
        };
        export const getIdentity = () => globalThis.__aitPeerFixture.identity;
        export const setIdentity = id => { globalThis.__aitPeerFixture.identity = id; };
        export const updateIdentityTokens = patch => Object.assign(globalThis.__aitPeerFixture.identity, patch);
        export const resolveTargetActor = actor => actor ?? requireIdentity().did;
      `
    } else if (resolved.endsWith('/src/push.js')) {
      source = 'export const tryRegister = async () => {};'
    } else if (resolved.endsWith('/src/aitty/identity.js')) {
      source = 'export const saveIdentity = () => {};'
    }
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

agent.call = async (nsid, params) => {
  assert.equal(nsid, 'ait.actor.searchActors')
  const label = params.q.slice(0, -1)
  try { ensureValidHandle(`${label}.aitproto.com`) } catch { return {data:{actors:[]}} }
  const url = new URL('/xrpc/com.atproto.identity.resolveHandle', process.env.APPVIEW_URL)
  url.searchParams.set('handle', `${label}.aitproto.com`)
  const response = await fetch(url, {redirect:'error'}), body = await response.json()
  if (response.ok) return { data: { actors: [{did:body.did,handle:`${label}${domain}`}] } }
  if ([400,404].includes(response.status) && body.error === 'HandleNotFound') return {data:{actors:[]}}
  if (body.error === 'AmbiguousHandle') return {data:{actors:[{did:A,handle:`${label}${domain}`},{did:B,handle:`${label}.${'b'.repeat(52)}.aitproto.com`}]}}
  throw Object.assign(new Error(body.message ?? body.error), {status:response.status,error:body.error})
}

let lunaAmbiguous = false
let logicalPds = 'https://pds.localhost'
const pdsRequests = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid')
  if (url.pathname !== '/xrpc/com.atproto.identity.resolveHandle') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    pdsRequests.push({ url: req.url, method: req.method, headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    if (/^\/xrpc\/com\.atproto\.server\.(createAccount|createSession|refreshSession|getSession)$/.test(url.pathname)) {
      return res.end(JSON.stringify({
        did: SELF, handle: wireHandle, accessJwt: 'routed-access', refreshJwt: 'routed-refresh',
        emailConfirmed: true, active: true,
        didDoc: {
          id: SELF, alsoKnownAs: [`at://${wireHandle}`],
          service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: logicalPds }],
        },
      }))
    }
    if (url.pathname === '/xrpc/fixture.unauthorized' ||
      (url.pathname === '/xrpc/com.atproto.repo.createRecord' && JSON.parse(body).record.text === 'force401')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="local-fixture"' })
      return res.end(JSON.stringify({ error: 'AuthRequired', message: 'Unauthorized fixture POST' }))
    }
    if (url.pathname === '/xrpc/com.atproto.repo.createRecord') {
      return res.end(JSON.stringify({ uri: `at://${SELF}/ait.feed.post/routed`, cid }))
    }
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      return res.end(JSON.stringify({ uri: `at://${SELF}/ait.feed.post/routed`, cid, value: { text: 'routed fixture' } }))
    }
    if (url.pathname === '/xrpc/fixture.redirect') {
      res.writeHead(302, { location: 'https://forbidden.invalid/' })
      return res.end()
    }
    res.statusCode = 404
    return res.end(JSON.stringify({ error: 'NotFound' }))
  }
  assert.equal(req.method, 'GET')
  assert.equal(url.pathname, '/xrpc/com.atproto.identity.resolveHandle')
  const handle = url.searchParams.get('handle')
  ensureValidHandle(handle)
  requests.push(handle)
  const label = handle.toLowerCase().replace(/(?:\.[a-z2-7]{52})?\.aitproto\.com$|\.test$/, '')
  const full = /\.[a-z2-7]{52}\.aitproto\.com$/i.test(handle)
  res.setHeader('content-type', 'application/json')
  if (label === 'reset') return req.socket.destroy()
  if (label === 'broken') return res.end('{')
  if (label === 'invalid') return res.end(JSON.stringify({ did: 'wrong' }))
  if (label === 'redirect') {
    res.writeHead(302, { location: 'http://unused.invalid/' })
    return res.end()
  }
  if (label === 'twin' || (label === 'luna' && lunaAmbiguous && !full)) {
    res.statusCode = 400
    return res.end(JSON.stringify({
      error: 'AmbiguousHandle',
      // Canonical XRPC errors carry candidate DIDs in message; also exercise
      // an optional structured candidate list without requiring that extension.
      message: label === 'twin'
        ? `More than one verified actor has this label: ${A}, ${B}.`
        : 'More than one verified actor has this label.',
      ...(label === 'twin' ? {} : { candidates: [A, B] }),
    }))
  }
  if (label === 'luna' || label === 'legacy') {
    return res.end(JSON.stringify({ did: label === 'luna' ? A : B }))
  }
  res.statusCode = label === 'down' ? 503 : 400
  res.end(JSON.stringify({ error: 'HandleNotFound', message: 'No verified actor.' }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const oldAppView = process.env.APPVIEW_URL
process.env.APPVIEW_URL = `http://127.0.0.1:${server.address().port}`
const realFetch = globalThis.fetch
const transportRequests = []
globalThis.fetch = (input, options) => {
  assert.equal(new URL(input instanceof Request ? input.url : input).origin, process.env.APPVIEW_URL, 'only fixture HTTP is allowed')
  assert.equal(input instanceof Request ? input.redirect : options?.redirect, 'error', 'cannot redirect to another resolver')
  transportRequests.push(input)
  return realFetch(input, options)
}

try {
  const localService = process.env.APPVIEW_URL
  const routingFetch = (input, init) => localPdsFetch(input, init, localService)
  const writeInput = {
    repo: SELF, collection: 'ait.feed.post',
    record: { $type: 'ait.feed.post', text: 'UTF8 body café 🙂', createdAt: '2026-10-30T12:00:00.000Z' },
  }
  // SDK session responses really change dispatchUrl. The constructor-provided
  // fetch still routes GET/POST locally, without changing session internals.
  for (const endpoint of ['https://pds.localhost', `https://${machine}.localhost`]) {
    logicalPds = endpoint
    const routed = new AtpAgent({ service: localService, fetch: routingFetch })
    registerAitLexicons(routed)
    await routed.createAccount({ handle: wireHandle, password: 'fixture', email: 'fixture@example.invalid' })
    assert.equal(routed.dispatchUrl.origin, endpoint)
    await routed.com.atproto.repo.createRecord(writeInput)
    assert.equal(pdsRequests.at(-1).method, 'POST')
    assert.deepEqual(JSON.parse(pdsRequests.at(-1).body), writeInput)
    assert.equal(pdsRequests.at(-1).headers.authorization, 'Bearer routed-access')
    assert.match(pdsRequests.at(-1).headers['content-type'], /application\/json/)
    await routed.login({ identifier: SELF, password: 'fixture' })
    assert.equal(routed.dispatchUrl.origin, endpoint)
    await routed.com.atproto.repo.createRecord(writeInput)
    const resumed = new AtpAgent({ service: localService, fetch: routingFetch })
    registerAitLexicons(resumed)
    await resumed.resumeSession({ ...routed.session })
    assert.equal(resumed.dispatchUrl.origin, endpoint)
    await resumed.com.atproto.repo.createRecord(writeInput)
    await resumed.com.atproto.repo.getRecord({ repo: SELF, collection: 'ait.feed.post', rkey: 'routed' })
    const get = pdsRequests.at(-1)
    assert.equal(get.method, 'GET')
    assert.equal(get.body, '')
    assert.equal(get.headers.authorization, 'Bearer routed-access')
    const query = new URL(get.url, localService).searchParams
    assert.equal(query.get('repo'), SELF)
    assert.equal(query.get('collection'), 'ait.feed.post')
    assert.equal(query.get('rkey'), 'routed')
    const abort = new AbortController()
    abort.abort()
    const beforeAbort = pdsRequests.length
    await assert.rejects(() => resumed.com.atproto.repo.getRecord(
      { repo: SELF, collection: 'ait.feed.post', rkey: 'routed' }, { signal: abort.signal },
    ))
    assert.equal(transportRequests.at(-1).signal.aborted, true)
    assert.equal(pdsRequests.length, beforeAbort, 'aborted request never reaches fixture')
  }
  const beforeRejected = transportRequests.length
  for (const url of [
    'https://outside.invalid/xrpc/com.atproto.repo.createRecord',
    'https://pds.localhost.attacker.invalid/xrpc/test',
    `https://${machine}a.localhost/xrpc/test`,
    `https://${'1'.repeat(52)}.localhost/xrpc/test`,
    'https://other.localhost/xrpc/test', 'http://pds.localhost/xrpc/test',
    'https://pds.localhost:9999/xrpc/test', `https://${machine}.localhost:9999/xrpc/test`,
    'http://127.0.0.1:1/xrpc/test', 'https://user:secret@pds.localhost/xrpc/test',
    'https://pds.localhost/not-xrpc', `${localService}/xrpc`,
  ]) await assert.rejects(() => localPdsFetch(url, undefined, localService))
  for (const service of ['https://outside.invalid', 'http://user:secret@localhost:2583', 'ftp://127.0.0.1']) {
    await assert.rejects(() => localPdsFetch('https://pds.localhost/xrpc/test', undefined, service))
  }
  assert.equal(transportRequests.length, beforeRejected, 'negative host/path/config cases never invoke fetch or DNS')
  const beforeRedirect = pdsRequests.length
  await assert.rejects(() => localPdsFetch('https://pds.localhost/xrpc/fixture.redirect', undefined, localService))
  assert.equal(pdsRequests.length, beforeRedirect + 1, 'redirect is not followed')

  const deniedBody = JSON.stringify({ text: 'finite POST café 🙂' })
  const denied = await localPdsFetch('https://pds.localhost/xrpc/fixture.unauthorized', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
    body: deniedBody,
  }, localService)
  assert.equal(denied.status, 401, 'HTTP 401 must remain a response, not a fetch failure')
  assert.equal((await denied.json()).error, 'AuthRequired')
  assert.equal(pdsRequests.at(-1).body, deniedBody)
  assert.equal(pdsRequests.at(-1).headers.authorization, 'Bearer fixture')
  const unauthenticated = new AtpAgent({ service: localService, fetch: routingFetch })
  registerAitLexicons(unauthenticated)
  await assert.rejects(() => unauthenticated.com.atproto.repo.createRecord({
    ...writeInput, record: { ...writeInput.record, text: 'force401' },
  }), (error) => {
    assert.equal(error.status, 401, 'canonical client must receive the normal XRPC 401')
    assert.equal(error.error, 'AuthRequired')
    return true
  })

  const { buildMentionFacets } = await import('../src/atproto/mentions.ts')
  const { resolveActorDid } = await import('../src/atproto/actorLookup.ts')
  const { displayHandle } = await import('../src/handles.ts')
  const { postHandler } = await import('../src/tools/post.ts')
  const { replyHandler } = await import('../src/tools/reply.ts')
  const { followHandler } = await import('../src/tools/follow.ts')
  const facetText = (text, facet) => Buffer.from(text).subarray(
    facet.index.byteStart, facet.index.byteEnd,
  ).toString('utf8')
  const isAmbiguous = (error) => {
    assert.match(error.message, /AmbiguousHandle|ambiguous/)
    assert.ok(error.message.includes(A) && error.message.includes(B))
    return true
  }
  const rejectsWithoutWrite = async (run, expected) => {
    const count = writes.length
    await assert.rejects(run, expected)
    assert.equal(writes.length, count, 'lookup failure must precede record write')
  }

  const text = `🙂 café @LUNA, @luna.test! @{${B}}; @missing @legacy.test.`
  await postHandler({ text })
  const post = writes.at(-1).record
  assert.equal(post.text, text)
  assert.deepEqual(post.facets.map((f) => facetText(text, f)), [
    '@LUNA', '@luna.test', `@{${B}}`, '@legacy.test',
  ])
  assert.deepEqual(post.facets.map((f) => f.features[0].did), [A, A, B, B])
  assert.equal(post.facets[0].index.byteStart, Buffer.byteLength('🙂 café '))
  assert.equal(requests[0], 'luna.aitproto.com', 'bare labels use the private placeholder namespace')
  assert.ok(requests.includes('luna.test') && requests.includes('legacy.test'))
  assert.ok(!requests.some((handle) => handle.startsWith('did:')))

  const before = requests.length
  assert.equal((await buildMentionFacets(agent, '@luna @LUNA @luna')).length, 3)
  assert.equal(requests.length - before, 1, 'resolve repeated label once per record')
  assert.deepEqual(await buildMentionFacets(agent, 'mail x@luna.test; no mention'), [])
  assert.deepEqual(await buildMentionFacets(agent, '@luna.test_suffix @luna.testé @luna_foo'), [])
  assert.deepEqual(await buildMentionFacets(agent, '@missing'), [])
  const beforeInvalidToken = requests.length
  await postHandler({ text: 'L @1.2.3 and @-invalid are ordinary text' })
  assert.equal(writes.at(-1).record.text, 'L @1.2.3 and @-invalid are ordinary text')
  assert.equal(writes.at(-1).record.facets, undefined)
  assert.equal(requests.length, beforeInvalidToken, 'invalid ordinary tokens are not looked up')
  await postHandler({ text: 'é @1.2.3 and @luna' })
  assert.equal(writes.at(-1).record.facets.length, 1)
  assert.equal(facetText(writes.at(-1).record.text, writes.at(-1).record.facets[0]), '@luna')

  await replyHandler({ parent_uri: parentUri, text: 'é @luna' })
  assert.equal(writes.at(-1).record.facets[0].features[0].did, A)
  assert.deepEqual(writes.at(-1).record.reply.parent, { uri: parentUri, cid })
  for (const target of ['luna', 'LUNA.TEST', B]) {
    await followHandler({ target })
    assert.equal(writes.at(-1).record.subject, target === B ? B : A)
  }
  await rejectsWithoutWrite(() => postHandler({ text: '@twin' }), isAmbiguous)
  await rejectsWithoutWrite(() => replyHandler({ parent_uri: parentUri, text: '@twin.test' }), isAmbiguous)
  await rejectsWithoutWrite(() => followHandler({ target: 'twin' }), isAmbiguous)
  await rejectsWithoutWrite(() => followHandler({ target: 'missing' }), /No AIT actor matches/)
  await rejectsWithoutWrite(() => followHandler({ target: SELF }), /Cannot follow yourself/)

  // No cross-call alias cache: a formerly unique label can become ambiguous.
  lunaAmbiguous = true
  await rejectsWithoutWrite(() => postHandler({ text: '@luna' }), isAmbiguous)
  const didRequests = requests.length
  await postHandler({ text: `Choose @{${A}}` })
  await followHandler({ target: A })
  assert.equal(requests.length, didRequests, 'explicit DID makes no lookup')

  for (const label of ['down', 'broken', 'invalid', 'reset', 'redirect']) {
    await rejectsWithoutWrite(() => postHandler({ text: `@${label}` }), Error)
    await rejectsWithoutWrite(() => followHandler({ target: label }), Error)
  }
  await rejectsWithoutWrite(() => postHandler({ text: '@{did:plc:}' }), Error)
  await rejectsWithoutWrite(() => followHandler({ target: 'did:plc:' }), Error)
  await rejectsWithoutWrite(() => followHandler({ target: '-bad' }), Error)
  await rejectsWithoutWrite(() => postHandler({ text: 'x'.repeat(1001) }), /grapheme/i)
  assert.equal(await resolveActorDid('missing'), null)

  for (const [input, expected] of [
    [wireHandle, 'luna'], ['luna.aitproto.com', 'luna.aitproto.com'], ['luna.test', 'luna'],
    ['luna.test.example', 'luna.test.example'], ['luna.example.com', 'luna.example.com'],
    [`luna.test${domain}`, `luna.test${domain}`], ['did:web:someone.test', 'did:web:someone.test'],
  ]) assert.equal(displayHandle(input), expected)
  assert.equal(await resolveActorDid(wireHandle), A)
  assert.equal(requests.at(-1), wireHandle, 'machine-qualified inputs remain exact')
  assert.equal(await resolveActorDid(`LUNA${domain}`), A)
  assert.equal(requests.at(-1), `LUNA${domain}`)

  const { newAccountHandle, resolveAppViewActorParams } = await import('../src/atproto/aitClient.ts')
  let domains = [domain, '.ignored.invalid']
  const accounts = []
  agent.com.atproto.server = {
    describeServer: async () => ({ data: { availableUserDomains: domains } }),
    createAccount: async (input) => {
      accounts.push(input)
      return { data: { did: SELF, handle: input.handle, accessJwt: 'new-access', refreshJwt: 'new-refresh' } }
    },
  }
  assert.equal(await newAccountHandle(agent, 'new-peer'), `new-peer${domain}`)
  for (const invalid of [[], ['.test'], ['.aitproto.com'], [`.${'A'.repeat(52)}.aitproto.com`], [`.${'a'.repeat(51)}.aitproto.com`], ['.invalid', domain]]) {
    domains = invalid
    await assert.rejects(() => newAccountHandle(agent, 'new-peer'), /PDS must advertise/)
  }
  domains = [domain]
  globalThis.__aitPeerFixture.identity = null
  const { joinHandler } = await import('../src/tools/join.ts')
  const joined = await joinHandler({ handle_hint: 'new-peer' })
  assert.equal(accounts.at(-1).handle, `new-peer${domain}`)
  assert.equal(globalThis.__aitPeerFixture.identity.handle, `new-peer${domain}`)
  assert.ok(joined.content[0].text.includes('Handle: @new-peer\n'))

  // Exercise the real MCP input boundary and DID-based reauthentication. Only
  // the SDK transport is replaced; session persistence remains an in-memory mock.
  const pds = await import('../src/atproto/pdsClient.ts')
  const pdsAgent = pds.getRawAgent()
  let activeSession = { did: SELF, handle: wireHandle, accessJwt: 'fresh-access', refreshJwt: 'fresh-refresh' }
  Object.defineProperty(pdsAgent, 'session', { get: () => activeSession })
  pdsAgent.login = async ({ identifier, password }) => {
    assert.equal(identifier, SELF, 'reauthentication uses stored DID, not stale handle')
    assert.equal(password, 'fixture')
  }
  globalThis.__aitPeerFixture.identity = { did: SELF, handle: 'stale.test', password: 'fixture' }
  globalThis.__aitPeerFixture.reauth = pds.reauthCurrentSession
  await pds.reauthCurrentSession()
  assert.equal(globalThis.__aitPeerFixture.identity.did, SELF)
  assert.equal(globalThis.__aitPeerFixture.identity.handle, wireHandle)
  assert.equal(globalThis.__aitPeerFixture.identity.accessJwt, 'fresh-access')
  const identityBeforeMismatch = globalThis.__aitPeerFixture.identity
  activeSession = { ...activeSession, did: B }
  await assert.rejects(() => pds.reauthCurrentSession(), /stored DID/)
  assert.equal(globalThis.__aitPeerFixture.identity, identityBeforeMismatch)
  activeSession = { ...activeSession, did: SELF }
  const accountCount = accounts.length
  const rejoined = await joinHandler({ handle_hint: 'ignored' })
  assert.equal(accounts.length, accountCount, 'existing session never creates another account')
  assert.ok(rejoined.content[0].text.includes(`@luna (${SELF})`))

  const history = 'literal @luna.test and @someone.aitproto.com'
  const view = {
    uri: parentUri, cid, author: { did: A, handle: wireHandle },
    record: { text: history }, indexedAt: '2026-10-30T12:00:00.000Z',
  }
  const profile = { did: A, handle: wireHandle, postsCount: 1, followersCount: 0, followsCount: 0, live: true }
  const notes = [{ uri: parentUri, cid, author: view.author, reason: 'mention', record: view.record, isRead: false, indexedAt: view.indexedAt, cursor: 'fixture' }]
  const actors = [
    { did: A, handle: wireHandle, live: true },
    { did: B, handle: `luna.${'b'.repeat(52)}.aitproto.com`, live: true },
  ]
  const outputs = {
    'ait.actor.getProfile': profile,
    'ait.feed.getAuthorFeed': { feed: [{ post: view }] },
    'ait.feed.getTimeline': { feed: [{ post: view }] },
    'ait.feed.getPostThread': { thread: { post: view } },
    'ait.notification.listNotifications': { notifications: notes },
    'ait.actor.searchActors': { actors },
    'ait.actor.setRetired': { subject: A, retired: true },
  }
  const originalOutputs = JSON.stringify(outputs)
  const calls = []
  pdsAgent.call = async (nsid, params, data) => {
    validator.lex.assertValidXrpcParams(nsid, params)
    if (data) validator.lex.assertValidXrpcInput(nsid, data)
    validator.lex.assertValidXrpcOutput(nsid, outputs[nsid])
    calls.push({ nsid, params, data })
    return { data: outputs[nsid] }
  }
  globalThis.__aitPeerFixture.appViewCall = pds.appViewCall
  const params = { actor: wireHandle, limit: 5 }
  await pds.appViewCall('ait.feed.getAuthorFeed', { params })
  assert.equal(calls.at(-1).params.actor, A)
  assert.equal(params.actor, wireHandle, 'caller params are not mutated')
  for (const actor of ['legacy', 'legacy.test']) {
    await pds.appViewCall('ait.actor.getProfile', { params: { actor } })
    assert.equal(calls.at(-1).params.actor, B, 'friendly and legacy inputs become DIDs before XRPC')
  }
  assert.equal((await resolveAppViewActorParams({ actor: B })).actor, B)
  for (const actor of ['luna', 'luna.test']) {
    await assert.rejects(() => pds.appViewCall('ait.actor.getProfile', { params: { actor } }), isAmbiguous)
  }
  for (const [file, handler, input] of [
    ['getProfile', 'getProfileHandler', { actor: wireHandle }],
    ['getAuthorFeed', 'getAuthorFeedHandler', { actor: wireHandle }],
    ['getTimeline', 'getTimelineHandler', {}],
    ['getPostThread', 'getPostThreadHandler', { post_uri: parentUri }],
    ['listNotifications', 'listNotificationsHandler', {}],
    ['searchActors', 'searchActorsHandler', { query: 'luna' }],
  ]) {
    const module = await import(`../src/tools/${file}.ts`)
    const result = await module[handler](input)
    assert.ok(result.content[0].text.includes('@luna'), `${file} displays friendly label`)
    assert.ok(!result.content[0].text.includes(machine), `${file} hides machine namespace`)
    if (['getAuthorFeed', 'getTimeline', 'getPostThread', 'listNotifications'].includes(file)) {
      assert.ok(result.content[0].text.includes(history), 'stored post text stays literal')
    }
  }
  assert.equal(JSON.stringify(outputs), originalOutputs, 'wire output objects stay unchanged')

  const terminal = await import('../src/aitty/agent.ts')
  assert.equal(await terminal.resolveHandleToDid(agent, wireHandle), A)
  await assert.rejects(() => terminal.resolveHandleToDid(agent, 'luna'), isAmbiguous)
  await terminal.fetchProfile(pdsAgent, wireHandle)
  assert.equal(calls.at(-1).params.actor, A)
  await terminal.fetchAuthorFeed(pdsAgent, wireHandle, 5)
  assert.equal(calls.at(-1).params.actor, A)
  await terminal.setActorRetired(pdsAgent, wireHandle, true)
  assert.equal(calls.at(-1).data.subject, A)
  await terminal.createWatcherAccount(agent, 'terminal-peer', 'fixture')
  assert.equal(accounts.at(-1).handle, `terminal-peer${domain}`)

  const { makeStyles, renderPost } = await import('../src/aitty/render.ts')
  const { normalizeHandle, actionProfile, actionNotifs } = await import('../src/aitty/commands.ts')
  const styles = makeStyles(false)
  assert.equal(normalizeHandle('luna'), 'luna', 'no new .test suffixes')
  assert.equal(normalizeHandle('did:web:CaseSensitive'), 'did:web:CaseSensitive')
  const rendered = renderPost({ post: view }, { styles, now: Date.now(), width: 200, isReply: true, parentHandle: wireHandle })
  assert.ok(rendered.includes('@luna') && rendered.includes('replying to @luna'))
  assert.ok(rendered.includes(history) && !rendered.includes(machine))
  assert.ok((await actionProfile(pdsAgent, wireHandle, styles, 200)).includes('@luna'))
  assert.ok((await actionNotifs(pdsAgent, styles)).includes('@luna'))

  const { MentionPrompt } = await import('../src/aitty/picker.ts')
  for (const withAt of [true, false]) {
    const picker = new MentionPrompt({
      styles, findToken: () => ({ start: 0, query: 'luna', withAt, retiredOnly: false }),
      search: async () => actors, onLine: () => {}, onClose: () => {},
    })
    picker.line = '@luna'
    picker.cursor = 5
    picker.results = actors
    picker.selected = 1
    picker.render = () => {}
    const rows = picker.dropdownRows(200).join('\n')
    assert.ok(rows.includes(actors[0].handle) && rows.includes(actors[1].handle), 'duplicate labels show canonical candidates')
    assert.ok(rows.includes(machine), 'ambiguous rows retain canonical identity detail')
    picker.accept()
    assert.equal(picker.line, (withAt ? `@${actors[1].handle}` : actors[1].handle) + ' ')
    assert.equal(actors[1].handle, `luna.${'b'.repeat(52)}.aitproto.com`)
  }
  console.log('PASS: real AtpAgent createAccount/login/resume -> logical PDS dispatch -> local GET/POST; body/auth/query/signal preserved; denied hosts never fetch; redirects blocked; private namespace; mentions/display/picker/actor boundaries; domain discovery; DID reauth')
} finally {
  globalThis.fetch = realFetch
  if (oldAppView === undefined) delete process.env.APPVIEW_URL
  else process.env.APPVIEW_URL = oldAppView
  hooks.deregister()
  delete globalThis.__aitPeerFixture
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
