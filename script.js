/* ══════════════════════════════════════════
   BACKEND CONFIG — HYBRID ARCHITECTURE
   ─────────────────────────────────────────
   The Express AI backend now lives on Render (persistent
   server, no serverless timeout), separate from this
   Vercel-hosted frontend. ⚠️ REPLACE THE PLACEHOLDER BELOW
   with your real Render service URL once it's deployed
   (Render dashboard → your service → the URL at the top,
   e.g. https://bharat-nova-ai-backend.onrender.com).
══════════════════════════════════════════ */
const BACKEND_URL = 'https://bharat-zenith-backend.onrender.com/api/server';

/* ══════════════════════════════════════════
   ENGINE REGISTRY (must match api/server.js keys)
   Order = "Intelligence Wise" ranking.
   textOnly:true → engine cannot see images; these
   4 get disabled in the dropdown while an image is
   attached (see IMAGE-AWARE ENGINE LOCKING below).
══════════════════════════════════════════ */
const ENGINES = [
  { key:'gemini',       name:'Gemini',        sub:'Google · gemini-2.5-flash',          color:'#4285F4', textOnly:false },
  { key:'githubmodels', name:'GitHub Models', sub:'gpt-4o-mini · OpenAI-compatible',     color:'#58A6FF', textOnly:false },
  { key:'openrouter',   name:'OpenRouter',    sub:'Gemini 2.5 Flash · vision capable',  color:'#8b5cf6', textOnly:false },
  { key:'mistral',      name:'Mistral',       sub:'Mistral-small · Pixtral Vision',     color:'#FF7000', textOnly:false },
  { key:'groq',         name:'Groq',          sub:'gpt-oss-20b · ultra fast',           color:'#FF8C00', textOnly:true  },
  { key:'sambanova',    name:'SambaNova',     sub:'Llama 4 Maverick · ultra fast',      color:'#EE2B69', textOnly:false },
  { key:'nvidia',       name:'NVIDIA',        sub:'NIM · Llama 3.1 8B',                 color:'#76b900', textOnly:true  },
  { key:'huggingface',  name:'HuggingFace',   sub:'Llama 3.1 8B Instruct',              color:'#ffcc4d', textOnly:true  },
  { key:'cohere',       name:'Cohere',        sub:'command-r-latest',                   color:'#39594D', textOnly:true  },
  { key:'fireworks',    name:'Fireworks',     sub:'Llama 3.1 8B',                       color:'#ff5e5e', textOnly:true  },
];
const engineByKey = k => ENGINES.find(e => e.key === k) || ENGINES.find(e => e.key === 'groq') || ENGINES[0];

let selectedEngine = localStorage.getItem('bz_engine') || 'groq';
let currentUser = null;
let chats = [];
let activeChatId = null;
let pendingAttachment = null; // { base64, mimeType, name, isImage, dataUrl } — current unsent attachment
let agentModeOn = localStorage.getItem('bz_agent_mode') === '1'; // Manus Agent Mode toggle

/* ══════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════ */
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('on');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('on');
}

/* ══════════════════════════════════════════
   MODEL SELECTOR (dropup pill)
══════════════════════════════════════════ */
function renderEngineMenu(){
  const menu = document.getElementById('engineMenu');
  menu.innerHTML = ENGINES.map(e => {
    const isLocked = engineLockedForImage && e.textOnly;
    return `
    <div class="engine-opt ${e.key===selectedEngine?'active':''} ${isLocked?'disabled':''}"
         ${isLocked ? 'aria-disabled="true"' : `onclick="pickEngine('${e.key}')"`}>
      <span class="model-dot" style="background:${e.color}"></span>
      <div>
        <div class="eo-name">${e.name}${isLocked ? ' <span class="eo-lock">🔒</span>' : ''}</div>
        <div class="eo-sub">${isLocked ? 'Text-only · disabled for images' : e.sub}</div>
      </div>
    </div>
  `;
  }).join('');
}
function toggleEngineMenu(){
  renderEngineMenu();
  document.getElementById('engineMenu').classList.toggle('open');
}
function pickEngine(key){
  if (engineLockedForImage) {
    const target = engineByKey(key);
    if (target && target.textOnly) return; // text-only engines are unselectable while an image is attached
  }
  selectedEngine = key;
  localStorage.setItem('bz_engine', key);
  updatePillUI();
  document.getElementById('engineMenu').classList.remove('open');
}
function updatePillUI(){
  const e = engineByKey(selectedEngine);
  document.getElementById('pillName').textContent = e.name;
  document.getElementById('pillDot').style.background = e.color;
}

/* ══════════════════════════════════════════
   MANUS AGENT MODE TOGGLE
   ─────────────────────────────────────────
   OFF (default) → sendMessage() behaves exactly as
   before: single chosen engine + automatic failsafe.
   ON → sendMessage() forks to sendAgentMessage(), which
   breaks the query into sub-tasks, distributes them
   across the engine pool with live failover, and
   synthesizes one final answer (see /agent route).
══════════════════════════════════════════ */
function toggleAgentMode(){
  agentModeOn = !agentModeOn;
  localStorage.setItem('bz_agent_mode', agentModeOn ? '1' : '0');
  document.getElementById('agentToggle')?.classList.toggle('on', agentModeOn);
  showToast(agentModeOn
    ? '🧬 Manus Agent Mode ON — complex questions are broken into sub-tasks routed across multiple engines.'
    : 'Manus Agent Mode OFF — back to single-engine mode.');
}

/* ══════════════════════════════════════════
   IMAGE-AWARE ENGINE LOCKING
   ─────────────────────────────────────────
   The 4 text-only engines (NVIDIA, HuggingFace,
   Cohere, Fireworks) can't process images. As soon
   as an image attachment is pending we disable them
   in the dropdown. If one of them was already the
   active selection, we auto-switch to Gemini so the
   request actually reaches a vision-capable engine.
   Clearing/removing the image re-enables all four.
══════════════════════════════════════════ */
let engineLockedForImage = false;

