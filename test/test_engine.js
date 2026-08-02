const E = require('../engine.js');

const SR = 16000;

// --- synthesise a voice-like tone following a cents contour ---
function synth(events, tonic, opts) {
  opts = opts || {};
  const total = events.reduce((a, e) => a + e.dur, 0);
  const n = Math.round(total * SR);
  const x = new Float32Array(n);
  let phase = 0, idx = 0;
  const harm = [1, 0.55, 0.32, 0.18, 0.10, 0.06];
  for (const ev of events) {
    const len = Math.round(ev.dur * SR);
    for (let i = 0; i < len && idx < n; i++, idx++) {
      const t = i / SR;
      let cents = ev.cents;
      if (ev.gamaka === 'kampita') cents += ev.depth * Math.sin(2 * Math.PI * ev.rate * t);
      if (ev.gamaka === 'slide') cents += ev.span * (t / ev.dur);
      const f = tonic * Math.pow(2, cents / 1200);
      phase += 2 * Math.PI * f / SR;
      let s = 0;
      for (let h = 0; h < harm.length; h++) s += harm[h] * Math.sin(phase * (h + 1));
      // simple attack/release so onsets are realistic
      const env = Math.min(1, i / (0.02 * SR)) * Math.min(1, (len - i) / (0.02 * SR));
      x[idx] = 0.25 * s * env + (opts.noise || 0) * (Math.random() - 0.5);
    }
  }
  return x;
}

function cfgFor(ragamName, tonicHz, over) {
  const ragam = E.RAGAMS.find(r => r.name === ragamName);
  return Object.assign({
    tonicHz, ragam, temperament: 'et',
    window: 800, hop: 256, fmin: 70, fmax: 900,
    minConf: 0.55, silenceRatio: 0.045,
    sigma: 55, switchPenalty: 5.0, silencePenalty: 6, minNoteDur: 0.06
  }, over || {});
}

function labelsOf(res) { return res.notes.map(n => E.renderSvara(n, false)).join(' '); }

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) { console.log('        got : ' + got); console.log('        want: ' + want); fail++; } else pass++;
}

