# Tools

Two separate jobs live here: measuring the engine's accuracy, and building the
Carnatic library the app browses.

Nothing here needs `npm install` or `pip install`. Node, Python 3 and macOS's
built-in `afconvert` and `textutil` are the only requirements — the two
dependencies that would otherwise be needed, a zip reader that works over HTTP
range requests and a YAML parser, are in `lib/` at about a hundred lines each.

```
tools/
  # Accuracy harness
  selftest.js           end-to-end check with synthetic audio — run this first
  eval.js               score the engine against a dataset
  tune.js               search the engine's parameters against a dataset
  fetch-saraga.py       fetch Saraga selectively from Zenodo (public, no VPN)
  fetch-sanidha.py      mirror Sanidha (needs the Georgia Tech VPN)
  prune-cache.js        reclaim decoded audio once pitch tracks exist

  # Library builders
  fetch-varnams.py      pull the CompMusic varnam notations out of Zenodo
  build-varnams.py      those notations -> full compositions, sahitya aligned
  load-varnams.py       -> SQL
  build-ragams.py       Wikipedia's janya list -> the ragam library
  build-compositions.py Wikipedia's composer lists -> composition metadata
  build-saraga-sections.py  Saraga's section layer -> composition structure

  lib/
    engine.js        extracts the engine straight out of index.html
    wav.js           dependency-free WAV reader
    metrics.js       mir_eval melody metrics + tonic / ragam / svara scores
    datasets.js      Saraga and Sanidha adapters
    remotezip.py     reads zip members over HTTP range requests
    objectstore.py   optional S3 / Supabase upload, no SDK required
    tinyyaml.py      a YAML subset, enough for the varnam notations
    run.js           runs and scores one record, with a pitch-track cache
```

Everything under `tools/data/` is a build output or a cache and is gitignored;
the builders regenerate all of it. The varnam dataset in particular is
CC BY-NC-ND and must not be committed — `fetch-varnams.py` retrieves it.

The engine is read out of `index.html` at run time rather than copied, so the
harness always measures the code that actually ships and the two cannot drift
apart.

## Start here

```sh
node tools/selftest.js
```

Builds a synthetic Mohanam phrase with an exactly known F0 contour, runs the
whole scoring path over it, and checks 13 invariants. If this passes, a poor
score later means a poor engine and not a broken harness.

## Getting data

### Saraga — public, available now

249 Carnatic tracks from CompMusic. 197 carry a tonic annotation and an F0
contour, 168 have a bleed-free vocal stem, and 117 have phrase-level solfège
transcriptions — the only note-level ground truth that exists for this task.

```sh
python3 tools/fetch-saraga.py --out ~/datasets/saraga --list              # what would be fetched
python3 tools/fetch-saraga.py --out ~/datasets/saraga --annotations-only  # a few MB
python3 tools/fetch-saraga.py --out ~/datasets/saraga --tracks 40 --trim-pitch 240
```

**The 14.4 GB archive is never downloaded.** Zenodo honours HTTP range
requests, and a zip keeps its table of contents at the end, so individual
members are pulled straight out of the remote archive. What is actually useful
is far smaller than what contains it:

| | tracks | size |
| --- | ---: | ---: |
| tonic, metadata, phrases, sections | 197 | 0.4 MB |
| F0 contours | 197 | 1320 MB |
| isolated vocal stems | 168 | 1982 MB |

`--tracks N` takes the N pieces carrying the most ground truth. `--trim-pitch
SEC` keeps only the head of each contour, which is where the bulk sits — 26
tracks with vocal stems and 240 s of contour comes to well under a gigabyte.

Zenodo rate-limits by request count, and selective extraction makes many small
requests. `--pace` sets the gap between them (0.35 s by default); 429s are
retried with backoff rather than failing the run.

### Sanidha — behind the Georgia Tech VPN

Five studio concerts, ~8 hours, isolated vocal stems with essentially no bleed,
plus per-song F0 contours, tonic, ragam, talam and section annotations. Cleaner
than Saraga, and closer to what the app records.

```sh
python3 tools/fetch-sanidha.py --check                                  # diagnose the connection
python3 tools/fetch-sanidha.py --out ~/datasets/sanidha                 # vocals + annotations
python3 tools/fetch-sanidha.py --out ~/datasets/sanidha --excerpt 60:60 # ~5 MB per stem
```