function applyImageEngineLock(hasImage){
  engineLockedForImage = !!hasImage;
  if (engineLockedForImage) {
    const current = engineByKey(selectedEngine);
    if (current && current.textOnly) {
      selectedEngine = 'gemini';
      localStorage.setItem('bz_engine', 'gemini');
      updatePillUI();
      showToast('Switched to Google Gemini — the previously selected engine can\'t view images.');
    }
  }
  renderEngineMenu();
}
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('engineMenu');
  const pill = document.getElementById('modelPill');
  if (menu.classList.contains('open') && !menu.contains(ev.target) && !pill.contains(ev.target)) {
    menu.classList.remove('open');
  }
});

/* ══════════════════════════════════════════
   PLUS BUTTON → FLOATING ATTACH MENU
══════════════════════════════════════════ */
function toggleAttachMenu(ev){
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('attachMenu');
  const btn = document.getElementById('plusBtn');
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  btn.classList.toggle('active', willOpen);
}
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('attachMenu');
  const wrap = document.getElementById('plusWrap');
  if (menu.classList.contains('open') && !wrap.contains(ev.target)) {
    menu.classList.remove('open');
    document.getElementById('plusBtn').classList.remove('active');
  }
});
function triggerPicker(kind){
  document.getElementById('attachMenu').classList.remove('open');
  document.getElementById('plusBtn').classList.remove('active');
  if (kind === 'photo') document.getElementById('fileInputPhoto').click();
  else if (kind === 'camera') document.getElementById('fileInputCamera').click();
  else document.getElementById('fileInputFile').click();
}

/* ══════════════════════════════════════════
   FILE / IMAGE → BASE64 PROCESSING
   Images are downscaled + re-encoded as JPEG on a
   canvas before becoming base64, so uploads stay
   small and fast even from a 12MP phone camera.
   Generic files are read as-is (size-capped).
══════════════════════════════════════════ */
const MAX_RAW_FILE_BYTES = 6 * 1024 * 1024;      // pre-read cap for non-image files
const MAX_ATTACHMENT_BASE64_CHARS = 8000000;      // ~6MB raw after base64 inflation

function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
function compressImageToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_EDGE = 1280;
        let { width, height } = img;
        if (width > MAX_EDGE || height > MAX_EDGE) {
          if (width >= height) { height = Math.round(height * (MAX_EDGE / width)); width = MAX_EDGE; }
          else { width = Math.round(width * (MAX_EDGE / height)); height = MAX_EDGE; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const mimeType = 'image/jpeg';
        const dataUrl = canvas.toDataURL(mimeType, 0.78);
        resolve({ base64: dataUrl.split(',')[1] || '', mimeType, dataUrl });
      };
      img.onerror = () => reject(new Error('Could not decode that image.'));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
}
async function handleFileSelect(ev){
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = ''; // reset so the same file can be re-picked later
  if (!file) return;

  const isImage = file.type.startsWith('image/');
  try {
    if (isImage) {
      const { base64, mimeType, dataUrl } = await compressImageToBase64(file);
      setPendingAttachment({ base64, mimeType, dataUrl, name: file.name, isImage: true });
    } else {
      if (file.size > MAX_RAW_FILE_BYTES) {
        showToast('That file is too large (max ~6MB). Please choose a smaller file.');
        return;
      }
      const base64 = await fileToBase64(file);
      if (base64.length > MAX_ATTACHMENT_BASE64_CHARS) {
        showToast('That file is too large (max ~6MB). Please choose a smaller file.');
        return;
      }
      setPendingAttachment({ base64, mimeType: file.type || 'application/octet-stream', name: file.name, isImage: false });
    }
  } catch (err) {
    showToast(err?.message || 'Could not process that file.');
  }
}
function setPendingAttachment(att){
  pendingAttachment = att;
  renderAttachPreview();
  applyImageEngineLock(!!att.isImage);
}
function clearAttachment(){
  pendingAttachment = null;
  renderAttachPreview();
  applyImageEngineLock(false);
}
function renderAttachPreview(){
  const wrap = document.getElementById('attachPreviewWrap');
  const box = document.getElementById('attachPreview');
  if (!pendingAttachment) { wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = 'block';
  box.innerHTML = pendingAttachment.isImage
    ? `<div class="attach-item">
         <img class="attach-thumb" src="${pendingAttachment.dataUrl}" alt="Attached image preview"/>
         <button class="attach-remove" onclick="clearAttachment()" aria-label="Remove attachment">✕</button>
       </div>`
    : `<div class="attach-item">
         <div class="attach-file-chip">
           <span class="afc-ico">📄</span>
           <span class="afc-name">${escapeHtml(pendingAttachment.name || 'file')}</span>
         </div>
         <button class="attach-remove" onclick="clearAttachment()" aria-label="Remove attachment">✕</button>
       </div>`;
}

/* ══════════════════════════════════════════
   TOASTS
══════════════════════════════════════════ */
function showToast(msg, ms=5000){
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, ms);
}

/* ══════════════════════════════════════════
   UTILITY: HTML ESCAPE (used for user bubbles
   and any raw text inserted into HTML)
══════════════════════════════════════════ */
function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ══════════════════════════════════════════
   CODE STORE — avoids embedding long strings
   in onclick attributes for artifact buttons
══════════════════════════════════════════ */
const _codeStore = {};
let _codeIdx = 0;
function _storeCode(code) {
  const id = 'cs' + (_codeIdx++);
  _codeStore[id] = code;
  return id;
}
function _resetCodeStore() {
  Object.keys(_codeStore).forEach(k => delete _codeStore[k]);
  _codeIdx = 0;
}

