// Runs the shipped engine over one dataset record and scores it.
//
// Split into two stages on purpose, mirroring how the page itself works:
// yinTrack() is expensive and depends only on the YIN settings, while
// finishAnalysis() is cheap and depends on everything a user can actually
// change. Caching the track to disk means a parameter sweep over sigma,
// switchPenalty, minConf and friends re-runs only the cheap half -- thousands
// of configurations for the cost of tracking the audio once.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const wav = require('./wav');
const metrics = require('./metrics');
const datasets = require('./datasets');

// ---------- audio preparation ----------
// WAV sources (Sanidha) are used untouched: our reader handles them and the
// engine's own mixdownResample then does the downmix and the 44.1k -> 16k step,
// so the harness exercises the same (linear-interpolation) resampler the page
// uses rather than a nicer one.
//
// Compressed sources (Saraga's mp3) have to be decoded first, and afconvert
// cannot seek, so decoding a 20-minute track for a 60-second excerpt would be
// paid on every run. Those get a one-off cached WAV instead. The downmix there
// is a plain channel average -- identical to what mixdownResample would have
// computed -- so caching changes cost, not results.
function prepareAudio(record, cacheDir) {
  const src = record.audioPath;
  if (path.extname(src).toLowerCase() === '.wav') return src;

  const st = fs.statSync(src);
  const key = crypto.createHash('sha1')
    .update(src + ':' + st.size + ':' + st.mtimeMs).digest('hex').slice(0, 16);
  const out = path.join(cacheDir, 'audio-' + key + '.wav');
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(cacheDir, { recursive: true });

  const tmp = out + '.part';
  const convert = (args) => execFileSync('/usr/bin/afconvert', args.concat([src, tmp]),
    { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    // --mix -c 1 is rejected outright when the source is already mono.
    convert(['-f', 'WAVE', '-d', 'LEI16', '--mix', '-c', '1']);
  } catch (e) {
    convert(['-f', 'WAVE', '-d', 'LEI16']);
  }
  fs.renameSync(tmp, out);
  return out;
}

// ---------- pitch track, cached ----------
const TRACK_MAGIC = 'sscribe-track-1';

function writeTrack(file, track) {
  const header = JSON.stringify({
    magic: TRACK_MAGIC, nFrames: track.nFrames, hop: track.hop, sr: track.sr
  });
  const head = Buffer.from(header + '\n', 'utf8');
  const parts = [head];
  for (const k of ['f0', 'conf', 'rms']) parts.push(Buffer.from(track[k].buffer, track[k].byteOffset, track[k].length * 4));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', Buffer.concat(parts));
  fs.renameSync(file + '.part', file);
}

function readTrack(file) {
  const b = fs.readFileSync(file);
  const nl = b.indexOf(10);
  if (nl < 0) return null;
  let h;
  try { h = JSON.parse(b.toString('utf8', 0, nl)); } catch (e) { return null; }
  if (!h || h.magic !== TRACK_MAGIC) return null;
  const n = h.nFrames, need = nl + 1 + n * 12;
  if (b.length < need) return null;
  const get = (i) => {
    const off = nl + 1 + i * n * 4;
    const a = new Float32Array(n);
    for (let k = 0; k < n; k++) a[k] = b.readFloatLE(off + k * 4);
    return a;
  };
  return { f0: get(0), conf: get(1), rms: get(2), hop: h.hop, sr: h.sr, nFrames: n };
}

// segment = {start, len} in recording time; yin = {} or overrides of
// window/hop/fmin/fmax.
function getTrack(engine, record, segment, yin, cacheDir) {
  const wavPath = prepareAudio(record, cacheDir);
  // A byte-range excerpt holds only part of the recording, so a request in
  // recording time has to be rebased onto the file before reading.
  const fileStart = segment.start - (record.audioOffsetSec || 0);
  const sig = crypto.createHash('sha1')
    .update([wavPath, fileStart, segment.len, JSON.stringify(yin || {})].join('|'))
    .digest('hex').slice(0, 16);
  const cacheFile = path.join(cacheDir, 'track-' + sig + '.bin');

  if (fs.existsSync(cacheFile)) {
    const cached = readTrack(cacheFile);
    if (cached) return cached;
  }

  if (fileStart < -0.001) {
    throw new Error('excerpt starts at ' + (record.audioOffsetSec || 0).toFixed(0) +
      's; asked for ' + segment.start + 's — refetch with a wider --excerpt window');
  }
  const audio = wav.readWav(wavPath, fileStart, segment.len);
  const samples = wav.toMono(audio, engine);
  const opts = Object.assign({}, yin || {});
  const track = engine.yinTrack(samples, engine.DEFAULTS.sr, opts);
  const slim = {
    f0: track.f0, conf: track.conf, rms: track.rms,
    hop: track.hop, sr: track.sr, nFrames: track.nFrames
  };
  writeTrack(cacheFile, slim);
  return slim;
}

// ---------- ground truth aligned to our frames ----------
function alignGT(record, track, segment, windowLen) {
  const times = metrics.frameTimes(track.nFrames, track.hop, track.sr, windowLen);
  // Frame times are relative to the excerpt; the contour is absolute.
  for (let i = 0; i < times.length; i++) times[i] += segment.start;
  return metrics.sampleGT(record.pitch(), times);
}

// ---------- notes -> per-frame svara ----------
function notesToFrames(notes, nFrames, hop, sr) {
  const out = new Array(nFrames).fill(null);
  const frameDur = hop / sr;
  for (const n of notes) {
    if (n.transit) continue; // the page hides these; scoring them would be unfair
    const a = Math.max(0, Math.round(n.start / frameDur));
    const b = Math.min(nFrames - 1, Math.round(n.end / frameDur) - 1);
    for (let i = a; i <= b; i++) out[i] = n;
  }
  return out;
}

// ---------- the score ----------
// Chance-level octave-collapsed agreement is about 8%. Two and a half times
// that is comfortably above anything a mismatched pair produces and far below
// anything a working tracker produces on matching audio, so the gap is wide
// enough that the exact value does not matter.
const ALIGNMENT_FLOOR = 0.20;
const ALIGNMENT_PROBE = { minConf: 0.5, silenceRatio: 0.045 };

const BASE_CFG = {
  temperament: 'et', minConf: 0.62, silenceRatio: 0.045, sigma: 55,
  switchPenalty: 3.2, silencePenalty: 6, minNoteDur: 0.075, transientMax: 0.12
};

function scoreRecord(engine, record, opts) {
  const o = Object.assign({
    segment: { start: 0, len: 60 }, yin: {}, cfg: {}, tonicJitterCents: 0,
    cacheDir: path.join(__dirname, '..', 'data', 'cache'), toleranceCents: 50
  }, opts);

  if (!record.tonicHz) return { id: record.id, skipped: 'no tonic annotation' };

  const track = getTrack(engine, record, o.segment, o.yin, o.cacheDir);
  if (track.nFrames < 50) return { id: record.id, skipped: 'segment too short' };

  const ragam = datasets.findRagam(engine, record.ragam, metrics)
    || engine.RAGAMS[engine.RAGAMS.length - 1];   // Chromatic: decode without a grammar
  const ragamKnown = !!datasets.findRagam(engine, record.ragam, metrics);

  // Hand the engine a tonic that is deliberately off by a known amount, so the
  // auto-sruthi correction has something real to find. Jitter 0 measures the
  // easy case where the user already set Sa perfectly.
  const configuredTonic = record.tonicHz * Math.pow(2, -o.tonicJitterCents / 1200);
  const cfg = Object.assign({}, BASE_CFG, o.cfg, { tonicHz: configuredTonic, ragam: ragam });

  const result = engine.finishAnalysis(track, cfg);

  const windowLen = (o.yin && o.yin.window) || engine.DEFAULTS.window;
  const gtHz = alignGT(record, track, o.segment, windowLen);

  // Two views of the pitch stage. `raw` is YIN's own opinion; `processed` is
  // what the decoder actually consumes, after octave repair, median smoothing
  // and gap filling. When processed scores worse than raw, the clean-up is
  // costing accuracy rather than adding it -- which is exactly the kind of
  // thing this harness exists to catch.
  const rawVoiced = engine.voicingMask(track, { minConf: cfg.minConf, silenceRatio: cfg.silenceRatio });
  const rawHz = new Float64Array(track.nFrames);
  for (let i = 0; i < track.nFrames; i++) rawHz[i] = rawVoiced[i] ? track.f0[i] : 0;

  const procHz = new Float64Array(track.nFrames);
  for (let i = 0; i < track.nFrames; i++)
    procHz[i] = (result.voiced[i] && isFinite(result.cents[i]))
      ? configuredTonic * Math.pow(2, result.cents[i] / 1200) : 0;

  const raw = metrics.bestLagScores(rawHz, gtHz, 3, o.toleranceCents);
  const processed = metrics.bestLagScores(procHz, gtHz, 3, o.toleranceCents);

  const est = notesToFrames(result.notes, track.nFrames, track.hop, track.sr);
  const svara = metrics.svaraAgreement(est, gtHz, record.tonicHz, ragam, cfg.temperament, engine.centsOf);

  // Not every published record is internally consistent. In Saraga some pieces
  // ship audio and a pitch contour that describe different content -- not a
  // fixed time offset, and not a stem-versus-mix mixup, but genuinely unrelated
  // material. Scored naively those records land at chance and drag a perfectly
  // healthy engine's average down by tens of points.
  //
  // Chroma accuracy is the tell. Octave-collapsed agreement within 50 cents has
  // a chance rate near 100/1200, so a real tracker on real matching audio sits
  // far above it while a mismatched pair sits on top of it. Flag rather than
  // silently drop: a corpus problem the caller cannot see is worse than a low
  // score they can.
  //
  // The probe deliberately uses fixed voicing settings rather than the config
  // under test. Derived from the live config, a parameter sweep could drop a
  // stubborn record below the threshold, have it excluded, and book the
  // resulting rise in the average as an improvement. Which records count has to
  // be a property of the corpus, not something the search can move.
  const chance = 100 / 1200;
  const probeVoiced = engine.voicingMask(track, ALIGNMENT_PROBE);
  const probeHz = new Float64Array(track.nFrames);
  for (let i = 0; i < track.nFrames; i++) probeHz[i] = probeVoiced[i] ? track.f0[i] : 0;
  const probe = metrics.bestLagScores(probeHz, gtHz, 3, 50);
  const alignment = {
    chroma: probe.rawChromaAccuracy,
    ok: probe.rawChromaAccuracy > ALIGNMENT_FLOOR,
    chanceLevel: chance
  };

  return {
    id: record.id,
    dataset: record.dataset,
    title: record.title,
    isolatedVocal: record.isolatedVocal,
    ragamTrue: record.ragam,
    ragamKnown: ragamKnown,
    ragamUsed: ragam.name,
    tonicHz: record.tonicHz,
    frames: track.nFrames,
    alignment: alignment,
    raw: raw,
    processed: processed,
    tonic: metrics.tonicScore(result.appliedShift, configuredTonic, record.tonicHz),
    ragamRank: metrics.ragamRank(result.ragamSuggestions, record.ragam),
    svara: svara,
    noteCount: result.notes.length
  };
}

// ---------- aggregation ----------
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function summarize(rows) {
  const scored = rows.filter((r) => !r.skipped);
  // Averaging over records whose annotation does not describe their audio
  // measures the corpus, not the engine.
  const ok = scored.filter((r) => !r.alignment || r.alignment.ok);
  const withRagam = ok.filter((r) => r.ragamTrue);
  const pick = (f) => mean(ok.map(f));
  return {
    records: ok.length,
    skipped: rows.length - scored.length,
    misaligned: scored.length - ok.length,
    misalignedIds: scored.filter((r) => r.alignment && !r.alignment.ok).map((r) => r.id),
    rawPitchAccuracy: pick((r) => r.raw.rawPitchAccuracy),
    processedPitchAccuracy: pick((r) => r.processed.rawPitchAccuracy),
    processedChromaAccuracy: pick((r) => r.processed.rawChromaAccuracy),
    octaveErrorRate: pick((r) => r.processed.octaveErrorRate),
    voicingRecall: pick((r) => r.processed.voicingRecall),
    voicingFalseAlarm: pick((r) => r.processed.voicingFalseAlarm),
    svaraAccuracy: pick((r) => r.svara.svaraAccuracy),
    svaraClassAccuracy: pick((r) => r.svara.svaraClassAccuracy),
    noteCoverage: pick((r) => r.svara.noteCoverage),
    tonicResidualCents: pick((r) => r.tonic.residualCents),
    ragamTop1: withRagam.length ? withRagam.filter((r) => r.ragamRank === 0).length / withRagam.length : 0,
    ragamTop5: withRagam.length
      ? withRagam.filter((r) => r.ragamRank >= 0 && r.ragamRank < 5).length / withRagam.length : 0,
    ragamScored: withRagam.length
  };
}

module.exports = { prepareAudio, getTrack, alignGT, notesToFrames, scoreRecord, summarize,
                   BASE_CFG, ALIGNMENT_FLOOR, mean };
