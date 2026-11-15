import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {fixtureStream} from '../examples/frontend-frameworks/shared/fixture-api.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const FIXTURES=join(ROOT,'examples/frontend-frameworks');
const run=promisify(execFile);
const frameworkBuilds={angular:'node_modules/@angular/cli/bin/ng.js',sveltekit:'node_modules/vite/bin/vite.js',nuxt:'node_modules/nuxt/bin/nuxt.mjs'};
async function eventually(check,label){for(let n=0;n<150;n++){try{if(await check())return;}catch{}await delay(100);}throw new Error(label);}
async function port(){const s=createServer();await new Promise(done=>s.listen(0,'127.0.0.1',done));const p=s.address().port;await new Promise(done=>s.close(done));return p;}
async function start(framework){
  const cwd=join(FIXTURES,framework);
  await run(process.execPath,[join(cwd,frameworkBuilds[framework]),'build'],{cwd,env:{...process.env,CI:'1',NUXT_TELEMETRY_DISABLED:'1'},maxBuffer:16*1024*1024});
  if(framework==='angular'){
    const root=join(cwd,'dist/browser');
    const server=createServer(async(req,res)=>{
      const path=resolve(root,'.'+new URL(req.url,'http://local').pathname);
      if(!path.startsWith(root+'/')&&path!==root){res.writeHead(404).end();return;}
      let target=path;
      if(!(await stat(target).catch(()=>null))?.isFile())target=join(root,'index.html');
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
      res.setHeader('content-type',types[extname(target)]??'application/octet-stream');
      res.end(await readFile(target));
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    return {origin:`http://127.0.0.1:${server.address().port}`,stop:()=>new Promise(done=>{server.closeAllConnections();server.close(done);})};
  }
  const listenPort=await port();
  const origin=`http://127.0.0.1:${listenPort}`;
  const child=spawn(process.execPath,[framework==='sveltekit'?'build/index.js':'.output/server/index.mjs'],{
    cwd,env:{...process.env,PORT:String(listenPort),HOST:'127.0.0.1',NITRO_PORT:String(listenPort),NITRO_HOST:'127.0.0.1',ORIGIN:origin},stdio:['ignore','pipe','pipe'],
  });
  let log='';child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);
  const stop=async()=>{if(child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await done;clearTimeout(timer);};
  try{await eventually(async()=>{if(child.exitCode!==null)throw new Error(log);return(await fetch(origin)).ok;},`${framework} server did not start: ${log}`);}catch(error){await stop();throw error;}
  return {origin,stop};
}
async function send(page,text){const input=page.locator('textarea[placeholder="Ask the fixture"]');await input.fill(text);await input.press('Enter');}

test('Angular, SvelteKit and Nuxt mount the existing SDK safely and execute browser contracts', {timeout:300_000},async t=>{
  const playwrightPath=process.env.PLAYWRIGHT_MODULE;
  assert.ok(playwrightPath,'Set PLAYWRIGHT_MODULE to the installed Playwright index.mjs');
  const {chromium}=await import(pathToFileURL(playwrightPath).href);
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??'chrome'});
  t.after(()=>browser.close());
  for(const framework of Object.keys(frameworkBuilds))await t.test(framework,{timeout:120_000},async t=>{
    const server=await start(framework);t.after(server.stop);
    const html=await fetch(server.origin).then(response=>response.text());
    assert.doesNotMatch(html, /ReferenceError|HTMLElement is not defined/);
    if(framework!=='angular')assert.match(html, /Home/,'SSR should render the page without importing browser-only SDK code');
    const context=await browser.newContext();t.after(()=>context.close());
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/me',route=>route.fulfill({json:{userId:'u-1',tenantId:'tenant-a'}}));
    const posted=[];
    await page.route('**/api/chat',async route=>{
      const data=route.request().postDataJSON();posted.push(data);
      const text=data.messages.at(-1)?.parts?.find(part=>part.type==='text')?.text??'';
      await route.fulfill({status:200,headers:{'content-type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1'},body:fixtureStream(text)});
    });
    await page.goto(server.origin);
    await page.locator('textarea[placeholder="Ask the fixture"]').waitFor();
    await send(page,'Highlight fixture target');
    await eventually(()=>page.getByTestId('highlight-target').getAttribute('data-highlight-count').then(n=>n==='1'),'Client action did not execute');
    assert.ok(posted[0].glirastesClientActions?.includes('fixture.highlight'),'Registered action should be advertised to runtime');
    await page.reload();await page.locator('textarea[placeholder="Ask the fixture"]').waitFor();
    await page.getByText('Highlight fixture target',{exact:true}).waitFor();
    const stored=await page.evaluate(()=>Object.keys(localStorage));
    assert.ok(stored.some(key=>key.includes('tenant-a')&&key.includes('u-1')&&key.includes(framework)),'Session store was not identity scoped before mount');
    await send(page,'Navigate to overview');
    await page.waitForURL('**/overview');await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
    // Retain removed element only inside the test to inspect SDK cleanup.
    await page.evaluate(()=>{window.__removedChat=document.querySelector('glirastes-chat');});
    await page.getByRole('button',{name:'Unmount chat',exact:true}).click();
    await eventually(()=>page.locator('glirastes-chat').count().then(n=>n===0),'Chat was not removed');
    await eventually(()=>page.evaluate(()=>window.__removedChat.shadowRoot.childNodes.length===0),'React shadow root was not released');
    await page.getByRole('button',{name:'Mount chat',exact:true}).click();await page.locator('textarea[placeholder="Ask the fixture"]').waitFor();
    await page.getByTestId('highlight-target').evaluate(el=>el.dataset.highlightCount='0');
    await send(page,'Highlight fixture target again');
    await eventually(()=>page.getByTestId('highlight-target').getAttribute('data-highlight-count').then(n=>n==='1'),'Remount lost/duplicated the action handler');
    await delay(100);assert.equal(await page.getByTestId('highlight-target').getAttribute('data-highlight-count'),'1');
    assert.deepEqual(errors,[]);
    await page.close();
    // Async identity lookup completing after unmount must not resurrect the UI.
    const race=await context.newPage();let pending;
    await race.route('**/api/me',route=>{pending=route;});
    await race.goto(server.origin);await eventually(()=>Boolean(pending),'Identity request did not start');
    await race.getByRole('button',{name:'Unmount chat',exact:true}).click();
    await pending.fulfill({json:{userId:'u-1',tenantId:'tenant-a'}}).catch(()=>{});
    await delay(100);assert.equal(await race.locator('glirastes-chat').count(),0);
  });
});