/* ══════════════════════════════════════════
   BHARAT TAG EXTRACTOR
══════════════════════════════════════════ */
function extractTag(raw, tagName) {
  const re = new RegExp('<' + tagName + '>[\\s\\S]*?<\\/' + tagName + '>', 'i');
  const match = raw.match(re);
  if (!match) return { content: null, stripped: raw };
  const inner = match[0]
    .replace(new RegExp('^<' + tagName + '>', 'i'), '')
    .replace(new RegExp('<\\/' + tagName + '>$', 'i'), '')
    .trim();
  const stripped = raw.replace(re, '').trim();
  return { content: inner, stripped };
}

/* ══════════════════════════════════════════
   HTML DECODE (for artifact code extraction)
══════════════════════════════════════════ */
function htmlDecode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/* ══════════════════════════════════════════
   INTENT DETECTION (for loading thought text)
══════════════════════════════════════════ */
function detectIntent(text) {
  const t = (text || '').toLowerCase();
  if (/\b(bug|fix|error|code|function|class|script|program|debug|compile|syntax|python|javascript|html|css|react|node|api|import|export|variable|loop|array|json|sql|algorithm)\b/.test(t)) return 'code';
  if (/\b(math|calculate|solve|equation|formula|integral|derivative|algebra|geometry|proof|compute|statistics|probability|matrix)\b/.test(t)) return 'math';
  return 'general';
}
const INTENT_MSGS = {
  code:    ['Reading repository structure…', 'Analyzing code context…', 'Detecting anomalies…', 'Structuring optimal logic…', 'Compiling solution…'],
  math:    ['Parsing variables…', 'Validating formulas…', 'Calculating step sequences…', 'Verifying results…', 'Finalizing answer…'],
  general: ['Analyzing query intent…', 'Processing contextual parameters…', 'Synthesizing global knowledge…', 'Refining prose elegance…', 'Generating response…'],
};

/* ══════════════════════════════════════════
   TOGGLE ACCORDION (thought / steps)
══════════════════════════════════════════ */
function toggleAccordion(id) {
  const body = document.getElementById(id);
  if (!body) return;
  const isOpen = body.classList.toggle('open');
  const hdr = body.previousElementSibling;
  if (hdr) {
    const chev = hdr.querySelector('.bta-chevron,.bsc-chevron');
    if (chev) chev.classList.toggle('open', isOpen);
  }
}

/* ══════════════════════════════════════════
   RENDER BHARAT THOUGHT ACCORDION
══════════════════════════════════════════ */
function renderThoughtAccordion(thoughtText) {
  const id = 'bta' + Math.random().toString(36).slice(2, 8);
  const inner = thoughtText ? marked.parse(thoughtText) : '';
  return `<div class="bharat-thought-accordion">
  <div class="bta-header" onclick="toggleAccordion('${id}')">
    <span class="bta-icon">🧠</span>
    <span class="bta-label">Bharat Thought</span>
    <span class="bta-chevron">›</span>
  </div>
  <div class="bta-body" id="${id}">
    <div class="bta-content">${inner}</div>
  </div>
</div>`;
}

/* ══════════════════════════════════════════
   RENDER BHARAT STEPS CONTAINER
══════════════════════════════════════════ */
function renderStepsContainer(stepsText) {
  const id = 'bsc' + Math.random().toString(36).slice(2, 8);
  const steps = stepsText.split('\n').map(s => s.trim()).filter(s => s.length > 1);
  const count = steps.length;
  const stepsHtml = steps.map(s =>
    `<div class="bsc-step">${escapeHtml(s.replace(/^[•\-\*\d\.]\s*/, ''))}</div>`
  ).join('');
  return `<div class="bharat-steps-container">
  <div class="bsc-header" onclick="toggleAccordion('${id}')">
    <span class="bsc-icon">💼</span>
    <span class="bsc-label">${count} step${count !== 1 ? 's' : ''} ›</span>
    <span class="bsc-chevron">›</span>
  </div>
  <div class="bsc-body" id="${id}">
    ${stepsHtml}
  </div>
</div>`;
}

/* ══════════════════════════════════════════
   ARTIFACT HELPERS — copy / download / preview
══════════════════════════════════════════ */
function getArtifactFilename(lang) {
  const m = {
    javascript:'script.js', js:'script.js', typescript:'script.ts', ts:'script.ts',
    python:'main.py',    py:'main.py',    html:'index.html',  css:'styles.css',
    json:'data.json',    bash:'script.sh', shell:'script.sh', sh:'script.sh',
    java:'Main.java',    cpp:'main.cpp',   c:'main.c',         rust:'main.rs',
    go:'main.go',        ruby:'script.rb', php:'index.php',    sql:'query.sql',
    xml:'data.xml',      yaml:'config.yaml', yml:'config.yml', markdown:'README.md', md:'README.md',
  };
  const l = (lang || '').toLowerCase();
  return m[l] || (l ? `code.${l}` : 'code.txt');
}

function renderArtifact(code, lang) {
  const codeId  = _storeCode(code);
  const filename = getArtifactFilename(lang);
  const l = (lang || '').toLowerCase();
  const previewable = ['html', 'css', 'javascript', 'js'].includes(l);
  return `<div class="artifact-wrap">
  <div class="artifact-bar">
    <span class="artifact-lang">${escapeHtml(lang || 'code')}</span>
    <span class="artifact-filename">${escapeHtml(filename)}</span>
    <div class="artifact-btns">
      <button class="art-btn" onclick="copyArtifact(this,'${codeId}')" title="Copy Code">📋 Copy</button>
      <button class="art-btn" onclick="downloadArtifact('${codeId}','${escapeHtml(filename)}')" title="Download">⬇ Save</button>
      ${previewable ? `<button class="art-btn art-preview" onclick="previewArtifact('${codeId}','${l}')" title="Live Preview">👁 Preview</button>` : ''}
    </div>
  </div>
  <div class="artifact-code"><pre><code>${escapeHtml(code)}</code></pre></div>
</div>`;
}

