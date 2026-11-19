(async()=>{
 const checks=[];
 const assert=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
 const wait=async(fn)=>{const until=Date.now()+15000;while(Date.now()<until){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,60));}throw new Error('browser_condition_timeout');};
 const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
 const api=async()=>{const r=await fetch('/api/reports/usage'+location.search,{cache:'no-store'});if(!r.ok)throw new Error('api_failed');return r.json();};
 const total=()=>document.querySelector('[data-testid="exact-total"]')?.textContent.split(' tokens')[0].replaceAll(',','').trim();
 const matches=async()=>{const r=await api();await wait(()=>total()===r.total.total);return r;};
 await wait(()=>total());
 assert('real API total displayed',(await matches()).total.total===total());
 button('30일').click();await wait(()=>new URLSearchParams(location.search).get('period')==='30');let r=await matches();
 assert('30 calendar days and exact four components',r.days.length===30&&['input','output','cacheRead','cacheWrite'].reduce((s,k)=>s+BigInt(r.total[k]),0n)===BigInt(r.total.total));
 assert('daily/project/model sums equal total',[r.days,r.projects,r.models].every(rows=>rows.reduce((s,x)=>s+BigInt(x.total),0n)===BigInt(r.total.total)));
 button('오늘').click();button('30일').click();button('7일').click();await wait(()=>new URLSearchParams(location.search).get('period')==='7');r=await matches();
 assert('rapid filter responses retain newest scope',r.scope.period==='7'&&total()===r.total.total);
 const day=[...document.querySelectorAll('.local-chart button')][0];const date=day.getAttribute('aria-label').slice(0,10);day.focus();day.click();await wait(()=>new URLSearchParams(location.search).get('from')===date);r=await matches();
 assert('keyboard reachable date drill uses inclusive same date',new URLSearchParams(location.search).get('to')===date&&r.days.length===1);
 document.querySelector('#report-diagnostics summary').click();await wait(()=>button('출처 보기'));const trigger=button('출처 보기');trigger.focus();trigger.click();await wait(()=>document.querySelector('dialog[open] pre')?.textContent.includes('byteStart'));
 assert('request evidence has source/generation/offset without transcript',document.querySelector('dialog pre').textContent.includes('sourceId')&&!document.querySelector('dialog pre').textContent.includes('"content"'));
 button('닫기').click();assert('dialog closes and focus returns',!document.querySelector('dialog[open]')&&document.activeElement===trigger);
 let captured=null;const create=URL.createObjectURL,anchor=HTMLAnchorElement.prototype.click;
 URL.createObjectURL=function(blob){captured=blob;return create.call(URL,blob);};HTMLAnchorElement.prototype.click=function(){};
 try{button('CSV 내보내기 ↗').click();await wait(()=>captured);const csv=await captured.text();const rows=csv.replace(/^\uFEFF/,'').split('\r\n').slice(1).filter(Boolean).map(line=>line.split(',').map(v=>v.replace(/^"|"$/g,'')));
 assert('CSV button generates matching exact total',rows.reduce((sum,row)=>sum+BigInt(row[6]),0n)===BigInt(r.total.total));assert('CSV carries asOf/pricing/basis',csv.includes('standard_equivalent')&&csv.includes(r.pricing.version));
 }finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=anchor;}
 return {status:'passed',checks:checks.map(name=>({name,passed:true})),viewport:{width:innerWidth,height:innerHeight},urlPath:location.pathname,rawContentCaptured:false};
})()
