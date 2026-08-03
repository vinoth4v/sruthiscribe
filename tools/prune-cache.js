#!/usr/bin/env node
// Drop the disposable half of the cache.
//
//   node tools/prune-cache.js            # show what would go
//   node tools/prune-cache.js --yes      # delete it
//   node tools/prune-cache.js --yes --all
//
// The cache holds two very different things. Decoded WAVs exist only because
// afconvert cannot seek, and they are the bulk of it — hundreds of megabytes
// per hour of audio. Pitch tracks are ~100 kB per scored minute and are what
// every parameter sweep actually reads.
//
// So once a track is computed, its decoded audio is dead weight: deleting it
// costs one re-decode if you later change the excerpt window or the YIN
// settings, and costs nothing at all if you do not. On a machine short of
// space this is the difference between keeping a working corpus and not.
//
// --all additionally drops the pitch tracks, which means re-tracking every
// excerpt from source. Only worth it when reclaiming the last few megabytes.

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'data', 'cache');
const args = process.argv.slice(2);
const commit = args.includes('--yes');
const all = args.includes('--all');

if (!fs.existsSync(dir)) {
  console.log('nothing cached at ' + dir);
  process.exit(0);
}

const files = fs.readdirSync(dir);
const audio = files.filter((f) => f.startsWith('audio-'));
const tracks = files.filter((f) => f.startsWith('track-'));
const doomed = all ? audio.concat(tracks) : audio;

const size = (list) => list.reduce((n, f) => {
  try { return n + fs.statSync(path.join(dir, f)).size; } catch (e) { return n; }
}, 0);
const human = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB');

console.log(`cache: ${dir}`);
console.log(`  decoded audio  ${String(audio.length).padStart(4)} files  ${human(size(audio))}` +
  (all ? '' : '   <- reclaimable'));
console.log(`  pitch tracks   ${String(tracks.length).padStart(4)} files  ${human(size(tracks))}` +
  (all ? '   <- reclaimable' : '   (keep: this is what tuning reads)'));

if (!doomed.length) { console.log('\nnothing to reclaim'); process.exit(0); }

if (!commit) {
  console.log(`\nwould free ${human(size(doomed))}. Rerun with --yes to do it.`);
  process.exit(0);
}

let freed = 0;
for (const f of doomed) {
  const p = path.join(dir, f);
  try { freed += fs.statSync(p).size; fs.rmSync(p); } catch (e) {}
}
console.log(`\nfreed ${human(freed)}`);
