// Sadhana: practising a written composition against your own voice.
//
// The practice loop needs a microphone and a clock, neither of which exists
// here, so the parts that can be tested are the ones that decide what is
// right: turning a notation into timed pitch targets, resolving the bare
// letters SSP prints against the piece's ragam, and judging a set of measured
// deviations. Those are also the parts where a mistake is silent -- a target
// built at the wrong cents would simply mark a correct singer wrong.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const shim = require('./lib/canvas-shim');

let pass = 0, fail = 0;
const chk = (n, c, x = '') => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  ' + x));
  c ? pass++ : fail++;
};

// A stand-in library. supaFetch hands back the Response object, not the parsed
// body -- getting that contract wrong is what made every load in this view fail
// with "could not reach the library" while the library was perfectly fine, so
// the stub mimics fetch exactly rather than resolving to an array.
const STUB_ROWS = [{
  id: '1', title: 'Ninnukori', composer: 'Srinivasa Iyengar', ragam: 'Mohanam',
  tala: 'Adi', form: 'Varnam', completeness: 'complete',
  versions: [{ id: 'v', created_at: '2026-01-01', notation: { gridFactor: 1, sections: [
    { name: 'Pallavi', svaras: [{s:'S',o:0,d:1},{s:'R2',o:0,d:1},{s:'G3',o:0,d:1},{s:'P',o:0,d:1}] },
    { name: 'Anupallavi', svaras: [{s:'D2',o:0,d:1},{s:'S',o:1,d:1}] }] } }]
}, {
  id: '2', title: 'Metadata Only', composer: 'x', ragam: 'Kalyani', tala: 'Adi',
  form: 'Kriti', completeness: 'pallavi', versions: [{ id: 'w', created_at: '2026-01-01', notation: null }]
}];

function boot() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://x.test/',
    beforeParse(w) {
      shim.install(w);
      w.Element.prototype.scrollIntoView = function () {};
      w.__queries = [];
      w.fetch = async (u) => { w.__queries.push(String(u));
        return { ok: true, status: 200, json: async () => STUB_ROWS }; };
    } });
  return new Promise(r => setTimeout(() => r({ w: dom.window, d: dom.window.document }), 350));
}

const note = (s, o, d) => ({ s: s, o: o || 0, d: d || 1 });

