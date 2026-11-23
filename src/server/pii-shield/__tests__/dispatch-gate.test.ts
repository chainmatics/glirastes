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

it.each(['plain', 'frozen', 'callable'] as const)('guards allowed and refused %s model descriptors with their original receiver', async kind => {
  const requests: unknown[] = [];
  const provider = createOpenAI({apiKey: 'synthetic', baseURL: 'https://shape.fixture.invalid/v1', fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{index: 0, message: {role: 'assistant', content: 'OK'}, finish_reason: 'stop'}]});
  }});
  const delegate = provider.chat('fixture');
  const fields = {specificationVersion: 'v3' as const, provider: delegate.provider, modelId: delegate.modelId, supportedUrls: {},
    doGenerate: delegate.doGenerate.bind(delegate), doStream: delegate.doStream.bind(delegate)};
  const model = kind === 'frozen' ? Object.freeze(fields) : kind === 'callable' ? Object.assign(() => {}, fields) : fields;
  const gate = vi.fn();
  expect((await generateText({model: guardModelDispatch(model, gate), prompt: 'shape.canary@example.invalid', maxRetries: 0})).text).toBe('OK');
  expect(gate).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(1);
  const refused = guardModelDispatch(model, () => { throw new PrivacyError('privacy_policy_revoked'); });
  await expect(generateText({model: refused, prompt: 'blocked.canary@example.invalid', maxRetries: 0})).rejects.toMatchObject({code: 'privacy_policy_revoked'});
  const stream = streamText({model: refused, prompt: 'blocked.canary@example.invalid', maxRetries: 0, onError: () => {}});
  for await (const _ of stream.fullStream) { /* consume refusal */ }
  expect(requests).toHaveLength(1);
});
