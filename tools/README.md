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

The assembler is the open problem, and `--audit` measures it: **169 of 389
sections verify, 25 of 146 kirtanas end to end** — up from 22 and 2.

The two fixes that mattered both came from *looking at the page*.
`lib/pdfpage.py` cuts one page out of the volume into a standalone PDF (macOS
`sips` and `qlmanage` render only page 1 of a document), and a narrow
`/MediaBox` crops to a band, which is how you zoom in on a single column:

```sh
python3 tools/lib/pdfpage.py tools/data/ssp/ssp_cakram1-4.pdf 60 /tmp/p.pdf 180 612 420 648
qlmanage -t -s 2600 -o /tmp /tmp/p.pdf
```

**Grace notes.** SSP sets ornamental svaras smaller and in italic. They are
sung, but they belong to the akshara of the note they lean on, and counting
them as full notes is why avartanas came out one or two aksharas long. A
drutam printed `M / p m g` reads 5 until you notice the `m` is
`URWPalladioL-Italic` at 9pt among Roman 10pt — then it is 4 and the row is
8|4|4. Sections 32 → 63.

**Row clustering.** A svara band is up to ~9pt tall (accents above, dropped
sub-baselines below) while the gap down to its sahitya is 8–10pt. Grouping by
distance from the row's *top edge* cut tall bands in half and split one
printed row into two. Chaining to the previous glyph splits only at real gaps:
63 → 107. It also explains why sweeping that threshold had looked random —
63/9/37/86 under the old rule against 102/107/99/93 under the new one.

Four smaller fixes took it 22 → 32 first: a jati-aware tala model
(`lib/tala.py` — khanda-jati triputa is 5+2+2 and had been landing on ata), an
implicit danda at line breaks, a guard keeping CM* gamaka glyphs off the
svaras, and centre-based underline overlap.

Three more fixes after those. Dandas mark anga boundaries but may also
subdivide them — SSP prints 3|4 inside a misra laghu of 7, where it is
clapped — so the test is containment (every anga boundary falls on a danda)
rather than equality. Piece headers are read from their em-dash fields
instead of pattern-matched, because an unrecognised kind used to leave the
previous kirtana in force: eleven consecutive rows of a misra-jati-eka
svarajati were read as adi and "missed by 2" while being perfectly correct.
And `tala.anga` now strips the trailing word "tala" before matching, since
"ekatala" contains "ata" and a laghu of 3 was being read as 3+3+2+2.

Tried and reverted: treating an underline as stating the value outright
rather than halving what the case implied. One row argued for it; the corpus
did not (107 -> 43 sections, 0 kirtanas).

`--scan` reports where the remaining failures are, by tala family and by
page, and its answer has changed character. There are now **no pages where
four or more rows of one kirtana miss by the same amount** — every systematic,
whole-piece failure found so far has been fixed. 71% of rows total a whole
number of avartanas; what is left is scattered, ±1 akshara on 13% of rows and
±0.5 on 6%, which is per-row noise rather than another rule waiting to be
found.

By row totals: rupaka 79%, eka 69%, adi 63%, jhampa 59%, dhruva 37%.

Eka tala looked like it needed its own model, since a single anga means its
dandas cannot be marking anga boundaries. Surveying what eka rows actually
contain says otherwise: tisra runs [6,6,6] (a laghu of 3 at 2 kalai), chatusra
[4,4,4,4], khanda [10,10], misra [7,7] and also [3,4,3,4] where the laghu of 7
is clapped 3+4 — all of which the containment test already accepts. At section
level eka verifies at 42%, ahead of adi (29%) and rupaka (25%), so it is the
healthiest of the big families rather than the broken one. The [8,4,4] pallavi
that prompted the question occurs 11 times against [6,6,6]'s 59; that one
piece is an outlier, not the rule.

What the survey did turn up is the eduppu: rows opening [1,4,4,4] or [2,7,7],
a fragment then whole avartanas. A section may begin part-way into the cycle,
so the containment test now allows a shifted grid — with the offset pinned to
the length of that opening fragment rather than free. Sections 118 -> 123.

