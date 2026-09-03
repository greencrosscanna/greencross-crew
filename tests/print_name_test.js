#!/usr/bin/env node
/* ─── The Print PDF filename ───────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/print_name_test.js
 *
 * WHY THIS EXISTS
 * Chrome names a Save-as-PDF from `document.title`, so the filename is decided by whatever the tab
 * is called at the moment the dialog opens. Crew's tab is "GX Crew", so an unnamed print filed a
 * payroll record as `GX Crew.pdf` — and the archived reports it has to sit beside are named
 * `Incentive Dashboard - 033026-041226.pdf` (Sky, 2026-09-02).
 *
 * The naming code existed and still did not work, because it lived inside the app's own Print
 * button's click handler. Cmd+P and File > Print — how anybody prints a page they are already
 * looking at — call window.print() directly, and reached the dialog with the title untouched.
 * `beforeprint` is the one hook the browser fires for BOTH routes.
 *
 * Also retired with it: a `setTimeout(restore, 4000)`. It existed because `afterprint` is not
 * universal, but a 4-second timer racing a human choosing a save folder decided the filename on
 * how fast they clicked.
 *
 * WHAT MUST HOLD:
 *   1. MMDDYY-MMDDYY, matching the archive convention exactly.
 *   2. It works for the plain browser print, not just our button.
 *   3. The tab goes back afterwards — one left named after a pay period looks broken.
 *   4. It renames NOTHING when the incentive screen is not the thing being printed.
 *   5. A missing date produces no name rather than half of one.
 */
const fs=require('fs');
let src=fs.readFileSync('crew.js','utf8');
const TAIL='})();';const cut=src.lastIndexOf(TAIL);
src=src.slice(0,cut)+'\n; return { incMMDDYY, incDocName, __setInc:(d,vis)=>{inc.data=d; ui={inc:{style:{display:vis?"block":"none"}}};} };\n'+src.slice(cut);
src=src.replace('(function () {','return (function () {');
const listeners={};
const doc={readyState:'loading',currentScript:{src:'crew.js?v=99'},title:'GX Crew',
  body:{classList:{add(){},remove(){}}},getElementById:()=>null,querySelector:()=>null,
  querySelectorAll:()=>[],createElement:()=>({style:{setProperty(){}},classList:{add(){}},
  setAttribute(){},addEventListener(){},appendChild(){}}),addEventListener(){}};
const win={GXClient:()=>({jsonp:async()=>({})}),GXStores:{color:()=>''},
  addEventListener:(k,f)=>{(listeners[k]=listeners[k]||[]).push(f);},print(){}};
const store={getItem:()=>'',setItem(){},removeItem(){}};
const M=new Function('document','window','sessionStorage','localStorage','location','navigator',src)
  (doc,win,store,store,{hostname:'localhost'},{});
let fail=0;const ok=(l,c)=>c?console.log('  ✓ '+l):(fail++,console.log('  ✗ '+l));

console.log("\nThe format Sky asked for");
ok("2026-03-30 -> 033026", M.incMMDDYY('2026-03-30')==='033026');
ok("2026-04-12 -> 041226", M.incMMDDYY('2026-04-12')==='041226');

const fire=k=>(listeners[k]||[]).forEach(f=>f());
console.log("\nCmd+P on the incentive screen (the case that was broken)");
M.__setInc({pp_start:'2026-03-30',pp_end:'2026-04-12'},true);
fire('beforeprint');
ok('document is named for the pay period', doc.title==='Incentive Dashboard - 033026-041226');
ok('…which is exactly Sky\'s example filename',
   doc.title+'.pdf'==='Incentive Dashboard - 033026-041226.pdf');
fire('afterprint');
ok('and the tab goes back afterwards', doc.title==='GX Crew');

console.log("\nA live period carries its dates on payPeriod instead");
M.__setInc({payPeriod:{start:'2026-08-17',end:'2026-08-30'}},true);
fire('beforeprint');
ok('still named correctly', doc.title==='Incentive Dashboard - 081726-083026');
fire('afterprint');

console.log("\nIt must not rename the tab when you are not looking at incentive");
M.__setInc({pp_start:'2026-03-30',pp_end:'2026-04-12'},false);
fire('beforeprint');
ok('printing the roster leaves the title alone', doc.title==='GX Crew');
fire('afterprint');
ok('and afterprint does not clobber it either', doc.title==='GX Crew');

console.log("\nMissing dates must not produce a half-name");
M.__setInc({pp_start:'2026-03-30'},true);
fire('beforeprint');
ok('no end date -> title untouched', doc.title==='GX Crew');
M.__setInc(null,true);
fire('beforeprint');
ok('no data at all -> title untouched', doc.title==='GX Crew');

console.log(fail?'\n'+fail+' FAILED\n':'\nAll good.\n');process.exit(fail?1:0);
