# SruthiScribe

Turns a Carnatic vocal recording into svara notation, in the browser, and backs it with a
community-editable library of compositions.

Live: <https://vinoth4v.github.io/sruthiscribe/> · also deployed to Vercel from `main`.

This README is written for a developer or AI agent picking the project up cold. It documents
**why** the system is shaped the way it is, not just what the code does — most of the
constraints below were arrived at the hard way and are cheap to violate by accident.

---

## 1. What the product actually does

A user sings (or uploads a recording). The app:

1. tracks the pitch of the voice frame by frame,
2. decodes that pitch contour into **named svaras**, constrained by the grammar of the ragam,
3. lays those svaras out in **tala structure** (avartana and anga bar lines, held-beat commas,
   speed groupings), with optional **sahitya** (lyrics) under each svara,
4. exports the result as a PDF that matches what's on screen,
5. and matches the reading against a **community database** of compositions, which anyone can
   correct or extend.

An optional "Ask" panel sends the *decoded svara sequence* (never the audio) to Claude for
a teacher-style reading.

### The product's core promise

> Never state something musically confident that the data doesn't support.

This single idea explains a lot of otherwise-odd decisions: the decoder reports its own
deviation and drift; low-confidence svaras render differently; the Ask panel's system prompt
forbids inventing a kriti name; unmatched tala systems get **no** bar lines rather than wrong
ones; lyrics are never auto-generated. An agent that "improves" the app by making it guess
more confidently has made it worse.

---

## 2. Repository layout

```
index.html      the entire app: markup, CSS, engine, and UI logic in one file
api/ask.js      Vercel serverless function -- optional shared-key proxy for the Ask panel
vercel.json     static config + microphone permission header
README.md       this file
```

There is no build step, no bundler, no package.json, and **no CDN dependencies**. Opening
`index.html` from a file:// URL gives you the working app.

### Why single-file, and why it must stay that way

- It has to run inside a Claude artifact sandbox, which blocks external script loads. A CDN
  dependency silently breaks the app there. This is not hypothetical: PDF export was
  originally built on a CDN-loaded jsPDF and did not work in that environment at all. It was
  replaced with a hand-written PDF-1.4 writer (`buildPdfBlob`) for exactly this reason.
- It must work offline and be trivially portable (email the file, it still works).

**Rule for agents: do not add a runtime dependency, a build step, or an external font.**
Typography uses system font stacks only, for the same reason.

---

## 3. Architecture

### 3.1 The engine (pure, testable, no DOM)

The decoding engine is an IIFE inside `index.html` exporting a `SwaraEngine` global. It touches
no DOM and no browser API beyond typed arrays, so it can be `require()`d directly in Node for
testing. Public surface:

```
DEFAULTS frameCount RAGAMS ET JI centsOf dirSets
TALAS JATHIS avartanaBeats angaBoundaries talaLabel allTalas commaCount
mixdownResample yinTrack toCents voicingMask repairOctaves medianSmooth
pitchHistogram tonicOffset ragamMatches buildStates viterbi pathToNotes
renderSvara notationText analyzeSamples finishAnalysis
```

`DEFAULTS`: 16 kHz analysis rate, 800-sample window, 256-sample hop (~16 ms/frame),
f0 range 70–900 Hz.

> **The single most dangerous trap in this repo.** A standalone `engine.js` exists in the
> development workspace and the same code is *embedded* in `index.html`. They are kept
> byte-identical by a re-embed script. This has silently desynced twice, and the second time
> shipped a build where `E.TALAS` was `undefined` while the UI called `E.TALAS.forEach(...)`
> unconditionally at load — which throws and takes the **whole page** down, not just the tala
> feature. If you edit the engine, re-embed it and diff the two copies before committing.

### 3.2 The decode pipeline

```
audio → mixdownResample → yinTrack → toCents → repairOctaves → medianSmooth
      → pitchHistogram → tonicOffset  ─┐
                                        ├→ buildStates → viterbi → pathToNotes → notes[]
      → ragamMatches (suggestions)     ─┘
```

