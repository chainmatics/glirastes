import {describe,it,expect} from 'vitest';
import {createOpenAI} from '@ai-sdk/openai';
import {createResultStore,createReadResultTool,toolToAiTool} from '../index.js';
import {createPrivacyBoundary} from '../../pii-shield/model-boundary.js';
import {wrapToolsForPrivacy} from '../../pii-shield/tool-boundary.js';
import {memoryShield,testScope,captureFetch} from '../../pii-shield/__tests__/privacy-fixtures.js';
const sensitive='ConfidentialIdentityPrefix'+'x'.repeat(5000);
describe('exported protected tool boundary',()=>{
 it.each(['direct','copied','execute-only','core-converted','converted-copy','core-protected','ordinary-full-result'])('rejects SDK reader supplied %s',async(mode)=>{
  const store=createResultStore();
  const overview=await store.put({toolName:'list',readOnly:true,maxChars:1000,value:{success:true,description:sensitive}}) as any;
  const reader=createReadResultTool(store);
  const session=await memoryShield().open(testScope());await session.registerIdentities([{name:sensitive}]);
  const boundary=createPrivacyBoundary({session});
  const tool=mode==='ordinary-full-result'?{execute:async()=>({description:sensitive})}:mode==='direct'?reader:mode==='copied'?{...reader,id:'renamed'}:mode==='execute-only'?{execute:reader.execute}:mode==='converted-copy'?{...toolToAiTool(reader,{} as any,'renamed')}:toolToAiTool(reader,{} as any,'read_result',mode==='core-protected'?{protectedResults:true}:undefined);
  const wrapped=wrapToolsForPrivacy({read_result:tool},boundary);
  const result=await wrapped.read_result.execute!({resultId:overview._result.id,fields:['description']},{} as any);
  if(mode!=='ordinary-full-result')expect(result).toMatchObject({success:false,error:{code:'privacy_result_handles_unsupported'}});
  const captured=captureFetch('openai-chat');
  const model=boundary.wrapModel(createOpenAI({apiKey:'fixture',fetch:captured.fetch as any}).chat('fixture'));
  await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'Read result'}]},{role:'assistant',content:[{type:'tool-call',toolCallId:'r',toolName:'read_result',input:{resultId:overview._result.id,fields:['description']}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'r',toolName:'read_result',output:{type:'json',value:result}}]}]} as any);
  const leaked=captured.requests.some(r=>r.body.includes('ConfidentialIdentityPrefix'));
  expect(leaked).toBe(false);
 });
});
