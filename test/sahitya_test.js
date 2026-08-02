// Manual "add a composition" form + sahitya (lyrics) rendering tests.
// Uses only invented placeholder syllables (la, li, lo...) — never real lyrics —
// to verify the mechanism without touching any actual copyrighted text.
const fs=require('fs'); const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

function boot(fetchStub){
  return new Promise(res=>{
    let calls=[];
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext=function(){return{state:'running',resume(){},createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),createBufferSource:()=>({connect(){},start(){},stop(){}}),decodeAudioData(){},destination:{}};};
        w.fetch=(url,opts)=>{ calls.push({url,opts}); return fetchStub(url,opts); };
      }});
    setTimeout(()=>res({d:dom.window.document, w:dom.window, calls:()=>calls}), 250);
  });
}
function firstSectionFields(d){
  const block = d.querySelector('#aSections .asection');
  return { sv: block.querySelector('[data-role="sv"]'), syl: block.querySelector('[data-role="syl"]') };
}
function setField(w, el, val){ el.value = val; el.dispatchEvent(new w.Event('input')); }

(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

  let r = await boot(async()=>({ok:true,status:200,json:async()=>[]}));
  chk('add form hidden initially', r.d.querySelector('#brAddForm').classList.contains('hide'));
  const ragOpts = [...r.d.querySelectorAll('#aRagam option')].map(o=>o.value);
  chk('add-form ragam list populated', ragOpts.includes('Kalyani') && ragOpts.length>50);
  chk('a default Pallavi section exists before the form is even opened',
      r.d.querySelectorAll('#aSections .asection').length === 1 &&
      r.d.querySelector('#aSections .asection').dataset.name === 'Pallavi');
  r.d.querySelector('#brAddBtn').click();
  chk('toggle reveals the form', !r.d.querySelector('#brAddForm').classList.contains('hide'));

  r.calls().length = 0;
  r.d.querySelector('#aSubmit').click();
  chk('empty title blocked', /title is needed/.test(r.d.querySelector('#aStatus').textContent));
  chk('no fetch on validation failure', r.calls().length===0);

  r.d.querySelector('#aTitle').value = 'Test Piece';
  r.d.querySelector('#aSubmit').click();
  chk('empty svaras blocked', /Add at least a few svaras/.test(r.d.querySelector('#aStatus').textContent));

  let fields = firstSectionFields(r.d);
  setField(r.w, fields.sv, "S R2 G3 P D2 S'");
  setField(r.w, fields.syl, 'la li lo');
  const block = r.d.querySelector('#aSections .asection');
  chk('live per-section error shows the mismatch as you type',
      block.querySelector('[data-role="err"]').textContent.length > 0,
      block.querySelector('[data-role="err"]').textContent);
  r.d.querySelector('#aSubmit').click();
  chk('mismatched syllable count blocked on submit', /Pallavi.*3 syllables.*6 svaras/.test(r.d.querySelector('#aStatus').textContent),
      r.d.querySelector('#aStatus').textContent);

  r = await boot(async(url,opts)=>{
    if (String(url).includes('select=id,title,ragam&')) return {ok:true,status:200,json:async()=>[]};
    if (String(url).includes('/rest/v1/kritis') && opts && opts.method==='POST') return {ok:true,status:201,json:async()=>[{id:'new-id-1'}]};
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>[]};
    if (String(url).includes('/rest/v1/versions')) return {ok:true,status:201,json:async()=>[{id:'v1'}]};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#brAddBtn').click();
  r.d.querySelector('#aTitle').value = 'Test Piece';
  r.d.querySelector('#aComposer').value = 'A Composer';
  r.d.querySelector('#aRagam').value = 'Mohanam';
  chk('Talam/Jathi selects default to Adi (Chaturasra Triputa)',
      r.d.querySelector('#aTalaSel').value==='Triputa' && r.d.querySelector('#aJathiSel').value==='Chaturasra');
  chk('the talam summary line names Adi', /Adi/.test(r.d.querySelector('#aTalaOut').textContent));
  fields = firstSectionFields(r.d);
  setField(r.w, fields.sv, "S R2 G3 P D2 S'");
  setField(r.w, fields.syl, 'la li lo la li lo');
  r.d.querySelector('#aName').value = 'tester';
  r.calls().length = 0;
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,150));

  const kcall = r.calls().find(c=>String(c.url).includes('/rest/v1/kritis') && c.opts && c.opts.method==='POST');
  chk('kritis insert fired', !!kcall);
  const kbody = JSON.parse(kcall.opts.body);
  chk('title/composer/ragam correct', kbody.title==='Test Piece' && kbody.composer==='A Composer' &&
      kbody.ragam==='Mohanam');
  chk('tala field carries the full descriptive label, naming Adi', /Adi/.test(kbody.tala), kbody.tala);
  chk('source is community', kbody.source==='community');

  const vcall = r.calls().find(c=>String(c.url).includes('/rest/v1/versions'));
  chk('versions insert fired, linked to new kriti', !!vcall && JSON.parse(vcall.opts.body).kriti_id==='new-id-1');
  const vbody = JSON.parse(vcall.opts.body);
  chk('flat is pure svara tokens (unaffected by syl)', vbody.flat === "S R2 G3 P D2 S'");
  chk('each svara carries its syl', vbody.notation.sections[0].svaras.every(function(n,i){
    return n.syl === ['la','li','lo','la','li','lo'][i];
  }));
  chk('octave parsed correctly on the final S\'', vbody.notation.sections[0].svaras[5].o === 1);
  chk('the first svara is tagged with its section name (Pallavi)',
      vbody.notation.sections[0].svaras[0].sectionStart === 'Pallavi');
  chk('success message shown', /Test Piece.*added/.test(r.d.querySelector('#aStatus').textContent));
  chk('form resets to one clean Pallavi section after success',
      r.d.querySelector('#aTitle').value === '' && r.d.querySelectorAll('#aSections .asection').length===1);

  r = await boot(async(url,opts)=>{
    if (String(url).includes('select=id,title,ragam&')) return {ok:true,status:200,json:async()=>[]};
    if (String(url).includes('/rest/v1/kritis') && opts && opts.method==='POST') return {ok:true,status:201,json:async()=>[{id:'new-id-2'}]};
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>[]};
    if (String(url).includes('/rest/v1/versions')) return {ok:true,status:201,json:async()=>[{id:'v2'}]};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#brAddBtn').click();
  r.d.querySelector('#aTitle').value = 'Svara Only Piece';
  r.d.querySelector('#aRagam').value = 'Kalyani';
  setField(r.w, firstSectionFields(r.d).sv, 'S R2 G3 M2 P');
  r.calls().length = 0;
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,150));
  const vcall2 = r.calls().find(c=>String(c.url).includes('/rest/v1/versions'));
  const vbody2 = JSON.parse(vcall2.opts.body);
  chk('no syl field when sahitya left blank', vbody2.notation.sections[0].svaras.every(function(n){ return !('syl' in n); }));
  chk('note reflects svaras-only', /svaras only/.test(vbody2.note));

  r = await boot(async(url,opts)=>{
    if (String(url).includes('select=id,title,ragam&')) return {ok:true,status:200,json:async()=>[]};
    if (String(url).includes('/rest/v1/kritis') && opts && opts.method==='POST') return {ok:true,status:201,json:async()=>[{id:'new-id-3'}]};
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>[]};
    if (String(url).includes('/rest/v1/versions')) return {ok:true,status:201,json:async()=>[{id:'v3'}]};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#brAddBtn').click();
  r.d.querySelector('#aTitle').value = 'Multi Section Piece';
  r.d.querySelector('#aRagam').value = 'Kalyani';
  setField(r.w, firstSectionFields(r.d).sv, 'S R2 G3');
  r.d.querySelector('#aNewSectionName').value = 'Anupallavi';
  r.d.querySelector('#aAddSection').click();
  chk('a second section block was added', r.d.querySelectorAll('#aSections .asection').length===2);
  const secondBlock = r.d.querySelectorAll('#aSections .asection')[1];
  setField(r.w, secondBlock.querySelector('[data-role="sv"]'), "P D2 S'");
  r.calls().length = 0;
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,150));
  const vcall3 = r.calls().find(c=>String(c.url).includes('/rest/v1/versions'));
  const vbody3 = JSON.parse(vcall3.opts.body);
  chk('multi-section flat concatenates both sections in order', vbody3.flat === "S R2 G3 P D2 S'", vbody3.flat);
  const svs3 = vbody3.notation.sections[0].svaras;
  chk('first section tagged Pallavi', svs3[0].sectionStart==='Pallavi');
  chk('second section tagged Anupallavi at the right note', svs3[3].sectionStart==='Anupallavi', svs3.map(n=>n.sectionStart));

  r = await boot(async()=>({ok:true,status:200,json:async()=>[]}));
  r.d.querySelector('#brAddBtn').click();
  const onlyBlock = r.d.querySelector('#aSections .asection');
  onlyBlock.querySelector('[data-role="remove"]').click();
  chk('the last remaining section cannot be removed', r.d.querySelectorAll('#aSections .asection').length===1);
  r.d.querySelector('#aNewSectionName').value = 'Caranam';
  r.d.querySelector('#aAddSection').click();
  chk('now there are two sections', r.d.querySelectorAll('#aSections .asection').length===2);
  r.d.querySelectorAll('#aSections .asection')[0].querySelector('[data-role="remove"]').click();
  chk('removing one of two sections leaves one', r.d.querySelectorAll('#aSections .asection').length===1);

  const FAKE_ROWS = [
    { id:'k1', title:'With Lyrics', composer:null, ragam:'Mohanam', tala:'Adi', form:'kriti', source:'community',
      versions:[{ id:'v1', contributor:'tester', status:'community',
        flat:"S R2 G3", created_at:'2026-08-01T10:00:00Z',
        notation:{ sections:[{ name:'full', svaras:[
          {s:'S',o:0,syl:'la'}, {s:'R2',o:0,syl:'li'}, {s:'G3',o:0,syl:'lo'} ] }] } }]},
    { id:'k2', title:'Svaras Only', composer:null, ragam:'Kalyani', tala:null, form:'kriti', source:'seed:traditional',
      versions:[{ id:'v2', contributor:'seed', status:'seed',
        flat:"S R2 G3", created_at:'2026-08-01T10:00:00Z',
        notation:{ sections:[{ name:'full', svaras:[ {s:'S',o:0}, {s:'R2',o:0}, {s:'G3',o:0} ] }] } }]}
  ];
  r = await boot(async(url)=>{
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>FAKE_ROWS};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  const cards = r.d.querySelectorAll('.brcard');
  chk('placeholder syllables render under svaras', /la/.test(cards[0].querySelector('.brnote').textContent) &&
      /li/.test(cards[0].querySelector('.brnote').textContent));
  chk('svara-only card has no syllable text leaking in', !/la|li|lo/.test(cards[1].querySelector('.brnote').textContent));

  const NO_DB = html.replace("url: 'https://yrgsdvgsnoxmfhtyngqc.supabase.co',", "url: '',")
                     .replace("key: 'sb_publishable_zyHN7T8UeH1ZVtQ6DJpSsA_7exufW0j'", "key: ''");
  r = await boot(async()=>({ok:true,status:200,json:async()=>[]}));
  const dom2 = new JSDOM(NO_DB, {runScripts:'dangerously', pretendToBeVisual:true, url:'https://x.test/',
    beforeParse(w){ w.AudioContext=function(){return{state:'running',resume(){},createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),createBufferSource:()=>({connect(){},start(){},stop(){}}),decodeAudioData(){},destination:{}};};
      w.fetch=async()=>{throw new Error('should not be called');}; }});
  await new Promise(z=>setTimeout(z,250));
  const d2 = dom2.window.document;
  d2.querySelector('#brAddBtn').click();
  d2.querySelector('#aTitle').value = 'X';
  d2.querySelector('#aSections .asection [data-role="sv"]').value = 'S R2';
  d2.querySelector('#aSubmit').click();
  chk('no-DB build fails gracefully', /not connected/.test(d2.querySelector('#aStatus').textContent));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