Three accuracy mechanisms are worth understanding before touching the decoder:

**Two-pass sruthi correction.** If the singer's actual Sa sits measurably off the configured
tonic, *every* svara decision is made against a shifted grid — the largest single source of
wholesale mislabeling. The engine measures the offset, shifts the svarasthana grid to match the
voice, then decodes. Benchmarked: 28.5¢ → 2.1¢ mean deviation at 30¢ drift. Controlled by
`cfg.autoTonic` (default on); the applied shift is reported as `result.appliedShift`.

**Directional ragam grammar.** Many ragams are asymmetric (Bilahari ascends without M1 or N3
but descends with them). `dirSets()` derives legal-ascending and legal-descending svara sets
from the aroha/avaroha strings. Two penalties apply: a Viterbi *transition* penalty for entering
a direction-illegal svara, and a per-frame *occupancy* penalty for dwelling on one during a
clear glide. Slope is smoothed over ~160 ms specifically so kampita oscillation averages to
zero — **gamaka must never be mistaken for a directional glide.** Controlled by `cfg.grammar`.

**Auto speed grouping.** Genuinely fast passages are detected by duration and grouped into
2nd/3rd-speed beat units. Critical detail: speed is judged against a *local* reference window
that **excludes the candidate notes themselves**. An earlier version compared against a
whole-clip percentile, which a uniformly fast passage could simply redefine as its own baseline
and thereby evade detection entirely.

### 3.3 Carnatic domain model (for agents unfamiliar with the tradition)

- **Svarasthana** — the 16 named pitch positions (S, R1, R2, R3, G1, G2, G3, M1, M2, P, D1, D2,
  D3, N1, N2, N3) mapped to 12 semitones with overlaps. A **ragam** selects a subset plus rules.
  `E.RAGAMS` holds **114**: all 72 melakartas (verified complete by mela number) plus 42 janya
  ragams. Each entry carries `{name, mela, aroh, avaroh, svaras}`.
- **Aroha / avaroha** — the ascending and descending scale. Often asymmetric; this asymmetry is
  real musical information the decoder uses (see above).
