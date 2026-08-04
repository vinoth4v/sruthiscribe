// WCAG contrast audit of the new palette. Colours are parsed straight out of
// the stylesheet's :root block, so this checks what actually ships, not a
// hand-copied list that could drift from the CSS.
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'), 'utf8');

let pass=0, fail=0;
const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

const root = html.match(/:root\{[\s\S]*?\n\}/)[0];
const vars = {};
root.replace(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})/g, (m,k,v)=>{ vars[k]=v; return m; });
console.log('parsed tokens:', Object.keys(vars).join(', '));

function srgb(hex){
  hex = hex.replace('#','');
  if (hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  return [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255);
}
function lum(hex){
  const [r,g,b] = srgb(hex).map(c => c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4));
  return 0.2126*r + 0.7152*g + 0.0722*b;
}
function ratio(a,b){
  const la = lum(a), lb = lum(b);
  return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);
}

// Each pairing that a user actually reads, with the WCAG threshold that applies.
// 4.5 = normal body text (AA). 3.0 = large text (>=18.66px bold / 24px) and
// meaningful non-text elements like bar lines and focus rings (AA).
// Each pairing a reader actually looks at, with the WCAG threshold that
// applies: 4.5 for body text (AA), 3.0 for large text and meaningful non-text
// marks. The palette is light -- --ink is the text colour and --bg the page --
// which is the opposite of the dark scheme these pairs were first written for.
const pairs = [
  ['body text on page',           'ink',        'bg',        4.5],
  ['body text on card',           'ink',        'surface',   4.5],
  ['body text on tinted card',    'ink',        'surface-2', 4.5],
  ['secondary text on page',      'ink-2',      'bg',        4.5],
  ['muted text on page',          'muted',      'bg',        4.5],
  ['muted text on card',          'muted',      'surface',   4.5],
  ['faint label on card',         'faint',      'surface',   3.0],
  ['accent on page',              'accent',     'bg',        4.5],
  ['accent on card',              'accent',     'surface',   4.5],
  ['peacock on page',             'teal',       'bg',        4.5],
  ['peacock on card',             'teal',       'surface',   4.5],
  ['gold on page',                'gold',       'bg',        4.5],
  ['gold on card',                'gold',       'surface',   4.5],
  ['error text on page',          'danger',     'bg',        4.5],
  ['NOTATION: svara on paper',    'paper-ink',  'paper',     4.5],
  ['NOTATION: syllable on paper', 'paper-dim',  'paper',     4.5],
  ['panel text on the stave panel','panel-text','panel',     4.5],
  ['panel dim on the stave panel', 'panel-dim', 'panel',     4.5],
];
pairs.forEach(([label, fgKey, bgKey, min])=>{
  const fg = vars[fgKey], bg = vars[bgKey];
  chk(label + ' tokens exist', !!fg && !!bg, fgKey+'='+fg+' '+bgKey+'='+bg);
  if (!fg || !bg) return;
  const r = ratio(fg, bg);
  chk(label + ' (' + fg + ' on ' + bg + ') meets ' + min + ':1',
      r >= min, 'measured ' + r.toFixed(2) + ':1');
});

// The beta chip in the header sets its colour literally, so check the literal.
const beta = (html.match(/\.brand \.beta\{[^}]*color:(#[0-9A-Fa-f]{6})/)||[])[1];
chk('beta chip colour found in CSS', !!beta, beta);
if (beta) chk('beta chip on soft gold meets 4.5:1',
              ratio(beta, vars['gold-soft']) >= 4.5,
              'measured ' + ratio(beta, vars['gold-soft']).toFixed(2) + ':1');

// Bar lines are non-text marks on the paper surface: 3:1.
const avline = (html.match(/\.avline\{[^}]*border-left:[^;]*var\(--([\w-]+)\)/)||[])[1];
const angline = (html.match(/\.angline\{[^}]*border-left:[^;]*var\(--([\w-]+)\)/)||[])[1];
chk('avartana bar colour resolves to a token', !!avline && !!vars[avline], String(avline));
if (avline && vars[avline]) chk('avartana bar on paper meets 3:1 (non-text)',
    ratio(vars[avline], vars['paper']) >= 3.0,
    'measured ' + ratio(vars[avline], vars['paper']).toFixed(2) + ':1');
chk('anga bar colour resolves to a token', !!angline && !!vars[angline], String(angline));
if (angline && vars[angline]) chk('anga bar on paper meets 3:1 (non-text)',
    ratio(vars[angline], vars['paper']) >= 3.0,
    'measured ' + ratio(vars[angline], vars['paper']).toFixed(2) + ':1');

// The low-confidence svara must stay legible on paper, not merely visible.
const low = (html.match(/\.sv\.low\{color:\s*var\(--([\w-]+)\)/)||[])[1];
chk('low-confidence svara colour resolves to a token', !!low && !!vars[low], String(low));
if (low && vars[low]) chk('low-confidence svara on paper meets 4.5:1',
    ratio(vars[low], vars['paper']) >= 4.5,
    'measured ' + ratio(vars[low], vars['paper']).toFixed(2) + ':1');

// Regression guard, rewritten for the light palette: the page background must
// never be used as a text colour. (Under the old dark scheme the offending
// token was --ink; here --ink is the text and --bg is the page.)
chk('no rule paints text in the page background colour',
    !/color:\s*var\(--bg\)/.test(html));

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
