/* Purchasing Dashboard — client-side analytics over data.js payload.
   Sources (SAP PRD extracts, Documents/duckdb):
     po_receipt    goods-receipt movement ledger   -> spend / receipt / delivery / lead-time
     fact_incoming open PO commitments              -> open / overdue exposure
     fact_konv     landed-cost condition ledger     -> customs / freight / charges
     fact_inventory current stock                   -> purchasing-vs-stock alignment
     dim_vendors   vendor master
   Value basis = dmbtr (local-currency SAR) on GR posting 101 rows. Window excludes 2023. */
'use strict';

const PALETTE = ['#4f8cff','#22c1a4','#f5a623','#ff5d6c','#a78bfa','#33c08a','#ffb347','#7b5cff',
                 '#e8638a','#5fc9e0','#9ad26b','#f08c3b','#7f8ce8','#e0a45c'];
const CAT_COLORS = {'Early':'#22c1a4','On Time':'#33c08a','Late ≤7d':'#f5a623','Late >7d':'#ff5d6c','Missing date':'#6f8298'};
const DKEY = {on:'on_time', early:'early', l7:'late_<=7', lgt:'late_>7', miss:'missing'};
const FONT = "'Segoe UI', Roboto, Arial, sans-serif";
Chart.defaults.font.family = FONT;