window.copyArtifact = function(btn, id) {
  const code = _codeStore[id] || '';
  navigator.clipboard?.writeText(code).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Copied';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
};
window.downloadArtifact = function(id, filename) {
  const code = _codeStore[id] || '';
  const blob = new Blob([code], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
window.previewArtifact = function(id, lang) {
  const code = _codeStore[id] || '';
  let srcdoc;
  if (lang === 'css') {
    srcdoc = `<!DOCTYPE html><html><head><style>body{font-family:system-ui;padding:20px}button{margin:6px;padding:8px 16px}input{margin:6px;padding:8px;border:1px solid #ccc;border-radius:4px}</style><style>${code}</style></head><body><h2>CSS Preview</h2><p>Your styles are applied to this page.</p><button>Sample Button</button><button class="secondary">Secondary</button><br><input placeholder="Sample Input" type="text"/></body></html>`;
  } else if (lang === 'js' || lang === 'javascript') {
    srcdoc = `<!DOCTYPE html><html><head><style>body{font-family:system-ui;padding:20px;color:#333}</style></head><body><div id="output"></div><script>try{${code}}catch(e){document.getElementById('output').innerHTML='<b style="color:red">Error: '+e.message+'</b>'}<\/script></body></html>`;
  } else {
    srcdoc = code;
  }
  document.getElementById('previewFrame').srcdoc = srcdoc;
  document.getElementById('previewModal').classList.add('open');
};
window.closePreview = function() {
  document.getElementById('previewModal').classList.remove('open');
  setTimeout(() => { document.getElementById('previewFrame').srcdoc = ''; }, 300);
};

/* ══════════════════════════════════════════
   PERFORMANCE BADGE RENDERER
══════════════════════════════════════════ */
function renderPerfBadge(m) {
  if (!m.timing && !m.engineName) return '';
  const eng = escapeHtml(m.engineName || '');
  const t   = m.timing ? `⚡ ${m.timing}s` : '';
  if (m.fallback) {
    return `<div class="perf-badge failsafe">🛡️ Failsafe: ${t} via ${eng}</div>`;
  }
  return `<div class="perf-badge">${t} via ${eng}</div>`;
}

/* ══════════════════════════════════════════
   RICH CONTENT RENDERER — Marked.js + KaTeX
   ─────────────────────────────────────────
   The trick: LaTeX math MUST be extracted and
   replaced with opaque placeholders BEFORE
   marked.parse() runs, because Marked will
   escape $ signs and mangle \[ \] sequences.
   After Markdown is rendered we put the KaTeX
   HTML back in place of every placeholder.

   Supported delimiters:
     Block:  $$ ... $$   and   \[ ... \]
     Inline: $ ... $     and   \( ... \)
══════════════════════════════════════════ */
function renderContent(raw) {
  if (!raw) return '';

  // Stash for extracted math expressions
  const mathStore = [];

  function protect(type, math) {
    const id = mathStore.length;
    mathStore.push({ type, math });
    // Null-byte delimiters — invisible to Marked and safe in HTML
    return `\x00MATH${id}\x00`;
  }

  let s = raw;

  // 1. Block math: $$...$$ — must match before single $
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => protect('block', m));

  // 2. Block math: \[...\]
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => protect('block', m));

  // 3. Inline math: \(...\)
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => protect('inline', m));

  // 4. Inline math: $...$ (no newlines — avoids false positives on lone $ in prices)
  s = s.replace(/\$([^\$\n]+?)\$/g, (_, m) => protect('inline', m));

  // 5. Run full Markdown rendering
  s = marked.parse(s);

  // 6. Restore each placeholder as a rendered KaTeX equation
  s = s.replace(/\x00MATH(\d+)\x00/g, (_, idx) => {
    const { type, math } = mathStore[parseInt(idx, 10)];
    try {
      return katex.renderToString(math.trim(), {
        displayMode: type === 'block',
        throwOnError: false,
        output: 'html',
      });
    } catch (e) {
      // Fallback: show the raw LaTeX in a code tag so it's still readable
      return `<code class="math-err">${escapeHtml(math)}</code>`;
    }
  });

  return s;
}

/* ══════════════════════════════════════════
   CHAT STORAGE (per Firebase user, localStorage)
══════════════════════════════════════════ */
function storageKey(){ return `bz_chats_${currentUser ? currentUser.uid : 'anon'}`; }
function loadChats(){
  try { chats = JSON.parse(localStorage.getItem(storageKey())) || []; } catch { chats = []; }
}
function saveChats(){
  localStorage.setItem(storageKey(), JSON.stringify(chats));
}
function getActiveChat(){
  return chats.find(c => c.id === activeChatId) || null;
}
function newChat(){
  const chat = { id: 'c_' + Date.now(), title: 'New chat', messages: [], createdAt: Date.now() };
  chats.unshift(chat);
  activeChatId = chat.id;
  saveChats();
  renderHistory();
  renderMessages();
  closeSidebar();
  document.getElementById('msgInput').focus();
}
function switchChat(id){
  activeChatId = id;
  renderHistory();
  renderMessages();
  closeSidebar();
}
function deleteChat(id, ev){
  ev.stopPropagation();
  chats = chats.filter(c => c.id !== id);
  saveChats();
  if (activeChatId === id) {
    activeChatId = chats.length ? chats[0].id : null;
    if (!activeChatId) newChat();
  }
  renderHistory();
  renderMessages();
}
function renderHistory(){
  const list = document.getElementById('histList');
  if (!chats.length) { list.innerHTML = '<div style="color:var(--faint);font-size:.78rem;padding:8px 10px;">No chats yet</div>'; return; }
  list.innerHTML = chats.map(c => `
    <div class="hist-item ${c.id===activeChatId?'active':''}" onclick="switchChat('${c.id}')">
      <span class="hist-title">${escapeHtml(c.title || 'New chat')}</span>
      <button class="hist-del" onclick="deleteChat('${c.id}', event)">✕</button>
    </div>
  `).join('');
}

