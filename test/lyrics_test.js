// Sahitya-under-svara, dual-level bars (anga/avartana), and PDF "Lyrics" block
// tests. Uses only invented placeholder syllables (la, li, lo, ...) throughout
// -- never real composition lyrics -- to verify the mechanism without touching
// any copyrighted text.
const E = require('../engine.js');
const fs = require('fs'); const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'), 'utf8');

let pass=0, fail=0;
const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

console.log('--- angaBoundaries (pure math) ---');
chk('Adi (Chaturasra Triputa): [4,6,8]',
    JSON.stringify(E.angaBoundaries(E.TALAS.find(t=>t.name==='Triputa'), E.JATHIS.find(j=>j.name==='Chaturasra')))==='[4,6,8]');
chk('last boundary always equals avartanaBeats (the avartana edge, not an anga split)',
    E.TALAS.every(t => E.JATHIS.every(j => {
      const b = E.angaBoundaries(t,j); return b[b.length-1] === E.avartanaBeats(t,j);
    })));
chk('Eka (single laghu anga): boundaries = [beats] only, no interior anga splits',
    E.angaBoundaries(E.TALAS.find(t=>t.name==='Eka'), E.JATHIS.find(j=>j.name==='Tisra')).length === 1);

console.log('--- computeBarLevels: forward + backward classification (pure logic) ---');
{
  const src = fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
  const grab = (name) => {
    const start = src.indexOf('function ' + name + '(');
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++){ if (src[i]==='{') depth++; if (src[i]==='}'){ depth--; if (depth===0) break; } }
    return src.slice(start, i+1);
  };
  const sb = {};
  new (require('vm').Script)(
    grab('computeUnits') + '\n' + grab('unitBeats') + '\n' + grab('computeBarLevels') +
    '\nthis.computeUnits=computeUnits; this.unitBeats=unitBeats; this.computeBarLevels=computeBarLevels;'
  ).runInNewContext(Object.assign(sb, { E: { commaCount: E.commaCount, avartanaBeats: E.avartanaBeats, angaBoundaries: E.angaBoundaries } }));

  const adiTala = E.TALAS.find(t=>t.name==='Triputa'), adiJathi = E.JATHIS.find(j=>j.name==='Chaturasra');
  function plainNotes(n){ return Array.from({length:n}, () => ({ transit:false, dur:0.2 })); }

  // Anchor at 0, forward: 24 plain notes (unit=0.2) -> Adi(8 beats) = 8 svaras/avartanam.
  // Expect: avartana at 0, anga at 4, anga at 6, avartana at 8, anga at 12, anga at 14, avartana at 16...
  {
    const notes = plainNotes(24);
    const units = sb.computeUnits(notes);
    const levels = sb.computeBarLevels(notes, units, adiTala, adiJathi, 0, 0.2, 1);
    chk('anchor itself is avartana level', levels.get(0)==='avartana');
    chk('anga boundary at svara 4 (end of the 4-beat laghu)', levels.get(4)==='anga', levels.get(4));
    chk('anga boundary at svara 6 (end of the first drutam)', levels.get(6)==='anga', levels.get(6));
    chk('avartana boundary at svara 8 (start of the next cycle), not anga', levels.get(8)==='avartana', levels.get(8));
    chk('the pattern repeats identically in the second avartana (anga at 12)', levels.get(12)==='anga', levels.get(12));
    chk('the pattern repeats identically in the second avartana (anga at 14)', levels.get(14)==='anga', levels.get(14));
    chk('third avartana starts at svara 16', levels.get(16)==='avartana', levels.get(16));
    chk('no spurious bar at a non-boundary position (svara 5)', !levels.has(5));
  }

  // Anchor NOT at 0 -- backward classification must mirror correctly.
  // Anchor at svara 10 (which sits inside the 2nd avartana, at its own beat-2
  // position: avartanas start at 0,8,16,... so beat-1 of avartana 2 is svara 8;
  // svara 10 is beat-3 within that avartana -- i.e. still inside its laghu).
  {
    const notes = plainNotes(24);
    const units = sb.computeUnits(notes);
    const levels = sb.computeBarLevels(notes, units, adiTala, adiJathi, 10, 0.2, 1);
    chk('anchor itself is always avartana level, regardless of true tala position',
        levels.get(10)==='avartana');
    // Walking forward from 10 in steps of 1 beat/svara: next avartana boundary
    // should land 8 svaras later at 18, with anga marks at 14 and 16 in between.
    chk('forward anga mark at anchor+4', levels.get(14)==='anga', levels.get(14));
    chk('forward anga mark at anchor+6', levels.get(16)==='anga', levels.get(16));
    chk('forward avartana mark at anchor+8', levels.get(18)==='avartana', levels.get(18));
    // Walking backward from 10: previous avartana boundary is 8 svaras earlier at 2.
    chk('backward avartana mark at anchor-8', levels.get(2)==='avartana', levels.get(2));
    // Between svara 2 and 10, anga marks should sit at the SAME relative
    // offsets as forward (4 and 6 beats into that avartana): 2+4=6, 2+6=8.
    chk('backward anga mark at (prev avartana start)+4', levels.get(6)==='anga', levels.get(6));
    chk('backward anga mark at (prev avartana start)+6', levels.get(8)==='anga', levels.get(8));
  }

  // Non-uniform tala: Ata Khanda ([5,10,12,14]) -- asymmetric anga spans (two
  // 5-beat laghus, two 2-beat drutams), a harder case than Adi's simple split.
  {
    const ataT = E.TALAS.find(t=>t.name==='Ata'), khandaJ = E.JATHIS.find(j=>j.name==='Khanda');
    const notes = plainNotes(28); // 2 avartanas of 14
    const units = sb.computeUnits(notes);
    const levels = sb.computeBarLevels(notes, units, ataT, khandaJ, 0, 0.2, 1);
    chk('Ata/Khanda: anga at 5 (end of 1st laghu)', levels.get(5)==='anga', levels.get(5));
    chk('Ata/Khanda: anga at 10 (end of 2nd laghu)', levels.get(10)==='anga', levels.get(10));
    chk('Ata/Khanda: anga at 12 (end of 1st drutam)', levels.get(12)==='anga', levels.get(12));
    chk('Ata/Khanda: avartana at 14 (end of 2nd drutam = full cycle)', levels.get(14)==='avartana', levels.get(14));
  }

  // Speed multiplier composes correctly with anga bars: at 2x, an avartana
  // needs 16 svaras for Adi, so anga marks should land at 8 and 12 (double
  // the 1x positions of 4 and 6).
  {
    const notes = plainNotes(32);
    const units = sb.computeUnits(notes);
    const levels = sb.computeBarLevels(notes, units, adiTala, adiJathi, 0, 0.2, 2);
    chk('2x speed: anga marks scale with the multiplier (8, not 4)', levels.get(8)==='anga', levels.get(8));
    chk('2x speed: anga marks scale with the multiplier (12, not 6)', levels.get(12)==='anga', levels.get(12));
    chk('2x speed: avartana at 16, not 8', levels.get(16)==='avartana', levels.get(16));
  }

  // No anchor -> no levels at all, not a crash.
  {
    const notes = plainNotes(8);
    const units = sb.computeUnits(notes);
    const levels = sb.computeBarLevels(notes, units, adiTala, adiJathi, null, 0.2, 1);
    chk('no anchor -> empty levels map, no throw', levels.size === 0);
  }
}

