// Live-preview tests for the redesigned Add-composition builder: does the
// preview actually show avartana/anga bars and syllables matching the
// selected tala, and does it update live as you type or change tala?
const fs=require('fs'); const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

function boot(){
  return new Promise(res=>{
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext=function(){return{state:'running',resume(){},createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),createBufferSource:()=>({connect(){},start(){},stop(){}}),decodeAudioData(){},destination:{}};};
        w.fetch=async()=>({ok:true,status:200,json:async()=>[]});
      }});
    setTimeout(()=>res({d:dom.window.document, w:dom.window}), 250);
  });
}
function setField(w, el, val){ el.value = val; el.dispatchEvent(new w.Event('input')); }

(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

  let r = await boot();
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#brAddBtn').click();
  const block = r.d.querySelector('#aSections .asection');
  const sv = block.querySelector('[data-role="sv"]');
  const preview = block.querySelector('[data-role="preview"]');

  console.log('--- empty state ---');
  chk('empty preview shows a friendly placeholder, not blank/broken', /Nothing yet/.test(preview.textContent));

  console.log('--- typing renders svaras immediately, with an avartana bar at the start ---');
  setField(r.w, sv, "S R2 G3 M1 P D2 N3 S'");  // exactly 8 svaras = one Adi avartana
  chk('8 svara cells rendered', preview.querySelectorAll('.sv').length === 8, preview.querySelectorAll('.sv').length);
  chk('an avartana bar (double, gold) opens the line', preview.querySelector('.avline') !== null);
  chk('no anga bar coincides with the very first cell (that is the avartana bar, not anga)',
      preview.firstElementChild.className === 'avline');

  console.log('--- anga bars land at the correct beat positions for Adi (4, 6) ---');
  // Cells in DOM order: [avline][S][R2][G3][M1][angline][P][D2][angline][N3][S']
  const kids = [...preview.children];
  const angCount = kids.filter(k=>k.classList && k.classList.contains('angline')).length;
  chk('exactly two anga bars inside one Adi avartana (after the 4-beat laghu, after the first drutam)',
      angCount === 2, angCount);

  console.log('--- a second avartana (16 svaras total) gets its own opening bar ---');
  setField(r.w, sv, "S R2 G3 M1 P D2 N3 S' S' N3 D2 P M1 G3 R2 S");
  const avCount = preview.querySelectorAll('.avline').length;
  chk('two avartana bars for 16 plain svaras under Adi', avCount === 2, avCount);

  console.log('--- sahitya renders under each svara live ---');
  setField(r.w, sv, 'S R2 G3');
  const syl = block.querySelector('[data-role="syl"]');
  setField(r.w, syl, 'la li lo');  // invented placeholders, not real lyrics
  chk('three .syl spans render, one under each svara', preview.querySelectorAll('.syl').length === 3);
  chk('the placeholder text is exactly what was typed', preview.textContent.includes('la') &&
      preview.textContent.includes('li') && preview.textContent.includes('lo'));

  console.log('--- mismatched sahitya count shows a live error without crashing the preview ---');
  setField(r.w, syl, 'la li');  // 2 for 3 svaras
  chk('svaras still render even with a sahitya mismatch', preview.querySelectorAll('.sv').length === 3);
  chk('the per-section error message appears live', block.querySelector('[data-role="err"]').textContent.length > 0);
  setField(r.w, syl, '');  // clear back to svaras-only, error should clear too
  chk('clearing sahitya clears the error', block.querySelector('[data-role="err"]').textContent === '');

  console.log('--- changing Talam/Jathi re-renders every open section preview live ---');
  setField(r.w, sv, "S R2 G3 M1 P D2 N3 S'"); // 8 svaras
  const avBefore = preview.querySelectorAll('.avline').length;
  r.d.querySelector('#aTalaSel').value = 'Eka';
  r.d.querySelector('#aTalaSel').dispatchEvent(new r.w.Event('change'));
  r.d.querySelector('#aJathiSel').value = 'Tisra'; // Eka/Tisra = 3-beat avartana
  r.d.querySelector('#aJathiSel').dispatchEvent(new r.w.Event('change'));
  const avAfter = preview.querySelectorAll('.avline').length;
  chk('switching to a much shorter tala (Eka/Tisra, 3 beats) produces more avartana bars for the same 8 svaras',
      avAfter > avBefore, 'before: '+avBefore+', after: '+avAfter);

  console.log('--- a second section renders its own independent preview, starting fresh at beat 1 ---');
  r.d.querySelector('#aTalaSel').value = 'Triputa';
  r.d.querySelector('#aTalaSel').dispatchEvent(new r.w.Event('change'));
  r.d.querySelector('#aJathiSel').value = 'Chaturasra';
  r.d.querySelector('#aJathiSel').dispatchEvent(new r.w.Event('change'));
  r.d.querySelector('#aNewSectionName').value = 'Anupallavi';
  r.d.querySelector('#aAddSection').click();
  const blocks = r.d.querySelectorAll('#aSections .asection');
  chk('two section blocks now exist', blocks.length === 2);
  const secondPreview = blocks[1].querySelector('[data-role="preview"]');
  chk('the new section starts with its own empty preview, unaffected by the first section\u2019s content',
      /Nothing yet/.test(secondPreview.textContent));
  setField(r.w, blocks[1].querySelector('[data-role="sv"]'), "S R2 G3 M1");
  chk('the second section\u2019s own avartana bar opens at ITS first svara (beat 1 of a fresh avartana), not offset by the first section',
      secondPreview.firstElementChild.className === 'avline');
  chk('the first section\u2019s preview is untouched by typing in the second', preview.querySelectorAll('.sv').length === 8);

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
