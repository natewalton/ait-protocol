#!/usr/bin/env node
// Owned real MCPs -> actual AppView registry -> SQLite backlog -> channel/cursor.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID, randomBytes, createCipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb } from '../../appview/dist/db.js'
import * as registry from '../../appview/dist/pushRegistry.js'
import * as delivery from '../dist/claudeDelivery.js'
import { encodeSeqCursor, decodeSeqCursor } from '../../appview/dist/queries/cursor.js'
const did='did:plc:'+'a'.repeat(24), author='did:plc:'+'b'.repeat(24)
const zero=encodeSeqCursor(0), oldBirth='Sat Jan  1 00:00:00 2000', newerBirth='Mon Jan  1 00:00:00 2001'
const repo=fileURLToPath(new URL('../..',import.meta.url))
async function until(check,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(10)}assert.fail(label)}
async function fixture(t){
 registry._clear()
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ait-claude-owner-')), config=path.join(root,'config'), data=path.join(root,'data'), store=path.join(data,'ait-mcp'), project=path.join(root,'project')
 for(const dir of [store,project,path.join(config,'projects','fixture')])fs.mkdirSync(dir,{recursive:true})
 const claimDir=path.join(store,'claude-delivery-'+createHash('sha256').update(did).digest('hex'))
 const identity=id=>path.join(store,'identity-'+createHash('sha256').update(id).digest('hex').slice(0,16)+'.json')
 const transcript=id=>path.join(config,'projects','fixture',id+'.jsonl')
 function seed(id){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(id+':ait-mcp:v2').digest(),nonce)
  const jwt='e30.'+Buffer.from(JSON.stringify({sub:did,scope:'com.atproto.access',exp:Math.floor(Date.now()/1000)+86400})).toString('base64url')+'.fixture'
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify({password:'fixture',accessJwt:jwt,refreshJwt:jwt})),cipher.final()])
  fs.writeFileSync(identity(id),JSON.stringify({did,handle:'owner.test',createdAt:new Date().toISOString(),lastSeenNotificationCursor:zero,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}))
  fs.writeFileSync(transcript(id),JSON.stringify({type:'user',sessionId:id})+'\n')
 }
 function continueTo(from,to){
  fs.appendFileSync(transcript(from),JSON.stringify({type:'continued-in',sessionId:from,continuedInSessionId:to,timestamp:'2000-01-01T00:00:00.500Z'})+'\n')
  const dir=path.join(config,'jobs',to.slice(0,8));fs.mkdirSync(dir,{recursive:true})
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({sessionId:to,state:'running',interactiveLineage:true,cwd:project,respawnFlags:['--channels','server:ait-protocol']}))
 }
 const db=openDb(path.join(root,'projection.sqlite'))
 for(const actor of [did,author])db.prepare('INSERT INTO actors(did,active,indexedAt) VALUES(?,1,?)').run(actor,'2000-01-01T00:00:00.000Z')
 const idResolver={did:{resolveAtprotoData:async id=>({did:id,handle:id===did?'owner.test':'author.test',signingKey:'',pds:''})}}
 const requests=[],clients=[];let gate=null
 const server=http.createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{}
   if(/(?:createSession|refreshSession|getSession)$/.test(req.url)){
    const jwt='e30.'+Buffer.from(JSON.stringify({sub:did,scope:'com.atproto.access',exp:Math.floor(Date.now()/1000)+86400})).toString('base64url')+'.fixture'
    res.setHeader('content-type','application/json');res.end(JSON.stringify({did,handle:'owner.test',email:'fixture@example.com',emailConfirmed:true,active:true,accessJwt:jwt,refreshJwt:jwt}))
   }else if(req.url.endsWith('registerPushTarget')){
    requests.push(body)
    const held=gate;gate=null;if(held)await held
    const after=body.cursor===undefined?0:(decodeSeqCursor(body.cursor)??0)
    await registry.registerAndReplay(db,idResolver,did,body.url,after)
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',cursor:encodeSeqCursor(after)}))
   }else if(req.url.includes('getAuthorFeed')){res.setHeader('content-type','application/json');res.end('{"feed":[]}')}
   else{res.writeHead(500);res.end('{"error":"unexpected fixture call"}')}
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}))}
 })
 server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint='http://127.0.0.1:'+server.address().port
 const wrapper=path.join(root,'wrapper.mjs')
 fs.writeFileSync(wrapper,`import fs from 'node:fs';import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const real=cp.execFileSync;cp.execFileSync=(p,a,...r)=>p==='ps'?(a.includes('lstart=')?(()=>{if(fs.existsSync(process.env.FIXTURE_INSPECTION_FAILURE))throw new Error('fixture transient ps failure');return process.env.FIXTURE_BIRTH})():'claude --resume '+process.env.CLAUDE_CODE_SESSION_ID):real(p,a,...r);syncBuiltinESMExports();const timeout=globalThis.setTimeout;let beat;process.on('SIGUSR1',()=>{const f=beat;beat=null;f?.()});globalThis.setTimeout=(f,ms,...a)=>{if(ms===30000){beat=()=>f(...a);console.error('fixture beat armed');return timeout(()=>{},60000)}return timeout(f,ms,...a)};await import(${JSON.stringify(new URL('../dist/server.js',import.meta.url).href)});`)
 async function start(id,birth=oldBirth){
  const registrationHeld=gate!==null
  const env={...process.env,HOME:path.join(root,'home'),CLAUDE_CONFIG_DIR:config,XDG_DATA_HOME:data,CLAUDE_CODE_SESSION_ID:id,AIT_NOTIFICATION_MODE:'push',PDS_URL:endpoint,APPVIEW_URL:endpoint,FIXTURE_BIRTH:birth,FIXTURE_INSPECTION_FAILURE:path.join(root,'inspection-unavailable')}
  for(const name of ['AIT_MCP_TEST_SESSION_ID','AIT_SESSION_ID','CODEX_SESSION_ID','CLAUDECODE'])delete env[name]
  const transport=new StdioClientTransport({command:process.execPath,args:[wrapper],env,cwd:project,stderr:'pipe'})
  let errors='';transport.stderr.on('data',chunk=>errors+=chunk)
  const client=new Client({name:'claude-owner-fixture',version:'1'}), notifications=[]
  client.fallbackNotificationHandler=async value=>notifications.push(value)
  await client.connect(transport)
  const item={client,transport,notifications,errors:()=>errors,beat:()=>process.kill(transport.pid,'SIGUSR1')};clients.push(item);if(!registrationHeld)await until(()=>errors.includes('fixture beat armed'),'registration completes');return item
 }
 function notification(){
  const uri='at://'+author+'/ait.feed.post/'+randomUUID(),now=new Date().toISOString()
  db.prepare('INSERT INTO posts(uri,cid,did,text,createdAt,indexedAt) VALUES(?,?,?,?,?,?)').run(uri,'cid',author,'owned pending notification',now,now)
  const row=db.prepare("INSERT INTO notifications(uri,cid,recipientDid,authorDid,reason,reasonSubject,createdAt,indexedAt) VALUES(?,?,?,?, 'mention',?,?,?)").run(uri,'cid',did,author,uri,now,now)
  return {uri,cursor:encodeSeqCursor(Number(row.lastInsertRowid))}
 }
 t.after(async()=>{if(!requests.length)console.error(clients.map(item=>item.errors()).join('\n'));for(const item of clients)await item.client.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await registry._processAll();registry._clear();db.close();fs.rmSync(root,{recursive:true,force:true})})
 function checkpoint(id){
  const env={...process.env,XDG_DATA_HOME:data,AIT_SESSION_ID:id,AIT_NOTIFICATION_MODE:'push'};delete env.AIT_MCP_TEST_SESSION_ID
  const checked=spawnSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(new URL('../dist/storage.js',import.meta.url).href)});console.log(JSON.stringify(m.getNotificationRegistrationCheckpoint().value))`],{env,encoding:'utf8'})
  assert.equal(checked.status,0,checked.stderr);return JSON.parse(checked.stdout)
 }
 return {root,config,data,store,claimDir,identity,transcript,seed,continueTo,start,requests,notification,checkpoint,publish:pending=>registry.notifyInsert(db,idResolver,did,pending.uri),holdNext:()=>{let release;gate=new Promise(r=>release=r);return release}}
}

test('native handover then newer original owns delivery despite live continued worker and reconnects',async t=>{
 const f=await fixture(t),a=randomUUID(),b=randomUUID();f.seed(a)
 const original=await f.start(a);await until(()=>f.requests.length===1,'original registers')
 f.continueTo(a,b)
 const child=await f.start(b);await until(()=>f.requests.length===2,'same-second handover must register')
 const childClaim=fs.readdirSync(f.claimDir).find(name=>name.includes(b));assert(childClaim.startsWith('946684800500-'),'native handover orders same-second child')
 const resumed=await f.start(a,newerBirth);await until(()=>f.requests.length===3,'newer original registers')
 const winner=f.requests.at(-1).url, before=f.requests.length
 child.beat();original.beat();await delay(50);assert.equal(f.requests.length,before,'retired processes must not renew')
 const childRestart=await f.start(b);await delay(50);assert.equal(f.requests.length,before,'MCP restart under old parent must not reclaim')
 assert.match(childRestart.errors(),/ait push listener/)
 const pending=f.notification();f.publish(pending)
 // Registration replay uses the actual registry and saved checkpoint.
 resumed.beat();await until(()=>resumed.notifications.length===1,'winner receives queued notification')
 assert.equal(f.checkpoint(a),pending.cursor)
 assert.equal(child.notifications.length+original.notifications.length+childRestart.notifications.length,0)
 const claimsBefore=fs.readdirSync(f.claimDir).filter(name=>name.endsWith('.claim')).length
 await resumed.client.close();const restarted=await f.start(a,newerBirth);await until(()=>f.requests.length===before+2,'same winning parent reconnect registers')
 assert.equal(fs.readdirSync(f.claimDir).filter(name=>name.endsWith('.claim')).length,claimsBefore,'reconnect must reuse its token')
 registry._clear();restarted.beat();await until(()=>registry._registeredUrl(did)===f.requests.at(-1).url,'AppView restart must preserve local owner')
 process.kill(restarted.transport.pid,'SIGKILL');await until(()=>restarted.transport.pid===null,'newest MCP crash observed');const afterCrash=f.requests.length;childRestart.beat();await delay(30);assert.equal(f.requests.length,afterCrash,'winner crash must not revive old claimant')
})

for(const order of ['older-first','newer-first'])test('claim publication order: '+order,async t=>{
 const f=await fixture(t),a=randomUUID(),b=randomUUID();f.seed(a);f.continueTo(a,b)
 let older,newer
 if(order==='older-first'){older=await f.start(b);await until(()=>f.requests.length===1,'older initial');newer=await f.start(a,newerBirth);await until(()=>f.requests.length===2,'newer initial')}
 else{newer=await f.start(a,newerBirth);await until(()=>f.requests.length===1,'newer initial');older=await f.start(b)}
 const count=f.requests.length;older.beat();await delay(30);assert.equal(f.requests.length,count)
 const pending=f.notification();newer.beat();await until(()=>newer.notifications.length===1,'greatest owner receives replay');assert.equal(f.checkpoint(a),pending.cursor);assert.equal(older.notifications.length,0)
})

test('held old registration cannot deliver or commit; winner heartbeat recovers actual backlog',async t=>{
 const f=await fixture(t),a=randomUUID(),b=randomUUID();f.seed(a);f.seed(b)
 const release=f.holdNext(),older=await f.start(a);await until(()=>f.requests.length===1,'old request held')
 const newer=await f.start(b,newerBirth);await until(()=>f.requests.length===2,'winner registered')
 release();await until(()=>older.errors().includes('fixture beat armed'),'old response completed')
 assert.equal(f.checkpoint(a),zero,'old response cannot commit')
 const pending=f.notification();f.publish(pending);await registry._processAll();assert.equal(registry._registeredUrl(did),undefined,'stale sink rejects and drops only its own callback');newer.beat();await until(()=>newer.notifications.length===1,'heartbeat replays after stale URL registration')
 assert.equal(f.checkpoint(b),pending.cursor);assert.equal(older.notifications.length,0);assert.equal(JSON.parse(fs.readFileSync(f.identity(a))).lastSeenNotificationCursor,zero,'legacy credential rewrites are no longer delivery authority')
 const before=f.requests.length;older.beat();await delay(30);assert.equal(f.requests.length,before,'old heartbeat remains fenced')
})

test('exact activation tie is unavailable; later activation recovers without deleting claims',async t=>{
 const f=await fixture(t),a=randomUUID(),b=randomUUID();f.seed(a);f.seed(b)
 const first=await f.start(a);await until(()=>f.requests.length===1,'first tie candidate registered')
 const second=await f.start(b);await until(()=>fs.readdirSync(f.claimDir).filter(name=>name.endsWith('.claim')).length===2,'second claim published')
 const count=f.requests.length;first.beat();second.beat();await delay(30);assert.equal(f.requests.length,count)
 const later=await f.start(a,newerBirth);await until(()=>f.requests.length===count+1,'later owner supersedes exact tie')
 const pending=f.notification();later.beat();await until(()=>later.notifications.length>=1,'later tie recovery delivers: '+later.errors());assert.equal(f.checkpoint(a),pending.cursor)
})

test('malformed claims refuse push visibly without breaking tools',async t=>{
 const f=await fixture(t),a=randomUUID();f.seed(a);fs.mkdirSync(f.claimDir);fs.writeFileSync(path.join(f.claimDir,'malformed.claim'),'')
 const current=await f.start(a);await delay(30);assert.equal(f.requests.length,0)
 assert.match(current.errors(),/Claude delivery state/)
 const result=await current.client.callTool({name:'getAuthorFeed',arguments:{}})
 assert(!result.isError);assert(result.content.some(item=>item.text?.includes('Automatic mentions are unavailable')))
})

for(const kind of ['symlink','directory','unreadable'])test('ownership state '+kind+' fails closed',async t=>{
 const f=await fixture(t),a=randomUUID();f.seed(a);fs.mkdirSync(f.claimDir)
 if(kind==='unreadable'){fs.chmodSync(f.claimDir,0)}
 else if(kind==='directory')fs.mkdirSync(path.join(f.claimDir,'malformed.claim'))
 else {const target=path.join(f.root,'unrelated');fs.writeFileSync(target,'preserve');fs.symlinkSync(target,path.join(f.claimDir,'malformed.claim'))}
 const current=await f.start(a);await delay(30);assert.equal(f.requests.length,0)
 assert.match(current.errors(),/Claude delivery state/)
 if(kind==='unreadable')fs.chmodSync(f.claimDir,0o700)
 if(kind==='symlink')assert.equal(fs.readFileSync(path.join(f.root,'unrelated'),'utf8'),'preserve')
})


test('stale credential rename cannot roll back the active delivery checkpoint',async t=>{
 const f=await fixture(t),a=randomUUID();f.seed(a)
 const current=await f.start(a,newerBirth);await until(()=>f.requests.length===1,'owner registers')
 const paused=path.join(f.root,'credential-paused'),release=path.join(f.root,'credential-release')
 const script=`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const m=await import(${JSON.stringify(new URL('../dist/storage.js',import.meta.url).href)});const original=fs.renameSync;fs.renameSync=(from,to)=>{fs.writeFileSync(${JSON.stringify(paused)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return original(from,to)};syncBuiltinESMExports();m.saveIdentity(m.loadIdentity());`
 const env={...process.env,XDG_DATA_HOME:f.data,AIT_SESSION_ID:a,AIT_NOTIFICATION_MODE:'push'};delete env.AIT_MCP_TEST_SESSION_ID
 const stale=spawn(process.execPath,['--input-type=module','-e',script],{env,stdio:['ignore','ignore','pipe']});let errors='';stale.stderr.on('data',x=>errors+=x)
 t.after(()=>{if(stale.exitCode===null)stale.kill('SIGKILL')})
 const exited=once(stale,'exit');await until(()=>fs.existsSync(paused),'credential rewrite paused before rename')
 const pending=f.notification();current.beat();await until(()=>current.notifications.length===1,'winner delivers while old credential write waits')
 assert.equal(f.checkpoint(a),pending.cursor)
 fs.writeFileSync(release,'go');const [code]=await exited;assert.equal(code,0,errors)
 assert.equal(JSON.parse(fs.readFileSync(f.identity(a))).lastSeenNotificationCursor,zero,'proof actually restores the stale credential baseline')
 assert.equal(f.checkpoint(a),pending.cursor,'delivery checkpoint is independent of stale credential rename')
 const before=f.requests.length;current.beat();await until(()=>f.requests.length>before,'winner renews after credential rename')
 assert.equal(f.requests.at(-1).cursor,pending.cursor,'registration uses durable delivered cursor')
})


test('temporary parent inspection failure recovers on the same listener heartbeat',async t=>{
 const f=await fixture(t),a=randomUUID();f.seed(a)
 const blocked=path.join(f.root,'inspection-unavailable');fs.writeFileSync(blocked,'temporary')
 const current=await f.start(a);assert.equal(f.requests.length,0)
 current.beat();await delay(30);assert.equal(f.requests.length,0,'failed inspection cannot authorize push')
 fs.unlinkSync(blocked);current.beat();await until(()=>f.requests.length===1,'same MCP retries process inspection and registers')
 const pending=f.notification();f.publish(pending);await until(()=>current.notifications.length===1,'recovered original listener delivers')
 assert.equal(f.checkpoint(a),pending.cursor)
})

test('temporary owner-state I/O failure does not permanently stop a live listener',async t=>{
 const f=await fixture(t),a=randomUUID();f.seed(a);const current=await f.start(a)
 const claim=path.join(f.claimDir,fs.readdirSync(f.claimDir).find(x=>x.endsWith('.claim'))),saved=fs.readFileSync(claim)
 fs.writeFileSync(claim,'temporary unreadable checkpoint');current.beat();await delay(50)
 assert.equal(f.requests.length,1,'unavailable state must refuse renewal')
 fs.writeFileSync(claim,saved);current.beat();await until(()=>f.requests.length===2,'same listener renews after state recovers')
 const pending=f.notification();f.publish(pending);await until(()=>current.notifications.length===1,'same listener delivers after state recovery')
 assert.equal(f.checkpoint(a),pending.cursor)
})


test('a handover snapshot may replay committed notifications but cannot skip them',async t=>{
 const f=await fixture(t),a=randomUUID(),b=randomUUID()
 const old=delivery.describeOwner(f.claimDir,a,946684800000,1234,946684800000)
 delivery.publishOwner(old,{kind:'cursor',value:zero})
 const inherited=delivery.readCheckpoint(f.claimDir),delivered=encodeSeqCursor(2)
 assert(delivery.commitCheckpoint(old,zero,delivered),'previous owner commits after successor snapshots')
 const next=delivery.describeOwner(f.claimDir,b,978307200000,5678,978307200000)
 delivery.publishOwner(next,inherited)
 assert.equal(delivery.readCheckpoint(f.claimDir).value,zero,'at-least-once handover may start before already delivered rows')
 assert.equal(delivery.commitCheckpoint(old,delivered,encodeSeqCursor(3)),false,'old owner cannot skip backlog on successor')
 assert(delivery.commitCheckpoint(next,zero,delivered),'replay can commit the already delivered rows under the new owner')
 assert.equal(delivery.readCheckpoint(f.claimDir).value,delivered)
})
