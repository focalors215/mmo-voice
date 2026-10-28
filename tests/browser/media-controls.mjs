import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base='http://localhost:18080',prefix='quality-test-'+Date.now().toString(36);
const checks=[],errors=[];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const contexts=[],users=[];
async function request(context,path,data,method='POST'){
 const response=await context.request.fetch(base+path,{method,...(data===undefined?{}:{data})});
 const body=await response.json();assert.ok(response.ok(),path+': '+response.status()+' '+body.error);return body;
}
async function waitEnabled(page){await page.waitForFunction(()=>![...document.querySelectorAll('.media-quality select')].some(s=>s.disabled))}
async function assertEncoding(page,kind,bitrate,framerate){
 await page.waitForFunction(({kind,bitrate,framerate})=>(window.__rtcPeers||[]).some(peer=>peer.getSenders().some(sender=>sender.track?.kind===kind&&sender.getParameters().encodings.some(e=>e.maxBitrate===bitrate&&(!framerate||e.maxFramerate===framerate)))),{kind,bitrate,framerate},{timeout:10000});
}
try{
 for(let i=0;i<2;i++){
  const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:900}});contexts.push(context);
  await context.addInitScript(()=>{
   const Native=window.RTCPeerConnection;window.__rtcPeers=[];
   window.RTCPeerConnection=class extends Native{constructor(...args){super(...args);window.__rtcPeers.push(this)}};
   window.__captureRequests=0;
   navigator.mediaDevices.getDisplayMedia=async()=>{
    window.__captureRequests++;const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
    const ctx=canvas.getContext('2d');let n=0;const draw=()=>{ctx.fillStyle=n++%2?'#205f49':'#123426';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='white';ctx.font='60px sans-serif';ctx.fillText('Live shared screen',100,300)};draw();setInterval(draw,100);return canvas.captureStream(30);
   };
  });
  users.push((await request(context,'/api/auth/register',{username:prefix+(i?'b':'a'),password:'TestQuality-123!'})).user);
 }
 const community=(await request(contexts[0],'/api/communities',{name:prefix})).community;
 const invite=await request(contexts[0],'/api/communities/'+community.id+'/invites');
 await request(contexts[1],'/api/invites/'+invite.code+'/join');
 const pages=await Promise.all(contexts.map(c=>c.newPage()));
 for(const page of pages){page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('.channel').filter({hasText:'休闲大厅'}).click()}
 assert.equal(await pages[0].getByLabel('屏幕分享画质').inputValue(),'standard');
 assert.equal(await pages[0].getByLabel('麦克风音质').inputValue(),'standard');
 await pages[0].getByLabel('屏幕分享画质').selectOption('data');await waitEnabled(pages[0]);
 await pages[0].getByLabel('麦克风音质').selectOption('data');await waitEnabled(pages[0]);
 for(const page of pages){await page.getByRole('button',{name:'加入语音',exact:true}).click();await page.getByRole('button',{name:'关闭麦克风',exact:true}).waitFor({timeout:30000})}
 await assertEncoding(pages[0],'audio',24000);
 checks.push('Selected microphone encoding applies on initial join');
 for(const [quality,bitrate] of [['standard',48000],['high',96000],['data',24000]]){
  await pages[0].getByLabel('麦克风音质').selectOption(quality);await waitEnabled(pages[0]);await assertEncoding(pages[0],'audio',bitrate);
 }
 // Stereo music profiles republish the microphone and must negotiate stereo Opus at the requested bitrate.
 for(const [quality,bitrate] of [['max',320000],['hifi',192000]]){
  await pages[0].getByLabel('麦克风音质').selectOption(quality);await waitEnabled(pages[0]);await assertEncoding(pages[0],'audio',bitrate);
  await pages[0].waitForFunction(()=>(window.__rtcPeers||[]).some(p=>/(^|;)stereo=1/m.test((p.localDescription?.sdp||'').split('\n').filter(l=>l.startsWith('a=fmtp:')).join('\n').replace(/ /g,';'))),null,{timeout:10000});
  await pages[1].getByText('频道中 2 人',{exact:false}).waitFor();
 }
 await pages[0].getByLabel('麦克风音质').selectOption('data');await waitEnabled(pages[0]);await assertEncoding(pages[0],'audio',24000);
 checks.push('Stereo 192/320 kbps profiles republish the microphone with stereo Opus');
 await pages[0].getByRole('button',{name:'关闭麦克风',exact:true}).click();
 await pages[0].getByLabel('麦克风音质').selectOption('high');await waitEnabled(pages[0]);
 await pages[0].getByRole('button',{name:'开启麦克风',exact:true}).waitFor();await assertEncoding(pages[0],'audio',96000);
 await pages[0].getByRole('button',{name:'开启麦克风',exact:true}).click();
 checks.push('All audio bitrate tiers apply without unmuting a muted microphone');
 await pages[0].getByRole('button',{name:'分享屏幕',exact:true}).click();
 await pages[0].getByRole('button',{name:'停止分享',exact:true}).waitFor();
 await pages[1].waitForFunction(()=>document.querySelector('.screen-tracks video')?.videoWidth>0,null,{timeout:20000});
 await assertEncoding(pages[0],'video',400000,15);
 const card=pages[1].locator('.screen-card');
 await card.getByRole('button',{name:'全屏观看',exact:true}).click();
 await pages[1].waitForFunction(()=>document.fullscreenElement?.classList.contains('screen-card'));
 await card.getByRole('button',{name:'退出全屏',exact:true}).waitFor();
 const dimensions=await pages[1].evaluate(()=>({width:document.fullscreenElement.getBoundingClientRect().width,height:document.fullscreenElement.getBoundingClientRect().height,viewportWidth:innerWidth,viewportHeight:innerHeight}));
 assert.ok(Math.abs(dimensions.width-dimensions.viewportWidth)<2);assert.ok(Math.abs(dimensions.height-dimensions.viewportHeight)<2);
 checks.push('Viewer can enter real fullscreen with full viewport layout');
 for(const [quality,bitrate,fps] of [['standard',1500000,30],['high',3000000,30],['ultra',6000000,30],['data',400000,15]]){
  await pages[0].getByLabel('屏幕分享画质').selectOption(quality);await waitEnabled(pages[0]);await assertEncoding(pages[0],'video',bitrate,fps);
  assert.ok(await pages[1].evaluate(()=>!!document.fullscreenElement));
 }
 assert.equal(await pages[0].evaluate(()=>window.__captureRequests),1);
 checks.push('All screen encoding tiers change without reopening capture or interrupting viewer fullscreen');
 await card.getByRole('button',{name:'退出全屏',exact:true}).click();await pages[1].waitForFunction(()=>!document.fullscreenElement);
 await card.locator('video').dblclick();await pages[1].waitForFunction(()=>!!document.fullscreenElement);
 await pages[1].keyboard.press('Escape');await pages[1].waitForFunction(()=>!document.fullscreenElement);
 checks.push('Exit button, double-click and Escape synchronize fullscreen controls');
 await card.getByRole('button',{name:'全屏观看',exact:true}).click();await pages[1].waitForFunction(()=>!!document.fullscreenElement);
 await pages[0].getByRole('button',{name:'停止分享',exact:true}).click();
 await pages[1].waitForFunction(()=>!document.fullscreenElement&&document.querySelectorAll('.screen-card').length===0);
 checks.push('Stopped screen share exits fullscreen and removes video controls');
 await pages[0].getByRole('button',{name:'离开语音',exact:true}).click();await pages[0].reload();await pages[0].locator('.channel').filter({hasText:'休闲大厅'}).click();
 assert.equal(await pages[0].getByLabel('屏幕分享画质').inputValue(),'data');assert.equal(await pages[0].getByLabel('麦克风音质').inputValue(),'high');
 checks.push('Quality preferences persist after reload');
 assert.deepEqual(errors,[]);
 const report={ok:true,prefix,userIds:users.map(u=>u.id),communityId:community.id,checks,limits:['Browser test uses synthetic microphone/screen capture on the project server.','Actual source resolution and available bitrate depend on capture source and browser.']};
 fs.writeFileSync('/reports/media-controls.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
 const report={ok:false,prefix,userIds:users.map(u=>u.id),checks,errors,error:error.message};fs.writeFileSync('/reports/media-controls-failure.json',JSON.stringify(report,null,2));console.error(JSON.stringify(report,null,2));process.exitCode=1;
}finally{await browser.close()}