The default selection skips the video and the non-vocal stems, which turns a
several-hundred-gigabyte mirror into a couple of gigabytes. `--all-stems` and
`--videos` widen it.

`--excerpt START:LEN` narrows it much further. Sanidha's stems are uncompressed
WAV, so a timestamp is a byte offset: fetching only the window you intend to
score costs about 5 MB per stem instead of 300 MB. Each excerpt gets an
`.excerpt.json` sidecar recording where in the recording it came from, and the
harness applies that offset so absolute annotation timestamps still line up.
Asking `eval.js` for a window outside what was fetched is an error, not a
silent misalignment.

Access needs three things in order: email `natcs@gatech.edu` for a GT Guest
account, connect the GT VPN (Palo Alto GlobalProtect via `vpn.gatech.edu`, Duo
2FA), then run the fetcher. Any commercial VPN must be off — it routes you
further from campus, not closer. `--check` says which step is missing.

## Measuring

```sh
node tools/eval.js --data ~/datasets/saraga --limit 20 --json before.json
node tools/eval.js --data ~/datasets/sanidha --isolated --jitter 35
```

Reported per record and in aggregate:

| metric | what it tells you |
| --- | --- |
| raw pitch accuracy | YIN alone, before any clean-up |
| processed pitch accuracy | what the decoder actually consumes, after octave repair, smoothing and gap filling |
| octave error rate | the gap between chroma and pitch accuracy — the most visible failure, since it moves a svara to the wrong octave dot |
| voicing recall / false alarm | notes invented from silence, or dropped from singing |
| svara accuracy | the decoded svara against the ground-truth contour quantised to the known ragam — closest to what a user reads |
| note coverage | how much of the singing got named at all |
| tonic residual | how much of a deliberately mis-set Sa the auto-sruthi step recovers |
| ragam top-1 / top-5 | histogram-based ragam identification against the annotated ragam |

`raw` and `processed` are reported separately on purpose. If processed scores
*worse* than raw, the clean-up stage is costing accuracy rather than adding it,
and `repairOctaves` is the first place to look.

`--jitter N` hands the engine a tonic that is wrong by a known N cents. Without
it the auto-sruthi correction has nothing to find and scores a perfect zero for
free.

## Tuning

```sh
node tools/tune.js --data ~/datasets/saraga --limit 24 --holdout --out tuned.json
node tools/eval.js --data ~/datasets/saraga --limit 24 --cfg tuned.json
```

Coordinate descent over one parameter at a time. `--holdout` tunes on half the
records and reports on the other half; a gain that appears on both is real, and
one that appears only on the tuning half is the search fitting noise. The tool
says so explicitly when the two disagree.

Parameters split by cost. The decode-stage ones — `sigma`, `switchPenalty`,
`minConf`, `silenceRatio`, `minNoteDur`, `transientMax`, `temperament`,
`grammar`, `dirPenalty`, `occupancyPenalty` — reuse the cached pitch track, so a
full sweep is milliseconds per configuration. The YIN ones (`window`, `hop`,
`fmin`, `fmax`, `threshold`) invalidate that cache and re-track every excerpt;
they are behind `--yin`.

Once a config wins on the held-out split, copy its values into the defaults in
`index.html` (`cfg()` and the control defaults) — the harness never edits the
page itself.

## What this has found so far

Measured on 17 Saraga records (60 s from 60 s), the shipped parameters turned
out to be close to a local optimum: `tune.js` found +2.5 points on the tuning
split and **−4.5 on the held-out split**. Parameter tuning is not where the
accuracy is.

The accuracy was in a structural bug. `finishAnalysis` shifted the whole svara
grid whenever the best histogram rotation moved more than 12 cents. Gamaka
smears a pitch histogram far wider than 12 cents, so some rotation always won
by a hair and the test fired on nearly every reading — inventing a ~39-cent
tonic error on readings whose Sa was already correct.

The shift now has to clear two bars: be large enough to be worth making
(`autoTonicMinCents`, 25) and fit the histogram *meaningfully* better than not
shifting (`autoTonicMargin`, 0.08). Svara accuracy with a correctly set tonic:

| tonic error | before | after |
| --- | ---: | ---: |
| 0 cents | 54.5% | **67.0%** |
| 25 cents | 54.4% | **63.7%** |
| 50 cents | 51.1% | 52.7% |
| 90 cents | 52.0% | 51.6% |