/* ══════════════════════════════════════════
   MESSAGE RENDERING
══════════════════════════════════════════ */
function renderMessages(){
  _resetCodeStore();
  const inner = document.getElementById('chatInner');
  const chat = getActiveChat();
  if (!chat || !chat.messages.length) {
    inner.innerHTML = `
      <div class="empty-state">
        <div class="big-icon">N</div>
        <h2>Bharat Zenith AI</h2>
        <p>Pick an engine from the pill in the input bar and start chatting. If your chosen engine ever fails, Nova automatically switches to a backup — no downtime.</p>
      </div>`;
    return;
  }
  inner.innerHTML = chat.messages.map((m, i) => renderBubble(m, i)).join('');
  // KaTeX is synchronous — no post-render typeset call needed
  scrollChatToBottom(true);
}
function renderBubble(m, idx){
  const isUser = m.role === 'user';
  const avatar = isUser
    ? `<div class="avatar user">YOU</div>`
    : `<div class="avatar ai">N</div>`;
  const attachmentHtml = renderBubbleAttachment(m.attachment);

  /* ── USER BUBBLE ── */
  if (isUser) {
    const content = escapeHtml(m.content);
    const hasText = !!(m.content && m.content.trim());
    return `<div class="msg-row user">
      ${avatar}
      <div class="bubble-col">
        ${attachmentHtml}
        ${hasText || !attachmentHtml ? `<div class="bubble">${content}</div>` : ''}
      </div>
    </div>`;
  }

  /* ── AI ERROR BUBBLE ── */
  if (m.error) {
    return `<div class="msg-row ai">
      ${avatar}
      <div class="bubble-col">
        <div class="bubble error">${renderContent(m.content || '')}</div>
        ${renderPerfBadge(m)}
      </div>
    </div>`;
  }

  /* ── AI RESPONSE BUBBLE ── */
  let raw = m.content || '';

  // 1. Extract <bharat_thought>
  const tResult = extractTag(raw, 'bharat_thought');
  const thoughtText = tResult.content;
  raw = tResult.stripped;

  // 2. Extract <bharat_steps>
  const sResult = extractTag(raw, 'bharat_steps');
  const stepsText = sResult.content;
  raw = sResult.stripped;

  // 3. Run remaining text through Markdown renderer
  let mainHtml = renderContent(raw);

  // 4. Post-process: replace marked's <pre><code> blocks with artifact containers
  mainHtml = mainHtml.replace(
    /<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (match, cls, encodedCode) => {
      const lang = cls ? cls.replace('language-', '') : '';
      const code = htmlDecode(encodedCode);
      if (code.trim().length < 10) return match; // skip trivial snippets
      return renderArtifact(code, lang);
    }
  );

  // 5. Build optional blocks
  const thoughtHtml = thoughtText ? renderThoughtAccordion(thoughtText) : '';
  const stepsHtml   = stepsText   ? renderStepsContainer(stepsText)     : '';
  const manusHtml   = m.agentSubtasks ? renderManusSummary(m.agentSubtasks) : '';
  const badgeHtml   = renderPerfBadge(m);
  const copyBtn     = `<button class="copy-btn" onclick="copyMsg(${idx})">Copy</button>`;

  return `<div class="msg-row ai">
    ${avatar}
    <div class="bubble-col">
      ${attachmentHtml}
      ${manusHtml}
      ${thoughtHtml}
      ${stepsHtml}
      ${mainHtml ? `<div class="bubble">${mainHtml}</div>` : ''}
      ${badgeHtml}
      <div class="msg-meta"><span>${escapeHtml(m.engineName||'')}</span>${copyBtn}</div>
    </div>
  </div>`;
}
function renderBubbleAttachment(att){
  if (!att) return '';
  if (att.isImage && att.dataUrl) {
    return `<img class="bubble-attach-img" src="${att.dataUrl}" alt="Attached image"/>`;
  }
  return `<div class="bubble-attach-file">📄 ${escapeHtml(att.name || 'Attached file')}</div>`;
}
function copyMsg(idx){
  const chat = getActiveChat();
  if (!chat) return;
  const m = chat.messages[idx];
  if (!m) return;
  let text = m.content || '';
  text = text.replace(/<bharat_thought>[\s\S]*?<\/bharat_thought>/gi, '').trim();
  text = text.replace(/<bharat_steps>[\s\S]*?<\/bharat_steps>/gi, '').trim();
  navigator.clipboard?.writeText(text);
}
let _typingInterval = null;
function showTyping(userText){
  const inner = document.getElementById('chatInner');
  const intent = detectIntent(userText || '');
  const msgs   = INTENT_MSGS[intent];
  const row = document.createElement('div');
  row.className = 'msg-row ai';
  row.id = 'typingRow';
  row.innerHTML = `
    <div class="avatar ai">N</div>
    <div class="bubble-col">
      <div class="bharat-thought-accordion loading-thought">
        <div class="bta-header" style="cursor:default">
          <span class="bta-icon">🧠</span>
          <span class="bta-label">Bharat Thought</span>
          <span class="bta-status" id="thoughtStatus">${escapeHtml(msgs[0])}</span>
        </div>
      </div>
      <div class="bubble"><div class="typing-text">Bharat</div></div>
    </div>`;
  inner.appendChild(row);
  scrollChatToBottom(true);
  let mi = 0;
  _typingInterval = setInterval(() => {
    mi = (mi + 1) % msgs.length;
    const el = document.getElementById('thoughtStatus');
    if (el) { el.style.opacity = '0'; setTimeout(() => { if(el){ el.textContent = msgs[mi]; el.style.opacity = '1'; } }, 180); }
  }, 1900);
}
function hideTyping(){
  if (_typingInterval) { clearInterval(_typingInterval); _typingInterval = null; }
  document.getElementById('typingRow')?.remove();
}

/* Only auto-scroll if the user is already near the bottom, so manual
   scroll-up to read history is never jittered or yanked back down. */
function isNearBottom(){
  const wrap = document.getElementById('chatWrap');
  return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
}
function scrollChatToBottom(force){
  const wrap = document.getElementById('chatWrap');
  if (force || isNearBottom()) {
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  }
}

