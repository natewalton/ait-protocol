// Disposable protocol/command fixtures only. Never connects to an installed
// app-server, reads a real Codex home or acquires/deletes a thread writer lock.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { probeCodexWriters } from '../dist/codex/writerOwnership.js'
import { AppServerClient } from '../dist/codex/appServerClient.js'

const root = fs.realpathSync(fs.mkdtempSync('/tmp/aitw-'))
const bin = path.join(root, 'bin'), home = path.join(root, 'server home')
const stateFile = path.join(root, 'state.json'), logFile = path.join(root, 'calls.jsonl')
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const lock = value => path.join(home, 'thread-writer-locks', `${value.toLowerCase()}.lock`)
fs.mkdirSync(bin); fs.mkdirSync(path.dirname(lock(id)), { recursive: true })
fs.writeFileSync(lock(id), 'fixture contents must be preserved')
fs.writeFileSync(lock(other), '')
const before = fs.readFileSync(lock(id), 'utf8')
const oldPath = process.env.PATH
process.env.PATH = bin + path.delimiter + path.dirname(process.execPath)
const state = value => fs.writeFileSync(stateFile, JSON.stringify(value))
const calls = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : []
const info = { codexHome: home, pid: 101 }
function executable(name, source) {
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o700 })
}
executable('lsof', `
const fs=require('node:fs'),args=process.argv.slice(2);
const file=${JSON.stringify(stateFile)},s=JSON.parse(fs.readFileSync(file));
fs.appendFileSync(${JSON.stringify(logFile)},JSON.stringify({command:'lsof',args})+'\\n');
if(args.slice(0,5).join(' ')!=='-w -nP -F pnaf --') process.exit(3);
if(s.mode==='timeout') { setTimeout(()=>{},5000); }
else if(s.mode==='malformed') { console.log('f999'); }
else if(s.mode==='invalid-fd') { console.log('p202\\nf-1\\nn'+args[5]); }
else if(s.mode==='oversized-fd') { console.log('p202\\nf9007199254740992\\nn'+args[5]); }
else if(s.mode==='access-before-fd') { console.log('p202\\nau\\nf46\\nn'+args[5]); }
else if(s.mode==='missing-access') { console.log('p202\\nf46\\nn'+args[5]); }
else if(s.mode==='missing-file') { console.log('p202\\nf46\\nau'); }
else if(s.mode==='invalid-access') { console.log('p202\\nf46\\nax\\nn'+args[5]); }
else if(s.mode==='duplicate-access') { console.log('p202\\nf46\\nau\\naw\\nn'+args[5]); }
else if(s.mode==='permission') { console.error('permission denied');process.exit(1); }
else if(s.mode==='failure') process.exit(2);
else if(s.mode==='gone') { s.mode='empty';fs.writeFileSync(file,JSON.stringify(s));console.log('p202\\nf46\\nau\\nn'+args[5]); }
else if(s.mode==='disappear') {fs.unlinkSync(args[5]);console.error('status error: no such file');process.exit(1);}
else {
 let count=0;for(const p of args.slice(5)) {
  for(const pid of s.owners?.[p]||[]) {const a='a'+(s.accesses?.[pid]??s.access??'u');console.log('p'+pid+'\\nf46\\n'+(s.nameFirst?'n'+p+'\\n'+a:a+'\\nn'+p));count++;}
 }
 if(!count)process.exit(1);
}
`)
executable('ps', `
const fs=require('node:fs'),args=process.argv.slice(2),s=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));
fs.appendFileSync(${JSON.stringify(logFile)},JSON.stringify({command:'ps',args})+'\\n');
if(args.length!==4||args[0]!=='-p'||args[2]!=='-o'||args[3]!=='comm=')process.exit(3);
if(s.mode==='ps-failure'){console.error('permission denied');process.exit(1);}
if(s.mode==='ps-timeout')setTimeout(()=>{},5000);
else if(s.mode==='empty'||!s.commands?.[args[1]])process.exit(1);
else console.log(s.commands[args[1]]);
`)
const external = (pid = 202, command = '/Applications/ChatGPT.app/Contents/Resources/codex') => ({
  owners: { [lock(id)]: [pid] }, commands: { [pid]: command },
})

