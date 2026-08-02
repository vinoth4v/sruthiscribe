// Faithful end-to-end test: load real audio through the actual UI (mocked
// file/decoder plumbing only), run the real analysis pipeline, then drive
// the Ask panel and inspect the real outgoing fetch to api.anthropic.com.
const fs=require('fs'); const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

function synthTone(sr, dur, tonicHz){
  const n=Math.round(sr*dur), x=new Float32Array(n);
  const seq=[0,200]; let ph=0;
  for(let i=0;i<n;i++){
    const seg=Math.floor(i/(n/seq.length));
    const cents=seq[Math.min(seg,seq.length-1)];
    const f=tonicHz*Math.pow(2,cents/1200);
    ph+=2*Math.PI*f/sr;
    const env=Math.min(1,i/(0.02*sr))*Math.min(1,(n-i)/(0.02*sr));
    x[i]=0.3*env*(Math.sin(ph)+0.4*Math.sin(2*ph));
  }
  return x;
}

function mkAC(fakeBuffer){
  return function(){
    return {
      state:'running', resume(){}, currentTime:0,
      createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
      createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
      createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
      createBufferSource:()=>({connect(){},start(){},stop(){}}),
      destination:{},
      decodeAudioData(arrayBuf, onSuccess){ onSuccess(fakeBuffer); }
    };
  };
}

function run(fetchStub){
  return new Promise(res=>{
    const sr=44100, dur=2.0, tonicHz=146.83;
    const samples = synthTone(sr, dur, tonicHz);
    const fakeBuffer = { duration:dur, numberOfChannels:1, sampleRate:sr, length:samples.length,
      getChannelData(){ return samples; } };
    let calls=[];
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext = mkAC(fakeBuffer);
        w.fetch = (url,opts)=>{ calls.push({url,opts}); return fetchStub(url,opts); };
        // Deterministic FileReader stub -- content is irrelevant since decodeAudioData is stubbed.
        w.Element.prototype.scrollIntoView = w.Element.prototype.scrollIntoView || function(){};
        w.FileReader = function(){
          this.readAsArrayBuffer = function(){ var self=this;
            setTimeout(function(){ self.result = new ArrayBuffer(8); if (self.onload) self.onload(); }, 0);
          };
        };
      }});
    setTimeout(()=>{
      const w=dom.window, d=w.document;
      // Simulate picking a file: real File object, files set via defineProperty (jsdom quirk).
      const file = new w.File(['x'], 'test.wav', { type:'audio/wav' });
      const input = d.querySelector('#fileIn');
      Object.defineProperty(input, 'files', { value:[file], configurable:true });
      input.dispatchEvent(new w.Event('change'));
      setTimeout(()=>{
        // audio decoded; select Mohanam and click "Read the notation"
        var filterEv = new w.Event('input');
        var filt = d.querySelector('#ragamFilter'); filt.value='Mohanam'; filt.dispatchEvent(filterEv);
        setTimeout(()=>{
          var rg = d.querySelector('#ragamList .rg'); if (rg) rg.click();
          d.querySelector('#goBtn').click();
          // pipeline is async with rAF chunking; poll until resultStep is revealed
          var tries=0;
          (function poll(){
            tries++;
            if (!d.querySelector('#resultStep').classList.contains('hide') || tries>80){
              res({ d, w, calls:()=>calls });
            } else setTimeout(poll, 50);
          })();
        }, 80);
      }, 80);
    }, 250);
  });
}

(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

  let r = await run(async()=>({ ok:true, status:200,
    json:async()=>({content:[{type:'text',text:'This reads as Mohanam throughout.'}]}) }));

  chk('reading actually completed', !r.d.querySelector('#resultStep').classList.contains('hide'));
  chk('ask panel visible (no probe needed)', !r.d.querySelector('#askPanel').classList.contains('hide'));
  const notesShown = r.d.querySelectorAll('#notation .sv:not(.bar)').length;
  chk('notation has real notes', notesShown > 0, 'count='+notesShown);

  r.calls().length = 0; // clear any incidental calls before asking
  const chips = r.d.querySelectorAll('#askChips .chipbtn');
  chk('4 chips present', chips.length===4);
  chips[0].click();
  await new Promise(z=>setTimeout(z,150));

  const call = r.calls()[0];
  chk('called api.anthropic.com/v1/messages directly', call && call.url === 'https://api.anthropic.com/v1/messages', call&&call.url);
  const sent = JSON.parse(call.opts.body);
  chk('model is claude-sonnet-4-6', sent.model === 'claude-sonnet-4-6', sent.model);
  chk('max_tokens is 1000', sent.max_tokens === 1000, sent.max_tokens);
  chk('no x-api-key header', !('x-api-key' in (call.opts.headers||{})));
  chk('no api key anywhere in request', !JSON.stringify(call.opts).toLowerCase().includes('sk-ant'));
  chk('system prompt present', /Carnatic music teacher/.test(sent.system));
  chk('prompt cites ragam Mohanam', /Mohanam/.test(sent.messages[0].content));
  chk('answer rendered from response', /Mohanam/.test(r.d.querySelector('#askOut').textContent));

  // error path
  r = await run(async()=>({ ok:false, status:401, json:async()=>({error:{message:'bad request'}}) }));
  r.d.querySelectorAll('#askChips .chipbtn')[0].click();
  await new Promise(z=>setTimeout(z,150));
  chk('non-ok response shows message, no crash', /bad request/.test(r.d.querySelector('#askOut').textContent));

  // network failure path
  r = await run(async()=>{ throw new TypeError('Failed to fetch'); });
  r.d.querySelectorAll('#askChips .chipbtn')[0].click();
  await new Promise(z=>setTimeout(z,150));
  chk('network failure handled gracefully', /Could not reach the API/.test(r.d.querySelector('#askOut').textContent));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
