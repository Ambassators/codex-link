import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerRepl } from '../src/computer-repl.mjs';
import { installComputerReplTools } from '../src/computer-repl-tools.mjs';
import { Jobs } from '../src/jobs.mjs';
import { fixture, waitJob } from './helpers.mjs';

const p={clientId:'client',grantId:'grant',scopes:['computer:use','shell:execute']};
function setup(t,{delay=0,approval=false}={}) {
 const f=fixture(t);f.config.value.dangerousModeEnabled=!approval;
 const clients=[],calls=[];let blocks=[];let now=Date.now();
 const owner={config:f.config,native:{relay:true,assertEnabled(){},rules:()=>blocks,permissionDeadline:()=>Infinity}};
 const repl=new ComputerRepl(owner,{now:()=>now,clientFactory:()=>{
  const c={closed:false,initialize:async()=>{},close(){this.closed=true},async replCall(tool,args,context){
   calls.push({client:c,tool,args});
   if(delay)await new Promise(r=>setTimeout(r,delay));
   if(args.code==='consent')await context.requestApproval({source:'Codex Computer Use',message:'Allow app?'});
   if(args.code==='transport-error'){this.closed=true;throw Error('uncertain transport');}
   return {content:[{type:'text',text:args.code||'reset'},{type:'image',mimeType:'image/png',data:'image'}],isError:args.code==='js-error',_meta:{upstream:'retained'}};
  }};clients.push(c);return c;
 }});
 owner.repl=repl;const jobs=new Jobs(f.config), definitions=new Map();
 const tools={computer:owner,config:f.config,jobs,add(name,description,schema,scopes,readOnly,handler){definitions.set(name,{handler,scopes,schema})}};
 installComputerReplTools(tools,{inlineWaitMs:5});
 const call=(name,args={},principal=p)=>definitions.get(name).handler(args,principal);
 t.after(async()=>{repl.stop();await jobs.close()});
 return {repl,jobs,clients,calls,call,definitions,block:()=>{blocks=[{decision:'block'}]},advance:ms=>{now+=ms}};
}
test('REPL persists per grant, passes raw code and resets through the upstream tool',async t=>{
 const f=setup(t);const code='let app = await cua.getApp("Calculator");';
 const r=await f.call('computer_js',{code});assert.equal(r.content[0].text,code);assert.equal(r.content[1].type,'image');assert.equal(r._meta.upstream,'retained');
 await f.call('computer_js',{code:'await app.getAXState();'});assert.equal(f.clients.length,1);
 await f.call('computer_js', {code:'other connection'}, {...p,grantId:'other'});assert.equal(f.clients.length,2);
 await f.call('computer_js_reset');assert.equal(f.calls.at(-1).tool,'js_reset');
 assert.deepEqual(f.definitions.get('computer_js').scopes,['computer:use','shell:execute']);
});
test('slow REPL calls return pending and result retrieval preserves images without replay',async t=>{
 const f=setup(t,{delay:20});const args={code:'click once',idempotencyKey:'once'};
 const pending=await f.call('computer_js',args);const jobId=pending.structuredContent.jobId;
 await waitJob(f.jobs,jobId);
 const result=await f.call('computer_js_result',{jobId});assert.equal(result.content[1].data,'image');
 assert.equal((await f.call('computer_js',args)).content[1].data,'image');assert.equal(f.calls.length,1);
 await assert.rejects(f.call('computer_js',{...args,code:'different'}),/Idempotency/);
 await assert.rejects(f.call('computer_js_result',{jobId},{...p,grantId:'other'}),/connection/);
 assert.equal(f.jobs.get(jobId).result.fetchWith,'computer_js_result');assert.ok(!JSON.stringify(f.jobs.get(jobId).result).includes('image'));
});
test('REPL local approval and upstream consent are distinct; stopping discards runtime',async t=>{
 const f=setup(t,{approval:true});const pending=await f.call('computer_js',{code:'consent'});const jobId=pending.structuredContent.jobId;
 assert.equal(pending.structuredContent.status,'awaiting_approval');assert.equal(f.calls.length,0);
 f.jobs.approve(jobId,true);await new Promise(r=>setImmediate(r));
 assert.equal(f.jobs.get(jobId).permissionRequest.source,'Codex Computer Use');
 f.jobs.approve(jobId,true);await waitJob(f.jobs,jobId);assert.equal(f.calls.length,1);
 f.repl.stop();assert.equal(f.clients[0].closed,true);
});
test('REPL respects app blocks, expires bindings, and preserves JS errors without resetting',async t=>{
 const f=setup(t);const err=await f.call('computer_js',{code:'js-error'});assert.equal(err.isError,true);
 await f.call('computer_js',{code:'corrected'});assert.equal(f.clients.length,1);
 f.advance(900001);await f.call('computer_js',{code:'fresh session'});assert.equal(f.clients.length,2);assert.equal(f.clients[0].closed,true);
 f.block();await assert.rejects(f.call('computer_js',{code:'anything'}),/app blocks/);
});
