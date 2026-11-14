// Owned account/projection stores and loopback services only. Exercise the
// compiled AppView retirement endpoint with real signed service JWTs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { WebSocketServer } from 'ws'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import { openDb } from '../dist/db.js'
import { resolveLocalOperator, localPdsAccountFile, resolveInstallationOperator } from '../dist/operatorIdentity.mjs'
const A='did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', B='did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', C='did:plc:cccccccccccccccccccccccc'
const audience='did:plc:dddddddddddddddddddddddd'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ait-local-operator-'))
let driver, fixture, wss
try {
  for(const name of ['pds','appview','home','xdg']) fs.mkdirSync(path.join(root,name))
  const accountFile=path.join(root,'pds/account.sqlite')
  const accounts=new Database(accountFile)
  accounts.exec('CREATE TABLE actor(did TEXT PRIMARY KEY,handle TEXT)')
  accounts.prepare('INSERT INTO actor VALUES(?,?)').run(A,'operator.test'); accounts.close()
  fs.writeFileSync(path.join(root,'pds/.env'),'PDS_ACCOUNT_DB_LOCATION=account.sqlite\n')
  const original=fs.readFileSync(accountFile)
  for(const reference of [A,'operator','operator.test',' @operator.test ']) assert.equal(resolveLocalOperator(accountFile,reference).did,A)
  for(const reference of [undefined,'',B,'missing.test','bad reference','did:not-valid']) assert.equal(resolveLocalOperator(accountFile,reference).did,null)
  const missing=path.join(root,'missing.sqlite')
  assert.equal(resolveLocalOperator(missing,A).did,null);assert.equal(fs.existsSync(missing),false)
  assert.deepEqual(fs.readFileSync(accountFile),original,'binding must not write account data')
  assert.equal(localPdsAccountFile(root),accountFile)
  const previous=process.env.PDS_ACCOUNT_DB_LOCATION
  process.env.PDS_ACCOUNT_DB_LOCATION=missing
  try { assert.equal(localPdsAccountFile(root),accountFile,'sourced assignment wins') }
  finally { if(previous===undefined)delete process.env.PDS_ACCOUNT_DB_LOCATION;else process.env.PDS_ACCOUNT_DB_LOCATION=previous }
  fs.writeFileSync(path.join(root,'pds/.env'),`PDS_ACCOUNT_DB_LOCATION="$HOME/../pds/account.sqlite"\n`)
  const previousHome=process.env.HOME;process.env.HOME=path.join(root,'home')
  try {assert.equal(localPdsAccountFile(root),accountFile,'shell-expanded account path')}
  finally {if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome}
  fs.writeFileSync(path.join(root,'pds/.env'),'PDS_ACCOUNT_DB_LOCATION=account.sqlite\n')
  assert.equal(resolveInstallationOperator(root,'operator.test').did,A)
  const duplicate=new Database(accountFile);duplicate.prepare('INSERT INTO actor VALUES(?,?)').run(B,'operator.other.example');duplicate.close()
  assert.equal(resolveLocalOperator(accountFile,'operator').did,null,'ambiguous local shorthand disables authority')
  assert.equal(resolveLocalOperator(accountFile,A).did,A)
  const removeDuplicate=new Database(accountFile);removeDuplicate.prepare('DELETE FROM actor WHERE did=?').run(B);removeDuplicate.close()
  const keys=new Map([[A,await Secp256k1Keypair.create()],[B,await Secp256k1Keypair.create()]])
  let handleReads=0
  fixture=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture'), did=decodeURIComponent(url.pathname.slice(1))
    res.setHeader('content-type','application/json')
    if(keys.has(did)) {
      res.end(JSON.stringify({id:did,alsoKnownAs:['at://operator.test'],verificationMethod:[{
        id:did+'#atproto',type:'Multikey',controller:did,publicKeyMultibase:keys.get(did).did().slice('did:key:'.length),
      }]}));return
    }
    if(url.pathname==='/xrpc/com.atproto.identity.resolveHandle') {handleReads++;res.end(JSON.stringify({did:B}));return}
    res.writeHead(404);res.end('{}')
  })
  wss=new WebSocketServer({server:fixture})
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
  const upstream=`http://127.0.0.1:${fixture.address().port}`
  const reserved=http.createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve))
  const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve))
  const dbPath=path.join(root,'projection.sqlite'), db=openDb(dbPath)
  for(const did of [A,B,C]) db.prepare('INSERT INTO actors(did,active,indexedAt) VALUES(?,1,?)').run(did,new Date().toISOString())
  db.close()
  driver=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.js',import.meta.url))],{
    cwd:path.join(root,'appview'),env:{...process.env,HOME:path.join(root,'home'),XDG_DATA_HOME:path.join(root,'xdg'),
      APPVIEW_PORT:String(port),APPVIEW_DB_PATH:dbPath,APPVIEW_PDS_URL:upstream,APPVIEW_PDS_WS_URL:upstream.replace('http','ws'),
      APPVIEW_PLC_URL:upstream,APPVIEW_DID:audience,APPVIEW_OPERATOR:'operator.test'},stdio:['ignore','pipe','pipe'],
  })
  let output='';driver.stdout.on('data',c=>output+=c);driver.stderr.on('data',c=>output+=c)
  const end=Date.now()+8000
  while(!output.includes('appview listening')) {
    assert.equal(driver.exitCode,null,output);assert.ok(Date.now()<end,output);await delay(20)
  }
  assert.ok(output.includes(`operator ${A} bound to the local PDS account`),output)
  async function retire(viewer,subject,retired) {
    const token=await createServiceJwt({iss:viewer,aud:audience,lxm:'ait.actor.setRetired',keypair:keys.get(viewer)})
    return fetch(`http://127.0.0.1:${port}/xrpc/ait.actor.setRetired`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({subject,retired}),signal:AbortSignal.timeout(3000)})
  }
  const allowed=await retire(A,C,true);assert.equal(allowed.status,200,await allowed.text())
  const denied=await retire(B,C,false);assert.equal(denied.status,400);assert.equal((await denied.json()).error,'NotOperator')
  const self=await retire(B,B,true);assert.equal(self.status,200,await self.text())
  const check=new Database(dbPath,{readonly:true});assert.ok(check.prepare('SELECT retiredAt FROM actors WHERE did=?').get(C).retiredAt);check.close()
  assert.equal(handleReads,0,'operator authorization must not resolve through PDS directory')
  console.log('PASS local operator: compiled authenticated retirement honors local principal, rejects namesake, retains self-retirement')
} finally {
  if(driver && driver.exitCode===null && driver.signalCode===null) {
    const exit=once(driver,'exit');driver.kill('SIGTERM');await Promise.race([exit,delay(3000)])
    if(driver.exitCode===null && driver.signalCode===null){driver.kill('SIGKILL');await exit}
  }
  if(wss){for(const socket of wss.clients)socket.terminate();await new Promise(resolve=>wss.close(resolve))}
  if(fixture){fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))}
  fs.rmSync(root,{recursive:true,force:true})
}
