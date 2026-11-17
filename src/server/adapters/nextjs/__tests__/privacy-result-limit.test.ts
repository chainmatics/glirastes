import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { memoryShield, testScope } from '../../../pii-shield/__tests__/privacy-fixtures.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { streamChunks } from './command-fixtures.js';

import {agentRevision,manifestRevision,policyRevision,principal,localLimits} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import {createTurnSnapshot} from '../../../../runtime/turn-snapshot.js';
import { createProviderRegistry } from '../../../pii-shield/provider-registry.js';
import type { PrivacyPolicyBlock } from '../../../../contracts/privacy-policy.js';
const sensitive = 'ConfidentialIdentityPrefix' + 'x'.repeat(5_000);

describe('protected result limits after upstream truncation integration', () => {
  for (const mode of ['protected','off','configured-off','local-stricter','signed-protected'] as const) {
 const protectedMode=mode==='protected'||mode==='local-stricter'||mode==='signed-protected';
    it(`${mode} actual provider transport for an oversized tool result`, async () => {
      const requests: string[] = [];
      const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(init?.body));
        const first = requests.length === 1;
        const delta = first
          ? {role:'assistant',tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'list_tasks',arguments:'{}'}}]}
          : {role:'assistant',content:'Done'};
        const chunk = (value: unknown, finish: string | null) => ({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:value,finish_reason:finish}]});
        return new Response([chunk(delta,null),chunk({},first?'tool_calls':'stop')].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
      };
      const execute = vi.fn(async () => ({success:true,description:sensitive}));
      const model=createOpenAI({apiKey:'fixture',fetch:fetch as typeof globalThis.fetch}).chat('fixture');
      const registry=createProviderRegistry({adapters:[{id:'fixture',qualified:true,binding:{protocol:'openai-chat',defaultEndpoint:'https://api.openai.com/v1'},createModel:()=>model}],entries:[{id:'main',label:'Main',adapter:'fixture',modelId:'fixture',secretRef:'K'}],defaultEntry:'main',secrets:()=>'fixture'});
      const signedBlock:PrivacyPolicyBlock={schemaVersion:1,profile:'protected-text/v1',screenshots:{mode:'blocked'},providers:{allowed:[{entryId:'main',bindingDigest:registry.bindings().main!}],defaultEntryId:'main',userChoice:false},mapping:{idleTtlSeconds:600,absoluteTtlSeconds:1800},speech:{localOnly:true,maxDurationSeconds:30}};
      const handler = createAiChatHandler({
        model,
        tools:{list_tasks:defineTool({id:agentRevision.toolAllowlist[0]!,description:'Read person',inputSchema:z.object({}),execute})},
        systemPrompt:'Help',maxResultChars:1000,
        ...(['configured-off','local-stricter','signed-protected'].includes(mode)?{managedRuntime:{resolvePrincipal:async()=>principal,resolveTurnSnapshot:({turnId})=>createTurnSnapshot({turnId,agentRevision,manifestRevision,policyRevision:{...policyRevision,privacy:mode==='signed-protected'?signedBlock:{schemaVersion:1,profile:'off'}},principal,localLimits})}}:{}),
        ...(mode!=='off'?{privacy:{shield:memoryShield(),providers:{registry},...(mode==='configured-off'?{policy:{required:false}}:{}),scope:()=>testScope({conversationId:'limit'}),knownIdentities:()=>[{name:sensitive}]}}:{}),
      });
      const response=await handler(new Request('http://fixture/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'limit',messages:[{id:'u',role:'user',parts:[{type:'text',text:'Read person'}]}]})}));
      const chunks=await streamChunks(response);
      expect(requests).toHaveLength(2);
      expect(execute).toHaveBeenCalledTimes(1);
      if(protectedMode) {
        expect(requests.join('')).not.toContain('ConfidentialIdentityPrefix');
        expect(requests[1]).toContain('outputWithheld');
        expect(JSON.stringify(chunks)).toContain('outputWithheld');
      } else {
        expect(requests[1]).toContain('ConfidentialIdentityPrefix');
        expect(requests[1]).toContain('_truncated');
      }
    });
  }
});
