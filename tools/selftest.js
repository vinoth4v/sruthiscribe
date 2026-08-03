#!/usr/bin/env node
// End-to-end check of the harness with no dataset required.
//
//   node tools/selftest.js
//
// Synthesises a short Mohanam phrase whose F0 is known exactly, writes it out
// in the Sanidha directory layout, and runs the real scoring path over it. If
// this passes, the engine extraction, WAV reading, ground-truth alignment,
// metrics and dataset scanners are all wired up correctly -- so when the real
// numbers arrive, a bad score means a bad engine and not a broken harness.

const fs = require('fs');
const os = require('os');
const path = require('path');

const engineLoader = require('./lib/engine');
const datasets = require('./lib/datasets');
const run = require('./lib/run');

const SR = 44100;
const TONIC = 220;                       // A3
const GT_HOP = 128 / SR;                 // matches Saraga's contour resolution

// Mohanam: S R2 G3 P D2. Mixing steady notes, a kampita-style oscillation and
// a glide gives the decoder something with the shape of real singing rather
// than a scale exercise it would pass trivially.
const PHRASE = [
  { svara: 0,  dur: 0.6, style: 'plain' },
  { svara: 2,  dur: 0.5, style: 'kampita' },
  { svara: 4,  dur: 0.7, style: 'plain' },
  { rest: 0.3 },
  { svara: 7,  dur: 0.8, style: 'kampita' },
  { svara: 9,  dur: 0.5, style: 'plain' },
  { svara: 12, dur: 0.9, style: 'plain' },
  { rest: 0.25 },
  { svara: 9,  dur: 0.45, style: 'glide', to: 7 },
  { svara: 4,  dur: 0.6, style: 'plain' },
  { svara: 2,  dur: 0.5, style: 'kampita' },
  { svara: 0,  dur: 1.0, style: 'plain' }
];

function buildContour(repeats) {
  const t = [], hz = [];
  let now = 0;
  for (let r = 0; r < repeats; r++) {
    for (const step of PHRASE) {
      const dur = step.rest != null ? step.rest : step.dur;
      const n = Math.round(dur / GT_HOP);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        let f = 0;
        if (step.rest == null) {
          let cents = step.svara * 100;
          if (step.style === 'kampita') cents += 45 * Math.sin(2 * Math.PI * 5.5 * i * GT_HOP);
          else if (step.style === 'glide') cents += (step.to * 100 - step.svara * 100) * u;
          else cents += 6 * Math.sin(2 * Math.PI * 4.5 * i * GT_HOP); // a little natural drift
          f = TONIC * Math.pow(2, cents / 1200);
        }
        t.push(now + i * GT_HOP);
        hz.push(f);
      }
      now += n * GT_HOP;
    }
  }
  return { t: t, hz: hz, duration: now };
}

// Harmonic-rich source with a soft attack/release per note, so the voicing
// detector has real onsets to find rather than instant square edges.
function synthesise(contour) {
  const n = Math.ceil(contour.duration * SR);
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const gi = Math.min(contour.hz.length - 1, Math.floor(i / SR / GT_HOP));
    const f = contour.hz[gi];
    if (f <= 0) { phase = 0; continue; }
    phase += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(h * phase) / h;
    // fade across the two GT frames either side of a voiced/unvoiced boundary
    const prev = contour.hz[Math.max(0, gi - 2)], next = contour.hz[Math.min(contour.hz.length - 1, gi + 2)];
    const edge = (prev <= 0 || next <= 0) ? 0.35 : 1;
    x[i] = 0.28 * v * edge;
  }
  // a touch of noise: a perfectly clean signal is not a fair test of voicing
  for (let i = 0; i < n; i++) x[i] += (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.004;
  return x;
}

function writeWav(file, samples) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b);
}

function buildFixture(root) {
  const contour = buildContour(6);              // ~42 s
  const song = path.join(root, 'Concert01', '01-songs', 'Selftest');
  writeWav(path.join(song, 'Audio-Multitracks-Clean', 'vocals.wav'), synthesise(contour));
  fs.writeFileSync(path.join(song, 'vocal_pitch.txt'),
    contour.t.map((t, i) => t.toFixed(6) + '\t' + contour.hz[i].toFixed(4)).join('\n'));
  fs.writeFileSync(path.join(song, 'info.json'),
    JSON.stringify({ composition: 'Selftest phrase', ragam: 'Mohanam', talam: 'Adi' }, null, 2));
  fs.writeFileSync(path.join(song, 'sections.txt'), '0\t' + contour.duration.toFixed(2) + '\talapana\n');
  fs.writeFileSync(path.join(root, 'Concert01', 'tonic.txt'), TONIC.toFixed(4) + '\n');
  return contour;
}

