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

// A fake audio stack: a clock we advance by hand, an analyser that emits a
// steady tone we choose, and a microphone that always says yes. Without this
// the practice loop was never executed by any test -- which is how a call to a
// function that no longer existed in the engine shipped, dying on the first
// animation frame while every other check stayed green.
function fakeAudio(w, ctl) {
  const node = () => ({ connect(){}, disconnect(){}, start(){}, stop(){},
    gain: { value: 0, setValueAtTime(){}, exponentialRampToValueAtTime(){},
            linearRampToValueAtTime(){}, setTargetAtTime(){} },
    frequency: { value: 0 }, type: '' });
  w.AudioContext = function () {
    return { state: 'running', resume(){}, destination: {}, sampleRate: 48000,
      get currentTime() { return ctl.clock; },
      createGain: node, createBiquadFilter: () => Object.assign(node(), { frequency: { value: 0 } }),
      createOscillator: node, createMediaStreamSource: node,
      createBufferSource: () => { const n = node(); n.buffer = null; n.onended = null;
        n.start = function () { ctl.playing = true; }; n.stop = function () { ctl.playing = false; };
        return n; },
      decodeAudioData: async () => ({ duration: 6, length: 1, sampleRate: 48000 }),
      createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{ kind: 'audio' }] } }),
      createAnalyser: () => ({ fftSize: 4096, connect(){},
        getFloatTimeDomainData(b) {
          for (let i = 0; i < b.length; i++)
            b[i] = 0.4 * (Math.sin(2*Math.PI*ctl.hz*i/48000) +
                          0.3 * Math.sin(4*Math.PI*ctl.hz*i/48000));
        } }) };
  };
  w.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop(){} }] }) };
  // A recorder that produces one chunk, and a Blob whose arrayBuffer resolves,
  // so the replay path can be driven without real media.
  w.MediaRecorder = function (stream, opts) {
    const self = this;
    self.state = 'inactive';
    self.mimeType = (opts && opts.mimeType) || 'audio/webm';
    self.stream = stream;
    self.start = function () { self.state = 'recording';
      setTimeout(() => self.ondataavailable && self.ondataavailable({ data: { size: 128 } }), 5); };
    self.stop = function () { self.state = 'inactive';
      setTimeout(() => self.onstop && self.onstop(), 5); };
  };
  w.MediaRecorder.isTypeSupported = (t) => /webm/.test(t);
  // Canvas capture and a download target, so the film path can run to a file.
  w.HTMLCanvasElement.prototype.captureStream = function () {
    return { getTracks: () => [], addTrack(t) { (this._t = this._t || []).push(t); } };
  };
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};
  ctl.downloads = [];
  const realClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () {
    if (this.download) { ctl.downloads.push(this.download); return; }
    return realClick.apply(this, arguments);
  };
}

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
    // Two kinds of label now: svara names on lanes and bars, and the avartana
    // number at each cycle boundary of the tala grid.
    chk('the labels are svara names or avartana numbers',
        texts.every(t => /^[SRGMPDN]/.test(t) || /^\u2016 \d+$/.test(t)), texts.join(' '));
    chk('the tala grid numbers each avartana', texts.some(t => /^\u2016 \d+$/.test(t)));
  }

  console.log('--- sruthi, talam, jathi and nadai are set here too ---');
  {
    chk('the view offers its own sruthi, talam, jathi and nadai',
        ['sadNote','sadOct','sadHz','sadTala','sadJathi','sadSpeed']
          .every(id => !!r.d.querySelector('#' + id)));
    chk('talam and jathi come from what the library records for the piece',
        r.d.querySelector('#sadTala').value === 'Triputa' &&
        r.d.querySelector('#sadJathi').value === 'Chaturasra',
        r.d.querySelector('#sadTala').value + '/' + r.d.querySelector('#sadJathi').value);
    chk('so the stage knows the cycle it is ruling',
        SD.state.avartana === 8 && JSON.stringify(SD.state.angas) === '[4,6,8]',
        SD.state.avartana + ' ' + JSON.stringify(SD.state.angas));

    const before = SD.state.total;
    r.d.querySelector('#sadSpeed').value = '2';
    r.d.querySelector('#sadSpeed').dispatchEvent(new r.w.Event('change'));
    chk('2x nadai halves the piece', Math.abs(SD.state.total - before/2) < 1e-6, SD.state.total);
    chk('but the beat itself does not move — the cycle stays where it is counted',
        Math.abs(SD.state.beat - 1) < 1e-6 && SD.state.avartana === 8, SD.state.beat);
    chk('the summary states the nadai and svaras per avartanam',
        /2x nadai, 16 svaras per avartanam/.test(r.d.querySelector('#sadSruthi').textContent),
        r.d.querySelector('#sadSruthi').textContent);
    r.d.querySelector('#sadSpeed').value = '1';
    r.d.querySelector('#sadSpeed').dispatchEvent(new r.w.Event('change'));

    r.d.querySelector('#sadTala').value = 'Rupaka';
    r.d.querySelector('#sadTala').dispatchEvent(new r.w.Event('change'));
    chk('changing the talam re-rules the grid',
        SD.state.avartana === 6 && JSON.stringify(SD.state.angas) === '[2,6]',
        SD.state.avartana + ' ' + JSON.stringify(SD.state.angas));

    // The sruthi here is the app's sruthi, not a second one.
    r.d.querySelector('#sadHz').value = '196.00';
    r.d.querySelector('#sadHz').dispatchEvent(new r.w.Event('change'));
    chk('setting Sa here sets it in Scribe too',
        Math.round(parseFloat(r.d.querySelector('#hzIn').value)) === 196,
        r.d.querySelector('#hzIn').value);
    chk('and the header chip follows', /196/.test(r.d.querySelector('#chipText').textContent));
    chk('targets stay at the same cents — Sa moved, the intervals did not',
        Math.round(SD.state.targets[0].cents) === 0);
  }

  console.log('--- the trace is cleaned before it is drawn or scored ---');
  {
    const st = () => { SD.state.recent = []; SD.state.folds = 0; };

    st();
    const steady = [];
    for (let i = 0; i < 30; i++) steady.push(SD.stabilise(400 + Math.sin(i*1.7)*6));
    const spread = Math.max(...steady) - Math.min(...steady);
    chk('frame jitter on a held note is flattened', spread < 12, spread.toFixed(1) + ' cents');

    st();
    const withOct = [];
    for (let i = 0; i < 30; i++) {
      let c = 400 + Math.sin(i*1.7)*6;
      if (i === 12 || i === 13) c += 1200;      // YIN locks onto a harmonic
      if (i === 22) c -= 1200;                  // and onto a subharmonic
      withOct.push(SD.stabilise(c));
    }
    const octSpread = Math.max(...withOct) - Math.min(...withOct);
    chk('an octave artefact is folded back, not drawn as a leap',
        octSpread < 20, octSpread.toFixed(1) + ' cents');
    chk('and the note it belonged to is still where it was sung',
        Math.abs(withOct[14] - 400) < 20, withOct[14].toFixed(1));

    // A real move must survive: only whole octaves are folded.
    st();
    for (let i = 0; i < 6; i++) SD.stabilise(0);
    let moved = 0;
    for (let i = 0; i < 6; i++) moved = SD.stabilise(700);   // Sa up to Pa
    chk('a real leap of a fifth is kept — it is singing, not an artefact',
        Math.abs(moved - 700) < 20, moved.toFixed(1));

    st();
    for (let i = 0; i < 6; i++) SD.stabilise(0);
    let up = 0;
    for (let i = 0; i < 6; i++) up = SD.stabilise(1200);     // Sa to upper Sa
    chk('an octave the singer actually sang is NOT folded away once settled',
        Math.abs(up - 1200) < 20, up.toFixed(1));

    chk('the median ignores an outlier rather than averaging it in',
        SD.median([1, 2, 3, 4, 1000]) === 3, SD.median([1,2,3,4,1000]));
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

  console.log('--- the practice loop actually runs ---');
  {
    const ctl = { clock: 0, hz: 146.83 };
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
      url: 'https://x.test/',
      beforeParse(w) {
        shim.install(w);
        w.Element.prototype.scrollIntoView = function () {};
        w.fetch = async () => ({ ok: true, status: 200, json: async () => STUB_ROWS });
        fakeAudio(w, ctl);
      } });
    const L = await new Promise(z => setTimeout(() => z({ w: dom.window, d: dom.window.document }), 350));
    const LS = L.w.SwaraDebug.sadhana;
    L.d.querySelector('#navSadhana').click();
    await new Promise(z => setTimeout(z, 140));
    L.d.querySelector('#sadList .sad-item').click();
    L.d.querySelector('#sadGo').click();
    await new Promise(z => setTimeout(z, 140));

    chk('starting puts the loop into the running state', LS.state.running === true);
    chk('and the button offers to stop', /Singing/.test(L.d.querySelector('#sadGo').textContent),
        L.d.querySelector('#sadGo').textContent);

    const clockBefore = L.d.querySelector('#sadClock').textContent;
    // Advance the audio clock by hand, singing Sa then R1 (100 cents up).
    for (let i = 0; i < 18; i++) {
      ctl.clock += 0.25;
      if (i === 7) ctl.hz = 146.83 * Math.pow(2, 100 / 1200);
      await new Promise(z => setTimeout(z, 26));
    }

    chk('the transport clock advances — the stage is not frozen',
        L.d.querySelector('#sadClock').textContent !== clockBefore,
        clockBefore + ' -> ' + L.d.querySelector('#sadClock').textContent);
    chk('the singer\u2019s pitch is recorded frame by frame', LS.state.trace.length > 5,
        LS.state.trace.length);
    chk('the trace carries a deviation against the target it belongs to',
        LS.state.trace.some(pt => pt.dev != null));
    chk('the readout says how far off the voice is, in svaras',
        /svara|hair|on the note/.test(L.d.querySelector('#sadCents').textContent),
        L.d.querySelector('#sadCents').textContent);
    chk('the svara being sung is named as it passes',
        L.d.querySelector('#sadNow').textContent !== '\u2014',
        L.d.querySelector('#sadNow').textContent);

    const judged = LS.state.targets.filter(t => t.judged);
    chk('notes are judged the moment they are behind the singer', judged.length >= 2, judged.length);
    chk('a svara sung on pitch is a hit', LS.state.targets[0].judged === 'hit',
        LS.state.targets[0].judged);
    // When the voice moves, the trace follows it. Asserting WHICH target the
    // move lands in would be a bet on how setTimeout and requestAnimationFrame
    // interleave, which is not a property of the app.
    const near = LS.state.trace.filter(pt => Math.abs(pt.cents) < 40).length;
    const up = LS.state.trace.filter(pt => Math.abs(pt.cents - 100) < 40).length;
    chk('the trace follows the voice down at Sa', near > 0, near);
    chk('and up a semitone when the singer moves', up > 0, up);
    chk('judging discriminates — not everything is a hit',
        LS.state.targets.some(t => t.judged === 'hit') &&
        LS.state.targets.some(t => t.judged && t.judged !== 'hit'),
        LS.state.targets.map(t => t.judged).join(','));
    chk('a running score is shown while singing',
        /%/.test(L.d.querySelector('#sadPct').textContent),
        L.d.querySelector('#sadPct').textContent);

    // The pitch step must fit an animation frame, or it stalls the loop it drives.
    const E2 = require('../engine.js');
    const buf = new Float32Array(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = 0.3 * Math.sin(2*Math.PI*147*i/48000);
    const nf = E2.frameCount(buf.length, { window: 1600, hop: 512, sr: 48000, fmin: 70 });
    const t0 = Date.now();
    for (let k = 0; k < 30; k++)
      E2.yinTrack(buf, 48000, { window: 1600, hop: 512, fmin: 70, frameStart: nf-1, frameEnd: nf });
    const per = (Date.now() - t0) / 30;
    chk('one pitch reading costs one frame, not a dozen',
        E2.yinTrack(buf, 48000, { window: 1600, hop: 512, fmin: 70,
                                  frameStart: nf-1, frameEnd: nf }).nFrames === 1);
    chk('and fits inside an animation frame', per < 8, per.toFixed(2) + ' ms');

    LS.state.running = false;   // leave the loop stopped
  }

  console.log('--- replay: watch and hear the take back ---');
  {
    const ctl = { clock: 0, hz: 146.83, playing: false };
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
      url: 'https://x.test/',
      beforeParse(w) {
        shim.install(w);
        w.Element.prototype.scrollIntoView = function () {};
        w.fetch = async () => ({ ok: true, status: 200, json: async () => STUB_ROWS });
        fakeAudio(w, ctl);
        // Blob.arrayBuffer is not implemented in this DOM; replay needs it.
        w.Blob.prototype.arrayBuffer = async function () { return new ArrayBuffer(8); };
      } });
    const L = await new Promise(z => setTimeout(() => z({ w: dom.window, d: dom.window.document }), 350));
    const LS = L.w.SwaraDebug.sadhana;
    L.d.querySelector('#navSadhana').click();
    await new Promise(z => setTimeout(z, 140));
    L.d.querySelector('#sadList .sad-item').click();

    chk('replay is not offered before anything has been sung',
        L.d.querySelector('#sadReplay').classList.contains('hide'));

    L.d.querySelector('#sadGo').click();
    await new Promise(z => setTimeout(z, 140));
    for (let i = 0; i < 10; i++) { ctl.clock += 0.3; await new Promise(z => setTimeout(z, 26)); }
    L.d.querySelector('#sadStop').click();
    await new Promise(z => setTimeout(z, 60));

    chk('the take is kept once the session ends', !!LS.state.take);
    chk('replay is offered on the stage', !L.d.querySelector('#sadReplay').classList.contains('hide'));

    const traceBefore = LS.state.trace.length;
    L.d.querySelector('#sadReplay').click();
    await new Promise(z => setTimeout(z, 90));
    chk('replaying starts the take playing', ctl.playing === true);
    chk('the app knows it is replaying, not recording',
        LS.state.replaying === true && LS.state.running === false);
    chk('the button offers to stop the replay',
        /Stop replay/.test(L.d.querySelector('#sadReplay').textContent),
        L.d.querySelector('#sadReplay').textContent);

    const clockBefore = L.d.querySelector('#sadClock').textContent;
    // Far enough to cross a whole second: replay starts 1.2 s before the first
    // svara, the same lead-in the live stage shows, so a short nudge still
    // reads 0:00 at both ends and proves nothing.
    for (let i = 0; i < 10; i++) { ctl.clock += 0.45; await new Promise(z => setTimeout(z, 26)); }
    chk('the stage scrolls during replay',
        L.d.querySelector('#sadClock').textContent !== clockBefore,
        clockBefore + ' -> ' + L.d.querySelector('#sadClock').textContent);
    chk('and says so, so it cannot be mistaken for a live take',
        /replay/.test(L.d.querySelector('#sadClock').textContent));
    chk('replay does not re-record over the trace it is showing',
        LS.state.trace.length === traceBefore, LS.state.trace.length + ' vs ' + traceBefore);

    L.d.querySelector('#sadReplay').click();
    await new Promise(z => setTimeout(z, 40));
    chk('stopping the replay stops the audio', ctl.playing === false);
    chk('and returns the button to its offer',
        /Replay/.test(L.d.querySelector('#sadReplay').textContent) &&
        !/Stop/.test(L.d.querySelector('#sadReplay').textContent));

    console.log('--- saving the replay as a video ---');
    chk('a video of the take is offered once there is one',
        !L.d.querySelector('#sadFilm').classList.contains('hide'));
    L.d.querySelector('#sadFilm').click();
    await new Promise(z => setTimeout(z, 90));
    chk('filming plays the take so the file has the voice in it', ctl.playing === true);
    chk('the stage is being replayed while it is filmed', LS.state.replaying === true);
    chk('and the app knows it is filming', LS.state.filming === true);
    chk('the button says so and cannot be pressed twice',
        /Recording/.test(L.d.querySelector('#sadFilm').textContent) &&
        L.d.querySelector('#sadFilm').disabled,
        L.d.querySelector('#sadFilm').textContent);
    // Run it to the end of the piece.
    for (let i = 0; i < 14; i++) { ctl.clock += 0.6; await new Promise(z => setTimeout(z, 26)); }
    await new Promise(z => setTimeout(z, 60));
    chk('a file is offered when the replay ends', ctl.downloads.length === 1, ctl.downloads.join());
    chk('named after the composition, not "download"',
        /sadhana\.(webm|mp4)$/.test(ctl.downloads[0] || ''), ctl.downloads[0]);
    chk('and the button returns to its offer',
        /Save video/.test(L.d.querySelector('#sadFilm').textContent) &&
        !L.d.querySelector('#sadFilm').disabled);
    chk('filming ends with the replay', LS.state.filming === false && LS.state.replaying === false);

    // Choosing a different piece must not offer a take that belongs to another.
    LS.prepare();
    chk('re-preparing drops a take that no longer matches the targets',
        !LS.state.take && L.d.querySelector('#sadReplay').classList.contains('hide'));
  }

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
  chk('the held percentage counts only clean hits', /^63%/.test(cards[0]), cards[0]);
  console.log('--- the report speaks svaras, not cents ---');
  {
    const cs = [...r.d.querySelectorAll('#sadScoreRow div')];
    chk('the percentage says how many of how many',
        /\d+ of \d+/.test(cs[0].querySelector('span').textContent),
        cs[0].querySelector('span').textContent);
    chk('the typical miss is given as a share of a svara, not in cents',
        /svara|hair/.test(cs[1].querySelector('b').textContent) &&
        !/¢/.test(cs[1].querySelector('b').textContent),
        cs[1].querySelector('b').textContent);
    chk('the lean is a word a singer uses',
        /^(Flat|Sharp|In tune)$/.test(cs[2].querySelector('b').textContent),
        cs[2].querySelector('b').textContent);
    chk('and says which way, in svaras',
        /(above|below) the written svaras|no consistent lean/
          .test(cs[2].querySelector('span').textContent),
        cs[2].querySelector('span').textContent);
    chk('the cents are still there for anyone who wants them, on hover',
        /cents/.test(cs[1].title) && /cents/.test(cs[2].title),
        cs[1].title + ' / ' + cs[2].title);
    chk('a consistent lean is blamed on the sruthi and given a number to try',
        /Try setting Sa to [\d.]+ Hz/.test(r.d.querySelector('#sadVerdict').textContent),
        r.d.querySelector('#sadVerdict').textContent.slice(-90));
  }

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
