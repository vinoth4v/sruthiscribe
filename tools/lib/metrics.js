// Accuracy metrics for a SruthiScribe reading against dataset ground truth.
//
// The melody numbers are the standard mir_eval definitions (Salamon et al.),
// so they are directly comparable with published Carnatic pitch-tracking
// results. The rest are app-specific: they score the three decisions the page
// actually makes on the user's behalf -- where Sa is, which ragam it is, and
// which svara each moment belongs to.

// ---------- frame timing ----------
// yinTrack's frame i analyses samples [i*hop, i*hop + W), so the estimate
// describes the centre of that window, not its start. Getting this wrong shifts
// every comparison by ~25 ms and quietly costs several points of pitch
// accuracy, which is why it is stated explicitly rather than assumed.
function frameTimes(nFrames, hop, sr, windowLen) {
  const t = new Float64Array(nFrames);
  const centre = (windowLen || 0) / 2;
  for (let i = 0; i < nFrames; i++) t[i] = (i * hop + centre) / sr;
  return t;
}

// ---------- ground-truth resampling ----------
// Ground-truth contours are sampled far denser than our 16 ms hop (Saraga's are
// ~2.9 ms). Nearest-neighbour within half a GT step is the honest mapping: no
// interpolation across a voiced/unvoiced boundary, which would invent pitch.
function sampleGT(gt, times) {
  const { t: gtT, hz: gtHz } = gt;
  const out = new Float64Array(times.length);
  const step = gtT.length > 1 ? (gtT[gtT.length - 1] - gtT[0]) / (gtT.length - 1) : 0.01;
  const tol = Math.max(step, 0.005);
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    const want = times[i];
    while (j + 1 < gtT.length && gtT[j + 1] <= want) j++;
    let best = j;
    if (j + 1 < gtT.length && Math.abs(gtT[j + 1] - want) < Math.abs(gtT[j] - want)) best = j + 1;
    out[i] = Math.abs(gtT[best] - want) <= tol ? gtHz[best] : 0; // outside coverage = unvoiced
  }
  return out;
}

function centsBetween(a, b) { return 1200 * Math.log2(a / b); }

function foldOctave(c) {
  let x = ((c % 1200) + 1200) % 1200;
  return x > 600 ? x - 1200 : x;
}

// ---------- melody metrics (mir_eval definitions) ----------
function melodyScores(estHz, gtHz, toleranceCents) {
  const tol = toleranceCents || 50;
  let gtVoiced = 0, gtUnvoiced = 0, tp = 0, fp = 0, rpa = 0, rca = 0, correct = 0;
  for (let i = 0; i < gtHz.length; i++) {
    const g = gtHz[i], e = estHz[i];
    const gv = g > 0, ev = e > 0;
    if (gv) {
      gtVoiced++;
      if (ev) {
        tp++;
        const d = centsBetween(e, g);
        if (Math.abs(d) <= tol) { rpa++; correct++; }
        if (Math.abs(foldOctave(d)) <= tol) rca++;
      }
    } else {
      gtUnvoiced++;
      if (ev) fp++; else correct++;
    }
  }
  return {
    frames: gtHz.length,
    voicingRecall: gtVoiced ? tp / gtVoiced : 0,
    voicingFalseAlarm: gtUnvoiced ? fp / gtUnvoiced : 0,
    rawPitchAccuracy: gtVoiced ? rpa / gtVoiced : 0,
    rawChromaAccuracy: gtVoiced ? rca / gtVoiced : 0,
    overallAccuracy: gtHz.length ? correct / gtHz.length : 0,
    // The gap between chroma and pitch accuracy is entirely octave errors --
    // the single most visible failure in the notation, since it moves a svara
    // to the wrong octave dot rather than mistuning it slightly.
    octaveErrorRate: gtVoiced ? (rca - rpa) / gtVoiced : 0
  };
}

// The window-centre correction above is a model of the tracker's latency, not a
// measurement of it; smoothing and gap-filling add a little more. Scoring at a
// handful of candidate lags and reporting the best one keeps a fixed timing
// offset from being mistaken for a pitch error. The chosen lag is returned so a
// suspiciously large one is visible rather than silently absorbed.
function bestLagScores(estHz, gtHz, maxLagFrames, toleranceCents) {
  const maxLag = maxLagFrames == null ? 3 : maxLagFrames;
  let best = null;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const n = gtHz.length - Math.abs(lag);
    if (n <= 0) continue;
    const e = new Float64Array(n), g = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      e[i] = estHz[lag > 0 ? i + lag : i];
      g[i] = gtHz[lag > 0 ? i : i - lag];
    }
    const s = melodyScores(e, g, toleranceCents);
    if (!best || s.rawPitchAccuracy > best.scores.rawPitchAccuracy) best = { lag: lag, scores: s };
  }
  const out = best ? best.scores : melodyScores(estHz, gtHz, toleranceCents);
  out.lagFrames = best ? best.lag : 0;
  return out;
}

// ---------- tonic ----------
// The page's job is to notice that the singer's Sa is not exactly where the
// user set it. To score that we hand the engine a deliberately wrong tonic and
// check how much of the known error it recovers.
function tonicScore(appliedShiftCents, configuredTonicHz, trueTonicHz) {
  const trueOffset = centsBetween(trueTonicHz, configuredTonicHz);
  return {
    trueOffsetCents: trueOffset,
    appliedShiftCents: appliedShiftCents,
    residualCents: Math.abs(trueOffset - appliedShiftCents),
    // What the user would have been left with had the engine done nothing.
    uncorrectedCents: Math.abs(trueOffset)
  };
}

