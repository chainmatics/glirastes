import {afterEach,expect,it,vi} from 'vitest';
import {generateText,streamText} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {guardModelDispatch} from '../dispatch-gate.js';
import {PrivacyError} from '../detection-result.js';
afterEach(()=>{vi.useRealTimers();});
it.each(['generate','stream'] as const)('blocks %s provider retries after live revocation using serialized HTTP capture',async(kind)=>{
 let revoked=false;const requests:unknown[]=[];
 const provider=createOpenAI({apiKey:'synthetic-only',baseURL:'https://retry.fixture.invalid/v1',fetch:async(_url,init)=>{
   requests.push(JSON.parse(String(init?.body)));revoked=true;
   return Response.json({error:{message:'synthetic retry',type:'server_error',code:'server_error'}},{status:503});
 }});
 const model=guardModelDispatch(provider.chat('fixture'),()=>{if(revoked)throw new PrivacyError('privacy_policy_revoked');});
 if(kind==='generate') await expect(generateText({model,prompt:'retry.canary@example.invalid',maxRetries:1})).rejects.toBeDefined();
 else {const result=streamText({model,prompt:'retry.canary@example.invalid',maxRetries:1,onError:()=>{}});for await(const _ of result.fullStream){};}
 expect(requests).toHaveLength(1);expect(JSON.stringify(requests)).toContain('retry.canary@example.invalid');
});
it('resolves a model string through the same consumer global provider and guards its actual call',async()=>{
 const previous=globalThis.AI_SDK_DEFAULT_PROVIDER;const generate=vi.fn(async()=>({}));
 const model={specificationVersion:'v3',provider:'fixture',modelId:'fixture',supportedUrls:{},doGenerate:generate,doStream:vi.fn()};
 try{globalThis.AI_SDK_DEFAULT_PROVIDER={languageModel:vi.fn(()=>model)} as never;
 const wrapped=guardModelDispatch('fixture',()=>{throw new PrivacyError('privacy_policy_revoked');}) as unknown as typeof model;
 await expect(wrapped.doGenerate()).rejects.toMatchObject({code:'privacy_policy_revoked'});expect(generate).not.toHaveBeenCalled();
 }finally{globalThis.AI_SDK_DEFAULT_PROVIDER=previous;}
});
