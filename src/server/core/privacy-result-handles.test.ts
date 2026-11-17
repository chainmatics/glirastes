import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type ToolContext } from '../../types.js';
import { createReadResultTool, createResultStore, toolToAiTool } from './index.js';

const secret = 'SyntheticKnownIdentity' + 'x'.repeat(5000);
describe('protected result handles are explicitly unsupported', () => {
  it('does not persist raw results or capture owners even with an injected store', async () => {
    const owner = vi.fn(async () => ({subjectId:'alice',tenantId:'tenant'}));
    const store = createResultStore({ owner });
    const put = vi.spyOn(store,'put');
    const execute = vi.fn(async () => ({success:true,description:secret}));
    const tool = defineTool({id:'tool',description:'Read synthetic person',inputSchema:z.object({}),execute});
    const output = await toolToAiTool(tool,{} as ToolContext,'read_person',{protectedResults:true,resultStore:store,maxResultChars:1000}).execute({});
    expect(output).toMatchObject({success:true,outputWithheld:true});
    expect(JSON.stringify(output)).not.toContain('SyntheticKnownIdentity');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
  });
  it.each(['current','foreign-scope','deleted'] as const)('refuses an externally registered reader before %s handle access', async (state) => {
    let subjectId='alice';
    const store=createResultStore({owner:async()=>({subjectId,tenantId:'tenant'})});
    const overview=await store.put({toolName:'read_person',readOnly:true,maxChars:1000,value:{success:true,description:secret},owner:{subjectId:'alice',tenantId:'tenant'}}) as {_result:{id:string}};
    if(state==='foreign-scope')subjectId='bob';
    if(state==='deleted')store.clear();
    const reader=createReadResultTool(store);
    const execute=vi.spyOn(reader,'execute');
    const output=await toolToAiTool(reader,{} as ToolContext,'renamed_reader',{protectedResults:true,resultStore:store}).execute({resultId:overview._result.id,fields:['description']});
    expect(output).toMatchObject({success:false,error:{code:'privacy_result_handles_unsupported'}});
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).not.toContain('SyntheticKnownIdentity');
  });
});
