/* Mosel Wortschatz: AI client and word-list loader.
 *
 * Where the backend is:
 *  - same origin: the page is served by the Python server (local or Render).
 *  - remote: a static copy (GitHub Pages) uses the server named in <meta name="mosel-backend">
 *    for the word list and AI, so visitors need no key and the key stays on the server.
 *  - none: the learner pastes their own Groq key and the browser calls Groq directly.
 */
(function(){
  'use strict';

  const SERVER = 'server';                       // stands in for "a key is available on the server"
  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const ACCESS_KEY = 'mosel-wortschatz-access-code';
  const CUSTOM_VOCAB_KEY = 'mosel-wortschatz-custom-vocab';
  // Used only in direct (own-key) mode; the server has its own list. Tried in order.
  const DIRECT_MODELS = {
    quality: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    fast: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
  };
  // A German tutor must not answer in Chinese, Japanese or Korean script (Qwen occasionally does).
  const FOREIGN_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
  const OPTIONAL = ['presence_penalty', 'frequency_penalty', 'response_format', 'top_p', 'reasoning_format', 'reasoning_effort'];
  const NEXT_MODEL = [404, 408, 413, 429, 500, 502, 503, 504];

  let health = null;
  let base = '';                                 // '' = same origin, or the remote backend URL (ends with /)

  function remoteBackend(){
    const meta = document.querySelector('meta[name="mosel-backend"]');
    const url = meta && meta.content ? meta.content.trim() : '';
    return url ? url.replace(/\/?$/, '/') : '';
  }

  async function probe(prefix, timeoutMs){
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(prefix + 'api/health', {headers: {'Accept': 'application/json'}, signal: ctrl.signal});
      const type = r.headers.get('content-type') || '';
      return r.ok && type.includes('json') ? await r.json() : null;
    } catch(e){ return null; } finally { clearTimeout(timer); }
  }

  function store(key, value){
    try { if(value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch(e){}
  }
  function read(key){
    try { return localStorage.getItem(key); } catch(e){ return null; }
  }

  /* onWait(message) is called if the remote server has to wake up (free hosting sleeps when idle). */
  async function init(onWait){
    health = location.protocol === 'file:' ? null : await probe('', 5000);
    const remote = remoteBackend();
    if(!health && remote){
      const waking = setTimeout(() => onWait && onWait('Waking up the server (free hosting sleeps when idle; up to a minute)…'), 2500);
      health = await probe(remote, 75000);
      clearTimeout(waking);
      if(health) base = remote;
    }
    document.documentElement.classList.toggle('server-ai', !!(health && health.ai));
    return health;
  }

  // The app was written for Groq's old Llama models; map its requests onto a tier.
  function tierOf(model){ return /8b|instant/i.test(model || '') ? 'fast' : 'quality'; }

  async function viaServer(body){
    const payload = Object.assign({}, body, {tier: tierOf(body.model)});
    delete payload.model;
    for(let attempt = 0; attempt < 2; attempt++){
      const code = read(ACCESS_KEY);
      const res = await fetch(base + 'api/ai/chat', {
        method: 'POST',
        headers: Object.assign({'Content-Type': 'application/json'}, code ? {'X-Access-Code': code} : {}),
        body: JSON.stringify(payload),
      });
      if(res.status !== 401) return res;
      const entered = window.prompt('This server needs an access code for the AI tutor:');
      if(!entered) return res;
      store(ACCESS_KEY, entered.trim());
    }
    return fetch(base + 'api/ai/chat', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  }

  async function direct(body, apiKey){
    let last = null;
    for(const model of DIRECT_MODELS[tierOf(body.model)]){
      const b = Object.assign({}, body, {model});
      if(model.startsWith('qwen/')) b.reasoning_format = 'hidden';
      if(model.includes('gpt-oss')){                      // it thinks first; the thinking counts against max_tokens
        b.reasoning_effort = 'low';
        if(b.max_tokens) b.max_tokens += 1024;
      }
      for(let i = 0; i <= OPTIONAL.length; i++){
        last = await fetch(GROQ_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey},
          body: JSON.stringify(b),
        });
        if(last.ok){
          const reply = await last.clone().json().catch(() => null);
          const content = reply && reply.choices && reply.choices[0] && reply.choices[0].message && reply.choices[0].message.content;
          if(!content || !content.trim() || FOREIGN_SCRIPT.test(content)) break;   // try the next model
          return last;
        }
        const text = await last.clone().text().catch(() => '');
        let drop = OPTIONAL.find(p => p in b && text.includes(p));
        if(!drop && /json_validate_failed/.test(text) && 'response_format' in b) drop = 'response_format';
        if(last.status === 400 && drop){ delete b[drop]; continue; }
        if(NEXT_MODEL.includes(last.status) || /tool_use_failed|json_validate_failed/.test(text)) break;
        return last;
      }
    }
    return last;
  }

  /* Same contract as fetch(GROQ_URL, ...): resolves to a Response with Groq's JSON. */
  async function chat(body, apiKey){
    if(health && health.ai && (!apiKey || apiKey === SERVER)) return viaServer(body);
    if(!apiKey || apiKey === SERVER) throw new Error('Paste your Groq API key first.');
    return direct(body, apiKey);
  }

  /* Word list: your imported list (this browser) > the server's list > the bundled sample. */
  async function loadWords(){
    const custom = read(CUSTOM_VOCAB_KEY);
    if(custom){
      try { const d = JSON.parse(custom); return Object.assign({source: 'custom'}, d); } catch(e){ store(CUSTOM_VOCAB_KEY, null); }
    }
    if(health){
      const r = await fetch(base + 'api/vocab');
      if(r.ok) return r.json();
    }
    const [chapters, examples] = await Promise.all([
      fetch('data/vocab.json').then(r => { if(!r.ok) throw new Error('word list not found'); return r.json(); }),
      fetch('data/examples_en.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    return {source: 'sample', chapters, examples_en: examples};
  }

  function validateWords(chapters){
    if(!Array.isArray(chapters) || !chapters.length) throw new Error('expected a list of chapters');
    const ids = new Set();
    for(const c of chapters){
      if(!c || !c.title || !Array.isArray(c.words)) throw new Error('every chapter needs a title and words');
      for(const w of c.words){
        if(!w || w.id == null || !w.term || !w.translation) throw new Error('every word needs id, term and translation');
        if(ids.has(w.id)) throw new Error('duplicate word id ' + w.id);
        ids.add(w.id);
      }
    }
    return ids.size;
  }

  function importWords(text){
    const parsed = JSON.parse(text);
    const chapters = Array.isArray(parsed) ? parsed : parsed.chapters;
    const count = validateWords(chapters);
    store(CUSTOM_VOCAB_KEY, JSON.stringify({chapters, examples_en: (parsed && parsed.examples_en) || {}}));
    return count;
  }

  function resetWords(){ store(CUSTOM_VOCAB_KEY, null); }

  window.MoselAI = {SERVER, init, chat, get serverAI(){ return !!(health && health.ai); }, get health(){ return health; },
    get remote(){ return base; }};
  window.MoselData = {load: loadWords, importWords, resetWords, validate: validateWords};
})();