// ---------- ragam identification ----------
// Dataset ragam names carry diacritics and transliteration variants
// ("Śaṅkarābharaṇaṃ", "Sankarabharanam", "Shankarabharanam", "kalyANi").
// Fold to bare consonant-vowel skeletons before comparing, and treat the
// common sh/s and v/w swaps as equal.
function normalizeRagam(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip combining marks
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/sh/g, 's').replace(/w/g, 'v')
    .replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/ii/g, 'i')
    .replace(/oo/g, 'u').replace(/uu/g, 'u')
    .replace(/th/g, 't').replace(/dh/g, 'd').replace(/bh/g, 'b')
    .replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/ph/g, 'p')
    .replace(/(am|a|i|u|m)$/, '');                       // drop case endings
}

function editDistance(a, b) {
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Exact match on the folded skeleton first; only then a small edit-distance
// fallback, because the folding rules cannot cover every romanisation
// ("Rītigauḷa" vs "Reetigowla" survive as ritigaul/ritigovl). The threshold
// scales with name length and stays tight enough that genuinely different
// ragams -- Kalyani/Kalyani-adjacent names included -- never collide.
// Some ragams are known by two names that share no letters, so no amount of
// folding will connect them. These are the ones the corpora actually use.
// Only genuine synonyms belong here -- Pantuvarali IS Kamavardhani (mela 51),
// but Subhapantuvarali is mela 45 and a different ragam entirely.
const RAGAM_ALIASES = {
  todi: 'Hanumatodi',
  pantuvarali: 'Kamavardhani',
  kamavardhini: 'Kamavardhani',
  sankarabharanam: 'Shankarabharanam',
  dheerasankarabharanam: 'Shankarabharanam',
  mechakalyani: 'Kalyani',
  shuddhasaveri: 'Shuddha Saveri',
  suddhasaveri: 'Shuddha Saveri',
  suddhadhanyasi: 'Shuddha Dhanyasi',
  udayaravichandrika: 'Shuddha Dhanyasi',
  natai: 'Nattai',
  nata: 'Nattai',
  poorvikalyani: 'Purvikalyani',
  pantuvarali51: 'Kamavardhani'
};

const ALIAS_FOLDED = {};
for (const k of Object.keys(RAGAM_ALIASES)) ALIAS_FOLDED[normalizeRagam(k)] = RAGAM_ALIASES[k];

function ragamRank(suggestions, trueName) {
  let want = normalizeRagam(trueName);
  if (!want) return -1;
  const folded = suggestions.map(function (s) { return normalizeRagam(s.name); });

  // An alias is a statement about the music, so it outranks any spelling
  // guess: resolve it first and match on the canonical name. Both sides go
  // through the same folding, or "Thodi" never reaches the "todi" key.
  if (ALIAS_FOLDED[want]) want = normalizeRagam(ALIAS_FOLDED[want]);

  for (let i = 0; i < folded.length; i++) if (folded[i] === want) return i;

  // Take the CLOSEST name within budget, not the first one that happens to
  // clear it. Scanning in table order matched "Kamavardhini" to Ragavardhini
  // at distance 2 while Kamavardhani sat at distance 1 further down the
  // table -- a different melakarta, so every svara after it was decoded
  // against the wrong scale.
  const budget = want.length >= 8 ? 2 : 1;
  let bestI = -1, bestD = Infinity;
  for (let i = 0; i < folded.length; i++) {
    if (Math.abs(folded[i].length - want.length) > budget) continue;
    const d = editDistance(folded[i], want);
    if (d <= budget && d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}


// ---------- svara agreement ----------
// There is no note-level ground truth in either dataset, so this is a proxy,
// and an honest one: take the ground-truth F0, quantise it against the known
// tonic and the known ragam exactly as a listener naming svaras would, and ask
// how often the Viterbi path lands on the same svara. It isolates the decoder
// from the pitch tracker -- both are scored against the same reference contour,
// so a low number here with a high RPA means the decoding stage is at fault.
function quantizeToRagam(cents, ragam, temperament, centsOf) {
  let best = null;
  for (let oct = -3; oct <= 3; oct++) {
    for (let i = 0; i < ragam.svaras.length; i++) {
      const c = oct * 1200 + centsOf(ragam.svaras[i][0], temperament);
      const d = Math.abs(cents - c);
      if (!best || d < best.d) best = { d: d, label: ragam.svaras[i][1], oct: oct };
    }
  }
  return best;
}

// `est` is one entry per frame, {label, oct} or null, built from the notes the
// page would actually print -- not from the raw Viterbi path. Frames the
// decoder dropped as too short to name are reported as coverage rather than
// folded into the accuracy, so a decoder that stays silent cannot score well by
// simply refusing to commit.
function svaraAgreement(est, gtHz, tonicHz, ragam, temperament, centsOf) {
  let voicedFrames = 0, scored = 0, sameSvara = 0, samePitchClass = 0;
  for (let i = 0; i < gtHz.length && i < est.length; i++) {
    if (gtHz[i] <= 0) continue;
    voicedFrames++;
    const got = est[i];
    if (!got) continue;
    const ref = quantizeToRagam(centsBetween(gtHz[i], tonicHz), ragam, temperament, centsOf);
    scored++;
    if (got.label === ref.label) {
      samePitchClass++;
      if (got.oct === ref.oct) sameSvara++;
    }
  }
  return {
    scoredFrames: scored,
    noteCoverage: voicedFrames ? scored / voicedFrames : 0,
    svaraAccuracy: scored ? sameSvara / scored : 0,          // label + octave
    svaraClassAccuracy: scored ? samePitchClass / scored : 0 // label only
  };
}

module.exports = {
  frameTimes, sampleGT, melodyScores, bestLagScores, tonicScore,
  normalizeRagam, ragamRank, editDistance, svaraAgreement, quantizeToRagam,
  centsBetween, foldOctave
};
