// Community DB tests: match rendering, alignment suggestions, contribution flow,
// and graceful behavior when the DB is not configured. Real UI + pipeline.
const fs=require('fs'); const {JSDOM}=require('jsdom');
let html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
// Simulate a deployed build with the placeholders filled:
const DEPLOYED = html; // work.html now ships with real production credentials baked in
const UNCONFIGURED = html
  .replace("url: 'https://yrgsdvgsnoxmfhtyngqc.supabase.co',", "url: '',")
  .replace("key: 'sb_publishable_zyHN7T8UeH1ZVtQ6DJpSsA_7exufW0j'", "key: ''");

function synthTone(sr,dur,tonicHz){
  const n=Math.round(sr*dur),x=new Float32Array(n); const seq=[0,200,400,700,900,1200,900,700,400,200]; let ph=0;
  for(let i=0;i<n;i++){const seg=Math.floor(i/(n/seq.length));
    const f=tonicHz*Math.pow(2,seq[Math.min(seg,seq.length-1)]/1200); ph+=2*Math.PI*f/sr;
    const env=Math.min(1,i/(0.02*sr))*Math.min(1,(n-i)/(0.02*sr));
    x[i]=0.3*env*(Math.sin(ph)+0.4*Math.sin(2*ph));}
  return x;
}
function run(page, fetchStub){
  return new Promise(res=>{
    const sr=44100,dur=6.0,samples=synthTone(sr,dur,146.83);
    const fakeBuffer={duration:dur,numberOfChannels:1,sampleRate:sr,length:samples.length,
      getChannelData(){return samples;}};
    let calls=[];
    const dom=new JSDOM(page,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext=function(){return{state:'running',resume(){},currentTime:0,
          createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
          createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
          createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
          createBufferSource:()=>({connect(){},start(){},stop(){}}),destination:{},
          decodeAudioData(a,ok){ok(fakeBuffer);}};};
        w.fetch=(url,opts)=>{calls.push({url,opts});return fetchStub(url,opts,calls);};
        w.Element.prototype.scrollIntoView=w.Element.prototype.scrollIntoView||function(){};
        w.FileReader=function(){this.readAsArrayBuffer=function(){var s=this;
          setTimeout(()=>{s.result=new ArrayBuffer(8); if(s.onload) s.onload();},0);};};
      }});
    setTimeout(()=>{
      const w=dom.window,d=w.document;
      const file=new w.File(['x'],'t.wav',{type:'audio/wav'});
      const input=d.querySelector('#fileIn');
      Object.defineProperty(input,'files',{value:[file],configurable:true});
      input.dispatchEvent(new w.Event('change'));
      setTimeout(()=>{
        const filt=d.querySelector('#ragamFilter'); filt.value='Mohanam'; filt.dispatchEvent(new w.Event('input'));
        setTimeout(()=>{
          const rg=d.querySelector('#ragamList .rg'); if(rg) rg.click();
          d.querySelector('#goBtn').click();
          let tries=0;
          (function poll(){ tries++;
            if(!d.querySelector('#resultStep').classList.contains('hide')||tries>120)
              setTimeout(()=>res({d,w,calls:()=>calls}),200); // let dbMatch fire
            else setTimeout(poll,50);
          })();
        },80);
      },80);
    },250);
  });
}

