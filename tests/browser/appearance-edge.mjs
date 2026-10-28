import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const c=await browser.newContext({viewport:{width:320,height:740}}),p=await c.newPage(),checks=[];
try{
 await p.goto('http://localhost:18080');
 await p.getByRole('button',{name:'外观设置',exact:true}).waitFor();
 await p.evaluate(()=>{localStorage.setItem('house.appearance.v1',JSON.stringify({preset:'window-night',transparency:'bad'}))});
 await p.reload();await p.getByRole('button',{name:'外观设置',exact:true}).click();
 assert.equal(await p.getByLabel('背景透明度',{exact:true}).inputValue(),'62');
 await p.keyboard.press('Escape');
 await p.evaluate(async()=>{await new Promise((resolve,reject)=>{const r=indexedDB.open('house-appearance',1);r.onsuccess=()=>{const d=r.result,t=d.transaction('images','readwrite');t.objectStore('images').put(new Blob(['broken'],{type:'image/png'}),'custom');t.oncomplete=()=>{d.close();resolve()};t.onerror=reject}});localStorage.setItem('house.appearance.v1',JSON.stringify({preset:'custom',transparency:50}))});
 await p.reload();await p.waitForFunction(()=>document.querySelector('.appearance-wallpaper')?.style.backgroundImage.includes('window-day'));
 await p.getByRole('button',{name:'外观设置',exact:true}).click();
 assert.equal(await p.getByRole('button',{name:/添加本地图片/}).count(),1);
 checks.push('Invalid stored transparency and corrupt stored image recover safely');
 await p.evaluate(()=>document.documentElement.style.fontSize='200%');
 await p.getByRole('button',{name:'完成',exact:true}).scrollIntoViewIfNeeded();
 assert.ok(await p.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'dialog overflow at 320px/200%');
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow');
 await p.screenshot({path:'/reports/house-appearance-large-text.png'});
 checks.push('320px appearance dialog remains operable with 200% text');
 const devtools=await c.newCDPSession(p);
 await devtools.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-contrast',value:'more'}]});
 assert.equal(await p.getByRole('dialog').evaluate(e=>getComputedStyle(e,'::backdrop').backdropFilter),'none');
 checks.push('Reduced transparency uses an unblurred backdrop');
 const report={ok:true,checks};fs.writeFileSync('/reports/appearance-edge.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(e){await p.screenshot({path:'/reports/appearance-edge-failure.png'});console.error(e);process.exitCode=1}finally{await browser.close()}
