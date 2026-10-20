(function(){
  'use strict';

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));


  // Teacher-checked sentence-builder overrides.
  // These fix the broken AI/Groq output for tricky entries such as separable verbs
  // (e.g. herumgehen -> "Ich gehe ... herum", not "Ich gehe herumgehen ...").
  const BUILDER_CURATED_SENTENCES = {
    138: {german: 'Ich kann nicht gut Französisch.', english: "I can't speak French well."},
    139: {german: 'Unser Kind ist noch zu klein.', english: 'Our child is still too small.'},
    140: {german: 'Ich finde hier einen Parkplatz.', english: 'I find a parking space here.'},
    141: {german: 'Ich gehe um die Baustelle herum.', english: 'I walk around the construction site.'},
    142: {german: 'Ich benutze am Strand Sonnencreme.', english: 'I use sunscreen at the beach.'},
    143: {german: 'Im Einkaufszentrum gibt es viele Geschäfte.', english: 'There are many shops in the shopping centre.'},
    144: {german: 'Das Hotel liegt innerhalb der Stadtmauern.', english: 'The hotel is inside the city walls.'},
    145: {german: 'Wir wohnen außerhalb der Stadt.', english: 'We live outside the city.'},
    146: {german: 'Morgens trinke ich immer Kaffee.', english: 'In the morning I always drink coffee.'},
    147: {german: 'Ich fühle mich hier zu Hause.', english: 'I feel at home here.'},
    148: {german: 'In der Konditorei kaufe ich Kuchen.', english: 'I buy cake at the patisserie.'},
    149: {german: 'Danach gehen wir zum Markt.', english: 'After that we go to the market.'},
    150: {german: 'Samstags ist die Konditorei geschlossen.', english: 'The patisserie is closed on Saturdays.'},
    151: {german: 'Ich gehe über die Brücke.', english: 'I walk across the bridge.'},
    152: {german: 'Meditation hilft mir am Morgen.', english: 'Meditation helps me in the morning.'},
    153: {german: 'Der Lärm weckt mich früh.', english: 'The noise wakes me early.'},
    154: {german: 'Ich arbeite in einer kleinen Buchhandlung.', english: 'I work in a small bookshop.'},
    155: {german: 'Er verkauft besondere Bücher.', english: 'He sells special books.'},
    156: {german: 'Sie mag antike Möbel.', english: 'She likes antique furniture.'},
    157: {german: 'Wir sehen uns das Schaufenster an.', english: 'We look at the shop window.'},
    158: {german: 'Ich kaufe ein Geschenk für Anna.', english: 'I buy a present for Anna.'},
    159: {german: 'Wir dekorieren die Altstadt vor Weihnachten.', english: 'We decorate the old town before Christmas.'},
    160: {german: 'Lampen beleuchten die Kirche am Abend.', english: 'Lamps light up the church in the evening.'}
  };

  function exampleEnglish(w){
    const curated = BUILDER_CURATED_SENTENCES[Number(w && w.id)];
    if(curated && curated.english) return curated.english;
    const raw = EXAMPLE_EN[w && w.id] || '';
    // The uploaded EXAMPLE_EN list after id 137 came from an older vocabulary set,
    // so those English sentences were misleading. Use no sentence translation instead of a wrong one.
    if(Number(w && w.id) > 137) return '';
    return raw;
  }
  const WORD_BY_ID = {};
  let TOTAL_WORDS = 0;
  VOCAB_DATA.forEach(ch => ch.words.forEach(w => { WORD_BY_ID[w.id] = w; TOTAL_WORDS++; }));

  let progress = {};
  let saveTimer = null;
  let autoBackupState = 'Not enabled';
  const storageKey = 'mosel-wortschatz-progress-single';
  const storageBackupKey = storageKey + '-backup';
  const storageMetaKey = storageKey + '-meta';
  const groqKeyStorage = 'mosel-wortschatz-groq-key';
  const durableDbName = 'mosel-wortschatz-durable-backup';
  const durableStoreName = 'progress-store';
  const durableProgressKey = 'latest-progress-json';
  const durableFileHandleKey = 'auto-backup-file-handle';

  function storageWorks(){
    try{
      const k = storageKey + '-test';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    }catch(e){ return false; }
  }
  function readStoredProgress(raw){
    if(!raw) return {};
    const data = JSON.parse(raw);
    if(data && data.progress && typeof data.progress === 'object') return data.progress;
    return (data && typeof data === 'object') ? data : {};
  }
  function loadProgress(){
    try{
      progress = readStoredProgress(localStorage.getItem(storageKey));
      if(!progress || !Object.keys(progress).length){
        progress = readStoredProgress(localStorage.getItem(storageBackupKey));
      }
    }catch(e){ progress = {}; }
  }
  function progressPayload(){
    return {
      app: 'Mosel Wortschatz',
      version: 3,
      savedAt: new Date().toISOString(),
      progress
    };
  }
  function durableDb(){
    return new Promise((resolve, reject) => {
      if(!('indexedDB' in window)) return reject(new Error('IndexedDB not available'));
      const req = indexedDB.open(durableDbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(durableStoreName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
    });
  }
  async function durableGet(key){
    const db = await durableDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(durableStoreName, 'readonly');
      const req = tx.objectStore(durableStoreName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Read failed'));
      tx.oncomplete = () => db.close();
    });
  }
  async function durableSet(key, value){
    const db = await durableDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(durableStoreName, 'readwrite');
      tx.objectStore(durableStoreName).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Write failed')); };
    });
  }
  async function durableDelete(key){
    const db = await durableDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(durableStoreName, 'readwrite');
      tx.objectStore(durableStoreName).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Delete failed')); };
    });
  }
  async function requestPersistentStorage(){
    try{
      if(navigator.storage && navigator.storage.persist){
        const ok = await navigator.storage.persist();
        if(ok && autoBackupState === 'Not enabled') autoBackupState = 'Browser storage protected';
      }
    }catch(e){}
  }
  async function writeAutoBackupFile(showToast){
    try{
      const handle = await durableGet(durableFileHandleKey);
      if(!handle || !handle.createWritable) return false;
      if(handle.queryPermission){
        let perm = await handle.queryPermission({mode:'readwrite'});
        if(perm !== 'granted' && handle.requestPermission){
          perm = await handle.requestPermission({mode:'readwrite'});
        }
        if(perm !== 'granted'){
          autoBackupState = 'Permission needed';
          if(showToast) toast('Auto backup needs permission again. Click Enable auto backup file.');
          return false;
        }
      }
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(progressPayload(), null, 2));
      await writable.close();
      autoBackupState = 'Enabled — external JSON file is updating';
      if(showToast) toast('External backup file updated.');
      return true;
    }catch(e){
      console.warn('Auto backup file write failed', e);
      autoBackupState = 'Auto file backup unavailable';
      return false;
    }
  }
  function scheduleDurableBackup(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try{ await durableSet(durableProgressKey, JSON.stringify(progressPayload())); }catch(e){}
      await writeAutoBackupFile(false);
    }, 350);
  }
  async function restoreFromDurableStores(){
    if(progress && Object.keys(progress).length) return false;
    try{
      const raw = await durableGet(durableProgressKey);
      const p = readStoredProgress(raw);
      if(p && Object.keys(p).length){
        progress = p;
        autoBackupState = 'Restored from durable browser backup';
        return true;
      }
    }catch(e){}
    try{
      const handle = await durableGet(durableFileHandleKey);
      if(handle && handle.getFile){
        const raw = await (await handle.getFile()).text();
        const p = readStoredProgress(raw);
        if(p && Object.keys(p).length){
          progress = p;
          autoBackupState = 'Restored from external backup file';
          return true;
        }
      }
    }catch(e){}
    return false;
  }
  async function checkAutoBackupStatus(){
    try{
      const handle = await durableGet(durableFileHandleKey);
      if(handle && handle.name) autoBackupState = 'Enabled — ' + handle.name;
    }catch(e){}
  }
  function saveProgress(){
    try{
      const now = new Date().toISOString();
      localStorage.setItem(storageKey, JSON.stringify(progress));
      localStorage.setItem(storageBackupKey, JSON.stringify({savedAt: now, progress}));
      localStorage.setItem(storageMetaKey, JSON.stringify({savedAt: now, count: Object.keys(progress).length}));
      scheduleDurableBackup();
    }catch(e){ console.warn('Could not save progress', e); }
  }
  function lastSaveText(){
    try{
      const meta = JSON.parse(localStorage.getItem(storageMetaKey) || '{}');
      if(!meta.savedAt) return 'Not saved yet';
      return new Date(meta.savedAt).toLocaleString();
    }catch(e){ return 'Unknown'; }
  }
  function getStatus(id){ return progress[id] || 'new'; }
  function setStatus(id, status){
    if(status === 'new') delete progress[id];
    else progress[id] = status;
    saveProgress();
  }
  window.addEventListener('beforeunload', saveProgress);

  function exportProgress(){
    saveProgress();
    const payload = progressPayload();
    payload.exportedAt = new Date().toISOString();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0,10);
    a.href = URL.createObjectURL(blob);
    a.download = `mosel-wortschatz-progress-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    toast('Progress backup downloaded. Keep this JSON file safe.');
  }
  function importProgressFile(file){
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const data = JSON.parse(reader.result);
        const imported = data.progress && typeof data.progress === 'object' ? data.progress : data;
        if(!imported || typeof imported !== 'object') throw new Error('Invalid progress file');
        progress = imported;
        saveProgress();
        toast('Progress imported successfully.');
        renderShell();
      }catch(e){ toast('Could not import this file. Use the exported JSON backup.'); }
    };
    reader.readAsText(file);
  }
  async function enableAutoBackupFile(){
    if(!('showSaveFilePicker' in window)){
      toast('Your browser does not support auto file backup here. Use Download progress backup instead.');
      return;
    }
    try{
      const handle = await window.showSaveFilePicker({
        suggestedName: 'mosel-wortschatz-auto-backup.json',
        types: [{ description: 'JSON progress backup', accept: { 'application/json': ['.json'] } }]
      });
      await durableSet(durableFileHandleKey, handle);
      await writeAutoBackupFile(true);
      renderShell();
    }catch(e){
      if(e && e.name === 'AbortError') return;
      console.warn(e);
      toast('Could not enable auto backup file.');
    }
  }
  async function disableAutoBackupFile(){
    try{ await durableDelete(durableFileHandleKey); }catch(e){}
    autoBackupState = 'Not enabled';
    toast('Auto backup file disabled. Browser auto-save still works.');
    renderShell();
  }

  function escapeHtml(s){
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escapeAttr(s){
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }
  function shuffle(arr){
    const a = arr.slice();
    for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]] = [a[j],a[i]]; }
    return a;
  }
  function chapterWords(n){ return (VOCAB_DATA.find(c => c.number === n) || {words:[]}).words; }
  function headword(term){ return String(term || '').split(',')[0].split(' (')[0].trim(); }
  function cleanSpeechText(text){
    return headword(text).replace(/\([^)]*\)/g,'').replace(/\s+/g,' ').trim();
  }
  function cleanLongSpeechText(text){
    return String(text || '').replace(/[„“"']/g,'').replace(/\([^)]*\)/g,'').replace(/\s+/g,' ').trim();
  }
  function stripArticle(s){ return String(s || '').replace(/^(der|die|das|den|dem|des)\s+/i,'').trim(); }
  function renderTerm(term){
    return escapeHtml(term).replace(/^(der|die|das)\b/i, m => `<span class="vt-art-${m.toLowerCase()}">${m}</span>`);
  }
  function extractArticle(term){
    const first = String(term || '').split(',')[0];
    if(/^der\s*\/\s*die\b/i.test(first) || /^die\s*\/\s*der\b/i.test(first)) return null;
    const m = first.match(/^(der|die|das)\s+/i);
    return m ? m[1].toLowerCase() : null;
  }
  function nounOnly(term){ return headword(term).replace(/^(der|die|das)\s+/i,'').trim(); }
  function pluralPart(term){
    const parts = String(term || '').split(',');
    return parts.length > 1 ? parts.slice(1).join(',').split(' (')[0].trim() : '';
  }
  function forvoUrl(word){ return 'https://forvo.com/word/' + encodeURIComponent(cleanSpeechText(word).toLowerCase().replace(/\s+/g,'_')) + '/#de'; }

  const SPEAK_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
  let selectedVoice = null;
  let voicesPromise = null;
  function getVoices(){
    if(!('speechSynthesis' in window)) return [];
    const voices = window.speechSynthesis.getVoices() || [];
    selectedVoice = voices.find(v => (v.lang || '').toLowerCase().startsWith('de-de'))
      || voices.find(v => (v.lang || '').toLowerCase().startsWith('de'))
      || voices.find(v => /german|deutsch/i.test(v.name || ''))
      || null;
    return voices;
  }
  function waitForVoices(){
    if(!('speechSynthesis' in window)) return Promise.resolve([]);
    const current = getVoices();
    if(current.length) return Promise.resolve(current);
    if(voicesPromise) return voicesPromise;
    voicesPromise = new Promise(resolve => {
      let done = false;
      const finish = () => { if(done) return; done = true; resolve(getVoices()); };
      window.speechSynthesis.onvoiceschanged = finish;
      setTimeout(finish, 900);
    });
    return voicesPromise;
  }
  function setSpeaking(el, on){
    if(el && el.classList){
      el.classList.toggle('is-speaking', !!on);
      if(on) el.setAttribute('aria-busy','true');
      else el.removeAttribute('aria-busy');
    }
  }
  function googleTtsUrl(phrase){
    return 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=de&q=' + encodeURIComponent(phrase);
  }
  function playOnlineTTS(phrase, el){
    return new Promise(resolve => {
      try{
        setSpeaking(el, true);
        const audio = new Audio(googleTtsUrl(phrase));
        audio.preload = 'auto';
        audio.volume = 1;
        audio.onended = () => { setSpeaking(el, false); resolve(true); };
        audio.onerror = () => { setSpeaking(el, false); toast('Online TTS blocked. Click “Forvo native” for audio.'); resolve(false); };
        const playPromise = audio.play();
        if(playPromise && typeof playPromise.catch === 'function'){
          playPromise.catch(() => { setSpeaking(el, false); toast('Browser blocked audio. Click the button once again or use Forvo.'); resolve(false); });
        }
      }catch(e){
        console.warn(e);
        setSpeaking(el, false);
        toast('Audio is blocked here. Use Forvo native audio.');
        resolve(false);
      }
    });
  }
  function speak(text, btn, fullText=false){
    const phrase = fullText ? cleanLongSpeechText(text) : cleanSpeechText(text);
    if(!phrase) return false;
    const el = btn || document.activeElement;

    // Many Linux/Ubuntu Chrome installs have no German system voice, so browser
    // speechSynthesis throws an error. In that case we immediately use online TTS.
    const voices = getVoices();
    const deVoice = selectedVoice
      || voices.find(v => (v.lang || '').toLowerCase().startsWith('de-de'))
      || voices.find(v => (v.lang || '').toLowerCase().startsWith('de'))
      || voices.find(v => /german|deutsch/i.test(v.name || ''));

    if(!('speechSynthesis' in window) || !deVoice){
      playOnlineTTS(phrase, el);
      return true;
    }

    try{
      if(window.speechSynthesis.paused) window.speechSynthesis.resume();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(phrase);
      u.lang = 'de-DE';
      u.rate = 0.82;
      u.pitch = 1;
      u.volume = 1;
      u.voice = deVoice;
      let started = false;
      let finished = false;
      u.onstart = () => { started = true; setSpeaking(el, true); };
      u.onend = () => { finished = true; setSpeaking(el, false); };
      u.onerror = () => {
        if(finished) return;
        finished = true;
        try{ window.speechSynthesis.cancel(); }catch(_e){}
        setSpeaking(el, false);
        playOnlineTTS(phrase, el);
      };
      window.speechSynthesis.speak(u);
      setTimeout(() => {
        if(!started && !finished){
          finished = true;
          try{ window.speechSynthesis.cancel(); }catch(_e){}
          setSpeaking(el, false);
          playOnlineTTS(phrase, el);
        }
      }, 1100);
      return true;
    }catch(e){
      console.warn(e);
      setSpeaking(el, false);
      playOnlineTTS(phrase, el);
      return true;
    }
  }
  async function speakLongText(text, btn){
    const phrase = cleanLongSpeechText(text);
    if(!phrase) return false;
    const chunks = (phrase.match(/[^.!?]+[.!?]+/g) || [phrase])
      .map(s => s.trim())
      .filter(Boolean)
      .flatMap(s => s.length > 180 ? s.match(/.{1,170}(\s|$)/g).map(x => x.trim()).filter(Boolean) : [s]);
    const voices = getVoices();
    const deVoice = selectedVoice
      || voices.find(v => (v.lang || '').toLowerCase().startsWith('de-de'))
      || voices.find(v => (v.lang || '').toLowerCase().startsWith('de'))
      || voices.find(v => /german|deutsch/i.test(v.name || ''));
    if(!('speechSynthesis' in window) || !deVoice){
      for(const chunk of chunks){
        const ok = await playOnlineTTS(chunk, btn);
        if(!ok) return false;
      }
      return true;
    }
    return speak(phrase, btn, true);
  }

  function toast(message){
    let node = $('#vtMiniNotice');
    if(!node){
      node = document.createElement('div');
      node.id = 'vtMiniNotice';
      node.className = 'vt-mini-notice';
      $('#vtRoot').appendChild(node);
    }
    node.textContent = message;
    node.classList.add('is-showing');
    clearTimeout(node._timer);
    node._timer = setTimeout(() => node.classList.remove('is-showing'), 2800);
  }

  const state = {
    tab: 'search', chapter: 1,
    learn: {filter:'all', chunk:'today20', order:[], orderKey:'', idx:0, flipped:false, showEn:false},
    article: {scope:'pack', queue:[], idx:0, correct:0, total:0, answered:null, wrongPick:null},
    quiz: {phase:'setup', scope:'pack', dir:'mixed', count:'15', queue:[], idx:0, correct:0, total:0, options:[], correctText:'', answered:false},
    recall: {phase:'setup', scope:'pack', count:'20', queue:[], idx:0, correct:0, total:0, options:[], correctText:'', answered:false},
    match: {scope:'pack', cards:[], selected:null, matched:new Set(), moves:0, size:6},
    type: {phase:'setup', scope:'pack', count:'15', queue:[], idx:0, correct:0, total:0, revealed:false, feedback:null},
    builder: {scope:'pack', queue:[], idx:0, correct:0, total:0, currentId:null, tiles:[], selected:[], feedback:null, aiItems:[], aiStatus:'', aiError:'', tempKey:''},
    read: {usedIds:[], showEn:true, ai:null, aiStatus:'', aiError:'', tempKey:'', chat:[], chatStatus:'', chatError:'', chatContext:'', selectedWord:null, answerIndex:0, answerText:'', answerStatus:'', answerFeedback:''},
    search: {query:'', results:[], groqText:'', groqStatus:'', groqError:'', tempKey:''},
    activePackKey: ''
  };

  function statsFor(words){
    let known = 0, learning = 0;
    words.forEach(w => { const s = getStatus(w.id); if(s === 'known') known++; else if(s === 'learning') learning++; });
    return {total: words.length, known, learning, neu: words.length-known-learning};
  }
  function overallStats(){ return statsFor(VOCAB_DATA.flatMap(c => c.words)); }
  function resetForChapter(){
    state.learn.order = []; state.learn.orderKey=''; state.learn.idx = 0; state.learn.flipped = false; state.learn.showEn = false;
    state.article.queue = [];
    state.quiz.phase = 'setup'; state.quiz.queue = [];
    state.recall.phase = 'setup'; state.recall.queue = []; state.recall.options = []; state.recall.answered = false;
    state.match.cards = []; state.match.matched = new Set(); state.match.selected = null; state.match.moves = 0;
    state.type.phase = 'setup'; state.type.queue = [];
    state.builder.queue = []; state.builder.idx = 0; state.builder.correct = 0; state.builder.total = 0; state.builder.currentId = null; state.builder.tiles = []; state.builder.selected = []; state.builder.feedback = null; state.builder.aiItems = []; state.builder.aiStatus = ''; state.builder.aiError = '';
    state.read.usedIds = []; state.read.ai = null; state.read.chat = []; state.read.chatStatus = ''; state.read.chatError = ''; state.read.selectedWord = null; state.read.answerText = ''; state.read.answerStatus = ''; state.read.answerFeedback = ''; state.read.chatContext = ''; state.read.selectedWord = null; state.read.answerText = ''; state.read.answerStatus = ''; state.read.answerFeedback = '';
  }
  function renderShell(){ renderOverall(); renderChapters(); renderTabs(); renderBody(); }
  function renderOverall(){
    const s = overallStats();
    const pct = s.total ? Math.round(s.known / s.total * 100) : 0;
    $('#vtOverall').innerHTML = `<span>${s.known.toLocaleString('de-DE')} <span style="opacity:.75">von</span> ${s.total.toLocaleString('de-DE')}</span><b>${pct}%</b>`;
  }

  function chapterTitleEn(ch){
    if(ch.title_en) return ch.title_en;
    // Fallback for word lists without title_en, matched by German title so it can't mislabel another list.
    const known = {
      'An Rhein und Mosel': 'Rhine and Moselle',
      'Gesund und fit': 'Healthy and fit',
      'Geschichte und Geschichten': 'History and stories',
      'Immer mobil': 'Always mobile',
      'Mehr als eine Sprache': 'More than one language',
      'Kaufen und verkaufen': 'Buying and selling',
      'Digitale Zukunft': 'Digital future',
      'Wirtschaft': 'Economy',
      'So wohnen wir': 'How we live',
      'Digitale Welten': 'Digital worlds',
      'Lernen – Wann? Wo? Wie?': 'Learning — when? where?'
    };
    return known[ch.title] || '';
  }
  function modeTitle(german, english, copy){
    return `<h2 class="vt-mode-title">${escapeHtml(german)}</h2><div class="vt-mode-subtitle">${escapeHtml(english)}</div>${copy ? `<p class="vt-mode-copy">${escapeHtml(copy)}</p>` : ''}`;
  }

  function renderChapters(){
    $('#vtChapters').innerHTML = VOCAB_DATA.map(ch => {
      const s = statsFor(ch.words); const pct = s.total ? Math.round(s.known / s.total * 100) : 0;
      return `<button class="vt-chip ${ch.number===state.chapter?'is-active':''}" data-ch="${ch.number}" title="${escapeHtml(ch.title)}">
        <div class="vt-chip-num">KAP. ${String(ch.number).padStart(2,'0')} · ${s.total}</div>
        <div class="vt-chip-title">${escapeHtml(ch.title)}</div>
        <div class="vt-chip-en">${escapeHtml(chapterTitleEn(ch))}</div>
        <div class="vt-chip-progress"><div style="width:${pct}%"></div></div>
      </button>`;
    }).join('');
    $$('.vt-chip').forEach(btn => btn.addEventListener('click', () => { state.chapter = Number(btn.dataset.ch); resetForChapter(); renderShell(); }));
  }
  function renderTabs(){ $$('.vt-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === state.tab)); }
  function poolByScope(scope){
    if(scope === 'all') return VOCAB_DATA.flatMap(c => c.words);
    if(scope === 'weak') return VOCAB_DATA.flatMap(c => c.words).filter(w => getStatus(w.id) === 'learning');
    if(scope === 'pack') return learnPool();
    return chapterWords(state.chapter);
  }
  function currentPackKey(){
    return `${state.chapter}|${state.learn.filter}|${state.learn.chunk}|${learnPool().map(w=>w.id).join(',')}`;
  }
  function syncPackQueues(){
    const key = currentPackKey();
    if(state.activePackKey && state.activePackKey !== key){
      resetModeQueues();
    }
    state.activePackKey = key;
  }
  function renderBody(){
    syncPackQueues();
    if(state.tab === 'search') renderSearch();
    else if(state.tab === 'learn') renderLearn();
    else if(state.tab === 'artikel') renderArticle();
    else if(state.tab === 'quiz') renderQuiz();
    else if(state.tab === 'recall') renderRecall();
    else if(state.tab === 'match') renderMatch();
    else if(state.tab === 'type') renderType();
    else if(state.tab === 'builder') renderBuilder();
    else if(state.tab === 'read') renderRead();
    else renderStats();
  }

  const PACK_SIZE = 20;

  function learnFilteredWords(){
    let words = chapterWords(state.chapter);
    const f = state.learn.filter;
    if(f === 'core') words = words.filter(w => w.core);
    else if(f !== 'all') words = words.filter(w => getStatus(w.id) === f);
    return words;
  }
  function todayPack(words){
    const learning = words.filter(w => getStatus(w.id) === 'learning');
    const fresh = words.filter(w => getStatus(w.id) === 'new');
    const known = words.filter(w => getStatus(w.id) === 'known');
    return learning.concat(fresh, known).slice(0, PACK_SIZE);
  }
  function learnPool(){
    const words = learnFilteredWords();
    const chunk = state.learn.chunk || 'today20';
    if(chunk === 'all') return words;
    if(chunk === 'today20') return todayPack(words);
    if(chunk.startsWith('block:')){
      const i = Math.max(0, Number(chunk.split(':')[1]) || 0);
      return words.slice(i * PACK_SIZE, (i + 1) * PACK_SIZE);
    }
    return words;
  }
  function chunkLabel(){
    const chunk = state.learn.chunk || 'today20';
    if(chunk === 'today20') return 'Today Pack · 20 words max';
    if(chunk === 'all') return 'Full chapter';
    if(chunk.startsWith('block:')){
      const i = Math.max(0, Number(chunk.split(':')[1]) || 0);
      const start = i * PACK_SIZE + 1;
      const end = Math.min((i + 1) * PACK_SIZE, learnFilteredWords().length);
      return `Block ${i + 1} · words ${start}-${end}`;
    }
    return 'Study pack';
  }
  function chunkOptions(){
    const words = learnFilteredWords();
    const totalBlocks = Math.max(1, Math.ceil(words.length / PACK_SIZE));
    let html = `<option value="today20" ${state.learn.chunk==='today20'?'selected':''}>Today Pack: weak + new 20</option>`;
    for(let i=0;i<totalBlocks;i++){
      const start = i * PACK_SIZE + 1;
      const end = Math.min((i + 1) * PACK_SIZE, words.length);
      html += `<option value="block:${i}" ${state.learn.chunk===`block:${i}`?'selected':''}>Block ${i+1}: ${start}-${end}</option>`;
    }
    html += `<option value="all" ${state.learn.chunk==='all'?'selected':''}>All words in this filter</option>`;
    return html;
  }
  function filterOptions(){
    return `<option value="all" ${state.learn.filter==='all'?'selected':''}>Alle Wörter</option>
      <option value="core" ${state.learn.filter==='core'?'selected':''}>Nur Kernwortschatz</option>
      <option value="new" ${state.learn.filter==='new'?'selected':''}>Nur Neu</option>
      <option value="learning" ${state.learn.filter==='learning'?'selected':''}>Nur „Übe noch”</option>
      <option value="known" ${state.learn.filter==='known'?'selected':''}>Nur Gelernt</option>`;
  }
  function scopeOptions(current){
    return `<option value="pack" ${current==='pack'?'selected':''}>Aktueller Pack / Block</option>
      <option value="chapter" ${current==='chapter'?'selected':''}>Ganzes Kapitel ${state.chapter}</option>
      <option value="weak" ${current==='weak'?'selected':''}>Alle schwachen Wörter</option>
      <option value="all" ${current==='all'?'selected':''}>Alle Kapitel</option>`;
  }
  function packControls(prefix){
    const n = learnPool().length;
    return `<div class="vt-studybar vt-topbar vt-pack-controls">
      <select class="vt-select" id="${prefix}Filter">${filterOptions()}</select>
      <select class="vt-select" id="${prefix}Chunk">${chunkOptions()}</select>
      <span class="vt-pack-pill">${n} words</span>
    </div>
    <div class="vt-pack-note"><span><b>${escapeHtml(chunkLabel())}</b> — this same small pack can be used in Karten, Artikel, Quiz, Abruf, Paaren, Tippen, Sätze, and Absatz.</span><span class="vt-pack-pill">saved: ${escapeHtml(lastSaveText())}</span></div>`;
  }
  function wirePackControls(prefix, rerender){
    const f = $('#'+prefix+'Filter');
    const c = $('#'+prefix+'Chunk');
    if(f) f.addEventListener('change', e => { state.learn.filter = e.target.value; state.learn.order=[]; state.learn.orderKey=''; resetModeQueues(); rerender(); });
    if(c) c.addEventListener('change', e => { state.learn.chunk = e.target.value; state.learn.order=[]; state.learn.orderKey=''; resetModeQueues(); rerender(); });
  }
  function resetModeQueues(){
    state.article.queue = []; state.article.idx = 0; state.article.answered = null; state.article.wrongPick = null;
    state.quiz.phase = 'setup'; state.quiz.queue = []; state.quiz.options = []; state.quiz.answered = false;
    state.recall.phase = 'setup'; state.recall.queue = []; state.recall.options = []; state.recall.answered = false;
    state.match.cards = []; state.match.selected = null; state.match.matched = new Set(); state.match.moves = 0;
    state.type.phase = 'setup'; state.type.queue = [];
    state.builder.queue = []; state.builder.idx = 0; state.builder.correct = 0; state.builder.total = 0; state.builder.currentId = null; state.builder.tiles = []; state.builder.selected = []; state.builder.feedback = null; state.builder.aiItems = []; state.builder.aiStatus = ''; state.builder.aiError = ''; state.type.feedback = null; state.type.revealed = false;
    state.read.usedIds = []; state.read.ai = null; state.read.chat = []; state.read.chatStatus = ''; state.read.chatError = ''; state.read.chatContext = ''; state.read.selectedWord = null; state.read.answerText = ''; state.read.answerStatus = ''; state.read.answerFeedback = '';
  }
  function shortcutLine(text){ return `<div class="vt-progress-mini" style="text-align:center;margin-top:14px">${text}</div>`; }
  function packStats(ids){
    const words = ids.map(id => WORD_BY_ID[id]).filter(Boolean);
    return statsFor(words);
  }
  function packDots(ids){
    return `<div class="vt-pack-dots">${ids.map(id => {
      const st = getStatus(id);
      return `<span class="vt-pack-dot ${st==='known'?'is-known':st==='learning'?'is-learning':''}" title="${st}"></span>`;
    }).join('')}</div>`;
  }
  function ensureLearnOrder(){
    const ids = learnPool().map(w => w.id);
    const key = `${state.chapter}|${state.learn.filter}|${state.learn.chunk}|${ids.join(',')}`;
    const same = key === state.learn.orderKey && ids.length === state.learn.order.length && state.learn.order.every(id => ids.includes(id));
    if(!same){
      state.learn.order = (state.learn.chunk === 'today20') ? ids : shuffle(ids);
      state.learn.orderKey = key;
      state.learn.idx = 0;
      state.learn.flipped = false;
      state.learn.showEn = false;
    }
  }
  function renderLearn(){
    ensureLearnOrder();
    const order = state.learn.order;
    const filter = `<div class="vt-studybar vt-topbar">
      <select class="vt-select" id="learnFilter">
        <option value="all" ${state.learn.filter==='all'?'selected':''}>Alle Wörter</option>
        <option value="core" ${state.learn.filter==='core'?'selected':''}>Nur Kernwortschatz</option>
        <option value="new" ${state.learn.filter==='new'?'selected':''}>Nur Neu</option>
        <option value="learning" ${state.learn.filter==='learning'?'selected':''}>Nur „Übe noch”</option>
        <option value="known" ${state.learn.filter==='known'?'selected':''}>Nur Gelernt</option>
      </select>
      <select class="vt-select" id="learnChunk">${chunkOptions()}</select>
      <button class="vt-btn vt-btn-ghost" id="learnShuffle">Mischen</button>
      <button class="vt-btn vt-btn-ghost" id="learnExportTop">Backup</button>
    </div>`;
    if(!order.length){ $('#vtBody').innerHTML = filter + '<div class="vt-empty">Keine Wörter in diesem Filter.</div>'; wireLearn(); return; }
    const ps = packStats(order);
    const packNote = `<div class="vt-pack-note"><span><b>${escapeHtml(chunkLabel())}</b> — focus only on this small pack. Mark weak words as <b>Übe noch</b> and remembered words as <b>Gelernt</b>.</span><span class="vt-pack-pill">${ps.known}/${ps.total}</span></div>`;
    const w = WORD_BY_ID[order[state.learn.idx]];
    const status = getStatus(w.id);
    const enEx = exampleEnglish(w);
    const term = headword(w.term);
    $('#vtBody').innerHTML = modeTitle('Karten','Cards / flashcards','Study one small block at a time. Use Next after the last card to loop back to card 1.') + filter + packNote + `<div class="vt-cardwrap vt-big-stage">
      <div class="vt-progressline">${state.learn.idx+1} / ${order.length} · ${escapeHtml(chunkLabel())}</div>
      ${packDots(order)}
      <div class="vt-progress-mini">Green = learned · Blue = still practicing · saved: ${escapeHtml(lastSaveText())}</div>
      <div class="vt-card vt-supercard ${state.learn.flipped?'is-flipped':''}" id="learnCard" tabindex="0" role="button" aria-label="Flip vocabulary card">
        <div class="vt-card-corner-tl"><span class="vt-pill vt-pill-${status}">${status==='known'?'gelernt':status==='learning'?'übe noch':'neu'}</span></div>
        <div class="vt-card-corner-tr">${w.core ? '<span class="vt-pill vt-pill-core">★ kern</span>' : ''}</div>
        <div class="vt-card-section">${escapeHtml(w.section || 'Wortschatz')}</div>
        ${state.learn.flipped ? `<div class="vt-card-term vt-card-term-back">${renderTerm(w.term)}</div>
          <div class="vt-card-back-trans">${escapeHtml(w.translation)}</div>
          <div class="vt-card-example">„${escapeHtml(w.example)}”
            ${enEx ? `<div class="vt-card-example-en" style="display:${state.learn.showEn?'block':'none'}">${escapeHtml(enEx)}</div>
            <div style="margin-top:10px"><button class="vt-btn vt-btn-ghost vt-smallbtn" id="learnToggleEn">${state.learn.showEn?'English ausblenden':'English anzeigen'}</button></div>` : ''}
          </div>` : `<div class="vt-card-term vt-hero-word">${renderTerm(w.term)}</div><div class="vt-card-flipnote">Tap the card for meaning + example</div>`}
        <a class="vt-card-forvo" href="${forvoUrl(term.replace(/^(der|die|das)\s+/i,''))}" target="_blank" rel="noopener">Forvo native ↗</a>
        <button class="vt-iconbtn vt-card-speak vt-speak-big" id="learnSpeak" title="Aussprache anhören" aria-label="Aussprache anhören">${SPEAK_ICON}<span>Hören</span></button>
      </div>
      <div class="vt-cardnav vt-wide-nav">
        <button class="vt-iconbtn" id="learnPrev" ${order.length<2?'disabled':''}>←</button>
        <div class="vt-statusrow">
          <button class="vt-btn ${status==='learning'?'is-on':''}" id="learnMarkLearning">Übe noch</button>
          <button class="vt-btn ${status==='known'?'is-on':''}" id="learnMarkKnown">Gelernt</button>
        </div>
        <button class="vt-iconbtn" id="learnNext" ${order.length<2?'disabled':''}>→</button>
      </div>
    </div>`;
    wireLearn();
  }
  function wireLearn(){
    const filter = $('#learnFilter'); if(filter) filter.addEventListener('change', e => { state.learn.filter = e.target.value; state.learn.order=[]; state.learn.orderKey=''; resetModeQueues(); renderLearn(); });
    const chunk = $('#learnChunk'); if(chunk) chunk.addEventListener('change', e => { state.learn.chunk = e.target.value; state.learn.order=[]; state.learn.orderKey=''; resetModeQueues(); renderLearn(); });
    const shuffleBtn = $('#learnShuffle'); if(shuffleBtn) shuffleBtn.addEventListener('click', () => { state.learn.order = shuffle(state.learn.order); state.learn.idx = 0; state.learn.flipped = false; renderLearn(); });
    const exportTop = $('#learnExportTop'); if(exportTop) exportTop.addEventListener('click', exportProgress);
    const card = $('#learnCard'); if(card) card.addEventListener('click', e => { if(e.target.closest('button,a')) return; state.learn.flipped = !state.learn.flipped; state.learn.showEn=false; renderLearn(); });
    const sp = $('#learnSpeak'); if(sp) sp.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const w = WORD_BY_ID[state.learn.order[state.learn.idx]]; speak(headword(w.term), sp); });
    const prev = $('#learnPrev'); if(prev) prev.addEventListener('click', () => { if(state.learn.order.length>1){ state.learn.idx = (state.learn.idx - 1 + state.learn.order.length) % state.learn.order.length; state.learn.flipped=false; state.learn.showEn=false; renderLearn(); } });
    const next = $('#learnNext'); if(next) next.addEventListener('click', () => { if(state.learn.order.length>1){ state.learn.idx = (state.learn.idx + 1) % state.learn.order.length; state.learn.flipped=false; state.learn.showEn=false; renderLearn(); } });
    const ml = $('#learnMarkLearning'); if(ml) ml.addEventListener('click', () => { const id = state.learn.order[state.learn.idx]; setStatus(id, getStatus(id)==='learning'?'new':'learning'); renderShell(); });
    const mk = $('#learnMarkKnown'); if(mk) mk.addEventListener('click', () => { const id = state.learn.order[state.learn.idx]; setStatus(id, getStatus(id)==='known'?'new':'known'); if(state.learn.idx<state.learn.order.length-1){ state.learn.idx++; state.learn.flipped=false; } renderShell(); });
    const te = $('#learnToggleEn'); if(te) te.addEventListener('click', e => { e.stopPropagation(); state.learn.showEn = !state.learn.showEn; renderLearn(); });
  }

  const GENDER_RULES = [
    ['chen','das','-chen words are always neuter.'], ['lein','das','-lein words are always neuter.'], ['ung','die','-ung is feminine.'], ['heit','die','-heit is feminine.'], ['keit','die','-keit is feminine.'], ['schaft','die','-schaft is feminine.'], ['ion','die','-ion is feminine.'], ['ismus','der','-ismus is masculine.'], ['ling','der','-ling is usually masculine.']
  ];
  function genderHint(noun){ const n = noun.toLowerCase(); const r = GENDER_RULES.find(([end]) => n.endsWith(end)); return r ? r[2] : 'No simple ending rule here — memorize it with the noun.'; }
  function articlePool(scope){ return poolByScope(scope).filter(w => extractArticle(w.term)); }
  function startArticle(){
    let pool = articlePool(state.article.scope);
    if(pool.length < 3 && state.article.scope === 'pack'){
      toast('This pack has few nouns, so I added chapter nouns.');
      pool = articlePool('chapter');
    }
    if(pool.length < 3) pool = articlePool('all');
    state.article.queue = shuffle(pool); state.article.idx=0; state.article.correct=0; state.article.total=0; state.article.answered=null; state.article.wrongPick=null;
    renderArticle();
  }
  function renderArticle(){
    const a = state.article;
    if(!a.queue.length){
      $('#vtBody').innerHTML = `<div class="vt-qsetup vt-artwrap">
        ${modeTitle('Artikel','Articles: der / die / das','Use the same small block here. Don’t train all 243 words at once.')}
        ${packControls('art')}
        <div class="vt-row" style="justify-content:center">
          <select class="vt-select" id="artScope">${scopeOptions(a.scope)}</select>
          <button class="vt-btn vt-btn-primary" id="artStart">Start →</button>
        </div>
        ${shortcutLine('Shortcuts: 1 = der · 2 = die · 3 = das · Space/→ = next · ↑ = sound')}
      </div>`;
      wirePackControls('art', renderArticle);
      $('#artScope').addEventListener('change', e => a.scope = e.target.value);
      $('#artStart').addEventListener('click', startArticle);
      return;
    }
    if(a.idx >= a.queue.length){
      const pct = a.total ? Math.round(a.correct/a.total*100) : 0;
      $('#vtBody').innerHTML = `<div class="vt-qend"><div class="vt-qend-score">${a.correct}/${a.total}</div><div class="vt-qend-label">${pct}% Richtig</div><button class="vt-btn vt-btn-primary" id="artAgain">Nochmal</button></div>`;
      $('#artAgain').addEventListener('click', startArticle); return;
    }
    const w = a.queue[a.idx]; const article = extractArticle(w.term); const noun = nounOnly(w.term); const plural = pluralPart(w.term); const enEx = exampleEnglish(w);
    const cls = art => !a.answered ? '' : art===article ? 'is-correct' : (a.wrongPick===art ? 'is-wrong' : '');
    $('#vtBody').innerHTML = `<div class="vt-artwrap">
      <div class="vt-progressline">${a.idx+1} / ${a.queue.length} · ${a.correct} richtig · ${escapeHtml(chunkLabel())}</div>
      <div class="vt-artcard vt-supercard" style="position:relative">
        <button class="vt-iconbtn vt-qprompt-speak" id="artSpeak" title="Aussprache">${SPEAK_ICON}</button>
        <div class="vt-card-section">${escapeHtml(w.section || '')}</div>
        <div class="vt-artnoun ${a.answered?'is-revealed':''}">${a.answered?`<span class="vt-art-prefix vt-art-${article}">${article}</span> `:''}${escapeHtml(noun)}</div>
        ${a.answered ? `<div class="vt-artplural">${plural ? 'Plural: '+escapeHtml(plural) : ''}</div><div class="vt-arttrans">${escapeHtml(w.translation)}</div><div class="vt-artexample">„${escapeHtml(w.example)}”${enEx?`<div class="vt-card-example-en">${escapeHtml(enEx)}</div>`:''}</div><div class="vt-arthint"><b>Tipp:</b> ${escapeHtml(genderHint(noun))}</div>` : '<div class="vt-card-flipnote">Choose article first. Sound before answer says noun only.</div>'}
        <div class="vt-artbuttons"><button class="vt-artbtn ${cls('der')}" data-art="der" ${a.answered?'disabled':''}>der</button><button class="vt-artbtn ${cls('die')}" data-art="die" ${a.answered?'disabled':''}>die</button><button class="vt-artbtn ${cls('das')}" data-art="das" ${a.answered?'disabled':''}>das</button></div>
        ${a.answered ? `<div class="vt-artnav"><button class="vt-btn vt-btn-primary" id="artNext">Weiter →</button></div>` : ''}
      </div>
      ${shortcutLine('1/2/3 answer · Space or → next · ↑ sound')}
    </div>`;
    $$('.vt-artbtn').forEach(b => b.addEventListener('click', () => { a.total++; a.answered = b.dataset.art===article?'correct':'wrong'; a.wrongPick = b.dataset.art; if(a.answered==='correct'){ a.correct++; setStatus(w.id,'known'); } else if(getStatus(w.id)!=='known') setStatus(w.id,'learning'); renderOverall(); renderChapters(); renderArticle(); }));
    const next = $('#artNext'); if(next) next.addEventListener('click', () => { a.idx++; a.answered=null; a.wrongPick=null; renderArticle(); });
    const sp = $('#artSpeak'); if(sp) sp.addEventListener('click', () => speak(a.answered ? (article + ' ' + noun) : noun, sp));
  }

  function makeOptions(correct, pool, dir){
    const get = w => dir === 'de2en' ? w.translation : headword(w.term);
    const correctText = get(correct);
    const opts = [];
    shuffle(pool).forEach(w => { const t = get(w); if(w.id !== correct.id && t.toLowerCase() !== correctText.toLowerCase() && !opts.includes(t) && opts.length < 3) opts.push(t); });
    while(opts.length < 3) opts.push('—');
    return shuffle([correctText, ...opts]);
  }
  function startQuiz(){
    let pool = poolByScope(state.quiz.scope); if(pool.length < 4) pool = poolByScope('chapter'); if(pool.length < 4) pool = poolByScope('all');
    const n = state.quiz.count === 'all' ? pool.length : Math.min(Number(state.quiz.count), pool.length);
    state.quiz.queue = shuffle(pool).slice(0,n).map(w => ({word:w, dir: state.quiz.dir==='mixed' ? (Math.random()<0.5?'de2en':'en2de') : state.quiz.dir}));
    state.quiz.phase='run'; state.quiz.idx=0; state.quiz.correct=0; state.quiz.total=0; state.quiz.answered=false; state.quiz.options=[]; renderQuiz();
  }
  function renderQuiz(){
    const q = state.quiz;
    if(q.phase === 'setup'){
      $('#vtBody').innerHTML = `<div class="vt-qsetup"><h2 class="vt-mode-title">Quiz</h2><p class="vt-mode-copy">Quiz only the current small block, or switch to chapter/weak/all.</p>${packControls('quiz')}<div class="vt-row"><select class="vt-select" id="quizScope">${scopeOptions(q.scope)}</select><select class="vt-select" id="quizDir"><option value="mixed">Gemischt</option><option value="de2en">Deutsch → Englisch</option><option value="en2de">Englisch → Deutsch</option></select><select class="vt-select" id="quizCount"><option value="10">10</option><option value="15">15</option><option value="25">25</option><option value="all">Alle in pack/scope</option></select><button class="vt-btn vt-btn-primary" id="quizStart">Start →</button></div>${shortcutLine('Shortcuts: 1-4 = answer · ↑ = sound when German is shown · Space = start')}</div>`;
      wirePackControls('quiz', renderQuiz);
      $('#quizScope').value=q.scope; $('#quizDir').value=q.dir; $('#quizCount').value=q.count;
      $('#quizScope').addEventListener('change', e => q.scope=e.target.value); $('#quizDir').addEventListener('change', e => q.dir=e.target.value); $('#quizCount').addEventListener('change', e => q.count=e.target.value); $('#quizStart').addEventListener('click', startQuiz); return;
    }
    if(q.idx >= q.queue.length){ const pct = q.total ? Math.round(q.correct/q.total*100) : 0; $('#vtBody').innerHTML = `<div class="vt-qend"><div class="vt-qend-score">${q.correct}/${q.total}</div><div class="vt-qend-label">${pct}% Richtig</div><button class="vt-btn vt-btn-primary" id="quizAgain">Nochmal</button></div>`; $('#quizAgain').addEventListener('click', startQuiz); return; }
    const item = q.queue[q.idx]; const w = item.word; const prompt = item.dir==='de2en'?w.term:w.translation; const label = item.dir==='de2en'?'What does this mean?':'How do you say this in German?'; const options = q.options.length && !q.answered ? q.options : makeOptions(w, poolByScope(q.scope).length ? poolByScope(q.scope) : poolByScope('chapter'), item.dir); q.options = options; q.correctText = item.dir==='de2en'?w.translation:headword(w.term);
    $('#vtBody').innerHTML = `<div class="vt-qarea"><div class="vt-scorebar"><span>${q.idx+1}/${q.queue.length} · ${escapeHtml(chunkLabel())}</span><span>${q.correct} richtig</span></div><div class="vt-qprompt"><div class="vt-qprompt-label">${label}</div><div class="vt-qprompt-main">${item.dir==='de2en'?renderTerm(prompt):escapeHtml(prompt)}</div>${item.dir==='de2en'?`<button class="vt-iconbtn vt-qprompt-speak" id="quizSpeak">${SPEAK_ICON}</button>`:'<div class="vt-progress-mini">Sound is hidden here because it would reveal the German answer.</div>'}</div><div class="vt-options">${options.map((o,i) => `<button class="vt-option" data-val="${escapeHtml(o)}"><span style="opacity:.55;font-weight:900">${i+1}.</span> ${escapeHtml(o)}</button>`).join('')}</div>${shortcutLine('1-4 answer · ↑ sound if German prompt')}</div>`;
    const sp = $('#quizSpeak'); if(sp) sp.addEventListener('click', () => speak(headword(w.term), sp));
    $$('.vt-option').forEach(b => b.addEventListener('click', () => { if(q.answered) return; q.answered=true; q.total++; const ok = b.dataset.val === q.correctText; if(ok){ q.correct++; setStatus(w.id,'known'); } else if(getStatus(w.id)!=='known') setStatus(w.id,'learning'); $$('.vt-option').forEach(x => { if(x.dataset.val===q.correctText) x.classList.add('is-correct'); }); if(!ok) b.classList.add('is-wrong'); renderOverall(); renderChapters(); setTimeout(() => { q.idx++; q.answered=false; q.options=[]; renderQuiz(); }, 900); }));
  }

  function recallScopeOptions(current){
    return `<option value="pack" ${current==='pack'?'selected':''}>Aktueller Pack / Block</option>
      <option value="chapter" ${current==='chapter'?'selected':''}>Ganzes Kapitel ${state.chapter}</option>
      <option value="chapterKnown" ${current==='chapterKnown'?'selected':''}>Gelernt in Kapitel ${state.chapter}</option>
      <option value="allKnown" ${current==='allKnown'?'selected':''}>Alle gelernten Wörter</option>
      <option value="weak" ${current==='weak'?'selected':''}>Alle schwachen Wörter</option>
      <option value="all" ${current==='all'?'selected':''}>Alle Kapitel</option>`;
  }
  function recallPoolByScope(scope){
    if(scope === 'chapterKnown') return chapterWords(state.chapter).filter(w => getStatus(w.id) === 'known');
    if(scope === 'allKnown') return VOCAB_DATA.flatMap(c => c.words).filter(w => getStatus(w.id) === 'known');
    return poolByScope(scope);
  }
  function startRecall(){
    let pool = recallPoolByScope(state.recall.scope);
    if(pool.length < 4 && (state.recall.scope === 'chapterKnown' || state.recall.scope === 'allKnown')){
      toast('Not enough learned words yet. Mark more words as Gelernt, or use current block.');
    }
    if(pool.length < 4) pool = poolByScope('pack');
    if(pool.length < 4) pool = poolByScope('chapter');
    if(pool.length < 4) pool = poolByScope('all');
    const n = state.recall.count === 'all' ? pool.length : Math.min(Number(state.recall.count) || 20, pool.length);
    state.recall.queue = shuffle(pool).slice(0, n);
    state.recall.idx = 0; state.recall.correct = 0; state.recall.total = 0;
    state.recall.phase = 'run'; state.recall.answered = false; state.recall.options = [];
    renderRecall();
  }
  function renderRecall(){
    const r = state.recall;
    if(r.phase === 'setup'){
      $('#vtBody').innerHTML = `<div class="vt-qsetup">${modeTitle('Abruf','English → German Recall','English comes first. Pick the German word. Use current block for block-wise practice, or choose learned words for revision.')}${packControls('recall')}<div class="vt-row"><select class="vt-select" id="recallScope">${recallScopeOptions(r.scope)}</select><select class="vt-select" id="recallCount"><option value="10">10 random</option><option value="15">15 random</option><option value="20">20 random</option><option value="25">25 random</option><option value="all">Alle in source</option></select><button class="vt-btn vt-btn-primary" id="recallStart">Start →</button></div>${shortcutLine('This is the hard direction: English meaning → German word. Shortcuts: 1-4 answer · Space start')}</div>`;
      wirePackControls('recall', renderRecall);
      $('#recallScope').value = r.scope; $('#recallCount').value = r.count;
      $('#recallScope').addEventListener('change', e => r.scope = e.target.value);
      $('#recallCount').addEventListener('change', e => r.count = e.target.value);
      $('#recallStart').addEventListener('click', startRecall);
      return;
    }
    if(r.idx >= r.queue.length){
      const pct = r.total ? Math.round(r.correct / r.total * 100) : 0;
      $('#vtBody').innerHTML = `<div class="vt-qend"><div class="vt-qend-score">${r.correct}/${r.total}</div><div class="vt-qend-label">${pct}% Richtig · English → German</div><button class="vt-btn vt-btn-primary" id="recallAgain">Nochmal</button></div>`;
      $('#recallAgain').addEventListener('click', startRecall);
      return;
    }
    const w = r.queue[r.idx];
    const optionPool = recallPoolByScope(r.scope).length >= 4 ? recallPoolByScope(r.scope) : (poolByScope('chapter').length >= 4 ? poolByScope('chapter') : poolByScope('all'));
    const options = r.options.length && !r.answered ? r.options : makeOptions(w, optionPool, 'en2de');
    r.options = options; r.correctText = headword(w.term);
    $('#vtBody').innerHTML = `<div class="vt-qarea"><div class="vt-scorebar"><span>${r.idx+1}/${r.queue.length} · ${escapeHtml(chunkLabel())}</span><span>${r.correct} richtig</span></div><div class="vt-qprompt"><div class="vt-qprompt-label">English first: choose the German word</div><div class="vt-qprompt-main">${escapeHtml(w.translation)}</div><div class="vt-progress-mini">No sound before answering, because audio would reveal the German word.</div><button class="vt-iconbtn vt-qprompt-speak" id="recallSpeak" disabled>${SPEAK_ICON}</button></div><div class="vt-options">${options.map((o,i) => `<button class="vt-option" data-val="${escapeHtml(o)}"><span style="opacity:.55;font-weight:900">${i+1}.</span> ${renderTerm(o)}</button>`).join('')}</div><div class="vt-typefeedback" id="recallFeedback"></div>${shortcutLine('1-4 answer · ↑ sound after answering')}</div>`;
    const sp = $('#recallSpeak'); if(sp) sp.addEventListener('click', () => speak(headword(w.term), sp));
    $$('.vt-option').forEach(b => b.addEventListener('click', () => {
      if(r.answered) return;
      r.answered = true; r.total++;
      const ok = b.dataset.val === r.correctText;
      if(ok){ r.correct++; setStatus(w.id, 'known'); }
      else if(getStatus(w.id) !== 'known') setStatus(w.id, 'learning');
      $$('.vt-option').forEach(x => { x.disabled = true; if(x.dataset.val === r.correctText) x.classList.add('is-correct'); });
      if(!ok) b.classList.add('is-wrong');
      const fb = $('#recallFeedback');
      if(fb){
        fb.className = 'vt-typefeedback ' + (ok ? 'ok' : 'bad');
        fb.innerHTML = `${ok ? '✓ Richtig!' : '✕ Correct: ' + renderTerm(r.correctText)}<div style="margin-top:10px;font-size:16px;color:var(--ink-2)">German example: „${escapeHtml(w.example)}”</div>`;
      }
      if(sp) sp.disabled = false;
      renderOverall(); renderChapters();
      setTimeout(() => { r.idx++; r.answered = false; r.options = []; renderRecall(); }, 1400);
    }));
  }

  function matchSpeakTarget(){
    if(!state.match.cards.length) return null;
    if(state.match.selected !== null){
      const c = state.match.cards[state.match.selected];
      if(c.side === 'de') return c.text;
      const w = WORD_BY_ID[c.id]; if(w) return headword(w.term);
    }
    const first = state.match.cards.find(c => c.side === 'de' && !state.match.matched.has(c.id));
    return first ? first.text : null;
  }
  function startMatch(){
    let pool = poolByScope(state.match.scope); if(pool.length < state.match.size) pool = poolByScope('chapter'); if(pool.length < state.match.size) pool = poolByScope('all');
    const chosen = shuffle(pool).slice(0,state.match.size);
    const cards = [];
    chosen.forEach(w => { cards.push({id:w.id, side:'de', text:headword(w.term)}); cards.push({id:w.id, side:'en', text:w.translation}); });
    state.match.cards = shuffle(cards); state.match.selected=null; state.match.matched=new Set(); state.match.moves=0; renderMatch();
  }
  function renderMatch(){
    if(!state.match.cards.length){ $('#vtBody').innerHTML = `<div class="vt-qsetup"><h2 class="vt-mode-title">Matching Game</h2><p class="vt-mode-copy">Match German words with English meanings. Use the same block instead of the full chapter.</p>${packControls('match')}<div class="vt-row"><select class="vt-select" id="matchScope">${scopeOptions(state.match.scope)}</select><select class="vt-select" id="matchSize"><option value="4">4 pairs</option><option value="6">6 pairs</option><option value="8">8 pairs</option><option value="10">10 pairs</option></select><button class="vt-btn vt-btn-primary" id="matchStart">Start →</button></div>${shortcutLine('Shortcut: ↑ = speak selected/next German card')}</div>`; wirePackControls('match', renderMatch); $('#matchScope').value=state.match.scope; $('#matchSize').value=String(state.match.size); $('#matchScope').addEventListener('change', e => state.match.scope=e.target.value); $('#matchSize').addEventListener('change', e => state.match.size=Number(e.target.value)); $('#matchStart').addEventListener('click', startMatch); return; }
    $('#vtBody').innerHTML = `<div class="vt-scorebar"><span>Moves: <b>${state.match.moves}</b> · ${escapeHtml(chunkLabel())}</span><div class="vt-row"><button class="vt-iconbtn vt-speak-big" id="matchSpeak">${SPEAK_ICON}<span>Hören</span></button><button class="vt-btn vt-btn-ghost" id="matchRestart">Neu mischen</button></div></div><div class="vt-matchgrid">${state.match.cards.map((c,i) => `<button class="vt-matchcard ${state.match.matched.has(c.id)?'is-matched':''} ${state.match.selected===i?'is-selected':''}" data-i="${i}" ${state.match.matched.has(c.id)?'disabled':''}>${c.side==='de'?renderTerm(c.text):escapeHtml(c.text)}</button>`).join('')}</div>${shortcutLine('Click a card, then click its pair. ↑ speaks selected German word.')}`;
    $('#matchRestart').addEventListener('click', startMatch);
    const ms = $('#matchSpeak'); if(ms) ms.addEventListener('click', () => { const t = matchSpeakTarget(); if(t) speak(t, ms); });
    $$('.vt-matchcard').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.i); const c = state.match.cards[i]; if(state.match.selected===null){ state.match.selected=i; renderMatch(); return; } const s = state.match.cards[state.match.selected]; if(s.side === c.side){ state.match.selected=i; renderMatch(); return; } state.match.moves++; if(s.id === c.id){ state.match.matched.add(c.id); setStatus(c.id,'known'); state.match.selected=null; renderOverall(); renderChapters(); if(state.match.matched.size===state.match.size) toast('Great! Batch complete.'); renderMatch(); } else { b.classList.add('is-wrong'); setTimeout(() => { state.match.selected=null; renderMatch(); }, 450); } }));
  }

  function startType(){ let pool = poolByScope(state.type.scope); if(!pool.length) pool = poolByScope('chapter'); if(!pool.length) pool = poolByScope('all'); const n = state.type.count==='all'?pool.length:Math.min(Number(state.type.count), pool.length); state.type.queue=shuffle(pool).slice(0,n); state.type.idx=0; state.type.correct=0; state.type.total=0; state.type.phase='run'; state.type.revealed=false; state.type.feedback=null; renderType(); }
  function renderType(){
    const t = state.type;
    if(t.phase==='setup'){ $('#vtBody').innerHTML = `<div class="vt-qsetup">${modeTitle('Tippen','Type Practice','Type only from the current small block. German example is hidden until you check.')}${packControls('type')}<div class="vt-row"><select class="vt-select" id="typeScope">${scopeOptions(t.scope)}</select><select class="vt-select" id="typeCount"><option value="10">10</option><option value="15">15</option><option value="25">25</option><option value="all">Alle in pack/scope</option></select><button class="vt-btn vt-btn-primary" id="typeStart">Start →</button></div>${shortcutLine('Shortcuts: Enter / → = check or next · ↑ = sound')}</div>`; wirePackControls('type', renderType); $('#typeScope').value=t.scope; $('#typeCount').value=t.count; $('#typeScope').addEventListener('change', e => t.scope=e.target.value); $('#typeCount').addEventListener('change', e => t.count=e.target.value); $('#typeStart').addEventListener('click', startType); return; }
    if(t.idx >= t.queue.length){ const pct = t.total ? Math.round(t.correct/t.total*100) : 0; $('#vtBody').innerHTML = `<div class="vt-qend"><div class="vt-qend-score">${t.correct}/${t.total}</div><div class="vt-qend-label">${pct}% Richtig</div><button class="vt-btn vt-btn-primary" id="typeAgain">Nochmal</button></div>`; $('#typeAgain').addEventListener('click', startType); return; }
    const w = t.queue[t.idx]; const target = headword(w.term); const enEx = '';
    $('#vtBody').innerHTML = `<div class="vt-qarea"><div class="vt-scorebar"><span>${t.idx+1}/${t.queue.length} · ${escapeHtml(chunkLabel())}</span><span>${t.correct} richtig</span></div><div class="vt-qprompt"><div class="vt-qprompt-label">Type the German word</div><div class="vt-qprompt-main">${escapeHtml(w.translation)}</div><div class="vt-qprompt-example">${enEx ? `Target word: <span>${escapeHtml(headword(w.term))} = ${escapeHtml(w.translation)}</span>` : 'No German sentence shown before checking.'}</div></div><input class="vt-typeinput ${t.feedback?t.feedback.cls:''}" id="typeInput" autocomplete="off" spellcheck="false" placeholder="der Fluss..." ${t.revealed?'disabled':''} value="${t.revealed?escapeHtml(target):''}"><div class="vt-typefeedback ${t.feedback?t.feedback.cls:''}">${t.feedback?t.feedback.msg:''}${t.revealed ? `<div style="margin-top:10px;font-size:16px;color:var(--ink-2)">German example: „${escapeHtml(w.example)}”${enEx?`<br><span style="color:var(--ink-dim)">${escapeHtml(enEx)}</span>`:''}</div>` : ''}</div><div class="vt-row"><button class="vt-btn vt-btn-primary" id="typeCheck">${t.revealed?'Weiter →':'Prüfen'}</button><button class="vt-btn vt-btn-ghost" id="typeReveal">Zeig’s mir</button><button class="vt-iconbtn vt-speak-big" id="typeSpeak">${SPEAK_ICON}<span>Hören</span></button></div>${shortcutLine('Enter / → check or next · ↑ sound')}</div>`;
    const input = $('#typeInput'); if(input && !t.revealed) input.focus();
    $('#typeSpeak').addEventListener('click', () => speak(target, $('#typeSpeak')));
    $('#typeReveal').addEventListener('click', () => { t.revealed=true; t.feedback={cls:'partial', msg:'Answer shown.'}; if(getStatus(w.id)!=='known') setStatus(w.id,'learning'); renderType(); });
    $('#typeCheck').addEventListener('click', () => { if(t.revealed){ t.idx++; t.revealed=false; t.feedback=null; renderType(); return; } const raw = input.value.trim(); if(!raw) return; t.total++; const norm = s => s.toLowerCase().replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss').replace(/\s+/g,' ').trim(); const ok = norm(raw)===norm(target) || norm(stripArticle(raw))===norm(stripArticle(target)); if(ok){ t.correct++; t.feedback={cls:'ok', msg:'✓ Richtig!'}; setStatus(w.id,'known'); } else { t.feedback={cls:'bad', msg:'✕ Correct: '+target}; if(getStatus(w.id)!=='known') setStatus(w.id,'learning'); } t.revealed=true; renderOverall(); renderChapters(); renderType(); });
    if(input) input.addEventListener('keydown', e => { if(e.key==='Enter' || e.key==='ArrowRight'){ e.preventDefault(); $('#typeCheck').click(); } else if(e.key==='ArrowUp'){ e.preventDefault(); $('#typeSpeak').click(); } });
  }

  function readPool(){
    let pool = learnPool();
    if(!pool.length) pool = chapterWords(state.chapter);
    if(!pool.length) pool = VOCAB_DATA.flatMap(c => c.words);
    return pool;
  }
  function chooseReadWords(force=false){
    const pool = readPool();
    const poolIds = new Set(pool.map(w => w.id));
    const stillValid = state.read.usedIds.length && state.read.usedIds.every(id => poolIds.has(id));
    if(!force && stillValid) return state.read.usedIds.map(id => WORD_BY_ID[id]).filter(Boolean);
    const learning = pool.filter(w => getStatus(w.id) === 'learning');
    const fresh = pool.filter(w => getStatus(w.id) === 'new');
    const known = pool.filter(w => getStatus(w.id) === 'known');
    const ordered = shuffle(learning.concat(fresh, known)).filter(w => w.example);
    // Reading mode now uses the whole small pack/block, not only 8-9 words.
    // If someone selects a huge scope, keep it practical by taking 20 words.
    const targetCount = Math.min(20, ordered.length || pool.length);
    const chosen = ordered.slice(0, targetCount);
    state.read.usedIds = chosen.map(w => w.id);
    return chosen;
  }
  function normalizeSimpleSentence(s){
    s = String(s || '').replace(/\s+/g,' ').trim();
    if(!/[.!?]$/.test(s)) s += '.';
    return s;
  }
  function readParagraph(words){
    const starters = ['Heute', 'Zuerst', 'Dann', 'Außerdem', 'Später', 'Am Ende', 'Deshalb', 'Trotzdem', 'Danach'];
    const sentences = words.map((w, i) => {
      let ex = normalizeSimpleSentence(w.example);
      if(i === 0 && !/^(Heute|Zuerst|Dann|Außerdem|Später|Am Ende|Deshalb|Trotzdem|Danach)\b/.test(ex)){
        ex = starters[i] + ' ' + ex.charAt(0).toLowerCase() + ex.slice(1);
      }
      return ex;
    });
    return sentences.join(' ');
  }
  function readEnglish(words){
    return words.map(w => normalizeSimpleSentence(exampleEnglish(w) || `${headword(w.term)} = ${w.translation}`)).join(' ');
  }
  function makeTip(w){
    const art = extractArticle(w.term);
    const artPart = art ? `${art} · ` : '';
    const plural = pluralPart(w.term);
    const pluralPartText = plural ? ` · plural: ${plural}` : '';
    return `${headword(w.term)} → ${w.translation}${pluralPartText}`;
  }
  function termVariants(w){
    const variants = [];
    function add(v){
      v = String(v || '').replace(/\([^)]*\)/g,'').trim();
      if(v.length > 1 && !variants.some(x => x.toLowerCase() === v.toLowerCase())) variants.push(v);
    }
    add(headword(w.term));
    add(nounOnly(w.term));
    const p = pluralPart(w.term);
    if(p && !p.startsWith('-')) add(p.replace(/^(der|die|das)\s+/i,''));
    return variants;
  }

  const COMMON_WORD_TIPS = {
    'der':'the / of the (masc. nominative OR fem. genitive/dative)', 'die':'the (fem. or plural)', 'das':'the / that (neuter)',
    'ein':'a / one', 'eine':'a / one', 'einen':'a / one', 'einem':'a / one', 'einer':'a / one', 'kein':'no / not a', 'keine':'no / not a',
    'ich':'I', 'du':'you', 'er':'he', 'sie':'she / they', 'es':'it', 'wir':'we', 'ihr':'you all', 'mich':'me', 'dich':'you', 'uns':'us', 'ihn':'him', 'ihre':'her / their', 'sein':'his / to be',
    'ist':'is', 'sind':'are', 'war':'was', 'waren':'were', 'bin':'am', 'bist':'are', 'hat':'has', 'haben':'have', 'hatte':'had', 'hatten':'had', 'wird':'will / becomes', 'werden':'will / become',
    'kann':'can', 'können':'can', 'muss':'must', 'müssen':'must', 'möchte':'would like', 'möchten':'would like', 'soll':'should', 'darf':'may / allowed',
    'und':'and', 'oder':'or', 'aber':'but', 'denn':'because', 'weil':'because', 'wenn':'when / if', 'dass':'that', 'ob':'whether / if', 'deshalb':'therefore', 'daher':'therefore', 'darum':'that is why', 'trotzdem':'nevertheless', 'also':'so',
    'in':'in', 'im':'in the', 'an':'at / on', 'am':'at the / on the', 'auf':'on', 'aus':'from / out of', 'von':'from / of', 'vom':'from the / of the', 'zu':'to', 'zum':'to the', 'zur':'to the', 'mit':'with', 'für':'for', 'ohne':'without', 'nach':'after / to', 'vor':'before / in front of', 'über':'over / about', 'unter':'under', 'zwischen':'between', 'durch':'through', 'gegen':'against / around', 'bei':'at / with', 'bis':'until / up to',
    'heute':'today', 'morgen':'tomorrow / morning', 'gestern':'yesterday', 'später':'later', 'dann':'then', 'danach':'after that', 'zuerst':'first', 'außerdem':'besides / also', 'am':'at/on the', 'ende':'end', 'oft':'often', 'immer':'always', 'nie':'never', 'schon':'already', 'noch':'still / another', 'nur':'only', 'sehr':'very', 'so':'so', 'auch':'also', 'hier':'here', 'dort':'there', 'oben':'up there / at the top', 'unten':'at the bottom', 'links':'left', 'rechts':'right', 'wieder':'again',
    'viel':'much / a lot', 'viele':'many', 'mehr':'more', 'als':'than / as', 'wenig':'little', 'etwas':'something / a little', 'alle':'all', 'alles':'everything', 'jeder':'each / every', 'jede':'each / every', 'jeden':'each / every', 'man':'one / people',
    'gut':'good', 'besser':'better', 'schön':'beautiful', 'alt':'old', 'neu':'new', 'groß':'big', 'klein':'small', 'lang':'long', 'kurz':'short', 'leicht':'easy / light', 'schwer':'difficult / heavy', 'einfach':'simple', 'interessant':'interesting', 'wichtig':'important', 'richtig':'correct / proper',
    'gehen':'to go', 'geht':'goes / is going', 'fahren':'to travel/drive', 'fährt':'travels/drives', 'machen':'to do / make', 'macht':'does / makes', 'sehen':'to see', 'sieht':'sees', 'lernen':'to learn', 'besuchen':'to visit', 'essen':'to eat', 'trinken':'to drink', 'bleiben':'to stay', 'suchen':'to search/look for', 'finden':'to find', 'brauchen':'to need', 'nehmen':'to take', 'geben':'to give / there is', 'gibt':'gives / there is',
    'mosel':'Moselle river', 'rhein':'Rhine river', 'burg':'castle', 'burgen':'castles', 'mauer':'wall', 'mauern':'walls', 'fluss':'river', 'flusses':'of the river', 'dorf':'village', 'dörfer':'villages', 'kirche':'church', 'touristen':'tourists', 'ruhe':'peace / quiet', 'meter':'metre', 'km':'kilometres', 'kilometer':'kilometre',
    'region':'region', 'reise':'trip / journey', 'urlaub':'holiday', 'weg':'path / way', 'wege':'paths', 'wanderweg':'hiking path', 'radwege':'cycling paths', 'fahrradtour':'bike tour', 'gasthaus':'guesthouse / restaurant', 'küche':'cuisine / kitchen'
  };
  let ALL_VOCAB_TIP_MAP = null;
  function normalizeWordKey(s){
    return String(s || '').toLowerCase().replace(/[„“”"'.,!?;:()\[\]{}]/g,'').trim();
  }
  function addTipToMap(map, key, tip){
    key = normalizeWordKey(key);
    if(key && key.length > 1 && !map[key]) map[key] = tip;
  }
  function allVocabTipMap(){
    if(ALL_VOCAB_TIP_MAP) return ALL_VOCAB_TIP_MAP;
    const map = {};
    VOCAB_DATA.forEach(ch => ch.words.forEach(w => {
      const tip = makeTip(w);
      termVariants(w).forEach(v => addTipToMap(map, v, tip));
      addTipToMap(map, stripArticle(headword(w.term)), tip);
    }));
    ALL_VOCAB_TIP_MAP = map;
    return map;
  }
  function makeAiGlossaryMap(glossary){
    const map = {};
    if(Array.isArray(glossary)){
      glossary.forEach(item => {
        if(typeof item === 'string') return;
        const word = item.word || item.german || item.term || item.de;
        const meaning = item.meaning || item.english || item.translation || item.en;
        if(word && meaning) addTipToMap(map, word, `${word} → ${meaning}`);
      });
    } else if(glossary && typeof glossary === 'object'){
      Object.keys(glossary).forEach(k => addTipToMap(map, k, `${k} → ${glossary[k]}`));
    }
    return map;
  }
  function inflectionGuesses(key){
    const guesses = [key];
    ['es','en','er','em','e','s','n'].forEach(suf => {
      if(key.length > suf.length + 3 && key.endsWith(suf)) guesses.push(key.slice(0, -suf.length));
    });
    return guesses;
  }
  function lookupWordTip(rawWord, targetMap, aiMap){
    const key = normalizeWordKey(rawWord);
    if(!key) return '';
    for(const k of inflectionGuesses(key)){
      if(targetMap[k]) return targetMap[k];
      if(aiMap[k]) return aiMap[k];
      if(allVocabTipMap()[k]) return allVocabTipMap()[k];
      if(COMMON_WORD_TIPS[k]) return `${rawWord} → ${COMMON_WORD_TIPS[k]}`;
    }
    return `${rawWord} → no saved meaning yet · click to ask AI`;
  }
  function buildTargetMap(words){
    const map = {};
    words.forEach(w => {
      const tip = makeTip(w);
      termVariants(w).forEach(v => addTipToMap(map, v, tip));
      addTipToMap(map, stripArticle(headword(w.term)), tip);
    });
    return map;
  }
  function findTargetAt(text, i, terms){
    for(const item of terms){
      const t = item.t;
      if(text.slice(i, i + t.length).toLowerCase() === t.toLowerCase()){
        const before = i === 0 ? ' ' : text[i-1];
        const after = i + t.length >= text.length ? ' ' : text[i+t.length];
        if(!/[A-Za-zÀ-ÿÄÖÜäöüß]/.test(before) && !/[A-Za-zÀ-ÿÄÖÜäöüß]/.test(after)) return item;
      }
    }
    return null;
  }
  function highlightTerms(text, words, glossary){
    const aiMap = makeAiGlossaryMap(glossary);
    const targetMap = buildTargetMap(words || []);
    const targetTerms = [];
    (words || []).forEach(w => termVariants(w).forEach(t => targetTerms.push({t, w})));
    targetTerms.sort((a,b) => b.t.length - a.t.length);
    let out = '';
    let i = 0;
    const wordRe = /^[A-Za-zÀ-ÿÄÖÜäöüß]+(?:-[A-Za-zÀ-ÿÄÖÜäöüß]+)?/;
    while(i < text.length){
      const targetHit = findTargetAt(text, i, targetTerms);
      if(targetHit){
        const shown = text.slice(i, i + targetHit.t.length);
        const tip = makeTip(targetHit.w);
        out += `<mark class="vt-word-tip vt-term-mark" tabindex="0" data-word="${escapeAttr(headword(targetHit.w.term))}" data-tip="${escapeAttr(tip)}" title="${escapeAttr(tip)}">${escapeHtml(shown)}</mark>`;
        i += targetHit.t.length;
        continue;
      }
      const rest = text.slice(i);
      const m = rest.match(wordRe);
      if(m){
        const shown = m[0];
        const tip = lookupWordTip(shown, targetMap, aiMap);
        const cls = /no saved meaning/i.test(tip) ? 'vt-word-tip is-unknown' : 'vt-word-tip';
        out += `<span class="${cls}" tabindex="0" data-word="${escapeAttr(shown)}" data-tip="${escapeAttr(tip)}" title="${escapeAttr(tip)}">${escapeHtml(shown)}</span>`;
        i += shown.length;
      } else {
        out += escapeHtml(text[i]);
        i++;
      }
    }
    return out;
  }

  function loadGroqKey(){
    // A key on the server (MoselAI.SERVER) counts as available; a key you paste always wins.
    let saved = '';
    try { saved = localStorage.getItem(groqKeyStorage) || ''; } catch(e){}
    return saved || (window.MoselAI && MoselAI.serverAI ? MoselAI.SERVER : '');
  }
  function saveGroqKey(key){
    try { if(key) localStorage.setItem(groqKeyStorage, key); } catch(e){}
  }
  function clearGroqKey(){
    try { localStorage.removeItem(groqKeyStorage); } catch(e){}
    state.read.tempKey = '';
    state.read.aiStatus = 'Groq key cleared.';
    state.read.aiError = '';
  }
  function extractJsonObject(text){
    text = String(text || '').trim();
    if(!text) throw new Error('Empty model response');
    try { return JSON.parse(text); } catch(e){}
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if(start >= 0 && end > start){ return JSON.parse(text.slice(start, end + 1)); }
    throw new Error('Model did not return valid JSON');
  }
  function cleanModelText(s){
    return String(s || '').replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  }
  function randomParagraphScenario(){
    const places = ['an der Mosel', 'in Koblenz', 'in einem kleinen Dorf', 'bei einer Burg', 'auf einem Wochenendausflug', 'während einer Fahrradtour', 'in einer Pension', 'auf einem Wanderweg'];
    const situations = ['zwei Freunde planen einen ruhigen Tag', 'eine Familie entdeckt die Region', 'ein Tourist schreibt einen Blogeintrag', 'eine kleine Gruppe sucht einen schönen Ausblick', 'Anna und Max machen eine kurze Reise', 'ein Reiseführer erklärt die Umgebung', 'ein Gast spricht mit der Touristeninformation', 'Freunde vergleichen zwei Routen'];
    const moods = ['ruhig und praktisch', 'freundlich und lebendig', 'wie ein kurzer Reisebericht', 'wie eine kleine Alltagsszene', 'mit einfachen Dialog-Gefühlen', 'mit klarer Reihenfolge: zuerst, dann, später'];
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    return `${pick(situations)} ${pick(places)}; style: ${pick(moods)}; variation seed: ${Date.now()}-${Math.floor(Math.random()*100000)}`;
  }
  function normalizeForTargetMatch(s){
    return String(s || '').toLowerCase()
      .replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss')
      .replace(/[„“”"'.,!?;:()\[\]{}]/g,' ')
      .replace(/[–—…]/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }
  function targetConceptPresent(text, w){
    const normalText = ' ' + normalizeForTargetMatch(text) + ' ';
    const wordsInText = normalText.trim().split(/\s+/).filter(Boolean);
    const variants = termVariants(w).concat([headword(w.term), stripArticle(headword(w.term)), nounOnly(w.term)]);
    for(const raw of variants){
      const v = normalizeForTargetMatch(raw);
      if(!v || v.length < 2) continue;
      if(v.endsWith('-')){
        const stem = v.slice(0, -1);
        if(stem && wordsInText.some(x => x.startsWith(stem))) return true;
      }
      if(v.includes(' ')){
        const parts = v.split(/\s+/).filter(Boolean);
        if(parts.every(part => normalText.includes(' ' + part + ' '))) return true;
      }
      if(normalText.includes(' ' + v + ' ')) return true;
      // Simple German inflection tolerance: regional -> regionale/regionalen, dick -> dicke/dicken, etc.
      if(wordsInText.some(x => x === v || x.startsWith(v) || inflectionGuesses(x).includes(v))) return true;
    }
    return false;
  }
  function missingTargetWords(text, words){
    return (words || []).filter(w => !targetConceptPresent(text, w)).map(w => headword(w.term));
  }
  function groqPrompt(words, extraMissing){
    const list = words.map((w, i) => `${i+1}. ${headword(w.term)} (${w.translation}) — example: ${w.example}`).join('\n');
    const scenario = randomParagraphScenario();
    const missingLine = extraMissing && extraMissing.length
      ? `\nImportant retry instruction: The previous paragraph missed these target words, so include them clearly this time: ${extraMissing.join(', ')}.\n`
      : '';
    return `Write a natural German reading text for a Goethe B1 beginner learner.

