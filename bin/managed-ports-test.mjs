// Real start entry point, copied to an owned fixture. Refusal must precede any
// child launch; no process discovery, service, or installed configuration runs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const repo = fileURLToPath(new URL('..', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-managed-ports-'))
try {
  for (const dir of ['bin','plc','pds','appview','logs']) fs.mkdirSync(path.join(root,dir))
  for (const file of ['start-all.sh','lib-service-pids.sh']) fs.copyFileSync(path.join(repo,'bin',file),path.join(root,'bin',file))
  fs.mkdirSync(path.join(root,'appview/node_modules'))
  fs.symlinkSync(path.join(repo,'appview/node_modules/dotenv'),path.join(root,'appview/node_modules/dotenv'))
  const env = { ...process.env, AIT_LOG_DIR: path.join(root,'logs') }
  for (const key of ['PORT','PDS_PORT','APPVIEW_PORT']) delete env[key]
  const set = (plc='',pds='',appview='') => {
    for (const [name,text] of [['plc',plc],['pds',pds],['appview',appview]]) fs.writeFileSync(path.join(root,name,'.env'),text)
  }
  const preflight = overrides => spawnSync('/bin/bash',['-c','. "$1/bin/lib-service-pids.sh"; check_managed_ports','fixture',root],{env:{...env,...overrides},encoding:'utf8'})
  set(); assert.equal(preflight().status,0)
  set('PORT=2582\n','PDS_PORT=2583\n','APPVIEW_PORT=2585\n'); assert.equal(preflight().status,0)
  for (const [key,contents,message] of [
    ['plc','PORT=7777\n','PLC PORT=2582'],
    ['pds','PDS_PORT=7777\n','PDS_PORT=2583'],
    ['appview','APPVIEW_PORT=7777\n','APPVIEW_PORT=2585'],
  ]) {
    set(); fs.writeFileSync(path.join(root,key,'.env'),contents)
    const child=spawnSync('/bin/bash',[path.join(root,'bin/start-all.sh')],{env,encoding:'utf8',timeout:5000})
    assert.equal(child.status,1,`${key}: ${child.stderr}`)
    assert.ok(child.stderr.includes(message),child.stderr)
    assert.ok(!/started |waiting for |already running/.test(child.stdout),child.stdout)
  }
  set(); assert.equal(preflight({APPVIEW_PORT:'7777'}).status,1)
  set('PORT=2582\n','PDS_PORT=2583\n','APPVIEW_PORT=7777\n')
  assert.equal(preflight({APPVIEW_PORT:'2585'}).status,0,'AppView inherited env wins over dotenv')
  set('PORT=2582\n','PDS_PORT=2583\n')
  assert.equal(preflight({PORT:'7777',PDS_PORT:'7777'}).status,0,'sourced PLC/PDS values win')
  console.log('PASS managed ports: real startup rejects unsupported ports before service work')
} finally { fs.rmSync(root,{recursive:true,force:true}) }
