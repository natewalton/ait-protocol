// Disposable real MCP + local XRPC fixture. No installed services/accounts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { createHash, createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const repo = fileURLToPath(new URL('../..', import.meta.url)), root = fs.mkdtempSync('/private/tmp/ait-claude-bg-test-')
const config = path.join(root, 'claude'), data = path.join(root, 'data'), store = path.join(data, 'ait-mcp'), project = path.join(root, 'project')
for (const dir of [store, project, path.join(config, 'projects', 'fixture')]) fs.mkdirSync(dir, { recursive: true })
const source = randomUUID(), child = randomUUID(), did = 'did:plc:' + 'a'.repeat(24), handle = 'fixture.test'
const transcript = id => path.join(config, 'projects', 'fixture', `${id}.jsonl`)
const identityFile = id => path.join(store, `identity-${createHash('sha256').update(id).digest('hex').slice(0,16)}.json`)
const jwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: did, scope: 'com.atproto.access', exp: Math.floor(Date.now()/1000)+86400 })).toString('base64url')}.fixture`
function seed(id) {
 const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(id+':ait-mcp:v2').digest(),nonce)
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify({password:'fixture-password',accessJwt:jwt,refreshJwt:jwt})),cipher.final()])
 fs.writeFileSync(identityFile(id),JSON.stringify({did,handle,createdAt:new Date().toISOString(),lastSeenNotificationCursor:'before',nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}))
 fs.writeFileSync(transcript(id),JSON.stringify({type:'user',sessionId:id,cwd:project})+'\n')
}
function state(id, extra={}) {
 const dir=path.join(config,'jobs',id.slice(0,8));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({sessionId:id,interactiveLineage:true,cwd:project,...extra}))
}
function continued(from,to) { fs.appendFileSync(transcript(from),JSON.stringify({type:'continued-in',sessionId:from,continuedInSessionId:to})+'\n') }
seed(source);state(child)
const calls=[], clients=[]
const pds=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture'), chunks=[];for await(const c of req)chunks.push(c)
 calls.push({path:url.pathname,actor:url.searchParams.get('actor'),data:chunks.length?JSON.parse(Buffer.concat(chunks)):null})
 let body
 switch(url.pathname){
  case '/xrpc/com.atproto.server.getSession':body={did,handle,email:'fixture@example.com',emailConfirmed:true,active:true};break
  case '/xrpc/com.atproto.server.refreshSession':case '/xrpc/com.atproto.server.createSession':body={did,handle,accessJwt:jwt,refreshJwt:jwt,active:true};break
  case '/xrpc/ait.feed.getAuthorFeed':body={feed:[]};break
  case '/xrpc/ait.notification.listNotifications':body={notifications:[{uri:`at://${did}/ait.feed.post/fixture`,cid:'bafyreigogaydx3b5gcfj7byynrzqtzl6slrhxta7jfhy4nkgfjhkpg2jve',author:{did,handle},reason:'mention',record:{text:'pending handoff'},isRead:false,indexedAt:new Date().toISOString(),cursor:'after'}]};break
  case '/xrpc/ait.notification.registerPushTarget':body={status:'ok',cursor:'before'};break
  default:res.writeHead(500);res.end(JSON.stringify({error:'UnexpectedFixtureCall',message:url.pathname}));return
 }
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body))
})
pds.listen(0,'127.0.0.1');await once(pds,'listening')
const endpoint=`http://127.0.0.1:${pds.address().port}`
function environment(id){
 const env={...process.env,HOME:path.join(root,'home'),CLAUDE_CONFIG_DIR:config,XDG_DATA_HOME:data,CLAUDE_CODE_SESSION_ID:id,AIT_NOTIFICATION_MODE:'push',PDS_URL:endpoint,APPVIEW_URL:endpoint}
 for(const k of ['AIT_MCP_TEST_SESSION_ID','AIT_SESSION_ID','CODEX_SESSION_ID','CLAUDECODE'])delete env[k]
 return env
}
async function connect(id,wrapper=false){
 const args=wrapper?[path.join(root,'wrapper.mjs'),'--dangerously-load-development-channels','server:ait-protocol','--resume',id]:[path.join(repo,'mcp/dist/server.js')]
 const transport=new StdioClientTransport({command:process.execPath,args,env:environment(id),cwd:project,stderr:'pipe'})
 let errors='';transport.stderr?.on('data',b=>errors+=b)
 const client=new Client({name:'claude-background-fixture',version:'1'}), notifications=[]
 client.fallbackNotificationHandler=async n=>{notifications.push(n)}
 await client.connect(transport);clients.push(client)
 return {client,transport,notifications,errors:()=>errors}
}
async function call(client,name,args={}){return client.callTool({name,arguments:args})}
function text(result){return result.content?.map(c=>c.text??'').join('\n')??''}
try{
 const first=await connect(child)
 let result=await call(first.client,'getAuthorFeed');assert.equal(result.isError,true);assert.match(text(result),/moving this session|continuation record/)
 result=await call(first.client,'join',{handle_hint:'must-not-mint'});assert.equal(result.isError,true);assert.equal(calls.length,0,'pending handover must not create an account or call PDS')
 continued(source,child)
 result=await call(first.client,'getAuthorFeed');assert(!result.isError,text(result));assert.match(text(result),/Automatic mentions are unavailable/)
 assert(calls.some(c=>c.actor===did),'real tool uses original DID')
 result=await call(first.client,'listNotifications');assert(!result.isError,text(result));assert.match(text(result),/pending handoff/)
 assert.equal(calls.filter(c=>c.path.endsWith('registerPushTarget')).length,0,'missing channel flag reuses poll mode')
 assert.equal(JSON.parse(fs.readFileSync(identityFile(source))).lastSeenNotificationCursor,'before')
 assert.equal(fs.existsSync(identityFile(child)),false,'never copy credentials to the continued runtime')
 await first.client.close()
 // The durable binding survives worker/MCP restart without rescanning a source.
 fs.renameSync(transcript(source),transcript(source)+'.saved')
 const second=await connect(child);result=await call(second.client,'getAuthorFeed');assert(!result.isError,text(result));await second.client.close()
 fs.renameSync(transcript(source)+'.saved',transcript(source))
 console.log('PASS late native metadata resolves in the same MCP; same DID/cursor, poll warning, durable respawn; no join or credential copy')
 const fork=randomUUID();state(fork,{forkSessionId:fork,forkParentSessionId:source,forkBoundaryAt:new Date().toISOString()})
 const independent=await connect(fork);result=await call(independent.client,'getAuthorFeed');assert.equal(result.isError,true);assert.match(text(result),/No actor|No identity/);await independent.client.close()
 assert(!fs.existsSync(path.join(store,`claude-thread-${fork}.json`)))
 console.log('PASS independent native fork cannot acquire the source identity')
 // Use the actual resolver against owned metadata. The second pending call
 // must do no transcript I/O; an appended record needs only the changed tail.
 const scanSource=randomUUID(),pending=randomUUID();seed(scanSource);state(pending)
 fs.truncateSync(transcript(scanSource),16*1024*1024)
 const probeCode=`
 import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 const original=fs.readSync;let bytes=0;fs.readSync=function(...args){const n=original.apply(this,args);bytes+=n;return n};syncBuiltinESMExports();
 const m=await import(${JSON.stringify(new URL('../dist/claudeSession.js',import.meta.url).href)});
 assert.throws(()=>m.resolveClaudeIdentity(${JSON.stringify(pending)}),m.ClaudeHandoverPending);const first=bytes;assert(first>=16*1024*1024);
 bytes=0;assert.throws(()=>m.resolveClaudeIdentity(${JSON.stringify(pending)}),m.ClaudeHandoverPending);assert.equal(bytes,0);
 fs.appendFileSync(${JSON.stringify(transcript(scanSource))},'\\n'+JSON.stringify({type:'continued-in',sessionId:${JSON.stringify(scanSource)},continuedInSessionId:${JSON.stringify(pending)}})+'\\n');
 assert.equal(m.resolveClaudeIdentity(${JSON.stringify(pending)}),${JSON.stringify(scanSource)});assert(bytes<200000);
 console.log(JSON.stringify({firstBytes:first,unchangedRetryBytes:0,changedRetryBytes:bytes}));`
 const probe=spawnSync(process.execPath,['--input-type=module','-e',probeCode],{env:environment(pending),cwd:project,encoding:'utf8'})
 assert.equal(probe.status,0,probe.stderr+probe.stdout);console.log('PASS bounded metadata scan '+probe.stdout.trim())
 const conflicting=randomUUID(),otherSource=randomUUID();state(conflicting);seed(otherSource)
 continued(source,conflicting);continued(otherSource,conflicting)
 const conflict=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';const m=await import(${JSON.stringify(new URL('../dist/claudeSession.js',import.meta.url).href)});assert.throws(()=>m.resolveClaudeIdentity(${JSON.stringify(conflicting)}),/Conflicting/);`],{env:environment(conflicting),cwd:project,encoding:'utf8'});assert.equal(conflict.status,0,conflict.stderr)
 const escaped=randomUUID(),escapedSource=randomUUID();state(escaped);seed(escapedSource)
 const outside=path.join(root,'outside.jsonl');fs.renameSync(transcript(escapedSource),outside)
 fs.appendFileSync(outside,JSON.stringify({type:'continued-in',sessionId:escapedSource,continuedInSessionId:escaped})+'\n')
 fs.symlinkSync(outside,transcript(escapedSource))
 const escape=await connect(escaped);result=await call(escape.client,'getAuthorFeed');assert.equal(result.isError,true);assert.match(text(result),/continuation record/);await escape.client.close()
 console.log('PASS conflicting sources and transcript symlinks grant no identity')
 const mismatched=randomUUID(),mismatchSource=randomUUID();state(mismatched);seed(mismatchSource)
 fs.appendFileSync(transcript(mismatchSource),JSON.stringify({type:'continued-in',sessionId:randomUUID(),continuedInSessionId:mismatched})+'\n')
 const mismatch=await connect(mismatched);result=await call(mismatch.client,'getAuthorFeed');assert.equal(result.isError,true);assert.match(text(result),/continuation record/);await mismatch.client.close()
 const resolverUrl=new URL('../dist/claudeSession.js',import.meta.url).href
 function resolveProbe(id,code,extra={}) {
   const checked=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import fs from 'node:fs';const m=await import(${JSON.stringify(resolverUrl)});${code}`],{env:{...environment(id),...extra},cwd:project,encoding:'utf8'})
   assert.equal(checked.status,0,checked.stderr+checked.stdout)
 }
 const middle=randomUUID(),latest=randomUUID(),chainSource=randomUUID();seed(chainSource);state(latest)
 fs.writeFileSync(transcript(middle),JSON.stringify({sessionId:middle,cwd:project})+'\n')
 continued(chainSource,middle);continued(middle,latest)
 resolveProbe(latest,`assert.equal(m.resolveClaudeIdentity(${JSON.stringify(latest)}),${JSON.stringify(chainSource)});`)
 const foreignProject=randomUUID(),foreignSource=randomUUID();state(foreignProject);seed(foreignSource)
 fs.writeFileSync(transcript(foreignSource),JSON.stringify({sessionId:foreignSource,cwd:root})+'\n');continued(foreignSource,foreignProject)
 resolveProbe(foreignProject,`assert.throws(()=>m.resolveClaudeIdentity(${JSON.stringify(foreignProject)}),m.ClaudeHandoverPending);`)
 const wrongName=randomUUID(),jobSource=randomUUID();state(wrongName);seed(jobSource)
 fs.unlinkSync(transcript(jobSource));state(jobSource)
 fs.writeFileSync(path.join(config,'jobs',jobSource.slice(0,8),`${randomUUID()}.jsonl`),JSON.stringify({type:'continued-in',sessionId:jobSource,continuedInSessionId:wrongName})+'\n')
 resolveProbe(wrongName,`assert.throws(()=>m.resolveClaudeIdentity(${JSON.stringify(wrongName)}),m.ClaudeHandoverPending);`)
 const mixed=randomUUID(),mixedSource=randomUUID();state(mixed);seed(mixedSource)
 fs.appendFileSync(transcript(mixedSource),JSON.stringify({type:'continued-in',sessionId:mixedSource.toUpperCase(),continuedInSessionId:mixed.toUpperCase()})+'\n')
 resolveProbe(mixed,`assert.equal(m.resolveClaudeIdentity(${JSON.stringify(mixed)}),${JSON.stringify(mixedSource)});`)
 const bindingPath=path.join(store,`claude-thread-${mixed}.json`), savedBinding=JSON.parse(fs.readFileSync(bindingPath))
 fs.writeFileSync(bindingPath,JSON.stringify({...savedBinding,identity:mixedSource.toUpperCase()}))
 resolveProbe(mixed,`assert.equal(m.resolveClaudeIdentity(${JSON.stringify(mixed)}),${JSON.stringify(mixedSource)});`)
 const foreignConfig=path.join(root,'other-config');fs.mkdirSync(foreignConfig)
 resolveProbe(mixed,`assert.equal(m.readClaudeBinding(${JSON.stringify(mixed)}),null);assert.equal(m.claudeContinuedSessions().length,0);`,{CLAUDE_CONFIG_DIR:foreignConfig})
 seed(mixed)
 resolveProbe(mixed,`assert.throws(()=>m.resolveClaudeIdentity(${JSON.stringify(mixed)}),/conflicts with an already joined account/);`)
 fs.unlinkSync(identityFile(mixed))
 const cyclicA=randomUUID(),cyclicB=randomUUID()
 for(const [runtime,identity] of [[cyclicA,cyclicB],[cyclicB,cyclicA]])fs.writeFileSync(path.join(store,`claude-thread-${runtime}.json`),JSON.stringify({runtime,identity,source:identity,config,project}))
 resolveProbe(cyclicA,`assert.throws(()=>m.claudeIdentityUuid(${JSON.stringify(cyclicA)}),/cycle/);`)
 for(const id of [cyclicA,cyclicB])fs.unlinkSync(path.join(store,`claude-thread-${id}.json`))
 // Source-only --resume on a fork never substitutes for the worker's own UUID.
 const missing=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.execFileSync=()=>${JSON.stringify('--fork-session --resume '+source)};syncBuiltinESMExports();const m=await import(${JSON.stringify(resolverUrl)});assert.equal(m.claudeRuntimeUuid(),null);`],{env:{...environment('not-a-uuid')},cwd:project,encoding:'utf8'})
 assert.equal(missing.status,0,missing.stderr)
 console.log('PASS configuration/project scope, job filenames, UUID canonicalization, conflicts/cycles, source-only forks and unresolved intermediate continuations')


 // Exercise the real push server through its existing registration and sink.
 const old=randomUUID(),next=randomUUID();seed(old)
 fs.writeFileSync(path.join(root,'wrapper.mjs'),`import {spawn} from 'node:child_process';const c=spawn(process.execPath,[${JSON.stringify(path.join(repo,'mcp/dist/server.js'))}],{stdio:'inherit',env:process.env});process.once('SIGTERM',()=>c.kill('SIGTERM'));c.on('exit',code=>process.exit(code??0));`)
 const beforeCalls=calls.length, original=await connect(old,true)
 const deadline=Date.now()+5000
 while(!calls.slice(beforeCalls).some(c=>c.path.endsWith('registerPushTarget'))){assert(Date.now()<deadline,original.errors());await new Promise(r=>setTimeout(r,10))}
 const registered=calls.slice(beforeCalls).find(c=>c.path.endsWith('registerPushTarget')).data.url
 continued(old,next)
 const notify={uri:`at://${did}/ait.feed.post/new`,cid:'bafyreigogaydx3b5gcfj7byynrzqtzl6slrhxta7jfhy4nkgfjhkpg2jve',author:{did,handle},reason:'mention',record:{text:'after handover'},indexedAt:new Date().toISOString(),cursor:'must-not-commit'}
 const refused=await fetch(registered,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(notify)});assert.equal(refused.status,500)
 assert.equal(original.notifications.length,0,'retired sink must not emit a channel event')
 assert.equal(JSON.parse(fs.readFileSync(identityFile(old))).lastSeenNotificationCursor,'before','retired sink never commits old cursor')
 await new Promise(r=>setTimeout(r,30500))
 assert.equal(calls.slice(beforeCalls).filter(c=>c.path.endsWith('registerPushTarget')).length,1,'retained parent never steals the callback back')
 await assert.rejects(fetch(registered,{method:'POST',body:JSON.stringify(notify)}),'existing heartbeat closes retired listener')
 await original.client.close()
 console.log('PASS old real MCP refuses delivery/cursor writes, stops renewal and closes its own listener on the existing heartbeat')
 // A foreground worker with channel activation replays from the same durable
 // checkpoint after the old callback retired.
 state(next)
 const restored=await connect(next,true), replayCalls=calls.length
 const readyBy=Date.now()+5000
 while(!calls.slice(replayCalls).some(c=>c.path.endsWith('registerPushTarget'))){assert(Date.now()<readyBy,restored.errors());await new Promise(r=>setTimeout(r,10))}
 const replay=calls.slice(replayCalls).find(c=>c.path.endsWith('registerPushTarget')).data
 assert.equal(replay.cursor,'before','new runtime registers from the original checkpoint')
 const delivered=await fetch(replay.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...notify,cursor:'replayed'})})
 assert.equal(delivered.status,200)
 assert.equal(JSON.parse(fs.readFileSync(identityFile(old))).lastSeenNotificationCursor,'replayed')
 assert(!fs.existsSync(identityFile(next)))
 await restored.client.close()
 console.log('PASS supported foreground channel replays and commits under the original identity')

 console.log('PASS Claude background consumer journey')
}finally{
 for(const client of clients)await client.close().catch(()=>{})
 pds.closeAllConnections();await new Promise(resolve=>pds.close(resolve));fs.rmSync(root,{recursive:true,force:true})
}
