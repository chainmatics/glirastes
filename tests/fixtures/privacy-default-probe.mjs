import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=resolve(process.argv[2]);const require=createRequire(root+'/package.json');
const {createOpenAI}=require('@ai-sdk/openai');
const {createAiChatHandler}=await import(pathToFileURL(root+'/dist/server/adapters/nextjs/index.js'));
const requests=[];const errors=[];
const provider=createOpenAI({apiKey:'synthetic-only',baseURL:'https://fixture.invalid/v1',fetch:async (_url,init)=>{
 requests.push(JSON.parse(String(init.body)));
 const chunk=(delta,finish_reason=null)=>({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]});
 return new Response([chunk({role:'assistant',content:'Ordinary response'}),chunk({},'stop')].map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
const handler=createAiChatHandler({model:provider.chat('fixture'),tools:{},systemPrompt:'Baseline assistant',onError:error=>errors.push(error.name)});
const response=await handler(new Request('https://consumer.invalid/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'baseline-session',messages:[{id:'u1',role:'user',parts:[{type:'text',text:'Contact OrdinaryBaselineCanary at ordinary.canary@example.invalid'}]}]})}));
const text=await response.text();
process.stdout.write(JSON.stringify({status:response.status,requests,errors,privacyStatus:text.includes('data-privacy-status'),responsePresent:text.includes('Ordinary response')},null,2)+'\n');
