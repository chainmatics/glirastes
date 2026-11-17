import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { memoryShield, testScope } from '../../../pii-shield/__tests__/privacy-fixtures.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { streamChunks } from './command-fixtures.js';

const sensitive = 'ConfidentialIdentityPrefix' + 'x'.repeat(5_000);

describe('protected result limits after upstream truncation integration', () => {
  for (const protectedMode of [true, false]) {
    it(`${protectedMode ? 'protected' : 'off'} actual provider transport for an oversized tool result`, async () => {
      const requests: string[] = [];
      const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(init?.body));
        const first = requests.length === 1;
        const delta = first
          ? {role:'assistant',tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'read_person',arguments:'{}'}}]}
          : {role:'assistant',content:'Done'};
        const chunk = (value: unknown, finish: string | null) => ({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:value,finish_reason:finish}]});
        return new Response([chunk(delta,null),chunk({},first?'tool_calls':'stop')].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
      };
      const execute = vi.fn(async () => ({success:true,description:sensitive}));
      const handler = createAiChatHandler({
        model:createOpenAI({apiKey:'fixture',fetch:fetch as typeof globalThis.fetch}).chat('fixture'),
        tools:{read_person:defineTool({id:'read.person',description:'Read person',inputSchema:z.object({}),execute})},
        systemPrompt:'Help',maxResultChars:1000,
        ...(protectedMode?{privacy:{shield:memoryShield(),scope:()=>testScope({conversationId:'limit'}),knownIdentities:()=>[{name:sensitive}]}}:{}),
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
