// Decode real mp3/m4a via ffmpeg (stand-in for browser decodeAudioData),
// then run the actual engine on the decoded samples.
const {execSync} = require('child_process');
const E = require('../engine.js');

function decode(path){
  const raw = execSync(`ffmpeg -v error -i ${path} -f f32le -ac 1 -ar 16000 -`,
    {maxBuffer: 1<<28});
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length/4);
}
const ragam = E.RAGAMS.find(r=>r.name==='Mohanam');
const cfg = { tonicHz:146.83, ragam, temperament:'et', minConf:0.55, silenceRatio:0.045,
  sigma:55, switchPenalty:5.0, silencePenalty:6, minNoteDur:0.06, transientMax:0.12 };
const WANT = 'S R2 G3 P D2 S\u0307';

let pass=0, fail=0;
const FIX = require('path').join(__dirname,'fixtures');
for (const f of ['ref.wav','ref.mp3','ref.m4a','ref_stereo.m4a'].map(n=>require('path').join(FIX,n))) {
  try {
    const x = decode(f);
    const res = E.finishAnalysis(E.yinTrack(x, 16000, {}), cfg);
    const got = res.notes.map(n=>E.renderSvara(n,false)).join(' ');
    const ok = got === WANT;
    console.log((ok?'  PASS  ':'  FAIL  ')+f.padEnd(15)+' -> '+got+
      '   dev '+res.quality.meanAbsDeviation.toFixed(1)+'c');
    ok?pass++:fail++;
  } catch(e){ console.log('  SKIP  '+f+' ('+e.message.split('\n')[0]+')'); }
}
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