(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

  // ---------- 1. Unconfigured build: panel shows, degrades gracefully, no fetch
  let r = await run(UNCONFIGURED, async(url)=>{
    if (url.includes('supabase')) throw new Error('must not call DB when unconfigured');
    return {ok:true,status:200,json:async()=>({content:[{type:'text',text:'x'}]})};
  });
  chk('panel visible after decode', !r.d.querySelector('#dbPanel').classList.contains('hide'));
  chk('unconfigured: clear message', /not connected/.test(r.d.querySelector('#dbMatches').textContent));
  chk('unconfigured: no supabase call', !r.calls().some(c=>String(c.url).includes('supabase')));
  chk('unconfigured: suggest disabled', r.d.querySelector('#dbSuggestBtn').disabled);

  // ---------- 2. Configured build: matches render, headers correct
  const MOHANAM_REF = "G3 R2 S R2 G3 P G3 R2 S R2 G3 R2 S D2. S R2 G3 P D2 S' D2 P G3 P D2 G3 R2";
  r = await run(DEPLOYED, async(url,opts)=>{
    if (url.includes('/rpc/match_kritis')){
      return {ok:true,status:200,json:async()=>[
        {kriti_id:'k1',version_id:'v1',title:'Ninnukori (Varnam) — pallavi',
         composer:'Ramanathapuram Srinivasa Iyengar',ragam:'Mohanam',tala:'Adi',
         form:'varnam',contributor:'seed',status:'seed',flat:MOHANAM_REF,score:0.41},
        {kriti_id:'k2',version_id:'v2',title:'Mohanam alapana sketch',composer:null,
         ragam:'Mohanam',tala:null,form:'other',contributor:'ravi',status:'community',
         flat:'S R2 G3 P D2 S\' D2 P G3 R2 S',score:0.22}
      ]};
    }
    if (url.includes('/rest/v1/kritis'))
      return {ok:true,status:201,json:async()=>[{id:'new-kriti-id'}]};
    if (url.includes('/rest/v1/versions'))
      return {ok:true,status:201,json:async()=>[{id:'new-version-id'}]};
    return {ok:true,status:200,json:async()=>({content:[{type:'text',text:'x'}]})};
  });
  const mcall = r.calls().find(c=>String(c.url).includes('/rpc/match_kritis'));
  chk('match RPC called after decode', !!mcall);
  chk('apikey header present', mcall.opts.headers.apikey==='sb_publishable_zyHN7T8UeH1ZVtQ6DJpSsA_7exufW0j');
  chk('bearer auth present', mcall.opts.headers.Authorization==='Bearer sb_publishable_zyHN7T8UeH1ZVtQ6DJpSsA_7exufW0j');
  const sentQ = JSON.parse(mcall.opts.body).q;
  chk('query is a svara token string', /^[SRGMPDN][0-9]?['.]* /.test(sentQ+' '), sentQ.slice(0,30));
  chk('matches rendered with title', /Ninnukori/.test(r.d.querySelector('#dbMatches').textContent));
  chk('seed tag shown', /\[seed\]/.test(r.d.querySelector('#dbMatches').textContent));
  chk('suggest button enabled', !r.d.querySelector('#dbSuggestBtn').disabled);

  // ---------- 3. Alignment: correct algorithm behavior on known cases
  const A = r.w.SwaraDebug.alignSeqs(['S','R2','G3'], ['S','R2','G3']);
  chk('align: identical -> all matched pairs', A.every(p=>p[0]>=0&&p[1]>=0) && A.length===3);
  const B = r.w.SwaraDebug.alignSeqs(['S','G3','P'], ['S','R2','G3','P']);
  const gaps = B.filter(p=>p[0]<0).length;
  chk('align: missing token -> one ref gap', gaps===1, JSON.stringify(B));

  // ---------- 4. Apply suggestions: only in-ragam substitutions, marked edited
  const beforeFlat = r.w.SwaraDebug.flatSeq();
  r.d.querySelector('#dbSuggestBtn').click();
  await new Promise(z=>setTimeout(z,50));
  const notes = r.w.SwaraDebug.notes().filter(n=>!n.transit);
  chk('suggestions ran (status set)', /updated from|agrees with/.test(r.d.querySelector('#status').textContent),
      r.d.querySelector('#status').textContent);
  chk('all labels still in ragam', notes.every(n=>['S','R2','G3','P','D2'].includes(n.label)));

  // ---------- 5. Contribute as a version of the best match (title prefilled)
  r.d.querySelector('#dbShareBtn').click();
  chk('share form opens prefilled', r.d.querySelector('#cTitle').value.includes('Ninnukori'));
  r.calls().length=0;
  r.d.querySelector('#cSubmit').click();
  await new Promise(z=>setTimeout(z,120));
  const vcall = r.calls().find(c=>String(c.url).includes('/rest/v1/versions'));
  chk('version insert called', !!vcall);
  const vbody = JSON.parse(vcall.opts.body);
  chk('links to matched kriti', vbody.kriti_id==='k1');
  chk('parent version recorded', vbody.parent_version==='v1');
  chk('status is community', vbody.status==='community');
  chk('flat sequence included', typeof vbody.flat==='string' && vbody.flat.length>10);
  chk('no kritis insert for existing title', !r.calls().some(c=>String(c.url).includes('/rest/v1/kritis')));
  chk('thank-you confirmation', /thank you/.test(r.d.querySelector('#cStatus').textContent));

  // ---------- 6. Contribute as a brand-new kriti
  r.d.querySelector('#dbShareBtn').click(); // reopen
  r.d.querySelector('#cTitle').value = 'My new alapana';
  r.calls().length=0;
  r.d.querySelector('#cSubmit').click();
  await new Promise(z=>setTimeout(z,120));
  const kcall = r.calls().find(c=>String(c.url).includes('/rest/v1/kritis'));
  chk('new title -> kritis insert first', !!kcall);
  const kbody = JSON.parse(kcall.opts.body);
  chk('new kriti source=community', kbody.source==='community');
  chk('ragam auto-filled from app', kbody.ragam==='Mohanam');
  const vcall2 = r.calls().filter(c=>String(c.url).includes('/rest/v1/versions')).pop();
  chk('then version linked to returned id', JSON.parse(vcall2.opts.body).kriti_id==='new-kriti-id');

  // ---------- 7. DB unreachable -> graceful
  r = await run(DEPLOYED, async(url)=>{
    if (url.includes('supabase')) throw new TypeError('Failed to fetch');
    return {ok:true,status:200,json:async()=>({})};
  });
  chk('network failure -> friendly message', /Could not reach/.test(r.d.querySelector('#dbMatches').textContent));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
