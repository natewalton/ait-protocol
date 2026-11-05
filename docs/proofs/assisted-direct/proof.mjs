import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import dgram from 'node:dgram'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
const root = path.dirname(new URL(import.meta.url).pathname)
assert(process.env.IROH_BINDING && process.env.IROH_RELAY_BIN, 'explicit fixture binding and relay required')
const run = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-assisted-direct-'))
const journal = event => fs.appendFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...event })+'\n')
const children = [], sockets = []
let gateOpen = false, forwarded = 0, dropped = 0, sequence = 0
async function tcpPort() { const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p }
async function udpSocket() {const s=dgram.createSocket('udp4');s.bind(0,'127.0.0.1');await once(s,'listening');sockets.push(s);return s}
async function freeUdpPort() {const s=await udpSocket();const p=s.address().port;sockets.splice(sockets.indexOf(s),1);s.close();return p}
const bounded = (promise, name, ms=20000) => {
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`deadline: ${name}`)),ms)})]).finally(()=>clearTimeout(timer))
}
function worker(role, port, peerProxy, relayPort) {
  const profile=path.join(run,role+'.sb')
  fs.writeFileSync(profile,`(version 1)\n(allow default)\n(deny network*)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote tcp "localhost:${relayPort}"))\n(allow network-outbound (remote udp "localhost:${peerProxy}"))\n`)
  const child=spawn('sandbox-exec',['-f',profile,process.execPath,path.join(root,'worker.mjs'),role,String(port),`http://127.0.0.1:${relayPort}/`],{env: {...process.env, IROH_POLICY: mode}, stdio:['pipe','pipe','pipe']})
  children.push(child);const events=new EventEmitter(), history=[], pending=new Map()
  child.stderr.on('data',b=>fs.appendFileSync(path.join(run,role+'.stderr'),b))
  readline.createInterface({input:child.stdout}).on('line',line=>{
    let msg;try{msg=JSON.parse(line)}catch{journal({role,output:line});return}
    journal({role,...msg});history.push(msg)
    if(msg.response){const p=pending.get(msg.response);if(p){pending.delete(msg.response);msg.error?p.reject(Error(msg.error)):p.resolve(msg.value)}}
    events.emit('event',msg)
  })
  child.once('exit',(code,signal)=>{journal({role,event:'exit',code,signal});for(const p of pending.values())p.reject(Error(`${role} exited`));events.emit('exit')})
  const wait=(predicate,name,after=0,ms=20000)=>bounded(new Promise((resolve,reject)=>{
    const old=history.slice(after).find(predicate);if(old){resolve(old);return}
    const listener=msg=>{if(predicate(msg)){events.off('event',listener);events.off('exit',exited);resolve(msg)}}
    const exited=()=>{events.off('event',listener);reject(Error(`${role} exited while ${name}`))}
    events.on('event',listener);events.once('exit',exited)
  }),name,ms)
  const ask=(command,extra={})=>{const id=++sequence;return bounded(new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,command,...extra})+'\n')}),`${role}:${command}`,command==='send'?90000:20000)}
  return {child,history,wait,ask}
}
let relay, a, b
const mode=process.argv[2]??'strict'; assert(['strict','control'].includes(mode))
const result={mode,run,checks:[]}
try {
 const relayPort=await tcpPort(),metricsPort=await tcpPort(),aPort=await freeUdpPort(),bPort=await freeUdpPort()
 const pa=await udpSocket(),pb=await udpSocket()
 for(const [incoming,outgoing,target,source] of [[pb,pa,bPort,aPort],[pa,pb,aPort,bPort]]) incoming.on('message',(buf,info)=>{
   assert.equal(info.address,'127.0.0.1');assert.equal(info.port,source)
   if(gateOpen){forwarded+=buf.length;outgoing.send(buf,target,'127.0.0.1')}else dropped+=buf.length
 })
 fs.writeFileSync(path.join(run,'relay.toml'),`http_bind_addr = "127.0.0.1:${relayPort}"\nenable_quic_addr_discovery = false\nenable_metrics = true\nmetrics_bind_addr = "127.0.0.1:${metricsPort}"\n`)
 const relayProfile=path.join(run,'relay.sb');fs.writeFileSync(relayProfile,'(version 1)\n(allow default)\n(deny network*)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n');
 relay=spawn('sandbox-exec',['-f',relayProfile,process.env.IROH_RELAY_BIN,'--dev','-c',path.join(run,'relay.toml')],{env:{...process.env,RUST_LOG:'info'},stdio:['ignore','pipe','pipe']});children.push(relay)
 await bounded(new Promise((resolve,reject)=>{
  const listen=chunk=>{const text=chunk.toString();fs.appendFileSync(path.join(run,'relay.log'),text);if(/relay is running|Relay server listening|HTTP server listening|iroh-relay is running|server listening|Serving|serving/.test(text))resolve()}
  relay.stdout.on('data',listen);relay.stderr.on('data',listen);relay.once('exit',code=>reject(Error(`relay exited ${code}`)))
 }),'relay readiness',5000)
 const metric=async()=>{const r=await fetch(`http://127.0.0.1:${metricsPort}/metrics`);const text=await r.text();fs.writeFileSync(path.join(run,`metrics-${++sequence}.txt`),text);return text.split('\n').filter(s=>/bytes|packets|send|recv/i.test(s)&&!s.startsWith('#'))}
 b=worker('server',bPort,pa.address().port,relayPort);const br=await b.wait(x=>x.event==='ready','server ready')
 a=worker('client',aPort,pb.address().port,relayPort);await a.wait(x=>x.event==='ready','client ready')
 await a.ask('connect',{peer:br.id,proxyPort:pb.address().port});await b.wait(x=>x.event==='connected','server connected')
 result.initial=(await a.ask('snapshot')).paths;assert(result.initial.some(p=>p.isSelected&&p.isRelay));result.checks.push('handshake on relay with UDP blocked')
 let early
 if(mode==='strict') {
   early=a.ask('send',{size:16384,byte:17})
   assert.equal((await b.ask('snapshot')).received.length,0)
 }
 gateOpen=true
 await Promise.all([a.ask('advertise',{address:`127.0.0.1:${pa.address().port}`}),b.ask('advertise',{address:`127.0.0.1:${pb.address().port}`})])
 await Promise.all([a.wait(x=>x.event==='paths'&&x.paths.some(p=>p.isSelected&&p.isIp),'client direct'),b.wait(x=>x.event==='paths'&&x.paths.some(p=>p.isSelected&&p.isIp),'server direct')])
 result.checks.push('direct UDP selected through controlled proxy')
 if(early) {
   const sent=await early
   await b.wait(x=>x.event==='received'&&x.sha256===sent.sha256,'queued pre-direct stream')
   result.checks.push('stream queued during relay-only setup arrives only after direct path opens')
 }
 for(const [sender,receiver,byte] of [[a,b,51],[b,a,52]]) {
   const dg=await sender.ask('datagram',{byte})
   await receiver.wait(x=>x.event==='datagramReceived'&&x.sha256===dg.sha256,'datagram receiver hash')
   await sender.ask('bidirectional')
 }
 result.checks.push('bidirectional streams and datagrams verified in both endpoint roles')
 const before=await metric();const transfer=await a.ask('send',{size:262144,byte:45});const recv=await b.wait(x=>x.event==='received'&&x.sha256===transfer.sha256,'direct transfer');assert.equal(recv.length,transfer.length)
 result.checks.push('application transfer after setup verified byte-for-byte');result.beforeCut={metrics:await metric(),beforeTransfer:before,client:await a.ask('snapshot'),server:await b.ask('snapshot')}
 gateOpen=false; const markerA=a.history.length, markerB=b.history.length; journal({event:'cutDirect',forwarded,dropped})
 const baselineReceived=result.beforeCut.server.received.length
 const fallback=a.ask('send',{size:262144,byte:79}).then(value=>({delivered:true,...value}),error=>({delivered:false,error:String(error)}))
 if(mode==='control'){
   result.afterCut=await fallback
   assert(result.afterCut.delivered)
   await b.wait(x=>x.event==='received'&&x.sha256===result.afterCut.sha256,'fallback receiver')
   result.checks.push('default control delivers second payload through relay after UDP cut')
 } else {
   await Promise.all([a.wait(x=>x.event==='paths'&&x.paths.some(p=>p.isSelected&&p.isRelay),'client relay selected after cut',markerA), b.wait(x=>x.event==='paths'&&x.paths.some(p=>p.isSelected&&p.isRelay),'server relay selected after cut',markerB)])
   const holdMs=Number(process.env.IROH_HOLD_MS??31000)
   if(holdMs) await new Promise(resolve=>setTimeout(resolve,holdMs))
   result.blocked={client:await a.ask('snapshot'),server:await b.ask('snapshot'),holdMs}
   assert.equal(result.blocked.server.received.length,baselineReceived,'no payload while only relay available')
   assert.equal(result.blocked.client.closed,null,'relay control kept connection alive')
   result.checks.push('queued application payload stays blocked while relay control remains live')
   gateOpen=true
   await Promise.all([a.ask('advertise',{address:`127.0.0.1:${pa.address().port}`}),b.ask('advertise',{address:`127.0.0.1:${pb.address().port}`})])
   const expected=(await import('node:crypto')).createHash('sha256').update(Buffer.alloc(262144,79)).digest('hex')
   const received=await b.wait(x=>x.event==='received'&&x.sha256===expected,'restored queued payload',0,90000)
   assert.equal(received.length,262144)
   result.afterCut=await fallback
   result.checks.push('restoring direct UDP delivers the queued payload with the expected hash')
 }
 if(mode==='strict') {
   const markerA=a.history.length, markerB=b.history.length
   await a.ask('disconnect')
   await a.ask('connect',{peer:br.id,proxyPort:pb.address().port})
   await Promise.all([a.wait(x=>x.event==='paths'&&x.paths.some(p=>p.isSelected&&p.isIp),'client reconnect direct',markerA),b.wait(x=>x.event==='paths'&&x.paths.some(p=>p.isSelected&&p.isIp),'server reconnect direct',markerB)])
   const sent=await a.ask('send',{size:16384,byte:99})
   await b.wait(x=>x.event==='received'&&x.sha256===sent.sha256,'reconnected receiver')
   result.checks.push('explicit reconnect retains strict policy and transfers directly')
 }
 result.final={metrics:await metric(),client:await a.ask('snapshot'),server:await b.ask('snapshot'),forwarded,dropped}
 result.status='PASS'
} catch(error){result.status='FAIL';result.error=String(error);process.exitCode=1}
finally {
 for(const w of [a,b])if(w&&w.child.exitCode===null)try{await w.ask('close');if(w.child.exitCode===null)await bounded(once(w.child,'exit'),'graceful worker exit',5000)}catch(error){result.cleanupError=String(error);result.status='FAIL';process.exitCode=1}
 await Promise.all(sockets.map(s=>new Promise(resolve=>{try{s.close(resolve)}catch{resolve()}})))
 for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM')
 await Promise.all(children.map(c=>c.exitCode!==null||c.signalCode!==null?null:once(c,'exit')))
 result.workerResources=[a,b].filter(Boolean).map(w=>w.history.find(x=>x.event==='resourcesAtExit'))
 if(result.workerResources.some(x=>!x?.closed)){result.status='FAIL';result.cleanupError='missing closed worker exit evidence';process.exitCode=1}
 result.cleanup=children.map(c=>({pid:c.pid,exitCode:c.exitCode,signal:c.signalCode}))
 fs.writeFileSync(path.join(run,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,mode,run,checks:result.checks,error:result.error,cleanup:result.cleanup}));
}