(async () => {
  const r = await boot();
  const SD = r.w.SwaraDebug.sadhana;
  chk('the practice internals are reachable for testing', !!SD && !!SD.build);

  console.log('--- the third view ---');
  r.d.querySelector('#navSadhana').click();
  chk('a Sadhana tab exists and opens its view',
      !r.d.querySelector('#sadhanaView').classList.contains('hide'));
  chk('opening it hides Scribe', r.d.querySelector('#scribeView').classList.contains('hide'));
  chk('opening it hides the Library', r.d.querySelector('#browseSection').classList.contains('hide'));
  chk('the reading dock is hidden — it belongs to Scribe',
      r.d.querySelector('#dock').classList.contains('hide'));
  r.d.querySelector('#navScribe').click();
  chk('going back to Scribe restores it',
      !r.d.querySelector('#scribeView').classList.contains('hide') &&
      r.d.querySelector('#sadhanaView').classList.contains('hide'));
  r.d.querySelector('#navSadhana').click();

  console.log('--- the picker: the library\u2019s own filters, narrowed to what can be sung ---');
  await new Promise(z => setTimeout(z, 120));
  {
    ['sadQuery','sadRagam','sadComposer','sadForm','sadState'].forEach(id =>
      chk('the picker offers the ' + id.replace('sad','').toLowerCase() + ' filter',
          !!r.d.querySelector('#' + id)));
    chk('the ragam list is populated from the engine',
        r.d.querySelectorAll('#sadRagam option').length > 100,
        r.d.querySelectorAll('#sadRagam option').length);
    chk('Chromatic is not offered as a practice ragam',
        ![...r.d.querySelectorAll('#sadRagam option')].some(o => /Chromatic/.test(o.textContent)));

    const q = r.w.__queries.join(' ');
    chk('the query asks the server for notated rows, not the whole catalogue',
        /completeness=neq\.none/.test(q), q.slice(0, 160));
    chk('the response is read as a Response, so a working library is not reported broken',
        r.d.querySelector('#sadEmpty').classList.contains('hide'));

    const items = r.d.querySelectorAll('#sadList .sad-item');
    chk('a piece with written svaras is listed', items.length === 1, items.length);
    chk('a metadata-only row is not offered for practice',
        !/Metadata Only/.test(r.d.querySelector('#sadList').textContent));
    chk('the card states ragam, tala and how much there is to sing',
        /Mohanam/.test(items[0].textContent) && /Adi/.test(items[0].textContent) &&
        /6 svaras/.test(items[0].textContent), items[0].textContent);
    chk('the card counts the sections when there is more than one',
        /2 sections/.test(items[0].textContent));

    items[0].click();
    chk('choosing it offers the whole piece and each section',
        [...r.d.querySelectorAll('#sadSection option')].map(o => o.value).join(',') ===
        '*,Pallavi,Anupallavi',
        [...r.d.querySelectorAll('#sadSection option')].map(o => o.value).join(','));
    chk('and builds a target per written svara', SD.state.targets.length === 6);

    // Changing a filter re-queries rather than filtering a stale list.
    const before = r.w.__queries.length;
    r.d.querySelector('#sadRagam').value = 'Kalyani';
    r.d.querySelector('#sadRagam').dispatchEvent(new r.w.Event('change'));
    chk('changing a filter goes back to the server', r.w.__queries.length > before);
    chk('the filter reaches the query',
        /ragam=eq\.Kalyani/.test(r.w.__queries[r.w.__queries.length-1]));
  }

  console.log('--- bare letters resolve through the ragam, spelled ones stand ---');
  const E = require('../engine.js');
  const shankara = E.RAGAMS.find(x => x.name === 'Shankarabharanam');
  const todi = E.RAGAMS.find(x => x.name === 'Hanumatodi');
  chk('S is the tonic in any ragam', SD.pos('S', shankara) === 0 && SD.pos('S', todi) === 0);
  chk('P is the fifth in any ragam', SD.pos('P', shankara) === 7);
  chk('bare G in Shankarabharanam is G3 (antara)', SD.pos('G', shankara) === 4);
  chk('bare G in Todi is G2 (sadharana)', SD.pos('G', todi) === 3, SD.pos('G', todi));
  chk('bare R in Todi is R1 (suddha)', SD.pos('R', todi) === 1, SD.pos('R', todi));
  chk('a spelled svara wins over the ragam default', SD.pos('R2', todi) === 2, SD.pos('R2', todi));
  chk('a comma is not a target', SD.pos(',', shankara) === null);
  chk('rubbish is not a target', SD.pos('zz', shankara) === null);

  console.log('--- a notation becomes timed targets ---');
  const notation = { tala: 'Adi', gridFactor: 1, sections: [
    { name: 'Pallavi', svaras: [note('S'), note('R2'), note('G3'), note('M1'),
                                note('P'), note('D2'), note('N3'), note('S', 1)] }] };
  SD.choose({ k: { id: 'x', title: 'Test', ragam: 'Shankarabharanam', tala: 'Adi' },
              v: {}, n: notation, count: 8 }, null);
  const SAD = SD.state;
  chk('the piece’s own ragam is used, not the Scribe one',
      SAD.ragam.name === 'Shankarabharanam', SAD.ragam.name);
  chk('one target per written svara', SAD.targets.length === 8, SAD.targets.length);
  const cents = SAD.targets.map(t => Math.round(t.cents));
  chk('the arohana lands on the right cents',
      JSON.stringify(cents) === JSON.stringify([0,200,400,500,700,900,1100,1200]), cents.join(','));
  chk('the upper Sa is an octave above the lower', cents[7] - cents[0] === 1200);
  chk('targets are laid end to end with no gap',
      SAD.targets.every((t, i) => i === 0 || Math.abs(t.start - SAD.targets[i-1].end) < 1e-9));
  chk('at 60 beats a minute, eight aksharas last eight seconds',
      Math.abs(SAD.total - 8) < 1e-6, SAD.total);
  chk('the target under a moment is the one being sung then',
      SD.targetAt(2.5).label === 'G3' && SD.targetAt(7.5).label === 'S');
  chk('nothing is playing before the start or after the end',
      SD.targetAt(-1) === null && SD.targetAt(99) === null);

  console.log('--- tempo and held notes change the clock, not the notes ---');
  // 90 is a real option; setting a value the select does not offer would
  // silently leave the old tempo in place and quietly pass.
  r.d.querySelector('#sadTempo').value = '90';
  chk('the tempo actually took (a value off the list would not)',
      r.d.querySelector('#sadTempo').value === '90');
  r.d.querySelector('#sadTempo').dispatchEvent(new r.w.Event('change'));
  chk('a faster tempo shortens the piece proportionally',
      Math.abs(SD.state.total - 8 * 60 / 90) < 1e-6, SD.state.total);
  chk('a faster tempo leaves the pitches alone',
      Math.round(SD.state.targets[2].cents) === 400);
  r.d.querySelector('#sadTempo').value = '60';
  r.d.querySelector('#sadTempo').dispatchEvent(new r.w.Event('change'));
  const held = { gridFactor: 2, sections: [{ name: 'x', svaras: [note('S', 0, 4), note('P', 0, 2)] }] };
  SD.choose({ k: { title: 'Held', ragam: 'Shankarabharanam' }, v: {}, n: held, count: 2 }, null);
  chk('a note held four half-aksharas lasts two beats',
      Math.abs(SD.state.targets[0].end - 2) < 1e-6, SD.state.targets[0].end);
  chk('the grid factor divides, so the piece totals three beats',
      Math.abs(SD.state.total - 3) < 1e-6, SD.state.total);

  console.log('--- the stage draws itself ---');
  SD.choose({ k: { title: 'Test', ragam: 'Shankarabharanam' }, v: {}, n: notation, count: 8 }, null);
  {
    const g = r.d.querySelector('#sadCanvas').getContext('2d');
    const ops = {};
    g.calls.forEach(c => { ops[c[0]] = (ops[c[0]] || 0) + 1; });
    chk('the stage is painted when a piece is chosen', g.calls.length > 20, g.calls.length);
    chk('the panel is cleared and filled before drawing', ops.clearRect >= 1 && ops.fillRect >= 1);
    chk('svarasthana lanes are ruled across it', (ops.stroke || 0) >= 5, ops.stroke);
    chk('the written notes are drawn as filled bars', (ops.fill || 0) >= 3, ops.fill);
    const texts = g.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
    chk('lanes and notes are labelled', texts.length >= 8, texts.length);
    chk('the labels are svara names', texts.every(t => /^[SRGMPDN]/.test(t)), texts.join(' '));
  }

  console.log('--- judging what was sung ---');
  chk('dead on is a hit', SD.judge({ samples: [2, -3, 1, 0, 4] }) === 'hit');
  chk('40 cents out is still a hit (the edge)', SD.judge({ samples: [38, 40, 39, 40, 38] }) === 'hit');
  chk('60 cents out is near', SD.judge({ samples: [58, 60, 61, 59, 60] }) === 'near');
  chk('a semitone out is a miss', SD.judge({ samples: [100, 102, 98, 101, 99] }) === 'miss');
  chk('flat is judged like sharp', SD.judge({ samples: [-100, -102, -98, -101, -99] }) === 'miss');
  chk('silence is not a miss, it is nothing', SD.judge({ samples: [] }) === 'none');
  chk('one stray frame is not enough to judge on', SD.judge({ samples: [0, 1] }) === 'none');
  chk('the median ignores a single wild frame',
      SD.judge({ samples: [5, 3, 900, 4, 6] }) === 'hit');

  console.log('--- the report ---');
  SD.choose({ k: { title: 'Test', ragam: 'Shankarabharanam' }, v: {}, n: notation, count: 8 }, null);
  const T = SD.state.targets;
  T.forEach((t, i) => { if (i !== 3) t.samples = [8, 6, 9, 7, 8]; });   // one silent
  T[5].samples = [60, 61, 59, 60, 62];                                  // one near
  T[6].samples = [130, 128, 131, 129, 130];                             // one miss
  T.forEach(t => { t.judged = SD.judge(t); });
  SD.results();
  chk('the results panel is shown', !r.d.querySelector('#sadResult').classList.contains('hide'));
  const cards = [...r.d.querySelectorAll('#sadScoreRow div b')].map(b => b.textContent);
  chk('four figures are reported', cards.length === 4, cards.join('|'));
  chk('the held percentage counts only clean hits', cards[0] === '63%', cards[0]);
  chk('the silent svara is counted and shown', cards[3] === '1', cards[3]);
  chk('a bad figure is coloured as a warning, not as good news',
      [...r.d.querySelectorAll('#sadScoreRow div b')][3].style.color.indexOf('accent') !== -1);
  const cells = [...r.d.querySelectorAll('#sadNoteMap i')];
  chk('every written svara gets a cell', cells.length === 8, cells.length);
  chk('the cells carry the judgement as a class',
      cells[0].className === 'hit' && cells[3].className === 'none' &&
      cells[5].className === 'near' && cells[6].className === 'miss',
      cells.map(c => c.className).join(','));
  chk('a missed cell says how far off it was', /cents (sharp|flat)/.test(cells[6].title), cells[6].title);
  chk('a silent cell says nothing was sung', /nothing sung/.test(cells[3].title));
  chk('the verdict names the sruthi when the singer leans hard',
      /sharp|flat|sruthi|Sa/.test(r.d.querySelector('#sadVerdict').textContent));

  console.log('--- a piece with no usable notation cannot be practised ---');
  SD.choose({ k: { title: 'Empty', ragam: 'Kalyani' }, v: {},
              n: { sections: [{ name: 'x', svaras: [{ s: ',', o: 0, d: 1 }] }] }, count: 0 }, null);
  chk('a section of only rests yields no targets', SD.state.targets.length === 0);
  chk('and no crash', true);

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
