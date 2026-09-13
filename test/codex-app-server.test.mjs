import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerClient } from '../src/codex-app-server-client.mjs';
import { parseCodexApps } from '../src/codex-computer.mjs';

const server = `
import {createInterface} from 'node:readline';
let waiting;
const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
const content=text=>({content:[{type:'text',text}]});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.jsonrpc)throw Error('Unexpected MCP header');
 if(m.method==='initialize'){if(m.params.clientInfo.name!=='codex-link')throw Error('Client identity');send(m.id,{});}
 else if(m.method==='thread/start'){if(m.params.ephemeral!==true)throw Error('Persistent session');send(m.id,{thread:{id:'temporary',ephemeral:true}});}
 else if(m.method==='mcpServer/tool/call'){
  if(m.params.threadId!=='temporary'||m.params.server!=='cua_repl'||!['js','js_reset'].includes(m.params.tool))throw Error('Wrong tool');
  if(m.params.tool==='js_reset'){send(m.id,content('Runtime reset'));return;}
  const code=m.params.arguments.code;
  if(code.startsWith('let target')){waiting=m.id;process.stdout.write(JSON.stringify({id:'approval',method:'mcpServer/elicitation/request',params:{threadId:'temporary',serverName:'cua_repl',turnId:null,mode:'form',message:'Allow Calculator?',requestedSchema:{type:'object',properties:{}}}})+'\\n');}
  else if(code.includes('inventory.apps'))send(m.id,content(JSON.stringify({apps:[{id:'com.apple.calculator',displayName:'Calculator',isRunning:true}]})));
  else if(code.includes('getAXStateAndScreenshot'))send(m.id,{content:[{type:'text',text:'24 button Change Sign'},{type:'image',data:'image',mimeType:'image/png'}]});
  else send(m.id,content(code));
 } else if(m.id==='approval')send(waiting,content(m.result.action));
});`;
const create = t => { const c = new CodexAppServerClient({ executable: process.execPath, args: ['--input-type=module','-e',server] }); t.after(()=>c.close()); return c; };
test('raw REPL forwards model code unchanged and exposes upstream reset', async t => {
 const c=create(t);await c.initialize();
 const code='let discord = await cua.getApp("com.hnc.Discord");';
 const r=await c.replCall('js',{code,title:'Inspect Discord'});
 assert.equal(r.content[0].text,code);
 assert.equal((await c.replCall('js_reset',{})).content[0].text,'Runtime reset');
 await assert.rejects(c.replCall('other',{}),/Unsupported/);
});
test('app-server uses ephemeral sessions and returns structured app inventory', async t => {
 const c=create(t); await c.initialize(); const apps=parseCodexApps(await c.call('list_apps',{}));
 assert.equal(apps[0].appId,'com.apple.calculator'); assert.equal(apps[0].targetKind,'app-key-window'); assert.equal(apps[0].running,true);
});
test('app-server forwards consent, binds one app and quotes text as data', async t => {
 const c=create(t); await c.initialize(); let count=0;
 const observed=await c.call('get_app_state',{app:'com.apple.calculator'},{requestApproval:async r=>{count++;assert.equal(r.message,'Allow Calculator?');return true;}});
 assert.equal(count,1); assert.equal(observed.content[1].type,'image');
 const text='\"); throw new Error("injection"); //\n` ${untrusted}';
 const typed=await c.call('type_text',{app:'com.apple.calculator',text});
 assert.equal(typed.content[0].text,`await target.typeText(${JSON.stringify(text)}); await target.getAXState();`);
 await assert.rejects(c.call('click',{app:'another',element_index:'24'}),/cannot switch/);
 await assert.rejects(c.call('click',{app:'com.apple.calculator',element_index:'24); evil()'}),/numeric element/);
 const click=await c.call('click',{app:'com.apple.calculator',element_index:'24'});
 assert.match(click.content[0].text,/target.click\(24,/);
});
test('app-server cancels missing consent and honors owner rejection', async t => {
 const c=create(t); await c.initialize();
 await assert.rejects(c.call('get_app_state',{app:'com.apple.calculator'}),/approval/);
 await assert.rejects(c.call('get_app_state',{app:'com.apple.calculator'},{requestApproval:async()=>false}),/denied/);
});
test('app-server cancellation closes an awaiting consent call without input replay', async t => {
 const c=create(t); await c.initialize(); const controller=new AbortController();
 const pending=c.call('get_app_state',{app:'com.apple.calculator'},{signal:controller.signal,requestApproval:()=>new Promise(()=>{})});
 controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(c.closed,true);assert.equal(c.pending.size,0);
});
