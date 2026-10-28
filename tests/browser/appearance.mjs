import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
const base='http://localhost:18080',prefix='house-test-'+Date.now().toString(36),checks=[],errors=[],ids=[];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
async function api(path,data){const r=await context.request.post(base+path,{data});assert.ok(r.ok(),path+await r.text());return r.json()}
async function settings(){await page.getByRole('button',{name:'外观设置',exact:true}).click();await page.getByRole('dialog').waitFor()}
async function noOverflow(){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow')}
try{
 await page.goto(base);assert.equal(await page.title(),'喵喵零和小鱼的小屋');
 await page.screenshot({path:'/reports/house-login-light.png'});
 const user=(await api('/api/auth/register',{username:prefix,password:randomBytes(24).toString('base64url')})).user;ids.push(user.id);
 const community=(await api('/api/communities',{name:'小屋设计验收'})).community;
 await page.reload();await page.locator('.channel').filter({hasText:'大厅聊天'}).waitFor();
 await settings();
 const d=page.getByRole('dialog');
 const range=page.getByLabel('背景透明度',{exact:true});
 for(const [key,expected] of [['Home',0],['End',1]]){
  await range.focus();await range.press(key);
  await page.waitForFunction(expected=>Number(getComputedStyle(document.querySelector('.appearance-wallpaper')).opacity)===1-expected,expected);
 }
 await range.press('Home');for(let i=0;i<50;i++)await range.press('ArrowRight');
 assert.equal(await range.inputValue(),'50');
 await page.getByRole('button',{name:'月光小屋',exact:false}).click();
 await page.screenshot({path:'/reports/house-appearance-light.png'});
 await page.keyboard.press('Escape');await page.reload();await settings();
 assert.equal(await page.getByLabel('背景透明度',{exact:true}).inputValue(),'50');
 assert.equal(await page.getByRole('button',{name:'月光小屋',exact:false}).getAttribute('aria-pressed'),'true');
 checks.push('Built-in wallpaper and 0/50/100 transparency persist across reload');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 await d.locator('input[type=file]').setInputFiles({name:'house.png',mimeType:'image/png',buffer:png});
 await page.waitForFunction(()=>document.querySelector('.appearance-wallpaper').style.backgroundImage.includes('blob:'));
 await page.keyboard.press('Escape');await page.reload();
 await page.waitForFunction(()=>document.querySelector('.appearance-wallpaper').style.backgroundImage.includes('blob:'));
 await settings();assert.equal(await page.getByRole('button',{name:/我的图片/}).getAttribute('aria-pressed'),'true');
 await d.locator('input[type=file]').setInputFiles({name:'unsafe.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
 await page.getByRole('status').filter({hasText:/PNG|WebP/}).waitFor();
 assert.ok(await page.locator('.appearance-wallpaper').evaluate(e=>e.style.backgroundImage.includes('blob:')));
 checks.push('Custom PNG displays immediately, survives reload; invalid file preserves current image');
 await page.getByRole('button',{name:'移除本地图片',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.appearance-wallpaper').style.backgroundImage.includes('blob:'));
 await page.getByRole('button',{name:'恢复默认',exact:true}).click();
 assert.equal(await page.getByLabel('背景透明度',{exact:true}).inputValue(),'62');
 checks.push('Remove custom image and restore defaults');
 await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal(await page.getByRole('button',{name:'外观设置',exact:true}).evaluate(e=>e===document.activeElement),true);
 checks.push('Appearance dialog keyboard dismissal and focus return');
 await page.screenshot({path:'/reports/house-chat-light.png'});
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});await noOverflow();
  await page.getByRole('button',{name:/打开频道|显示频道|频道导航/}).click();
  await page.locator('.channel').filter({hasText:'休闲大厅'}).click();
  await page.getByRole('button',{name:'加入语音',exact:true}).waitFor();await noOverflow();
  await page.screenshot({path:'/reports/house-mobile-'+width+'.png'});
 }
 checks.push('320px and 390px navigation reaches voice without horizontal overflow');
 await page.setViewportSize({width:1440,height:900});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
 await page.screenshot({path:'/reports/house-voice-dark.png'});
 const dark=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--house-text').trim());assert.equal(dark.toLowerCase(),'#f3f4fa');
 checks.push('Dark system appearance and reduced motion supported');
 await page.evaluate(()=>document.documentElement.style.fontSize='200%');await noOverflow();await page.getByRole('button',{name:'加入语音',exact:true}).waitFor();
 checks.push('200% root text keeps main controls available');await page.evaluate(()=>document.documentElement.style.fontSize='');
 assert.deepEqual(errors,[]);
 const report={ok:true,prefix,userIds:ids,communityId:community.id,checks};fs.writeFileSync('/reports/appearance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(e){await page.screenshot({path:'/reports/appearance-failure.png'});console.error(e);fs.writeFileSync('/reports/appearance-failure.json',JSON.stringify({ok:false,prefix,userIds:ids,checks,errors,error:e.message},null,2));process.exitCode=1}finally{await browser.close()}
