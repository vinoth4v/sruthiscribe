// Accuracy-improvement tests with measured before/after comparisons.
// 1. Two-pass sruthi correction: singer 30c off from configured tonic.
// 2. Directional raga grammar: Bilahari ascent must not use avaroha-only svaras.
const E = require('../engine.js');

const SR = E.DEFAULTS.sr;
function synth(centsSeq, tonicHz, noteDur){
  noteDur = noteDur || 0.45;
  const n = Math.round(SR * noteDur * centsSeq.length);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++){
    const seg = Math.min(centsSeq.length-1, Math.floor(i / (SR*noteDur)));
    const f = tonicHz * Math.pow(2, centsSeq[seg]/1200);
    ph += 2*Math.PI*f/SR;
    const local = (i % Math.round(SR*noteDur)) / (SR*noteDur);
    const env = Math.min(1, local*30) * Math.min(1, (1-local)*30);
    x[i] = 0.3*Math.max(0.15,env)*(Math.sin(ph)+0.35*Math.sin(2*ph)+0.15*Math.sin(3*ph));
  }
  return x;
}
function cfgFor(name, over){
  return Object.assign({
    tonicHz: 146.83, ragam: E.RAGAMS.find(r=>r.name===name),
    temperament: 'et', minConf: 0.5, silenceRatio: 0.045,
    sigma: 55, switchPenalty: 5, silencePenalty: 6,
    minNoteDur: 0.06, transientMax: 0.12
  }, over||{});
}
function labelsOf(res){ return res.notes.filter(n=>!n.transit).map(n=>n.label); }

let pass=0, fail=0;
const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

// ============ 1. Two-pass sruthi correction ============
// Mohanam arohana sung with the singer's Sa 30 cents SHARP of the configured tonic.
const DRIFT = 30;
const mohanam = [0,200,400,700,900,1200].map(c=>c+DRIFT);
const xDrift = synth(mohanam, 146.83);

const resOld = E.analyzeSamples(xDrift, SR, cfgFor('Mohanam', { autoTonic:false }));
const resNew = E.analyzeSamples(xDrift, SR, cfgFor('Mohanam'));

const devOld = resOld.quality.meanAbsDeviation;
const devNew = resNew.quality.meanAbsDeviation;
console.log('    [measured] mean |deviation| without correction: ' + devOld.toFixed(1) + 'c, with: ' + devNew.toFixed(1) + 'c');
chk('drift measured correctly (~+30c)', Math.abs(resNew.tonicOffset.shift - DRIFT) <= 10, resNew.tonicOffset.shift);
chk('auto-shift was applied', Math.abs(resNew.appliedShift - DRIFT) <= 10, resNew.appliedShift);
chk('old pipeline shows large systematic deviation', devOld > 20, devOld.toFixed(1));
chk('two-pass cuts deviation by >60%', devNew < devOld*0.4, devNew.toFixed(1)+' vs '+devOld.toFixed(1));
chk('correct arohana labels with drifted voice',
    JSON.stringify(labelsOf(resNew)) === JSON.stringify(['S','R2','G3','P','D2','S']),
    labelsOf(resNew).join(' '));
chk('no shift applied when voice is in tune',
    E.analyzeSamples(synth([0,200,400,700,900,1200],146.83), SR, cfgFor('Mohanam')).appliedShift === 0);

// ============ 2. Directional raga grammar (Bilahari) ============
// Bilahari: aroha S R2 G3 P D2 S (no M1, no N3); avaroha has all seven.
// A slow ascending chromatic-ish glide passes THROUGH the M1 and N3 positions.
// Without grammar, dwell near those cents can be labeled M1/N3 on the way UP,
// which no Bilahari singer would accept; with grammar those labels are suppressed
// while still allowed on the way DOWN.
// TRUE continuous glides (real jaaru shape), 3s per octave sweep:
function synthGlide(c0, c1, tonicHz, dur){
  const n = Math.round(SR*dur), x = new Float32Array(n); let ph=0;
  for (let i=0;i<n;i++){
    const c = c0 + (c1-c0)*(i/n);
    const f = tonicHz*Math.pow(2,c/1200);
    ph += 2*Math.PI*f/SR;
    const env = Math.min(1,i/(0.02*SR))*Math.min(1,(n-i)/(0.02*SR));
    x[i] = 0.3*env*(Math.sin(ph)+0.35*Math.sin(2*ph)+0.15*Math.sin(3*ph));
  }
  return x;
}
const xUp = synthGlide(0, 1200, 146.83, 3.0);
const xDown = synthGlide(1200, 0, 146.83, 3.0);

const upNoGram = E.analyzeSamples(xUp, SR, cfgFor('Bilahari', { grammar:false, autoTonic:false }));
const upGram   = E.analyzeSamples(xUp, SR, cfgFor('Bilahari', { autoTonic:false }));
const downGram = E.analyzeSamples(xDown, SR, cfgFor('Bilahari', { autoTonic:false }));

const illegalUp = (res)=> labelsOf(res).filter(l=>l==='M1'||l==='N3').length;
console.log('    [measured] avaroha-only labels on ascent — without grammar: ' + illegalUp(upNoGram) + ', with: ' + illegalUp(upGram));
chk('grammar-off ascent DOES mislabel with avaroha-only svaras (proves the problem exists)', illegalUp(upNoGram) > 0, illegalUp(upNoGram));
chk('grammar-aware ascent suppresses them', illegalUp(upGram) < illegalUp(upNoGram), illegalUp(upGram));
chk('descent still free to use N3/M1 (not over-constrained)',
    labelsOf(downGram).some(l=>l==='N3'||l==='M1'), labelsOf(downGram).join(' '));

// dirSets parsing sanity
const bila = E.dirSets(E.RAGAMS.find(r=>r.name==='Bilahari'));
chk('dirSets: Bilahari aroha lacks M1/N3', !bila.up.M1 && !bila.up.N3);
chk('dirSets: Bilahari avaroha has M1/N3', bila.down.M1 && bila.down.N3);
const moh = E.dirSets(E.RAGAMS.find(r=>r.name==='Mohanam'));
chk('dirSets: symmetric raga unaffected', moh.up.G3 && moh.down.G3 && !moh.up.M1 && !moh.down.M1);

// Symmetric-raga regression: grammar must not change a clean Shankarabharanam scale.
const sank = [0,200,400,500,700,900,1100,1200];
const rG = E.analyzeSamples(synth(sank,146.83), SR, cfgFor('Shankarabharanam', { autoTonic:false }));
const rN = E.analyzeSamples(synth(sank,146.83), SR, cfgFor('Shankarabharanam', { grammar:false, autoTonic:false }));
chk('grammar neutral on symmetric raga (same labels)',
    JSON.stringify(labelsOf(rG)) === JSON.stringify(labelsOf(rN)), labelsOf(rG).join(' '));

// Performance guard: O(K^2) transition loop must stay fast for a 60s clip.
const long = synth(Array.from({length:120},(_,i)=>[0,200,400,700,900][i%5]), 146.83, 0.5);
const t0 = Date.now();
E.analyzeSamples(long, SR, cfgFor('Mohanam'));
const ms = Date.now()-t0;
console.log('    [measured] 60s clip full analysis: ' + ms + ' ms');
chk('60s clip analyzes in under 8s', ms < 8000, ms+'ms');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
