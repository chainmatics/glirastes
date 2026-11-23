import {describe,it,expect} from 'vitest';
import {createResultStore,createReadResultTool,toolToAiTool} from '../index.js';
describe('owner-bound external SDK reader',()=>{
 it.each(['same','subject','tenant','missing'])('enforces current owner for %s',async(change)=>{
  let owner: {subjectId:string;tenantId:string}|undefined={subjectId:'alice',tenantId:'tenant-a'};
  const store=createResultStore({owner:async()=>owner});
  const overview=await store.put({toolName:'list',readOnly:true,maxChars:1000,value:{success:true,privateValue:'SyntheticAliceRecord',padding:'x'.repeat(5000)},owner:{...owner}}) as any;
  expect(overview._result.id).toBeTruthy();
  const reader=createReadResultTool(store);
  if(change==='subject')owner={subjectId:'bob',tenantId:'tenant-a'};
  if(change==='tenant')owner={subjectId:'alice',tenantId:'tenant-b'};
  if(change==='missing')owner=undefined;
  const result=await toolToAiTool(reader,{} as any,'read_result').execute({resultId:overview._result.id,fields:['privateValue']});
  if(change==='same')expect(result).toMatchObject({privateValue:'SyntheticAliceRecord'});
  else expect(JSON.stringify(result)).not.toContain('SyntheticAliceRecord');
 });
});

describe('owner and store changes across asynchronous read guards',()=>{
 it.each(['subject','tenant','missing','throw','deleted'])('refuses %s changed by the read guard',async(change)=>{
  let current:{subjectId:string;tenantId:string}|undefined={subjectId:'alice',tenantId:'tenant-a'};
  let failure=false;
  const store=createResultStore({owner:async()=>{if(failure)throw new Error('SyntheticPrivateError');return current;}});
  const overview=await store.put({toolName:'list',readOnly:true,maxChars:1000,value:{success:true,privateValue:'SyntheticAliceRecord',padding:'x'.repeat(5000)},owner:{...current}}) as {_result:{id:string}};
  const reader=createReadResultTool(store,{beforeRead:async()=>{
   if(change==='subject')current={subjectId:'bob',tenantId:'tenant-a'};
   if(change==='tenant')current={subjectId:'alice',tenantId:'tenant-b'};
   if(change==='missing')current=undefined;
   if(change==='throw')failure=true;
   if(change==='deleted')store.clear();
  }});
  const result=await toolToAiTool(reader,{} as never,'read_result').execute({resultId:overview._result.id,fields:['privateValue']});
  expect(result).toMatchObject({error:change==='deleted'?'result_expired':'result_denied'});
  expect(JSON.stringify(result)).not.toMatch(/SyntheticAliceRecord|SyntheticPrivateError/);
 });
});