// ---------------- Test 1: plain Mohanam arohana/avarohana ----------------
{
  const tonic = 146.83; // D3
  const seq = [0, 200, 400, 700, 900, 1200, 900, 700, 400, 200, 0];
  const ev = seq.map(c => ({ cents: c, dur: 0.45 }));
  const x = synth(ev, tonic, { noise: 0.004 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Mohanam', tonic));
  check('Mohanam plain scale', labelsOf(res),
    'S R2 G3 P D2 S\u0307 D2 P G3 R2 S');
  console.log('        mean |dev| =', res.quality.meanAbsDeviation.toFixed(1), 'cents');
}

// ---------------- Test 2: kampita gamaka must NOT split into extra notes ----------------
{
  const tonic = 196.00; // G3
  const ev = [
    { cents: 0,   dur: 0.5 },
    { cents: 200, dur: 0.7, gamaka: 'kampita', depth: 95, rate: 5.5 },   // heavy oscillation on R2
    { cents: 400, dur: 0.5 },
    { cents: 700, dur: 0.8, gamaka: 'kampita', depth: 70, rate: 6.0 },   // on P
    { cents: 0,   dur: 0.5 }
  ];
  const x = synth(ev, tonic, { noise: 0.004 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Shankarabharanam', tonic));
  check('Kampita not fragmented', labelsOf(res), 'S R2 G3 P S');
  const artic = res.notes.map(n => n.artic).join(',');
  console.log('        articulations:', artic);
  if (!/kampita/.test(artic)) { console.log('  FAIL  kampita not detected'); fail++; } else { console.log('  PASS  kampita detected'); pass++; }
}

// ---------------- Test 3: jaaru (slide) detection ----------------
{
  const tonic = 220.0;
  const ev = [
    { cents: 0, dur: 0.4 },
    { cents: 0, dur: 0.45, gamaka: 'slide', span: 500 },  // S -> M1 slide
    { cents: 500, dur: 0.5 }
  ];
  const x = synth(ev, tonic, { noise: 0.003 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Kharaharapriya', tonic));
  const hasSlide = res.notes.some(n => n.artic === 'slide-up');
  console.log((hasSlide ? '  PASS  ' : '  FAIL  ') + 'ascending jaaru detected');
  hasSlide ? pass++ : fail++;
  console.log('        notation:', labelsOf(res));
}

// ---------------- Test 4: ragam-aware naming (position 3 = G2 not R3) ----------------
{
  const tonic = 164.81;
  const ev = [0, 200, 300, 500, 700, 900, 1000, 1200].map(c => ({ cents: c, dur: 0.4 }));
  const x = synth(ev, tonic, { noise: 0.004 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Kharaharapriya', tonic));
  check('Kharaharapriya svara names', labelsOf(res), 'S R2 G2 M1 P D2 N2 S\u0307');
}

// ---------------- Test 5: wrong sruthi is detected and quantified ----------------
{
  const tonic = 146.83;
  const ev = [0, 200, 400, 700, 900, 1200].map(c => ({ cents: c, dur: 0.4 }));
  const x = synth(ev, tonic, { noise: 0.004 });
  // deliberately tell the engine the tonic is 30 cents sharp
  const wrong = tonic * Math.pow(2, 30 / 1200);
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Mohanam', wrong));
  const shift = res.tonicOffset.shift;
  const ok = Math.abs(shift + 30) <= 10;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'sruthi drift detected (reported ' + shift + ' cents, expected ~-30)');
  ok ? pass++ : fail++;
}

// ---------------- Test 6: ragam suggestion from the audio itself ----------------
{
  const tonic = 174.61;
  const ev = [0,300,500,800,1000,1200,1000,800,500,300,0].map(c => ({ cents: c, dur: 0.35 }));
  const x = synth(ev, tonic, { noise: 0.004 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Chromatic (all 12)', tonic));
  const top = res.ragamSuggestions.map(s => s.name);
  const ok = top.slice(0, 2).indexOf('Hindolam') >= 0;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'Hindolam in top-2 suggestions -> ' + top.slice(0, 3).join(', '));
  ok ? pass++ : fail++;
}

// ---------------- Test 7: notation text with duration extension ----------------
{
  const tonic = 146.83;
  const ev = [
    { cents: 0, dur: 0.25 }, { cents: 200, dur: 0.25 },
    { cents: 400, dur: 0.75 }, { cents: 700, dur: 0.25 }
  ];
  const x = synth(ev, tonic, { noise: 0.003 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Mohanam', tonic));
  const txt = E.notationText(res.notes, { marks: false, perLine: 8 });
  console.log('        notation grid: ' + JSON.stringify(txt));
  const ok = /G3\s+,\s+,/.test(txt);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'long note extended with commas');
  ok ? pass++ : fail++;
}

// ---------------- Test 8: timing / speed budget ----------------
{
  const tonic = 146.83;
  const ev = [];
  for (let i = 0; i < 120; i++) ev.push({ cents: [0,200,400,700,900][i % 5], dur: 0.5 }); // 60 s
  const x = synth(ev, tonic, { noise: 0.004 });
  const t0 = Date.now();
  E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Mohanam', tonic));
  const dt = Date.now() - t0;
  console.log('        60 s of audio analysed in ' + dt + ' ms (node, single thread)');
  const ok = dt < 20000;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'analysis within budget');
  ok ? pass++ : fail++;
}


// ---------------- Test 9: gentle vibrato must NOT be called kampita ----------------
{
  const tonic = 220.0;
  const ev = [
    { cents: 0,   dur: 0.6, gamaka: 'kampita', depth: 22, rate: 5.5 },
    { cents: 700, dur: 0.6, gamaka: 'kampita', depth: 20, rate: 6.0 }
  ];
  const x = synth(ev, tonic, { noise: 0.003 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Mohanam', tonic));
  const artic = res.notes.map(n => n.artic);
  const ok = artic.every(a => a !== 'kampita');
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'gentle vibrato not over-called as kampita -> ' + artic.join(','));
  ok ? pass++ : fail++;
}

// ---------------- Test 10: transit tones inside a glide are flagged ----------------
{
  const tonic = 220.0;
  const ev = [
    { cents: 0, dur: 0.5 },
    { cents: 0, dur: 0.30, gamaka: 'slide', span: 700 },
    { cents: 700, dur: 0.5 }
  ];
  const x = synth(ev, tonic, { noise: 0.003 });
  const res = E.finishAnalysis(E.yinTrack(x, SR, {}), cfgFor('Kharaharapriya', tonic));
  const held = res.notes.filter(n => !n.transit).map(n => E.renderSvara(n, false)).join(' ');
  const nTransit = res.notes.filter(n => n.transit).length;
  console.log('        all notes : ' + res.notes.map(n => E.renderSvara(n, false) + (n.transit ? '*' : '')).join(' '));
  const ok = nTransit >= 1 && /^S .*P$/.test(held);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'glide transit tones flagged (held: ' + held + ')');
  ok ? pass++ : fail++;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
