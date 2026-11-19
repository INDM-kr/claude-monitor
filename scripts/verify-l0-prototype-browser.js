(async () => {
  // Execute via gstack browse eval while the local L0 prototype is open.
  // Keep this file a single expression so browse returns its awaited result.
  // Exercises only synthetic local UI; no real agent controls or account actions.
  const checks = [];
  const pause = () => new Promise(resolve => setTimeout(resolve, 45));
  const q = selector => { const el=document.querySelector(selector); if(!el)throw new Error('Missing '+selector); return el; };
  const click = async selector => { q(selector).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); await pause(); };
  const select = async (selector,value) => { q(selector).value=value; q(selector).dispatchEvent(new Event('change',{bubbles:true})); await pause(); };
  const route = async name => { location.hash=name; await pause(); };
  const check = (name,condition) => { if(!condition)throw new Error(name); checks.push(name); };
  const total = () => Number(q('.metrics').dataset.total);
  const projectSum = () => [...document.querySelectorAll('[data-project-total]')].reduce((n,e)=>n+Number(e.dataset.projectTotal),0);
  await route('overview'); await select('#scenario','normal'); await click('[data-days="7"]');
  check('7-day total equals explicit demo oracle and project sum',total()===5077000&&projectSum()===5077000);
  await click('[data-days="30"]');
  check('30-day total and 30 day bars',total()===23805000&&projectSum()===23805000&&document.querySelectorAll('[data-day]').length===30);
  await click('[data-days="1"]');
  check('Today ends at demo asOf',total()===524000);
  await route('usage'); await click('[data-days="30"]'); await select('#model-filter','예시 모델 B');
  check('Model filter scopes metrics and project table',total()===2730000&&projectSum()===2730000&&document.querySelectorAll('[data-project-total]').length===1);
  await select('#model-filter','all'); await click('.project-button[data-project="relay"]');
  check('Project row opens project and its run',q('h1').textContent==='Relay API'&&document.querySelectorAll('.run-row').length===1);
  await route('usage'); await click('[data-days="7"]');
  await click('[data-day="2026-09-22"]');
  check('Chart day drills into that date only',total()===1040000&&projectSum()===1040000&&Boolean(document.querySelector('.filter-chip')));
  await click('[data-action="clear-day"]');
  check('Clearing day restores full selected period',total()===5077000);
  await select('#chart-group','type');
  check('Token breakdown does not change total',total()===5077000&&q('.legend').textContent.includes('캐시 읽기'));
  const create=URL.createObjectURL, revoke=URL.revokeObjectURL, anchorClick=HTMLAnchorElement.prototype.click;
  let blob;
  try {
    URL.createObjectURL=b=>{blob=b;return 'blob:local-demo-test';};
    URL.revokeObjectURL=()=>{};
    HTMLAnchorElement.prototype.click=function(){};
    await click('[data-action="export"]');
    const csv=await blob.text();
    const csvRows=csv.trim().split(/\r?\n/).slice(1).map(line=>line.slice(1,-1).split('","'));
    check('CSV generation matches visible token scope',csvRows.reduce((n,row)=>n+Number(row[8]),0)===total()&&csv.includes('illustrative-standard-global'));
  } finally { URL.createObjectURL=create;URL.revokeObjectURL=revoke;HTMLAnchorElement.prototype.click=anchorClick; }
  await route('overview'); await click('[data-action="attention"]');
  check('Attention shortcut opens two actionable runs',q('h1').textContent==='실행 현황'&&document.querySelectorAll('.run-row').length===2);
  await click('[data-run="run-b"]');
  check('Run detail retains stable task title and outcome distinction',q('#run-dialog').open&&q('#run-title').textContent==='결제 웹훅 중복 처리 방지'&&q('#run-detail').textContent.includes('업무 결과 아직 검증되지 않음'));
  q('#run-dialog').close();
  await route('overview');
  for(const [scenario,expected] of [['empty','사용 기록이 없습니다'],['loading','전체 합계를 확정하지 않습니다'],['error','사용량을 확인할 수 없습니다'],['partial','일부 기록'],['stale','관측이 지연'],['unsupported','요율을 확인할 수 없습니다']]) {
    await select('#scenario',scenario);
    check('Explicit '+scenario+' state',q('main').textContent.includes(expected));
    if(['empty','loading','error'].includes(scenario))check('No misleading KPI strip in '+scenario,!document.querySelector('.metrics'));
    if(['loading','error'].includes(scenario))check('CSV disabled for '+scenario,q('[data-action="export"]').disabled);
    if(scenario==='unsupported')check('Unknown cost preserves token total',total()===5077000&&q('.metrics').textContent.includes('미산정'));
    if(scenario==='stale')check('Stale attention is not a confirmed wait count',q('.attention-panel').textContent.includes('미확인'));
  }
  await select('#scenario','normal');
  check('Viewport has no page overflow',document.documentElement.scrollWidth<=window.innerWidth);
  return {status:'pass',checks,viewport:{width:innerWidth,height:innerHeight},scope:'Synthetic prototype only. CSV content generation inspected; operating-system download completion not asserted.'};
})()
