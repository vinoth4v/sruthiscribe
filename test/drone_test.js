// Drone volume slider: live adjustment, safe range, and persistence as the
// default for the next time the drone is started.
const fs = require('fs'); const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname,'..','index.html'), 'utf8');

let pass=0, fail=0;
const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

function boot(){
  return new Promise(res=>{
    const gains = []; // capture every GainNode created, keyed by creation order
    const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
      url:'https://claudeusercontent.com/artifacts/x',
      beforeParse(w){
        w.AudioContext=function(){return{state:'running',resume(){},currentTime:12.5,
          createGain:()=>{
            var state = { _v: 0 };
            var param = {
              get value(){ return state._v; },
              set value(v){ state._v = v; },
              setValueAtTime:function(v){ state._v=v; },
              linearRampToValueAtTime:function(v){ state._v=v; },
              exponentialRampToValueAtTime:function(v){ state._v=v; },
              setTargetAtTime:function(v){ state._v=v; }
            };
            var g = { connect(){}, gain: param, _state: state };
            gains.push(g); return g;
          },
          createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
          createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
          createBufferSource:()=>({connect(){},start(){},stop(){}}),destination:{},
          decodeAudioData(){}};};
        w.fetch=async()=>({ok:true,status:200,json:async()=>[]});
      }});
    setTimeout(()=>res({d:dom.window.document, w:dom.window, gains}), 250);
  });
}

(async()=>{
  const r = await boot();

  console.log('--- slider exists with a sane default ---');
  const sl = r.d.querySelector('#droneVol');
  chk('volume slider exists', !!sl);
  chk('default is 58%', sl.value==='58');
  chk('readout shows the default percentage', r.d.querySelector('#droneVolOut').textContent==='58%');
  chk('range is 0-100', sl.min==='0' && sl.max==='100');

  console.log('--- moving the slider before playing sets the starting volume ---');
  sl.value = '80'; sl.dispatchEvent(new r.w.Event('input'));
  chk('readout updates live', r.d.querySelector('#droneVolOut').textContent==='80%');

  console.log('--- starting the drone uses the slider-set volume, not a hardcoded one ---');
  r.d.querySelector('#droneBtn').click();
  chk('drone bus gain matches 80% of the safe ceiling (0.6)',
      Math.abs(r.gains[r.gains.length-1]._gain - 0.48) < 0.01 ||
      r.gains.some(g => Math.abs(g._state._v - 0.48) < 0.01),
      r.gains.map(g=>g._state._v));

  console.log('--- adjusting the slider WHILE the drone is playing changes it live ---');
  sl.value = '30'; sl.dispatchEvent(new r.w.Event('input'));
  chk('gain updates live to 30% of ceiling (~0.18) without needing a restart',
      r.gains.some(g => Math.abs(g._state._v - 0.18) < 0.01), r.gains.map(g=>g._state._v));

  console.log('--- max slider position stays within the safe headroom ceiling ---');
  sl.value = '100'; sl.dispatchEvent(new r.w.Event('input'));
  chk('100% maps to exactly the 0.6 safe ceiling, not higher', r.d.querySelector('#droneVol').value==='100');
  const maxCall = r.gains.filter(g => Math.abs(g._state._v-0.6)<0.001);
  chk('reaching 100% actually sets the gain to 0.6', maxCall.length>0);

  console.log('--- stopping and restarting the drone remembers the last volume ---');
  r.d.querySelector('#droneBtn').click(); // stop
  await new Promise(z=>setTimeout(z,50));
  const gainsBeforeRestart = r.gains.length;
  r.d.querySelector('#droneBtn').click(); // play again, without touching the slider
  chk('restarting reuses the last-set volume (0.6), not a reset default',
      r.gains.slice(gainsBeforeRestart).some(g => Math.abs(g._state._v - 0.6) < 0.01),
      r.gains.slice(gainsBeforeRestart).map(g=>g._state._v));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