// ---------- checks ----------
const checks = [];
function check(name, ok, detail) {
  checks.push({ name: name, ok: ok, detail: detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

// `--fixture DIR` writes the synthetic corpus and stops, so eval.js and tune.js
// can be exercised end to end before any real data has finished downloading.
function fixtureOnly(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const contour = buildFixture(dir);
  console.log(`wrote a ${contour.duration.toFixed(1)}s Mohanam fixture to ${dir}`);
  console.log(`try:  node tools/eval.js --data ${dir} --start 0 --len 40`);
}

function main() {
  const fi = process.argv.indexOf('--fixture');
  if (fi !== -1) return fixtureOnly(path.resolve(process.argv[fi + 1] || 'fixture'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sscribe-selftest-'));
  const cache = path.join(root, 'cache');
  try {
    console.log('fixture: ' + root);
    buildFixture(root);

    const engine = engineLoader.load();
    check('engine loads from index.html', !!engine.yinTrack && engine.RAGAMS.length > 60,
      engine.RAGAMS.length + ' ragams');

    const records = datasets.scan(root);
    check('Sanidha scanner finds the record', records.length === 1, records.length + ' found');
    if (!records.length) return report();

    const rec = records[0];
    check('tonic parsed', Math.abs(rec.tonicHz - TONIC) < 0.01, rec.tonicHz + ' Hz');
    check('ragam parsed', rec.ragam === 'Mohanam', String(rec.ragam));
    check('ragam resolves to the engine table',
      !!datasets.findRagam(engine, rec.ragam, require('./lib/metrics')), '');

    console.log('\n-- tonic set correctly --');
    const clean = run.scoreRecord(engine, rec, {
      segment: { start: 0, len: 40 }, cacheDir: cache
    });
    if (clean.skipped) { check('scoring runs', false, clean.skipped); return report(); }

    const p = (x) => (100 * x).toFixed(1) + '%';
    console.log(`     raw pitch ${p(clean.raw.rawPitchAccuracy)}  processed ${p(clean.processed.rawPitchAccuracy)}` +
      `  lag ${clean.processed.lagFrames} frames`);
    console.log(`     svara ${p(clean.svara.svaraAccuracy)}  coverage ${p(clean.svara.noteCoverage)}` +
      `  notes ${clean.noteCount}  ragam rank ${clean.ragamRank}`);

    check('raw pitch accuracy is high on synthetic audio',
      clean.raw.rawPitchAccuracy > 0.85, p(clean.raw.rawPitchAccuracy));
    check('processed contour does not collapse',
      clean.processed.rawPitchAccuracy > 0.80, p(clean.processed.rawPitchAccuracy));
    check('voicing recall is high', clean.processed.voicingRecall > 0.80,
      p(clean.processed.voicingRecall));
    check('notes cover most voiced frames', clean.svara.noteCoverage > 0.60,
      p(clean.svara.noteCoverage));
    check('svara agreement is high', clean.svara.svaraAccuracy > 0.75,
      p(clean.svara.svaraAccuracy));
    check('true ragam is in the top 5', clean.ragamRank >= 0 && clean.ragamRank < 5,
      'rank ' + clean.ragamRank);

    console.log('\n-- tonic mis-set by 40 cents --');
    const jittered = run.scoreRecord(engine, rec, {
      segment: { start: 0, len: 40 }, tonicJitterCents: 40, cacheDir: cache
    });
    console.log(`     true offset ${jittered.tonic.trueOffsetCents.toFixed(1)}c` +
      `  applied ${jittered.tonic.appliedShiftCents.toFixed(1)}c` +
      `  residual ${jittered.tonic.residualCents.toFixed(1)}c`);
    check('auto-sruthi recovers most of a 40-cent error',
      jittered.tonic.residualCents < jittered.tonic.uncorrectedCents,
      `${jittered.tonic.residualCents.toFixed(1)}c left of ${jittered.tonic.uncorrectedCents.toFixed(1)}c`);

    console.log('\n-- track cache --');
    const t0 = Date.now();
    run.scoreRecord(engine, rec, { segment: { start: 0, len: 40 }, cacheDir: cache });
    const warm = Date.now() - t0;
    check('cached re-run is fast', warm < 4000, warm + ' ms');

    report();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function report() {
  const bad = checks.filter((c) => !c.ok);
  console.log('\n' + (bad.length ? `${bad.length} of ${checks.length} checks FAILED`
    : `all ${checks.length} checks passed`));
  process.exit(bad.length ? 1 : 0);
}

main();