let DATA = null;           // window.__PURCHASING__
let AS_OF = null;
const charts = {};
const state = {
  cc:'', vendors:new Set(), year:'', search:'',
  vsPage:1, vsSize:25, vsSort:'spend', vsDir:-1,
  poPage:1, poSize:25, poSort:'del_date', poDir:1,
  vsSearch:'', poSearch:''
};
/* ---------- helpers ---------- */
const fmtInt = n => (n==null?0:n).toLocaleString('en-US',{maximumFractionDigits:0});
const fmtNum = (n,d=0) => (n==null?0:n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:d});
const fmtMoney = n => 'SAR '+fmtNum(n,0);
const fmtMoneyC = n => { // compact SAR
  const a=Math.abs(n||0);
  if(a>=1e9) return 'SAR '+(n/1e9).toFixed(2)+'B';
  if(a>=1e6) return 'SAR '+(n/1e6).toFixed(2)+'M';
  if(a>=1e3) return 'SAR '+(n/1e3).toFixed(1)+'K';
  return 'SAR '+fmtNum(n,0);
};
const fmtPct = n => (n==null?0:n).toFixed(1)+'%';
const esc = s => String(s==null?'':s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
const strip0 = s => String(s==null?'':s).replace(/^0+/,'')||'0';
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function debounce(fn,ms){ let t; return function(...a){ clearTimeout(t); t=setTimeout(()=>fn.apply(this,a),ms); }; }

/* ---------- theme ---------- */
let CURRENT_THEME='dark';
/* Sun/moon pair for the account-menu theme row. Both stay in the DOM and
   cross-fade, so enter AND exit animate. */
const THEME_ICONS=
  '<span class="icon-stack">'+
  '<svg class="icon icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'+
  '<svg class="icon icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>'+
  '</span><span class="theme-item-label"></span>';

function applyTheme(t){
  CURRENT_THEME=t;
  document.documentElement.setAttribute('data-theme',t);
  try{localStorage.setItem('pur-theme',t);}catch(e){}
  const btn=document.getElementById('theme-toggle');
  if(btn){
    // Account-menu row: sun/moon icon + the theme you would switch TO.
    if(!btn.querySelector('.icon-stack')) btn.innerHTML=THEME_ICONS;
    const lab=btn.querySelector('.theme-item-label');
    if(lab) lab.textContent = t==='light' ? 'Dark theme' : 'Light theme';
    btn.setAttribute('aria-label', t==='light' ? 'Switch to dark theme' : 'Switch to light theme');
    btn.title=btn.getAttribute('aria-label');
  }
  Chart.defaults.color = cssVar('--muted') || '#8a99af';
  Chart.defaults.borderColor = t==='light'?'rgba(20,30,50,.12)':'rgba(42,54,71,.6)';
  renderCharts();
}
function initTheme(){ let t='dark'; try{t=localStorage.getItem('pur-theme')||'dark';}catch(e){} applyTheme(t==='light'?'light':'dark'); }

/* ---------- derived / filtered totals ---------- */
// Year-scoped selectors. state.year='' -> all years (use *_gr merged-all); else use *_y[year].
function curDelivery(){ return state.year && DATA.delivery_y && DATA.delivery_y[state.year] ? DATA.delivery_y[state.year] : DATA.delivery; }
function curLead(){ return state.year && DATA.lead_y && DATA.lead_y[state.year] ? DATA.lead_y[state.year] : DATA.lead; }
function vendorsForYear(){ return state.year && DATA.vendor_gr_y && DATA.vendor_gr_y[state.year] ? DATA.vendor_gr_y[state.year] : DATA.vendor_gr; }
function revForYear(){ return state.year && DATA.rev_y && DATA.rev_y[state.year] ? DATA.rev_y[state.year].val : DATA.kpi_spend.rev_val; }
// Dimension rows (incoterm / strategy) honouring the Spend Year filter ('' = all years).
// Each row is {label, cc, val_sar, post}; the per-year map mirrors vendor_gr_y.
function curDimGr(allKey, yKey){
  return state.year && DATA[yKey] && DATA[yKey][state.year] ? DATA[yKey][state.year] : DATA[allKey];
}
function konvMonths(){ // konv_month filtered to selected year ('' = all)
  if(!state.year) return DATA.konv_month;
  return DATA.konv_month.filter(r=>r.ym.slice(0,4)===state.year);
}
function konvTypesAgg(rows){ // recompute type totals from (possibly year-filtered) konv months
  const m={};
  for(const r of rows){ const t=m[r.type]||(m[r.type]={type:r.type,txt:r.txt||'',val:0,rows:0,vendors:0}); t.val+=r.val; t.rows+=r.rows; }
  const arr=Object.values(m); arr.sort((a,b)=>b.val-a.val); return arr;
}

function spendTotal(){
  let val=0,qty=0,ton=0,post=0,po=0,vend=new Set();
  for(const r of DATA.monthly_gr){
    if(state.cc && r.cc!==state.cc) continue;
    if(state.year && r.ym.slice(0,4)!==state.year) continue;
    val+=r.val_sar; qty+=r.qty; ton+=(r.ton||0); post+=r.post;
  }
  const yrVendors = vendorsForYear();
  for(const v of yrVendors){ if(state.cc && v.cc!==state.cc) continue; vend.add(v.vendor); }
  po = poCount();
  return {val,qty,ton,post,po,vendors:vend.size};
}
function poCount(){
  const cc=state.cc||'', yr=state.year||'all';
  return DATA.po_by_ccyear[cc+'|'+yr] || 0;
}
function openRows(){
  const cc=state.cc, qs=state.vendors, q=state.search.trim().toLowerCase();
  let lines=0,val=0,ovLines=0,ovVal=0; const poSet=new Set(),vend=new Set(),perVendor={};
  for(const o of DATA.open_detail){
    if(cc && o.cc!==cc) continue;
    if(qs.size && !qs.has(o.vendor)) continue;
    if(q && !((o.vname||'').toLowerCase()+' '+o.matnr+' '+(o.po||'')).includes(q)) continue;
    lines++; val+=o.value; poSet.add(o.po); vend.add(o.vendor);
    if(o.overdue){ ovLines++; ovVal+=o.value; }
    const k=o.vendor; const pv=perVendor[k]||(perVendor[k]={value:0,ov:0,lines:0});
    pv.value+=o.value; pv.lines++; if(o.overdue) pv.ov+=o.value;
  }
  return {lines,val,ovLines,ovVal,po:poSet.size,vendors:vend.size,perVendor};
}
function leadMap(){ // per (vendor|cc) avg lead time from the current year's 101 receipts
  const arr=(state.year && DATA.vendor_lead_y && DATA.vendor_lead_y[state.year])?DATA.vendor_lead_y[state.year]:DATA.vendor_lead;
  const m=new Map();
  for(const r of arr) m.set((r.vendor||'')+'|'+(r.cc||''),r);
  return m;
}
function filteredVendors(){ // vendor receipt rows honouring cc+year+vendor+search
  const cc=state.cc, qs=state.vendors, q=state.search.trim().toLowerCase();
  const map=new Map();
  const rows = vendorsForYear();
  const lm=leadMap();
  for(const v of rows){
    if(cc && v.cc!==cc) continue;
    if(qs.size && !qs.has(v.vendor)) continue;
    if(q && !((v.name||'').toLowerCase()+' '+v.vendor).includes(q)) continue;
    const e=map.get(v.vendor)||(map.set(v.vendor,{vendor:v.vendor,name:v.name||v.vendor,local:v.local||'',val:0,post:0,po:0,leadW:0,leadPost:0})&&map.get(v.vendor));
    e.val+=v.val_sar; e.post+=v.post; e.po+=v.po;
    const ld=lm.get((v.vendor||'')+'|'+(v.cc||''));
    if(ld && ld.post){ e.leadW+=(ld.lead_days||0)*ld.post; e.leadPost+=ld.post; }
  }
  return [...map.values()].sort((a,b)=>b.val-a.val);
}

/* ---------- KPIs ---------- */
function kpi(container,label,value,sub,cls){
  const el=document.createElement('div'); el.className='kpi '+(cls||'k-value');
  el.innerHTML=`<div class="label">${esc(label)}</div><div class="value">${value}</div>`+(sub?`<div class="sub">${sub}</div>`:'');
  container.appendChild(el);
}
function renderKpis(){
  const sp=spendTotal(), open=openRows();
  const d=curDelivery();
  const elig=d[DKEY.on].post+d[DKEY.early].post+d[DKEY.l7].post+d[DKEY.lgt].post;
  // Standard OTD: received on or before the expected (statistical) delivery date.
  const otPct=elig? (d[DKEY.on].post+d[DKEY.early].post)/elig*100:0;
  const c=document.getElementById('kpis'); c.innerHTML='';
  const yrTxt = state.year? state.year : '2024–'+AS_OF.slice(0,4);
  kpi(c,'Net Received Value', fmtMoneyC(sp.val), fmtInt(sp.post)+' GR rows · '+fmtInt(sp.po)+' POs · '+fmtInt(sp.vendors)+' suppliers · '+yrTxt,'k-value');
  kpi(c,'Received Tonnage', fmtInt(sp.ton)+' t', 'goods received (tonnes) · net of returns · '+yrTxt);
  kpi(c,'Open PO Commitment', fmtMoneyC(open.val), fmtInt(open.lines)+' open lines · '+fmtInt(open.po)+' POs · '+fmtInt(open.vendors)+' suppliers');
  kpi(c,'Overdue Open PO', fmtMoneyC(open.ovVal), fmtInt(open.ovLines)+' lines past expected delivery','k-risk');
  kpi(c,'GR Returns (net)', fmtMoneyC(revForYear()),'reversal postings · already netted into spend','k-warn');
  kpi(c,'On-Time Receipts', fmtPct(otPct),'received on or before expected date · '+yrTxt,'k-good');
  kpi(c,'Avg PO Price', sp.po? fmtMoneyC(sp.val/sp.po):'SAR 0','net received value ÷ distinct POs · '+yrTxt,'k-value');
  const ktot=konvMonths().reduce((s,r)=>s+r.val,0);
  kpi(c,'Landed Cost', fmtMoneyC(ktot),'customs·freight·duty·charges · '+yrTxt,'k-warn');
}

/* ---------- charts ---------- */
function mk(id,cfg){
  const cv=document.getElementById(id); if(!cv) return null;
  const old=charts[id]; if(old){old.destroy(); delete charts[id];}
  try{ charts[id]=new Chart(cv.getContext('2d'),cfg); }catch(e){ console.error('chart '+id,e); }
  return charts[id];
}
// Spend-share doughnut over GR dimension rows [{label,cc,val_sar,post}].
// Collapses slices after topN-1 into "Other" for readability; honours state.cc already applied by caller.
function donutChart(id, rows, topN){
  const m={};
  for(const r of rows){ const k=r.label||'(blank)'; m[k]=(m[k]||0)+r.val_sar; }
  let items=Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k,v]);
  if(items.length>topN){
    const keep=items.slice(0,topN-1);
    const rest=items.slice(topN-1).reduce((s,x)=>s+x[1],0);
    items=keep.concat([['Other',rest]]);
  }
  const tot=items.reduce((s,x)=>s+x[1],0)||1;
  const colors=items.map((_,i)=>PALETTE[i%PALETTE.length]);
  mk(id,{type:'doughnut',data:{labels:items.map(x=>x[0]),datasets:[{data:items.map(x=>x[1]),
    backgroundColor:colors,borderColor:cssVar('--card')||'#fff',borderWidth:2}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'52%',
      plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:9},color:cssVar('--muted')||'#8a99af',
        generateLabels:c=>{const col=cssVar('--muted')||'#8a99af';const bg=c.data.datasets[0].backgroundColor;
          return (c.data.labels||[]).map((lab,i)=>({text:lab.length>20?lab.slice(0,19)+'…':lab,
            fillStyle:bg[i],strokeStyle:bg[i],lineWidth:0,hidden:false,index:i,fontColor:col}));}}},
        tooltip:{callbacks:{label:c=>{const p=(c.parsed/tot*100).toFixed(1);
          return ' '+fmtMoneyC(c.parsed)+'  ('+p+'% of spend)';}}}}}});
}
function baseOpts(yTitle,has2){ // 2nd y axis present
  return {
    responsive:true, maintainAspectRatio:false,
    plugins:{legend:{labels:{boxWidth:12,font:{size:10}}},
      tooltip:{callbacks:{label:ctx=>{let lab=ctx.dataset.label||''; if(lab)lab+=': ';
        return lab+fmtMoneyC(ctx.parsed.y!==undefined?ctx.parsed.y:ctx.parsed);}}}},
    scales:{
      x:{grid:{display:false},ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:12,font:{size:10}}},
      y:{position:'left',ticks:{callback:v=>fmtMoneyC(v)},title:{display:true,text:yTitle,font:{size:10}}},
      ...(has2?{y1:{position:'right',grid:{drawOnChartArea:false},ticks:{callback:v=>fmtInt(v)},title:{display:true,text:'count',font:{size:10}}}}:{})
    }
  };
}
function renderCharts(){
  const d=curDelivery();
  // 1 GR spend trend — line graph, one line per sales org (company code)
  const mc=DATA.monthly_gr.filter(r=>(!state.cc||r.cc===state.cc)&&(!state.year||r.ym.slice(0,4)===state.year));
  // months axis = union of ym, sorted
  const monLabels=[...new Set(mc.map(r=>r.ym))].sort().map(m=>m.slice(0,7));
  const orgs=[...new Set(mc.map(r=>r.cc))].sort();
  const orgColors=['#4f8cff','#22c1a4','#f5a623','#ff5d6c','#a78bfa'];
  const lineSets=orgs.map((cc,i)=>({
    label:'Sales Org '+cc+' (Company '+cc+')',
    data:monLabels.map(m=>{const row=mc.find(r=>r.cc===cc&&r.ym.slice(0,7)===m); return row?row.val_sar:null;}),
    borderColor:orgColors[i%orgColors.length],backgroundColor:orgColors[i%orgColors.length],
    fill:false,tension:.15,pointRadius:2,spanGaps:false
  }));
  mk('chart-spend',{type:'line',data:{labels:monLabels,datasets:lineSets},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{labels:{boxWidth:12,font:{size:10}}},tooltip:{mode:'index',callbacks:{label:c=>c.dataset.label+': '+fmtMoney(c.parsed.y)}}},
      scales:{x:{grid:{display:false},ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:12,font:{size:10}}},
        y:{ticks:{callback:v=>fmtMoneyC(v)},title:{display:true,text:'Net value (SAR)',font:{size:10}}}}}});

  // 2 pareto top15 — removed 2026-09-02

  // 4 vendor share donut removed 2026-09-07

  // 5 delivery (horizontal bar of categories)
  const cat=[[DKEY.early,'Early'],[DKEY.on,'On Time'],[DKEY.l7,'Late ≤7d'],[DKEY.lgt,'Late >7d'],[DKEY.miss,'Missing date']];
  const delElig=d[DKEY.on].post+d[DKEY.early].post+d[DKEY.l7].post+d[DKEY.lgt].post;
  mk('chart-delivery',{type:'bar',data:{labels:cat.map(c=>c[1]+'  ('+fmtPct(delElig? d[c[0]].post/delElig*100:0)+')'),datasets:[{
    data:cat.map(c=>d[c[0]].post),backgroundColor:cat.map(c=>CAT_COLORS[c[1]]),borderColor:cat.map(c=>CAT_COLORS[c[1]]),borderWidth:1
  }]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmtInt(c.parsed.x)+' receipts'}}},
    scales:{x:{grid:{display:false},ticks:{callback:v=>fmtInt(v)}},y:{ticks:{font:{size:11}},grid:{display:false}}}}});

  // 6 lead time — removed 2026-09-08 (replaced by Landed Cost by Condition)

  // 7 pgrp — removed 2026-09-02

  // 8 open by delivery month (value only, Lines overlay removed)
  const om=DATA.open_month.filter(r=>!state.cc||r.cc===state.cc).sort((a,b)=>a.ym<b.ym?-1:1);
  mk('chart-open-month',{type:'bar',data:{labels:om.map(r=>r.ym),datasets:[
    {label:'Open value (SAR)',data:om.map(r=>r.value),backgroundColor:'rgba(245,166,35,.7)',borderColor:'#f5a623',borderWidth:1}
  ]},options:baseOpts('Open commitment (SAR)',false)});

  // 9 open by vendor top10
  const ov=DATA.open_vendor.filter(r=>!state.cc||r.cc===state.cc).sort((a,b)=>b.value-a.value).slice(0,10);
  mk('chart-open-vendor',{type:'bar',data:{labels:ov.map(v=>(v.name||v.vendor).slice(0,20)),datasets:[{label:'Open value (SAR)',data:ov.map(v=>v.value),backgroundColor:'rgba(245,166,35,.7)',borderColor:'#f5a623',borderWidth:1}]},
    options:baseOpts('Open (SAR)',false)});

  // 9b open by material top10 (tooltip shows open value + qty + tonnage)
  const omat=DATA.open_material.filter(r=>!state.cc||r.cc===state.cc).sort((a,b)=>b.value-a.value).slice(0,10);
  mk('chart-open-material',{type:'bar',data:{labels:omat.map(m=>(m.descr||m.matnr).slice(0,20)),datasets:[{label:'Open value (SAR)',data:omat.map(m=>m.value),backgroundColor:'rgba(245,166,35,.7)',borderColor:'#f5a623',borderWidth:1}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},
      tooltip:{callbacks:{afterLabel:c=>{const r=omat[c.dataIndex];
        return 'Open qty: '+fmtInt(r.qty)+'  ·  '+fmtInt(r.ton)+' t';}}}},
      scales:{x:{ticks:{callback:v=>fmtMoneyC(v)}},y:{ticks:{font:{size:11}},grid:{display:false}}}}});

  // 10 konv monthly stacked (year-scoped) — horizontal orientation (months as rows)
  const kt=konvMonths(); const ymSet=[...new Set(kt.map(r=>r.ym))].sort().reverse(); // newest on top
  const ktypes=konvTypesAgg(kt);
  const topTypes=ktypes.slice(0,5).map(t=>t.type);
  const setA=topTypes.map((t,i)=>({label:(ktypes.find(x=>x.type===t)||{}).txt||t,
    data:ymSet.map(ym=>kt.filter(r=>r.type===t&&r.ym===ym).reduce((s,r)=>s+r.val,0)),backgroundColor:PALETTE[i%PALETTE.length],stack:'s'}));
  setA.push({label:'Other',data:ymSet.map(ym=>kt.filter(r=>!topTypes.includes(r.type)&&r.ym===ym).reduce((s,r)=>s+r.val,0)),backgroundColor:'#3a4a5e',stack:'s'});
  mk('chart-konv-month',{type:'bar',data:{labels:ymSet.map(x=>x.slice(0,7)),datasets:setA},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{labels:{boxWidth:11,font:{size:9}}},tooltip:{mode:'index',callbacks:{label:c=>c.dataset.label+': '+fmtMoneyC(c.parsed.x)}}},
      scales:{y:{stacked:true,grid:{display:false},ticks:{font:{size:9}}},x:{stacked:true,ticks:{callback:v=>fmtMoneyC(v)},title:{display:false}}}}});

  // 11 konv type (year-scoped)
  const kvc=[...konvTypesAgg(konvMonths())].sort((a,b)=>b.val-a.val).slice(0,9);
  mk('chart-konv-type',{type:'bar',data:{labels:kvc.map(t=>(t.txt||t.type).slice(0,20)),datasets:[{label:'Amount',data:kvc.map(t=>t.val),backgroundColor:'rgba(245,166,35,.75)',borderColor:'#f5a623',borderWidth:1}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{x:{ticks:{callback:v=>{const a=Math.abs(v);if(a>=1e6)return (v/1e6)+'M';if(a>=1e3)return (v/1e3)+'K';return v;}}},y:{ticks:{font:{size:11}}}}}});

  // 12 GR spend share by Incoterms (year/company scoped) — top 8 + Other
  donutChart('chart-incoterm', curDimGr('incoterm_gr','incoterm_gr_y').filter(r=>!state.cc||r.cc===state.cc), 8);

  // 13 GR spend share by Strategy Group (year/company scoped)
  donutChart('chart-strategy', curDimGr('strategy_gr','strategy_gr_y').filter(r=>!state.cc||r.cc===state.cc), 8);

  // 14 Point of Destination
  donutChart('chart-dest', curDimGr('dest_gr','dest_gr_y').filter(r=>!state.cc||r.cc===state.cc), 8);

  // 16 Container type
  donutChart('chart-container', curDimGr('container_gr','container_gr_y').filter(r=>!state.cc||r.cc===state.cc), 8);

  // 17 Freight forwarder (vendor name)
  donutChart('chart-forwarder', curDimGr('forwarder_gr','forwarder_gr_y').filter(r=>!state.cc||r.cc===state.cc), 8);

  // 18 Broker (vendor name)
  donutChart('chart-broker', curDimGr('broker_gr','broker_gr_y').filter(r=>!state.cc||r.cc===state.cc), 8);
}

