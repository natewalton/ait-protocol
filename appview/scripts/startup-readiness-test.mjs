// Compiled main, owned stores/loopback PDS only. No installed services or data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import test from 'node:test'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { Secp256k1Keypair } from '@atproto/crypto'
import { Repo, MemoryBlockstore, getFullRepo, concatBytesAsync, cidForRecord } from '@atproto/repo'
import { Frame, MessageFrame, ErrorFrame, createServiceJwt } from '@atproto/xrpc-server'
import { encodeSeqCursor } from '../dist/queries/cursor.js'
import { openDb } from '../dist/db.js'
const A='did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', B='did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const time='2026-11-14T12:00:00.000Z'
const record = text => ({$type:'ait.feed.post',text,createdAt:time})
const signer=await Secp256k1Keypair.create()
let seq=0
async function frame(items, action='create', offset=0,did=A) {
  const store=new MemoryBlockstore()
  const entries=items.map((value,i)=>({action:'create',collection:'ait.feed.post',rkey:`r${offset+i}`,record:value}))
  const repo=await Repo.create(store,did,signer,entries)
  const blocks=await concatBytesAsync(getFullRepo(store,repo.cid))
  const ops=await Promise.all(entries.map(async entry=>({action,path:`ait.feed.post/${entry.rkey}`,cid:action==='delete'?null:await cidForRecord(entry.record)})))
  return {head:repo.cid.toString(),rev:repo.commit.rev, bytes:new MessageFrame({seq:++seq,rebase:false,tooBig:false,repo:did,commit:repo.cid,rev:repo.commit.rev,since:null,blocks,ops,blobs:[],time},{type:'#commit'}).toBytes()}
}
async function until(check,label,ms=10000) {
  const end=Date.now()+ms
  while(Date.now()<end){if(await check())return;await delay(20)}
  assert.fail(label)
}
async function fixture(t,{records=[record('snapshot old mention')],hold=true,gap=true,afterRev, connections}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ait-local-ready-'))
  fs.mkdirSync(path.join(root,'appview'));fs.mkdirSync(path.join(root,'home'))
  const state={root,held:new Set(),pushes:[],bytes:0,requests:0,output:'',mode:hold?'hold':'ok',readers:new Set(),connections:0}
  const initial=await frame(records)
  state.active=true;state.rev=initial.rev;state.afterRev=afterRev??initial.rev;state.records=records
  state.source=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');let result
    if(url.pathname==='/notify') {
      const chunks=[];for await(const chunk of req)chunks.push(chunk)
      state.pushes.push(JSON.parse(Buffer.concat(chunks).toString()));res.end('{}');return
    }
    const did=decodeURIComponent(url.pathname.slice(1))
    if([A,B].includes(did)){res.setHeader('content-type','application/json');res.end(JSON.stringify({id:did,alsoKnownAs:['at://fixture.test'],verificationMethod:[{id:did+'#atproto',type:'Multikey',controller:did,publicKeyMultibase:signer.did().slice(8)}],service:[{id:did+'#atproto_pds',type:'AtprotoPersonalDataServer',serviceEndpoint:state.upstream}]}));return}
    if(url.pathname.endsWith('getRepoStatus')&&state.repoMissing){res.writeHead(400);res.end('{"error":"RepoNotFound"}');return}
    if(url.pathname.endsWith('listRepos')) {
      state.requests++
      if(state.mode==='hold'){state.held.add(res);res.once('close',()=>state.held.delete(res));return}
      if(state.mode==='fail'){res.writeHead(503);res.end('{}');return}
      result={repos:state.repoMissing?[]:[{did:A,head:(await cidForRecord(records[0]??record('empty'))).toString(),rev:state.rev,active:state.active,...(!state.active?{status:'deactivated'}:{})}]}
    } else if(url.pathname.endsWith('listRecords')) {
      if(state.reactivatedOnRecords){state.reactivatedOnRecords=false;res.writeHead(400);res.end('{"error":"RepoDeactivated"}');return}
      if(state.missingOnRecords){state.repoMissing=true;res.writeHead(400);res.end('{"error":"RepoNotFound"}');return}

      const selected=url.searchParams.get('collection')==='ait.feed.post'?state.records:[]
      const offset=Number(url.searchParams.get('cursor')??0),limit=Number(url.searchParams.get('limit'))
      const chunk=selected.slice(offset,offset+limit)
      result={records:await Promise.all(chunk.map(async(value,i)=>({uri:`at://${A}/ait.feed.post/r${offset+i}`,cid:(await cidForRecord(value)).toString(),value}))),...(offset+limit<selected.length?{cursor:String(offset+limit)}:{})}
    } else if(url.pathname.endsWith('getRepoStatus')) {state.statusReads=(state.statusReads??0)+1;const active=state.afterActive??state.active;result={did:A,active,...(active?{rev:state.afterRev}:{status:'deactivated'})}}
    else {res.writeHead(404);res.end('{}');return}
    const body=JSON.stringify(result);state.bytes+=Buffer.byteLength(body)
    res.setHeader('content-type','application/json');res.end(body)
  })
  state.wss=new WebSocketServer({server:state.source})
  state.wss.on('connection',socket=>{
    state.connections++;state.socket=socket
    if(gap)socket.send(new MessageFrame({name:'OutdatedCursor',message:'owned older-than-window fixture'},{type:'#info'}).toBytes())
    connections?.(socket,state)
  })
  await new Promise(resolve=>state.source.listen(0,'127.0.0.1',resolve))
  state.upstream=`http://127.0.0.1:${state.source.address().port}`
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));state.port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))
  state.dbPath=path.join(root,'projection.sqlite')
  const db=openDb(state.dbPath)
  db.prepare('INSERT INTO actors(did,active,indexedAt) VALUES(?,1,?)').run(B,time)
  db.prepare('INSERT INTO posts(uri,cid,did,text,createdAt,indexedAt) VALUES(?,?,?,?,?,?)').run(`at://${B}/ait.feed.post/stale`,(await cidForRecord(record('retained stale row'))).toString(),B,'retained stale row',time,time)
  db.close()
  state.release=()=>{
    state.mode='ok'
    for(const res of state.held){const body=JSON.stringify({repos:[{did:A,head:initial.head,rev:state.rev,active:state.active,...(!state.active?{status:'deactivated'}:{})}]});state.bytes+=body.length;res.end(body)}state.held.clear()
  }
  state.start=async()=>{
    const connectionsBefore=state.connections
    state.output='';state.started=performance.now()
    state.child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.js',import.meta.url))],{cwd:path.join(root,'appview'),env:{...process.env,HOME:path.join(root,'home'),DOTENV_CONFIG_PATH:path.join(root,'absent.env'),APPVIEW_OPERATOR:'',APPVIEW_PORT:String(state.port),APPVIEW_DID:B,APPVIEW_DB_PATH:state.dbPath,APPVIEW_PDS_URL:state.upstream,APPVIEW_PDS_WS_URL:state.upstream.replace('http','ws'),APPVIEW_PLC_URL:state.upstream},stdio:['ignore','pipe','pipe']})
    state.exited=once(state.child,'exit')
    for(const stream of [state.child.stdout,state.child.stderr])stream.on('data',chunk=>state.output+=chunk)
    await until(()=>state.output.includes('appview listening'),'compiled server listen')
    await until(()=>state.connections>connectionsBefore,'owned PDS subscription connected')
  }
  state.health=async()=>{
    const response=await fetch(`http://127.0.0.1:${state.port}/xrpc/_health`,{signal:AbortSignal.timeout(2000)})
    return {code:response.status,...await response.json()}
  }
  state.stop=async()=>{
    if(!state.child||state.child.exitCode!==null||state.child.signalCode!==null)return
    state.child.kill('SIGTERM')
    await Promise.race([state.exited,delay(3000)])
    if(state.child.exitCode===null&&state.child.signalCode===null){state.child.kill('SIGKILL');await state.exited;assert.fail('compiled consumer failed graceful cleanup')}
  }
  t.after(async()=>{await state.stop();for(const res of state.held)res.destroy();for(const socket of state.wss.clients)socket.terminate();await new Promise(resolve=>state.wss.close(resolve));state.source.closeAllConnections();await new Promise(resolve=>state.source.close(resolve));fs.rmSync(root,{recursive:true,force:true})})
  await state.start();return state
}
test('old-window bootstrap is held until complete, preserves retained rows, and restarts quietly',async t=>{
  const state=await fixture(t)
  await until(()=>state.requests===1,'held bootstrap request')
  assert.equal((await state.health()).status,'starting')
  state.release();await until(async()=> (await state.health()).code===200,'bootstrap ready')
  const response=await fetch(`http://127.0.0.1:${state.port}/xrpc/ait.feed.getAuthorFeed?actor=${A}`)
  assert.equal(response.status,200);assert.equal((await response.json()).feed[0].post.record.text,'snapshot old mention')
  const db=openDb(state.dbPath);assert.equal(db.prepare('SELECT text FROM posts WHERE did=?').get(B).text,'retained stale row');db.close()
  await delay(100);assert.equal((await state.health()).status,'ok')
  await state.stop();await state.start();await until(async()=>(await state.health()).code===200,'older install restart ready')
})
test('a bootstrap failure is degraded while historical HTTP stays available',async t=>{
  const state=await fixture(t,{hold:false});await until(async()=>(await state.health()).code===200,'initial ready')
  const trigger=openDb(state.dbPath)
  trigger.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON posts WHEN NEW.text='force projection fail' BEGIN SELECT RAISE(FAIL, 'owned projection failure'); END")
  trigger.close()
  state.socket.send((await frame([record('force projection fail')])).bytes)
  await until(async()=>(await state.health()).status==='degraded','bad projection health')
  const response=await fetch(`http://127.0.0.1:${state.port}/xrpc/ait.feed.getAuthorFeed?actor=${B}`)
  assert.equal(response.status,200)
})
test('stream update and delete queued during bootstrap win and changed revision waits',async t=>{
  const state=await fixture(t)
  const update=await frame([record('new stream version')],'update')
  const deletion=await frame([record('delete snapshot')],'delete')
  state.afterRev=update.rev
  await until(()=>state.requests===1,'held list')
  state.release()
  await until(()=>state.statusReads>0,'snapshot status read')
  await delay(50);assert.equal((await state.health()).code,503,'changed revision must wait for projected commit')
  state.socket.send(update.bytes)
  await until(async()=>(await state.health()).code===200,'updated revision ready')
  const db=openDb(state.dbPath);assert.equal(db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`).text,'new stream version')
  state.socket.send(deletion.bytes)
  await until(()=>!db.prepare('SELECT 1 FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`),'queued delete wins');db.close()
})
test('representative 6000-post bootstrap plus retained-window replay has measured cost',async t=>{
  const records=Array.from({length:6000},(_,i)=>record(`post ${i} `+'x'.repeat(500)))
  const state=await fixture(t,{records})
  const all=[...records,record('replay completion')], retained=[]
  for(let offset=0;offset<all.length;offset+=100)retained.push(await frame(all.slice(offset,offset+100),'create',offset))
  state.afterRev=retained.at(-1).rev
  for(const batch of retained)state.socket.send(batch.bytes)
  state.release()
  try { await until(async()=>(await state.health()).code===200,'representative bootstrap/replay',30000) }
  catch(error){const diagnostic=openDb(state.dbPath);console.log(JSON.stringify({health:await state.health(),rows:diagnostic.prepare('SELECT count(*) AS n FROM posts WHERE did=?').get(A).n,bytes:state.bytes,output:state.output}));diagnostic.close();throw error}
  const db=openDb(state.dbPath);await until(()=>db.prepare('SELECT count(*) AS n FROM posts WHERE did=?').get(A).n===6001,'retained replay completed',30000);db.close()
  console.log(JSON.stringify({posts:6000,bootstrapResponseBytes:state.bytes,bootstrapPlusReplayMs:Math.round(performance.now()-state.started)}))
})
test('ConsumerTooSlow reconnects at the existing outer delay and recovers',async t=>{
  const times=[]
  const state=await fixture(t,{hold:false,connections(socket,s){times.push(performance.now());if(s.connections<3)setTimeout(()=>{socket.send(new ErrorFrame({error:'ConsumerTooSlow',message:'owned cutover overflow'}).toBytes());socket.close()},100)}})
  await until(()=>state.connections>=3,'paced reconnects',12000)
  await until(async()=>(await state.health()).code===200,'recovered overflow')
  assert.ok(times[1]-times[0]>=2900);assert.ok(times[2]-times[1]>=2900)
})

