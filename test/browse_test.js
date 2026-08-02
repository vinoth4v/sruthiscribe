// Browse-database feature tests: ragam dropdown population, query construction
// (filters + free text -> correct PostgREST query string), result rendering,
// expand/collapse, version history, and graceful failure modes.
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

(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

  // 1. Panel hidden by default; toggled by the header button; ragam dropdown populated.
  let r = await boot(async()=>({ok:true,status:200,json:async()=>[]}));
  chk('browse section hidden on load', r.d.querySelector('#browseSection').classList.contains('hide'));
  const opts = [...r.d.querySelectorAll('#brRagam option')].map(o=>o.value);
  chk('ragam dropdown has "any" + many ragams', opts[0]==='' && opts.length>50, opts.length);
  chk('Mohanam present in ragam list', opts.includes('Mohanam'));

  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  chk('opening reveals the section', !r.d.querySelector('#browseSection').classList.contains('hide'));
  chk('opening triggers an initial search', r.calls().some(c=>String(c.url).includes('/rest/v1/kritis')));

  // 2. No filters -> base query only (no ragam/form/or params).
  let call = r.calls().find(c=>String(c.url).includes('/rest/v1/kritis'));
  chk('base query has select+order+limit', /select=/.test(call.url) && /order=title/.test(call.url));
  chk('no ragam filter present by default', !call.url.includes('ragam=eq'));

  // 3. Ragam filter -> eq param; apikey header present.
  r = await boot(async(url,opts)=>({ok:true,status:200,json:async()=>[]}));
  r.d.querySelector('#brRagam').value = 'Mohanam';
  r.d.querySelector('#brRagam').dispatchEvent(new r.w.Event('change'));
  await new Promise(z=>setTimeout(z,80));
  call = r.calls().find(c=>String(c.url).includes('/rest/v1/kritis'));
  chk('ragam filter -> ragam=eq.Mohanam', call.url.includes('ragam=eq.Mohanam'));
  chk('apikey header sent', call.opts.headers.apikey === 'sb_publishable_zyHN7T8UeH1ZVtQ6DJpSsA_7exufW0j');

  // 4. Form + free text combine correctly (AND of eq + or-group).
  r = await boot(async()=>({ok:true,status:200,json:async()=>[]}));
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,50));
  r.d.querySelector('#brForm').value = 'varnam';
  r.d.querySelector('#brForm').dispatchEvent(new r.w.Event('change'));
  await new Promise(z=>setTimeout(z,50));
  r.d.querySelector('#brQuery').value = 'kalyani';
  r.d.querySelector('#brSearchBtn').click();
  await new Promise(z=>setTimeout(z,50));
  call = r.calls().filter(c=>String(c.url).includes('/rest/v1/kritis')).pop();
  chk('form filter present', call.url.includes('form=eq.varnam'));
  chk('free text -> or= group across title/composer/tala',
      /or=\(title\.ilike\.\*kalyani\*,composer\.ilike\.\*kalyani\*,tala\.ilike\.\*kalyani\*\)/.test(decodeURIComponent(call.url)),
      decodeURIComponent(call.url));

  // 5. Rendering: cards show title/meta/tag, expand on click to reveal notation + versions.
  const FAKE_ROWS = [
    { id:'k1', title:'Ninnukori (Varnam) — pallavi', composer:'Ramanathapuram Srinivasa Iyengar',
      ragam:'Mohanam', tala:'Adi', form:'varnam', source:'seed:traditional',
      versions:[
        { id:'v2', contributor:'ravi', status:'community', flat:"G3 R2 S R2 G3 P G3 R2 S", created_at:'2026-08-01T10:00:00Z' },
        { id:'v1', contributor:'SwaraScribe seed', status:'seed', flat:"G3 R2 S D2. S R2 G3 P", created_at:'2026-07-01T10:00:00Z' }
      ]},
    { id:'k2', title:'Untitled sketch', composer:null, ragam:'Kalyani', tala:null, form:'other',
      source:'community', versions:[] }
  ];
  r = await boot(async(url)=>{
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>FAKE_ROWS};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  const cards = r.d.querySelectorAll('.brcard');
  chk('two result cards rendered', cards.length === 2, cards.length);
  chk('title shown', /Ninnukori/.test(cards[0].textContent));
  chk('composer + ragam + tala + form in meta', /Ramanathapuram.*Mohanam.*Adi.*varnam/.test(cards[0].querySelector('.brmeta').textContent));
  chk('seed tag on first card', cards[0].querySelector('.brtag').classList.contains('seed'));
  chk('community tag on second card', cards[1].querySelector('.brtag').classList.contains('community'));
  chk('version count shown for multi-version kriti', /2 versions/.test(cards[0].textContent));
  chk('note hidden before expand', r.w.getComputedStyle(cards[0].querySelector('.brnote')).display === 'none' || !cards[0].classList.contains('open'));

  cards[0].click();
  chk('card opens on click', cards[0].classList.contains('open'));
  chk('notation rendered from latest (most recent) version, not first in array',
      cards[0].querySelector('.brnote').textContent.includes('S') && !cards[0].querySelector('.brnote').textContent.includes('undefined'));
  chk('version history lists both contributors', /ravi/.test(cards[0].textContent) && /SwaraScribe seed/.test(cards[0].textContent));
  chk('latest marked distinctly from older', /\u25CF latest/.test(cards[0].textContent) && /\u25CB/.test(cards[0].textContent));

  cards[0].click();
  chk('card closes on second click', !cards[0].classList.contains('open'));

  chk('kriti with zero versions handled gracefully', /No notation on file yet/.test(cards[1].textContent));

  // 5b. Saraga-sourced card: distinct tag + license attribution line on expand.
  const SARAGA_ROWS = [
    { id:'k3', title:'Janani', composer:null, ragam:'Reetigowla', tala:'Misra chapu', form:'kriti',
      source:'saraga:mtg-upf',
      license:'CC BY-NC-SA 4.0 - Saraga dataset, Music Technology Group, UPF (doi:10.5281/zenodo.4301737)',
      versions:[{ id:'v9', contributor:'Saraga (MTG-UPF)', status:'seed',
        flat:'N2 S G2 G2 M1', created_at:'2026-08-01T10:00:00Z' }]}
  ];
  r = await boot(async(url)=>{
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>SARAGA_ROWS};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  const scard = r.d.querySelector('.brcard');
  chk('saraga entry gets its own tag class', scard.querySelector('.brtag').classList.contains('saraga'));
  chk('tag text names the license family', /CC BY-NC-SA/.test(scard.querySelector('.brtag').textContent));
  scard.click();
  chk('expanded card shows full attribution line', /Saraga dataset, Music Technology Group, UPF/.test(scard.textContent));
  chk('query requests the license field', r.calls().some(c=>String(c.url).includes('license')));

  // 6. No results -> friendly empty state, no crash.
  r = await boot(async(url)=>{
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>[]};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  chk('empty results -> friendly message', /No matches/.test(r.d.querySelector('#brResults').textContent));

  // 7. Network/DB failure -> friendly message, no throw.
  r = await boot(async(url)=>{
    if (String(url).includes('/rest/v1/kritis')) throw new TypeError('Failed to fetch');
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  chk('fetch failure -> friendly message', /Could not reach/.test(r.d.querySelector('#brResults').textContent));

  // 8. Enter key in search box triggers search.
  r = await boot(async(url)=>({ok:true,status:200,json:async()=>[]}));
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,50));
  r.calls().length = 0;
  r.d.querySelector('#brQuery').value = 'todi';
  r.d.querySelector('#brQuery').dispatchEvent(new r.w.KeyboardEvent('keydown', {key:'Enter'}));
  await new Promise(z=>setTimeout(z,50));
  chk('Enter key triggers a new search', r.calls().some(c=>String(c.url).includes('todi')));

  console.log('--- Browse card upgrade: avartana/anga bars when the tala can be confidently matched ---');
  const BAR_ROWS = [
    // New-style entry: tala stored as the full generated label -- exact match.
    { id:'kb1', title:'Adi Bars Test', composer:null, ragam:'Mohanam', tala:'Chaturasra Triputa (Adi) \u2014 8 beats',
      form:'kriti', source:'community',
      versions:[{ id:'vb1', contributor:'tester', status:'community', created_at:'2026-08-01T10:00:00Z',
        flat:"S R2 G3 M2 P D2 N3 S'",
        notation:{ sections:[{ name:'full', svaras:[
          {s:'S',o:0,sectionStart:'Pallavi'},{s:'R2',o:0},{s:'G3',o:0},{s:'M2',o:0},
          {s:'P',o:0},{s:'D2',o:0},{s:'N3',o:0},{s:'S',o:1} ] }] } }]},
    // Old-style entry: tala stored as the bare common name "Adi" -- matched via the paren-alias check.
    { id:'kb2', title:'Bare Adi Name Test', composer:null, ragam:'Kalyani', tala:'Adi', form:'kriti', source:'seed:traditional',
      versions:[{ id:'vb2', contributor:'seed', status:'seed', created_at:'2026-08-01T10:00:00Z',
        flat:'S R2 G3',
        notation:{ sections:[{ name:'full', svaras:[ {s:'S',o:0}, {s:'R2',o:0}, {s:'G3',o:0} ] }] } }]},
    // Chapu tala -- NOT part of this app's Suladi Sapta Tala model. Must NOT get bars.
    { id:'kb3', title:'Misra Chapu Test', composer:null, ragam:'Reetigowla', tala:'Misra chapu', form:'kriti', source:'saraga:mtg-upf',
      versions:[{ id:'vb3', contributor:'Saraga', status:'seed', created_at:'2026-08-01T10:00:00Z',
        flat:'N2 S G2', notation:{ sections:[{ name:'full', svaras:[ {s:'N2',o:0}, {s:'S',o:0}, {s:'G2',o:0} ] }] } }]},
    // No tala stored at all -- must fall back safely, no crash.
    { id:'kb4', title:'No Tala Test', composer:null, ragam:'Mohanam', tala:null, form:'kriti', source:'community',
      versions:[{ id:'vb4', contributor:'tester', status:'community', created_at:'2026-08-01T10:00:00Z',
        flat:'S R2 G3', notation:{ sections:[{ name:'full', svaras:[ {s:'S',o:0}, {s:'R2',o:0}, {s:'G3',o:0} ] }] } }]}
  ];
  r = await boot(async(url)=>{
    if (String(url).includes('/rest/v1/kritis')) return {ok:true,status:200,json:async()=>BAR_ROWS};
    return {ok:true,status:200,json:async()=>[]};
  });
  r.d.querySelector('#browseBtn').click();
  await new Promise(z=>setTimeout(z,80));
  const barCards = r.d.querySelectorAll('.brcard');

  chk('exact-label match gets an avartana bar', barCards[0].querySelector('.avline') !== null);
  chk('exact-label match gets anga bars too (Adi: after beat 4 and beat 6)',
      barCards[0].querySelectorAll('.angline').length === 2, barCards[0].querySelectorAll('.angline').length);
  chk('section header renders from the stored sectionStart tag',
      [...barCards[0].querySelectorAll('.secthead')].some(h=>h.textContent==='Pallavi'));
  chk('all 8 svara cells render', barCards[0].querySelectorAll('.brnote .sv').length === 8,
      barCards[0].querySelectorAll('.brnote .sv').length);

  chk('bare common name "Adi" also matches and gets a bar', barCards[1].querySelector('.avline') !== null);

  chk('Misra Chapu (unsupported tala system) gets NO bars -- safe fallback, not a wrong bar',
      barCards[2].querySelector('.avline') === null && barCards[2].querySelector('.angline') === null);
  chk('Misra Chapu entry still shows its svaras via the plain fallback',
      /N2/.test(barCards[2].querySelector('.brnote').textContent));

  chk('no tala at all -- no crash, no bars, svaras still shown',
      barCards[3].querySelector('.avline') === null &&
      /S/.test(barCards[3].querySelector('.brnote').textContent));


  process.exit(fail?1:0);
})();
