// End-to-end PDF test: real UI, real decode, real pdfPages canvases, real
// buildPdfBlob bytes -- written to disk for external validation.
const fs=require('fs'); const {JSDOM}=require('jsdom');

// The DOM under test has no rasteriser (see test/lib/canvas-shim.js), so the
// page images are stubs and a byte count measures the shim rather than the
// PDF writer. Check the structure instead: a well-formed file with one image
// per page is what the writer is responsible for.
function pdfStructure(buf){
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const images = (s.match(/\/Subtype\s*\/Image/g) || []).length;
  return {
    pages, images,
    header: s.slice(0, 5) === '%PDF-',
    eof: s.slice(-8).includes('%%EOF'),
    xref: /\bxref\b/.test(s) && /\btrailer\b/.test(s),
    jpeg: /\/DCTDecode/.test(s),
    bytes: buf.length,
  };
}
const canvasShim=require('./lib/canvas-shim');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');

function synthTone(sr,dur,tonicHz){
  const n=Math.round(sr*dur),x=new Float32Array(n);
  const seq=[0,200,400,700,900,1200,900,700,400,200,0,400,700,900,1200,900]; let ph=0;
  for(let i=0;i<n;i++){const seg=Math.floor(i/(n/seq.length));
    const f=tonicHz*Math.pow(2,seq[Math.min(seg,seq.length-1)]/1200); ph+=2*Math.PI*f/sr;
    const env=Math.min(1,i/(0.02*sr))*Math.min(1,(n-i)/(0.02*sr));
    x[i]=0.3*env*(Math.sin(ph)+0.4*Math.sin(2*ph));}
  return x;
}
(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};

  const sr=44100,dur=8.0,samples=synthTone(sr,dur,146.83);
  const fakeBuffer={duration:dur,numberOfChannels:1,sampleRate:sr,length:samples.length,
    getChannelData(){return samples;}};
  let savedBlobParts=null;
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,
    url:'https://claudeusercontent.com/artifacts/x',
    beforeParse(w){ canvasShim.install(w);
      w.AudioContext=function(){return{state:'running',resume(){},currentTime:0,
        createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
        createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
        createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
        createBufferSource:()=>({connect(){},start(){},stop(){}}),destination:{},
        decodeAudioData(a,ok){ok(fakeBuffer);}};};
      w.fetch=async(url)=>{
        if(String(url).includes('supabase')) return {ok:true,status:200,json:async()=>[]};
        return {ok:true,status:200,json:async()=>({content:[{type:'text',text:'x'}]})};
      };
      w.Element.prototype.scrollIntoView=function(){};
      w.FileReader=function(){this.readAsArrayBuffer=function(){var s=this;
        setTimeout(()=>{s.result=new ArrayBuffer(8); if(s.onload) s.onload();},0);};};
      // Capture the Blob the app builds
      const RealBlob = w.Blob;
      w.Blob = function(parts, opts){ savedBlobParts = {parts, opts}; return new RealBlob(parts, opts); };
      w.URL.createObjectURL = ()=>'blob:fake';
      w.URL.revokeObjectURL = ()=>{};
    }});
  await new Promise(z=>setTimeout(z,250));
  const w=dom.window,d=w.document;
  const file=new w.File(['x'],'t.wav',{type:'audio/wav'});
  const input=d.querySelector('#fileIn');
  Object.defineProperty(input,'files',{value:[file],configurable:true});
  input.dispatchEvent(new w.Event('change'));
  await new Promise(z=>setTimeout(z,120));
  const filt=d.querySelector('#ragamFilter'); filt.value='Mohanam'; filt.dispatchEvent(new w.Event('input'));
  await new Promise(z=>setTimeout(z,80));
  d.querySelector('#ragamList .rg').click();
  d.querySelector('#goBtn').click();
  for (let t=0;t<150 && d.querySelector('#resultStep').classList.contains('hide'); t++)
    await new Promise(z=>setTimeout(z,50));
  chk('reading completed', !d.querySelector('#resultStep').classList.contains('hide'));
  const noteCount = w.SwaraDebug.notes().filter(n=>!n.transit).length;
  chk('has a healthy number of svaras', noteCount >= 10, noteCount);

  // Click the real PDF button
  d.querySelector('#pdfBtn').click();
  await new Promise(z=>setTimeout(z,300));
  chk('status says PDF saved', /PDF saved/.test(d.querySelector('#status').textContent),
      d.querySelector('#status').textContent);
  chk('a Blob was built', !!savedBlobParts);
  chk('blob typed application/pdf', savedBlobParts.opts && savedBlobParts.opts.type === 'application/pdf');

  // Reassemble the exact bytes and write to disk for external validation
  let total=0; savedBlobParts.parts.forEach(p=>total+=p.length);
  const buf = Buffer.alloc(total); let off=0;
  savedBlobParts.parts.forEach(p=>{ Buffer.from(p).copy(buf, off); off+=p.length; });
  fs.writeFileSync(require('os').tmpdir()+'/swarascribe_test.pdf', buf);
  const st = pdfStructure(buf);
  chk('PDF is well formed (header, xref, trailer, EOF)',
      st.header && st.xref && st.eof, JSON.stringify(st));
  chk('PDF has at least one page and an image for each',
      st.pages >= 1 && st.images === st.pages, JSON.stringify(st));
  chk('page images are JPEG-encoded', st.jpeg, JSON.stringify(st));
  chk('starts with %PDF header', buf.slice(0,5).toString()==='%PDF-');
  chk('ends with %%EOF', buf.slice(-6).toString().includes('%%EOF'));
  console.log('    wrote /tmp/swarascribe_test.pdf ('+buf.length+' bytes) for external validation');

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