VERY IMPORTANT STYLE RULES:
- German level: simple A2/B1.
- Use 10-14 SHORT sentences, not a few long sentences.
- Each German sentence should usually be 6-12 words. Absolute maximum: 14 words.
- Use at most ONE comma per sentence. Avoid long relative clauses.
- Use natural B1 German. Do NOT sound like a word list.
- Spread the target words across many short sentences. Use only 1-2 target words per sentence.
- You MUST use EVERY target word/concept from the list at least once. Use correct inflected forms if grammar needs it.
- If a word is difficult to combine naturally, create a separate simple sentence for it.
- Do not keep generating the same Mosel paragraph. Use this fresh scenario: ${scenario}.
- Keep grammar simple: present tense, perfect tense, modal verbs, simple connectors.
- Good connectors: Zuerst, Dann, Später, Danach, Außerdem, Am Ende, Deshalb.
- Avoid unnatural phrases like "ideal für das Fließen". Say natural things like "Der Fluss fließt..." or "Der Weg ist ideal für eine Tour".
- Also provide a simple English translation.
- Provide 3 very easy comprehension questions in German.
- In used_words, list ALL target words you used.
${missingLine}
Target words from the learner's current block:
${list}

Return ONLY valid JSON with this exact shape:
{
  "german": "...",
  "english": "...",
  "used_words": ["..."],
  "questions": ["...", "...", "..."],
  "glossary": {"German word from paragraph": "simple English meaning"}
}

