#!/usr/bin/env node
// Search the engine's tunable parameters against ground truth.
//
//   node tools/tune.js --data ~/datasets/saraga --limit 24 --holdout
//   node tools/tune.js --data ~/datasets/sanidha --objective pitch --yin
//
// The defaults in index.html were chosen by ear. This replaces that with
// measurement: coordinate descent over one parameter at a time, keeping a
// change only when it improves the score on the tuning split, then reporting
// the result on a held-out split that the search never saw. A gain that shows
// up on both is real; a gain that only shows up on the tuning half is the
// search fitting noise, and the printout makes that visible rather than
// letting it quietly ship.

const fs = require('fs');
const path = require('path');

const engineLoader = require('./lib/engine');
const datasets = require('./lib/datasets');
const run = require('./lib/run');

// Cheap parameters: these only touch finishAnalysis, so the cached pitch track
// is reused and a full sweep costs milliseconds per configuration.
const DECODE_GRID = {
  temperament: ['et', 'ji'],
  minConf: [0.45, 0.5, 0.55, 0.6, 0.62, 0.68, 0.75],
  silenceRatio: [0.02, 0.03, 0.045, 0.06, 0.09],
  // Voicing gate shape. Defaults below are the historical behaviour (no
  // hysteresis, no minimum run, floor off the single peak), so a search that
  // finds nothing leaves the engine exactly as it was.
  noiseMult: [0, 0.5, 1, 1.5, 2],
  enterMult: [1, 1.15, 1.3, 1.5, 1.8],
  keepConf: [1, 0.95, 0.9, 0.85, 0.75],
  minVoicedDur: [0, 0.03, 0.045, 0.06, 0.09],
  strongPct: [1.0, 0.98, 0.95],
  sigma: [35, 45, 55, 65, 80, 100],
  switchPenalty: [1.5, 2.2, 3.2, 4.5, 6, 8],
  silencePenalty: [3, 4.5, 6, 8],
  minNoteDur: [0.05, 0.06, 0.075, 0.09, 0.12],
  transientMax: [0.08, 0.12, 0.16, 0.2],
  grammar: [true, false],
  dirPenalty: [1, 2, 3.2, 5],
  occupancyPenalty: [0, 1, 2.2, 4],
  // Gate on the auto-sruthi correction. Worth sweeping with --jitter set,
  // since with a perfectly configured tonic there is nothing to correct and
  // any value that declines to shift will look equally good.
  autoTonicMinCents: [15, 25, 40, 60],
  autoTonicMargin: [0.03, 0.08, 0.15, 0.25]
};

// Expensive parameters: changing any of these invalidates the cached track, so
// every candidate re-runs YIN over every excerpt. Opt in with --yin.
const YIN_GRID = {
  window: [600, 800, 1024, 1400],
  hop: [192, 256, 320],
  fmin: [60, 70, 90],
  fmax: [700, 900, 1200],
  threshold: [0.1, 0.15, 0.2]
};

function parseArgs(argv) {
  const a = {
    data: null, limit: 24, start: 'auto', len: 60, jitter: 0, isolated: false,
    objective: 'svara', rounds: 2, yin: false, holdout: false,
    cache: path.join(__dirname, 'data', 'cache'), out: null
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], next = () => argv[++i];
    if (k === '--data') a.data = next();
    else if (k === '--start') { const v = next(); a.start = (v === 'auto' ? 'auto' : +v); }
    else if (k === '--limit') a.limit = +next();
    else if (k === '--len') a.len = +next();
    else if (k === '--jitter') a.jitter = +next();
    else if (k === '--objective') a.objective = next();
    else if (k === '--rounds') a.rounds = +next();
    else if (k === '--cache') a.cache = next();
    else if (k === '--out') a.out = next();
    else if (k === '--isolated') a.isolated = true;
    else if (k === '--yin') a.yin = true;
    else if (k === '--holdout') a.holdout = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error('unknown flag ' + k);
  }
  return a;
}

const USAGE = `
Usage: node tools/tune.js --data <dataset-dir> [options]

  --data DIR        root of a downloaded Saraga and/or Sanidha tree (required)
  --limit N         records to use                          (default 24)
  --start / --len   excerpt window in seconds               (default auto / 60,
                    matching eval.js so cached tracks are shared)
  --jitter CENTS    mis-set the tonic, to tune auto-sruthi too
  --isolated        only records with a bleed-free vocal track
  --objective X     svara | pitch | combined | voicing      (default svara)
  --rounds N        coordinate-descent passes               (default 2)
  --yin             also sweep the pitch-tracker settings (much slower)
  --holdout         tune on half the records, report on the other half
  --out FILE        write the winning config as JSON
`;

// What "better" means. svara is the metric closest to what a user reads off the
// page; pitch is the underlying contour; combined weights them together so a
// config cannot win by decoding confidently from a broken contour.
function objectiveValue(summary, kind) {
  if (kind === 'voicing') {
    // Half the score is the transcription, half is whether the engine agreed
    // about when anyone was singing. Balanced so that muting everything (no
    // false alarms, no recall) scores no better than crying wolf everywhere.
    const balanced = 0.5 * (summary.voicingRecall + (1 - summary.voicingFalseAlarm));
    return 0.5 * summary.svaraAccuracy * (0.5 + 0.5 * summary.noteCoverage)
         + 0.5 * balanced;
  }
  if (kind === 'pitch') return summary.processedPitchAccuracy;
  if (kind === 'combined')
    return 0.6 * summary.svaraAccuracy + 0.4 * summary.processedPitchAccuracy;
  // Coverage matters: a decoder that names nothing has a vacuously high
  // agreement over the few frames it does commit to.
  return summary.svaraAccuracy * (0.5 + 0.5 * summary.noteCoverage);
}