test('bootstrap suppresses historic pushes and overlapping mentions replay durably',async t=>{
  const mention=text=>({...record(text),facets:[{index:{byteStart:0,byteEnd:4},features:[{$type:'app.bsky.richtext.facet#mention',did:B}]}]})
  const state=await fixture(t,{records:[mention('@you historic')]})
  const register=async(cursor)=>{
    const token=await createServiceJwt({iss:B,aud:B,lxm:'ait.notification.registerPushTarget',keypair:signer})
    const response=await fetch(`http://127.0.0.1:${state.port}/xrpc/ait.notification.registerPushTarget`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({url:state.upstream+'/notify',...(cursor?{cursor}:{})}),signal:AbortSignal.timeout(3000)})
    assert.equal(response.status,200,await response.text())
  }
  await register()
  state.records.push(mention('@you current'))
  const overlap=await frame(state.records)
  state.afterRev=overlap.rev
  state.socket.send(overlap.bytes);state.release()
  await until(async()=>(await state.health()).code===200,'overlapping mention complete')
  const db=openDb(state.dbPath)
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications WHERE recipientDid=?').get(B).n,2)
  await delay(100)
  assert.equal(state.pushes.length,0,'bootstrap must not push historical records or duplicate overlap')
  await register()
  await until(()=>state.pushes.length===2,'registration replays durable overlap')
  assert.ok(state.pushes.some(item=>item.uri===`at://${A}/ait.feed.post/r1`))
  const checkpoint=encodeSeqCursor(db.prepare('SELECT max(seq) AS n FROM notifications').get().n)
  db.close()
  await state.stop();state.rev=state.afterRev
  await state.start();await until(async()=>(await state.health()).code===200,'mention restart ready')
  await register(checkpoint);await delay(100)
  assert.equal(state.pushes.length,2,'restart bootstrap must not re-push acknowledged historic mentions')
})