async function protocol(initialize, diagnostics, fn) {
  const socket = path.join(root, `s${Math.random().toString(16).slice(2, 8)}`)
  const http = createServer(), server = new WebSocketServer({ server: http }), methods = []
  server.on('connection', ws => ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    methods.push(message.method)
    if (message.id === undefined) return
    if (message.method === 'initialize') ws.send(JSON.stringify({ id: message.id, result: initialize }))
    else if (message.method === 'server/diagnostics') {
      if (diagnostics === 'disconnect') return ws.terminate()
      ws.send(JSON.stringify({ id: message.id, ...diagnostics }))
    } else ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unexpected fixture method' } }))
  }))
  http.listen(socket); await once(http, 'listening')
  const client = new AppServerClient(socket)
  try { await client.connect(); await fn(client, methods) }
  finally {
    client.close()
    for (const ws of server.clients) ws.terminate()
    await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => http.close(resolve))
  }
}

try {
  await test('absent metadata is unsupported, with no filesystem/command ownership claim', async () => {
    const n = calls().length
    assert.equal((await probeCodexWriters(null, [id])).size, 0)
    assert.equal(calls().length, n)
  })
  await test('absent ownership file and stale unheld file remain resumable without mutation', async () => {
    state({ mode: 'empty' })
    assert.equal((await probeCodexWriters(info, [id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])).size, 0)
    assert.equal(fs.readFileSync(lock(id), 'utf8'), before)
  })
  await test('external writer returns owner application, preserving original uppercase identifier', async () => {
    state(external())
    const result = await probeCodexWriters(info, [id.toUpperCase()])
    assert.deepEqual(result.get(id.toUpperCase()), { pid: 202, application: 'ChatGPT' })
  })
  await test('real macOS lsof p/f/a/n records preserve the external owner', async () => {
    state(external())
    assert.deepEqual((await probeCodexWriters(info, [id])).get(id), { pid: 202, application: 'ChatGPT' })
  })
  await test('read-only observers are not writers, even when a known Codex executable is inspecting', async () => {
    for (const command of ['/usr/bin/less', '/custom/bin/codex']) {
      state({ ...external(202, command), access: 'r' })
      const previous = calls().filter(c => c.command === 'ps').length
      assert.equal((await probeCodexWriters(info, [id])).size, 0)
      assert.equal(calls().filter(c => c.command === 'ps').length, previous)
    }
  })
  await test('write-capable unrelated processes are not falsely labelled as Codex owners', async () => {
    for (const command of ['/usr/bin/less', '/Applications/ChatGPT.app/Contents/MacOS/less', '/tmp/codex-fake']) {
      state(external(202, command))
      assert.equal((await probeCodexWriters(info, [id])).size, 0)
    }
  })
  await test('known Codex executables require write-capable descriptors and accept field ordering', async () => {
    state({ ...external(202, '/Applications/ChatGPT.app/Contents/MacOS/CodexCLI'), access: 'w', nameFirst: true })
    assert.equal((await probeCodexWriters(info, [id])).get(id).application, 'ChatGPT')
    state({ ...external(202, '/custom/codex.exe'), access: 'u' })
    assert.equal((await probeCodexWriters(info, [id])).get(id).application, 'a Codex process')
  })
  await test('an aliased server home resolves to the actual ownership file', async () => {
    const alias = path.join(root, 'aliased home'); fs.symlinkSync(home, alias)
    state(external())
    assert.equal((await probeCodexWriters({ ...info, codexHome: alias }, [id])).get(id).application, 'ChatGPT')
  })
  await test('the current shared app-server writer is reusable rather than treated as external', async () => {
    state(external(101))
    assert.equal((await probeCodexWriters(info, [id])).size, 0)
  })
  await test('Codex bundle and other local ownership labels never inspect command arguments', async () => {
    state(external(203, '/Applications/Codex.app/Contents/MacOS/codex'))
    assert.equal((await probeCodexWriters(info, [id])).get(id).application, 'Codex')
    state(external(204, '/custom/bin/codex'))
    assert.equal((await probeCodexWriters(info, [id])).get(id).application, 'a Codex process')
    assert(calls().filter(c => c.command === 'ps').every(c => c.args.at(-1) === 'comm='))
  })
  await test('same server and external owners are filtered independently in one batched query', async () => {
    state({ owners: { [lock(id)]: [101, 202], [lock(other)]: [101] }, commands: { 202: '/Applications/ChatGPT.app/Contents/Resources/codex' } })
    const result = await probeCodexWriters(info, [id, other])
    assert.equal(result.get(id).application, 'ChatGPT'); assert.equal(result.has(other), false)
  })
  await test('an owner that exits between lsof and ps recovers automatically', async () => {
    state({ mode: 'gone' })
    assert.equal((await probeCodexWriters(info, [id])).size, 0)
  })
  await test('a file removed by its fixture owner during the inspection is not recreated', async () => {
    const tmp = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    fs.writeFileSync(lock(tmp), '')
    state({ mode: 'disappear' })
    assert.equal((await probeCodexWriters(info, [tmp])).size, 0)
    assert.equal(fs.existsSync(lock(tmp)), false)
  })
  await test('command failure, permission denial and malformed output cannot mean unowned', async () => {
    for (const mode of ['failure', 'permission', 'malformed', 'invalid-fd', 'oversized-fd', 'access-before-fd', 'missing-access', 'missing-file', 'invalid-access', 'duplicate-access']) {
      state({ mode })
      await assert.rejects(probeCodexWriters(info, [id]), /could not check Codex writer ownership/)
    }
    state({ ...external(), mode: 'ps-failure' })
    await assert.rejects(probeCodexWriters(info, [id]), /process identity unavailable/)
  })
  await test('missing inspection commands cannot mean unowned', async () => {
    for (const name of ['lsof', 'ps']) {
      state(external())
      fs.renameSync(path.join(bin, name), path.join(bin, name + '.held'))
      try { await assert.rejects(probeCodexWriters(info, [id]), /could not check Codex writer ownership.*ENOENT/) }
      finally { fs.renameSync(path.join(bin, name + '.held'), path.join(bin, name)) }
    }
  })
  await test('inaccessible ownership files cannot mean unowned', async t => {
    if (process.getuid?.() === 0) { t.skip('root bypasses filesystem permissions'); return }
    const blocked = path.join(root, 'blocked-home'), directory = path.join(blocked, 'thread-writer-locks')
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, `${id}.lock`), '')
    fs.chmodSync(directory, 0)
    try { await assert.rejects(probeCodexWriters({ ...info, codexHome: blocked }, [id]), /ownership file inaccessible/) }
    finally { fs.chmodSync(directory, 0o700) }
  })
  await test('ownership command deadlines are bounded', async () => {
    state({ mode: 'timeout' })
    const start = Date.now()
    await assert.rejects(probeCodexWriters(info, [id]), /timed out/)
    assert(Date.now() - start < 4000)
    state({ ...external(), mode: 'ps-timeout' })
    await assert.rejects(probeCodexWriters(info, [id]), /timed out/)
  })
  await test('metadata, thread paths and file types are validated before inspecting processes', async () => {
    await assert.rejects(probeCodexWriters({ ...info, codexHome: 'relative' }, [id]), /invalid app-server identity/)
    await assert.rejects(probeCodexWriters({ ...info, pid: 0 }, [id]), /invalid app-server identity/)
    await assert.rejects(probeCodexWriters(info, ['../escape']), /invalid thread id/)
    const symlinkId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    fs.symlinkSync(lock(id), lock(symlinkId))
    await assert.rejects(probeCodexWriters(info, [symlinkId]), /unexpected ownership file type/)
  })
  await test('server initialize home and diagnostics PID define the ownership namespace', async () => {
    state(external())
    await protocol({ codexHome: home }, { result: { process: { id: 101 } } }, async client => {
      const remote = await client.localServerInfo()
      assert.deepEqual(remote, info)
      assert.equal((await probeCodexWriters(remote, [id])).get(id).application, 'ChatGPT')
    })
  })
  await test('older/malformed metadata and unsupported diagnostics remain explicitly unavailable', async () => {
    for (const initialize of [{}, { codexHome: 'relative' }, { codexHome: home + '\n' }]) {
      await protocol(initialize, { result: { process: { id: 101 } } }, async (client, methods) => {
        assert.equal(await client.localServerInfo(), null)
        assert.equal(methods.includes('server/diagnostics'), false)
      })
    }
    for (const response of [{ error: { code: -32601, message: 'not supported' } }, { result: {} }, { result: { process: { id: 0 } } }]) {
      await protocol({ codexHome: home }, response, async client => assert.equal(await client.localServerInfo(), null))
    }
  })
  await test('diagnostics transport failure and real RPC failure propagate', async () => {
    await protocol({ codexHome: home }, 'disconnect', async client => assert.rejects(client.localServerInfo(), /closed|disconnect|connection/i))
    await protocol({ codexHome: home }, { error: { code: -32603, message: 'internal failure' } }, async client => assert.rejects(client.localServerInfo(), /internal failure/))
  })
  await test('inspection does not change ownership files or issue state-changing RPCs', () => {
    assert.equal(fs.readFileSync(lock(id), 'utf8'), before)
    assert(calls().every(c => ['lsof', 'ps'].includes(c.command)))
  })
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
  fs.rmSync(root, { recursive: true, force: true })
}