/* ══════════════════════════════════════════
   INPUT HANDLING
══════════════════════════════════════════ */
function autoGrow(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}
function onInputKeydown(ev){
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendMessage();
  }
}

/* ══════════════════════════════════════════
   SEND MESSAGE → Render backend (auto-failsafe, see BACKEND_URL)
══════════════════════════════════════════ */
async function sendMessage(){
  if (agentModeOn) return sendAgentMessage();
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  const attachment = pendingAttachment; // snapshot — current turn's attachment only
  if (!text && !attachment) return;

  let chat = getActiveChat();
  if (!chat) { newChat(); chat = getActiveChat(); }

  // Compact record kept in chat history for re-rendering the bubble.
  // Images keep their (already-compressed) preview; generic files only
  // keep their name/type, never re-sent on later turns.
  const attachmentForHistory = attachment ? {
    isImage: attachment.isImage,
    mimeType: attachment.mimeType,
    name: attachment.name,
    dataUrl: attachment.isImage ? attachment.dataUrl : null,
  } : null;

  chat.messages.push({ role:'user', content:text, attachment: attachmentForHistory });
  if (chat.title === 'New chat') {
    const fallbackTitle = attachment ? (attachment.isImage ? '📷 Photo' : `📄 ${attachment.name || 'File'}`) : 'New chat';
    chat.title = (text || fallbackTitle).slice(0, 40);
  }
  saveChats();
  renderHistory();
  renderMessages();

  input.value = '';
  autoGrow(input);
  clearAttachment();
  document.getElementById('sendBtn').disabled = true;
  showTyping(text);

  const _perfStart = performance.now();
  try {
    const res = await fetch(BACKEND_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        engine: selectedEngine,
        temperature: 0.7,
        max_tokens: 4096,
        messages: chat.messages.map(m => {
          // For every past user turn that had an attachment, append a short
          // context note so the model retains awareness of what was sent.
          // We cannot re-transmit the raw binary data for prior turns (it
          // would bloat the payload on every follow-up), so a plain-text
          // summary is the right approach for maintaining multi-turn context.
          let content = m.content || '';
          if (m.role === 'user' && m.attachment) {
            if (m.attachment.isImage) {
              const tag = `[This message included an attached image (${m.attachment.mimeType || 'image'})]`;
              content = content ? `${content}\n${tag}` : tag;
            } else if (m.attachment.name) {
              const tag = `[This message included an attached file: "${m.attachment.name}" (${m.attachment.mimeType || 'file'})]`;
              content = content ? `${content}\n${tag}` : tag;
            }
          }
          return { role: m.role, content };
        }),
        ...(attachment ? { attachment: { mimeType: attachment.mimeType, data: attachment.base64, name: attachment.name } } : {}),
      }),
    });
    const data = await res.json();
    const _timing = ((performance.now() - _perfStart) / 1000).toFixed(1);
    hideTyping();

    if (data.error) {
      chat.messages.push({ role:'assistant', content:`⚠️ ${data.message || 'All engines failed.'}`, error:true, timing:_timing });
      showToast(`All engines failed for this request. Check your API keys in Render.`);
    } else {
      chat.messages.push({
        role:'assistant',
        content: data.reply,
        engine: data.engine,
        engineName: data.engineName,
        fallback: data.fallback,
        requestedEngineName: data.requestedEngineName,
        timing: _timing,
      });
      if (data.fallback) {
        showToast(`System: ${data.requestedEngineName} failed. Automatically fetched answer via ${data.engineName}.`);
      }
    }
  } catch (err) {
    const _timing = ((performance.now() - _perfStart) / 1000).toFixed(1);
    hideTyping();
    chat.messages.push({ role:'assistant', content:`⚠️ Network error: ${err?.message || 'request failed'}`, error:true, timing:_timing });
  }

  saveChats();
  renderMessages();
  document.getElementById('sendBtn').disabled = false;
}

/* ══════════════════════════════════════════
   MANUS AGENT MODE — multi-part breakdown,
   distributed task routing, live SSE feed
   ─────────────────────────────────────────
   Mirrors sendMessage()'s user-turn handling exactly,
   then streams from /agent instead of a single POST/
   JSON round-trip to /api/server.
══════════════════════════════════════════ */
const AGENT_URL = BACKEND_URL.replace(/\/[^/]+$/, '/agent');