Glossary rule: include every important word from the German text, including small words like articles, prepositions, verbs, and nouns when possible.`;
  }

  async function callGroqForParagraph(apiKey, words){
    async function oneCall(extraMissing){
      const body = {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {role: 'system', content: 'You are a careful German teacher. Generate natural, short-sentence, learner-friendly German. Return only valid JSON.'},
          {role: 'user', content: groqPrompt(words, extraMissing)}
        ],
        temperature: 1.05,
        max_tokens: 1700,
        presence_penalty: 0.35,
        frequency_penalty: 0.45,
        response_format: {type: 'json_object'}
      };
      let res = await MoselAI.chat(body, apiKey);
      if(!res.ok){
        const errText = await res.text().catch(() => '');
        // Some API layers can reject response_format. Retry once without it.
        if(/response_format/i.test(errText) || /json_object/i.test(errText)){
          delete body.response_format;
          res = await MoselAI.chat(body, apiKey);
        }
      }
      if(!res.ok){
        const errText = await res.text().catch(() => '');
        throw new Error((errText || ('Groq error: HTTP ' + res.status)).slice(0, 260));
      }
      const data = await res.json();
      const raw = cleanModelText(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
      const obj = extractJsonObject(raw);
      const german = normalizeSimpleSentence(obj.german || obj.paragraph || obj.text || '');
      const english = normalizeSimpleSentence(obj.english || obj.translation || '');
      const questions = Array.isArray(obj.questions) ? obj.questions.map(q => String(q)).filter(Boolean).slice(0,3) : [];
      const used = Array.isArray(obj.used_words) ? obj.used_words.map(x => String(x)).filter(Boolean) : [];
      const glossary = obj.glossary && typeof obj.glossary === 'object' ? obj.glossary : {};
      if(!german || german.length < 20) throw new Error('AI response was too short. Try again.');
      const missing = missingTargetWords(german, words);
      return {german, english, questions, used, glossary, missing};
    }
    let result = await oneCall([]);
    // One automatic retry if the model forgot some block words.
    if(result.missing && result.missing.length){
      const retry = await oneCall(result.missing).catch(() => null);
      if(retry && retry.missing.length <= result.missing.length) result = retry;
    }
    return result;
  }

  async function generateGroqParagraph(words){
    const input = $('#groqKeyInput');
    const remember = $('#groqRemember');
    const typed = input ? input.value.trim() : '';
    const saved = loadGroqKey();
    const key = typed || state.read.tempKey || saved;
    if(!key){ toast('Paste your Groq API key first.'); return; }
    if(typed){ state.read.tempKey = typed; if(remember && remember.checked) saveGroqKey(typed); }
    state.read.aiStatus = 'Generating varied B1 paragraph with all block words...';
    state.read.aiError = '';
    state.read.ai = null;
    state.read.chat = [];
    state.read.chatStatus = '';
    state.read.chatError = '';
    state.read.chatContext = '';
    renderRead();
    try{
      const result = await callGroqForParagraph(key, words);
      state.read.ai = Object.assign({ids: words.map(w => w.id).join(',')}, result);
      state.read.chat = [];
      state.read.chatStatus = '';
      state.read.chatError = '';
      state.read.chatContext = '';
      state.read.aiStatus = result.missing && result.missing.length ? ('AI paragraph generated, but check missing: ' + result.missing.join(', ')) : ('AI paragraph generated — all ' + words.length + ' block words included.');
      state.read.aiError = '';
    }catch(err){
      state.read.aiStatus = '';
      state.read.aiError = (err && err.message) ? err.message : 'Could not generate AI paragraph.';
      state.read.ai = null;
    }
    renderRead();
  }

  function chatTutorPrompt(paragraph, english, words, questions, userQuestion){
    const vocab = words.map((w, i) => `${i+1}. ${headword(w.term)} = ${w.translation}; example: ${w.example}`).join('\n');
    const qs = (questions || []).map((q, i) => `${i+1}. ${q}`).join('\n') || 'No generated questions.';
    return `You are a friendly German tutor helping a beginner learner.

