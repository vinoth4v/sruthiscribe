// v2 features test against work.html, driven through the real UI/pipeline:
// kattai B=1/2, stateless key header, edit mode corrections, PDF page build.
const fs=require('fs'); const {JSDOM}=require('jsdom');
const canvasShim=require('./lib/canvas-shim');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

function synthTone(sr,dur,tonicHz){
  const n=Math.round(sr*dur),x=new Float32Array(n); const seq=[0,200,400]; let ph=0;
  for(let i=0;i<n;i++){const seg=Math.floor(i/(n/seq.length));
    const f=tonicHz*Math.pow(2,seq[Math.min(seg,2)]/1200); ph+=2*Math.PI*f/sr;
    const env=Math.min(1,i/(0.02*sr))*Math.min(1,(n-i)/(0.02*sr));
    x[i]=0.3*env*(Math.sin(ph)+0.4*Math.sin(2*ph));}
  return x;
}
function run(fetchStub){
  return new Promise(res=>{
    const sr=44100,dur=3.0,samples=synthTone(sr,dur,146.83);
    const fakeBuffer={duration:dur,numberOfChannels:1,sampleRate:sr,length:samples.length,
      getChannelData(){return samples;}};
    let calls=[];
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){ canvasShim.install(w);
        w.AudioContext=function(){return{state:'running',resume(){},currentTime:0,
          createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
          createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
          createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
          createBufferSource:()=>({connect(){},start(){},stop(){}}),destination:{},
          decodeAudioData(a,ok){ok(fakeBuffer);}};};
        w.fetch=(url,opts)=>{calls.push({url,opts});return fetchStub(url,opts);};
        w.Element.prototype.scrollIntoView = w.Element.prototype.scrollIntoView || function(){};
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
              res({d,w,calls:()=>calls});
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

  const r = await run(async()=>({ok:true,status:200,
    json:async()=>({content:[{type:'text',text:'ok'}]})}));

  // --- kattai spot-check on the live dropdown
  const opts=[...r.d.querySelectorAll('#noteSel option')].map(o=>o.textContent.trim());
  chk('C = 1 kattai', /^C\s+·\s+1 kattai/.test(opts[0]), opts[0]);
  chk('E = 3 kattai', /^E\s+·\s+3 kattai/.test(opts[4]), opts[4]);
  chk('A# = 6\u00BD kattai', opts[10].includes('6\u00BD'), opts[10]);
  chk('B = \u00BD kattai', /^B\s+·\s+\u00BD kattai$/.test(opts[11]), opts[11]);
  chk('no 7 kattai anywhere', !opts.some(o=>/\b7 kattai/.test(o)));

  chk('reading completed', !r.d.querySelector('#resultStep').classList.contains('hide'));

  // --- default path: no key entered -> no x-api-key header
  r.calls().length=0;
  r.d.querySelectorAll('#askChips .chipbtn')[0].click();
  await new Promise(z=>setTimeout(z,150));
  let call=r.calls()[0];
  chk('no key: request has no x-api-key', call && !('x-api-key' in call.opts.headers));
  chk('no key: no version header either', call && !('anthropic-version' in call.opts.headers));

  // --- with key: headers present, key correct, stateless (input only)
  r.d.querySelector('#keyIn').value='sk-ant-test-123';
  r.calls().length=0;
  r.d.querySelectorAll('#askChips .chipbtn')[0].click();
  await new Promise(z=>setTimeout(z,150));
  call=r.calls()[0];
  chk('key: x-api-key header set', call && call.opts.headers['x-api-key']==='sk-ant-test-123');
  chk('key: version header set', call && call.opts.headers['anthropic-version']==='2023-06-01');
  chk('key: browser-access header set', call && call.opts.headers['anthropic-dangerous-direct-browser-access']==='true');
  chk('key not in body', !call.opts.body.includes('sk-ant-test-123'));
  chk('own-key path uses claude-sonnet-5', JSON.parse(call.opts.body).model==='claude-sonnet-5');

  // --- clearing key reverts (statelessness of the toggle)
  r.d.querySelector('#keyIn').value='';
  r.calls().length=0;
  r.d.querySelectorAll('#askChips .chipbtn')[0].click();
  await new Promise(z=>setTimeout(z,150));
  call=r.calls()[0];
  chk('key cleared: header gone again', call && !('x-api-key' in call.opts.headers));
  const src=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
  chk('no storage APIs used for the key', !/localStorage|sessionStorage/.test(src));

  // --- edit mode: correct a svara
  const w=r.w, d=r.d;
  const before=w.SwaraDebug.notes()[0].label;
  d.querySelector('#fixBtn').click();
  chk('edit mode hint shows', !d.querySelector('#fixHint').classList.contains('hide'));
  d.querySelector('#notation .sv:not(.bar)').click();
  const pk=d.querySelector('.picker');
  chk('picker opens on tap', !!pk);
  const target=[...pk.querySelectorAll('.pk-row')[0].querySelectorAll('button')]
    .find(b=>b.textContent!==before);
  const newLabel=target.textContent;
  target.click();
  const after=w.SwaraDebug.notes()[0].label;
  chk('svara corrected: '+before+' \u2192 '+newLabel, after===newLabel, after);
  chk('note flagged edited', !!w.SwaraDebug.notes()[0].edited);
  chk('edited style applied', d.querySelector('#notation .sv').classList.contains('edited'));
  chk('picker closed after choice', !d.querySelector('.picker'));

  // remove a note
  const count0=w.SwaraDebug.notes().length;
  d.querySelectorAll('#notation .sv:not(.bar)')[1].click();
  d.querySelector('.picker button.danger').click();
  chk('remove deletes the note', w.SwaraDebug.notes().length===count0-1);
  d.querySelector('#fixBtn').click();
  chk('edit mode toggles off', d.querySelector('#fixHint').classList.contains('hide'));

  // --- corrections carry into exports (JSON payload path uses n.label)
  const jsonLabels=w.SwaraDebug.notes().map(function(n){return n.label;}).join(',');
  chk('corrected label in export data', jsonLabels.split(',')[0]===newLabel);

  // --- PDF page builder (pure canvas part, no jsPDF needed)
  const pages=w.SwaraDebug.pdfPages().length;
  chk('pdfPages builds at least one page', pages>=1, 'pages='+pages);
  chk('pdf button exists', !!d.querySelector('#pdfBtn'));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
