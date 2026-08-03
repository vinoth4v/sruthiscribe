// Dataset adapters: turn a downloaded corpus into a flat list of records the
// harness can score, regardless of which corpus it came from.
//
// A record is the minimum the evaluation needs and no more:
//   { id, dataset, audioPath, isolatedVocal, tonicHz, ragam, talam,
//     pitch(), sections(), phrases() }
// The annotation readers are lazy because a Saraga pitch file is a few hundred
// thousand lines and most runs only touch a 60-second excerpt of it.
//
// Sanidha's layout is discovered rather than hard-coded. The published file
// tree shows one song folder per concert, but the exact nesting is only visible
// once the data is in hand (it lives behind the GT VPN), so the scanner anchors
// on the files it can name with certainty -- vocal_pitch.txt and tonic.txt --
// and walks outward from those.

const fs = require('fs');
const path = require('path');

// ---------- shared readers ----------

// Both corpora store contours as "<seconds><sep><hz>" per line, tab-separated
// in Saraga and whitespace-separated in Sanidha. 0 Hz means unvoiced.
function readContour(file) {
  const text = fs.readFileSync(file, 'utf8');
  const t = [], hz = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.trim().split(/[\t, ]+/);
    if (parts.length < 2) continue;
    const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
    if (!isFinite(a) || !isFinite(b)) continue;
    t.push(a); hz.push(b > 0 ? b : 0);
  }
  return { t: Float64Array.from(t), hz: Float64Array.from(hz) };
}

function readTonic(file) {
  const v = parseFloat(String(fs.readFileSync(file, 'utf8')).trim().split(/\s+/)[0]);
  return isFinite(v) && v > 0 ? v : null;
}

// "start<tab>end<tab>label" (Saraga) or "start end label" (Sanidha).
function readSections(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = line.trim().split(/\t|\s{2,}/);
    const start = parseFloat(p[0]), end = parseFloat(p[1]);
    if (!isFinite(start)) continue;
    out.push({ start: start, end: isFinite(end) ? end : null, label: (p[2] || p[1] || '').trim() });
  }
  return out;
}

function walk(dir, onFile, depth) {
  if (depth === 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, onFile, depth == null ? null : depth - 1);
    else onFile(full, e.name);
  }
}

