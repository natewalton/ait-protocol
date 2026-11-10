// Isolated naming journeys through real MCP/aitty consumers, with fake agents.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'ait-handles-'))
process.env.XDG_DATA_HOME = root
process.env.AIT_MCP_TEST_SESSION_ID = randomUUID()
delete process.env.CLAUDE_PROJECT_DIR
process.env.APPVIEW_URL = 'http://127.0.0.1:1'
const originalFetch = globalThis.fetch
try {
  const { displayHandle, resolveActor, UnknownActorError } = await import('../dist/handles.js')
  const machine = 'iq3l5t4vuaat4l2zbzjrkoryccobcfi4s5pujtcmtsqen6vf6jea'
  assert.match(machine, /^[a-z2-7]{52}$/)
  const canonical = `braze-pm.${machine}.aitproto.com`
  const did = 'did:plc:abcdefghijklmnopqrstuvwx'
  const ownDid = 'did:plc:zyxwvutsrqponmlkjihgfedc'
  const actor = { did, handle: canonical, live: false }
  let actors = [actor]
  let directoryFailure = null
  let resolverFailure = null
  let active = 0
  let peak = 0
  const calls = []
  const writes = []
  const deleted = []
  const profile = { ...actor, postsCount: 0, followersCount: 0, followsCount: 0 }
  const uri = `at://${ownDid}/ait.feed.post/3kfixture`
  const cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const respond = async (nsid, params, data) => {
    calls.push({ nsid, params, data })
    if (nsid === 'ait.actor.searchActors') {
      if (directoryFailure) throw directoryFailure
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active--
      return { data: { actors: actors.filter((entry) => entry.handle.startsWith(params.q)).slice(0, params.limit ?? 100) } }
    }
    if (nsid === 'com.atproto.identity.resolveHandle') {
      if (resolverFailure) throw resolverFailure
      return { data: { did } }
    }
    if (nsid === 'ait.actor.getProfile') return { data: profile }
    if (nsid === 'ait.feed.getAuthorFeed') return { data: { feed: [] } }
    if (nsid === 'com.atproto.repo.createRecord') { writes.push(data); return { data: { uri, cid } } }
    if (nsid === 'com.atproto.repo.deleteRecord') { deleted.push(data); return { data: {} } }
    if (nsid === 'com.atproto.repo.getRecord') return { data: { uri, cid, value: { text: 'parent' } } }
    if (nsid === 'ait.actor.setRetired') return { data: {} }
    throw new Error(`unexpected endpoint ${nsid}`)
  }
  const { setIdentity } = await import('../dist/session.js')
  setIdentity({ did: ownDid, handle: 'self.test', password: 'fake', accessJwt: 'fake', refreshJwt: 'fake' })
  const { getRawAgent } = await import('../dist/atproto/pdsClient.js')
  const agent = getRawAgent()
  Object.defineProperty(agent, 'session', { value: { did: ownDid, handle: 'self.test', accessJwt: 'fake', refreshJwt: 'fake' }, configurable: true })
  agent.resumeSession = async () => ({ success: true })
  let logins = 0
  agent.login = async () => { logins++; return { success: true } }
  agent.call = respond
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    assert.equal(url.origin, process.env.APPVIEW_URL, 'all names stay on the local projection')
    assert.equal(url.pathname, '/xrpc/com.atproto.identity.resolveHandle')
    const handle = url.searchParams.get('handle')
    calls.push({ nsid: 'com.atproto.identity.resolveHandle', params: { handle } })
    active++; peak = Math.max(peak, active)
    await new Promise((resolve) => setImmediate(resolve))
    active--
    if (resolverFailure) return Response.json({ error: resolverFailure.error, message: resolverFailure.message }, { status: resolverFailure.status })
    const short = /^([a-z0-9-]+)\.(?:test|aitproto\.com)$/.exec(handle)
    const matches = actors.filter(entry => short ? displayHandle(entry.handle) === short[1] : entry.handle === handle)
    if (matches.length > 1) return Response.json({ error: 'AmbiguousHandle', message: 'ambiguous: ' + matches.map(entry => entry.did).join(', ') }, { status: 400 })
    if (!matches.length) return Response.json({ error: 'HandleNotFound' }, { status: 400 })
    return Response.json({ did: matches[0].did })
  }

  assert.equal(displayHandle(canonical), 'braze-pm')
  assert.equal(displayHandle('old.test'), 'old')
  for (const handle of ['name.example.com', 'foo.example.test', 'foo.bar.' + machine + '.aitproto.com', 'name.' + 'a'.repeat(51) + '.aitproto.com']) assert.equal(displayHandle(handle), handle)
  assert.deepEqual(await resolveActor(agent, '@braze-pm'), { did, handle: did })
  assert.deepEqual(calls.at(-1).params, { handle: 'braze-pm.aitproto.com' })
  actors = [{ ...actor, handle: 'braze-pm-helper.test' }]
  await assert.rejects(resolveActor(agent, 'braze-pm'), UnknownActorError)
  actors = [{ ...actor, handle: 'braze-pm.example.com' }]
  await assert.rejects(resolveActor(agent, 'braze-pm'), UnknownActorError)
  actors = [actor, { did: 'did:plc:other', handle: 'braze-pm.test' }]
  await assert.rejects(resolveActor(agent, 'braze-pm'), /ambiguous/)
  actors = [actor]
  for (const hidden of ['retired', 'inactive', 'unlinked']) {
    const before = writes.length
    resolverFailure = Object.assign(new Error(`ambiguous ${hidden} namesake`), {status:400,error:'AmbiguousHandle'})
    directoryFailure = null
    await assert.rejects(resolveActor(agent, 'braze-pm'), /ambiguous/)
    assert.equal(writes.length, before)
  }
  resolverFailure = null

  const { followHandler } = await import('../dist/tools/follow.js')
  const { getProfileHandler } = await import('../dist/tools/getProfile.js')
  const { getAuthorFeedHandler } = await import('../dist/tools/getAuthorFeed.js')
  await followHandler({ target: '@braze-pm' })
  assert.equal(writes.at(-1).record.subject, did)
  assert.match((await getProfileHandler({ actor: '@braze-pm' })).content[0].text, /^@braze-pm\n/)
  await getAuthorFeedHandler({ actor: 'braze-pm' })
  assert.equal(calls.findLast((call) => call.nsid === 'ait.feed.getAuthorFeed').params.actor, did)
  await getProfileHandler({ actor: canonical })
  await getProfileHandler({ actor: did })
  const { searchActorsHandler } = await import('../dist/tools/searchActors.js')
  assert.match((await searchActorsHandler({ query: '@braze-pm' })).content[0].text, /^- @braze-pm /)
  let first = true
  agent.call = async (...args) => {
    if (args[0] === 'ait.actor.getProfile' && first) {
      first = false
      throw Object.assign(new Error('expired'), { status: 400, error: 'ExpiredToken' })
    }
    return respond(...args)
  }
  await getProfileHandler({ actor: 'braze-pm' })
  assert.equal(logins, 1, 'authenticated profile retry survives independent name resolution')
  agent.call = respond

  delete profile.live
  delete actor.live
  assert.match((await getProfileHandler({ actor: did })).content[0].text, /session: presence unknown/)
  assert.equal(calls.findLast(call => call.nsid === 'ait.actor.getProfile').params.includePresence, true)
  assert.match((await searchActorsHandler({ query: '@braze-pm' })).content[0].text, /presence unknown/)
  actor.live = false; profile.live = false

  const { postHandler } = await import('../dist/tools/post.js')
  const { replyHandler } = await import('../dist/tools/reply.js')
  const text = `🦊 Hello @braze-pm, @${canonical}! @braze-pm.test. Missing @unknown; mail x@braze-pm.test é@braze-pm.test https://x/@braze-pm @types/node @braze-pm.test/package \`@braze-pm\`\n\`\`\`\n@braze-pm\n\`\`\``
  for (const run of [() => postHandler({ text }), () => replyHandler({ text, parent_uri: uri })]) {
    await run()
    const record = writes.at(-1).record
    assert.equal(record.text, text)
    assert.equal(record.facets.length, 3)
    const mentioned = record.facets.map((facet) => {
      assert.equal(facet.features[0].did, did)
      return Buffer.from(text).subarray(facet.index.byteStart, facet.index.byteEnd).toString()
    })
    assert.deepEqual(mentioned, ['@braze-pm', '@' + canonical, '@braze-pm.test'])
  }
  for (const failure of ['ambiguous', 'network']) {
    actors = failure === 'ambiguous' ? [actor, { did: 'did:plc:other', handle: 'braze-pm.test' }] : [actor]
    resolverFailure = failure === 'network' ? Object.assign(new Error('projection unavailable'), {status:503,error:'ProjectionUnavailable'}) : null
    const before = writes.length
    await assert.rejects(postHandler({ text: '@braze-pm hi' }), failure === 'ambiguous' ? /ambiguous/ : /projection unavailable/)
    await assert.rejects(replyHandler({ text: '@braze-pm hi', parent_uri: uri }))
    assert.equal(writes.length, before)
  }
  actors = [actor]; directoryFailure = null; resolverFailure = null
  // Private full handles use the local projection's explicit negative shape.
  resolverFailure = Object.assign(new Error('Unable to resolve handle'), { status: 404, error: 'HandleNotFound' })
  await assert.rejects(resolveActor(agent, 'unknown.test'), UnknownActorError)
  await postHandler({ text: 'Keep @unknown.test as text' })
  assert.equal(writes.at(-1).record.text, 'Keep @unknown.test as text')
  assert.equal(writes.at(-1).record.facets, undefined)
  resolverFailure = Object.assign(new Error('invalid syntax'), { status: 400, error: 'HandleNotFound' })
  await assert.rejects(resolveActor(agent, 'invalid.test'), UnknownActorError)
  resolverFailure = Object.assign(new Error('expired'), { status: 400, error: 'ExpiredToken' })
  await assert.rejects(resolveActor(agent, canonical), (error) => error.status === resolverFailure.status && error.error === resolverFailure.error)
  resolverFailure = Object.assign(new Error('upstream unavailable'), { status: 503, error: 'UpstreamFailure' })
  const beforeFailure = writes.length
  await assert.rejects(postHandler({ text: '@braze-pm.test' }), /upstream unavailable/)
  await assert.rejects(replyHandler({ text: '@braze-pm.test', parent_uri: uri }), /upstream unavailable/)
  assert.equal(writes.length, beforeFailure)
  const beforeProse = calls.length
  await postHandler({ text: 'Email us at @support.example or install @types/node.' })
  assert.equal(calls.slice(beforeProse).filter((call) => /resolveHandle|searchActors/.test(call.nsid)).length, 0)
  resolverFailure = null
  await postHandler({ text: 'Stray `\nNotify @braze-pm\n```js\n@braze-pm.test\n' })
  assert.equal(writes.at(-1).record.facets.length, 1, 'unclosed fence hides code; stray backtick does not hide next line')
  actors = [actor, { did: 'did:plc:another', handle: 'another.test' }]
  peak = 0
  await postHandler({ text: '@braze-pm @another @braze-pm' })
  assert.equal(peak, 1, 'unique directory lookups are serialized')
  actors = [actor]

  const { actionFollow, actionUnfollow, actionRetire, actionProfile } = await import('../dist/aitty/commands.js')
  delete profile.live
  assert.match(await actionProfile(agent, did, { dim: value => value, handle: value => value }, 100), /session: presence unknown/)
  assert.equal(calls.findLast(call => call.nsid === 'ait.actor.getProfile').params.includePresence, true)
  const { fetchHandleForDid } = await import('../dist/aitty/agent.js')
  await fetchHandleForDid(agent, did)
  assert.equal(calls.findLast(call => call.nsid === 'ait.actor.getProfile').params.includePresence, undefined)
  profile.live = false
  const identity = { did: ownDid, handle: 'watcher.test', password: 'fake', createdAt: new Date().toISOString(), follows: {} }
  await actionFollow(agent, identity, 'braze-pm')
  assert.deepEqual(Object.keys(identity.follows), [did])
  const saved = JSON.parse(readFileSync(join(root, 'ait-watcher/identity.json')))
  assert.deepEqual(Object.keys(saved.follows), [did])
  const before = writes.length
  await actionFollow(agent, identity, canonical)
  assert.equal(writes.length, before, 'existing canonical follow is reused')
  resolverFailure = Object.assign(new Error('projection unavailable'), {status:503,error:'ProjectionUnavailable'})
  await assert.rejects(actionUnfollow(agent, identity, 'braze-pm'), /projection unavailable/)
  await actionUnfollow(agent, identity, did)
  assert.equal(Object.keys(identity.follows).length, 0)
  assert.equal(deleted.at(-1).rkey, '3kfixture')
  identity.follows[canonical] = { did, followUri: uri }
  await actionUnfollow(agent, identity, canonical)
  identity.follows[canonical] = { did, followUri: uri }
  identity.follows['braze-pm.test'] = { did: 'did:plc:other', followUri: uri }
  resolverFailure = Object.assign(new Error('ambiguous hidden account'), {status:400,error:'AmbiguousHandle'})
  await assert.rejects(actionUnfollow(agent, identity, 'braze-pm.test'), /ambiguous/)
  await assert.rejects(actionUnfollow(agent, identity, 'braze-pm'), /ambiguous/)
  resolverFailure = null; directoryFailure = null
  await actionRetire(agent, 'braze-pm', false)
  assert.equal(calls.at(-1).data.subject, did)
  for (const hidden of ['retired', 'inactive', 'unlinked']) {
    // Directory suggestions could show only this actor; the authoritative
    // resolver still knows the hidden namesake. Neither operator scope may act.
    actors = [actor]
    resolverFailure = Object.assign(new Error(`ambiguous ${hidden} namesake`), {status:400,error:'AmbiguousHandle'})
    const beforeWrites = writes.length
    const beforeRetirements = calls.filter(call => call.nsid === 'ait.actor.setRetired').length
    await assert.rejects(actionRetire(agent, 'braze-pm', true), /ambiguous/)
    await assert.rejects(actionRetire(agent, 'braze-pm', false), /ambiguous/)
    await assert.rejects(actionFollow(agent, identity, 'braze-pm'), /ambiguous/)
    assert.equal(writes.length, beforeWrites)
    assert.equal(calls.filter(call => call.nsid === 'ait.actor.setRetired').length, beforeRetirements)
  }
  resolverFailure = null

  const { MentionPrompt } = await import('../dist/aitty/picker.js')
  const editor = Object.create(MentionPrompt.prototype)
  const plain = (value) => value
  editor.styles = { dim: plain, mention: plain }
  editor.results = [actor, { did: 'did:plc:other', handle: 'braze-pm.test', live: false }]
  editor.selected = 0; editor.open = true
  const rows = editor.dropdownRows(40)
  assert.ok(rows.every((row) => row.length < 40), 'collision details respect physical terminal rows')
  assert.ok(rows.join('').includes(canonical), 'canonical collision choice remains visible')
  const { findCompletionToken } = await import('../dist/aitty/interactive.js')
  editor.findToken = findCompletionToken
  editor.closePicker = () => {}; editor.render = () => {}
  // The real token finder must preserve the selected DID for both an @-prefixed
  // command argument and a mention. A filtered one-result picker behaves alike.
  for (const [input, expected] of [
    ['follow bra', `follow ${did} `], ['follow @bra', `follow ${did} `],
    ['retire @bra', `retire ${did} `], ['unretire @bra', `unretire ${did} `],
    ['post @bra', `post @{${did}} `], ['reply 1 @bra', `reply 1 @{${did}} `],
  ]) {
    editor.results = [actor]
    editor.line = input; editor.cursor = input.length; editor.selected = 0
    editor.accept()
    assert.equal(editor.line, expected)
    if (input.startsWith('post ') || input.startsWith('reply ')) {
      const { buildMentionFacets } = await import('../dist/atproto/mentions.js')
      const facets = await buildMentionFacets(agent, editor.line)
      assert.equal(facets[0].features[0].did, did)
    } else {
      assert.equal((await resolveActor(agent, editor.line.trim().split(/\s+/)[1])).did, did)
    }
  }
  delete actor.live
  editor.results = [actor]
  assert.match(editor.dropdownRows(100).join(''), /presence unknown/)
  actor.live = false
  // Run the actual watch entry point with a fixture-only agent and terminal.
  const fixture = join(root, 'watch-agent.mjs')
  writeFileSync(fixture, `
import { AtpAgent } from ${JSON.stringify(new URL('../node_modules/@atproto/api/dist/index.js', import.meta.url).href)}
import { appendFileSync } from 'node:fs'
Object.defineProperty(process.stdin, 'isTTY', { value: true })
Object.defineProperty(process.stdout, 'isTTY', { value: true })
AtpAgent.prototype.login = async function () { Object.defineProperty(this, 'session', { value: { did: ${JSON.stringify(ownDid)}, handle: 'watcher.test' } }); return { success: true } }
AtpAgent.prototype.call = async function(nsid) {
  appendFileSync(process.env.AIT_WATCH_FIXTURE_RECEIPT, nsid + '\\n')
  if (nsid === 'com.atproto.repo.createRecord') return {data:{uri:'at://${ownDid}/ait.graph.follow/fixture'}}
  if (nsid === 'ait.feed.getTimeline') return {data:{feed:[]}}
  throw new Error('Unexpected fixture endpoint ' + nsid)
}
globalThis.fetch = async input => {
  const handle = new URL(input instanceof Request ? input.url : input).searchParams.get('handle')
  if (handle === 'valid.aitproto.com') return Response.json({did:${JSON.stringify(did)}})
  if (handle === 'ambiguous.test' || handle === 'ambiguous.aitproto.com') return Response.json({error:'AmbiguousHandle',message:'ambiguous hidden actor'}, {status:400})
  return Response.json({error:'HandleNotFound',message:'unknown'}, {status:404})
}
`)
  const receipt = join(root, 'watch-calls.txt')
  const env = { ...process.env, AIT_WATCH_FIXTURE_RECEIPT: receipt }
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'AIT_SESSION_ID', 'AI_AGENT']) delete env[key]
  const watched = spawnSync(process.execPath, ['--import', fixture, new URL('../dist/aitty/main.js', import.meta.url).pathname, 'watch', 'unknown.test'], { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(watched.status, 0, watched.stderr)
  assert.match(watched.stderr, /none of those handles resolved: unknown.test/)
  // A legacy cached alias cannot override ambiguity, and a later ambiguity
  // cannot leave an earlier new follow behind. This runs the real watch main.
  const storedWatcher = { did: ownDid, handle: 'watcher.test', password: 'fixture', createdAt: new Date().toISOString(),
    follows: {'ambiguous.test': {did,followUri:uri}} }
  for (const requested of [['ambiguous.test'], ['valid', 'ambiguous.test']]) {
    writeFileSync(join(root, 'ait-watcher/identity.json'), JSON.stringify(storedWatcher))
    writeFileSync(receipt, '')
    const result = spawnSync(process.execPath, ['--import', fixture, new URL('../dist/aitty/main.js', import.meta.url).pathname, 'watch', ...requested], { env, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /AmbiguousHandle/)
    assert.doesNotMatch(result.stderr, /watching [0-9]/)
    assert.equal(readFileSync(receipt, 'utf8'), '', 'ambiguity precedes all follows and polling')
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'ait-watcher/identity.json'))).follows, storedWatcher.follows)
  }
  console.log('all friendly handle consumer checks passed')
} finally {
  globalThis.fetch = originalFetch
  rmSync(root, { recursive: true, force: true })
}