test('updates and deletes buffered before bootstrap completion win in sequence',async t=>{
  const state=await fixture(t)
  const update=await frame([record('queued replacement')],'update')
  const deletion=await frame([record('queued delete')],'delete')
  state.afterRev=deletion.rev
  state.socket.send(update.bytes);state.socket.send(deletion.bytes)
  state.release();await until(async()=>(await state.health()).code===200,'queued deletion covered')
  const db=openDb(state.dbPath);assert.equal(db.prepare('SELECT 1 FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`),undefined);db.close()
})
test('stopping during held bootstrap aborts metadata and the quiet pending stream',async t=>{
  const state=await fixture(t,{gap:false})
  await until(()=>state.requests===1,'held metadata')
  const started=performance.now();await state.stop()
  assert.ok(performance.now()-started<3000)
  await until(()=>state.held.size===0,'metadata abort released body')
})

test('covered R1 cannot overwrite snapshot R2 before queued R2 arrives',async t=>{
  const old=await frame([record('R1 old')],'update')
  const state=await fixture(t,{records:[record('R2 current')]})
  state.socket.send(old.bytes)
  state.release();await until(async()=>(await state.health()).code===200,'R2 snapshot ready')
  await delay(100)
  const db=openDb(state.dbPath)
  assert.equal(db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`).text,'R2 current')
  assert.equal((await state.health()).code,200)
  db.close()
})
test('a timed-out bootstrap remains starting then recovers through existing retry',async t=>{
  const state=await fixture(t)
  await until(()=>state.output.includes('local bootstrap request timed out'),'bounded metadata timeout',12000)
  assert.equal((await state.health()).status,'starting')
  state.release();await until(async()=>(await state.health()).code===200,'timeout recovered',10000)
})
test('PDS transport restart recovers without an AppView restart',async t=>{
  const state=await fixture(t,{hold:false})
  await until(async()=>(await state.health()).code===200,'before restart')
  const port=state.source.address().port
  for(const socket of state.wss.clients)socket.terminate()
  state.source.closeAllConnections();await new Promise(resolve=>state.source.close(resolve))
  await delay(1200)
  assert.notEqual((await state.health()).status,'degraded')
  await new Promise(resolve=>state.source.listen(port,'127.0.0.1',resolve))
  await until(()=>state.connections>=2,'PDS reconnected',10000)
  await until(async()=>(await state.health()).code===200,'PDS restart ready')
})

test('an old covered delete cannot remove a recreated snapshot record',async t=>{
  const oldDelete=await frame([record('deleted old version')],'delete')
  const state=await fixture(t,{records:[record('recreated current version')]})
  state.socket.send(oldDelete.bytes);state.release()
  await until(async()=>(await state.health()).code===200,'recreated ready');await delay(100)
  const db=openDb(state.dbPath)
  assert.equal(db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`).text,'recreated current version')
  db.close()
})
test('an intermediate commit cannot satisfy a later observed target revision',async t=>{
  const state=await fixture(t)
  const middle=await frame([record('middle')],'update'),last=await frame([record('latest')],'update')
  state.afterRev=last.rev;state.release();await until(()=>state.statusReads>0,'later target sampled')
  state.socket.send(middle.bytes)
  const db=openDb(state.dbPath)
  await until(()=>db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`)?.text==='middle','middle projected')
  assert.equal((await state.health()).code,503)
  state.socket.send(last.bytes);await until(async()=>(await state.health()).code===200,'latest covered')
  assert.equal(db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`).text,'latest');db.close()
})
test('a reconnect OutdatedCursor bootstraps newer current records',async t=>{
  const state=await fixture(t,{hold:false})
  await until(async()=>(await state.health()).code===200,'initial current ready')
  const current=record('gap recovered current record'),revision=await frame([current])
  state.records=[current];state.rev=revision.rev;state.afterRev=revision.rev
  state.socket.send(new MessageFrame({name:'OutdatedCursor',message:'owned later gap'},{type:'#info'}).toBytes())
  const db=openDb(state.dbPath)
  await until(()=>db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`)?.text===current.text,'gap current read')
  await until(async()=>(await state.health()).code===200,'gap ready');db.close()
})
test('replayed account flags use current PDS authority without a commit watermark',async t=>{
  const state=await fixture(t);state.active=false;state.release()
  await until(async()=>(await state.health()).code===200,'inactive bootstrap ready')
  const account=active=>new MessageFrame({seq:++seq,time,did:A,active,...(!active?{status:'deactivated'}:{})},{type:'#account'}).toBytes()
  state.socket.send(account(true));await until(()=>state.statusReads>=1,'old active flag checked')
  const db=openDb(state.dbPath)
  assert.equal(db.prepare('SELECT active FROM actors WHERE did=?').get(A).active,0)
  state.active=true;state.socket.send(account(false))
  await until(()=>db.prepare('SELECT active FROM actors WHERE did=?').get(A).active===1,'current active authority wins')
  await until(async()=>(await state.health()).code===200,'reactivated bootstrap complete')
  state.socket.send(new MessageFrame({seq:++seq,time,did:A,handle:'obsolete.test'},{type:'#identity'}).toBytes())
  await delay(50)
  const response=await fetch(`http://127.0.0.1:${state.port}/xrpc/ait.feed.getAuthorFeed?actor=${A}`)
  assert.equal((await state.health()).code,200);assert.equal(response.status,200)
  assert.equal((await response.json()).feed[0].post.author.handle,'fixture.test')
  db.close()
})
test('one bootstrap HTTP503 returns to starting then recovers',async t=>{
  const state=await fixture(t)
  await until(()=>state.held.size>0,'held response')
  state.mode='ok';for(const res of state.held){res.writeHead(503);res.end('{}')}state.held.clear()
  await until(()=>state.output.includes('listRepos failed: 503'),'transient HTTP reported')
  assert.equal((await state.health()).status,'starting')
  await until(async()=>(await state.health()).code===200,'HTTP recovered',8000)
})

test('commit envelope ordering must match the parsed CAR root revision',async t=>{
  const old=await frame([record('forged old record')],'update')
  const state=await fixture(t,{records:[record('current snapshot')],hold:false})
  await until(async()=>(await state.health()).code===200,'snapshot ready')
  const later=await frame([record('later')])
  const envelope=Frame.fromBytes(old.bytes)
  state.socket.send(new MessageFrame({...envelope.body,rev:later.rev},{type:'#commit'}).toBytes())
  await until(async()=>(await state.health()).status==='degraded','forged ordering rejected')
  const db=openDb(state.dbPath);assert.equal(db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`).text,'current snapshot');db.close()
})

test('authoritatively absent accounts become inactive without stopping other actors',async t=>{
  const state=await fixture(t,{hold:false})
  await until(async()=>(await state.health()).code===200,'initial ready')
  state.repoMissing=true
  state.socket.send(new MessageFrame({seq:++seq,time,did:A,active:true},{type:'#account'}).toBytes())
  const db=openDb(state.dbPath)
  await until(()=>db.prepare('SELECT active FROM actors WHERE did=?').get(A)?.active===0,'missing account inactive')
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE did=?').get(A),'account absence must retain history')
  state.socket.send((await frame([record('other actor continues')],'create',0,B)).bytes)
  await until(()=>db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${B}/ait.feed.post/r0`)?.text==='other actor continues','other actor indexed')
  assert.equal((await state.health()).code,200);db.close()
})