- **Gamaka** — pitch ornamentation (oscillation, slides). Central to the music, *not* noise to
  be filtered out. `renderSvara` can mark them (`~`, `/`, `\`).
- **Sruthi** — the tonic (Sa) the whole performance is relative to. Everything is measured in
  cents from it.
- **Tala** — the rhythmic cycle. Built from **angas**: laghu (`L`, length = the jathi),
  drutam (`D`, always 2), anudrutam (`U`, always 1).
- **Jathi** — the laghu's count: Tisra 3, Chaturasra 4, Khanda 5, Misra 7, Sankeerna 9.
- **35 talas** = 7 Suladi Sapta Talas × 5 jathis. Adi tala = Chaturasra-jati Triputa
  (L4+D2+D2) = **8 beats**, the most common by far and the app's default.
- **Avartana** — one full cycle of the tala. Drawn as a double bar; anga divisions within it
  are single bars.
- **Speed (nadai)** — 1x/2x/3x/4x/8x. Divides each unit's beat weight, so more svaras fit per
  avartana. Adi at 1x = 8 svaras/avartana; at 8x = 64.

> **Chapu talas (Misra Chapu, Khanda Chapu) are a different framework and are NOT modelled.**
> Many database entries use them. The Browse view deliberately renders those with no bar lines
> rather than computing wrong ones. Do not "fix" this by forcing a match.

### 3.4 The rendering pipeline — one source of truth

Notation appears in **four** places: the reading view, the PDF, Browse cards, and the
Add-composition live preview. All four go through the same functions:

```
computeUnits(notes)                          group notes into beat units
computeBarLevels(notes, units, tala, jathi,  → Map<noteIndex, 'avartana'|'anga'>
                 anchorIdx, durUnit, speed)
buildRenderPlan(...)                         → ordered cells {type, indices, bar, section}
chunkIntoLines(cells, hasAnchor)             one avartana per line
wrapLineToRows(line)                         sub-wrap to ≤8 cells for print width
```

**Rule for agents: never render notation by walking `notes[]` directly.** Any new view must
consume `buildRenderPlan`, or it will drift from the others. Two shipped bugs came from
layout code that bypassed it.

`talaAnchor` is a **note index** marking avartana 1 / beat 1. It auto-sets to the first
non-transit note after a decode, and is decremented or cleared when a preceding note is
deleted — index-shift bugs here corrupt the whole bar layout silently.

---

## 4. Data model (Supabase)

Project `yrgsdvgsnoxmfhtyngqc`, free tier. The URL and **publishable** key are intentionally
committed in `index.html`: they are public by design and protected by row-level security, not
by secrecy. There is no service-role key anywhere in this repo, and there must never be one.

```sql
kritis(id, title, composer, ragam, tala, form, source, license, created_at)
versions(id, kriti_id, parent_version, contributor, note, sruthi_hz,
         notation jsonb, flat text, status, created_at)
```

- `notation` — `{sections:[{name, svaras:[{s, o, d?, syl?, sectionStart?}]}]}`
  where `s` = svara label, `o` = octave offset, `syl` = one lyric syllable,
  `sectionStart` = a section name (Pallavi, Anupallavi, …) tagged onto its first note.
- `flat` — space-separated svara tokens **including octave markers** (`S R2 G3 P D2 S'`).
  Used for trigram matching. A bug once rebuilt this from labels alone and silently dropped
  every octave marker; `noteToToken()` is the inverse of `tokenToNote()` and must be used.

### Invariants — enforced by RLS, not just convention

- **World-readable.** Anyone may `select`.
- **Append-only.** Insert policies exist; there are **no update or delete policies** for the
  public role. History is immutable.
- **Editing never overwrites.** An edit inserts a *new* version with `parent_version` pointing
  at the one it corrects, and `status = 'community'`. Seed and imported rows stay untouched
  forever. This is the core of the trust model — do not add an update path.

### RPCs

- `match_kritis(q, lim)` — trigram (`word_similarity` > 0.12) partial-phrase match, ordered by
  score, limit honoured.
- `kriti_versions(kid)` — version history, newest first.

### Current contents (140 kritis / 140 versions / 56 ragams)

| source | count | meaning |
|---|---|---|
| `seed:traditional` | 74 | original outline sketches written from general ragam grammar, public-domain/traditional |
| `saraga:mtg-upf` | 66 | phrase annotations imported from the Saraga dataset, CC BY-NC-SA 4.0 |
| `community` | 0 | user contributions (none yet) |

---

## 5. Licensing rules — read before importing any dataset

This is business logic, not legal boilerplate. Several datasets have already been evaluated and
**rejected**; re-importing them would be a regression.

The app's flagship feature is community members creating *modified versions* of entries.
Therefore:

| License | Verdict | Why |
|---|---|---|
| CC BY / CC BY-SA / CC BY-NC-SA | usable | derivatives permitted |
| **CC BY-NC-ND** | **unusable** | "ND" = no derivatives, which is exactly what versioning does |

Already assessed:

- **Saraga** (doi:10.5281/zenodo.4301737) — CC BY-NC-SA 4.0. **Imported.** Attribution stored
  per row and shown in the Browse UI; derived versions inherit the license.
- **CompMusic Carnatic Kriti Dataset** — CC BY-NC-ND, download links are dead placeholders, and
  the notations were compiled from third-party books. **Rejected.**
- **Zenodo Carnatic Varnam (7726167)** — CC BY-NC-ND, notations sourced from a third party's
  archive, so the packager could not relicense them anyway. **Rejected.**
- **Sanidha** (Georgia Tech CCML) — CC BY 4.0, the best license encountered. VPN-gated;
  access has been granted by the PI. Contains *pitch contours*, not notation — so the intended
  path is to run our own decoder over its `vocal_pitch` / `tonic` data, producing genuinely
  original derivative work. Not yet imported.

A third-party license on a *packaging* cannot grant rights the packager never held over the
*content*. Check both.

---

## 6. The AI ("Ask") panel

Sends the decoded svara sequence and per-note JSON — **never the audio** — to the Anthropic
Messages API. Three resolution paths, in priority order:

1. **A visitor's own API key** pasted into the panel. Read live from the field, never stored.
2. **Claude artifact context** — no key needed, the platform handles auth.
3. **`/api/ask`** — the Vercel function, using a shared key from `process.env.ANTHROPIC_API_KEY`
   server-side. The key never reaches the browser; returns 501 when unconfigured.

The system prompt (`ASK_SYSTEM`) explicitly instructs the model **not** to invent a composer,
kriti name, or lyrics it isn't sure of. Preserve that instruction.

---

## 7. Testing discipline

Node + jsdom, no framework. Run each file directly (`node tala_test.js`); exit code 0 = pass.
The canonical suites and their sizes:

| suite | checks | covers |
|---|---|---|
| `tala_test.js` | 71 | all 35 tala/jathi beat counts, anchors, commas, speed, PDF label |
| `lyrics_test.js` | 49 | sahitya under svaras, sections, dual-level bars, PDF lyrics block |
| `ux_test.js` | 35 | hero, setup collapse/expand, toolbar, keyboard access |
| `sahitya_test.js` | 34 | section-based Add-composition form |
| `browse_test.js` | 39 | filters, cards, attribution, bar rendering + Chapu fallback |
| `db_test.js` | 28 | Supabase queries, headers, failure modes |
| `v2_test.js` | 26 | core UI flows |
| `edit_test.js` | 24 | version editing, duplicate guard |
| `contrast_test.js` | 21 | WCAG AA audit parsed from the shipped `:root` |
| `addform_preview_test.js` | 16 | live preview rendering |
| `accuracy_test.js` | 14 | sruthi correction + grammar, with measured before/after |
| `r_ask.js` | 14 | Ask panel auth paths |
| `test_engine.js` | 11 | engine primitives |
| `drone_test.js` | 10 | drone volume slider |
| `wrap_test.js` | 9 | line wrapping / print rows |
| `pdf_test.js` | 8 | real PDF bytes, externally validated |
| `codec_test.js` | 4 | audio decoding |
| `ctx_test.js` | 3 | host/context detection |

~416 checks total. PDFs are additionally validated out-of-band with `qpdf --check`,
`pdfplumber` (geometry) and `pdftoppm` (rasterised, to prove the page isn't blank).

**The test suite has repeatedly caught real bugs that review missed** — a NaN poisoning every
bar calculation, dropped octave markers, invisible text, an engine desync that broke page load.
Run the full suite before every commit; a passing subset has given false confidence before.

---

## 8. Design system

Palette lives in `:root`. Deep indigo ink base, saffron primary, peacock-teal secondary,
kumkum for errors — plus a **warm paper surface used wherever notation appears**, because
notation is read continuously and is what the PDF already looks like.

`contrast_test.js` parses these tokens out of the shipped CSS and asserts WCAG AA on every
pairing, including a guard that fails if any rule sets a text colour to the page-background
token (which caused two invisible-text bugs).

---

## 9. Deliberate non-features

Do not "add" these without reading why they're absent:

- **Automatic lyrics from audio.** No reliable engine exists for sung, melismatic
  Sanskrit/Telugu/Tamil/Kannada. A confidently wrong lyric line is worse than none, so sahitya
  is manual-entry-and-correct.
- **Bar lines for unmatched talas.** See Chapu talas above.
- **Reproducing published notation or lyrics.** Entries are either original outlines,
  properly-licensed imports, or user-contributed.

---

## 10. Known open items

- Vercel has repeatedly served a stale first deployment despite pushes landing on `main`;
  the GitHub Pages URL is the reliable one. Suspected production-branch misconfiguration
  from the original zip-based deploy.
- `ANTHROPIC_API_KEY` must be set in Vercel env vars for `/api/ask` to work.
- Sanidha import pending (access granted, data not yet pulled).