/* ---------- vendor scorecard ---------- */
function vendorScoreBuild(){
  const open=openRows(); const total=spendTotal().val;
  return filteredVendors().map(v=>{
    const o=open.perVendor[v.vendor]||{value:0,ov:0,lines:0};
    const local=v.local==='LOCAL'?'Local':v.local==='FOREIGN'?'Foreign':(v.local||'—');
    const share=total?v.val/total*100:0;
    const avgLead=v.leadPost? v.leadW/v.leadPost : null;
    const avgPOVal=v.po? v.val/v.po : null;
    return {vendor:v.vendor,name:v.name,local,spend:v.val,share,post:v.post,po:v.po,
      avgLead,avgPOVal,openVal:o.value,overdue:o.ov,risk:riskFrom(o.ov,share)};
  });
}
function riskFrom(overdue,share){
  if(overdue>5e6) return 'High';
  if(overdue>0) return 'Watch';
  if(share>30) return 'Watch';
  return 'Low';
}
function renderVendorTable(){
  const rows=vendorScoreBuild();
  rows.forEach(r=>{ r._sortLead = r.avgLead==null?Infinity:r.avgLead;
                    r._sortAPV = r.avgPOVal==null?-Infinity:r.avgPOVal; });
  const skey = state.vsSort==='avgLead' ? '_sortLead' : state.vsSort==='avgPOVal' ? '_sortAPV' : state.vsSort;
  rows.sort((a,b)=>state.vsDir<0?b[skey]-a[skey]:a[skey]-b[skey]);
  document.getElementById('vs-count').textContent=rows.length+' suppliers';
  const tbody=document.querySelector('#vendor-table tbody'); tbody.innerHTML='';
  const pgsz=state.vsSize,total=rows.length,pages=Math.max(1,Math.ceil(total/pgsz));
  state.vsPage=Math.min(state.vsPage,pages);
  rows.slice((state.vsPage-1)*pgsz,state.vsPage*pgsz).forEach(r=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(r.vendor)}</td><td style="white-space:normal;min-width:170px">${esc(r.name)}</td><td>${esc(r.local)}</td>
      <td class="num">${fmtNum(r.spend,0)}</td><td class="num">${fmtPct(r.share)}</td>
      <td class="num">${fmtInt(r.post)}</td><td class="num">${fmtInt(r.po)}</td>
      <td class="num ${r.avgLead==null?'dim':''}">${r.avgLead==null?'—':fmtNum(r.avgLead,0)+' d'}</td>
      <td class="num ${r.avgPOVal==null?'dim':''}">${r.avgPOVal==null?'—':fmtMoneyC(r.avgPOVal)}</td>
      <td class="num">${r.openVal?fmtNum(r.openVal,0):'0'}</td>
      <td class="num ${r.overdue?'':'dim'}">${r.overdue?fmtNum(r.overdue,0):'0'}</td>
      <td><span class="tag ${r.risk==='High'?'t-High':r.risk==='Watch'?'t-Watch':'t-Healthy'}">${r.risk}</span></td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('vs-page-info').textContent=`Page ${state.vsPage} of ${pages} · ${total} rows`;
  document.getElementById('vs-prev').disabled=state.vsPage<=1;
  document.getElementById('vs-next').disabled=state.vsPage>=pages;
}