async function sendAgentMessage(){
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  const attachment = pendingAttachment;
  if (!text && !attachment) return;

  let chat = getActiveChat();
  if (!chat) { newChat(); chat = getActiveChat(); }

  const attachmentForHistory = attachment ? {
    isImage: attachment.isImage,
    mimeType: attachment.mimeType,
    name: attachment.name,
    dataUrl: attachment.isImage ? attachment.dataUrl : null,
  } : null;

  chat.messages.push({ role:'user', content:text, attachment: attachmentForHistory });
  if (chat.title === 'New chat') {
    const fallbackTitle = attachment ? (attachment.isImage ? '📷 Photo' : `📄 ${attachment.name || 'File'}`) : 'New chat';
    chat.title = (text || fallbackTitle).slice(0, 40);
  }
  saveChats();
  renderHistory();
  renderMessages();

  input.value = '';
  autoGrow(input);
  clearAttachment();
  document.getElementById('sendBtn').disabled = true;
  showAgentFeed();

  const _perfStart = performance.now();
  try {
    const res = await fetch(AGENT_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        engine: selectedEngine,
        temperature: 0.7,
        max_tokens: 4096,
        messages: chat.messages.map(m => {
          let content = m.content || '';
          if (m.role === 'user' && m.attachment) {
            if (m.attachment.isImage) {
              const tag = `[This message included an attached image (${m.attachment.mimeType || 'image'})]`;
              content = content ? `${content}\n${tag}` : tag;
            } else if (m.attachment.name) {
              const tag = `[This message included an attached file: "${m.attachment.name}" (${m.attachment.mimeType || 'file'})]`;
              content = content ? `${content}\n${tag}` : tag;
            }
          }
          return { role: m.role, content };
        }),
        ...(attachment ? { attachment: { mimeType: attachment.mimeType, data: attachment.base64, name: attachment.name } } : {}),
      }),
    });

    if (!res.ok || !res.body) throw new Error(`Agent endpoint returned HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalData = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream:true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop(); // keep the possibly-incomplete trailing chunk buffered
      for (const chunk of chunks) {
        const line = chunk.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === 'log') {
          appendAgentLog(evt.text, 'info');
        } else if (evt.type === 'subtask_attempt') {
          appendAgentLog(`→ Part ${evt.id} routed to ${evt.engineName}`, 'pending', evt.id);
        } else if (evt.type === 'subtask_result') {
          appendAgentLog(
            evt.status === 'success' ? `✓ Part ${evt.id} done` : `✗ Part ${evt.id} failed — all engines exhausted`,
            evt.status === 'success' ? 'success' : 'failed',
            evt.id
          );
        } else if (evt.type === 'final') {
          finalData = evt;
        }
      }
    }

    const _timing = ((performance.now() - _perfStart) / 1000).toFixed(1);
    hideAgentFeed();

    if (!finalData || finalData.error) {
      chat.messages.push({ role:'assistant', content:`⚠️ ${finalData?.message || 'Agent pipeline failed.'}`, error:true, timing:_timing });
      showToast('Manus Agent pipeline failed. Check Render logs.');
    } else {
      chat.messages.push({
        role:'assistant',
        content: finalData.reply,
        engine: finalData.engine,
        engineName: finalData.engineName,
        fallback: finalData.engine !== finalData.requestedEngine,
        requestedEngineName: finalData.requestedEngineName,
        timing: _timing,
        agentSubtasks: finalData.subtasks,
      });
    }
  } catch (err) {
    const _timing = ((performance.now() - _perfStart) / 1000).toFixed(1);
    hideAgentFeed();
    chat.messages.push({ role:'assistant', content:`⚠️ Agent network error: ${err?.message || 'request failed'}`, error:true, timing:_timing });
  }

  saveChats();
  renderMessages();
  document.getElementById('sendBtn').disabled = false;
}

/* Live execution feed — appended as a temporary row (same pattern as
   showTyping/hideTyping) while /agent streams its SSE events in. */
function showAgentFeed(){
  const inner = document.getElementById('chatInner');
  const row = document.createElement('div');
  row.className = 'msg-row ai';
  row.id = 'agentFeedRow';
  row.innerHTML = `
    <div class="avatar ai">N</div>
    <div class="bubble-col">
      <div class="manus-feed" id="manusFeed">
        <div class="manus-feed-header">
          <span class="manus-icon">🧬</span>
          <span class="manus-label">Manus Agent</span>
          <span class="manus-live-dot"></span>
        </div>
        <div class="manus-feed-body" id="manusFeedBody"></div>
      </div>
    </div>`;
  inner.appendChild(row);
  scrollChatToBottom(true);
}
function appendAgentLog(text, status, subtaskId){
  const body = document.getElementById('manusFeedBody');
  if (!body) return;
  if (subtaskId != null) {
    const existing = document.getElementById('manusLine-' + subtaskId);
    if (existing) {
      existing.className = 'manus-line ' + (status || 'info');
      existing.querySelector('.manus-line-text').textContent = text;
      scrollChatToBottom();
      return;
    }
  }
  const line = document.createElement('div');
  line.className = 'manus-line ' + (status || 'info');
  if (subtaskId != null) line.id = 'manusLine-' + subtaskId;
  line.innerHTML = `<span class="manus-badge"></span><span class="manus-line-text"></span>`;
  line.querySelector('.manus-line-text').textContent = text;
  body.appendChild(line);
  scrollChatToBottom();
}
function hideAgentFeed(){
  document.getElementById('agentFeedRow')?.remove();
}

/* Collapsible post-hoc breakdown summary, shown inside the final bubble
   for any agent-mode answer that actually decomposed into 2+ sub-tasks.
   Reuses the existing .bharat-steps-container / .bsc-* theme classes. */
function renderManusSummary(subtasks){
  if (!subtasks || subtasks.length < 2) return '';
  const id = 'mns' + Math.random().toString(36).slice(2, 8);
  const rows = subtasks.map(s => {
    const q = escapeHtml((s.question || '').slice(0, 90)) + (s.question && s.question.length > 90 ? '…' : '');
    const status = s.failed
      ? '<span style="color:var(--danger)">failed</span>'
      : escapeHtml(s.engineName || '') + (s.failedOver ? ' <span style="color:var(--accent2)">(failover)</span>' : '');
    return `<div class="bsc-step">Part ${s.id}: ${q} — ${status}</div>`;
  }).join('');
  return `<div class="bharat-steps-container">
  <div class="bsc-header" onclick="toggleAccordion('${id}')">
    <span class="bsc-icon">🧬</span>
    <span class="bsc-label">Manus Agent: ${subtasks.length} sub-tasks ›</span>
    <span class="bsc-chevron">›</span>
  </div>
  <div class="bsc-body" id="${id}">${rows}</div>
</div>`;
}
(function initFirebaseAuth(){
  const fbCfg = {
    apiKey: "AIzaSyALc807O77-KGEYOnjpiFinC5zzDBN0EUk",
    authDomain: "bharat-ai-chatbot-7a1fa.firebaseapp.com",
    projectId: "bharat-ai-chatbot-7a1fa",
    storageBucket: "bharat-ai-chatbot-7a1fa.firebasestorage.app",
    messagingSenderId: "732391672860",
    appId: "1:732391672860:web:c7a5f41559bab298a0e3d9",
    measurementId: "G-ZEPZYFMKL0"
  };
  firebase.initializeApp(fbCfg);
  const auth = firebase.auth();
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

  auth.onAuthStateChanged(function(user){
    const screen = document.getElementById('authScreen');
    if (user) {
      screen.style.display = 'none';
      currentUser = user;
      const name = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
      document.getElementById('sbUserAv').textContent = name.charAt(0).toUpperCase();
      document.getElementById('sbUserName').textContent = name;
      document.getElementById('sbUserEmail').textContent = user.email || '';
      loadChats();
      if (!chats.length) { newChat(); } else { activeChatId = chats[0].id; renderHistory(); renderMessages(); }
    } else {
      screen.style.display = 'flex';
      currentUser = null;
    }
  });

  window.switchAuthTab = function(tab){
    const isIn = tab === 'signin';
    document.getElementById('tabSignIn').classList.toggle('active', isIn);
    document.getElementById('tabSignUp').classList.toggle('active', !isIn);
    document.getElementById('formSignIn').style.display = isIn ? '' : 'none';
    document.getElementById('formSignUp').style.display = isIn ? 'none' : '';
    clearAuthErr('siErr'); clearAuthErr('suErr');
  };
  window.authTogglePw = function(id, btn){
    const inp = document.getElementById(id);
    const hidden = inp.type === 'password';
    inp.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? '🙈' : '👁';
  };
  function showAuthErr(id, msg){ const el=document.getElementById(id); el.textContent=msg; el.classList.add('on'); }
  function clearAuthErr(id){ document.getElementById(id).classList.remove('on'); }
  function setLoading(btnId, loading, label){
    const btn = document.getElementById(btnId);
    btn.disabled = loading;
    btn.innerHTML = loading ? '<span class="auth-spin"></span>Please wait…' : label;
  }
  function friendlyError(err){
    const map = {
      'auth/user-not-found':'No account found with this email.',
      'auth/wrong-password':'Incorrect password.',
      'auth/invalid-credential':'Incorrect email or password.',
      'auth/email-already-in-use':'An account with this email already exists.',
      'auth/weak-password':'Password should be at least 6 characters.',
      'auth/invalid-email':'Please enter a valid email address.',
      'auth/too-many-requests':'Too many attempts. Please try again later.',
    };
    return map[err.code] || err.message || 'Something went wrong. Please try again.';
  }

  window.handleSignIn = function(ev){
    ev.preventDefault();
    clearAuthErr('siErr');
    const email = document.getElementById('siEmail').value.trim();
    const pw = document.getElementById('siPw').value;
    setLoading('siSubmit', true, 'Sign In');
    auth.signInWithEmailAndPassword(email, pw)
      .catch(err => showAuthErr('siErr', friendlyError(err)))
      .finally(() => setLoading('siSubmit', false, 'Sign In'));
    return false;
  };
  window.handleSignUp = function(ev){
    ev.preventDefault();
    clearAuthErr('suErr');
    const name = document.getElementById('suName').value.trim();
    const email = document.getElementById('suEmail').value.trim();
    const pw = document.getElementById('suPw').value;
    setLoading('suSubmit', true, 'Create Account');
    auth.createUserWithEmailAndPassword(email, pw)
      .then(cred => cred.user.updateProfile({ displayName: name }))
      .catch(err => showAuthErr('suErr', friendlyError(err)))
      .finally(() => setLoading('suSubmit', false, 'Create Account'));
    return false;
  };
  window.doSignOut = function(){ auth.signOut(); };
})();

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */
updatePillUI();
renderEngineMenu();
document.getElementById('agentToggle')?.classList.toggle('on', agentModeOn);

/* ══════════════════════════════════════════
   PWA: INSTALL APP BUTTON
   ─────────────────────────────────────────
   The button is `display:none` by default in CSS.
   It is ONLY revealed when the browser actually fires
   `beforeinstallprompt` — which Chrome/Edge only fire
   when the PWA criteria are met AND it is not already
   installed. It disappears the instant install succeeds,
   and an extra `display-mode: standalone` check below
   guarantees it stays hidden if the app is relaunched
   from the home screen on a later visit.
══════════════════════════════════════════ */
let deferredInstallPrompt = null;

function isAppInstalled(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  if (isAppInstalled()) return; // safety net — never show if somehow already standalone
  deferredInstallPrompt = event;
  document.getElementById('installBtn')?.classList.add('show');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.getElementById('installBtn')?.classList.remove('show');
  showToast('App installed! You can now launch it from your home screen.');
});

window.installPWA = async function(){
  if (!deferredInstallPrompt) return;
  const btn = document.getElementById('installBtn');
  if (btn) btn.disabled = true;
  try {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      document.getElementById('installBtn')?.classList.remove('show');
    }
  } finally {
    deferredInstallPrompt = null;
    if (btn) btn.disabled = false;
  }
};

// Belt-and-suspenders: if this load IS the installed app running in
// standalone mode, force the button hidden regardless of anything else.
if (isAppInstalled()) {
  document.getElementById('installBtn')?.classList.remove('show');
}

/* ══════════════════════════════════════════
   PWA: SERVICE WORKER REGISTRATION + AUTO-UPDATE
   ─────────────────────────────────────────
   Goal: ship new frontend code to every open tab
   instantly, with zero manual refresh, WITHOUT ever
   touching localStorage/sessionStorage — so the
   Firebase auth session and chat history (both kept
   in localStorage, see CHAT STORAGE above) survive
   completely untouched across the reload. A SW update
   only replaces cached network assets; it never has
   access to — and never calls — localStorage.clear(),
   sessionStorage.clear(), or signOut().
══════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {

      // 1) A new SW version was found on the network — as soon as it
      //    finishes installing, tell it to activate immediately instead
      //    of waiting for all tabs to close.
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            newWorker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      // 2) Once the new worker actually takes control of this page,
      //    reload exactly once to pick up the fresh HTML/CSS/JS.
      //    The `refreshing` guard stops a possible reload loop.
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });

      // 3) Proactively re-check for a new version periodically, so a tab
      //    left open for hours still gets updated without the user
      //    having to close and reopen the app.
      setInterval(() => { reg.update(); }, 60 * 1000);

    }).catch(err => console.warn('SW registration failed:', err));
  });
}
