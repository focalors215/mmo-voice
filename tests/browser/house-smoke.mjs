import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
const testPassword=randomBytes(24).toString('base64url');
const base='http://localhost:18080';
const prefix='browser-test-'+Date.now().toString(36);
const errors=[],checks=[];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--host-resolver-rules=MAP insecure.test 127.0.0.1']});
const contexts=[];
async function req(context,path,data,method='POST'){
 const r=await context.request.fetch(base+path,{method,...(data===undefined?{}:{data})});
 assert.ok(r.ok(),method+' '+path+' '+r.status()+' '+await r.text());
 return r.json();
}
try {
 for(let i=0;i<2;i++){
  const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:900}});
  contexts.push(context);
  await context.addInitScript(()=>{
   const original=navigator.mediaDevices.getDisplayMedia;
   navigator.mediaDevices.getDisplayMedia=async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d');let n=0;
    const draw=()=>{ctx.fillStyle=n++%2?'#247c62':'#18312b';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='32px sans-serif';ctx.fillText('Synthetic screen '+n,40,180)};
    draw();const interval=setInterval(draw,100);const stream=canvas.captureStream(10);
    stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(interval));return stream;
   };
  });
 }
 const pages=await Promise.all(contexts.map(c=>c.newPage()));
 for(const page of pages)page.on('pageerror',e=>errors.push(e.message));
 await pages[0].goto(base);
 await pages[0].getByText('还没有账号？创建一个').click();
 await pages[0].getByLabel('用户名').fill(prefix+'a');
 await pages[0].getByLabel('密码').fill(testPassword);
 await pages[0].getByRole('button',{name:'创建账号',exact:true}).click();
 await pages[0].locator('nav').waitFor();
 checks.push('UI registration');
 await pages[0].locator('nav button').nth(0).click();
 await pages[0].getByPlaceholder('名称').fill(prefix);
 await pages[0].getByRole('button',{name:'创建',exact:true}).click();
 await pages[0].locator('.channel').filter({hasText:'大厅聊天'}).waitFor();
 checks.push('UI community creation');
 const community=(await req(contexts[0],'/api/communities',undefined,'GET')).communities[0];
 await pages[0].getByRole('button',{name:'生成邀请',exact:true}).click();
 await pages[0].getByRole('button',{name:'生成邀请链接',exact:true}).click();
 const link=await pages[0].getByLabel('完整邀请链接').inputValue();
 assert.ok(link.includes('?invite='));
 await pages[0].locator('.dialog .x').click();
 await req(contexts[1],'/api/auth/register',{username:prefix+'b',password:testPassword});
 await pages[1].goto(link);
 assert.equal(await pages[1].getByPlaceholder('粘贴邀请代码').inputValue(),new URL(link).searchParams.get('invite'));
 await pages[1].getByRole('button',{name:'加入',exact:true}).click();
 await pages[1].locator('.channel').filter({hasText:'大厅聊天'}).waitFor();
 checks.push('UI invitation generation and explicit join');
 const message='browser message '+prefix;
 await pages[0].getByPlaceholder('发送消息到 #大厅聊天').fill(message);
 await pages[0].locator('.composer button').click();
 await pages[1].getByText(message,{exact:true}).waitFor({timeout:10000});
 checks.push('Two-account message delivery');
 for(const page of pages){
  await page.locator('.channel').filter({hasText:'休闲大厅'}).click();
  await page.getByRole('button',{name:'加入语音',exact:true}).click();
  await page.getByRole('button',{name:'关闭麦克风',exact:true}).waitFor({timeout:30000});
 }
 await pages[0].getByText('频道中 2 人',{exact:false}).waitFor({timeout:15000});
 await pages[1].locator('.audio-host audio').waitFor({state:'attached',timeout:15000});
 assert.ok(await pages[1].locator('.audio-host audio').evaluateAll(xs=>xs.some(x=>x.srcObject&&x.srcObject.getAudioTracks().length>0)));
 checks.push('Two real LiveKit connections and synthetic microphone track subscription');
 await pages[1].getByRole('button',{name:'静音收听',exact:true}).click();
 assert.ok(await pages[1].locator('.audio-host audio').evaluateAll(xs=>xs.every(x=>x.muted)));
 await pages[1].getByRole('button',{name:'恢复收听',exact:true}).click();
 await pages[0].getByRole('button',{name:'关闭麦克风',exact:true}).click();
 await pages[0].getByRole('button',{name:'开启麦克风',exact:true}).waitFor();
 await pages[0].getByRole('button',{name:'开启麦克风',exact:true}).click();
 checks.push('Microphone mute and deafen');
 await pages[0].getByRole('button',{name:'分享屏幕',exact:true}).click();
 await pages[0].getByRole('button',{name:'停止分享',exact:true}).waitFor({timeout:15000});
 await pages[1].locator('.screen-tracks video').waitFor({timeout:15000});
 await pages[1].waitForFunction(()=>[...document.querySelectorAll('.screen-tracks video')].some(v=>v.videoWidth>0),null,{timeout:15000});
 assert.equal(await pages[0].locator('.screen-tracks video').count(),1);
 await pages[0].getByRole('button',{name:'停止分享',exact:true}).click();
 await pages[1].waitForFunction(()=>document.querySelectorAll('.screen-tracks video').length===0);
 await pages[0].waitForFunction(()=>document.querySelectorAll('.screen-tracks video').length===0);
 checks.push('Synthetic screen publication, rendered subscription, local preview and stop cleanup');
 await pages[0].getByRole('button',{name:'创建社区',exact:true}).click();
 await pages[0].getByPlaceholder('名称').fill(prefix+'second');
 await pages[0].getByRole('button',{name:'创建',exact:true}).click();
 await pages[1].getByText('频道中 1 人',{exact:false}).waitFor({timeout:15000});
 assert.equal(await pages[0].locator('.audio-host audio').count(),0);
 await pages[0].locator('nav button').nth(0).click();
 await pages[0].locator('.channel').filter({hasText:'休闲大厅'}).click();
 await pages[0].getByRole('button',{name:'加入语音',exact:true}).click();
 await pages[0].getByRole('button',{name:'关闭麦克风',exact:true}).waitFor({timeout:30000});
 await pages[1].getByText('频道中 2 人',{exact:false}).waitFor({timeout:15000});
 checks.push('Community switching releases the previous voice connection');

 await pages[0].locator('.channel').filter({hasText:'开黑房间'}).click();
 await pages[0].getByRole('button',{name:'加入语音',exact:true}).waitFor();
 await pages[1].getByText('频道中 1 人',{exact:false}).waitFor({timeout:15000});
 assert.equal(await pages[0].locator('.audio-host audio').count(),0);
 checks.push('Voice channel switching disconnect cleanup');
 await pages[1].getByRole('button',{name:'离开语音',exact:true}).click();
 assert.equal(await pages[1].locator('.audio-host audio').count(),0);
 await pages[0].locator('.channel').filter({hasText:'大厅聊天'}).click();
 await pages[0].getByText(message,{exact:true}).waitFor({timeout:10000});
 await pages[0].setViewportSize({width:390,height:844});
 assert.ok(await pages[0].evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 checks.push('Narrow-screen layout without horizontal overflow');

 const insecure=await browser.newContext({viewport:{width:1280,height:800}});
 contexts.push(insecure);
 // The gateway is loopback-only; a non-localhost name mapped to it gives a real insecure (non-secure-context) origin.
 const ipBase='http://insecure.test:18080';
 const login=await insecure.request.post('http://127.0.0.1:18080/api/auth/login',{data:{username:prefix+'a',password:testPassword}});
 const sessionCookie=(await insecure.cookies()).find(c=>c.name==='voicehub_session');
 await insecure.addCookies([{name:sessionCookie.name,value:sessionCookie.value,domain:'insecure.test',path:'/'}]);
 assert.ok(login.ok());
 const ipPage=await insecure.newPage();
 await ipPage.goto(ipBase);
 assert.equal(await ipPage.evaluate(()=>window.isSecureContext),false);
 await ipPage.locator('.channel').filter({hasText:'休闲大厅'}).click();
 let tokens=0;ipPage.on('request',r=>{if(r.url().endsWith('/token'))tokens++});
 await ipPage.getByRole('button',{name:'加入语音',exact:true}).click();
 await ipPage.getByRole('alert').filter({hasText:'公网 HTTP'}).waitFor();
 assert.equal(tokens,0);
 checks.push('Insecure HTTP accurately blocks media capture before token request');
 assert.deepEqual(errors,[]);
 const report={ok:true,prefix,communityId:community.id,checks,limits:['Microphone input uses Chromium fake device.','Screen capture uses a synthetic canvas stream; native screen picker and real human sound not verified.','Both browser contexts run on the project server; cross-network connectivity not verified.']};
 fs.writeFileSync('/reports/house-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(e){
 fs.writeFileSync('/reports/house-smoke-failure.json',JSON.stringify({prefix,checks,errors,error:e.message},null,2));
 console.error(JSON.stringify({prefix,checks,errors,error:e.message},null,2));process.exitCode=1;
} finally {await browser.close()}
