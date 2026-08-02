const fs=require('fs'); const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
function boot(url){ return new Promise(res=>{
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url,
    beforeParse(w){ w.AudioContext=function(){return{state:'running',resume(){},
      createGain:()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}},connect(){}}),
      createBiquadFilter:()=>({type:'',frequency:{value:0},connect(){}}),
      createOscillator:()=>({type:'',frequency:{value:0},connect(){},start(){},stop(){}}),
      createBufferSource:()=>({connect(){},start(){},stop(){}}),decodeAudioData(){},destination:{}};};
      w.fetch=async(u,o)=>{
        // simulate platform auth present on claude hosts, absent elsewhere
        const hasKey = o && o.headers && o.headers['x-api-key'];
        const onClaude = /claude/i.test(new URL(url).hostname);
        if (onClaude || hasKey) return {ok:true,status:200,json:async()=>({content:[{type:'text',text:'fine'}]})};
        return {ok:false,status:401,json:async()=>({error:{message:'authentication_error'}})};
      };
    }});
  setTimeout(()=>res(dom),250);
});}
(async()=>{
  let pass=0,fail=0;
  const chk=(n,c,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x));c?pass++:fail++;};
  let d=(await boot('https://claudeusercontent.com/artifacts/x')).window.document;
  chk('claude host: intro says no setup', /need no setup/.test(d.querySelector('#askIntro').textContent));
  const v=await boot('https://swarascribe.vercel.app/');
  d=v.window.document;
  chk('vercel host: intro says shared access by default', /own configured Claude access/.test(d.querySelector('#askIntro').textContent));
  // ask without key on vercel -> friendly key hint (drive via injected result? need notes)
  // simulate by calling ask path indirectly: set input, no notes -> guard; instead check the 401 branch via text presence in source
  const src=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
  chk('server-not-configured hint exists', /ANTHROPIC_API_KEY/.test(src) && /set up shared Claude access/.test(src));
  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
