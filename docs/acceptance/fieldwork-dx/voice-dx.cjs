const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({headless:true,channel:'chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${path.resolve('evidence/voice-fixture.wav')}`]});
 const page = await browser.newPage({viewport:{width:1200,height:1000},permissions:['microphone']});
 const results=[];
 let chatCalls=0;
 page.on('console',m=>{if(m.type()==='error') console.log('browser-error',m.text());});
 page.on('request',r=>{if(r.url().includes('speech.js'))console.log('asset-request',r.url());if(r.url().endsWith('/api/chat')&&r.method()==='POST') chatCalls++;});
 await page.addInitScript(()=>{
  window.__streams=[];window.__contexts=[];
  const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async (...args)=>{const s=await gum(...args);window.__streams.push(s);return s;};
  const AC=window.AudioContext;
  window.AudioContext=class extends AC{constructor(...args){super(...args);window.__contexts.push(this);}};
 });
 const resourceState=()=>page.evaluate(()=>({streams:window.__streams.length,tracks:window.__streams.flatMap(s=>s.getTracks().map(t=>t.readyState)),contexts:window.__contexts.map(c=>c.state)}));
 const released=async()=>{await page.waitForFunction(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&window.__contexts.every(c=>c.state==='closed'));return resourceState();};
 const mic=()=>page.locator('[data-component=voice-input-addon]');
 const recording=()=>page.waitForFunction(()=>document.querySelector('[data-component=voice-input-addon]')?.dataset.state==='recording');
 const editor=()=>page.getByRole('textbox',{name:'Was kann ich für dich übernehmen?'});
 try {
  await page.goto('http://127.0.0.1:3218');
  await page.getByRole('button',{name:/Demo-Arbeitsplatz/}).click();
  await page.waitForURL('http://127.0.0.1:3218/');
  await page.getByRole('button',{name:'KI fragen',exact:true}).click();
  assert.equal(await mic().getAttribute('aria-label'),'Aufnahme starten');
  assert.equal(await mic().locator('svg').count(),1);
  // Real failed worklet load; AudioContext and microphone must both be released.
  fs.renameSync('public/assets/speech.js','public/assets/speech.js.test-backup');
  await mic().click();
  await page.waitForTimeout(1500);console.log('capture-state',await mic().getAttribute('data-state'),await page.getByRole('alert').allTextContents());await page.screenshot({path:'evidence/voice-debug.png'});
  await page.getByRole('alert').filter({hasText:'Audio-Datei'}).waitFor();
  results.push({name:'missing-asset-localized-error',...await released()});
  await page.screenshot({path:'evidence/voice-asset-error.png'});
  fs.renameSync('public/assets/speech.js.test-backup','public/assets/speech.js');
  // Retry uses the same controller, one new stream, real OpenRouter transcription.
  if(process.env.VOICE_FAKE)await page.route('**/api/ai/speech-recognize?*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'Zeige dringende Aufträge'})}));
  await page.getByRole('button',{name:'Aufnahme wiederholen'}).click();
  await recording();
  await page.waitForTimeout(3600);
  const response=page.waitForResponse(r=>r.url().includes('/api/ai/speech-recognize'),{timeout:60000});
  await mic().click();
  assert.equal((await response).status(),200);
  await page.waitForFunction(()=>document.querySelector('[contenteditable=true]')?.textContent?.match(/Aufträge|dringend/i));
  const draft=await editor().innerText();
  assert.match(draft,/Aufträge|dringend/i);
  assert.equal(chatCalls,0);
  results.push({name:'retry-real-openrouter-draft-no-send',draft,chatCalls,...await released()});
  await page.screenshot({path:'evidence/voice-draft-dx.png'});
  // Cancel preserves the previous editable draft and performs no transcription.
  let speechRequests=0;
  const track=r=>{if(r.url().includes('/api/ai/speech-recognize'))speechRequests++;};page.on('request',track);
  await mic().click();await recording();
  await page.getByRole('button',{name:'Aufnahme abbrechen'}).click();
  results.push({name:'cancel-keeps-draft',...await released()});
  assert.equal(await editor().innerText(),draft);assert.equal(speechRequests,0);
  // Navigation is tested without another paid provider call.
  await page.route('**/api/ai/speech-recognize?*',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'Navigationsentwurf'})}));
  await mic().click();await recording();await page.waitForTimeout(400);
  await page.locator('a[href="/team"]').first().click();
  await page.waitForURL('**/team');
  await page.waitForFunction(()=>document.querySelector('[contenteditable=true]')?.textContent?.includes('Navigationsentwurf'));
  results.push({name:'navigation-stop-draft',...await released()});
  assert.equal(chatCalls,0);
  await mic().click();await recording();await page.waitForTimeout(400);
  await page.locator('[data-component=session-switcher] [data-element=trigger]').click();
  await page.locator('[data-element=new-session]').click();
  results.push({name:'session-switch-release',...await released()});
  // Reload unmounts the actual chat while recording.
  await mic().click();await recording();
  const before=await resourceState();assert.equal(before.tracks.filter(x=>x==='live').length,1);
  await page.reload();
  results.push({name:'reload-unmount',navigation:'completed',priorLiveTracks:1});
 } finally {if(fs.existsSync('public/assets/speech.js.test-backup'))fs.renameSync('public/assets/speech.js.test-backup','public/assets/speech.js');fs.writeFileSync(process.env.VOICE_FAKE?'evidence/voice-lifecycle-results.json':'evidence/voice-dx-results.json',JSON.stringify(results,null,2));await browser.close();}
 console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
