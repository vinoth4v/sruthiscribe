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
const pairs = [
  ['body text on page',            'text',       'ink',        4.5],
  ['body text on card',            'text',       'slab2',      4.5],
  ['body text on raised surface',  'text',       'raise',      4.5],
  ['muted text on page',           'muted',      'ink',        4.5],
  ['muted text on card',           'muted',      'slab2',      4.5],
  ['dim label text on card',       'muted-2',    'slab2',      3.0],
  ['saffron accent on page',       'brass',      'ink',        4.5],
  ['saffron accent on card',       'brass',      'slab2',      4.5],
  ['peacock accent on page',       'trace',      'ink',        4.5],
  ['peacock accent on card',       'trace',      'slab2',      4.5],
  ['error text on page',           'kumkum',     'ink',        4.5],
  ['error text on card',           'kumkum',     'slab2',      4.5],
  ['NOTATION: svara on paper',     'paper-ink',  'paper',      4.5],
  ['NOTATION: syllable on paper',  'paper-dim',  'paper',      4.5],
];
pairs.forEach(([label, fgKey, bgKey, min])=>{
  const fg = vars[fgKey], bg = vars[bgKey];
  const r = ratio(fg, bg);
  chk(label + ' (' + fg + ' on ' + bg + ') meets ' + min + ':1',
      r >= min, 'measured ' + r.toFixed(2) + ':1');
});

// Primary button: dark ink on saffron fill -- checked against the literal value
// used in the .btn.primary rule rather than a token.
const primaryText = (html.match(/\.btn\.primary\{[^}]*color:(#[0-9A-Fa-f]{6})/)||[])[1];
chk('primary button text colour found in CSS', !!primaryText, primaryText);
if (primaryText){
  const r = ratio(primaryText, vars['brass']);
  chk('primary button label on saffron fill meets 4.5:1', r >= 4.5, 'measured '+r.toFixed(2)+':1');
}

// Bar lines drawn on the paper surface must be visible as non-text elements.
const avlineColor = (html.match(/\.avline\{[^}]*border-left:2px solid (#[0-9A-Fa-f]{6})/)||[])[1];
chk('avartana bar colour found in CSS', !!avlineColor, avlineColor);
if (avlineColor){
  const r = ratio(avlineColor, vars['paper']);
  chk('avartana bar on paper meets 3:1 (non-text)', r >= 3.0, 'measured '+r.toFixed(2)+':1');
}

// The 'low confidence' svara red must stay legible ON PAPER, not just on dark.
const lowColor = (html.match(/\.sv\.low\{color:(#[0-9A-Fa-f]{6})\}/)||[])[1];
chk('low-confidence svara colour found in CSS', !!lowColor, lowColor);
if (lowColor){
  const r = ratio(lowColor, vars['paper']);
  chk('low-confidence svara on paper meets 4.5:1', r >= 4.5, 'measured '+r.toFixed(2)+':1');
}

// Regression guard: no rule may set text colour to the page background token,
// which is what produced two invisible-text bugs during this redesign.
const inkAsColor = /color:\s*var\(--ink\)/.test(html);
chk('no rule uses the page background token as a text colour', !inkAsColor);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
