// Interactive frontend fixture only. No real login, model, backend permissions,
// or automatic discovery is implemented here. Never expose this server publicly.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

export function fixtureStream(text){
  const action=/navigate/i.test(text)
    ? {type:'glirastes.navigate',actionId:'glirastes.navigate',payload:{href:'/overview'}}
    : {type:'glirastes.action',actionId:'fixture.highlight',payload:{}};
  const callId=crypto.randomUUID();
  const parts=[
    {type:'start',messageId:crypto.randomUUID()},{type:'start-step'},
    {type:'tool-input-available',toolCallId:callId,toolName:'fixture_action',input:{}},
    {type:'tool-output-available',toolCallId:callId,output:{success:true,uiAction:action}},
    {type:'text-start',id:'text'},{type:'text-delta',id:'text',delta:'Fixture action completed.'},
    {type:'text-end',id:'text'},{type:'finish-step'},{type:'finish',finishReason:'stop'},
  ];
  return parts.map(part=>`data: ${JSON.stringify(part)}\n\n`).join('')+'data: [DONE]\n\n';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');
    if(req.method==='GET'&&req.url==='/api/me'){
      res.setHeader('content-type','application/json');res.end(JSON.stringify({userId:'demo-user',tenantId:'demo-tenant'}));return;
    }
    if(req.method!=='POST'||req.url!=='/api/chat'){res.writeHead(404).end();return;}
    try{
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>65536){res.writeHead(413).end();return;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const text=body.messages?.at(-1)?.parts?.find(part=>part.type==='text')?.text??'';
      res.writeHead(200,{'content-type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1'});res.end(fixtureStream(text));
    }catch{res.writeHead(400).end();}
  }).listen(8899,'127.0.0.1',()=>console.log('Frontend-only fixture API: http://127.0.0.1:8899 (not production)'));
}
