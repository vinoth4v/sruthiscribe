// Edit-existing-entries + duplicate-guard tests.
const fs=require('fs'); const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

const ROWS = [
  { id:'k1', title:'Janani', composer:null, ragam:'Reetigowla', tala:'Misra chapu', form:'kriti',
    source:'saraga:mtg-upf', license:'CC BY-NC-SA 4.0 - Saraga dataset, Music Technology Group, UPF (doi:10.5281/zenodo.4301737)',
    versions:[{ id:'v1', contributor:'Saraga (MTG-UPF)', status:'seed',
      flat:'N2 S G2 G2 M1', created_at:'2026-08-01T10:00:00Z',
      notation:{ sections:[{name:'annotated phrases', svaras:[
        {s:'N2',o:0,sectionStart:'annotated phrases'},{s:'S',o:0},{s:'G2',o:0},{s:'G2',o:0},{s:'M1',o:0}]}]}}]},
  { id:'k2', title:'With Lyrics', composer:'X', ragam:'Mohanam', tala:'Adi', form:'kriti',
    source:'community', license:'contributor-shared',
    versions:[{ id:'v2', contributor:'tester', status:'community',
      flat:'S R2 G3', created_at:'2026-08-01T10:00:00Z',
      notation:{ sections:[{name:'full', svaras:[
        {s:'S',o:0,syl:'la',sectionStart:'Pallavi'},{s:'R2',o:0,syl:'li'},{s:'G3',o:0,syl:'lo'}]}]}}]}
];

function boot(fetchStub){
  return new Promise(res=>{
    let calls=[];
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext=function(){return{state:'running',resume(){},createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),createBufferSource:()=>({connect(){},start(){},stop(){}}),decodeAudioData(){},destination:{}};};
        w.Element.prototype.scrollIntoView=function(){};
        w.fetch=(url,opts)=>{ calls.push({url:String(url),opts}); return fetchStub(String(url),opts); };
      }});
    setTimeout(()=>res({d:dom.window.document, w:dom.window, calls:()=>calls}), 250);
  });
}
const listStub = extra => async(url,opts)=>{
  if (url.includes('/rest/v1/kritis') && (!opts || !opts.method)) {
    if (url.includes('select=id,title,ragam&')) return {ok:true,status:200,json:async()=>(extra&&extra.dup)||[]};
    return {ok:true,status:200,json:async()=>ROWS};
  }
  if (url.includes('/rest/v1/kritis')) return {ok:true,status:201,json:async()=>[{id:'new-k'}]};
  if (url.includes('/rest/v1/versions')) return {ok:true,status:201,json:async()=>[{id:'new-v'}]};
  return {ok:true,status:200,json:async()=>[]};
};
function firstSv(d){ return d.querySelector('#aSections .asection [data-role="sv"]'); }
function firstSyl(d){ return d.querySelector('#aSections .asection [data-role="syl"]'); }
function setField(w, el, val){ el.value = val; el.dispatchEvent(new w.Event('input')); }

