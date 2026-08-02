// UX redesign tests: hero condensed, setup collapses after a reading and is
// reversible, the notation toolbar carries Fix mistakes + Speed, and the
// summary line reports the real settings rather than placeholder text.
const fs = require('fs'); const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'), 'utf8');

let pass=0, fail=0;
const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

function synthTone(sr,dur,tonicHz,seq){
  const n=Math.round(sr*dur),x=new Float32Array(n); let ph=0;
  for(let i=0;i<n;i++){const seg=Math.floor(i/(n/seq.length));
    const f=tonicHz*Math.pow(2,seq[Math.min(seg,seq.length-1)]/1200); ph+=2*Math.PI*f/sr;
    const env=Math.min(1,i/(0.02*sr))*Math.min(1,(n-i)/(0.02*sr));
    x[i]=0.3*env*(Math.sin(ph)+0.4*Math.sin(2*ph));}
  return x;
}
function boot(){
  return new Promise(res=>{
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext=function(){return{state:'running',resume(){},currentTime:0,
          createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
          createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
          createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
          createBufferSource:()=>({connect(){},start(){},stop(){}}),destination:{},
          decodeAudioData(a,ok){ ok(w.__fakeBuffer); }};};
        w.fetch=async()=>({ok:true,status:200,json:async()=>[]});
        w.Element.prototype.scrollIntoView=function(){};
        w.IntersectionObserver = function(cb){ this.observe=function(){}; this.disconnect=function(){}; };
      }});
    setTimeout(()=>res({d:dom.window.document, w:dom.window}), 250);
  });
}

(async()=>{
  console.log('--- hero: condensed, with detail available but not forced ---');
  let r = await boot();
  const hero = r.d.querySelector('#hero');
  const heroParas = hero.querySelectorAll(':scope > p');
  chk('hero shows exactly one always-visible line, not a wall of paragraphs',
      heroParas.length === 1, heroParas.length);
  chk('the one line names the app and what it does', /SruthiScribe/.test(heroParas[0].textContent) &&
      /svara/i.test(heroParas[0].textContent));
  const more = r.d.querySelector('#heroMore');
  chk('the fuller explanation exists behind a disclosure, not deleted', !!more &&
      /community library/i.test(more.textContent));
  chk('the disclosure is collapsed by default', !more.hasAttribute('open'));
  chk('the AI teacher is still described in the detail', /Claude/.test(more.textContent));

  console.log('--- notation toolbar: Fix mistakes promoted, Speed relocated here ---');
  const bar = r.d.querySelector('#notationBar');
  chk('a dedicated notation toolbar exists', !!bar);
  chk('Fix mistakes is inside the toolbar', bar.querySelector('#fixBtn') !== null);
  chk('Fix mistakes is styled as the primary action, not one ghost among six',
      bar.querySelector('#fixBtn').classList.contains('primary'));
  chk('Speed lives in the toolbar next to the notation', bar.querySelector('#speedSel') !== null);
  chk('Speed no longer sits in the setup tala row',
      r.d.querySelector('#setupWrap #speedSel') === null);
  chk('exactly one Speed control exists in the whole page (no duplicate ids)',
      r.d.querySelectorAll('#speedSel').length === 1);
  chk('Speed still offers 1x through 8x',
      [...bar.querySelectorAll('#speedSel option')].map(o=>o.value).join()==='1,2,3,4,8');
  chk('Talam and Jathi stay in setup (they describe the piece, not the view)',
      r.d.querySelector('#setupWrap #talaSel') !== null &&
      r.d.querySelector('#setupWrap #jathiSel') !== null);
  ['transitBtn','marksBtn','copyBtn','jsonBtn','pdfBtn'].forEach(id=>{
    chk('secondary action #'+id+' is grouped away from the primary action',
        bar.querySelector('.nbar-rest #'+id) !== null);
  });

  console.log('--- setup starts expanded, summary hidden ---');
  chk('setup is visible before any reading', !r.d.querySelector('#setupWrap').classList.contains('hide'));
  chk('the summary strip is hidden before any reading',
      r.d.querySelector('#setupSummary').classList.contains('hide'));

  console.log('--- after a reading: setup collapses to a real summary line ---');
  const sr=44100, dur=8.0;
  const samples = synthTone(sr,dur,146.83,[0,200,400,700,900,1200,900,700,400,200,0,400]);
  const fakeBuffer={duration:dur,numberOfChannels:1,sampleRate:sr,length:samples.length,getChannelData(){return samples;}};
  r = await boot();
  r.w.eval("window.__setBuf=function(b){window.__fakeBuffer=b;}");
  r.w.__setBuf(fakeBuffer);
  const file=new r.w.File(['x'],'my-practice.wav',{type:'audio/wav'});
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
  chk('setup collapsed once the reading appeared', r.d.querySelector('#setupWrap').classList.contains('hide'));
  chk('the summary strip is now visible', !r.d.querySelector('#setupSummary').classList.contains('hide'));

  const sumText = r.d.querySelector('#setupSummaryText').textContent;
  chk('summary reports the real Sa, not a placeholder', /Sa\s+\w/.test(sumText) && /Hz/.test(sumText), sumText);
  chk('summary reports the chosen ragam', /Mohanam/.test(sumText), sumText);
  chk('summary reports the tala', /Adi|Triputa/.test(sumText), sumText);
  chk('summary reports the loaded filename', /my-practice\.wav/.test(sumText), sumText);

  console.log('--- the collapse is reversible, not a one-way door ---');
  r.d.querySelector('#setupSummary').click();
  chk('tapping the strip reopens setup', !r.d.querySelector('#setupWrap').classList.contains('hide'));
  chk('the strip hides itself once setup is open again',
      r.d.querySelector('#setupSummary').classList.contains('hide'));
  chk('the sruthi controls are genuinely reachable again',
      r.d.querySelector('#setupWrap #noteSel') !== null);

  console.log('--- keyboard accessibility on the summary strip ---');
  const strip = r.d.querySelector('#setupSummary');
  chk('the strip is focusable', strip.getAttribute('tabindex') === '0');
  chk('the strip announces itself as a control', strip.getAttribute('role') === 'button');
  // Collapse again the way a user would -- by running another reading -- then
  // reopen with the keyboard rather than the mouse.
  r.d.querySelector('#goBtn').click();
  for (let t=0;t<150 && !r.d.querySelector('#setupWrap').classList.contains('hide'); t++)
    await new Promise(z=>setTimeout(z,50));
  chk('collapsed again after a re-read', r.d.querySelector('#setupWrap').classList.contains('hide'));
  strip.dispatchEvent(new r.w.KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  chk('Enter reopens setup', !r.d.querySelector('#setupWrap').classList.contains('hide'));

  console.log('--- speed still drives the notation from its new home ---');
  const before = r.d.querySelectorAll('#notation .avline').length;
  const sp = r.d.querySelector('#speedSel');
  sp.value = '8'; sp.dispatchEvent(new r.w.Event('change'));
  chk('changing speed from the toolbar still re-renders the notation',
      r.d.querySelector('#talaHead').textContent.includes('8x') ||
      r.d.querySelectorAll('#notation .avline').length !== before,
      'talaHead: '+r.d.querySelector('#talaHead').textContent);

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
