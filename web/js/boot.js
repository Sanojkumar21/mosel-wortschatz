/* Start-up: detect the server, load the word list, then start the trainer (js/app.js). */
(async function(){
  'use strict';
  const body = document.getElementById('vtBody');
  const footer = document.getElementById('dataInfo');
  try {
    await MoselAI.init();
    const data = await MoselData.load();
    window.VOCAB_DATA = data.chapters;
    window.EXAMPLE_EN = data.examples_en || {};
    const words = data.chapters.reduce((n, c) => n + c.words.length, 0);
    const labels = {private: 'your word list', custom: 'your imported word list', sample: 'sample word list'};
    if(footer){
      footer.textContent = `${labels[data.source] || data.source} · ${data.chapters.length} chapters · ${words} words · AI: ${
        MoselAI.serverAI ? 'server' : 'your own Groq key'}`;
    }
    document.getElementById('resetWords').hidden = data.source !== 'custom';
    const app = document.createElement('script');
    app.src = 'js/app.js';
    document.body.appendChild(app);
  } catch(e){
    body.innerHTML = '<div class="vt-qsetup"><h2 class="vt-mode-title">Could not load the word list</h2><p>' +
      String(e.message || e).replace(/</g, '&lt;') + '</p><p>Run the server (<code>make serve</code>) or open the site from GitHub Pages.</p></div>';
  }

  document.getElementById('importWords').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if(!file) return;
    try {
      const n = MoselData.importWords(await file.text());
      alert(`Imported ${n} words. They stay in this browser only.`);
      location.reload();
    } catch(e){ alert('That file is not a valid word list: ' + e.message); }
  });
  document.getElementById('resetWords').addEventListener('click', () => { MoselData.resetWords(); location.reload(); });
})();