// ---------- Saraga (public: Zenodo 4301737) ----------
// <root>/saraga1.5_carnatic/<album>/<piece>/<Piece>.<ext>
// Every annotation shares the piece's basename, so the .json is the anchor.
function scanSaraga(root) {
  const records = [];
  walk(root, function (full, name) {
    if (!name.endsWith('.json')) return;
    const dir = path.dirname(full);
    const base = name.slice(0, -5);
    const at = (suffix) => {
      const p = path.join(dir, base + suffix);
      return fs.existsSync(p) ? p : null;
    };

    let meta;
    try { meta = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { return; }
    if (!meta || (!meta.raaga && !meta.title)) return;   // not a track metadata file

    const vocal = at('.multitrack-vocal.mp3');
    const mix = at('.mp3.mp3') || at('.mp3');
    const audioPath = vocal || mix;
    const ctonic = at('.ctonic.txt');
    // Prefer the vocal-only contour: it is the reference for the signal we
    // actually feed the engine when an isolated vocal track exists.
    const pitchPath = (vocal && at('.pitch-vocal.txt')) || at('.pitch.txt') || at('.pitch-vocal.txt');
    if (!audioPath || !ctonic || !pitchPath) return;

    const sectionsPath = at('.sections-manual-p.txt') || at('.sections-manual.txt');
    const phrasesPath = at('.mphrases-manual.txt');
    const first = (v) => Array.isArray(v) && v.length ? (v[0].name || v[0].common_name || null) : null;

    records.push({
      id: 'saraga/' + base,
      dataset: 'saraga',
      title: meta.title || base,
      audioPath: audioPath,
      isolatedVocal: !!vocal,
      tonicHz: readTonic(ctonic),
      ragam: first(meta.raaga),
      talam: first(meta.taala),
      form: first(meta.form),
      pitch: () => readContour(pitchPath),
      sections: () => (sectionsPath ? readSections(sectionsPath) : []),
      // Solfège phrase transcriptions -- the only note-level ground truth in
      // either corpus, and the closest thing to what the page outputs.
      phrases: () => (phrasesPath ? readSections(phrasesPath) : [])
    });
  }, 8);
  return records;
}

// ---------- Sanidha (GT VPN: ccml.gtcmt.gatech.edu/data/Sanidha) ----------
// Concert0x/0x-songs/<song>/{Audio-Multitracks-Clean/vocals.wav, info.json,
// sections.txt, vocal_pitch.txt} with tonic.txt at the concert root.
function scanSanidha(root) {
  const records = [];
  const pitchFiles = [];
  walk(root, function (full, name) {
    if (name === 'vocal_pitch.txt') pitchFiles.push(full);
  }, 10);

  for (const pitchPath of pitchFiles) {
    const dir = path.dirname(pitchPath);

    // Clean multitracks are the bleed-free ones -- the point of the corpus.
    let audioPath = null;
    for (const sub of ['Audio-Multitracks-Clean', 'Audio-Multitracks-Processed', '.']) {
      const p = path.join(dir, sub, 'vocals.wav');
      if (fs.existsSync(p)) { audioPath = p; break; }
    }
    if (!audioPath) continue;

    // tonic.txt sits at the concert root, some levels above the song folder.
    let tonicHz = null;
    for (let d = dir, i = 0; i < 5; i++, d = path.dirname(d)) {
      const p = path.join(d, 'tonic.txt');
      if (fs.existsSync(p)) { tonicHz = readTonic(p); break; }
    }

    // An excerpt fetched by byte range starts at t=0 in its own file but part
    // way into the recording the annotations describe. The sidecar carries that
    // offset; without applying it every contour comparison would be silently
    // shifted by minutes.
    let audioOffsetSec = 0;
    const sidecar = audioPath.replace(/\.wav$/i, '.excerpt.json');
    if (fs.existsSync(sidecar)) {
      try { audioOffsetSec = JSON.parse(fs.readFileSync(sidecar, 'utf8')).start || 0; }
      catch (e) {}
    }

    let meta = {};
    const infoPath = path.join(dir, 'info.json');
    if (fs.existsSync(infoPath)) {
      try { meta = JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch (e) {}
    }
    const pick = (...keys) => {
      for (const k of keys) {
        const v = meta[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (Array.isArray(v) && v.length) return v[0].name || v[0];
      }
      return null;
    };
    const sectionsPath = path.join(dir, 'sections.txt');

    records.push({
      id: 'sanidha/' + path.relative(root, dir).split(path.sep).join('/'),
      dataset: 'sanidha',
      title: pick('composition', 'title', 'name') || path.basename(dir),
      audioPath: audioPath,
      audioOffsetSec: audioOffsetSec,
      isolatedVocal: true,
      tonicHz: tonicHz,
      ragam: pick('ragam', 'raaga', 'raga'),
      talam: pick('talam', 'taala', 'tala'),
      form: pick('form', 'type'),
      pitch: () => readContour(pitchPath),
      sections: () => (fs.existsSync(sectionsPath) ? readSections(sectionsPath) : []),
      phrases: () => []
    });
  }
  return records;
}

// ---------- entry point ----------
function scan(root) {
  if (!fs.existsSync(root)) throw new Error('dataset directory not found: ' + root);
  const found = scanSaraga(root).concat(scanSanidha(root));
  found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return found;
}

// Resolve a dataset ragam name against the engine's own ragam table, so the
// decoder can be run under the correct grammar instead of a guess.
function findRagam(engine, name, metrics) {
  const rank = metrics.ragamRank(engine.RAGAMS, name);
  return rank >= 0 ? engine.RAGAMS[rank] : null;
}

module.exports = { scan, scanSaraga, scanSanidha, readContour, readTonic, readSections, findRagam };
