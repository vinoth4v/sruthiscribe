// Notation line-wrap fix tests: CSS no longer forces horizontal scroll, and
// the PDF's wrapLineToRows keeps every cell on the page even at high speed
// (where a single avartana can hold up to 64 svaras).
const fs = require('fs'); const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'), 'utf8');

let pass=0, fail=0;
const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

console.log('--- CSS: the actual root cause of the horizontal-scroll bug is gone ---');
{
  const cssMatch = html.match(/\.notation\{[^}]*\}/);
  chk('.notation rule found', !!cssMatch);
  chk('white-space:nowrap removed (this was forcing each line to refuse to wrap)',
      !/white-space:\s*nowrap/.test(cssMatch[0]), cssMatch[0]);
  chk('overflow-x:auto kept as a defensive fallback', /overflow-x:\s*auto/.test(cssMatch[0]));
}

console.log('--- wrapLineToRows (extracted for pure-logic testing) ---');
{
  const start = html.indexOf('function wrapLineToRows(line){');
  const braceStart = html.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < html.length; i++){ if (html[i]==='{') depth++; if (html[i]==='}'){ depth--; if (depth===0) break; } }
  const src = html.slice(start, i+1);
  const sb = {};
  new (require('vm').Script)('var MAX_PER_ROW=8;\n'+src+'\nthis.wrapLineToRows=wrapLineToRows;').runInNewContext(sb);

  function cell(countable){ return { countable: countable }; }

  const line8 = Array.from({length:8}, ()=>cell(true));
  chk('8 cells (1x Adi avartana) -> exactly 1 row, unchanged from before', sb.wrapLineToRows(line8).length === 1);

  const line64 = Array.from({length:64}, ()=>cell(true));
  const rows64 = sb.wrapLineToRows(line64);
  chk('64 cells (8x Adi avartana) -> exactly 8 rows of 8, none over the cap',
      rows64.length === 8 && rows64.every(r=>r.filter(c=>c.countable).length<=8),
      rows64.map(r=>r.length));
  chk('no cell lost or duplicated across the wrap', rows64.reduce((s,r)=>s+r.length,0) === 64);

  const line10 = Array.from({length:10}, ()=>cell(true));
  const rows10 = sb.wrapLineToRows(line10);
  chk('10 cells -> 2 rows (8 + 2), not one row of 10 (the original bug shape)',
      rows10.length === 2 && rows10[0].length === 8 && rows10[1].length === 2, rows10.map(r=>r.length));

  // Bar/section markers on the first cell must survive being in row 1 only.
  const lineWithBar = [Object.assign(cell(true), {bar:'avartana'})].concat(Array.from({length:9}, ()=>cell(true)));
  const rowsBar = sb.wrapLineToRows(lineWithBar);
  chk('the avartana marker stays on its own cell in row 1, not duplicated into row 2',
      rowsBar[0][0].bar==='avartana' && !rowsBar[1].some(c=>c.bar));

  // Uncountable (transit) cells interspersed among countable ones don't
  // themselves force an early break -- only reaching 8 countable cells does.
  const interspersed = [cell(true), cell(false), cell(true), cell(false), cell(true),
    cell(true), cell(true), cell(true), cell(true), cell(true)]; // 8 countable + 2 transit, mixed in
  const rowsI = sb.wrapLineToRows(interspersed);
  chk('interspersed transit cells travel with the row, only the 8th countable cell ends it',
      rowsI.length === 1 && rowsI[0].length === 10, rowsI.map(r=>r.length));
}

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