test('a covered native delete removes a retained row absent from the snapshot',async t=>{
  const deletion=await frame([record('deleted while stopped')],'delete',5)
  const state=await fixture(t)
  const db=openDb(state.dbPath)
  db.prepare('INSERT INTO posts(uri,cid,did,text,createdAt,indexedAt) VALUES(?,?,?,?,?,?)').run(`at://${A}/ait.feed.post/r5`,(await cidForRecord(record('deleted while stopped'))).toString(),A,'deleted while stopped',time,time)
  state.socket.send(deletion.bytes);state.release()
  await until(()=>!db.prepare('SELECT 1 FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r5`),'covered explicit deletion applied')
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE did=?').get(B),'unmentioned retained row must not be swept')
  assert.equal((await state.health()).code,200);db.close()
})
test('final inactive status is projected before bootstrap can report running',async t=>{
  const state=await fixture(t);state.afterActive=false;state.release()
  await until(async()=>(await state.health()).code===200,'inactive final status ready')
  const db=openDb(state.dbPath)
  assert.equal(db.prepare('SELECT active FROM actors WHERE did=?').get(A).active,0)
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE did=?').get(A),'inactive transition retains records');db.close()
})
test('a repository removed during bootstrap does not stop remaining actors',async t=>{
  const state=await fixture(t);state.missingOnRecords=true
  const db=openDb(state.dbPath)
  db.prepare('INSERT INTO posts(uri,cid,did,text,createdAt,indexedAt) VALUES(?,?,?,?,?,?)').run(`at://${A}/ait.feed.post/retained`,(await cidForRecord(record('retained'))).toString(),A,'retained',time,time)
  state.release();await until(async()=>(await state.health()).code===200,'deleted during bootstrap ready')
  assert.equal(db.prepare('SELECT active FROM actors WHERE did=?').get(A).active,0)
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE did=?').get(A))
  state.socket.send((await frame([record('sibling remains healthy')],'create',0,B)).bytes)
  await until(()=>db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${B}/ait.feed.post/r0`)?.text==='sibling remains healthy','sibling progresses')
  assert.equal((await state.health()).code,200);db.close()
})

test('reactivation during a record read retries the invalidated snapshot before running',async t=>{
  const state=await fixture(t);state.reactivatedOnRecords=true
  state.release()
  await until(()=>state.statusReads>=1,'reactivation checked against current account')
  assert.equal((await state.health()).status,'starting')
  await until(async()=>(await state.health()).code===200,'reactivated snapshot recovers')
  assert.ok(state.requests>=2,'invalidated read must retry bootstrap')
  const db=openDb(state.dbPath)
  assert.equal(db.prepare('SELECT text FROM posts WHERE uri=?').get(`at://${A}/ait.feed.post/r0`)?.text,'snapshot old mention')
  db.close()
})
