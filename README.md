# SruthiScribe

Converts a Carnatic vocal recording into readable svara notation, in the browser.

Live: https://vinoth4v.github.io/sruthiscribe/ · https://sruthiscribe.vercel.app/

---

## This README is written for an AI agent

You will most likely be asked to add a feature or fix a bug in `index.html`. Before you do,
read **[Read this before you change anything](#read-this-before-you-change-anything)** — it
lists the specific ways this codebase has repeatedly misled agents, including previous
sessions of Claude. They are not hypothetical; each one caused a real bug that shipped or
nearly shipped.

---

## What the app does

A singer records or uploads a phrase. The app tracks the pitch of their voice, decides which
svara each moment belongs to *given the ragam they say they're singing*, and renders standard
Carnatic notation — with tala structure, held-beat commas, speed groupings, optional sahitya
(lyrics) under each svara, and a PDF export that matches the screen.

It also hosts a community database of notated compositions that anyone can search, correct,
and add to.

**The core insight that shapes the whole design:** pitch alone does not determine a svara. The
same frequency can be two different svaras in two different ragams, and a gamaka (ornament)
can swing 200 cents around a note that is unambiguously *one* svara to a trained listener. So
the decoder is not a pitch-to-note lookup — it is a constrained search over the svaras the
chosen ragam actually permits, biased toward staying on a note rather than jumping between them.

---

## Architecture in one paragraph

Single self-contained `index.html`. No build step, no framework, no CDN — everything including
the PDF writer is vanilla JS in that one file. `engine.js` in the working directory is the
**same engine source, embedded verbatim** inside `index.html`; it exists separately so tests
can `require()` it. Data lives in Supabase (Postgres) accessed directly from the browser with
a publishable key, protected by row-level security. An optional serverless function
(`api/ask.js`) proxies an Anthropic API call so visitors don't need their own key.

```
index.html        the entire app: embedded engine + UI + rendering + PDF writer
engine.js         the same engine source, standalone, so tests can require() it
api/ask.js        serverless proxy → Anthropic API (optional, Vercel only)
test/             19 suites, 425 checks
test/fixtures/    synthetic audio tones for the codec suite (generated, not recordings)
package.json      dev deps for the tests only; the app itself has zero dependencies
```

---

## Business logic: the decoding pipeline

`E.analyzeSamples(samples, sampleRate, cfg)` runs the whole chain. `E.finishAnalysis(track, cfg)`
re-runs everything *after* pitch tracking — that's what the UI calls when you change a decoder
setting without re-recording.

| Stage | Function | What it does and why |
|---|---|---|
| 1. Mixdown | `mixdownResample` | Everything downstream assumes 16 kHz mono. |
| 2. Pitch track | `yinTrack` | YIN autocorrelation → f0 per frame (800-sample window, 256 hop). |
| 3. Voicing | `voicingMask` | Marks frames voiced/silent by confidence and energy. |
| 4. To cents | `toCents` | Frequency → cents relative to the chosen Sa. All later maths is in cents. |
| 5. Octave repair | `repairOctaves` | YIN halves/doubles octaves on breathy voices; this repairs the jumps. |
| 6. Smooth | `medianSmooth` | Median filter — kills spikes without smearing real transitions. |
| 7. Histogram | `pitchHistogram` | Where the voice actually spent its time. |
| 8. Sruthi drift | `tonicOffset` | How far the singer's real Sa sits from the configured Sa. |
| 9. **Auto-correct** | (in `finishAnalysis`) | **If drift ≥ 12 cents, shift the entire svarasthana grid to match the voice, then decode.** Without this a systematic offset pushes every boundary note onto the wrong svara. Measured: 28.5c → 2.1c mean error on a voice 30c sharp. Disable with `cfg.autoTonic = false`. |
| 10. Build states | `buildStates` | One Viterbi state per svarasthana per octave in the singer's range. |
| 11. **Decode** | `viterbi` | The heart of it — see below. |
| 12. To notes | `pathToNotes` | Collapse the frame path into note objects; classify articulation (`plain`/`kampita`/`slide-up`/`slide-down`) and flag short transit tones. |
| 13. Ragam check | `ragamMatches` | Ranks *all* ragams against the histogram, so the UI can say "this looks more like X than the X you chose". |

### The Viterbi decoder

Three forces, balanced:

- **Emission** — how close is this frame to this svara's cents? Gaussian, width `sigma`
  (default wide, ~55c, so gamaka doesn't shatter one note into five).
- **Transition penalty** (`switchPenalty`) — changing svara costs. This is what makes a wobble
  read as one ornamented note instead of a run.
- **Directional raga grammar** (`dirSets`) — many ragams are asymmetric. Bilahari's arohana has
  no M1 or N3; its avarohana does. The decoder computes a smoothed local slope and penalises
  *entering* (transition) or *occupying* (per-frame) a svara illegal for the direction of
  travel. Sa is always legal. The slope is smoothed over ~160 ms specifically so kampita
  oscillation averages to zero and is never mistaken for a glide. Disable with
  `cfg.grammar = false`.

### Tala, beats and bars

- 7 talas × 5 jathis = **35 combinations** (`E.allTalas()`), Suladi Sapta Tala system.
  Laghu = the jathi's count; drutam = 2; anudrutam = 1. Adi = Chaturasra Triputa = 8 beats.
- `computeUnits` groups notes into beat-units (a speed group of 2/3/4 notes = one unit).
- `unitBeats` = `(1 + commaCount) / speedMultiplier`.
- `computeBarLevels` walks forward *and backward* from the user's anchor note, returning a Map
  of note index → `'avartana'` (double bar) or `'anga'` (single bar).
- **Speed multiplier** (nadai) 1/2/3/4/8× divides each unit's beat weight, so 8× packs 64
  svaras into one Adi avartanam.
- `autoGroupSpeed` detects genuinely fast passages after decoding and groups them
  automatically — judged against a **local** window that *excludes the candidate notes*, so a
  uniformly fast passage can't redefine its own tempo as normal and escape detection.

### One render plan, three outputs

`buildRenderPlan(notes, tala, jathi, anchorIdx, durUnit, showTransit, speed)` returns an ordered
cell list. The on-screen notation, the Browse cards and the PDF **all render from this same
function**. If you add a notation feature, add it here once — don't fork the logic per output,
which is how they silently drift apart.

---

## Data model

Supabase project `yrgsdvgsnoxmfhtyngqc`. Two tables, append-only by design.

```sql
kritis   (id, title, composer, ragam, tala, form, source, license, created_at)
versions (id, kriti_id → kritis, parent_version → versions, contributor, note,
          sruthi_hz, notation jsonb, flat text, status, created_at)
```

- **`flat`** — space-separated svara tokens (`"S R2 G3 P D2 S'"`), `'` for tara sthayi and `.`
  for mandra. This is the matching key, indexed with a pg_trgm GIN index.
- **`notation`** — `{sections:[{name, svaras:[{s, o, syl?, sectionStart?}]}]}`. `s` = label,
  `o` = octave offset, `syl` = optional lyric syllable, `sectionStart` tags the first note of a
  Pallavi/Anupallavi/etc.
- **`status`** — `'seed'` (immutable baseline) or `'community'`.

**Versioning is append-only and non-negotiable.** RLS grants the anon role `select` and
`insert` only — there is no update or delete policy. Editing an entry inserts a *new* version
with `parent_version` pointing at the one it corrects. The original always survives. Don't
"simplify" this into an update.

`match_kritis(q, lim)` — RPC using `word_similarity` to find compositions containing a phrase
the user just sang.

### Current contents

140 compositions / 140 versions / 56 ragams, from two sources:

| Source | Count | License |
|---|---|---|
| `seed:traditional` | 74 | Public domain / traditional. Outline sketches written from general ragam grammar. |
| `saraga:mtg-upf` | 66 | **CC BY-NC-SA 4.0** — Saraga dataset, MTG-UPF, doi:10.5281/zenodo.4301737 |

---

## Licensing rules you must not break

This project has refused several datasets for specific, checked reasons. Before importing
anything, verify the license yourself — do not assume.

- **Derivatives must be permitted.** The whole app is built on community members editing
  entries. A **no-derivatives (ND)** license is therefore incompatible, full stop. This is why
  the CompMusic Carnatic Kriti Dataset and Zenodo record 7726167 were both declined.
- **Check who actually holds the rights.** Several datasets package notation *compiled from
  third-party books and blogs*. The packager cannot grant rights they never held.
- **Attribution must be stored per entry**, in `kritis.license`, and displayed in the UI.
  Saraga entries show a distinct tag plus their full attribution line.
- **Share-alike propagates.** Community versions derived from a CC BY-NC-SA entry inherit it.
- **The app never generates lyrics.** There is no automatic voice-to-lyrics extraction here,
  and the PDF's Lyrics block only ever contains syllables a human actually typed. A specific
  transcription pairing sahitya to svaras is usually someone's copyrighted edition even when
  the underlying composition is centuries old.

---

## Read this before you change anything

These are the traps. Each has already caused a real bug.

**1. `engine.js` and the copy inside `index.html` must stay byte-identical.**
This has broken twice. The second time the embedded engine was missing `E.TALAS`, and the tala
picker's unconditional `E.TALAS.forEach()` threw on page load — breaking the entire app, not
just that feature. After editing `engine.js`, re-embed:

```bash
python3 - <<'PY'
work = open('index.html').read(); eng = open('engine.js').read()
start = "/* ============================================================\n   SruthiScribe engine"
end = "})(typeof globalThis !== 'undefined' ? globalThis : this);"
si = work.index(start); ei = work.index(end, si) + len(end)
sj = eng.index(start);  ej = eng.index(end, sj) + len(end)
open('index.html','w').write(work[:si] + eng[sj:ej] + work[ei:])
PY
# then verify — this MUST print 0:
diff <(sed -n '/SruthiScribe engine/,/root.SwaraEngine = API/p' index.html) \
     <(sed -n '/SruthiScribe engine/,/root.SwaraEngine = API/p' engine.js) | wc -l
```

**2. Features you assume are missing are often already built.**
Multiple sessions have started building something that already existed, because it hadn't been
mentioned recently. The tala system, the sahitya/section system and the shared-key proxy were
each "rediscovered" this way. **Grep first:** `grep -n "featureName" index.html`.

**3. A working page is not a passing build.**
The tala system existed for an entire session while being completely broken at runtime, because
nothing tested it. Run the full suite below — not just the file you touched.

**4. Manually-entered notes have no `.dur`.**
`commaCount` divides by duration. Feed it a note without one and you get `NaN`, which poisons
every cumulative beat total after it and silently stops bars rendering. Preview code sets a
placeholder `dur: 0.2`.

**5. Don't rebuild `flat` from `note.s` alone.** That drops the octave marker (`S'` → `S`).
Use `noteToToken(n)`.

**6. Never set a text colour to `var(--ink)`.** That's the page background. It produced two
invisible-text bugs. `contrast_test.js` now fails the build if you do.

**7. Notation renders on a *paper* surface.** `.sv`, `.syl` and `.secthead` use dark, paper-
appropriate colours. Any new container showing notation must also be paper (`--paper`), or the
text is dark-on-dark. Three places do this: the reading, Browse cards, the Add-form preview.

**8. Bars are only drawn when the tala can be confidently matched.** `matchTalaJathi()`
deliberately returns `null` for anything it can't map to the 35 combinations — notably **Chapu
talas** (Misra Chapu, Khanda Chapu), a different system this app does not model, used by many
Saraga entries. Unmatched entries fall back to flat rendering. A confidently wrong bar is worse
than no bar.

---

## Tests

19 suites, 425 checks, pure Node + jsdom. No test runner, no config — each file is standalone
and exits non-zero on failure.

```bash
npm install     # jsdom + pngjs, needed by the tests only
npm test        # runs every suite, exits non-zero if any check fails
node test/tala_test.js    # or run one suite directly while debugging
```

`codec_test` also needs `ffmpeg` on PATH. The PDF suite validates output with `qpdf`,
`pdfplumber` and `pdftoppm` when available and degrades gracefully when they aren't.

| Suite | Covers |
|---|---|
| `test_engine`, `codec_test` | Pitch tracking, decoding, articulation, audio decode |
| `accuracy_test` | Sruthi auto-correction and directional grammar, with **measured before/after numbers** |
| `tala_test` | All 35 tala/jathi beat counts, comma maths, bars, speed multipliers, UI integration |
| `lyrics_test` | Sahitya under svaras, section labels, anga/avartana bar classification |
| `wrap_test` | Line wrapping, high-speed row splitting |
| `sahitya_test`, `addform_preview_test`, `edit_test` | Add-composition builder, live preview, versioned editing, duplicate guard |
| `browse_test`, `db_test` | Database search, filters, card rendering, attribution |
| `pdf_test` | Real PDF bytes, externally validated with `qpdf`, `pdfplumber`, `pdftoppm` |
| `ux_test`, `contrast_test` | Setup collapse, toolbar, and a WCAG AA audit of every colour pairing |
| `r_ask`, `r_dom`, `ctx_test`, `v2_test` | Ask panel, DOM smoke tests, artifact/deployment contexts |

Tests deliberately use invented placeholder syllables (`la`, `li`, `lo`) — never real lyrics.

---

## Deployment

- **GitHub Pages** — serves `main` directly. The reliable path.
- **Vercel** — connected to the same repo. Has historically failed to pick up pushes; if it
  looks stale, check Settings → Git → Production Branch is `main`.
- **Ask panel** — inside a Claude artifact it needs no key. On Vercel it uses `api/ask.js`,
  which requires `ANTHROPIC_API_KEY` in the Vercel environment. Otherwise a visitor can paste
  their own key, held in memory only and never stored.

The Supabase publishable key is intentionally committed. It is *designed* to be public — RLS
protects the data, not secrecy of that key. Never commit a service-role key.

---

## Conventions

- ES5-style `var` and `function` in `index.html` — it targets older mobile browsers directly
  with no transpiler. Match the surrounding style.
- Comments explain *why*, especially where a value was tuned or a simpler approach rejected.
  Preserve that reasoning when editing.
- Copy is plain and honest: errors say what happened and what to do; the app says when it isn't
  sure rather than guessing confidently.
