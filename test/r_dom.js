const fs=require('fs');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
const errs=[];
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
  beforeParse(w){
    w.AudioContext=function(){ return {state:'running',resume(){},currentTime:0,
      createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
      createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
      createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
      createBufferSource:()=>({connect(){},start(){},stop(){}}),
      decodeAudioData(){}, destination:{} }; };
    w.onerror=(m)=>errs.push(String(m));
  }});
const w=dom.window, d=w.document;
setTimeout(()=>{
  const chk=(n,c)=>console.log((c?'  PASS  ':'  FAIL  ')+n);
  chk('12 Sa options built', d.querySelectorAll('#noteSel option').length===12);
  chk('ragam buttons rendered', d.querySelectorAll('#ragamList .rg').length>40);
  chk('default ragam selected', !!d.querySelector('.rg[aria-pressed="true"]'));
  chk('scale text shown', /ārohaṇa/.test(d.querySelector('#scaleOut').innerHTML));
  chk('chip shows Hz', /146\.8/.test(d.querySelector('#chipText').textContent));
  // exercise the ragam filter
  const f=d.querySelector('#ragamFilter'); f.value='moha';
  f.dispatchEvent(new w.Event('input'));
  chk('filter narrows list', d.querySelectorAll('#ragamList .rg').length===1);
  // change sruthi via Hz
  const hz=d.querySelector('#hzIn'); hz.value='196'; hz.dispatchEvent(new w.Event('change'));
  chk('Hz -> note sync (G)', d.querySelector('#noteSel').value==='7');
  // tab switching
  d.querySelectorAll('.tabs button')[1].click();
  chk('tab switch reveals upload pane', d.querySelector('#pane-file').classList.contains('show'));
  chk('no runtime errors on load', errs.length===0);
  if(errs.length) console.log(errs);
},300);
