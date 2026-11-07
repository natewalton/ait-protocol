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
  agent.resumeSession = async () => ({ success: true })
  let logins = 0
  agent.login = async () => { logins++; return { success: true } }
  agent.call = respond

  assert.equal(displayHandle(canonical), 'braze-pm')
  assert.equal(displayHandle('old.test'), 'old')
  for (const handle of ['name.example.com', 'foo.example.test', 'foo.bar.' + machine + '.aitproto.com', 'name.' + 'a'.repeat(51) + '.aitproto.com']) assert.equal(displayHandle(handle), handle)
  assert.deepEqual(await resolveActor(agent, '@braze-pm'), actor)
  assert.deepEqual(calls.at(-1).params, { q: 'braze-pm.', limit: 2, retiredOnly: false })
  actors = [{ ...actor, handle: 'braze-pm-helper.test' }]
  await assert.rejects(resolveActor(agent, 'braze-pm'), UnknownActorError)
  actors = [{ ...actor, handle: 'braze-pm.example.com' }]
  await assert.rejects(resolveActor(agent, 'braze-pm'), UnknownActorError)
  actors = [actor, { did: 'did:plc:other', handle: 'braze-pm.test' }]
  await assert.rejects(resolveActor(agent, 'braze-pm'), /ambiguous/)
  actors = [actor]

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
    if (args[0] === 'ait.actor.searchActors' && first) {
      first = false
      throw Object.assign(new Error('expired'), { status: 400, error: 'ExpiredToken' })
    }
    return respond(...args)
  }
  await getProfileHandler({ actor: 'braze-pm' })
  assert.equal(logins, 1, 'bare lookup preserves authenticated retry')
  agent.call = respond

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
    directoryFailure = failure === 'network' ? new Error('network down') : null
    const before = writes.length
    await assert.rejects(postHandler({ text: '@braze-pm hi' }), failure === 'ambiguous' ? /ambiguous/ : /Could not look up/)
    await assert.rejects(replyHandler({ text: '@braze-pm hi', parent_uri: uri }))
    assert.equal(writes.length, before)
  }
  actors = [actor]; directoryFailure = null
  // Actual @atproto/pds 0.4.226 negative shape, shared with explicit actor inputs.
  resolverFailure = Object.assign(new Error('Unable to resolve handle'), { status: 400, error: 'InvalidRequest' })
  await assert.rejects(resolveActor(agent, 'unknown.test'), UnknownActorError)
  await postHandler({ text: 'Keep @unknown.test as text' })
  assert.equal(writes.at(-1).record.text, 'Keep @unknown.test as text')
  assert.equal(writes.at(-1).record.facets, undefined)
  resolverFailure = Object.assign(new Error('invalid syntax'), { status: 400, error: 'InvalidHandle' })
  await assert.rejects(resolveActor(agent, 'invalid.test'), UnknownActorError)
  resolverFailure = Object.assign(new Error('expired'), { status: 400, error: 'ExpiredToken' })
  await assert.rejects(resolveActor(agent, canonical), (error) => error === resolverFailure)
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

  const { actionFollow, actionUnfollow, actionRetire } = await import('../dist/aitty/commands.js')
  const identity = { did: ownDid, handle: 'watcher.test', password: 'fake', createdAt: new Date().toISOString(), follows: {} }
  await actionFollow(agent, identity, 'braze-pm')
  assert.deepEqual(Object.keys(identity.follows), [canonical])
  const saved = JSON.parse(readFileSync(join(root, 'ait-watcher/identity.json')))
  assert.deepEqual(Object.keys(saved.follows), [canonical])
  const before = writes.length
  await actionFollow(agent, identity, canonical)
  assert.equal(writes.length, before, 'existing canonical follow is reused')
  directoryFailure = new Error('retired actor absent / directory down')
  await actionUnfollow(agent, identity, 'braze-pm')
  assert.equal(Object.keys(identity.follows).length, 0)
  assert.equal(deleted.at(-1).rkey, '3kfixture')
  identity.follows[canonical] = { did, followUri: uri }
  await actionUnfollow(agent, identity, canonical)
  identity.follows[canonical] = { did, followUri: uri }
  identity.follows['braze-pm.test'] = { did: 'did:plc:other', followUri: uri }
  await assert.rejects(actionUnfollow(agent, identity, 'braze-pm'), /ambiguous/)
  directoryFailure = null
  await actionRetire(agent, 'braze-pm', false)
  assert.equal(calls.findLast((call) => call.nsid === 'ait.actor.searchActors').params.retiredOnly, true)
  assert.equal(calls.at(-1).data.subject, did)

  const { MentionPrompt } = await import('../dist/aitty/picker.js')
  const editor = Object.create(MentionPrompt.prototype)
  const plain = (value) => value
  editor.styles = { dim: plain, mention: plain }
  editor.results = [actor, { did: 'did:plc:other', handle: 'braze-pm.test', live: false }]
  editor.selected = 0; editor.open = true
  const rows = editor.dropdownRows(40)
  assert.ok(rows.every((row) => row.length < 40), 'collision details respect physical terminal rows')
  assert.ok(rows.join('').includes(canonical), 'canonical collision choice remains visible')
  editor.findToken = () => ({ withAt: true, start: 0 })
  editor.line = '@bra'; editor.cursor = 4
  editor.closePicker = () => {}; editor.render = () => {}
  editor.accept()
  assert.equal(editor.line, '@' + canonical + ' ')
  editor.results = [actor]; editor.line = '@bra'; editor.cursor = 4
  editor.accept()
  assert.equal(editor.line, '@braze-pm ')
  // Run the actual watch entry point with a fixture-only agent and terminal.
  const fixture = join(root, 'watch-agent.mjs')
  writeFileSync(fixture, `
import { AtpAgent } from ${JSON.stringify(new URL('../node_modules/@atproto/api/dist/index.js', import.meta.url).href)}
Object.defineProperty(process.stdin, 'isTTY', { value: true })
Object.defineProperty(process.stdout, 'isTTY', { value: true })
AtpAgent.prototype.login = async () => ({ success: true })
AtpAgent.prototype.call = async (nsid) => {
  if (nsid !== 'com.atproto.identity.resolveHandle') throw new Error('unexpected network action: ' + nsid)
  throw Object.assign(new Error('Unable to resolve handle'), { status: 400, error: 'InvalidRequest' })
}
`)
  const env = { ...process.env }
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'AIT_SESSION_ID', 'AI_AGENT']) delete env[key]
  const watched = spawnSync(process.execPath, ['--import', fixture, new URL('../dist/aitty/main.js', import.meta.url).pathname, 'watch', 'unknown.test'], { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(watched.status, 0, watched.stderr)
  assert.match(watched.stderr, /none of those handles resolved: unknown.test/)
  console.log('all friendly handle consumer checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