(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

  let r = await boot(listStub());
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  const cards = r.d.querySelectorAll('.brcard');
  const btn0 = cards[0].querySelector('button.btn.ghost');
  chk('edit button rendered on card', btn0 && /Edit/.test(btn0.textContent));
  btn0.click();
  chk('form opens in edit mode', !r.d.querySelector('#brAddForm').classList.contains('hide'));
  chk('title prefilled and locked', r.d.querySelector('#aTitle').value==='Janani' && r.d.querySelector('#aTitle').disabled);
  chk('ragam prefilled and locked', r.d.querySelector('#aRagam').value==='Reetigowla' && r.d.querySelector('#aRagam').disabled);
  chk('exactly one section rebuilt from the stored notation', r.d.querySelectorAll('#aSections .asection').length===1);
  chk('svaras prefilled from the stored notation', firstSv(r.d).value==='N2 S G2 G2 M1', firstSv(r.d).value);
  chk('submit label reflects version mode', /new version/.test(r.d.querySelector('#aSubmit').textContent));

  const before = r.calls().filter(c=>c.opts&&c.opts.method==='POST').length;
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,80));
  chk('identical resubmit blocked', /No changes made yet/.test(r.d.querySelector('#aStatus').textContent));
  chk('no POST fired for identical resubmit', r.calls().filter(c=>c.opts&&c.opts.method==='POST').length===before);

  setField(r.w, firstSv(r.d), 'N2 S G2 M1 P');
  r.d.querySelector('#aName').value = 'editor-person';
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,120));
  const posts = r.calls().filter(c=>c.opts&&c.opts.method==='POST');
  chk('exactly one POST (versions), zero kritis inserts',
      posts.length===1 && posts[0].url.includes('/rest/v1/versions'), posts.map(p=>p.url).join());
  const body = JSON.parse(posts[0].opts.body);
  chk('version tied to the kriti', body.kriti_id==='k1');
  chk('parent_version links the corrected version', body.parent_version==='v1');
  chk('contributor recorded', body.contributor==='editor-person');
  chk('status is community (immutable seed untouched)', body.status==='community');
  chk('form reset after save', r.d.querySelector('#aTitle').value==='' && !r.d.querySelector('#aTitle').disabled);

  r = await boot(listStub());
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelectorAll('.brcard')[1].querySelector('button.btn.ghost').click();
  chk('sahitya prefilled when version has full syls', firstSyl(r.d).value==='la li lo', firstSyl(r.d).value);
  setField(r.w, firstSyl(r.d), 'na ni no');
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,120));
  const vposts = r.calls().filter(c=>c.opts&&c.opts.method==='POST'&&c.url.includes('/versions'));
  chk('sahitya-only edit saves a new version', vposts.length===1);
  chk('new syls carried in notation', JSON.parse(vposts[0].opts.body).notation.sections[0].svaras[0].syl==='na');

  r = await boot(listStub());
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelectorAll('.brcard')[0].querySelector('button.btn.ghost').click();
  r.d.querySelector('#brAddBtn').click(); // hide
  r.d.querySelector('#brAddBtn').click(); // reopen fresh
  chk('reopened form is in add mode, unlocked', !r.d.querySelector('#aTitle').disabled &&
      r.d.querySelector('#aSubmit').textContent==='Add to the database');
  chk('reopened form has a clean single Pallavi section, not the leaked edit sections',
      r.d.querySelectorAll('#aSections .asection').length===1 &&
      r.d.querySelector('#aSections .asection').dataset.name==='Pallavi');

  r = await boot(listStub({dup:[{id:'k1',title:'Janani',ragam:'Reetigowla'}]}));
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#brAddBtn').click();
  r.d.querySelector('#aTitle').value='janani';
  r.d.querySelector('#aRagam').value='Reetigowla';
  setField(r.w, firstSv(r.d), 'S R2 G2');
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,120));
  chk('duplicate blocked with pointer to Edit', /already exists.*Edit/.test(r.d.querySelector('#aStatus').textContent),
      r.d.querySelector('#aStatus').textContent);
  chk('no kriti insert on duplicate', !r.calls().some(c=>c.opts&&c.opts.method==='POST'&&c.url.includes('/rest/v1/kritis')));
  const dupCall = r.calls().find(c=>c.url.includes('select=id,title,ragam&'));
  chk('dedup query matches title (ilike) AND ragam', dupCall && dupCall.url.includes('ilike') && dupCall.url.includes('ragam=eq.Reetigowla'));

  r = await boot(listStub({dup:[]}));
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  r.d.querySelector('#brAddBtn').click();
  r.d.querySelector('#aTitle').value='Janani';
  r.d.querySelector('#aRagam').value='Kalyani';
  setField(r.w, firstSv(r.d), 'S R2 G3 M2 P');
  r.d.querySelector('#aSubmit').click();
  await new Promise(z=>setTimeout(z,150));
  chk('same title in a different ragam is allowed', r.calls().some(c=>c.opts&&c.opts.method==='POST'&&c.url.includes('/rest/v1/kritis')));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