/* ---------- incoming purchase-orders table (all open lines) ---------- */
function poRows(){
  const cc=state.cc, qs=state.vendors;
  const q = (state.poSearch||'').trim().toLowerCase();
  const gq = state.search.trim().toLowerCase();
  const rows=[];
  for(const o of DATA.open_detail){
    if(cc && o.cc!==cc) continue;
    if(qs.size && !qs.has(o.vendor)) continue;
    const status = o.overdue ? 'Overdue' : 'Incoming';
    const hay = ((o.po||'')+' '+(o.item||'')+' '+o.matnr+' '+(o.descr||'')+' '+(o.vname||'')).toLowerCase();
    if(q && !hay.includes(q)) continue;
    if(gq && !((o.vname||'').toLowerCase()+' '+o.matnr+' '+(o.descr||'')+' '+(o.po||'')).includes(gq)) continue;
    rows.push({...o, status, ship:o.ship||''});
  }
  return rows;
}
function renderPoTable(){
  let rows=poRows();
  // sort
  const k=state.poSort, dir=state.poDir;
  rows.sort((a,b)=>{
    if(k==='qty'||k==='value') return (a[k]-b[k])*dir;
    const x=(a[k]==null?'':String(a[k])), y=(b[k]==null?'':String(b[k]));
    return x<y?-dir:x>y?dir:0;
  });
  const tbody=document.querySelector('#po-table tbody'); tbody.innerHTML='';
  const pgsz=state.poSize,total=rows.length,pages=Math.max(1,Math.ceil(total/pgsz));
  state.poPage=Math.min(state.poPage,pages);
  const nIncoming=rows.filter(r=>r.status==='Incoming').length;
  const totVal=rows.reduce((s,r)=>s+r.value,0);
  document.getElementById('po-count').textContent=fmtInt(total)+' lines · '+fmtInt(nIncoming)+' incoming · '+fmtMoney(totVal);
  rows.slice((state.poPage-1)*pgsz,state.poPage*pgsz).forEach(o=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${esc(o.po)}</td><td>${esc(o.item)}</td><td>${esc(o.matnr)}</td>
      <td style="white-space:normal;min-width:190px">${esc(o.descr||'—')}</td><td style="white-space:normal;min-width:150px">${esc(o.vname||o.vendor)}</td>
      <td class="num">${fmtInt(o.qty)}</td><td>${esc(o.uom)}</td>
      <td class="num">${fmtMoney(o.value)}</td><td>${o.po_date?esc(o.po_date.slice(0,10)):'—'}</td>
      <td>${o.del_date?esc(o.del_date.slice(0,10)):'—'}</td>
      <td><span class="tag ${o.status==='Incoming'?'t-Incoming':'t-Overdue'}">${o.status}</span></td>
      <td>${esc(o.ship||'—')}</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('po-page-info').textContent=`Page ${state.poPage} of ${pages} · ${fmtInt(total)} lines`;
  document.getElementById('po-prev').disabled=state.poPage<=1;
  document.getElementById('po-next').disabled=state.poPage>=pages;
}

/* ---------- methodology ---------- */
function renderMethodology(){
  const el=document.getElementById('method-body');
  el.innerHTML=`
  <h3>Value basis &amp; grain</h3>
  <ul>
    <li><b>Goods-receipt spend</b> uses the GR movement ledger (<code>po_receipt</code>) with value basis
    <code>sar_net_value</code> — the net value already converted to SAR — over goods-receipt rows from 2024 onward,
    <b>net of returns</b> (reversal rows 102/161/122/162 carry negative values and are included). This is the same
    definition the PSI dashboard uses, so the headline Net Received Value reconciles to PSI (~SAR 4.63B).</li>
    <li><b>Quantity</b> = <code>gr_menge</code> (net of returns).</li>
    <li><b>Reversal / return rows</b> are counted in their own month, so the spend trend is net; the GR Returns KPI
    reports the reversal subset for visibility.</li>
    <li><b>Open PO commitment</b> = open purchase-order lines in <code>fact_incoming</code> (still to receive) — the authoritative open layer, same one used by the PSI &amp; Inventory dashboards.</li>
    <li><b>Overdue</b> = an open PO line whose expected delivery date is earlier than the data "as of" date (<code>${esc(AS_OF||'')}</code>).</li>
    <li><b>Landed cost</b> = <code>fact_konv</code> condition ledger (customs duty, freight, port / transport, insurance, detention …). It has no PO/material key, so it is aggregated independently (vendor + condition type + month) and is <b>never joined</b> to PO lines — no spend double count.</li>
    <li><b>Delivery performance</b> compares the GR date to the statistically-released delivery date (<code>stat_rel_del_date</code>) on goods-receipt (101) postings; records without a usable expected date are reported as "missing" and excluded. On-Time Delivery = received on or before the expected date (early + on-time).</li>
    <li><b>Lead time</b> = GR date − PO creation date on goods-receipt (101) postings.</li>
    <li><b>Received Tonnage</b> = <code>SUM(tonnage)</code> over the net goods-receipt universe (year/company scoped).</li>
    <li><b>Avg PO Price</b> = net received value ÷ distinct POs in the selected year/company.</li>
    <li><b>Avg Supplier Lead Time</b> (scorecard) = <code>AVG(GR date − PO date)</code> per supplier over goods-receipt (101) postings, weighted by postings across years.</li>
    <li><b>Avg PO Value</b> (scorecard) = a supplier's received spend ÷ its distinct POs.</li>
    <li><b>Risk</b> (scorecard) is an open-exposure &amp; concentration signal — it does not score delivery/lead-time performance. <b>High</b> = overdue open value &gt; SAR 5M; <b>Watch</b> = any overdue open value or spend share &gt; 30% (over-dependence); <b>Low</b> = no overdue open value and share ≤ 30%. Overdue = open PO lines in <code>fact_incoming</code> whose expected delivery date is before the as-of date; share = supplier spend ÷ total net spend for the selected year/company.</li>
    <li><b>Spend-share charts</b> (Incoterms, Strategy Group, Point of Destination, Container, Freight Forwarder, Broker) group net received value off <code>po_receipt</code>. Freight-forwarder and broker values are vendor codes resolved to names via <code>dim_vendors</code>; blank values are reported as "(blank)" (incoterms) or "Not Defined".</li>
    <li><b>Stock</b> = <code>fact_inventory</code> current on-hand at material level, used only to compare purchasing / incoming against what is held (no inventory-aging here).</li>
    <li><b>Window</b>: goods-receipt analytics cover 2024 onward (2023 is a partial extract year, excluded — matching the PSI / Inventory dashboards).</li>
  </ul>
  <h3>Fact-to-fact join protection</h3>
  <p style="color:var(--text)">No raw fact-to-fact join is performed. Goods-receipt (spend), open-commitment (incoming), landed-cost (konv) and stock (inventory) are separate sources kept at their own grain; they meet only at material / vendor level for comparison. History-vs-open are therefore different snapshots (received history vs. currently-open) and no "Ordered = Received + Open" identity is forced.</p>
  <div class="disclaimer"><b>⚠️ Disclaimer:</b> Dashboard figures are derived estimates for management monitoring and decision support only. They are not audited accounting values; spend uses net SAR goods-receipt values and may differ from SAP standard reports on alternate valuation / currency bases. Open commitments and landed cost are subject to the completeness of the source extracts. Validate against SAP before making operational or financial decisions.</div>`;
}

/* ---------- filters ---------- */
function populateFilters(){
  const yr=document.getElementById('f-year');
  // "All years" option (clears the year filter)
  const all=document.createElement('option'); all.value=''; all.textContent='All years'; yr.appendChild(all);
  const yrs=[...new Set(DATA.monthly_gr.map(r=>r.ym.slice(0,4)))].sort().reverse();
  yrs.forEach(y=>{const o=document.createElement('option'); o.value=y; o.textContent=y; yr.appendChild(o);});
}
function bindFilters(){
  const tb=document.getElementById('theme-toggle'); if(tb) tb.addEventListener('click',()=>applyTheme(CURRENT_THEME==='light'?'dark':'light'));
  document.getElementById('f-cc').addEventListener('change',e=>{state.cc=e.target.value;state.vsPage=1;state.poPage=1;refresh();});
  document.getElementById('f-year').addEventListener('change',e=>{state.year=e.target.value;state.vsPage=1;refresh();});
  document.getElementById('f-search').addEventListener('input',debounce(e=>{state.search=e.target.value;state.vsPage=1;state.poPage=1;refresh();},200));
  document.getElementById('reset').addEventListener('click',()=>{
    Object.assign(state,{cc:'',year:'',search:'',vsPage:1,poPage:1,poSearch:''}); state.vendors.clear();
    document.getElementById('f-cc').value='';document.getElementById('f-year').value='';
    document.getElementById('f-search').value=''; syncMsToggle(); refresh();
  });
  bindPage('vs',renderVendorTable); bindPage('po',renderPoTable);
  // PO table column sort
  document.querySelectorAll('#po-table th').forEach((th,i)=>{
    th.addEventListener('click',()=>{ const key={0:'po',1:'item',2:'matnr',3:'descr',4:'vname',5:'qty',6:'uom',7:'value',8:'po_date',9:'del_date',10:'status',11:'ship'}[i];
      if(!key)return; if(state.poSort===key)state.poDir*=-1; else{state.poSort=key;state.poDir=-1;} state.poPage=1; renderPoTable(); });
  });
  // PO table header search control
  const poSearchIn=document.getElementById('po-search'); if(poSearchIn) poSearchIn.addEventListener('input',debounce(e=>{state.poSearch=e.target.value;state.poPage=1;renderPoTable();},200));
  // column-header sort for vendor table
  document.querySelectorAll('#vendor-table th').forEach((th,i)=>{
    th.addEventListener('click',()=>{ const key={1:'name',2:'local',3:'spend',4:'share',5:'post',6:'po',7:'avgLead',8:'avgPOVal',9:'openVal',10:'overdue'}[i];
      if(!key)return; if(state.vsSort===key)state.vsDir*=-1; else{state.vsSort=key;state.vsDir=-1;} state.vsPage=1; renderVendorTable(); });
  });
  document.getElementById('export-vendor-csv').addEventListener('click',()=>exportTableCSV('#vendor-table','Supplier'));
  const expPo=document.getElementById('export-po-csv'); if(expPo) expPo.addEventListener('click',()=>exportTableCSV('#po-table','IncomingPOs'));
}
function bindPage(prefix,render){
  document.getElementById(prefix+'-prev').addEventListener('click',()=>{state[prefix+'Page']--;render();});
  document.getElementById(prefix+'-next').addEventListener('click',()=>{state[prefix+'Page']++;render();});
  document.getElementById(prefix+'-page-size').addEventListener('change',e=>{state[prefix+'Size']=+e.target.value;state[prefix+'Page']=1;render();});
}
function exportTableCSV(sel,name){
  const tbl=document.querySelector(sel);
  const heads=[...tbl.querySelectorAll('thead th')].map(h=>h.textContent.trim());
  const rows=[...tbl.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim().replace(/,/g,'')).join(','));
  const csv=[heads.join(','),...rows].join('\n');
  const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name+'_'+new Date().toISOString().slice(0,10)+'.csv'; a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- vendor multiselect ---------- */
function initVendorMs(){
  const box=document.querySelector('.ms[data-key="vendor"]');
  const names={}; DATA.vendor_gr.forEach(v=>{ names[v.vendor]=v.name||v.vendor; });
  const opts=[...new Set(DATA.vendor_gr.map(v=>v.vendor))].sort((a,b)=>(names[a]||'').localeCompare(names[b]||''));
  box.innerHTML=`<button type="button" class="ms-toggle" id="ms-vendor"><span class="cnt">All</span><span class="chev">▾</span></button>
    <div class="ms-menu"><input class="ms-search" id="ms-vendor-s" placeholder="Search suppliers…"/>
      <div class="ms-list" id="ms-vendor-list"></div>
      <div class="ms-actions"><button type="button" data-all="1">All</button><button type="button" data-none="1">None</button></div></div>`;
  const list=document.getElementById('ms-vendor-list');
  function draw(filter){
    list.innerHTML='';
    opts.filter(v=>(names[v]||'').toLowerCase().includes(filter)).forEach(v=>{
      const l=document.createElement('label'); l.className='ms-opt';
      l.innerHTML=`<input type="checkbox" value="${esc(v)}" ${state.vendors.has(v)?'checked':''}/><span>${esc(names[v]||v)}</span>`;
      l.addEventListener('click',e=>{ if(e.target.tagName!=='INPUT'){const cb=l.querySelector('input');cb.checked=!cb.checked;}
        if(l.querySelector('input').checked) state.vendors.add(v); else state.vendors.delete(v); syncMsToggle(); state.vsPage=1; refresh(); });
      list.appendChild(l);
    });
  }
  draw('');
  document.getElementById('ms-vendor-s').addEventListener('input',e=>draw(e.target.value.toLowerCase()));
  box.querySelector('.ms-toggle').addEventListener('click',e=>{ e.stopPropagation(); box.classList.toggle('open'); });
  box.querySelectorAll('.ms-actions button').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation();
    if(b.dataset.all){ state.vendors.clear(); opts.forEach(v=>state.vendors.add(v)); } else state.vendors.clear();
    syncMsToggle(); draw(document.getElementById('ms-vendor-s').value.toLowerCase()); state.vsPage=1; refresh(); }));
  document.addEventListener('click',e=>{ if(!box.contains(e.target)) box.classList.remove('open'); });
}
function syncMsToggle(){
  const n=state.vendors.size, total=DATA?DATA.vendor_gr.length:0;
  const t=document.getElementById('ms-vendor'); if(!t) return;
  t.querySelector('.cnt').textContent= n===0?'All':n===total?'All ('+total+')':n+' sel';
}