Current German reading paragraph:
${paragraph}

English support:
${english || 'No English translation available.'}

Target vocabulary from the current block:
${vocab}

Comprehension questions:
${qs}

Learner question:
${userQuestion}

Answer rules:
- Answer the learner's question directly.
- Use simple English explanation with small German examples.
- If explaining grammar, show the rule and 1-2 examples from the paragraph.
- If explaining vocabulary, give meaning, article/plural if relevant, and one easy extra sentence.
- Keep it short and beginner friendly, maximum 160 words.
- Do not invent advanced grammar unless asked.
- If the question is unrelated to this paragraph or German learning, politely redirect to this paragraph.`;
  }

  async function callGroqChat(apiKey, paragraph, english, words, questions, history, userQuestion){
    const safeHistory = (history || []).slice(-6).map(m => ({role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '').slice(0, 1200)}));
    const body = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        {role: 'system', content: 'You are a patient Goethe A2/B1 German tutor. Explain grammar, vocabulary, articles, and comprehension in simple English with short German examples.'},
        ...safeHistory,
        {role: 'user', content: chatTutorPrompt(paragraph, english, words, questions, userQuestion)}
      ],
      temperature: 0.35,
      max_tokens: 550
    };
    const res = await MoselAI.chat(body, apiKey);
    if(!res.ok){
      const errText = await res.text().catch(() => '');
      throw new Error((errText || ('Groq chat error: HTTP ' + res.status)).slice(0, 260));
    }
    const data = await res.json();
    const answer = cleanModelText(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    if(!answer || answer.length < 2) throw new Error('AI tutor gave an empty response. Try again.');
    return answer;
  }

  async function sendReadChat(words, paragraph, english, questions){
    const input = $('#readChatInput');
    const keyInput = $('#groqKeyInput');
    const remember = $('#groqRemember');
    const typedKey = keyInput ? keyInput.value.trim() : '';
    const key = typedKey || state.read.tempKey || loadGroqKey();
    const question = input ? input.value.trim() : '';
    if(!key){ toast('Paste your Groq API key first.'); return; }
    if(!question){ toast('Ask something first.'); return; }
    if(typedKey){ state.read.tempKey = typedKey; if(remember && remember.checked) saveGroqKey(typedKey); }
    const historyBefore = state.read.chat.slice();
    state.read.chat.push({role:'user', content: question});
    state.read.chatStatus = 'AI tutor is thinking...';
    state.read.chatError = '';
    if(input) input.value = '';
    renderRead();
    try{
      const answer = await callGroqChat(key, paragraph, english, words, questions, historyBefore, question);
      state.read.chat.push({role:'assistant', content: answer});
      state.read.chatStatus = '';
      state.read.chatError = '';
    }catch(err){
      state.read.chatStatus = '';
      state.read.chatError = (err && err.message) ? err.message : 'AI tutor failed. Try again.';
    }
    renderRead();
  }


  /* ===== Sentence Builder Mode ===== */
  function tokenizeSentence(sentence){
    const tokens = String(sentence || '')
      .replace(/[„“"]/g, '')
      .match(/[A-Za-zÀ-ÿÄÖÜäöüß0-9]+(?:-[A-Za-zÀ-ÿÄÖÜäöüß0-9]+)?|[.,!?;:]/g) || [];
    const out = [];
    tokens.forEach(t => {
      if(/^[.,!?;:]$/.test(t) && out.length){
        out[out.length - 1] += t;
      } else {
        out.push(t);
      }
    });
    return out;
  }
  function untile(tokens){
    return (tokens || []).join(' ')
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function normalizeSentenceForCheck(s){
    return String(s || '')
      .toLowerCase()
      .replace(/[„“"]/g, '')
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/[.!?;:]+$/,'')
      .replace(/\s+/g,' ')
      .trim();
  }
  function builderPool(){
    let pool = poolByScope(state.builder.scope || 'pack').filter(w => w.example && (exampleEnglish(w) || w.translation));
    if(pool.length < 3 && state.builder.scope === 'pack') pool = poolByScope('chapter').filter(w => w.example);
    return pool;
  }
  function startBuilder(){
    const pool = builderPool();
    state.builder.aiItems = [];
    state.builder.queue = shuffle(pool).map(w => w.id);
    state.builder.idx = 0; state.builder.correct = 0; state.builder.total = 0;
    state.builder.currentId = null; state.builder.tiles = []; state.builder.selected = []; state.builder.feedback = null;
    renderBuilder();
  }

  function builderEnglish(w){
    const en = exampleEnglish(w);
    if(en) return en;
    return `Build a German sentence with: ${headword(w.term)} = ${w.translation}`;
  }
  function builderAiForId(id){
    return (state.builder.aiItems || []).find(x => Number(x.id) === Number(id));
  }
  function badBuilderPattern(german){
    const s = String(german || '').toLowerCase().replace(/\s+/g, ' ').trim();
    // Common AI error with separable verbs: finite verb + dictionary infinitive.
    if(/(ich|du|er|sie|es|wir|ihr|man)\s+(gehe|gehst|geht|gehen)\s+herumgehen/.test(s)) return true;
    if(/herumgehen\s+um/.test(s)) return true;
    if(/(ich|du|er|sie|es|wir|ihr|man)\s+(fühle|fühlst|fühlt|fühlen)\s+zu hause/.test(s) && !/mich|dich|sich|uns|euch/.test(s)) return true;
    return false;
  }
  function isUsableBuilderAiItem(item, w){
    if(!item || !w) return false;
    const german = normalizeSimpleSentence(item.german || '');
    const english = String(item.english || '').trim();
    if(german.length < 4 || english.length < 4) return false;
    if(tokenizeSentence(german).length > 14) return false;
    if(badBuilderPattern(german)) return false;
    return true;
  }
  function builderCurrentItem(){
    const id = state.builder.queue[state.builder.idx];
    const w = WORD_BY_ID[id];
    const curated = BUILDER_CURATED_SENTENCES[Number(id)];
    const ai = builderAiForId(id);
    const chosen = curated || (isUsableBuilderAiItem(ai, w) ? ai : null);
    return {
      w,
      german: normalizeSimpleSentence((chosen && chosen.german) || (w && w.example) || ''),
      english: (chosen && chosen.english) || builderEnglish(w)
    };
  }

  function setupBuilderSentence(item){
    if(state.builder.currentId === item.w.id && state.builder.tiles.length) return;
    const tokens = tokenizeSentence(normalizeSimpleSentence(item.german));
    state.builder.currentId = item.w.id;
    state.builder.tiles = shuffle(tokens.map((text, i) => ({id: i + '-' + Math.random().toString(36).slice(2,7), text})));
    state.builder.selected = [];
    state.builder.feedback = null;
  }
  function currentBuilderBuilt(){
    const selectedSet = new Set(state.builder.selected);
    const selectedTiles = state.builder.selected.map(id => state.builder.tiles.find(t => t.id === id)).filter(Boolean);
    return untile(selectedTiles.map(t => t.text));
  }
  function checkBuilderAnswer(){
    if(state.builder.feedback){ toast('Change tiles, reset, or go next.'); return; }
    const item = builderCurrentItem();
    const w = item.w;
    const target = normalizeSimpleSentence(item.german);
    const built = currentBuilderBuilt();
    state.builder.total++;
    if(normalizeSentenceForCheck(built) === normalizeSentenceForCheck(target)){
      state.builder.correct++;
      state.builder.feedback = {ok:true, text:'Correct! German word order is good.'};
      if(getStatus(w.id) !== 'known') setStatus(w.id, 'learning');
    } else {
      state.builder.feedback = {ok:false, text:'Not yet. Correct order: ' + target};
      setStatus(w.id, 'learning');
    }
    renderShell();
  }
  function nextBuilder(){
    if(state.builder.idx < state.builder.queue.length - 1){
      state.builder.idx++;
      state.builder.currentId = null; state.builder.tiles = []; state.builder.selected = []; state.builder.feedback = null;
      renderBuilder();
    } else {
      state.builder.idx = state.builder.queue.length;
      renderBuilder();
    }
  }

  function groqBuilderPrompt(words){
    const list = words.map((w,i)=>`${i+1}. id=${w.id}; target=${headword(w.term)}; meaning=${w.translation}; saved example=${w.example}`).join('\n');
    return `Create sentence-builder practice for a Goethe A2/B1 German learner.