SSP is not consistent about where it prints dandas, and pretending otherwise
was costing more than it was worth. A misra laghu of 7 prints 3|4, subdividing
an anga; dhruva prints 6|4|4, merging its laghu and drutam and omitting a
boundary; khanda capu prints 10|10|10|10, one danda per avartana at two kalai
with its 2+3 split never shown. No containment rule holds in both directions,
so the gate is now duration — does the section last a whole number of
avartanas — which is also what loading actually needs, since bar positions can
be re-derived from the tala. Whether the dandas also land on anga boundaries
is reported beside it and nothing depends on it: 125 of the 177.

Spot-checking a verified kriti against its printed page found the failure
mode that matters most: a section can verify while *missing rows*. On page 77
the second pallavi line had merged with its sahitya into one row, which then
read as prose, failed `is_svara_line` and was dropped silently — leaving a
one-line pallavi that happened to total a whole avartana. Two things caused
the merge, and both are fixed: mandra sthayi is a real period glyph set below
the svara, which stretches the band down towards the sahitya, so it is folded
into its svara before clustering; and rows are now chained over content only
(text and dandas), because a repeat-sign colon sitting 4.5pt below a band was
enough to bridge it into the line beneath. Both pallavi lines now read
10|4|4 = two avartanas of khanda-jati triputa, matching the page.

That fix *lowered* the section count from 177 to 169, because sections that
were passing on incomplete data now carry all their rows. 169 is the
trustworthy number.

`--audit` now reports the completeness check itself, so this cannot regress
quietly: it counts kirtanas holding a grid lyric row with no notation row
above it. 28 of 146 do, and spot-checking says they are almost all extra
caranams printed as words only, which SSP does routinely — but a dropped
notation line looks exactly the same from here, which is the point of
reporting it. Finding it also turned up a plain bug: dandas were matched by
character, so the letters j and k in any lyric or title counted as bar lines.
They have to come from the symbol font.

By family, verified / strict: eka 58%, triputa 63%, mathya 60%, adi 40% (140
sections), rupaka 40% (89), jhampa 30%, capu 100%, dhruva 0% (3 sections,
durations genuinely wrong).

What is left is per-glyph and fractional: 212 rows total a half or a quarter
akshara off, and each is its own small forensic case. One examined closely: a
rupaka row reads 2|4.5|2|4 because a printed underline ends at x=199.28 while
the next note begins at 200.58, so that note sits 1.3pt outside its group and
is read at full value. The vertical band used to find underlines was swept
from 0.70 to 1.15 of the font size and the score does not move at all, so the
remaining errors are not a threshold that wants tuning.

**Loaded, 2026-08-04.** The 25 that verify are in the library:

```sh
python3 tools/build-ssp.py --emit tools/data/ssp.json
python3 tools/load-ssp.py tools/data/ssp.json > tools/data/ssp.sql
```

62 sections, 4,695 svaras, every one carrying its sahitya syllable, and every
row citing the volume's own printed page. 12 attached to kirtanas the library
already listed from the Wikipedia catalogue — title and ragam agreeing
independently, which is the cross-check — and 13 came in as new rows. The
library went from **16 complete to 27**, and 70 partial to 84.

Svaras are stored as the book prints them: bare letters, with the variant left
to the ragam, because resolving it is unambiguous for most ragams and a guess
for a bhashanga raga using two variants of one letter.

The 13 new rows are titled by their pallavi opening as SSP sets it, syllable
by syllable and without word breaks — `Jñānambikēpalayaamaṁ` rather than
*Jñānāmbike Pālaya* — because the book prints no titles. They are searchable
and ugly; giving them their catalogue names is manual work, not extraction. The next targets are visible on the same reference page, where one
row reads 8|4.5|4 — an underline miscount in madhyamakala. Note also that
`load_pages` skips text-free pages, so its indices are not the volume's
printed page numbers, which matters once rows carry provenance.

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
