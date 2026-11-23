(() => {
  const $ = id => document.getElementById(id);
  const colors = ['#a78bfa','#38bdf8','#fb7185','#34d399','#fbbf24','#f472b6'];
  const playerId = Math.random().toString(36).slice(2,10);
  const color = colors[Math.floor(Math.random()*colors.length)];
  let socket, room, me, players = [], muted = false, midiAccess;
  const active = new Map(), oscillators = new Map(), held = new Map();
  let audio, soundfontSynth = null, incomingSf2Info = null, loadingSf2 = false;
  // VirtualPiano-style mapping: 36 consecutive white keys from C2 to C7.
  // Hold Shift with a mapped key to play the black key immediately above it.
  const keyboardKeys = '1234567890qwertyuiopasdfghjklzxcvbnm'.split('');
  const shiftedLabels = {'1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')'};
  const keyMap = new Map(keyboardKeys.map((key,index)=>[key,index]));
  const names = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const whiteSemitones = [0,2,4,5,7,9,11];
  const whiteNotes = Array.from({length:36},(_,i)=>36+Math.floor(i/7)*12+whiteSemitones[i%7]);
  const blackNotes = whiteNotes.slice(0,-1).map((note,index)=>({note:note+1,index})).filter(({note,index})=>whiteNotes[index+1]-whiteNotes[index]===2);
  function send(data){ if(socket && socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify(data)); }
  function connect(){ return new Promise((resolve,reject)=>{
    const protocol = location.protocol==='https:'?'wss:':'ws:';
    socket = new WebSocket(`${protocol}//${location.host}`);
    socket.binaryType = 'arraybuffer';
    socket.onopen=resolve; socket.onerror=()=>reject(new Error('Could not connect to the PianoHub server.'));
    socket.onmessage=e=>{ if(typeof e.data === 'string') handle(JSON.parse(e.data)); else handleSoundfontBinary(e.data); };
    socket.onclose=()=>{ if(room) showError('Connection to the room was lost.'); };
  });}
  function showError(text){ $('lobby-error').textContent=text; }
  function enter(data){
    room=data.room; players=data.players||[]; me=players.find(p=>p.id===playerId)||{id:playerId,name:$('nickname').value.trim()||'Pianist',color};
    $('room-title').textContent=room.name; $('copy').textContent=room.code+' ⧉ Invite';
    $('lobby').classList.add('hidden'); $('session').classList.remove('hidden');
    renderPlayers(); $('messages').innerHTML='<div class="empty">Say hi to the room 👋</div>';
    soundfontSynth = null; incomingSf2Info = null; loadingSf2 = false;
    $('sf2-status').textContent='No shared SF2 loaded · using default sound';
    initMIDI(); window.scrollTo(0,0);
  }
  function handle(msg){
    if(msg.type==='error'){showError(msg.message);return;}
    if(msg.type==='joined'){enter(msg);return;}
    if(msg.type==='join'){if(!players.some(p=>p.id===msg.player.id))players.push(msg.player);renderPlayers();return;}
    if(msg.type==='leave'){players=players.filter(p=>p.id!==msg.playerId);renderPlayers();return;}
    if(msg.type==='note-on'){if(msg.player.id!==playerId){highlight(msg.note,msg.player);toneOn(msg.note,.65);}return;}
    if(msg.type==='note-off'){if(active.get(msg.note)?.id!==msg.player.id)return;highlightOff(msg.note);toneOff(msg.note);return;}
    if(msg.type==='sf2-info'){incomingSf2Info=msg.info;$('sf2-status').textContent=`${msg.info.name} · shared by ${msg.info.by} · loading…`;return;}
    if(msg.type==='chat')addMessage(msg.player,msg.text);
  }
  function renderPlayers(){
    $('player-count').textContent=players.length+' '+(players.length===1?'pianist':'pianists')+' playing';$('side-count').textContent=players.length;
    $('avatars').innerHTML=players.slice(0,6).map(p=>`<div class="avatar" style="background:${p.color}" title="${escapeHTML(p.name)}">${escapeHTML(p.name[0].toUpperCase())}</div>`).join('');
    $('player-list').innerHTML=players.map(p=>`<div class="player-row"><div class="avatar" style="width:27px;height:27px;background:${p.color}">${escapeHTML(p.name[0].toUpperCase())}</div><span>${escapeHTML(p.name)}${p.id===playerId?' (you)':''}</span><i style="background:${p.color}"></i></div>`).join('');
  }
  function escapeHTML(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function addMessage(player,text){const empty=$('messages').querySelector('.empty');if(empty)empty.remove();const div=document.createElement('div');div.className='message';div.innerHTML=`<b style="color:${player.color}">${escapeHTML(player.name)}</b><p>${escapeHTML(text)}</p>`;$('messages').append(div);$('messages').scrollTop=$('messages').scrollHeight;}
  function buildPiano(){
    const piano=$('piano');
    whiteNotes.forEach((note,index)=>{const key=document.createElement('button');key.className='white-key';key.dataset.note=note;key.id='note-'+note;const label=keyboardKeys[index];key.innerHTML=`<span>${names[note%12]}</span><small class="computer-label">${label}</small>${note%12===0?`<small class="octave-label">${Math.floor(note/12)-1}</small>`:''}`;key.setAttribute('aria-label',`${names[note%12]}, computer key ${label}`);bindPointer(key,note);piano.append(key);});
    blackNotes.forEach(({note,index})=>{const key=document.createElement('button');key.className='black-key';key.dataset.note=note;key.id='note-'+note;key.style.left=`calc(${((index+1)/36)*100}% - 11px)`;const label=keyboardKeys[index];key.innerHTML=`<small>${shiftedLabels[label]||label.toUpperCase()}</small>`;key.setAttribute('aria-label',`${names[note%12]}, Shift plus ${label}`);bindPointer(key,note);piano.append(key);});
  }
  function bindPointer(key,n){key.addEventListener('pointerdown',e=>{e.preventDefault();key.setPointerCapture(e.pointerId);noteOn(n);});key.addEventListener('pointerup',()=>noteOff(n));key.addEventListener('pointercancel',()=>noteOff(n));key.addEventListener('lostpointercapture',()=>noteOff(n));}
  function toneOn(note,velocity=.8){if(muted)return;try{if(soundfontSynth){if(audio&&audio.state==='suspended')audio.resume();soundfontSynth.noteOn(0,note,Math.max(1,Math.min(127,Math.round(velocity*127))));return;}audio=audio||new AudioContext();if(audio.state==='suspended')audio.resume();if(oscillators.has(note))return;const osc=audio.createOscillator(),gain=audio.createGain();osc.type='triangle';osc.frequency.value=440*Math.pow(2,(note-69)/12);gain.gain.setValueAtTime(.0001,audio.currentTime);gain.gain.exponentialRampToValueAtTime(Math.max(.02,velocity*.18),audio.currentTime+.015);osc.connect(gain);gain.connect(audio.destination);osc.start();oscillators.set(note,{osc,gain});}catch(e){}}
  function toneOff(note){if(soundfontSynth){try{soundfontSynth.noteOff(0,note);}catch(e){}return;}const item=oscillators.get(note);if(!item)return;try{item.gain.gain.cancelScheduledValues(audio.currentTime);item.gain.gain.setTargetAtTime(.0001,audio.currentTime,.04);item.osc.stop(audio.currentTime+.18);}catch(e){}oscillators.delete(note);}
  function highlight(note,player=me){active.set(note,player);const key=$(`note-${note}`);if(key){key.classList.add('pressed');key.style.setProperty('--unused',player.color);key.style.background=key.classList.contains('white-key')?`linear-gradient(180deg,${player.color},#c9b5ff)`:player.color;}}
  function highlightOff(note){active.delete(note);const key=$(`note-${note}`);if(key){key.classList.remove('pressed');key.style.background='';}}
  function noteOn(note,velocity=.8){if(active.has(note))return;highlight(note,me);toneOn(note,velocity);send({type:'note-on',note});}
  function noteOff(note){if(!active.has(note))return;highlightOff(note);toneOff(note);send({type:'note-off',note});}
  async function loadSharedSoundfont(buffer){
    if(loadingSf2)return;
    loadingSf2=true;
    $('sf2-status').textContent=`Loading ${incomingSf2Info?.name||'shared soundfont'}…`;
    try{
      audio=audio||new AudioContext();
      await audio.resume();
      const {WorkletSynthesizer}=await import('https://esm.sh/spessasynth_lib@4.4.10?bundle');
      await audio.audioWorklet.addModule('https://cdn.jsdelivr.net/npm/spessasynth_lib@4.4.10/dist/spessasynth_processor.min.js');
      const nextSynth=new WorkletSynthesizer(audio);
      await nextSynth.soundBankManager.addSoundBank(buffer,'PianoHub room soundfont');
      await nextSynth.isReady;
      // WorkletSynthesizer does not automatically route audio to the speakers.
      nextSynth.connect(audio.destination);
      nextSynth.programChange(0,0);
      soundfontSynth=nextSynth;
      $('sf2-status').textContent=`${incomingSf2Info?.name||'Shared soundfont'} · loaded for everyone`;
    }catch(error){
      console.error('SF2 load failed:',error);
      $('sf2-status').textContent='Could not load this SF2 · check the file and refresh';
      showError('The shared SF2 could not be loaded in this browser.');
    }finally{loadingSf2=false;}
  }
  function handleSoundfontBinary(buffer){
    if(!(buffer instanceof ArrayBuffer))return;
    loadSharedSoundfont(buffer);
  }
  $('sf2-file').addEventListener('change',async event=>{
    const file=event.target.files?.[0];
    if(!file)return;
    if(!file.name.toLowerCase().endsWith('.sf2')){ $('sf2-status').textContent='Please choose an .sf2 file';event.target.value='';return; }
    if(file.size>48*1024*1024){ $('sf2-status').textContent='That file is over the 48 MB limit';event.target.value='';return; }
    try{
      const buffer=await file.arrayBuffer();
      const bytes=new Uint8Array(buffer);
      if(bytes.length<12||String.fromCharCode(...bytes.slice(0,4))!=='RIFF'||String.fromCharCode(...bytes.slice(8,12))!=='sfbk'){
        $('sf2-status').textContent='That file is not a valid SF2 soundfont';event.target.value='';return;
      }
      if(!socket||socket.readyState!==WebSocket.OPEN){$('sf2-status').textContent='Join a room before uploading';event.target.value='';return;}
      $('sf2-status').textContent=`Sending ${file.name} to everyone…`;
      send({type:'sf2-upload-start',name:file.name,size:file.size});
      socket.send(buffer);
    }catch(error){console.error(error);$('sf2-status').textContent='Could not read that file';}
    event.target.value='';
  });
  function initMIDI(){
    if(!navigator.requestMIDIAccess){$('midi-status').textContent='Web MIDI is not supported in this browser';return;}
    navigator.requestMIDIAccess().then(access=>{midiAccess=access;refreshMIDI();access.onstatechange=refreshMIDI;}).catch(()=>$('midi-status').textContent='MIDI permission was not granted');
  }
  function refreshMIDI(){
    const inputs=[...midiAccess.inputs.values()],select=$('midi-select');select.innerHTML='';
    inputs.forEach((input,i)=>{const option=document.createElement('option');option.value=input.id;option.textContent=input.name||`MIDI device ${i+1}`;select.append(option);});
    select.classList.toggle('hidden',inputs.length===0);$('midi-status').textContent=inputs.length?`${inputs.length} MIDI input${inputs.length===1?'':'s'} found`:'No MIDI device found';$('midi-dot').classList.toggle('on',inputs.length>0);
    inputs.forEach(input=>input.onmidimessage=null);attachMIDI();
  }
  function attachMIDI(){if(!midiAccess)return;const input=midiAccess.inputs.get($('midi-select').value)||midiAccess.inputs.values().next().value;if(!input)return;input.onmidimessage=e=>{const [status,note,velocity]=e.data,cmd=status&0xf0;if(cmd===0x90&&velocity>0)noteOn(note,velocity/127);else if(cmd===0x80||(cmd===0x90&&velocity===0))noteOff(note);};}
  $('midi-select').addEventListener('change',attachMIDI);
  $('create').onclick=async()=>{audio=audio||new AudioContext();audio.resume().catch(()=>{});const name=$('nickname').value.trim()||'Pianist';localStorage.setItem('pianohub-name',name);showError('');try{await connect();send({type:'create',name,roomName:$('roomname').value,playerId,color});}catch(e){showError(e.message+' Run npm start on the host computer first.');}};
  $('join').onclick=async()=>{audio=audio||new AudioContext();audio.resume().catch(()=>{});const name=$('nickname').value.trim()||'Pianist',code=$('code').value.trim().toUpperCase();if(!code){showError('Enter a room code.');return;}localStorage.setItem('pianohub-name',name);showError('');try{await connect();send({type:'join',name,code,playerId,color});}catch(e){showError(e.message);}};
  $('leave').onclick=()=>{if(socket)socket.close();socket=null;room=null;active.forEach((p,n)=>toneOff(n));active.clear();$('session').classList.add('hidden');$('lobby').classList.remove('hidden');$('lobby-error').textContent='';};
  $('copy').onclick=async()=>{try{await navigator.clipboard.writeText(room.code);$('copy').textContent='Copied!';setTimeout(()=>$('copy').textContent=room.code+' ⧉ Invite',1200);}catch(e){$('copy').textContent=room.code;}};
  $('mute').onclick=()=>{muted=!muted;$('mute').textContent=muted?'◖ Sound off':'◖ Sound on';if(muted){[...oscillators.keys()].forEach(toneOff);}};
  $('chat-form').onsubmit=e=>{e.preventDefault();const text=$('chat-input').value.trim();if(!text)return;addMessage(me,text);send({type:'chat',text});$('chat-input').value='';};
  function computerKeyForCode(code){if(code.startsWith('Key'))return code.slice(3).toLowerCase();if(code.startsWith('Digit'))return code.slice(5);return null;}
  window.addEventListener('keydown',e=>{if(!$('session').classList.contains('hidden')&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){const key=computerKeyForCode(e.code);if(key!==null&&keyMap.has(key)&&!held.has(e.code)){const index=keyMap.get(key),white=whiteNotes[index],pitch=white%12;const isBlack=e.shiftKey&&[0,2,5,7,9].includes(pitch);const note=white+(isBlack?1:0);held.set(e.code,note);noteOn(note);if(key===' '||e.code==='Space')e.preventDefault();}}});
  window.addEventListener('keyup',e=>{if(held.has(e.code)){noteOff(held.get(e.code));held.delete(e.code);}});
  window.addEventListener('blur',()=>{held.forEach(note=>noteOff(note));held.clear();});
  $('nickname').value=localStorage.getItem('pianohub-name')||'';
  buildPiano();
})();