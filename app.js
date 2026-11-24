(() => {
  const $ = id => document.getElementById(id);
  const colors = ['#a78bfa','#38bdf8','#fb7185','#34d399','#fbbf24','#f472b6'];
  const playerId = Math.random().toString(36).slice(2,10);
  const color = colors[Math.floor(Math.random()*colors.length)];
  let socket, room, me, players = [], muted = false, midiAccess;
  const active = new Map(), oscillators = new Map(), held = new Map();
  let audio, soundfontSynth = null, defaultSynth = null, defaultSynthPromise = null, loadingSf2 = false;
  const localSoundfonts = new Map(), synthForNote = new Map(), remoteSynths = new Map(), remoteLoading = new Set(), remoteSelected = new Map();
  // Full 88-key piano: A0 (MIDI 21) through C8 (MIDI 108).
  // Computer-key mapping covers the central five-octave range C2-C7;
  // hold Shift with a mapped key to play the black key immediately above it.
  const keyboardKeys = '1234567890qwertyuiopasdfghjklzxcvbnm'.split('');
  const shiftedLabels = {'1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')'};
  const keyMap = new Map(keyboardKeys.map((key,index)=>[key,index]));
  const names = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const whitePitchClasses = new Set([0,2,4,5,7,9,11]);
  const whiteNotes = Array.from({length:88},(_,i)=>21+i).filter(note=>whitePitchClasses.has(note%12));
  const keyboardStartIndex = whiteNotes.indexOf(36); // C2
  const blackNotes = whiteNotes.slice(0,-1).map((note,index)=>({note:note+1,index})).filter(({index})=>whiteNotes[index+1]-whiteNotes[index]===2);
  function send(data){ if(socket && socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify(data)); }
  function connect(){ return new Promise((resolve,reject)=>{
    const protocol = location.protocol==='https:'?'wss:':'ws:';
    socket = new WebSocket(`${protocol}//${location.host}`);
    socket.binaryType = 'arraybuffer';
    socket.onopen=resolve; socket.onerror=()=>reject(new Error('Could not connect to the PianoHub server.'));
    socket.onmessage=e=>{ if(typeof e.data === 'string') handle(JSON.parse(e.data)); else receiveSoundfontPacket(e.data); };
    socket.onclose=()=>{ if(room) showError('Connection to the room was lost.'); };
  });}
  function showError(text){ $('lobby-error').textContent=text; }
  function enter(data){
    room=data.room; players=data.players||[]; me=players.find(p=>p.id===playerId)||{id:playerId,name:$('nickname').value.trim()||'Pianist',color};
    $('room-title').textContent=room.name; $('copy').textContent=room.code+' ⧉ Invite';
    $('lobby').classList.add('hidden'); $('session').classList.remove('hidden');
    renderPlayers(); $('messages').innerHTML='<div class="empty">Say hi to the room 👋</div>';
    loadingSf2 = false;
    $('sf2-status').textContent=localSoundfonts.size ? `${localSoundfonts.size} personal SF2 file(s) available` : 'Your soundfont · other players hear your selected instrument';
    ensureDefaultSynth().catch(error=>{console.error(error);$('sf2-status').textContent='Could not load bundled default piano';}); players.filter(p=>p.id!==playerId).forEach(p=>{remoteSelected.set(p.id,p.soundfontId||'');if(!p.soundfontId)loadRemoteDefault(p.id);}); initMIDI(); window.scrollTo(0,0);
  }
  function handle(msg){
    if(msg.type==='public-rooms'){renderPublicRooms(msg.rooms||[]);return;}
    if(msg.type==='error'){showError(msg.message);return;}
    if(msg.type==='joined'){enter(msg);return;}
    if(msg.type==='join'){if(!players.some(p=>p.id===msg.player.id))players.push(msg.player);remoteSelected.set(msg.player.id,msg.player.soundfontId||'');if(!msg.player.soundfontId)loadRemoteDefault(msg.player.id);renderPlayers();return;}
    if(msg.type==='leave'){players=players.filter(p=>p.id!==msg.playerId);remoteSelected.delete(msg.playerId);const old=remoteSynths.get(msg.playerId);if(old){try{old.disconnect();}catch(e){}remoteSynths.delete(msg.playerId);}renderPlayers();return;}
    if(msg.type==='note-on'){if(msg.player.id!==playerId){highlight(msg.note,msg.player);toneOnForPlayer(msg.player.id,msg.note,.72);}return;}
    if(msg.type==='note-off'){if(active.get(msg.note)?.id!==msg.player.id)return;highlightOff(msg.note);toneOffForPlayer(msg.player.id,msg.note);return;}
    if(msg.type==='soundfont-select'){remoteSelected.set(msg.playerId,msg.soundfontId||'');if(!msg.soundfontId)loadRemoteDefault(msg.playerId);$('sf2-status').textContent=`Your sound: ${soundfontSynth?'custom SF2':'Full Grand Piano'} · other players use their own sounds`;return;}
    if(msg.type==='chat')addMessage(msg.player,msg.text);
  }
  function renderPlayers(){
    $('player-count').textContent=players.length+' '+(players.length===1?'pianist':'pianists')+' playing';$('side-count').textContent=players.length;
    $('avatars').innerHTML=players.slice(0,6).map(p=>`<div class="avatar" style="background:${p.color}" title="${escapeHTML(p.name)}">${escapeHTML(p.name[0].toUpperCase())}</div>`).join('');
    $('player-list').innerHTML=players.map(p=>`<div class="player-row"><div class="avatar" style="width:27px;height:27px;background:${p.color}">${escapeHTML(p.name[0].toUpperCase())}</div><span>${escapeHTML(p.name)}${p.id===playerId?' (you)':''}</span><i style="background:${p.color}"></i></div>`).join('');
  }
  function escapeHTML(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function renderPublicRooms(rooms){
    const list=$('public-rooms');
    if(!rooms.length){list.innerHTML='<div class="public-empty">No public rooms right now. Create one and be the first! 🎹</div>';return;}
    list.innerHTML=rooms.map(r=>`<div class="public-room"><div class="public-room-info"><b>${escapeHTML(r.name)}</b><span>${r.playerCount} ${r.playerCount===1?'player':'players'} · ${escapeHTML(r.code)}</span></div><button class="public-join" data-code="${escapeHTML(r.code)}">Join</button></div>`).join('');
  }
  function addMessage(player,text){const empty=$('messages').querySelector('.empty');if(empty)empty.remove();const div=document.createElement('div');div.className='message';div.innerHTML=`<b style="color:${player.color}">${escapeHTML(player.name)}</b><p>${escapeHTML(text)}</p>`;$('messages').append(div);$('messages').scrollTop=$('messages').scrollHeight;}
  function buildPiano(){
    const piano=$('piano');
    whiteNotes.forEach((note,index)=>{const key=document.createElement('button');key.className='white-key';key.dataset.note=note;key.id='note-'+note;const mapped=index>=keyboardStartIndex&&index<keyboardStartIndex+keyboardKeys.length;const label=mapped?keyboardKeys[index-keyboardStartIndex]:'';key.innerHTML=`<span>${names[note%12]}</span>${mapped?`<small class="computer-label">${label}</small>`:''}${note%12===0?`<small class="octave-label">${Math.floor(note/12)-1}</small>`:''}`;key.setAttribute('aria-label',`${names[note%12]}${mapped?', computer key '+label:''}`);bindPointer(key,note);piano.append(key);});
    blackNotes.forEach(({note,index})=>{const key=document.createElement('button');key.className='black-key';key.dataset.note=note;key.id='note-'+note;key.style.left=`calc(${((index+1)/whiteNotes.length)*100}% - clamp(5px, 1.15vw, 19px))`;const mapped=index>=keyboardStartIndex&&index<keyboardStartIndex+keyboardKeys.length;const label=mapped?keyboardKeys[index-keyboardStartIndex]:'';key.innerHTML=mapped?`<small>${shiftedLabels[label]||label.toUpperCase()}</small>`:'';key.setAttribute('aria-label',`${names[note%12]}${mapped?', Shift plus '+label:''}`);bindPointer(key,note);piano.append(key);});
  }
  function bindPointer(key,n){key.addEventListener('pointerdown',e=>{e.preventDefault();key.setPointerCapture(e.pointerId);noteOn(n);});key.addEventListener('pointerup',()=>noteOff(n));key.addEventListener('pointercancel',()=>noteOff(n));key.addEventListener('lostpointercapture',()=>noteOff(n));}
  function makeSoundfontPacket(meta, buffer){
    const header=new TextEncoder().encode(JSON.stringify(meta));
    const packet=new Uint8Array(4+header.length+buffer.byteLength);
    new DataView(packet.buffer).setUint32(0,header.length,false);
    packet.set(header,4);packet.set(new Uint8Array(buffer),4+header.length);
    return packet;
  }
  function receiveSoundfontPacket(data){
    try{
      const bytes=new Uint8Array(data),headerLength=new DataView(data).getUint32(0,false);
      const meta=JSON.parse(new TextDecoder().decode(bytes.slice(4,4+headerLength)));
      const buffer=bytes.slice(4+headerLength).buffer;
      if(meta.type==='soundfont'&&meta.playerId!==playerId){
        loadRemoteSoundfont(meta.playerId,meta.soundfontId,meta.name,buffer);
      }
    }catch(error){console.error("Could not receive a player's soundfont:",error);}
  }
  async function createSynthFromBuffer(buffer,name){
    audio=audio||new AudioContext();
    const {WorkletSynthesizer}=await import('https://esm.sh/spessasynth_lib@4.4.10?bundle');
    await audio.audioWorklet.addModule('https://cdn.jsdelivr.net/npm/spessasynth_lib@4.4.10/dist/spessasynth_processor.min.js');
    const synth=new WorkletSynthesizer(audio);
    await synth.soundBankManager.addSoundBank(buffer,name);
    await synth.isReady;
    synth.connect(audio.destination);
    synth.programChange(0,0);
    return synth;
  }
  async function ensureDefaultSynth(){
    if(defaultSynth)return defaultSynth;
    if(defaultSynthPromise)return defaultSynthPromise;
    defaultSynthPromise=(async()=>{
      const response = await fetch('/assets/Full_Grand_Piano.sf2?v=20261124-3', {
  cache: 'no-store'
});
      if(!response.ok)throw new Error(`Default piano SF2 failed to load (${response.status})`);
      const buffer=await response.arrayBuffer();
      defaultSynth=await createSynthFromBuffer(buffer,'Full Grand Piano');
      return defaultSynth;
    })().finally(()=>{defaultSynthPromise=null;});
    return defaultSynthPromise;
  }
  async function loadRemoteDefault(ownerId){
    try{
      const synth=await ensureDefaultSynth();
      remoteSynths.set(ownerId,synth);
      console.info(`Loaded default grand piano for remote player ${ownerId}`);
    }catch(error){console.error('Could not load default grand piano:',error);}
  }
  async function loadRemoteSoundfont(ownerId,id,name,buffer){
    if(remoteLoading.has(ownerId))return;
    remoteLoading.add(ownerId);
    try{
      const synth=await createSynthFromBuffer(buffer,name);
      const previous=remoteSynths.get(ownerId);if(previous){try{previous.disconnect();}catch(e){}}
      remoteSynths.set(ownerId,synth);
      console.info(`Loaded ${name} for remote player ${ownerId}`);
    }catch(error){console.error(`Could not load ${name} from another player:`,error);}
    finally{remoteLoading.delete(ownerId);}
  }
  function toneOnForPlayer(ownerId,note,velocity=.8){
    const synth=remoteSynths.get(ownerId);
    if(synth){try{if(audio?.state==='suspended')audio.resume();synth.noteOn(0,note,Math.max(1,Math.min(127,Math.round(velocity*127))));synthForNote.set(`${ownerId}:${note}`,synth);return;}catch(e){}}
    toneOn(note,velocity);
  }
  function toneOffForPlayer(ownerId,note){
    const key=`${ownerId}:${note}`,synth=synthForNote.get(key);
    if(synth){try{synth.noteOff(0,note);}catch(e){}synthForNote.delete(key);return;}
    toneOff(note);
  }
  function toneOn(note,velocity=.8){if(muted)return;try{const activeSynth=soundfontSynth||defaultSynth;if(activeSynth){if(audio&&audio.state==='suspended')audio.resume();activeSynth.noteOn(0,note,Math.max(1,Math.min(127,Math.round(velocity*127))));synthForNote.set(note,activeSynth);return;}audio=audio||new AudioContext();if(audio.state==='suspended')audio.resume();if(oscillators.has(note))return;const osc=audio.createOscillator(),gain=audio.createGain();osc.type='triangle';osc.frequency.value=440*Math.pow(2,(note-69)/12);gain.gain.setValueAtTime(.0001,audio.currentTime);gain.gain.exponentialRampToValueAtTime(Math.max(.02,velocity*.18),audio.currentTime+.015);osc.connect(gain);gain.connect(audio.destination);osc.start();oscillators.set(note,{osc,gain});}catch(e){}}
  function toneOff(note){const usedSynth=synthForNote.get(note);if(usedSynth){try{usedSynth.noteOff(0,note);}catch(e){}synthForNote.delete(note);return;}const item=oscillators.get(note);if(!item)return;try{item.gain.gain.cancelScheduledValues(audio.currentTime);item.gain.gain.setTargetAtTime(.0001,audio.currentTime,.04);item.osc.stop(audio.currentTime+.18);}catch(e){}oscillators.delete(note);}
  function highlight(note,player=me){active.set(note,player);const key=$(`note-${note}`);if(key){key.classList.add('pressed');key.style.setProperty('--unused',player.color);key.style.background=key.classList.contains('white-key')?`linear-gradient(180deg,${player.color},#c9b5ff)`:player.color;}}
  function highlightOff(note){active.delete(note);const key=$(`note-${note}`);if(key){key.classList.remove('pressed');key.style.background='';}}
  function noteOn(note,velocity=.8){if(active.has(note))return;highlight(note,me);toneOn(note,velocity);send({type:'note-on',note});}
  function noteOff(note){if(!active.has(note))return;highlightOff(note);toneOff(note);send({type:'note-off',note});}
  async function loadPersonalSoundfont(id){
    const entry=localSoundfonts.get(id);if(!entry)return;
    if(loadingSf2)return;
    loadingSf2=true;$('sf2-status').textContent=`Loading ${entry.name} for you…`;
    try{
      audio=audio||new AudioContext();await audio.resume();
      const {WorkletSynthesizer}=await import('https://esm.sh/spessasynth_lib@4.4.10?bundle');
      await audio.audioWorklet.addModule('https://cdn.jsdelivr.net/npm/spessasynth_lib@4.4.10/dist/spessasynth_processor.min.js');
      const nextSynth=new WorkletSynthesizer(audio);
      await nextSynth.soundBankManager.addSoundBank(entry.buffer,entry.name);
      await nextSynth.isReady;nextSynth.connect(audio.destination);nextSynth.programChange(0,0);
      const previous=soundfontSynth;soundfontSynth=nextSynth;
      if(previous){try{previous.disconnect();}catch(e){}}
      $('sf2-status').textContent=`${entry.name} · selected for you only`;
    }catch(error){console.error('Personal SF2 load failed:',error);$('sf2-status').textContent=`Could not load ${entry.name}`;showError('This SF2 could not be loaded in your browser.');}
    finally{loadingSf2=false;}
  }
  function refreshSoundfontSelect(selectedId){
    const select=$('sf2-select');select.innerHTML='';
    const defaultOption=document.createElement('option');defaultOption.value='';defaultOption.textContent='Full Grand Piano (default)';select.append(defaultOption);
    for(const [id,entry] of localSoundfonts){const option=document.createElement('option');option.value=id;option.textContent=entry.name;select.append(option);}
    select.value=selectedId||'';
  }
  $('sf2-file').addEventListener('change',async event=>{
    const files=[...(event.target.files||[])];if(!files.length)return;
    for(const file of files){
      if(!file.name.toLowerCase().endsWith('.sf2')){$('sf2-status').textContent=`${file.name}: choose an .sf2 file`;continue;}
      if(file.size>48*1024*1024){$('sf2-status').textContent=`${file.name}: over the 48 MB limit`;continue;}
      try{
        const buffer=await file.arrayBuffer(),bytes=new Uint8Array(buffer);
        if(bytes.length<12||String.fromCharCode(...bytes.slice(0,4))!=='RIFF'||String.fromCharCode(...bytes.slice(8,12))!=='sfbk'){$('sf2-status').textContent=`${file.name}: not a valid SF2`;continue;}
        const id=`sf2-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        localSoundfonts.set(id,{name:file.name,buffer});
        if(socket&&socket.readyState===WebSocket.OPEN){socket.send(makeSoundfontPacket({type:'soundfont',playerId,soundfontId:id,name:file.name},buffer));}
        refreshSoundfontSelect(id);await loadPersonalSoundfont(id);
        send({type:'soundfont-select',soundfontId:id});
      }catch(error){console.error(error);$('sf2-status').textContent=`Could not read ${file.name}`;}
    }
    event.target.value='';
  });
  $('sf2-select').addEventListener('change',async event=>{
    const id=event.target.value;
    if(!id){const previous=soundfontSynth;soundfontSynth=null;if(previous){try{previous.disconnect();}catch(e){}}try{await ensureDefaultSynth();$('sf2-status').textContent='Full Grand Piano · selected for you';}catch(error){console.error(error);$('sf2-status').textContent='Could not load default piano';}send({type:'soundfont-select',soundfontId:''});return;}
    await loadPersonalSoundfont(id);
    send({type:'soundfont-select',soundfontId:id});
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
  $('create').onclick=async()=>{audio=audio||new AudioContext();audio.resume().catch(()=>{});const name=$('nickname').value.trim()||'Pianist';localStorage.setItem('pianohub-name',name);showError('');try{if(!socket||socket.readyState!==WebSocket.OPEN)await connect();send({type:'create',name,roomName:$('roomname').value,visibility:$('visibility').value,playerId,color});}catch(e){showError(e.message+' Run npm start on the host computer first.');}};
  $('join').onclick=async()=>{audio=audio||new AudioContext();audio.resume().catch(()=>{});const name=$('nickname').value.trim()||'Pianist',code=$('code').value.trim().toUpperCase();if(!code){showError('Enter a room code.');return;}localStorage.setItem('pianohub-name',name);showError('');try{if(!socket||socket.readyState!==WebSocket.OPEN)await connect();send({type:'join',name,code,playerId,color});}catch(e){showError(e.message);}};
  $('refresh-public').onclick=async()=>{try{if(!socket||socket.readyState!==WebSocket.OPEN)await connect();send({type:'list-public'});}catch(e){showError(e.message);}};
  $('public-rooms').addEventListener('click',async event=>{const button=event.target.closest('.public-join');if(!button)return;audio=audio||new AudioContext();audio.resume().catch(()=>{});const name=$('nickname').value.trim()||'Pianist';localStorage.setItem('pianohub-name',name);showError('');try{if(!socket||socket.readyState!==WebSocket.OPEN)await connect();send({type:'join',name,code:button.dataset.code,playerId,color});}catch(e){showError(e.message);}});
  $('leave').onclick=()=>{if(socket)socket.close();socket=null;room=null;active.forEach((p,n)=>toneOff(n));active.clear();$('session').classList.add('hidden');$('lobby').classList.remove('hidden');$('lobby-error').textContent='';};
  $('copy').onclick=async()=>{try{await navigator.clipboard.writeText(room.code);$('copy').textContent='Copied!';setTimeout(()=>$('copy').textContent=room.code+' ⧉ Invite',1200);}catch(e){$('copy').textContent=room.code;}};
  $('mute').onclick=()=>{muted=!muted;$('mute').textContent=muted?'◖ Sound off':'◖ Sound on';if(muted){[...oscillators.keys()].forEach(toneOff);}};
  $('chat-form').onsubmit=e=>{e.preventDefault();const text=$('chat-input').value.trim();if(!text)return;addMessage(me,text);send({type:'chat',text});$('chat-input').value='';};
  function computerKeyForCode(code){if(code.startsWith('Key'))return code.slice(3).toLowerCase();if(code.startsWith('Digit'))return code.slice(5);return null;}
  window.addEventListener('keydown',e=>{if(!$('session').classList.contains('hidden')&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){const key=computerKeyForCode(e.code);if(key!==null&&keyMap.has(key)&&!held.has(e.code)){const index=keyMap.get(key),white=whiteNotes[keyboardStartIndex+index],pitch=white%12;const isBlack=e.shiftKey&&[0,2,5,7,9].includes(pitch);const note=white+(isBlack?1:0);held.set(e.code,note);noteOn(note);if(key===' '||e.code==='Space')e.preventDefault();}}});
  window.addEventListener('keyup',e=>{if(held.has(e.code)){noteOff(held.get(e.code));held.delete(e.code);}});
  window.addEventListener('blur',()=>{held.forEach(note=>noteOff(note));held.clear();});
  $('nickname').value=localStorage.getItem('pianohub-name')||'';
  buildPiano();
  connect().then(()=>send({type:'list-public'})).catch(()=>{ $('public-rooms').innerHTML='<div class="public-empty">Could not load rooms. Try refreshing.</div>'; });
})();