function evaluate(engine, records, cfg, yin, args) {
  const rows = records.map((r) => {
    try {
      return run.scoreRecord(engine, r, {
        segment: { start: (args.start === 'auto' ? (r.audioOffsetSec || 0) : args.start),
                   len: args.len },
        cfg: cfg, yin: yin, tonicJitterCents: args.jitter, cacheDir: args.cache
      });
    } catch (e) { return { id: r.id, skipped: e.message }; }
  });
  return run.summarize(rows);
}

function pct(x) { return (100 * x).toFixed(2) + '%'; }

function describe(s) {
  return `svara ${pct(s.svaraAccuracy)} (cov ${pct(s.noteCoverage)})  ` +
    `pitch ${pct(s.processedPitchAccuracy)}  oct-err ${pct(s.octaveErrorRate)}  ` +
    `tonic ${s.tonicResidualCents.toFixed(1)}c`;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.data) { console.error(USAGE); process.exit(1); }

  const engine = engineLoader.load();
  let records = datasets.scan(path.resolve(args.data.replace(/^~/, process.env.HOME)))
    .filter((r) => r.tonicHz);
  if (args.isolated) records = records.filter((r) => r.isolatedVocal);
  if (!records.length) { console.error('no scorable records under ' + args.data); process.exit(1); }
  if (args.limit > 0) records = records.slice(0, args.limit);

  // Deterministic split: alternate records so both halves span the same
  // artists and ragams rather than splitting by alphabetical accident.
  const tuneSet = args.holdout ? records.filter((_, i) => i % 2 === 0) : records;
  const testSet = args.holdout ? records.filter((_, i) => i % 2 === 1) : records;

  console.log(`tuning on ${tuneSet.length} record(s)` +
    (args.holdout ? `, holding out ${testSet.length}` : '') +
    `, objective=${args.objective}\n`);

  let cfg = Object.assign({}, run.BASE_CFG);
  let yin = {};

  const baselineTune = evaluate(engine, tuneSet, cfg, yin, args);
  console.log('baseline (shipped defaults)');
  console.log('  tune   ' + describe(baselineTune));
  const baselineTest = args.holdout ? evaluate(engine, testSet, cfg, yin, args) : null;
  if (baselineTest) console.log('  test   ' + describe(baselineTest));
  let best = objectiveValue(baselineTune, args.objective);
  console.log('');

  const grids = [['cfg', DECODE_GRID]];
  if (args.yin) grids.push(['yin', YIN_GRID]);

  for (let round = 1; round <= args.rounds; round++) {
    let improvedThisRound = false;
    console.log(`--- round ${round} ---`);
    for (const [which, grid] of grids) {
      for (const key of Object.keys(grid)) {
        const target = which === 'cfg' ? cfg : yin;
        const original = target[key];
        let bestVal = original, bestScore = best;
        for (const candidate of grid[key]) {
          if (candidate === original) continue;
          const trial = Object.assign({}, target, { [key]: candidate });
          const s = evaluate(engine, tuneSet,
            which === 'cfg' ? trial : cfg, which === 'yin' ? trial : yin, args);
          const v = objectiveValue(s, args.objective);
          if (v > bestScore + 1e-6) { bestScore = v; bestVal = candidate; }
        }
        if (bestVal !== original) {
          target[key] = bestVal;
          console.log(`  ${key}: ${JSON.stringify(original)} -> ${JSON.stringify(bestVal)}` +
            `   ${pct(best)} -> ${pct(bestScore)}`);
          best = bestScore;
          improvedThisRound = true;
        }
      }
    }
    if (!improvedThisRound) { console.log('  (no further improvement)'); break; }
  }

  const finalTune = evaluate(engine, tuneSet, cfg, yin, args);
  console.log('\ntuned');
  console.log('  tune   ' + describe(finalTune));
  if (args.holdout) {
    const finalTest = evaluate(engine, testSet, cfg, yin, args);
    console.log('  test   ' + describe(finalTest));
    const gainTune = objectiveValue(finalTune, args.objective) - objectiveValue(baselineTune, args.objective);
    const gainTest = objectiveValue(finalTest, args.objective) - objectiveValue(baselineTest, args.objective);
    console.log(`\n  gain on tuning split ${(100 * gainTune).toFixed(2)} pts` +
      `, on held-out split ${(100 * gainTest).toFixed(2)} pts`);
    if (gainTest < gainTune / 2)
      console.log('  ! the held-out gain is much smaller — treat this as overfitting, not a win');
  }

  console.log('\nwinning config:');
  console.log(JSON.stringify({ cfg: cfg, yin: yin }, null, 2));
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(cfg, null, 2));
    console.log('\nwrote ' + args.out + '  (usable with: node tools/eval.js --cfg ' + args.out + ')');
  }
}

try {
  main();
} catch (e) {
  // A missing dataset directory or an unreadable annotation is a normal thing
  // to hit while setting this up; a stack trace helps nobody.
  console.error('\n' + e.message);
  process.exit(1);
}
