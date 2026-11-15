#!/usr/bin/env python3
# Owned real Claude lifecycle fixture. Requires pexpect; local API stub only.
import os,json,tempfile,subprocess,threading,http.server,time,pathlib,uuid
BASE=pathlib.Path(os.environ.get('AIT_CLAUDE_NATIVE_EVIDENCE',tempfile.gettempdir())); BASE.mkdir(parents=True,exist_ok=True)
os.environ.setdefault('FIXTURE_NONBARE','1')
root=pathlib.Path(tempfile.mkdtemp(prefix='native-',dir=BASE)).resolve();home=root/'home';cfg=root/'config';project=root/'project'
for p in [home,cfg,project]:p.mkdir()
requests=[]
class Api(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  n=int(self.headers.get('content-length','0'));data=json.loads(self.rfile.read(n) or '{}');requests.append({'path':self.path,'model':data.get('model'),'stream':data.get('stream')})
  response={'id':'msg_fixture','type':'message','role':'assistant','model':data.get('model','claude-sonnet-4-6'),'content':[{'type':'text','text':'fixture ready'}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':2}}
  if 'count_tokens' in self.path:body=json.dumps({'input_tokens':1}).encode();typ='application/json'
  elif data.get('stream'):
   initial=dict(response,content=[],stop_reason=None);initial['usage']={'input_tokens':1,'output_tokens':0}
   events=[('message_start',{'type':'message_start','message':initial}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'fixture ready'}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':2}}),('message_stop',{'type':'message_stop'})]
   body=''.join('event: '+kind+'\ndata: '+json.dumps(value)+'\n\n' for kind,value in events).encode();typ='text/event-stream'
  else:body=json.dumps(response).encode();typ='application/json'
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Api);threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ)
for k in list(env):
 if k.startswith(('AIT_','ANTHROPIC_','CLAUDE_CODE_SESSION','CLAUDECODE','CODEX_')):env.pop(k,None)
env.update(HOME=str(home),CLAUDE_CONFIG_DIR=str(cfg),ANTHROPIC_API_KEY='fixture-not-a-real-key',ANTHROPIC_BASE_URL='http://127.0.0.1:'+str(server.server_port),DISABLE_TELEMETRY='1',DISABLE_ERROR_REPORTING='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',TERM='xterm-256color')
# All children have no external network and cannot write into the real home.
profile='(version 1)(allow default)(deny network*)(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(deny file-write* (subpath "'+str(pathlib.Path.home())+'"))'
import re
status=subprocess.run([__import__('shutil').which('claude'),'daemon','status'],env=env,cwd=project,capture_output=True,text=True,timeout=15)
(root/'daemon-before.txt').write_text(status.stdout+status.stderr)
assert 'not running' in status.stdout
sockdir=re.search(r'sock dir:\s+(/tmp/cc-daemon-[0-9]+/[a-f0-9]+)',status.stdout).group(1)
assert (root/'daemon-before.txt').exists()
for prefix in [sockdir,sockdir.replace('/tmp/','/private/tmp/',1)]:
 profile+='(allow network-bind (local unix-socket (regex #"^'+prefix+'/")))(allow network-inbound (local unix-socket (regex #"^'+prefix+'/")))(allow network-outbound (remote unix-socket (regex #"^'+prefix+'/")))'
claude=['sandbox-exec','-p',profile,__import__('shutil').which('claude')]
old=str(uuid.uuid4());new=str(uuid.uuid4())
def run(args,label):
 p=subprocess.run(claude+args,env=env,cwd=project,capture_output=True,text=True,timeout=40)
 (root/(label+'.out')).write_text(p.stdout);(root/(label+'.err')).write_text(p.stderr)
 print(label,p.returncode,p.stdout[-800:],p.stderr[-400:],flush=True);return p
try:
 p=run(([] if os.environ.get('FIXTURE_NONBARE') else ['--bare'])+['--session-id',old,'-p','Reply ready','--model','claude-sonnet-4-6','--output-format','json'],'seed')
 assert p.returncode==0, 'native seed failed'
 if p.returncode==0:
  p=run(([] if os.environ.get('FIXTURE_NONBARE') else ['--bare'])+['--resume',old,'--fork-session','--session-id',new,'-p','Reply again','--model','claude-sonnet-4-6','--output-format','json'],'manual-fork')
 # Interactive native backgrounding with a fixture MCP, never real model services.
 import pexpect
 mcp=root/'mcp.py'
 mcp.write_text("""import sys,json,os,subprocess,time,pathlib
for line in sys.stdin:
 try:o=json.loads(line)
 except:continue
 sid=os.environ.get('CLAUDE_CODE_SESSION_ID','')
 try: job=json.loads((pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])/'jobs'/sid[:8]/'state.json').read_text())
 except FileNotFoundError: job=None
 receipt={'at':time.time(),'pid':os.getpid(),'ppid':os.getppid(),'method':o.get('method'),'params':o.get('params') if o.get('method')=='initialize' else None,'session':sid,'job':{k:job.get(k) for k in ['sessionId','state','respawnFlags']} if job else None,'harnessKeys':[k for k in os.environ if k.startswith('CLAUDE_CODE_')],'harnessRole':{k:os.environ[k] for k in ['CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_IS_BACKGROUND','CLAUDE_CODE_BG_JOB_ID','CLAUDE_CODE_JOB_ID'] if k in os.environ}}
 with open(os.environ['FIXTURE_MCP_LOG'],'a') as f:f.write(json.dumps(receipt)+'\\n')
 if 'id' not in o:continue
 if o.get('method')=='initialize':result={'protocolVersion':o['params']['protocolVersion'],'capabilities':{'tools':{},'experimental':{'claude/channel':{}}},'serverInfo':{'name':'ait-protocol','version':'fixture'}}
 elif o.get('method')=='tools/list':result={'tools':[]}
 else:result={}
 print(json.dumps({'jsonrpc':'2.0','id':o['id'],'result':result}),flush=True)
""")
 env['FIXTURE_MCP_LOG']=str(root/'mcp.jsonl')
 mcp_config=root/'mcp.json';mcp_config.write_text(json.dumps({'mcpServers':{'ait-protocol':{'command':'/usr/bin/python3','args':[str(mcp)],'env':{'FIXTURE_MCP_LOG':str(root/'mcp.jsonl')}}}}))
 hook=root/'hook.py';hook.write_text("import sys,json\nfrom pathlib import Path\no=json.load(sys.stdin)\nwith open(sys.argv[1],'a') as f:f.write(json.dumps({k:v for k,v in o.items() if k not in ['prompt','tool_input','tool_response']})+'\\n')\n")
 settings=root/'settings.json';settings.write_text(json.dumps({'enableAllProjectMcpServers':True,'theme':'dark','skipDangerousModePermissionPrompt':True,'hooks':{event:[{'hooks':[{'type':'command','command':'/usr/bin/python3 '+str(hook)+' '+str(root/'hooks.jsonl')}]}] for event in ['SessionStart','SessionEnd']}}))
 config_file=cfg/'.claude.json';config=json.loads(config_file.read_text());config.update(hasCompletedOnboarding=True,theme='dark',customApiKeyResponses={'approved':['fixture-not-a-real-key'[-20:]],'rejected':[]},projects={str(project):{'hasTrustDialogAccepted':True}});config_file.write_text(json.dumps(config))
 args=claude[1:]+([] if os.environ.get('FIXTURE_NONBARE') else ['--bare'])+['--resume',old,'--model','claude-sonnet-4-6','--settings',str(settings),'--mcp-config',str(mcp_config)]+([] if os.environ.get('FIXTURE_NO_CHANNEL') else ['--dangerously-load-development-channels','server:ait-protocol'])
 terminal=pexpect.spawn(claude[0],args,env=env,cwd=str(project),encoding='utf-8',timeout=15,dimensions=(35,130))
 log=(root/'terminal.log').open('w');terminal.logfile=log
 try:
  import re
  seen=set(); raw=''; deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   try: raw+=terminal.read_nonblocking(65536,timeout=.3)
   except pexpect.TIMEOUT:pass
   except pexpect.EOF:raise Exception('terminal ended '+raw[-1000:])
   if '\x1b[6n' in raw and 'cursor' not in seen:terminal.send('\x1b[1;1R');seen.add('cursor')
   cleaned=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',raw)
   compact=re.sub(r'\s+','',cleaned)
   if 'DoyouwanttousethisAPIkey?' in compact and 'api' not in seen:terminal.send('\x1b[A\r');seen.add('api');print('accepted fixture key',flush=True)
   if 'Iamusingthisforlocaldevelopment' in compact and 'channel' not in seen:terminal.send('\r');seen.add('channel');print('accepted dev channel',flush=True)
   if ('Yes,Itrust' in compact or 'trustthisfolder' in compact) and 'trust' not in seen:terminal.send('\x1b[B\r');seen.add('trust')
   if ('UsethisMCPserver' in compact or 'MCPserverfound' in compact) and 'mcp' not in seen:terminal.send('\r');seen.add('mcp')
   if 'Choose' in compact and 'textstyle' in compact and 'theme' not in seen:terminal.send('\r');seen.add('theme')
   if (root/'mcp.jsonl').exists() and 'notifications/initialized' in (root/'mcp.jsonl').read_text():
    time.sleep(1); print('MCP initialized',flush=True);break
  assert (root/'mcp.jsonl').exists() and 'notifications/initialized' in (root/'mcp.jsonl').read_text(), 'foreground MCP did not initialize: '+compact[-1200:]
  print('terminal before bg',compact[-1200:],flush=True)
  terminal.send(os.environ.get('FIXTURE_COMMAND','/bg')+'\r');time.sleep(8)
  try:terminal.read_nonblocking(65536,timeout=2)
  except:pass
  print('bg control sent',flush=True)
  native_list=subprocess.run(claude+['agents','--json'],env=env,cwd=project,capture_output=True,text=True,timeout=15)
  (root/'agents.json').write_text(native_list.stdout)
  observations=[]
  if (root/'mcp.jsonl').exists():
   for line in (root/'mcp.jsonl').read_text().splitlines():
    o=json.loads(line)
    if o['method']=='initialize':
     p=subprocess.run(['ps','-o','command=','-p',str(o['ppid'])],capture_output=True,text=True);o['parentArgv']=p.stdout.strip();observations.append(o)
  (root/'mcp-initialize-receipt.json').write_text(json.dumps(observations,indent=2))
  terminal.send('\x1b');time.sleep(.5)
 finally:
  terminal.close(force=True);log.close()
 assert p.returncode==0, 'native manual fork failed'
 files=list(cfg.glob('projects/**/*.jsonl')); records={}
 for f in files:
  values=[]
  for l in f.read_text().splitlines():
   try:o=json.loads(l)
   except:continue
   if o.get('type')=='continued-in':values.append(o)
  records[str(f.relative_to(root))]=values
 result={'root':str(root),'old':old,'manual_fork_uuid':new,'background_uuid':next((v[0].get('continuedInSessionId') for v in records.values() if v),None),'requests':requests,'continued_records':records}
 (root/'result.json').write_text(json.dumps(result,indent=2))
 if os.environ.get('FIXTURE_COMMAND','/bg')=='/bg':
  assert result['background_uuid'], 'native /bg did not write a continuation'
  worker=[o for o in observations if o['session']==result['background_uuid']]
  assert worker, 'native background MCP did not initialize'
  record=next(v[0] for v in records.values() if v)
  result['childInitializeDelayMs']=(worker[0]['at']-__import__('datetime').datetime.fromisoformat(record['timestamp'].replace('Z','+00:00')).timestamp())*1000
  assert any(o['session']==old for o in observations)
  # Native resume correctly refuses an active background worker. Attach to
  # that owned worker, give it a stub-backed prompt so it saves a transcript,
  # then stop it using the supported command before testing foreground resume.
  attached=pexpect.spawn(claude[0],claude[1:]+['attach',result['background_uuid'][:8]],env=env,cwd=str(project),encoding='utf-8',timeout=15,dimensions=(35,130))
  attach_log=(root/'attach.log').open('w');attached.logfile=attach_log
  try:
   time.sleep(2)
   try: attached.read_nonblocking(65536,timeout=1)
   except pexpect.TIMEOUT: pass
   attached.send('Reply ready'+chr(13))
   until=time.monotonic()+20
   saved=[]
   while time.monotonic()<until:
    try: attached.read_nonblocking(65536,timeout=.3)
    except pexpect.TIMEOUT: pass
    saved=list(cfg.glob('projects/**/'+result['background_uuid']+'.jsonl'))
    if saved: break
   assert saved, 'native attached worker did not save its transcript'
   result['backgroundTranscript']=str(saved[0].relative_to(cfg))
  finally:
   attached.close(force=True);attach_log.close()
  stopped=run(['stop',result['background_uuid'][:8]],'continued-stop')
  assert stopped.returncode==0
  if os.environ.get('FIXTURE_RESPAWN'):
   prior=sum(1 for l in (root/'mcp.jsonl').read_text().splitlines() if (lambda o:o.get('method')=='initialize' and o.get('session')==result['background_uuid'])(json.loads(l)))
   until=time.monotonic()+8
   while True:
    agents=subprocess.run(claude+['agents','--json'],env=env,cwd=project,capture_output=True,text=True,timeout=15)
    active=[o for o in json.loads(agents.stdout) if o.get('sessionId')==result['background_uuid'] and o.get('pid')]
    if not active:break
    assert time.monotonic()<until, 'native worker did not stop'
    time.sleep(.1)
   revive=pexpect.spawn(claude[0],claude[1:]+['attach',result['background_uuid'][:8]],env=env,cwd=str(project),encoding='utf-8',timeout=15,dimensions=(35,130))
   revive_log=(root/'respawn-attach.log').open('w');revive.logfile=revive_log
   try:
    until=time.monotonic()+20
    while time.monotonic()<until:
     try:revive.read_nonblocking(65536,timeout=.3)
     except pexpect.TIMEOUT:pass
     initialized=[json.loads(l) for l in (root/'mcp.jsonl').read_text().splitlines() if (lambda o:o.get('method')=='initialize' and o.get('session')==result['background_uuid'])(json.loads(l))]
     if len(initialized)>prior:break
    assert len(initialized)>prior, 'stopped native worker did not initialize a new MCP on attach'
    result['respawnInitializeJob']=initialized[-1]['job']
    assert result['respawnInitializeJob']['state'] in ['working','blocked','running'], 'respawn MCP saw a terminal job state'
   finally:revive.close(force=True);revive_log.close()
   stopped=run(['stop',result['background_uuid'][:8]],'continued-stop-after-respawn')
   assert stopped.returncode==0
  until=time.monotonic()+10;attempt=0
  while True:
   attempt+=1
   resumed=run(['--resume',result['background_uuid'],'--mcp-config',str(mcp_config),'-p','Reply ready','--model','claude-sonnet-4-6','--output-format','json'],'continued-resume-'+str(attempt))
   if resumed.returncode==0 or 'session is running in the background' not in resumed.stderr:break
   assert time.monotonic()<until, 'native stop did not finish'
   time.sleep(.2)
  # Esc/attach must not revive delivery from the retained original runtime.
  check_env=dict(env,CLAUDE_CODE_SESSION_ID=old)
  module=(pathlib.Path(__file__).resolve().parents[1]/'dist'/'claudeSession.js').as_uri()
  check=subprocess.run(['sandbox-exec','-p',profile,__import__('shutil').which('node'),'--input-type=module','-e',"import assert from 'node:assert/strict';const m=await import("+json.dumps(module)+");assert.equal(m.isClaudeRuntimeCurrent(),false);console.log(JSON.stringify({isClaudeRuntimeCurrent:false}))"],env=check_env,cwd=project,capture_output=True,text=True,timeout=15)
  (root/'retirement-after-attach.txt').write_text(check.stdout+check.stderr)
  (root/'retirement-after-attach-result.json').write_text(json.dumps({'exit':check.returncode,'stdout':check.stdout,'stderr':check.stderr}))
  assert check.returncode==0, 'original runtime retirement changed after attach'
  result['continuedResumeExit']=resumed.returncode
  assert resumed.returncode==0, 'native continued runtime cannot be resumed'

 else:
  assert not result['background_uuid'], 'independent /fork must not continue the original'
  states=[json.loads(f.read_text()) for f in cfg.glob('jobs/*/state.json')]
  assert any(o.get('forkParentSessionId')==old for o in states), 'native /fork did not create an independent worker'
 if os.environ.get('FIXTURE_DISPATCH'):
  view=pexpect.spawn(claude[0],claude[1:]+['agents','--model','claude-sonnet-4-6','--mcp-config',str(mcp_config),'--settings',str(settings)],env=env,cwd=str(project),encoding='utf-8',timeout=15,dimensions=(35,130))
  view_log=(root/'dispatch.log').open('w');view.logfile=view_log
  before={str(f) for f in cfg.glob('jobs/*/state.json')}
  try:
   time.sleep(2)
   try:view.read_nonblocking(65536,timeout=1)
   except pexpect.TIMEOUT:pass
   view.send('Reply ready'+chr(13))
   until=time.monotonic()+15
   while time.monotonic()<until:
    try:view.read_nonblocking(65536,timeout=.3)
    except pexpect.TIMEOUT:pass
    new_states=[f for f in cfg.glob('jobs/*/state.json') if str(f) not in before]
    if new_states:break
   assert new_states, 'agent view did not dispatch a new worker'
   result['dispatchState']=json.loads(new_states[0].read_text())
   time.sleep(2)
  finally:view.close(force=True);view_log.close()
 (root/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
finally:
 status=subprocess.run([__import__('shutil').which('claude'),'daemon','status'],env=env,cwd=project,capture_output=True,text=True,timeout=15)
 (root/'daemon-after.txt').write_text(status.stdout+status.stderr)
 if 'not running' not in status.stdout:
  assert sockdir in status.stdout
  cleanup=subprocess.run([__import__('shutil').which('claude'),'daemon','stop','--any'],env=env,cwd=project,capture_output=True,text=True,timeout=15)
  (root/'daemon-cleanup.txt').write_text(cleanup.stdout+cleanup.stderr)
 after=subprocess.run([__import__('shutil').which('claude'),'daemon','status'],env=env,cwd=project,capture_output=True,text=True,timeout=15)
 assert 'not running' in after.stdout, 'fixture daemon remained running'
 server.shutdown()