Rules:
- Use the given target words, but use the correct German form in the sentence.
- Create one natural German sentence per target word.
- Each German sentence: 5-10 words, simple word order, no long clauses.
- English must be an accurate translation of the German sentence.
- For separable verbs, split the prefix correctly: "Ich gehe um die Baustelle herum." NOT "Ich gehe herumgehen um ...".
- For reflexive verbs, include the reflexive pronoun: "Ich fühle mich ...".
- For adjective stems like "besonder-", use an inflected form such as "besondere".
- For suffix entries like "-tags", use a real word such as "samstags".
- Never put the dictionary infinitive as an extra tile after a conjugated verb.
- Avoid weird sentences and avoid overly formal language.
- Return valid JSON only.

Target words:
${list}

Return JSON:
{"items":[{"id": 123, "german":"...", "english":"..."}]}`;
  }
  async function generateBuilderAiSet(){
    const input = $('#builderGroqKey');
    const remember = $('#builderGroqRemember');
    const typed = input ? input.value.trim() : '';
    const key = typed || state.builder.tempKey || loadGroqKey();
    if(!key){ toast('Paste your Groq key here or save it in Absatz first.'); return; }
    if(typed){ state.builder.tempKey = typed; if(remember && remember.checked) saveGroqKey(typed); }
    const words = builderPool().slice(0, PACK_SIZE);
    state.builder.aiStatus = 'Generating natural sentence-builder set with Groq...';
    state.builder.aiError = '';
    renderBuilder();
    try{
      const body = {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {role:'system', content:'You are a careful German teacher. Return only valid JSON.'},
          {role:'user', content:groqBuilderPrompt(words)}
        ],
        temperature: 0.75,
        max_tokens: 1700,
        response_format: {type:'json_object'}
      };
      let res = await MoselAI.chat(body, key);
      if(!res.ok){
        const errText = await res.text().catch(()=>'');
        if(/response_format|json_object/i.test(errText)){
          delete body.response_format;
          res = await MoselAI.chat(body, key);
        }
      }
      if(!res.ok){
        const errText = await res.text().catch(()=>'');
        throw new Error((errText || ('Groq error: HTTP ' + res.status)).slice(0,260));
      }
      const data = await res.json();
      const raw = cleanModelText(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
      const obj = extractJsonObject(raw);
      const items = Array.isArray(obj.items) ? obj.items : [];
      const rawItems = items.map(it => ({
        id: Number(it.id),
        german: normalizeSimpleSentence(it.german || ''),
        english: String(it.english || '').trim()
      })).filter(it => WORD_BY_ID[it.id]);
      const valid = rawItems.filter(it => isUsableBuilderAiItem(it, WORD_BY_ID[it.id]));
      state.builder.aiItems = valid;
      // Keep the whole current pack. Any rejected/missing AI item falls back to a teacher-checked override or saved example.
      state.builder.queue = words.map(w => w.id);
      state.builder.idx = 0; state.builder.correct = 0; state.builder.total = 0; state.builder.currentId = null; state.builder.tiles = []; state.builder.selected = []; state.builder.feedback = null;
      const fallbackCount = Math.max(0, words.length - valid.length);
      state.builder.aiStatus = `AI set checked: ${valid.length}/${words.length} AI sentences used; ${fallbackCount} use teacher/saved examples.`;
      state.builder.aiError = '';
    }catch(err){
      state.builder.aiStatus = '';
      state.builder.aiError = (err && err.message) ? err.message : 'Could not generate AI sentence set.';
    }
    renderBuilder();
  }

  function renderBuilder(){
    const b = state.builder;
    if(!b.queue.length){
      $('#vtBody').innerHTML = `<div class="vt-builder-wrap">
        ${modeTitle('Satz-Baumeister','Sentence Builder','Build German sentences from shuffled blocks. This trains German word order, not only vocabulary.')}
        ${packControls('build')}
        <div class="vt-builder-card">
          <div class="vt-row" style="justify-content:center">
            <select class="vt-select" id="builderScope">${scopeOptions(b.scope)}</select>
            <button class="vt-btn vt-btn-primary" id="builderStart">Start offline builder →</button>
            <button class="vt-btn vt-btn-primary" id="builderAIStart">AI Satz-Set</button>
          </div>
          <div class="vt-builder-ai-panel">
            <h4>AI Satz-Set <span class="vt-bilingual-note">· AI sentence set</span></h4>
            <p>For more natural and correct sentence blocks, Groq can create short A2/B1 sentences for the current block.</p>
            <div class="vt-ai-grid">
              <input class="vt-ai-input" id="builderGroqKey" type="password" autocomplete="off" spellcheck="false" placeholder="${loadGroqKey() || state.builder.tempKey ? 'Groq key ready — leave blank' : 'Paste Groq API key: gsk_...'}">
              <label class="vt-ai-check"><input type="checkbox" id="builderGroqRemember" ${loadGroqKey() ? 'checked' : ''}> save locally</label>
            </div>
            ${b.aiError ? `<div class="vt-ai-status vt-ai-error">${escapeHtml(b.aiError)}</div>` : (b.aiStatus ? `<div class="vt-ai-status vt-ai-good">${escapeHtml(b.aiStatus)}</div>` : '')}
          </div>
          <div class="vt-storage-note">Offline uses saved examples. AI Satz-Set creates fresh natural sentences + accurate English translations.</div>
        </div>
        ${shortcutLine('Shortcuts: Space/Enter = check/next · ↑ = sound after sentence appears')}
      </div>`;
      wirePackControls('build', renderBuilder);
      const sc = $('#builderScope'); if(sc) sc.addEventListener('change', e => b.scope = e.target.value);
      const st = $('#builderStart'); if(st) st.addEventListener('click', startBuilder);
      const aiSt = $('#builderAIStart'); if(aiSt) aiSt.addEventListener('click', generateBuilderAiSet);
      return;
    }
    if(b.idx >= b.queue.length){
      const pct = b.total ? Math.round(b.correct / b.total * 100) : 0;
      $('#vtBody').innerHTML = `<div class="vt-qend"><div class="vt-qend-score">${b.correct}/${b.total}</div><div class="vt-qend-label">${pct}% Satzbau</div><button class="vt-btn vt-btn-primary" id="builderAgain">Again</button></div>`;
      $('#builderAgain').addEventListener('click', startBuilder);
      return;
    }
    const item = builderCurrentItem();
    const w = item.w;
    setupBuilderSentence(item);
    const selectedSet = new Set(b.selected);
    const built = currentBuilderBuilt();
    const en = item.english;
    $('#vtBody').innerHTML = `<div class="vt-builder-wrap">
      ${modeTitle('Satz-Baumeister','Sentence Builder','Arrange the German tiles to build the correct German sentence.')}
      <div class="vt-builder-card">
        <div class="vt-builder-meta">${b.idx+1} / ${b.queue.length} · ${escapeHtml(chunkLabel())} · score ${b.correct}/${b.total}${(b.aiItems&&b.aiItems.length)?' · AI sentences':''}</div>
        <div class="vt-builder-prompt">${escapeHtml(en)}</div>
        <div class="vt-builder-meta">Your German sentence</div>
        <div class="vt-builder-target" id="builderTarget">
          ${b.selected.length ? b.selected.map(id => {
            const t = b.tiles.find(x => x.id === id);
            return t ? `<button class="vt-tile is-selected" data-remove-tile="${escapeAttr(id)}">${escapeHtml(t.text)}</button>` : '';
          }).join('') : '<span class="vt-grammar-empty">Click tiles below to build the sentence...</span>'}
        </div>
        <div class="vt-builder-meta">Available tiles</div>
        <div class="vt-builder-bank">
          ${b.tiles.filter(t => !selectedSet.has(t.id)).map(t => `<button class="vt-tile" data-add-tile="${escapeAttr(t.id)}">${escapeHtml(t.text)}</button>`).join('')}
        </div>
        ${b.feedback ? `<div class="vt-builder-feedback ${b.feedback.ok ? 'ok' : 'bad'}">${escapeHtml(b.feedback.text)}</div>` : ''}
        <div class="vt-row" style="margin-top:18px">
          <button class="vt-iconbtn vt-speak-big" id="builderSpeak">${SPEAK_ICON}<span>Hören</span></button>
          <button class="vt-btn vt-btn-primary" id="builderCheck">${b.feedback && b.feedback.ok ? 'Next →' : 'Check'}</button>
          <button class="vt-btn vt-btn-ghost" id="builderReset">Reset</button>
          <button class="vt-btn vt-btn-ghost" id="builderShow">Show answer</button>
          <button class="vt-btn vt-btn-ghost" id="builderSkip">Next / Skip</button>
        </div>
        <div class="vt-storage-note"><b>Target word:</b> ${renderTerm(headword(w.term))} · ${escapeHtml(w.translation)}</div>
      </div>
    </div>`;
    $$('[data-add-tile]').forEach(btn => btn.addEventListener('click', () => { b.selected.push(btn.dataset.addTile); b.feedback = null; renderBuilder(); }));
    $$('[data-remove-tile]').forEach(btn => btn.addEventListener('click', () => { b.selected = b.selected.filter(id => id !== btn.dataset.removeTile); b.feedback = null; renderBuilder(); }));
    const ch = $('#builderCheck'); if(ch) ch.addEventListener('click', () => { if(b.feedback && b.feedback.ok) nextBuilder(); else checkBuilderAnswer(); });
    const rs = $('#builderReset'); if(rs) rs.addEventListener('click', () => { b.selected = []; b.feedback = null; renderBuilder(); });
    const sh = $('#builderShow'); if(sh) sh.addEventListener('click', () => { b.feedback = {ok:false, text:'Correct order: ' + normalizeSimpleSentence(item.german)}; setStatus(w.id, 'learning'); renderShell(); });
    const sk = $('#builderSkip'); if(sk) sk.addEventListener('click', nextBuilder);
    const sp = $('#builderSpeak'); if(sp) sp.addEventListener('click', () => speak(normalizeSimpleSentence(item.german), sp));
  }

  /* ===== Grammar Click + AI Answer Check ===== */
  function localGrammarInfo(word, words, paragraph, glossary){
    const clean = String(word || '').trim();
    const lower = clean.toLowerCase();
    const aiMap = makeAiGlossaryMap(glossary);
    const targetMap = buildTargetMap(words || []);
    let target = null;
    for(const w of (words || [])){
      if(termVariants(w).some(v => v.toLowerCase() === lower || lower.startsWith(v.toLowerCase()))) { target = w; break; }
    }
    const meaning = target ? makeTip(target) : lookupWordTip(clean, targetMap, aiMap);
    const lines = [];
    lines.push(`<div class="vt-grammar-line"><b>Meaning:</b> ${escapeHtml(meaning)}</div>`);
    if(target){
      const art = extractArticle(target.term);
      const plural = pluralPart(target.term);
      if(art) lines.push(`<div class="vt-grammar-line"><b>Article:</b> ${escapeHtml(art)} — learn the noun as “${escapeHtml(art + ' ' + nounOnly(target.term))}”.</div>`);
      if(plural) lines.push(`<div class="vt-grammar-line"><b>Plural:</b> ${escapeHtml(plural)}</div>`);
      lines.push(`<div class="vt-grammar-line"><b>Example:</b> ${escapeHtml(target.example)}</div>`);
    }
    if(['der','die','das','den','dem','des'].includes(lower)){
      const expl = {
        der:'can mean masculine nominative, or feminine genitive/dative. Example: der Burg = of the castle / at the castle.',
        die:'can mean feminine nominative/accusative or plural nominative/accusative.',
        das:'neuter article, also “that”.',
        den:'masculine accusative or plural dative article.',
        dem:'masculine/neuter dative article.',
        des:'masculine/neuter genitive article, meaning “of the”.'
      }[lower];
      lines.push(`<div class="vt-grammar-line"><b>Article/case note:</b> ${escapeHtml(expl)}</div>`);
    } else if(/^[A-ZÄÖÜ]/.test(clean)){
      lines.push(`<div class="vt-grammar-line"><b>Grammar note:</b> Capital letter usually means this is a noun in German.</div>`);
    } else if(/en$/.test(lower)){
      lines.push(`<div class="vt-grammar-line"><b>Grammar note:</b> Words ending in -en can be infinitive verbs, plural forms, or adjective endings. Check the sentence context.</div>`);
    } else if(/e$/.test(lower)){
      lines.push(`<div class="vt-grammar-line"><b>Grammar note:</b> Final -e often appears in adjective endings or some noun/verb forms.</div>`);
    }
    return lines.join('');
  }
  function renderGrammarBox(words, paragraph, glossary){
    const sel = state.read.selectedWord;
    if(!sel){
      return `<h4>Grammar Click</h4><div class="vt-grammar-empty">Click any word in the paragraph to see meaning, article/case hints, and grammar notes here.</div>`;
    }
    return `<h4>Grammar Click</h4><div class="vt-grammar-word">${escapeHtml(sel.word)}</div>${localGrammarInfo(sel.word, words, paragraph, glossary)}
      <button class="vt-btn vt-btn-ghost vt-smallbtn" id="askAiAboutWord" style="margin-top:10px">Ask AI about “${escapeHtml(sel.word)}”</button>`;
  }
  function renderAnswerPractice(questions){
    if(!questions || !questions.length){
      return `<div class="vt-answer-box"><h4>AI checks your answer</h4><div class="vt-grammar-empty">Generate an AI paragraph first. Then answer its questions and click “Check answer”.</div></div>`;
    }
    const idx = Math.min(state.read.answerIndex || 0, questions.length - 1);
    const options = questions.map((q,i) => `<option value="${i}" ${i===idx?'selected':''}>${i+1}. ${escapeHtml(q)}</option>`).join('');
    const status = state.read.answerStatus ? `<div class="vt-answer-status ${/error|failed|Paste/i.test(state.read.answerStatus)?'vt-answer-error':''}">${escapeHtml(state.read.answerStatus)}</div>` : '';
    const feedback = state.read.answerFeedback ? `<div class="vt-answer-feedback">${escapeHtml(state.read.answerFeedback)}</div>` : '';
    return `<div class="vt-answer-box">
      <h4>AI checks your answer</h4>
      <select class="vt-answer-select" id="readAnswerQuestion">${options}</select>
      <textarea class="vt-answer-input" id="readAnswerInput" spellcheck="true" placeholder="Write your German answer here...">${escapeHtml(state.read.answerText || '')}</textarea>
      <div class="vt-row" style="margin-top:10px"><button class="vt-btn vt-btn-primary" id="readCheckAnswer">Check answer</button><button class="vt-btn vt-btn-ghost" id="readClearAnswer">Clear</button></div>
      ${status}${feedback}
    </div>`;
  }
  function answerCheckPrompt(paragraph, english, question, answer, words){
    const vocab = words.map(w => `${headword(w.term)} = ${w.translation}`).join('; ');
    return `You are a Goethe A2/B1 German tutor.

