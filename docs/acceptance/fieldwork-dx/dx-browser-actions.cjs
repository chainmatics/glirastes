const { chromium } = require('@playwright/test');
const fs = require('fs');
const assert = require('node:assert/strict');
const evidence = 'evidence/dx-retest'; fs.mkdirSync(evidence,{recursive:true});
(async () => {
 const browser = await chromium.launch({ headless:true, channel:'chrome' });
 const page = await browser.newPage({viewport:{width:1440,height:1000}});
 let calls=0;
 await page.route('**/api/chat', async route => {
  if(route.request().method()!=='POST') return route.continue();
  calls++; const jobId = calls===1?'job_003':'job-107';
  const toolCallId=`dx-action-${calls}`;
  const chunks=[{type:'start',messageId:`dx-msg-${calls}`},{type:'start-step'},
   {type:'tool-input-available',toolCallId,toolName:'ui_dispatch_highlight',input:{jobId}},
   {type:'tool-output-available',toolCallId,output:{success:true,requested:true,executionStatus:'unconfirmed',message:'Aktion angefordert. Ausführung unbestätigt.',uiAction:{type:'glirastes.action',actionId:'dispatch.highlight',payload:{jobId},route:'/'}}},
   {type:'finish-step'},{type:'finish',finishReason:'stop'}];
  if(calls===3) {
   chunks.splice(0,chunks.length,
    {type:'start',messageId:'dx-budget'}, {type:'start-step'},
    {type:'tool-input-available',toolCallId:'dx-plan',toolName:'update_plan',input:{items:[{title:'Aufträge lesen',status:'completed'},{title:'Team prüfen',status:'completed'},{title:'Material zusammenfassen',status:'pending'}]}},
    {type:'tool-output-available',toolCallId:'dx-plan',output:{success:true}},
    {type:'finish-step'},{type:'data-pipeline-state',data:{status:'safety-stop',totalSteps:6,maxSteps:6,stepLimitSource:'runtime-budget',updatedAt:new Date().toISOString()},transient:false},
    {type:'finish',finishReason:'stop'});
  }
  await route.fulfill({status:200,headers:{'content-type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1'},body:chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n'});
 });
 try {
  await page.goto('http://127.0.0.1:3218');
  await page.getByRole('button',{name:/Demo-Arbeitsplatz/}).click();
  await page.getByRole('button',{name:'KI fragen',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Was kann ich für dich übernehmen?'});
  await editor.fill('Außenbeleuchtung reparieren hervorheben');
  await page.getByRole('button',{name:'Senden',exact:true}).click();
  await page.getByText('Browseraktion abgelehnt.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Wartet auf Freigabe',{exact:true}).count(),0);
  assert.equal(await page.locator('.highlighted').count(),0);
  assert.equal(await page.getByText('Browseraktion ausgeführt.',{exact:true}).count(),0);
  await page.screenshot({path:`${evidence}/action-rejected.png`});
  await editor.fill('Mit korrekter ID hervorheben');
  await page.getByRole('button',{name:'Senden',exact:true}).click();
  await page.getByText('Browseraktion ausgeführt.',{exact:true}).waitFor();
  assert.equal(await page.locator('.highlighted').count(),1);
  await page.screenshot({path:`${evidence}/action-succeeded.png`});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`${evidence}/action-mobile.png`});
  await page.reload();
  // The board remount loses its ephemeral highlight. Restored history must not replay it.
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.highlighted').count(),0);
  assert.equal(calls,2);
  const open=page.getByRole('button',{name:'KI fragen',exact:true});
  if(await open.isVisible()) await open.click();
  await page.getByText('Browseraktion abgelehnt.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Wartet auf Freigabe',{exact:true}).count(),0);
  await page.getByText('Browseraktion ausgeführt.',{exact:true}).waitFor();
  await editor.fill('Dreiteiligen Plan prüfen');
  await page.getByRole('button',{name:'Senden',exact:true}).click();
  await page.locator('[data-element="pipeline-notice"]').waitFor();
  const notice=await page.locator('[data-element="pipeline-notice"]').innerText();
  assert.match(notice,/Sicherheitsbudget/); assert.match(notice,/6/);
  await page.getByText('Material zusammenfassen',{exact:true}).waitFor();
  await page.screenshot({path:`${evidence}/budget-mobile.png`});
  fs.writeFileSync(`${evidence}/budget.json`,JSON.stringify({mode:'deterministic SSE',notice,partialPlanVisible:true},null,2));
  await page.reload(); await page.waitForTimeout(500);
  if(await open.isVisible()) await open.click();
  await page.locator('[data-element="pipeline-notice"]').waitFor();
  fs.writeFileSync(`${evidence}/actions.json`,JSON.stringify({mode:'deterministic SSE replay, packed SDK, real app handlers',rejectedUnknownId:true,highlightedValidId:true,reloadNoReplay:true,receiptsPersisted:true,calls},null,2));
  console.log('PASS rejected unknown ID, success known ID, persisted receipts, no reload replay');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
