#!/usr/bin/env node
// Score the shipped engine against annotated ground truth.
//
//   node tools/eval.js --data ~/datasets/saraga --limit 20
//   node tools/eval.js --data ~/datasets/sanidha --isolated --jitter 35 --json before.json
//
// Everything is measured on the engine extracted live from index.html, so a
// number produced here is a number the page produces.

const fs = require('fs');
const path = require('path');

const engineLoader = require('./lib/engine');
const datasets = require('./lib/datasets');
const run = require('./lib/run');

function parseArgs(argv) {
  const a = {
    data: null, limit: 0, start: 60, len: 60, jitter: 0, json: null,
    isolated: false, cfg: null, cache: path.join(__dirname, 'data', 'cache'),
    tolerance: 50, quiet: false
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--data') a.data = next();
    else if (k === '--limit') a.limit = +next();
    else if (k === '--start') a.start = +next();
    else if (k === '--len') a.len = +next();
    else if (k === '--jitter') a.jitter = +next();
    else if (k === '--json') a.json = next();
    else if (k === '--cache') a.cache = next();
    else if (k === '--tolerance') a.tolerance = +next();
    else if (k === '--cfg') a.cfg = JSON.parse(fs.readFileSync(next(), 'utf8'));
    else if (k === '--isolated') a.isolated = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error('unknown flag ' + k);
  }
  return a;
}

const USAGE = `
Usage: node tools/eval.js --data <dataset-dir> [options]

  --data DIR       root of a downloaded Saraga and/or Sanidha tree (required)
  --limit N        score only the first N records
  --start SEC      excerpt start within each recording      (default 60)
  --len SEC        excerpt length                           (default 60)
  --jitter CENTS   mis-set the tonic by this much, to test auto-sruthi
  --isolated       only records that have a bleed-free vocal track
  --cfg FILE       JSON of engine overrides (sigma, switchPenalty, ...)
  --tolerance C    pitch-accuracy tolerance in cents        (default 50)
  --json FILE      write full per-record results
  --cache DIR      audio/track cache                        (default tools/data/cache)
`;

function pct(x) { return (100 * x).toFixed(1).padStart(5) + '%'; }

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.data) { console.error(USAGE); process.exit(1); }

  const engine = engineLoader.load();
  let records = datasets.scan(path.resolve(args.data.replace(/^~/, process.env.HOME)));
  if (args.isolated) records = records.filter((r) => r.isolatedVocal);
  if (!records.length) {
    console.error('No scorable records found under ' + args.data +
      '\n(need audio + a tonic annotation + a pitch annotation alongside each other)');
    process.exit(1);
  }
  if (args.limit > 0) records = records.slice(0, args.limit);

  console.log(`Scoring ${records.length} record(s) — ${args.len}s from ${args.start}s` +
    (args.jitter ? `, tonic mis-set by ${args.jitter} cents` : '') + '\n');

  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    let row;
    try {
      row = run.scoreRecord(engine, r, {
        segment: { start: args.start, len: args.len },
        cfg: args.cfg || {}, tonicJitterCents: args.jitter,
        cacheDir: args.cache, toleranceCents: args.tolerance
      });
    } catch (e) {
      row = { id: r.id, skipped: e.message };
    }
    rows.push(row);
    if (args.quiet) continue;
    const tag = `[${String(i + 1).padStart(3)}/${records.length}]`;
    if (row.skipped) console.log(`${tag} ${r.id} — skipped: ${row.skipped}`);
    else if (!row.alignment.ok) console.log(`${tag} ${row.id}\n` +
      `        EXCLUDED — the annotation does not describe this audio ` +
      `(chroma agreement ${pct(row.alignment.chroma)}, chance is ${pct(row.alignment.chanceLevel)})`);
    else console.log(`${tag} ${row.id}\n` +
      `        pitch raw ${pct(row.raw.rawPitchAccuracy)}  ->  processed ${pct(row.processed.rawPitchAccuracy)}` +
      `   octave-err ${pct(row.processed.octaveErrorRate)}\n` +
      `        svara ${pct(row.svara.svaraAccuracy)} (coverage ${pct(row.svara.noteCoverage)})` +
      `   ragam ${row.ragamTrue || '?'} rank ${row.ragamRank}` +
      `   tonic residual ${row.tonic.residualCents.toFixed(1)}c`);
  }

  const s = run.summarize(rows);
  console.log('\n' + '='.repeat(62));
  console.log(`records scored           ${s.records}   (skipped ${s.skipped}, misaligned ${s.misaligned})`);
  if (s.misaligned) {
    console.log(`  excluded as misaligned: ${s.misalignedIds.join(', ')}`);
    console.log('  (their audio and pitch annotation describe different content —');
    console.log('   a corpus problem, not an engine one; averaging them in would hide both)');
  }
  console.log(`raw pitch accuracy       ${pct(s.rawPitchAccuracy)}   YIN alone`);
  console.log(`processed pitch accuracy ${pct(s.processedPitchAccuracy)}   what the decoder sees`);
  console.log(`  chroma accuracy        ${pct(s.processedChromaAccuracy)}`);
  console.log(`  octave error rate      ${pct(s.octaveErrorRate)}`);
  console.log(`voicing recall           ${pct(s.voicingRecall)}`);
  console.log(`voicing false alarm      ${pct(s.voicingFalseAlarm)}`);
  console.log(`svara accuracy           ${pct(s.svaraAccuracy)}   label + octave`);
  console.log(`  ignoring octave        ${pct(s.svaraClassAccuracy)}`);
  console.log(`  note coverage          ${pct(s.noteCoverage)}`);
  console.log(`tonic residual           ${s.tonicResidualCents.toFixed(1)} cents`);
  console.log(`ragam top-1 / top-5      ${pct(s.ragamTop1)} / ${pct(s.ragamTop5)}   (n=${s.ragamScored})`);
  console.log('='.repeat(62));

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify({ args: args, summary: s, rows: rows }, null, 2));
    console.log('\nwrote ' + args.json);
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