German paragraph:
${paragraph}

English support:
${english || ''}

Target vocabulary:
${vocab}

Question:
${question}

Learner's German answer:
${answer}

Give short feedback in simple English.
Format:
1. Correctness: ✅ correct / 🟡 partly correct / ❌ not correct
2. Better German answer:
3. Small grammar/vocab correction:
Keep it under 130 words.`;
  }
  async function callGroqCheckAnswer(apiKey, paragraph, english, question, answer, words){
    const body = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        {role:'system', content:'You are a patient German tutor. Correct beginner German answers kindly and briefly.'},
        {role:'user', content: answerCheckPrompt(paragraph, english, question, answer, words)}
      ],
      temperature: 0.25,
      max_tokens: 420
    };
    const res = await MoselAI.chat(body, apiKey);
    if(!res.ok){
      const errText = await res.text().catch(() => '');
      throw new Error((errText || ('Groq answer-check error: HTTP ' + res.status)).slice(0, 260));
    }
    const data = await res.json();
    return cleanModelText(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
  }
  async function checkReadAnswer(words, paragraph, english, questions){
    const keyInput = $('#groqKeyInput');
    const remember = $('#groqRemember');
    const typedKey = keyInput ? keyInput.value.trim() : '';
    const key = typedKey || state.read.tempKey || loadGroqKey();
    const ansEl = $('#readAnswerInput');
    const qIdx = Math.min(Number($('#readAnswerQuestion') && $('#readAnswerQuestion').value || state.read.answerIndex || 0), (questions || []).length - 1);
    const answer = ansEl ? ansEl.value.trim() : '';
    if(!key){ toast('Paste your Groq API key first.'); return; }
    if(!questions || !questions.length){ toast('Generate AI questions first.'); return; }
    if(!answer){ toast('Write your answer first.'); return; }
    if(typedKey){ state.read.tempKey = typedKey; if(remember && remember.checked) saveGroqKey(typedKey); }
    state.read.answerIndex = qIdx;
    state.read.answerText = answer;
    state.read.answerStatus = 'Checking your German answer...';
    state.read.answerFeedback = '';
    renderRead();
    try{
      const feedback = await callGroqCheckAnswer(key, paragraph, english, questions[qIdx], answer, words);
      state.read.answerStatus = '';
      state.read.answerFeedback = feedback || 'No feedback returned.';
    }catch(err){
      state.read.answerStatus = (err && err.message) ? err.message : 'Answer check failed. Try again.';
      state.read.answerFeedback = '';
    }
    renderRead();
  }


  function renderRead(){
    const words = chooseReadWords(false);
    const ids = words.map(w => w.id).join(',');
    const ai = state.read.ai && state.read.ai.ids === ids ? state.read.ai : null;
    const paragraph = ai ? ai.german : readParagraph(words);
    const english = ai ? (ai.english || readEnglish(words)) : readEnglish(words);
    const questions = ai && Array.isArray(ai.questions) ? ai.questions : [];
    const chatContext = ids + '|' + (ai ? ('ai:' + ai.german) : ('offline:' + paragraph));
    if(state.read.chatContext && state.read.chatContext !== chatContext){
      state.read.chat = []; state.read.chatStatus = ''; state.read.chatError = ''; state.read.selectedWord = null; state.read.answerText = ''; state.read.answerStatus = ''; state.read.answerFeedback = '';
    }
    state.read.chatContext = chatContext;
    const chatHtml = state.read.chat.length
      ? state.read.chat.map(m => `<div class="vt-chat-msg ${m.role === 'user' ? 'user' : 'assistant'}">${escapeHtml(m.content)}</div>`).join('')
      : `<div class="vt-chat-empty">Ask about the paragraph, grammar, article rules, vocabulary, or the questions.</div>`;
    const chatStatusHtml = state.read.chatError
      ? `<div class="vt-chat-status vt-chat-error">${escapeHtml(state.read.chatError)}</div>`
      : (state.read.chatStatus ? `<div class="vt-chat-status">${escapeHtml(state.read.chatStatus)}</div>` : '');
    const savedKey = loadGroqKey();
    const hasKey = !!(savedKey || state.read.tempKey);
    const statusHtml = state.read.aiError
      ? `<div class="vt-ai-status vt-ai-error">${escapeHtml(state.read.aiError)}</div>`
      : (state.read.aiStatus ? `<div class="vt-ai-status ${ai?'vt-ai-good':''}">${escapeHtml(state.read.aiStatus)}</div>` : '');
    $('#vtBody').innerHTML = `<div class="vt-qsetup vt-read-page">
      ${modeTitle('Block Absatz','Block Paragraph','Offline mode remixes saved examples. AI mode uses Groq to write a more natural A2/B1 paragraph from the same block words.')}
      ${packControls('read')}
      <div class="vt-read-card">
        <div class="vt-read-head">
          <div><h3 class="vt-read-title">${ai ? 'AI-Lesetext' : 'Mini-Lesetext'}</h3><div class="vt-read-sub">${escapeHtml(chunkLabel())} · ${words.length} target words</div></div>
          <div class="${ai ? 'vt-ai-badge' : 'vt-read-level'}">${ai ? 'Groq · natürlicher B1' : 'offline · A2/B1'}</div>
        </div>
        <div class="vt-read-layout">
          <div class="vt-read-main">
            <div class="vt-read-text" id="readText">${highlightTerms(paragraph, words, ai && ai.glossary)}</div>
            ${ai && ai.missing && ai.missing.length ? `<div class="vt-ai-status vt-ai-error"><b>Missing target words:</b> ${escapeHtml(ai.missing.join(', '))}. Click AI paragraph again for a new version.</div>` : ''}
            ${state.read.showEn ? `<div class="vt-read-en"><b>English support:</b><br>${escapeHtml(english)}</div>` : ''}
            ${questions.length ? `<div class="vt-ai-questions"><b>Fragen:</b><ol>${questions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ol></div>` : ''}
            <div class="vt-read-words">${words.map(w => `<span class="vt-read-word" title="${escapeAttr(makeTip(w))}">${renderTerm(headword(w.term))} <span>· ${escapeHtml(w.translation)}</span></span>`).join('')}</div>
            <div class="vt-row" style="margin-top:18px">
              <button class="vt-iconbtn vt-speak-big" id="readSpeak">${SPEAK_ICON}<span>Hören</span></button>
              <button class="vt-btn vt-btn-primary" id="readNew">Offline paragraph</button>
              <button class="vt-btn vt-btn-primary" id="readAI">AI paragraph</button>
              <button class="vt-btn vt-btn-ghost" id="readToggleEn">${state.read.showEn ? 'Hide English' : 'Show English'}</button>
              <button class="vt-btn vt-btn-ghost" id="readMarkLearning">Mark words: Übe noch</button>
              <button class="vt-btn vt-btn-ghost" id="readMarkKnown">Mark words: Gelernt</button>
            </div>
            <div class="vt-ai-panel">
              <h4>Groq AI paragraph</h4>
              <p>${MoselAI.serverAI ? 'The AI tutor runs on the server: no key needed.' : 'Paste your own Groq key (free at console.groq.com). It is sent only to Groq and kept in this browser only if you tick save.'}</p>
              <div class="vt-ai-grid">
                <input class="vt-ai-input" id="groqKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? 'Groq key ready — leave blank to use saved/session key' : 'Paste Groq API key: gsk_...'}">
                <label class="vt-ai-check"><input type="checkbox" id="groqRemember" ${savedKey ? 'checked' : ''}> save locally</label>
                <button class="vt-btn vt-btn-ghost" id="groqSaveKey">Save key</button>
                <button class="vt-btn vt-btn-ghost" id="groqClearKey">Clear key</button>
              </div>
              ${statusHtml}
            </div>
          </div>
          <aside class="vt-read-side">
            <div class="vt-chat-panel">
              <h4>AI Tutor Chat</h4>
              <p>Ask about this paragraph: meaning, grammar, der/die/das, vocab, or questions. ${MoselAI.serverAI ? '' : 'Uses the same Groq key.'}</p>
              <div class="vt-grammar-box" id="readGrammarBox">${renderGrammarBox(words, paragraph, ai && ai.glossary)}</div>
              ${renderAnswerPractice(questions)}
              <div class="vt-chat-quick">
                <button class="vt-chat-chip" data-chat-prompt="Explain the grammar of this paragraph in simple English.">Grammar</button>
                <button class="vt-chat-chip" data-chat-prompt="Explain the hardest vocabulary from this paragraph with easy examples.">Vocab</button>
                <button class="vt-chat-chip" data-chat-prompt="Explain the der/die/das articles used in this paragraph.">Articles</button>
                <button class="vt-chat-chip" data-chat-prompt="Ask me 3 easy questions about this paragraph and wait for my answers.">Quiz me</button>
              </div>
              <div class="vt-chat-log" id="readChatLog">${chatHtml}</div>
              <div class="vt-chat-form">
                <textarea class="vt-chat-input" id="readChatInput" rows="2" spellcheck="true" placeholder="Example: Why is it der Besuch? What does lohnt sich mean? Explain this sentence..."></textarea>
                <button class="vt-btn vt-btn-primary" id="readChatSend">Ask</button>
              </div>
              ${chatStatusHtml}
            </div>
          </aside>
        </div>
      </div>
      ${shortcutLine('Shortcuts: ↑ = listen · Space/D/→ = offline paragraph · Enter in chat = send')}
    </div>`;
    wirePackControls('read', renderRead);
    const rs = $('#readSpeak'); if(rs) rs.addEventListener('click', () => speakLongText(paragraph, rs));
    const rn = $('#readNew'); if(rn) rn.addEventListener('click', () => { state.read.ai=null; state.read.aiError=''; state.read.aiStatus=''; state.read.chat=[]; state.read.chatStatus=''; state.read.chatError=''; state.read.chatContext=''; chooseReadWords(true); renderRead(); });
    const rai = $('#readAI'); if(rai) rai.addEventListener('click', () => generateGroqParagraph(words));
    const chatSend = $('#readChatSend'); if(chatSend) chatSend.addEventListener('click', () => sendReadChat(words, paragraph, english, questions));
    const aq = $('#readAnswerQuestion'); if(aq) aq.addEventListener('change', e => { state.read.answerIndex = Number(e.target.value) || 0; state.read.answerText = ''; state.read.answerFeedback = ''; state.read.answerStatus = ''; renderRead(); });
    const aiAns = $('#readAnswerInput'); if(aiAns) aiAns.addEventListener('input', e => { state.read.answerText = e.target.value; });
    const chkAns = $('#readCheckAnswer'); if(chkAns) chkAns.addEventListener('click', () => checkReadAnswer(words, paragraph, english, questions));
    const clrAns = $('#readClearAnswer'); if(clrAns) clrAns.addEventListener('click', () => { state.read.answerText=''; state.read.answerFeedback=''; state.read.answerStatus=''; renderRead(); });
    const askWord = $('#askAiAboutWord'); if(askWord) askWord.addEventListener('click', () => { const i=$('#readChatInput'); const word = state.read.selectedWord && state.read.selectedWord.word || ''; if(i && word){ i.value='Explain this word from the paragraph: ' + word + '. Include meaning, grammar role, article/case if relevant, and one easy example.'; i.focus(); } });

    const chatInput = $('#readChatInput'); if(chatInput) chatInput.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendReadChat(words, paragraph, english, questions); } });
    $$('.vt-chat-chip').forEach(btn => btn.addEventListener('click', () => { const input=$('#readChatInput'); if(input){ input.value = btn.dataset.chatPrompt || ''; input.focus(); } }));
    $$('.vt-word-tip').forEach(el => el.addEventListener('click', () => {
      const word = (el.dataset.word || el.textContent || '').trim();
      state.read.selectedWord = {word};
      const box = $('#readGrammarBox');
      if(box) box.innerHTML = renderGrammarBox(words, paragraph, ai && ai.glossary);
      const input=$('#readChatInput');
      if(input){ input.value = 'Explain this word from the paragraph: ' + word; }
      const askBtn = $('#askAiAboutWord');
      if(askBtn) askBtn.addEventListener('click', () => { const i=$('#readChatInput'); if(i){ i.value='Explain this word from the paragraph: ' + word + '. Include meaning, grammar role, article/case if relevant, and one easy example.'; i.focus(); } });
    }));
    const chatLog = $('#readChatLog'); if(chatLog) setTimeout(() => { chatLog.scrollTop = chatLog.scrollHeight; }, 0);
    const gsave = $('#groqSaveKey'); if(gsave) gsave.addEventListener('click', () => { const v = ($('#groqKeyInput') && $('#groqKeyInput').value || '').trim(); if(!v){ toast('Paste key first.'); return; } state.read.tempKey = v; saveGroqKey(v); state.read.aiStatus='Groq key saved locally.'; state.read.aiError=''; renderRead(); });
    const gclear = $('#groqClearKey'); if(gclear) gclear.addEventListener('click', () => { clearGroqKey(); renderRead(); });
    const te = $('#readToggleEn'); if(te) te.addEventListener('click', () => { state.read.showEn = !state.read.showEn; renderRead(); });
    const ml = $('#readMarkLearning'); if(ml) ml.addEventListener('click', () => { words.forEach(w => { if(getStatus(w.id) !== 'known') setStatus(w.id,'learning'); }); renderOverall(); renderChapters(); renderRead(); });
    const mk = $('#readMarkKnown'); if(mk) mk.addEventListener('click', () => { words.forEach(w => setStatus(w.id,'known')); renderOverall(); renderChapters(); renderRead(); });
  }


  function normalizeLookupText(s){
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[„“"'`´]/g, '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)\s+/i, '')
      .replace(/[.,;:!?/\\|()[\]{}<>+*=~–—-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function vocabRows(){
    return VOCAB_DATA.flatMap(ch => ch.words.map(w => Object.assign({chapterNumber: ch.number, chapterTitle: ch.title}, w)));
  }
  function lookupSearchMatches(query){
    const q = normalizeLookupText(query);
    if(!q) return [];
    const raw = String(query || '').toLowerCase().trim();
    const rows = vocabRows();
    return rows.map(w => {
      const term = normalizeLookupText(w.term);
      const head = normalizeLookupText(headword(w.term));
      const noun = normalizeLookupText(nounOnly(w.term));
      const trans = normalizeLookupText(w.translation);
      const ex = normalizeLookupText(w.example);
      let score = 0;
      if(term === q || head === q || noun === q) score += 120;
      if(term.startsWith(q) || head.startsWith(q) || noun.startsWith(q)) score += 85;
      if(term.split(' ').includes(q) || noun.split(' ').includes(q)) score += 70;
      if(term.includes(q) || head.includes(q) || noun.includes(q)) score += 55;
      if(ex.includes(q)) score += 35;
      if(trans === q) score += 30;
      if(trans.includes(q)) score += 18;
      if(raw && String(w.term || '').toLowerCase().includes(raw)) score += 25;
      return Object.assign({score}, w);
    }).filter(w => w.score > 0).sort((a,b) => b.score - a.score || a.id - b.id).slice(0, 12);
  }
  function renderSearchCard(w){
    const article = extractArticle(w.term);
    const plural = pluralPart(w.term);
    const status = getStatus(w.id);
    const exEn = exampleEnglish(w);
    return `<div class="vt-search-card">
      <div class="vt-search-card-title"><span>${renderTerm(w.term)}</span><button class="vt-iconbtn" data-search-speak="${escapeAttr(cleanSpeechText(w.term))}" title="Speak">${SPEAK_ICON}</button></div>
      <div class="vt-search-meta">
        <span class="vt-pill ${status==='known'?'vt-pill-known':status==='learning'?'vt-pill-learning':'vt-pill-new'}">${status==='known'?'Known':status==='learning'?'Learning':'New'}</span>
        ${article ? `<span class="vt-pill vt-pill-${article}">${article}</span>` : ''}
        ${plural ? `<span class="vt-pill vt-pill-new">Plural: ${escapeHtml(plural)}</span>` : ''}
        <span>Kap. ${String(w.chapterNumber).padStart(2,'0')} · ${escapeHtml(w.chapterTitle)}</span>
        <span>${escapeHtml(w.section || '')}</span>
      </div>
      <div class="vt-search-translation">${escapeHtml(w.translation)}</div>
      <div class="vt-search-example">${escapeHtml(w.example || '')}${exEn ? `<div class="vt-card-example-en">${escapeHtml(exEn)}</div>` : ''}</div>
      <div class="vt-row" style="margin-top:12px">
        <button class="vt-btn vt-smallbtn" data-search-learning="${w.id}">Mark learning</button>
        <button class="vt-btn vt-smallbtn vt-btn-primary" data-search-known="${w.id}">Mark known</button>
      </div>
    </div>`;
  }
  function searchLocalSummary(matches){
    if(!matches || !matches.length) return 'No exact book-data match was found.';
    return matches.slice(0, 6).map((w, i) => `${i+1}. ${w.term} = ${w.translation}; chapter ${w.chapterNumber} ${w.chapterTitle}; section ${w.section || 'n/a'}; example: ${w.example || ''}`).join('\n');
  }

  function stripTutorMarkdown(s){
    return String(s ?? '').replace(/\*\*/g, '').replace(/^[-•]\s*/g, '').trim();
  }
  function asCleanArray(value){
    if(value == null) return [];
    if(Array.isArray(value)) return value.map(stripTutorMarkdown).filter(Boolean);
    if(typeof value === 'object') return Object.entries(value).map(([k,v]) => `${stripTutorMarkdown(k)}: ${stripTutorMarkdown(v)}`).filter(Boolean);
    return String(value).split(/\n|;|\s+-\s+/).map(stripTutorMarkdown).filter(Boolean);
  }
  function renderGroqList(items){
    const list = asCleanArray(items);
    if(!list.length) return '';
    return `<ul class="vt-groq-list">${list.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
  }
  function renderGroqCard(label, inner, extraClass){
    if(!inner) return '';
    return `<section class="vt-groq-card ${extraClass || ''}"><div class="vt-groq-label">${escapeHtml(label)}</div>${inner}</section>`;
  }
  function findJsonObjectText(text){
    const raw = String(text || '').trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if(fenced) return fenced[1].trim();
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if(a >= 0 && b > a) return raw.slice(a, b + 1);
    return raw;
  }
  function tryParseGroqJson(text){
    try{ return JSON.parse(findJsonObjectText(text)); }catch(e){ return null; }
  }
  function formatGroqJsonMeaning(data){
    const meanings = data.meanings || data.meaning || data.meanings_in_english || [];
    const grammar = data.grammar || {};
    const example = data.example || {};
    const book = data.book_match || data.bookMatch || data.book || {};
    const usage = data.common_usage || data.usage || data.commonUsage || [];
    const word = data.word || data.query || '';
    const grammarInner = `<div class="vt-groq-mini-grid">${grammar.type ? `<div class="vt-groq-mini"><b>Type</b><span>${escapeHtml(grammar.type)}</span></div>` : ''}${grammar.article ? `<div class="vt-groq-mini"><b>Article</b><span>${escapeHtml(grammar.article)}</span></div>` : ''}${grammar.plural ? `<div class="vt-groq-mini"><b>Plural</b><span>${escapeHtml(grammar.plural)}</span></div>` : ''}${grammar.note ? `<div class="vt-groq-mini"><b>Note</b><span>${escapeHtml(grammar.note)}</span></div>` : ''}</div>`;
    const exampleDe = example.de || example.german || example.sentence || '';
    const exampleEn = example.en || example.english || example.translation || '';
    const exampleInner = exampleDe ? `<div class="vt-groq-example-de">${escapeHtml(exampleDe)}</div>${exampleEn ? `<div class="vt-groq-example-en">${escapeHtml(exampleEn)}</div>` : ''}` : '';
    let bookInner = '';
    if(book && (book.found === false || book.found === 'false')){
      bookInner = `<p class="vt-groq-text">Not found in the book data. ${escapeHtml(book.note || '')}</p>`;
    }else if(book && (book.term || book.chapter || book.section || book.note)){
      bookInner = `<div class="vt-groq-mini-grid">${book.term ? `<div class="vt-groq-mini"><b>Best match</b><span>${escapeHtml(book.term)}</span></div>` : ''}${book.chapter ? `<div class="vt-groq-mini"><b>Chapter</b><span>${escapeHtml(book.chapter)}</span></div>` : ''}${book.section ? `<div class="vt-groq-mini"><b>Section</b><span>${escapeHtml(book.section)}</span></div>` : ''}${book.note ? `<div class="vt-groq-mini"><b>Note</b><span>${escapeHtml(book.note)}</span></div>` : ''}</div>`;
    }
    return `<div class="vt-search-groq">${word ? `<div class="vt-groq-intro"><span class="vt-groq-chip">AI meaning</span>${escapeHtml(word)}</div>` : ''}${renderGroqCard('Meanings in English', renderGroqList(meanings), 'is-primary')}${renderGroqCard('Grammar', grammarInner, '')}${renderGroqCard('Example', exampleInner, '')}${renderGroqCard('Book match', bookInner, '')}${renderGroqCard('Common usage', renderGroqList(usage), '')}</div>`;
  }
  function formatGroqMarkdownMeaning(text){
    const raw = String(text || '').trim();
    const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const sections = [];
    let intro = [];
    let current = null;
    const startSection = (title, rest) => {
      current = {title: stripTutorMarkdown(title).replace(/:$/,''), lines: []};
      sections.push(current);
      if(rest && stripTutorMarkdown(rest)) current.lines.push(stripTutorMarkdown(rest));
    };
    for(const line of lines){
      const m1 = line.match(/^\*\*(.+?)\*\*\s*:?\s*(.*)$/);
      const m2 = line.match(/^([A-Z][A-Za-z +\/()-]{2,35}):\s*(.*)$/);
      if(m1){ startSection(m1[1], m1[2]); continue; }
      if(m2 && sections.length){ startSection(m2[1], m2[2]); continue; }
      if(current) current.lines.push(line); else intro.push(line);
    }
    const introHtml = intro.length ? `<div class="vt-groq-intro">${escapeHtml(stripTutorMarkdown(intro.join(' ')))}</div>` : '';
    const sectionHtml = sections.map((sec, idx) => {
      const items = sec.lines.map(stripTutorMarkdown).filter(Boolean);
      if(!items.length) return '';
      const hasBullets = sec.lines.some(x => /^[-•]/.test(x));
      const inner = hasBullets || items.length > 1 ? renderGroqList(items) : `<p class="vt-groq-text">${escapeHtml(items[0])}</p>`;
      return renderGroqCard(sec.title || `Part ${idx+1}`, inner, idx === 0 ? 'is-primary' : '');
    }).join('');
    if(sectionHtml || introHtml) return `<div class="vt-search-groq">${introHtml}${sectionHtml}</div>`;
    return `<div class="vt-search-groq"><div class="vt-groq-card"><p class="vt-groq-text">${escapeHtml(raw)}</p></div></div>`;
  }
  function formatGroqWordMeaning(text){
    const data = tryParseGroqJson(text);
    if(data && typeof data === 'object') return formatGroqJsonMeaning(data);
    return formatGroqMarkdownMeaning(text);
  }
  async function callGroqWordLookup(apiKey, query, matches){
    const localContext = searchLocalSummary(matches);
    const hasBookMatch = matches && matches.length;
    const prompt = `The learner searched this German word/phrase: "${query}".

Book-data search result:
${localContext}

Return ONLY valid JSON. No markdown, no greeting, no extra text.
Use exactly this shape:
{
  "word": "searched word",
  "meanings": ["short English meaning 1", "short English meaning 2"],
  "grammar": {"type": "noun/verb/adjective/adverb/preposition/phrase", "article": "der/die/das or empty", "plural": "plural or empty", "note": "one short grammar note"},
  "example": {"de": "one easy German sentence", "en": "English meaning"},
  "book_match": {"found": true, "term": "best book term or empty", "chapter": "chapter number and title or empty", "section": "section or empty", "note": "one short note"},
  "common_usage": ["short usage tip 1", "short usage tip 2"]
}
Keep every value practical and concise for an A1/B1 English-speaking learner. Do not say you searched the web.`;
    const res = await MoselAI.chat({
        model: 'llama-3.1-8b-instant',
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          {role:'system', content:'You are a friendly German vocabulary tutor. Return compact valid JSON only. Be accurate, concise, and useful for an Indian/English-speaking learner.'},
          {role:'user', content: prompt}
        ]
      }, apiKey);
    if(!res.ok){
      const errText = await res.text().catch(() => '');
      throw new Error((errText || ('Groq error: HTTP ' + res.status)).slice(0, 260));
    }
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  }
  async function runWordSearch(runGroq){
    const input = $('#wordSearchInput');
    const keyInput = $('#wordSearchGroqKey');
    const remember = $('#wordSearchRemember');
    const q = (input && input.value || '').trim();
    state.search.query = q;
    state.search.results = q ? lookupSearchMatches(q) : [];
    state.search.groqText = '';
    state.search.groqError = '';
    state.search.groqStatus = '';
    if(!q){ renderSearch(); return; }
    renderSearch();
    if(!runGroq) return;
    const typedKey = (keyInput && keyInput.value || '').trim();
    const key = typedKey || state.search.tempKey || loadGroqKey();
    if(typedKey){ state.search.tempKey = typedKey; if(remember && remember.checked) saveGroqKey(typedKey); }
    if(!key){
      state.search.groqStatus = 'Book search finished. Paste a Groq key to also get AI meaning.';
      renderSearch();
      return;
    }
    state.search.groqStatus = state.search.results.length ? 'Book match found. Asking Groq for a simple explanation too...' : 'No book match. Asking Groq for the meaning...';
    renderSearch();
    try{
      state.search.groqText = await callGroqWordLookup(key, q, state.search.results);
      state.search.groqStatus = 'Groq explanation ready.';
      state.search.groqError = '';
    }catch(e){
      console.warn(e);
      state.search.groqStatus = '';
      state.search.groqError = 'Groq failed: ' + (e && e.message ? e.message : 'unknown error');
    }
    renderSearch();
  }
  function renderSearch(){
    const q = state.search.query || '';
    const results = state.search.results || [];
    const savedKey = loadGroqKey();
    const hasKey = savedKey || state.search.tempKey;
    const localHtml = !q
      ? `<div class="vt-search-empty">Type a German word like <b>Besuch</b>, <b>lohnt sich</b>, <b>steil</b>, or <b>Übernachtung</b>.</div>`
      : results.length
        ? results.map(renderSearchCard).join('')
        : `<div class="vt-search-empty">No match found in the book data for <b>${escapeHtml(q)}</b>.<br>Groq can still explain it if your key is available.</div>`;
    const groqHtml = state.search.groqError
      ? `<div class="vt-search-groq vt-chat-error"><div class="vt-groq-card"><p class="vt-groq-text">${escapeHtml(state.search.groqError)}</p></div></div>`
      : state.search.groqText
        ? formatGroqWordMeaning(state.search.groqText)
        : `<div class="vt-search-empty">${escapeHtml(state.search.groqStatus || 'Groq explanation will appear here after search.')}</div>`;
    $('#vtBody').innerHTML = `<div class="vt-search-page">
      <div class="vt-search-hero">
        <h2 class="vt-search-title">German <span>Word Search</span></h2>
        <p class="vt-search-copy">Search your book vocabulary first. Then Groq also explains the word in simple English, whether the word is found in the book data or not.</p>
        <div class="vt-search-grid">
          <input class="vt-search-input" id="wordSearchInput" value="${escapeAttr(q)}" autocomplete="off" spellcheck="false" placeholder="Type German word: z.B. Burg, sich lohnen, Übernachtung...">
          <button class="vt-btn vt-btn-primary" id="wordSearchBtn">Search + Groq</button>
        </div>
        <div class="vt-search-keyrow">
          <input class="vt-ai-input" id="wordSearchGroqKey" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? 'Groq key ready — leave blank' : 'Paste Groq API key: gsk_...'}">
          <label class="vt-ai-check"><input type="checkbox" id="wordSearchRemember" ${savedKey ? 'checked' : ''}> save locally</label>
          <button class="vt-btn vt-btn-ghost" id="wordSearchBookOnly">Book only</button>
          <button class="vt-btn vt-btn-ghost" id="wordSearchClearKey">Clear key</button>
        </div>
        ${MoselAI.serverAI ? '' : '<div class="vt-search-note">Your key is sent only to Groq and stays in this browser only when saved.</div>'}
      </div>
      <div class="vt-search-results">
        <section class="vt-search-panel">
          <h3>Book data ${q ? `<span class="vt-pill vt-pill-new">${results.length} match${results.length===1?'':'es'}</span>` : ''}</h3>
          <p>Local results from your word list.</p>
          ${localHtml}
        </section>
        <aside class="vt-search-panel">
          <h3>Groq meaning</h3>
          <p>AI explanation uses the book matches as context when available.</p>
          ${groqHtml}
        </aside>
      </div>
      ${shortcutLine('Shortcut: Enter in search box = Search + Groq')}
    </div>`;
    const input = $('#wordSearchInput');
    if(input){
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); runWordSearch(true); } });
      input.addEventListener('input', e => { state.search.query = e.target.value; });
    }
    const sb = $('#wordSearchBtn'); if(sb) sb.addEventListener('click', () => runWordSearch(true));
    const bo = $('#wordSearchBookOnly'); if(bo) bo.addEventListener('click', () => runWordSearch(false));
    const ck = $('#wordSearchClearKey'); if(ck) ck.addEventListener('click', () => { clearGroqKey(); state.search.tempKey=''; state.search.groqStatus='Groq key cleared.'; state.search.groqText=''; state.search.groqError=''; renderSearch(); });
    $$('[data-search-speak]').forEach(btn => btn.addEventListener('click', () => speak(btn.dataset.searchSpeak || '', btn)));
    $$('[data-search-learning]').forEach(btn => btn.addEventListener('click', () => { setStatus(Number(btn.dataset.searchLearning), 'learning'); renderOverall(); renderChapters(); renderSearch(); }));
    $$('[data-search-known]').forEach(btn => btn.addEventListener('click', () => { setStatus(Number(btn.dataset.searchKnown), 'known'); renderOverall(); renderChapters(); renderSearch(); }));
  }


  function renderStats(){
    const s = overallStats();
    const canSave = storageWorks();
    $('#vtBody').innerHTML = `<div class="vt-statsgrid"><div class="vt-statcard"><div class="vt-statnum" style="color:var(--das)">${s.known}</div><div class="vt-statlabel">Gelernt</div></div><div class="vt-statcard"><div class="vt-statnum" style="color:var(--der)">${s.learning}</div><div class="vt-statlabel">Übe noch</div></div><div class="vt-statcard"><div class="vt-statnum">${s.neu}</div><div class="vt-statlabel">Neu</div></div><div class="vt-statcard"><div class="vt-statnum">${s.total}</div><div class="vt-statlabel">Gesamt</div></div></div><div class="vt-chaptertable">${VOCAB_DATA.map(ch => { const cs=statsFor(ch.words); const pct=cs.total?Math.round(cs.known/cs.total*100):0; return `<div class="vt-chrow" data-ch="${ch.number}"><div class="vt-chrow-num">${String(ch.number).padStart(2,'0')}</div><div class="vt-chrow-title">${escapeHtml(ch.title)}</div><div class="vt-chrow-bar"><div class="seg-known" style="width:${pct}%"></div></div><div class="vt-chrow-pct">${pct}%</div></div>`; }).join('')}</div>
    <div class="vt-save-panel">
      <h3>Progress safety</h3>
      <p>${canSave ? '<span class="vt-save-ok">Auto-save is working</span>' : '<span class="vt-save-warn">Browser storage may be blocked</span>'}. Last save: <b>${escapeHtml(lastSaveText())}</b>. Extra safety: <b>${escapeHtml(autoBackupState)}</b>.</p>
      <p><span class="vt-save-warn">Best protection:</span> click <b>Enable auto backup file</b> once and choose a JSON file. Then the app keeps updating that external file, so browser cleanup is much less scary.</p>
      <div class="vt-save-actions">
        <button class="vt-btn vt-btn-primary" id="enableAutoBackupBtn">Enable auto backup file</button>
        <button class="vt-btn" id="saveAutoBackupNowBtn">Save external backup now</button>
        <button class="vt-btn vt-btn-ghost" id="exportProgressBtn">Download progress backup</button>
        <button class="vt-btn vt-btn-ghost" id="importProgressBtn">Import backup</button>
        <button class="vt-btn vt-btn-ghost" id="disableAutoBackupBtn">Disable auto backup file</button>
        <input class="vt-file-input" id="importProgressInput" type="file" accept="application/json,.json">
      </div>
    </div>
    <div class="vt-storage-note">Tip: use Today Pack / Block mode first. Don’t try to memorize 243 words together.</div>`;
    $$('.vt-chrow').forEach(r => r.addEventListener('click', () => { state.chapter=Number(r.dataset.ch); state.tab='learn'; resetForChapter(); renderShell(); }));
    const ab = $('#enableAutoBackupBtn'); if(ab) ab.addEventListener('click', enableAutoBackupFile);
    const sn = $('#saveAutoBackupNowBtn'); if(sn) sn.addEventListener('click', () => writeAutoBackupFile(true));
    const db = $('#disableAutoBackupBtn'); if(db) db.addEventListener('click', disableAutoBackupFile);
    const ex = $('#exportProgressBtn'); if(ex) ex.addEventListener('click', exportProgress);
    const im = $('#importProgressBtn'); if(im) im.addEventListener('click', () => $('#importProgressInput').click());
    const fi = $('#importProgressInput'); if(fi) fi.addEventListener('change', e => importProgressFile(e.target.files && e.target.files[0]));
  }


  $$('.vt-tab').forEach(btn => btn.addEventListener('click', () => { state.tab = btn.dataset.tab; renderTabs(); renderBody(); }));
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const typing = ['input','select','textarea'].includes(tag) || (e.target && e.target.isContentEditable);
    const key = e.key.toLowerCase();

    if(typing){
      if(state.tab === 'type' && e.key === 'ArrowUp'){ e.preventDefault(); const b=$('#typeSpeak'); if(b) b.click(); }
      return;
    }

    const speakNow = () => {
      if(state.tab === 'learn'){ const b=$('#learnSpeak'); if(b){ b.click(); return true; } }
      if(state.tab === 'artikel'){ const b=$('#artSpeak'); if(b){ b.click(); return true; } }
      if(state.tab === 'quiz'){
        const b=$('#quizSpeak'); if(b){ b.click(); return true; }
        toast('No German audio on this English → German prompt, because it would reveal the answer.'); return true;
      }
      if(state.tab === 'recall'){
        const b=$('#recallSpeak'); if(b && !b.disabled){ b.click(); return true; }
        toast('Answer first, then you can hear the German word.'); return true;
      }
      if(state.tab === 'match'){ const b=$('#matchSpeak'); if(b){ b.click(); return true; } }
      if(state.tab === 'type'){ const b=$('#typeSpeak'); if(b){ b.click(); return true; } }
      if(state.tab === 'builder'){ const b=$('#builderSpeak'); if(b){ b.click(); return true; } }
      if(state.tab === 'read'){ const b=$('#readSpeak'); if(b){ b.click(); return true; } }
      return false;
    };

    if(e.key === 'ArrowUp' || key === 'w' || key === 's'){
      e.preventDefault(); speakNow(); return;
    }

    if(state.tab === 'learn'){
      if(e.code === 'Space' || e.key === 'Enter'){ e.preventDefault(); state.learn.flipped = !state.learn.flipped; state.learn.showEn=false; renderLearn(); return; }
      if(e.key === 'ArrowRight' || key === 'd'){ e.preventDefault(); const n = $('#learnNext'); if(n && !n.disabled) n.click(); return; }
      if(e.key === 'ArrowLeft' || key === 'a'){ e.preventDefault(); const p = $('#learnPrev'); if(p && !p.disabled) p.click(); return; }
    }

    if(state.tab === 'artikel'){
      if(['1','2','3'].includes(e.key)){
        const map = {'1':'der','2':'die','3':'das'}; const b = $(`.vt-artbtn[data-art="${map[e.key]}"]`); if(b && !b.disabled){ e.preventDefault(); b.click(); return; }
      }
      if(e.code === 'Space' || e.key === 'Enter' || e.key === 'ArrowRight' || key === 'd'){
        const n = $('#artNext') || $('#artStart') || $('#artAgain'); if(n){ e.preventDefault(); n.click(); return; }
      }
    }

    if(state.tab === 'quiz'){
      if(['1','2','3','4'].includes(e.key)){
        const opts = $$('.vt-option'); const b = opts[Number(e.key)-1]; if(b && !b.disabled){ e.preventDefault(); b.click(); return; }
      }
      if(e.code === 'Space' || e.key === 'Enter'){
        const n = $('#quizStart') || $('#quizAgain'); if(n){ e.preventDefault(); n.click(); return; }
      }
    }

    if(state.tab === 'recall'){
      if(['1','2','3','4'].includes(e.key)){
        const opts = $$('.vt-option'); const b = opts[Number(e.key)-1]; if(b && !b.disabled){ e.preventDefault(); b.click(); return; }
      }
      if(e.code === 'Space' || e.key === 'Enter'){
        const n = $('#recallStart') || $('#recallAgain'); if(n){ e.preventDefault(); n.click(); return; }
      }
    }

    if(state.tab === 'match'){
      if(e.code === 'Space' || e.key === 'Enter'){
        const n = $('#matchStart'); if(n){ e.preventDefault(); n.click(); return; }
      }
    }

    if(state.tab === 'type'){
      if(e.key === 'Enter' || e.key === 'ArrowRight' || key === 'd' || e.code === 'Space'){
        const n = $('#typeCheck') || $('#typeStart') || $('#typeAgain'); if(n){ e.preventDefault(); n.click(); return; }
      }
    }

    if(state.tab === 'builder'){
      if(e.code === 'Space' || e.key === 'Enter'){
        const n = $('#builderCheck') || $('#builderStart') || $('#builderAgain'); if(n){ e.preventDefault(); n.click(); return; }
      }
    }

    if(state.tab === 'read'){
      if(e.code === 'Space' || e.key === 'ArrowRight' || key === 'd'){
        const n = $('#readNew'); if(n){ e.preventDefault(); n.click(); return; }
      }
    }
  });

  async function startApp(){
    loadProgress();
    await restoreFromDurableStores();
    await checkAutoBackupStatus();
    saveProgress();
    requestPersistentStorage();
    if('speechSynthesis' in window){ getVoices(); window.speechSynthesis.onvoiceschanged = getVoices; document.body.addEventListener('pointerdown', () => waitForVoices(), {once:true}); }
    renderShell();
  }
  startApp();
})();