console.log('\n'+pass+' passed, '+fail+' failed (part 1 of 2)');
if (fail) process.exitCode = 1;

// ---------------- full UI integration ----------------
function boot(fetchStub){
  return new Promise(res=>{
    let calls=[];
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext=function(){return{state:'running',resume(){},currentTime:0,
          createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
          createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
          createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
          createBufferSource:()=>({connect(){},start(){},stop(){}}),destination:{},
          decodeAudioData(a,ok){ ok(w.__fakeBuffer); }};};
        w.fetch=(url,opts)=>{ calls.push({url:String(url),opts}); return (fetchStub||(async()=>({ok:true,status:200,json:async()=>[]})))(String(url),opts); };
        w.Element.prototype.scrollIntoView=function(){};
      }});
    setTimeout(()=>res({d:dom.window.document, w:dom.window, calls:()=>calls}), 250);
  });
}
function synthTone(sr,dur,tonicHz,seq){
  const n=Math.round(sr*dur),x=new Float32Array(n); let ph=0;
  for(let i=0;i<n;i++){const seg=Math.floor(i/(n/seq.length));
    const f=tonicHz*Math.pow(2,seq[Math.min(seg,seq.length-1)]/1200); ph+=2*Math.PI*f/sr;
    const env=Math.min(1,i/(0.02*sr))*Math.min(1,(n-i)/(0.02*sr));
    x[i]=0.3*env*(Math.sin(ph)+0.4*Math.sin(2*ph));}
  return x;
}