Verified on two independent halves of the corpus separately (+17.8 and +7.7
points at 0 cents), so it is not the search fitting noise. Simply disabling the
correction scores higher still on an in-tune reading (70.7%) but collapses on a
badly mis-set one (35% at 90 cents, 12.7% at 150), which is what the gate
preserves.

Still open, in rough order of size:

* **voicing false alarm ~50%** — half of the frames the reference calls silence
  produce notes. Directly visible as invented svaras between phrases.
* **svara 67% against pitch 72%** — the decoder gives back some of what the
  tracker hands it.
* **ragam top-1 6%** — histogram matching against 114 ragams is barely working.

## Records the corpus got wrong

Not every published record is internally consistent. In Saraga some pieces ship
audio and a pitch contour describing different content — not a fixed time
offset, and not a stem-versus-mix mixup. Scored naively they land at chance and
drag a healthy engine's average down by tens of points.

`eval.js` detects this and excludes them, naming each one. The test is
octave-collapsed pitch agreement: chance is about 8%, a working tracker on
matching audio is far above it, and a mismatched pair sits right on top of it.
The two populations are so far apart that the threshold barely matters.

If a record you expected to score well is excluded, that is worth reading as a
statement about the corpus, not about the engine.

## Off-machine storage (optional)

`--archive s3://bucket/prefix` or `--archive supabase://bucket/prefix` uploads
fetched audio as it arrives. Dependency-free — SigV4 is signed by hand, so
there is no boto3 to install. S3 reads `~/.aws/credentials`; Supabase needs
`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the publishable key in `index.html`
is read-only by design and cannot write to storage).

Worth being clear that this is rarely needed. Evaluation reads a one-minute
excerpt and keeps only the pitch track — about 100 kB per minute — so the audio
is scratch. Archiving pays off in two cases: re-tracking later with different
YIN settings without re-fetching, and a machine too small to hold even the
working set. Otherwise: fetch, track, delete.

## Caching

Decoded audio and pitch tracks land in `tools/data/cache`, keyed by source path,
excerpt and YIN settings. It is safe to delete; it only costs time. This is what
makes a parameter sweep cheap: YIN runs once per excerpt, and the thousands of
configurations after it only re-run the decode stage.

The two halves differ enormously in size and in value. Decoded WAVs exist only
because `afconvert` cannot seek — 2.3 GB for 24 tracks. Pitch tracks are 3.2 MB
for the same 24 and are what every sweep actually reads. Once tracked, the audio
is dead weight:

```sh
node tools/prune-cache.js         # show what would go
node tools/prune-cache.js --yes   # delete it
```

Deleting it costs one re-decode if you later change the excerpt window or the
YIN settings, and nothing at all otherwise.

## Building the library

The other half of this directory fills the `ragams` and `kritis` tables the
Browse tab reads. The constraint that shapes all of it: **complete Carnatic
notation is not openly licensed at any scale.** Lyrics and metadata are.

### Ragams

```sh
python3 tools/build-ragams.py --check    # coverage, and every disagreement
python3 tools/build-ragams.py --sql      # -> SQL
```

Wikipedia's *List of Janya ragas* is the one page that lays the whole system out
mechanically: a row per ragam, both scales as `{{svaraC|S|R1|G3|…}}` templates,
and numbered melakarta rows introducing the janyas under them. 72 melakartas and
867 janyas. Chakra, note counts, janya classification, vakra, the varja svaras
and the semitone table are all derived from the two scales rather than scraped.

The same parse also exists as `fetch_janya_ragas()` in the database, which is
what actually loaded the table — nine hundred rows of INSERT literals is mostly
quoting, and parsing server-side keeps the load reproducible. This script is the
reference implementation and the thing to run when checking the result.

Where Wikipedia and the ragam table inside `index.html` disagree, the app wins:
its scales are what pitch detection is scored against, and it is often the more
standard attribution — Wikipedia files Sahana and Valaji under different
melakartas than practice does. The other reading is kept in `ragams.notes`.

Two traps, both fixed and both easy to reintroduce:

- A scale is written Sa to Sa with the upper Sa unmarked. Read literally that
  looks like the line turns round at the end, which flags every melakarta as
  vakra. `bound_scale()` marks it before the contour is measured.
- A bhashanga ragam names more than seven svaras — Anandabhairavi borrows two,
  Sindhubhairavi is nearly chromatic. Count checks must allow twelve.

### Varnams — the only complete notation

```sh
python3 tools/fetch-varnams.py
python3 tools/build-varnams.py --selftest        # checks the whole chain
python3 tools/build-varnams.py --verify-octaves  # scores the octave inference
python3 tools/load-varnams.py > tools/data/varnams.sql
```

Seven varnams, every section, sahitya under the svaras. Three things have to be
reconstructed, and each is checked rather than assumed:

- **Svara variants.** The `moorchanas` block is numbered inconsistently between
  files — Kalyani's gandharam is G2 where Sahana's same pitch is G3 — so letters
  resolve against the app's own ragam table instead.
- **Octaves.** Not every file marks them: `abhogi.yaml` has no mandra marker at
  all though the pallavi descends to mandra dhaivatam, and three files mark
  nothing. Octaves come from the path of least melodic motion across a section,
  pinned wherever the file does give a marker. `--verify-octaves` scores it both
  ways: leave-one-out, the case actually relied on, recovers every mark; with a
  section's markers stripped entirely it leaves about 6% in the wrong octave.
- **Sahitya.** Each notation line's svaras are checked against the yaml at the
  same offset before its syllables are believed, so a line the `.doc` conversion
  mangled is skipped rather than sliding the rest of the section along.

`--selftest` checks all of it against the printed first avartana of *Evvari
bodhana*, mandra and tara markings included.

### Compositions

```sh
python3 tools/build-compositions.py --report   # coverage, and what fails to match
python3 tools/build-compositions.py --sql      # -> SQL
```

Wikipedia has two large machine-readable composition lists, Tyagaraja's and
Dikshitar's. The others do not exist. 466 rows of title, ragam, tala, language,
deity and the set each piece belongs to — metadata, no notation.

The work is in the matching, because romanisation is not standardised and every
source picks a different convention:

```
Sankarabharanam / Shankarabharanam / Śaṃkarābharaṇaṃ
Rītigauḷa / Reethigowla        Māyāmāḻavagauḻa / Mayamalavagowla
Miśra cāpu / miSra cApu / Misra Chapu
```

Matching on the literal string, even after stripping diacritics, resolves about
a third. `phon()` folds the systematic differences — aspirates, sibilants, long
vowels, the au/ow/ou family, both nasals to one, vocalic ṛ — and takes it to
88% of ragams and 94% of talas. Two guards matter: an exact fold wins over a
phonetic one, and a phonetic key matching two different ragams is discarded
rather than resolved arbitrarily, because the fold is deliberately lossy.

Whatever still fails to match keeps the spelling the page published and says so
on the row, rather than being dropped or guessed at. `--report` prints the
residue so it can be inspected.

### Section structure, from Saraga

```sh
python3 tools/fetch-saraga.py --out ~/datasets/saraga \
        --annotations-only --no-pitch --tracks 0     # 119 pieces, 0.4 MB