/* ---------- refresh ---------- */
function refresh(){ renderKpis(); renderCharts(); renderVendorTable(); renderPoTable(); }
function renderReconStatus(){}

/* ---------- boot ---------- */
function boot(){
  if(!window.__PURCHASING__){ document.getElementById('kpis').innerHTML='<p class="hint">Data payload not found.</p>'; return; }
  DATA=window.__PURCHASING__; AS_OF=DATA.as_of;
  initTheme();
  document.getElementById('meta-time').textContent='Data refreshed: '+(DATA.generated_at||'')+' · as of '+AS_OF;
  populateFilters(); bindFilters(); initVendorMs(); renderMethodology();
  // Default the year filter to the current calendar year (data as-of year) so the dashboard
  // opens on current-year activity. The dropdown has an "All years" option to widen the window.
  const curY = String(AS_OF).slice(0,4);
  if(DATA.monthly_gr.some(r=>r.ym.slice(0,4)===curY)){
    state.year = curY;
    const sel=document.getElementById('f-year');
    if(sel){ sel.value=curY; }
  }
  refresh();
}
// Boot only after the login gate confirms a session (auth.js dispatches auth:ready).
document.addEventListener('auth:ready', boot);
// Fallback for local double-click testing without auth files present: boot anyway.
// (typeof check — top-level const does not attach to window)
if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
  document.addEventListener('DOMContentLoaded', boot);
}