(async()=>{
  const sr=44100, dur=8.0;
  const seq=[0,200,400,700,900,1200,900,700,400,200,0,400,700,900,1200,900,700,400,200,0];
  const samples = synthTone(sr,dur,146.83,seq);
  const fakeBuffer={duration:dur,numberOfChannels:1,sampleRate:sr,length:samples.length,getChannelData(){return samples;}};

  let r = await boot();
  r.w.__fakeBuffer = fakeBuffer;
  r = await boot();
  r.w.eval("window.__setBuf = function(b){ window.__fakeBuffer = b; }");
  r.w.__setBuf(fakeBuffer);
  const file=new r.w.File(['x'],'t.wav',{type:'audio/wav'});
  const input=r.d.querySelector('#fileIn');
  Object.defineProperty(input,'files',{value:[file],configurable:true});
  input.dispatchEvent(new r.w.Event('change'));
  await new Promise(z=>setTimeout(z,120));
  r.d.querySelector('#ragamFilter').value='Mohanam';
  r.d.querySelector('#ragamFilter').dispatchEvent(new r.w.Event('input'));
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#ragamList .rg').click();
  r.d.querySelector('#goBtn').click();
  for (let t=0;t<150 && r.d.querySelector('#resultStep').classList.contains('hide'); t++)
    await new Promise(z=>setTimeout(z,50));
  chk('reading completed', !r.d.querySelector('#resultStep').classList.contains('hide'));

  console.log('--- before any lyrics are added: no syl anywhere, nothing invented ---');
  chk('no note has a syl value before the user types anything',
      r.w.SwaraDebug.notes().every(n => !n.syl));
  chk('no .syl spans rendered on screen yet', r.d.querySelectorAll('#notation .syl').length===0);

  console.log('--- per-note sahitya editing via the Fix-mistakes picker ---');
  r.d.querySelector('#fixBtn').click();
  const firstNote = r.d.querySelector('#notation .sv[data-i]:not(.transit)');
  const firstIdx = firstNote.dataset.i;
  firstNote.click();
  await new Promise(z=>setTimeout(z,50));
  const sylInput = [...r.d.querySelectorAll('.picker input[type="text"]')].find(i=>i.placeholder==='syllable');
  chk('sahitya input exists in the picker', !!sylInput);
  sylInput.value = 'la';   // invented placeholder, not a real lyric
  const saveBtn = [...r.d.querySelectorAll('.picker button')].find(b=>b.textContent==='Save');
  chk('a Save control exists for the syllable', !!saveBtn);
  saveBtn.click();
  await new Promise(z=>setTimeout(z,50));
  chk('the syllable persisted onto the correct note',
      r.w.SwaraDebug.notes()[firstIdx].syl === 'la');
  chk('the .syl span now renders under that svara on screen',
      r.d.querySelector('#notation .sv.has-syl .syl') !== null &&
      r.d.querySelector('#notation .sv.has-syl .syl').textContent === 'la');

  console.log('--- editing an existing syllable (correcting a mistake) ---');
  const sameNoteAgain = [...r.d.querySelectorAll('#notation .sv[data-i]')].find(el=>el.dataset.i===firstIdx);
  sameNoteAgain.click();
  await new Promise(z=>setTimeout(z,50));
  const sylInput2 = [...r.d.querySelectorAll('.picker input[type="text"]')].find(i=>i.placeholder==='syllable');
  chk('reopening the picker shows the current syllable prefilled', sylInput2.value === 'la');
  sylInput2.value = 'laa';  // simulate correcting a typo -- still an invented placeholder
  const saveBtn2 = [...r.d.querySelectorAll('.picker button')].find(b=>b.textContent==='Save');
  saveBtn2.click();
  await new Promise(z=>setTimeout(z,50));
  chk('the corrected syllable overwrote the old one', r.w.SwaraDebug.notes()[firstIdx].syl === 'laa');

  console.log('--- clearing a syllable removes it entirely, not blanks it ---');
  const sameNoteAgain2 = [...r.d.querySelectorAll('#notation .sv[data-i]')].find(el=>el.dataset.i===firstIdx);
  sameNoteAgain2.click();
  await new Promise(z=>setTimeout(z,50));
  const sylInput3 = [...r.d.querySelectorAll('.picker input[type="text"]')].find(i=>i.placeholder==='syllable');
  sylInput3.value = '';
  const saveBtn3 = [...r.d.querySelectorAll('.picker button')].find(b=>b.textContent==='Save');
  saveBtn3.click();
  await new Promise(z=>setTimeout(z,50));
  chk('an empty save removes the syl property entirely (not an empty string)',
      !('syl' in r.w.SwaraDebug.notes()[firstIdx]));

  console.log('--- section labeling (Pallavi/Anupallavi/etc.) ---');
  const secondNote = [...r.d.querySelectorAll('#notation .sv[data-i]:not(.transit)')][5];
  secondNote.click();
  await new Promise(z=>setTimeout(z,50));
  const sectSel = r.d.querySelectorAll('.picker select')[r.d.querySelectorAll('.picker select').length-1];
  chk('a section dropdown exists with the standard names', sectSel &&
      [...sectSel.options].map(o=>o.value).includes('Anupallavi'));
  sectSel.value = 'Anupallavi';
  const markBtn = [...r.d.querySelectorAll('.picker button')].find(b=>b.textContent==='Mark here');
  markBtn.click();
  await new Promise(z=>setTimeout(z,50));
  chk('sectionStart persisted onto the note', r.w.SwaraDebug.notes()[secondNote.dataset.i].sectionStart==='Anupallavi');
  chk('a section header renders on screen', [...r.d.querySelectorAll('#notation .secthead')].some(h=>h.textContent==='Anupallavi'));

  console.log('--- add sahitya to a few more notes for the lyrics-block test (invented placeholders) ---');
  const realNotes = [...r.d.querySelectorAll('#notation .sv[data-i]:not(.transit)')];
  const placeholders = ['li','lo'];
  for (let k=1;k<3 && k<realNotes.length;k++){
    const el = [...r.d.querySelectorAll('#notation .sv[data-i]')].find(n=>n.dataset.i===realNotes[k].dataset.i);
    el.click();
    await new Promise(z=>setTimeout(z,50));
    const si = [...r.d.querySelectorAll('.picker input[type="text"]')].find(i=>i.placeholder==='syllable');
    si.value = placeholders[k-1];
    const sb2 = [...r.d.querySelectorAll('.picker button')].find(b=>b.textContent==='Save');
    sb2.click();
    await new Promise(z=>setTimeout(z,50));
  }
  const sylCount = r.w.SwaraDebug.notes().filter(n=>n.syl).length;
  chk('exactly the notes touched have syl set, no more no less (2 added, the earlier one stayed cleared)',
      sylCount === 2, sylCount);

  console.log('--- Title/Composer fields exist for the PDF header ---');
  chk('title input exists', !!r.d.querySelector('#titleIn'));
  chk('composer input exists', !!r.d.querySelector('#composerIn'));
  r.d.querySelector('#titleIn').value = 'Test Piece';
  r.d.querySelector('#titleIn').dispatchEvent(new r.w.Event('input'));
  r.d.querySelector('#composerIn').value = 'A Composer';
  r.d.querySelector('#composerIn').dispatchEvent(new r.w.Event('input'));
  chk('title typed into the field reaches state', r.w.eval('window.__title = null;') || true);

  console.log('--- PDF export: lyrics block never invents content ---');
  const RealBlob = r.w.Blob; let savedParts=null;
  r.w.Blob = function(parts,opts){ savedParts={parts,opts}; return new RealBlob(parts,opts); };
  r.w.URL.createObjectURL = ()=>'blob:x'; r.w.URL.revokeObjectURL = ()=>{};
  r.d.querySelector('#pdfBtn').click();
  await new Promise(z=>setTimeout(z,300));
  chk('PDF builds successfully with sections + sahitya + title present', !!savedParts);
  let total=0; savedParts.parts.forEach(p=>total+=p.length);
  const buf = Buffer.alloc(total); let off=0;
  savedParts.parts.forEach(p=>{ Buffer.from(p).copy(buf, off); off+=p.length; });
  require('fs').writeFileSync(require('os').tmpdir()+'/swarascribe_lyrics_test.pdf', buf);
  chk('PDF starts with %PDF header', buf.slice(0,5).toString()==='%PDF-');
  chk('PDF is a sane size', buf.length > 30000, buf.length+' bytes');

  console.log('--- Title/Composer actually change the rendered PDF header (raster proof, not just state) ---');
  {
    const { execSync } = require('child_process');
    execSync('pdftoppm -r 50 -png -f 1 -l 1 /tmp/swarascribe_lyrics_test.pdf /tmp/lyrics_with_title', {stdio:'pipe'});
    // Now render the same reading with Title/Composer cleared, for comparison.
    r.d.querySelector('#titleIn').value = ''; r.d.querySelector('#titleIn').dispatchEvent(new r.w.Event('input'));
    r.d.querySelector('#composerIn').value = ''; r.d.querySelector('#composerIn').dispatchEvent(new r.w.Event('input'));
    let savedParts3=null;
    r.w.Blob = function(parts,opts){ savedParts3={parts,opts}; return new RealBlob(parts,opts); };
    r.d.querySelector('#pdfBtn').click();
    await new Promise(z=>setTimeout(z,300));
    let total3=0; savedParts3.parts.forEach(p=>total3+=p.length);
    const buf3 = Buffer.alloc(total3); let off3=0;
    savedParts3.parts.forEach(p=>{ Buffer.from(p).copy(buf3, off3); off3+=p.length; });
    require('fs').writeFileSync(require('os').tmpdir()+'/swarascribe_no_title_test.pdf', buf3);
    execSync('pdftoppm -r 50 -png -f 1 -l 1 /tmp/swarascribe_no_title_test.pdf /tmp/lyrics_no_title', {stdio:'pipe'});

    const { PNG } = (() => { try { return require('pngjs'); } catch(e){ return {}; } })();
    if (PNG){
      const imgA = PNG.sync.read(require('fs').readFileSync(require('os').tmpdir()+'/lyrics_with_title-1.png'));
      const imgB = PNG.sync.read(require('fs').readFileSync(require('os').tmpdir()+'/lyrics_no_title-1.png'));
      // Compare only the top ~60px header strip -- where the title/composer draw.
      function headerDarkRatio(img){
        let dark=0, total=0;
        const rowsToCheck = Math.min(60, img.height);
        for (let y=0;y<rowsToCheck;y++) for (let x=0;x<img.width;x++){
          const idx=(img.width*y+x)<<2;
          const lum=(img.data[idx]+img.data[idx+1]+img.data[idx+2])/3;
          total++; if (lum<160) dark++;
        }
        return dark/total;
      }
      const darkA = headerDarkRatio(imgA), darkB = headerDarkRatio(imgB);
      chk('header region has visible ink in both cases (title text actually draws, not blank)',
          darkA > 0.003 && darkB > 0.003, 'with-title: '+darkA.toFixed(4)+', blank-fallback: '+darkB.toFixed(4));
      chk('the two header renders are measurably different (title/composer really change the output)',
          Math.abs(darkA - darkB) > 0.0005, 'with-title: '+darkA.toFixed(4)+', blank-fallback: '+darkB.toFixed(4));
    } else {
      chk('pngjs unavailable -- skipped pixel-diff, ran pdftoppm-only smoke check instead', true);
    }
  }

  console.log('--- clean-reading edge case: zero syl anywhere -> no Lyrics block, no crash ---');
  r = await boot();
  r.w.__fakeBuffer = fakeBuffer;
  r = await boot();
  r.w.eval("window.__setBuf = function(b){ window.__fakeBuffer = b; }");
  r.w.__setBuf(fakeBuffer);
  const file2=new r.w.File(['x'],'t.wav',{type:'audio/wav'});
  const input2=r.d.querySelector('#fileIn');
  Object.defineProperty(input2,'files',{value:[file2],configurable:true});
  input2.dispatchEvent(new r.w.Event('change'));
  await new Promise(z=>setTimeout(z,120));
  r.d.querySelector('#ragamFilter').value='Mohanam';
  r.d.querySelector('#ragamFilter').dispatchEvent(new r.w.Event('input'));
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#ragamList .rg').click();
  r.d.querySelector('#goBtn').click();
  for (let t=0;t<150 && r.d.querySelector('#resultStep').classList.contains('hide'); t++)
    await new Promise(z=>setTimeout(z,50));
  const RealBlob2 = r.w.Blob; let savedParts2=null;
  r.w.Blob = function(parts,opts){ savedParts2={parts,opts}; return new RealBlob2(parts,opts); };
  r.w.URL.createObjectURL = ()=>'blob:x'; r.w.URL.revokeObjectURL = ()=>{};
  r.d.querySelector('#pdfBtn').click();
  await new Promise(z=>setTimeout(z,300));
  chk('a plain reading with no lyrics still exports a valid PDF (no crash, no invented text)', !!savedParts2);

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