python3 tools/build-saraga-sections.py --data ~/datasets/saraga --report
python3 tools/build-saraga-sections.py --data ~/datasets/saraga --sql
```

Saraga annotates, by ear, where each section of a piece falls in a recording:

```
6.791836734   1   74.555102041   Pallavi
start(s)          duration(s)    label
```

That yields the composition's shape — which sections it has, in what order,
how long each ran — and separates it from the parts of a concert that are not
the composition: alapana, kalpana svara, neraval, tani avartana. In a ragamalika
the label also names the ragam each section is set in ("Caraṇam sahānā"), which
is kept.

**This is structure, not notation, and stops deliberately short of decoding
svaras from the audio.** The engine's measured svara accuracy is 67% with a
correct tonic, with a voicing false-alarm rate around 50%. That is a reasonable
starting point for the app's own recording flow, where the next step is *Fix
mistakes* — and quite wrong for a library entry someone reads as the notation of
a kriti. A third of the svaras would be incorrect with nothing marking which
third.

Note the flags. `--annotations-only` means *no audio*; the F0 contours are still
fetched unless `--no-pitch`, and they are 1.3 GB. `--tracks` defaults to 40, so
`--tracks 0` is needed for the whole annotated set. With `--annotations-only`
the selection widens from the pieces the harness can score — which need a tonic
and a contour — to every piece carrying any manual annotation, which is about a
hundred more.

### SSP — the notation that can complete the Dikshitar entries

```sh
python3 tools/fetch-ssp.py
python3 tools/build-ssp.py --selftest tools/data/ssp/ssp_cakram1-4.pdf
```

Subbarama Dikshitar's *Sangita Sampradaya Pradarsini* (1904, public domain) is
the only open source of complete kriti notation: 229 Muttusvami Dikshitar
kirtanas plus gitas, tanas and sancaris for all 72 melas. The English web
edition is typeset TeX with a real text layer, which makes machine extraction
possible; its typesetting is © Guruguhanugraha Archives, so the volumes are
fetched, never committed, and what the extractor takes is the public-domain
notation content.

The extraction core is verified (`lib/cff.py`, `lib/ssp_text.py`,
`lib/ssp_grid.py`): every font's encoding read from the PDF itself, every
glyph at its true position, every duration rule captured; the notation scheme
comes from the book's own page iii, and `--selftest` checks the tala
arithmetic of the first gita — tisra-laghu triputa, every full avartana
measuring exactly 7 aksharas.

The assembler reads real kirtanas correctly some of the time. `--audit` is the
number that decides whether anything loads:

```sh
python3 tools/build-ssp.py --audit     # 2 of 147 kirtanas clean end to end
```

The first Dikshitar kirtana in the book parses exactly right — `S . R G M |
P D N Ṡ | Ṡ N D P M G R` under *śrī nāthādi | guruguhō | jayati jayati*,
segments 8 | 4 | 4, which is 2-kalai adi tala — so the model is sound; it is
robustness across the other 145 that is missing. Per-segment agreement is 56%,
and that is the misleading figure: a kriti only loads when every avartana in
it verifies, and by that gate the yield is 1%. Nothing from SSP is in the
database, and nothing will be until that number is respectable.
Two buckets no pipeline can serve, for the record: Tyagaraja has no SSP — the
Walajapet manuscripts are scans without a text layer — and the Saraga phrase
rows are ragam motifs, not truncated compositions.

### Ragam identification sits at 12% top-1, and it is not the name matching

Measured on 33 Sanidha records with a trustworthy reference. Two things were
wrong and one was fixed:

**Name matching (fixed).** `metrics.ragamRank` returned the *first* candidate
within its edit-distance budget rather than the *closest*, which matched
"Kamavardhini" to Ragavardhini at distance 2 while Kamavardhani sat at
distance 1 further down the table — a different melakarta, so every svara
after it was decoded against the wrong scale. It now takes the best match, and
carries an alias table for names no amount of folding connects: Thodi is
Hanumatodi, Pantuvarali is Kamavardhani (mela 51 — Subhapantuvarali is mela 45
and a different ragam). This lifted svara accuracy 77.0% → 79.3% and cut the
tonic residual 10.5 → 7.6 cents. It did **not** move ragam top-1.

**The identifier itself (open).** `ragamMatches` scores cosine similarity
between a 12-dim pitch-class histogram and a binary svara template. Its top-1
shares the true ragam's svara set only 12% of the time, and its guesses skew
pentatonic — Shuddha Saveri, Abhogi, Valaji, Amritavarshini and Hamsadhwani
between them take most of the list, because the sqrt(n) divisor grows faster
than a lightly-used svara adds.

That bias is real but it is **not** the binding constraint: replacing the score
with a two-sided one (explained weight against svara presence, harmonic mean)
measured *worse* at every threshold tried — 9.1% top-1 at best, against 12.1%
for plain cosine — so it was reverted rather than shipped.

The real limits look structural. A pitch histogram cannot separate ragams that
share a svara set and differ by phrase and gamaka — Begada, Surati and
Kedaragowla are all Harikambhoji janyas with the same notes — and 60 seconds
of one concert item is thin evidence. Six of the corpus ragams are simply
absent from the engine's 115: Nayaki, Brindavani, Brindavana Saranga,
Malayamarutam, Jonpuri and Varamu. Ragamalika is correctly unmatched, being a
garland rather than a ragam.

Cheapest real progress, in order: import the missing ragams from the 939-row
`ragams` table; restrict candidates to those plausible for the composer or
form; and only then attempt phrase-level matching, which is where the
published work on automatic raga recognition actually lives.
