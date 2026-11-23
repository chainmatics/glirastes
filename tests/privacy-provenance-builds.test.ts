import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe,expect,it} from 'vitest';
import {z} from 'zod';
import {createPrivacyBoundary} from '../src/server/pii-shield/model-boundary.js';
import {memoryShield,testScope,providerAdapters} from '../src/server/pii-shield/__tests__/privacy-fixtures.js';
import {generateText} from 'ai';
const require=createRequire(import.meta.url);
type Core=typeof import('../src/server/core/index.js');
type Boundary=typeof import('../src/server/pii-shield/tool-boundary.js');
const esmCore=await import(/* @vite-ignore */pathToFileURL(resolve('dist/server/core/index.js')).href) as Core;
const esmBoundary=await import(/* @vite-ignore */pathToFileURL(resolve('dist/server/pii-shield/tool-boundary.js')).href) as Boundary;
const cjsCore=require('../dist/cjs/server/core/index.js') as Core;
const cjsBoundary=require('../dist/cjs/server/pii-shield/tool-boundary.js') as Boundary;
describe('execute-only adapters between published module formats',()=>{
  for(const [name,core,other] of [['CJS to ESM',cjsCore,esmBoundary],['ESM to CJS',esmCore,cjsBoundary]] as const){
    it(`${name} preserves protected failure projection and approval`,async()=>{
      const canary='BuildBoundaryIdentityCanary'+'X'.repeat(1600);
      const boundary=createPrivacyBoundary({session:await memoryShield().open(testScope())});
      await boundary.session.registerIdentities([{name:canary}]);
      const converted=core.toolToAiTool({id:'read',description:'Read',inputSchema:z.object({}),execute:async()=>({success:false,error:canary})},{currentDate:new Date(),locale:'en'});
      const wrapped=other.wrapToolsForPrivacy({read:{execute:converted.execute,needsApproval:true}},boundary);
      expect(wrapped.read.needsApproval).toBe(true);
      const result=await wrapped.read.execute({});
      expect(result).toMatchObject({success:false,error:'tool_execution_failed'});
      const adapter=providerAdapters().openrouter;
      await generateText({model:boundary.wrapModel(adapter.model),messages:[{role:'user',content:'Read'},
        {role:'assistant',content:[{type:'tool-call',toolName:'read',toolCallId:'c',input:{}}]},
        {role:'tool',content:[{type:'tool-result',toolName:'read',toolCallId:'c',output:{type:'json',value:result as never}}]},
      ]});
      expect(adapter.requests).toHaveLength(1);expect(JSON.stringify(adapter.requests)).not.toContain('BuildBoundaryIdentityCanary');
    });
    it(`${name} refuses an execute-only result reader`,async()=>{
      const store=core.createResultStore();
      const overview=await store.put({toolName:'read',readOnly:true,maxChars:1000,value:{description:'StoredIdentityCanary'+'X'.repeat(5000)}}) as {_result:{id:string}};
      const reader=core.createReadResultTool(store);
      const boundary=createPrivacyBoundary({session:await memoryShield().open(testScope())});
      const wrapped=other.wrapToolsForPrivacy({read:{execute:reader.execute}},boundary);
      expect(await wrapped.read.execute!({resultId:overview._result.id,fields:['description']},{} as never)).toMatchObject({success:false,error:{code:'privacy_result_handles_unsupported'}});
    });
  }
});
