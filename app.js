// ==========================================
// 1. SUPABASE INITIALIZATION
// ==========================================
const supabaseUrl = 'https://vazzmblpmgaqkrlvwzxe.supabase.co'; 
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhenptYmxwbWdhcWtybHZ3enhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNDk1OTIsImV4cCI6MjA5MDYyNTU5Mn0.BpiU8OW1bWrktOJNbNmTOy4NuuR8W_rdmtKU2Uzdi4k'; 

const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

let currentUser = null;
let appInitialized = false;

let CFG = {
  url: '', key: '', model: '', 
  temp: 1.0, topp: 1.0, 
  system: 'You are a helpful assistant.', thinking: false
};

let chats = []; 
let currentChatId = null;
let turns = [];
let loading = false;
let filesLoadingCount = 0; 
let pendingAttachments = [];

// ==========================================
// ==========================================
// 2. AUTHENTICATION LOGIC
// ==========================================
async function handleLogin() {
  const btn = document.getElementById('btn-login');
  btn.textContent = 'Authenticating...'; btn.disabled = true;

  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  
  if (error) {
    document.getElementById('auth-error').textContent = error.message;
    btn.textContent = 'Login'; btn.disabled = false;
  } else {
    // Login successful
    currentUser = data.user;
    document.getElementById('auth-overlay').style.display = 'none';
    initAppData();
  }
}

// Check if user is already logged in when the page loads
window.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    currentUser = session.user;
    document.getElementById('auth-overlay').style.display = 'none';
    initAppData();
  }
});

async function handleSignup() {
  const btn = document.getElementById('btn-signup');
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  
  if (!email || !password) { document.getElementById('auth-error').textContent = "Please enter an email and password."; return; }

  btn.textContent = 'Signing up...'; btn.disabled = true;
  const { error } = await supabaseClient.auth.signUp({ email, password });
  
  if (error) { document.getElementById('auth-error').textContent = error.message; btn.textContent = 'Sign Up'; btn.disabled = false; } 
  else { document.getElementById('auth-error').textContent = "Success! Logging you in..."; btn.textContent = 'Sign Up'; btn.disabled = false; }
}

async function handleLogout() {
  // 1. Try to tell the server we are logging out. 
  // If the server session is expired/glitched, it will fail silently here instead of crashing your app.
  try {
    await supabaseClient.auth.signOut();
  } catch (error) {
    console.warn("Supabase signout error, forcing local logout:", error);
  }
  
  // 2. Save API key temporarily so user doesn't have to re-enter it
  const storedKey = localStorage.getItem('mengassist_key');
  
  // 3. Clear local storage to forcefully kill the session
  localStorage.clear();
  
  // 4. Restore just the API key
  if (storedKey) {
    localStorage.setItem('mengassist_key', storedKey);
  }
  
  // 5. Reload the page to show the login screen
  window.location.reload();
}

// Mobile Enter Logic 
document.getElementById('user-input').addEventListener('keydown', e => {
  const isMobile = window.innerWidth <= 768 || navigator.maxTouchPoints > 0;
  if (e.key === 'Enter' && !e.shiftKey) { 
    if (isMobile) return; 
    e.preventDefault(); 
    sendMessage(); 
  }
});

// ==========================================
// 3. SECURE DATA SYNCING
// ==========================================
function saveLocalChats() {
  try { localStorage.setItem('mengassist_chats', JSON.stringify(chats)); } catch(e){}
}

async function initAppData() {
  // 1. Load Local CFG
  const storedKey = localStorage.getItem('mengassist_key');
  if (storedKey) CFG.key = storedKey;

  const storedCfg = localStorage.getItem('mengassist_cfg');
  if (storedCfg) { try { Object.assign(CFG, JSON.parse(storedCfg)); } catch(e){} }

  // 2. Load Local Chats
  const storedChats = localStorage.getItem('mengassist_chats');
  if (storedChats) { try { chats = JSON.parse(storedChats); } catch(e){} }

  // 3. Update UI for Config
  document.getElementById('cfg-url').value = CFG.url || '';
  document.getElementById('cfg-key').value = CFG.key || '';
  document.getElementById('cfg-model').value = CFG.model || '';
  document.getElementById('cfg-thinking').checked = CFG.thinking || false;

  // 4. Fetch Remote Config (Supabase)
  try {
    const { data: settingsData } = await supabaseClient.from('settings').select('config').eq('user_id', currentUser.id).single();
    if (settingsData && settingsData.config) {
      Object.assign(CFG, settingsData.config);
      localStorage.setItem('mengassist_cfg', JSON.stringify(settingsData.config)); 
      document.getElementById('cfg-url').value = CFG.url || '';
      document.getElementById('cfg-model').value = CFG.model || '';
      document.getElementById('cfg-thinking').checked = CFG.thinking || false;
    }
  } catch (err) {
    console.log("No remote config found or error fetching:", err.message);
  }
  
  // 5. Fetch Remote Chats (Supabase)
  let chatToLoad = null;
  if (chats.length > 0) chatToLoad = chats[0].id;

  try {
    const { data: chatsData } = await supabaseClient.from('chats').select('*').order('updated_at', { ascending: false });
    if (chatsData && chatsData.length > 0) { 
      chats = chatsData; 
      saveLocalChats();
      chatToLoad = chats[0].id;
    }
  } catch (err) {
    console.log("No remote chats found or error fetching:", err.message);
  }

  // 6. Load appropriate chat only once to avoid race conditions
  if (chatToLoad) {
    loadChat(chatToLoad, true);
  } else {
    startNewChat(true);
  }

  if (!CFG.url || !CFG.key || !CFG.model) toggleConfig();
}

async function syncSettingsToDB() {
  const safeConfig = { ...CFG }; delete safeConfig.key;
  localStorage.setItem('mengassist_cfg', JSON.stringify(safeConfig));
  if (!currentUser) return;
  try { await supabaseClient.from('settings').upsert({ user_id: currentUser.id, config: safeConfig }); } catch(err) {
    console.error("Failed to sync settings:", err);
  }
}

async function saveState() {
  if (turns.length === 0) return;

  const cleanTurns = turns.map(t => {
    const copy = {...t};
    delete copy._typing; delete copy._loading; delete copy._editing;
    return copy;
  });
  
  if (!currentChatId) {
    currentChatId = Date.now().toString();
    let textTitle = cleanTurns[0].content || "Image Upload";
    const title = textTitle.substring(0, 30) + (textTitle.length > 30 ? '...' : '');
    chats.unshift({ id: currentChatId, title, turns: [] });
  }
  
  const chatIndex = chats.findIndex(c => c.id === currentChatId);
  if (chatIndex > -1) { 
    chats[chatIndex].turns = cleanTurns; 
    saveLocalChats(); 
    if (currentUser) {
      try {
        const { error } = await supabaseClient.from('chats').upsert({
          id: currentChatId, user_id: currentUser.id, title: chats[chatIndex].title,
          turns: cleanTurns, updated_at: new Date().toISOString()
        });
        if (error) throw error;
      } catch (e) {
        console.error("Cloud sync error:", e);
        toast("Failed to sync chat to cloud", "err");
      }
    }
  }
  renderSidebar();
}

// ─── Attachments ──────────────────────────────────────────
async function handleFiles(event) {
  const files = event.target.files;
  const MAX_SIZE = 5 * 1024 * 1024; // 5MB limit
  
  for(let file of files) {
    // Prevent huge files from crashing the browser
    if (file.size > MAX_SIZE) {
      toast(`File ${file.name} is too large (max 5MB)`, 'err');
      continue;
    }
    
    filesLoadingCount++; document.getElementById('send-btn').disabled = true; renderAttachments(); 
    try {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => { pendingAttachments.push({ type: 'image', name: file.name, data: e.target.result }); finishFileLoad(); };
        reader.onerror = () => finishFileLoad();
        reader.readAsDataURL(file);
      } else {
        const text = await file.text();
        pendingAttachments.push({ type: 'text', name: file.name, data: text });
        finishFileLoad();
      }
    } catch(err) { finishFileLoad(); }
  }
  event.target.value = ''; 
}

function finishFileLoad() {
  filesLoadingCount--;
  if (filesLoadingCount <= 0) { filesLoadingCount = 0; document.getElementById('send-btn').disabled = false; }
  renderAttachments();
}

function renderAttachments() {
  const container = document.getElementById('attachments-preview'); container.innerHTML = '';
  pendingAttachments.forEach((att, idx) => {
    const chip = el('div', 'attach-chip');
    if (att.type === 'image') chip.innerHTML = `<img src="${att.data}"> ${att.name}`; else chip.innerHTML = `📄 ${att.name}`;
    const btn = el('button'); btn.textContent = '×'; btn.onclick = () => { pendingAttachments.splice(idx, 1); renderAttachments(); };
    chip.appendChild(btn); container.appendChild(chip);
  });
  if (filesLoadingCount > 0) { const loadChip = el('div', 'attach-chip'); loadChip.textContent = '⏳ Loading file...'; container.appendChild(loadChip); }
}

// ─── Settings & Presets ────────────────────────────
function applyPreset() { const val = document.getElementById('cfg-preset').value; if (val) document.getElementById('cfg-url').value = val; }

async function connectAPI() {
  const urlBase = document.getElementById('cfg-url').value.trim(), apiKey = document.getElementById('cfg-key').value.trim();
  const btn = document.getElementById('btn-connect');
  if (!urlBase) return toast('Please enter a Base URL', 'err');
  btn.textContent = '...'; btn.disabled = true;
  let modelsUrl = urlBase;
  if (modelsUrl.endsWith('/chat/completions')) modelsUrl = modelsUrl.replace('/chat/completions', '/models');
  else if (!modelsUrl.endsWith('/models')) modelsUrl = modelsUrl.replace(/\/$/, '') + '/models';

  try {
    const res = await fetch(modelsUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error('Invalid Key or CORS Error');
    const data = await res.json();
    if (data.data && Array.isArray(data.data)) {
      const sel = document.createElement('select'); sel.id = 'cfg-model';
      data.data.forEach(m => { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.id; if (m.id === CFG.model) opt.selected = true; sel.appendChild(opt); });
      document.getElementById('model-container').innerHTML = ''; document.getElementById('model-container').appendChild(sel);
      toast('Connected! Models loaded.', 'ok');
    } else throw new Error('Unrecognized response format');
  } catch(err) {
    toast(err.message, 'err');
    const inp = document.createElement('input'); inp.type = 'text'; inp.id = 'cfg-model'; inp.value = CFG.model;
    document.getElementById('model-container').innerHTML = ''; document.getElementById('model-container').appendChild(inp);
  }
  btn.textContent = 'Connect'; btn.disabled = false;
}

// ─── Modals & Confirm Logic ───────────────────────────────
let confirmCallback = null;
function openConfirm(msg, onConfirm) {
  document.getElementById('modal-container').classList.add('open');
  document.querySelectorAll('.modal-box').forEach(el => el.style.display = 'none');
  document.getElementById('modal-confirm').style.display = 'flex';
  document.getElementById('confirm-msg').textContent = msg;
  confirmCallback = onConfirm;
}
function execConfirm() { if (confirmCallback) confirmCallback(); closeModal(); }

// ─── Custom System Prompt Presets ──────────────────────────

// 1. Ensure presets exist in the config
function initPresets() {
  if (!CFG.systemPresets || !CFG.systemPresets.length) {
    // Migrate existing prompt into slot 1
    CFG.systemPresets = [{ title: 'Preset 1', content: CFG.system || 'You are a helpful assistant.' }];
    CFG.activePresetIdx = 0;
  }
}

// 2. Render the dropdown options
function renderPresets() {
  initPresets();
  const sel = document.getElementById('sys-preset');
  sel.innerHTML = '';
  
  CFG.systemPresets.forEach((p, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = p.title;
    if (idx === CFG.activePresetIdx) opt.selected = true;
    sel.appendChild(opt);
  });
  
  document.getElementById('temp-system').value = CFG.systemPresets[CFG.activePresetIdx].content;
}

// 3. Handle dropdown change
function applySystemPreset() {
  CFG.activePresetIdx = parseInt(document.getElementById('sys-preset').value);
  document.getElementById('temp-system').value = CFG.systemPresets[CFG.activePresetIdx].content;
}

// 4. Create a new blank preset slot
function addSystemPreset() {
  initPresets();
  const newIdx = CFG.systemPresets.length;
  CFG.systemPresets.push({ title: 'Preset ' + (newIdx + 1), content: '' });
  CFG.activePresetIdx = newIdx;
  
  renderPresets();
  syncSettingsToDB(); // Sync the new slot to cloud
}

// 6. Delete the currently selected preset slot
function removeSystemPreset() {
  initPresets();
// ─── Fixed 5-Slot System Presets ──────────────────────────

function initPresets() {
  // If presets don't exist yet, create exactly 5 slots. Put current prompt in slot 1.
  if (!CFG.systemPresets || CFG.systemPresets.length !== 5) {
    CFG.systemPresets = [
      CFG.system || 'You are a helpful assistant.', 
      '', '', '', ''
    ];
    CFG.activePresetIdx = 0;
  }
}

function applySystemPreset() {
  const idx = parseInt(document.getElementById('sys-preset').value);
  document.getElementById('temp-system').value = CFG.systemPresets[idx];
}

function saveSystem() {
  initPresets();
  const idx = parseInt(document.getElementById('sys-preset').value);
  const text = document.getElementById('temp-system').value.trim();
  
  CFG.systemPresets[idx] = text; // Save text to the chosen slot
  CFG.activePresetIdx = idx;     // Remember this is our active slot
  CFG.system = text;             // Tell the app to actually use this prompt
  
  syncSettingsToDB();            // Sync to cloud
  closeModal(); 
  toast('System Prompt Saved & Applied ✓', 'ok'); 
}

// ─── Modals & Confirm Logic ───────────────────────────────
function openModal(id) {
  document.getElementById('modal-container').classList.add('open');
  document.querySelectorAll('.modal-box').forEach(el => el.style.display = 'none'); 
  document.getElementById(id).style.display = 'flex';
  
  if (id === 'modal-sys') {
    initPresets();
    // Set the dropdown to the active slot, and load its text
    document.getElementById('sys-preset').value = CFG.activePresetIdx;
    document.getElementById('temp-system').value = CFG.systemPresets[CFG.activePresetIdx];
  }
  else if (id === 'modal-param') { 
    document.getElementById('temp-temp').value = CFG.temp; 
    document.getElementById('val-temp').textContent = CFG.temp.toFixed(1); 
    document.getElementById('temp-topp').value = CFG.topp; 
    document.getElementById('val-topp').textContent = CFG.topp.toFixed(2); 
  }
}

function closeModal() { document.getElementById('modal-container').classList.remove('open'); }
function saveSystem() { CFG.system = document.getElementById('temp-system').value.trim(); syncSettingsToDB(); closeModal(); toast('System Prompt Saved ✓', 'ok'); }
function saveParams() { CFG.temp = parseFloat(document.getElementById('temp-temp').value); CFG.topp = parseFloat(document.getElementById('temp-topp').value); syncSettingsToDB(); closeModal(); toast('Settings Saved ✓', 'ok'); }

function toggleSidebar(force) {
  const sb = document.getElementById('sidebar'), ov = document.getElementById('sidebar-overlay');
  const isOpen = force !== undefined ? force : !sb.classList.contains('open');
  if (isOpen) { sb.classList.add('open'); ov.classList.add('open'); renderSidebar(); } else { sb.classList.remove('open'); ov.classList.remove('open'); }
}

function renderSidebar() {
  const list = document.getElementById('chat-list'); list.innerHTML = '';
  chats.forEach(c => {
    const div = el('div', 'history-item' + (c.id === currentChatId ? ' active' : ''));
    div.onclick = () => loadChat(c.id); div.innerHTML = `<span>${esc(c.title || 'New Chat')}</span>`;
    const delBtn = el('button', 'del-chat'); delBtn.innerHTML = '✕'; delBtn.onclick = (e) => delChat(e, c.id);
    div.appendChild(delBtn); list.appendChild(div);
  });
}

function toggleConfig() { document.getElementById('config').classList.toggle('open'); document.getElementById('cfg-toggle').classList.toggle('active'); }

function saveConfig() {
  CFG.url = document.getElementById('cfg-url').value.trim(); 
  const newKey = document.getElementById('cfg-key').value.trim(); 
  if (newKey) { CFG.key = newKey; localStorage.setItem('mengassist_key', newKey); }
  CFG.model = document.getElementById('cfg-model').value.trim(); 
  CFG.thinking = document.getElementById('cfg-thinking').checked;
  syncSettingsToDB(); toggleConfig(); toast('Config saved locally & securely ✓', 'ok');
}

// ─── Data Management ──────────────────────────────────────
function startNewChat(keepSidebarOpen = false) { 
  currentChatId = null; turns = []; renderAll(); renderSidebar(); 
  if (!keepSidebarOpen) toggleSidebar(false); 
}

function loadChat(id, keepSidebarOpen = false) {
  const chat = chats.find(c => c.id === id);
  if (chat) { 
    currentChatId = id; 
    turns = chat.turns.map(t => ({...t, _editing: false, _typing: false, _loading: false})); 
    renderAll(); renderSidebar(); 
    if (!keepSidebarOpen) toggleSidebar(false); 
  }
}

function delChat(e, id) { 
  e.stopPropagation(); 
  openConfirm('Are you sure you want to permanently delete this chat history?', async () => {
    chats = chats.filter(c => c.id !== id); 
    saveLocalChats();
    try { if (currentUser) await supabaseClient.from('chats').delete().eq('id', id); } catch(err){}
    
    if (currentChatId === id) {
      if (chats.length > 0) loadChat(chats[0].id, true); else startNewChat(true);
    } else {
      renderSidebar(); 
    }
  });
}

function clearCurrentChat() { 
  openConfirm('Are you sure you want to clear all messages in this chat?', async () => {
    turns = []; 
    const chatIndex = chats.findIndex(c => c.id === currentChatId);
    if (chatIndex > -1) {
      chats[chatIndex].turns = [];
      saveLocalChats();
      try { 
        if (currentUser) {
          const { error } = await supabaseClient.from('chats').update({ turns: [] }).eq('id', currentChatId); 
          if (error) throw error;
        }
      } catch(err) {
        console.error("Failed to clear cloud chat:", err);
        toast("Failed to clear chat in cloud", "err");
      }
    }
    document.getElementById('config').classList.remove('open'); 
    document.getElementById('cfg-toggle').classList.remove('active');
    renderAll();
  });
}

// ─── Messaging & API Payload ──────────────────────────────
function buildMessages(upToTurnIdx = null) {
  const list = [{ role: 'system', content: CFG.system }];
  const end = upToTurnIdx !== null ? upToTurnIdx : turns.length;
  for (let i = 0; i < end; i++) {
    const t = turns[i];
    if (t.role === 'user') {
      let promptText = t.content || '';
      
      if (t.files && t.files.length > 0) {
        t.files.forEach(f => { promptText += `\n\n--- File: ${f.name} ---\n${f.data}`; });
      }

      if (t.images && t.images.length > 0) {
        let contentArr = [];
        if (promptText.trim() !== "") { contentArr.push({ type: 'text', text: promptText.trim() }); }
        t.images.forEach(img => contentArr.push({ type: 'image_url', image_url: { url: img } }));
        list.push({ role: 'user', content: contentArr });
      } else { 
        list.push({ role: 'user', content: promptText.trim() }); 
      }
    } else { 
      list.push({ role: 'assistant', content: t.versions[t.idx] }); 
    }
  }
  return list;
}

async function sendMessage() {
  const inp = document.getElementById('user-input'); 
  let text = inp.value.trim();
  
  const textFiles = pendingAttachments.filter(a => a.type === 'text');
  const images = pendingAttachments.filter(a => a.type === 'image').map(a => a.data);
  
  if (!text && images.length === 0 && textFiles.length === 0) return;
  if (loading || filesLoadingCount > 0) return;
  if (!CFG.url || !CFG.key || !CFG.model) { toggleConfig(); toast('Fill in config first', 'err'); return; }
  
  turns.push({ 
    role: 'user', 
    content: text, 
    images: images.length > 0 ? images : null,
    files: textFiles.length > 0 ? textFiles : null 
  }); 
  
  inp.value = ''; autoResize(inp); 
  pendingAttachments = []; renderAttachments(); renderAll(); saveState();
  
  await callAPI(false, null);
}

// ─── Core API call ────────────────────────────────────────
async function callAPI(isRegen, regenIdx) {
  loading = true; document.getElementById('send-btn').disabled = true;
  const msgUpTo = isRegen ? regenIdx : null; const messages = buildMessages(msgUpTo);
  if (isRegen) turns[regenIdx]._loading = true; else turns.push({ role: 'ai', _typing: true });
  renderAll();

  let content = '', thinking = '';
  try {
    const res = await fetch(CFG.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CFG.key}` },
      body: JSON.stringify({ model: CFG.model, messages, temperature: CFG.temp, top_p: CFG.topp })
    });
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error?.message || `HTTP ${res.status}`);
    const data = await res.json();
    content  = data.choices?.[0]?.message?.content || '';
    thinking = data.choices?.[0]?.message?.reasoning_content || '';
    const tm = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
    if (tm) { thinking = tm[1].trim(); content = content.slice(tm[0].length).trim(); }
  } catch (err) {
    toast('Error: ' + err.message, 'err');
    if (isRegen) delete turns[regenIdx]._loading; else { turns = turns.filter(t => !t._typing); if (turns.length && turns[turns.length-1].role === 'user') turns.pop(); }
    loading = false; document.getElementById('send-btn').disabled = false; saveState(); renderAll(); return;
  }

  if (isRegen) { delete turns[regenIdx]._loading; turns[regenIdx].versions.push(content); turns[regenIdx].thinkVersions.push(thinking); turns[regenIdx].idx = turns[regenIdx].versions.length - 1; }
  else { turns = turns.filter(t => !t._typing); turns.push({ role: 'ai', versions: [content], thinkVersions: [thinking], idx: 0 }); }
  loading = false; document.getElementById('send-btn').disabled = false; saveState(); renderAll();
}

// ─── Edit & Paging ────────────────────────────────────────
function startEdit(idx) { turns[idx]._editing = true; renderAll(true); }
function cancelEdit(idx) { turns[idx]._editing = false; renderAll(true); }

async function submitEdit(idx, newText) { 
  const oldTurn = turns[idx];
  if (!newText.trim() && !(oldTurn.images && oldTurn.images.length) && !(oldTurn.files && oldTurn.files.length)) return cancelEdit(idx); 
  turns = turns.slice(0, idx); 
  turns.push({ role: 'user', content: newText.trim(), images: oldTurn.images, files: oldTurn.files }); 
  saveState(); renderAll(); await callAPI(false, null); 
}

function prevVersion(idx) { const t = turns[idx]; if (!t || t.role !== 'ai') return; if (t.idx > 0) { t.idx--; saveState(); renderAll(true); } }
function nextVersion(idx) { const t = turns[idx]; if (!t || t.role !== 'ai') return; if (t.idx < t.versions.length - 1) { t.idx++; saveState(); renderAll(true); } }
async function regenMessage(idx) { const lastAiIdx = turns.findLastIndex(x => x.role === 'ai'); if (idx !== lastAiIdx) { toast('Can only regenerate last message', 'err'); return; } if (loading) return; await callAPI(true, idx); }

// ─── UI Rendering ─────────────────────────────────────────
function renderAll(skipScroll = false) {
  const box = document.getElementById('chat-box'); 
  const prevScroll = box.scrollTop; 
  
  box.innerHTML = '';
  if (turns.length === 0) { box.innerHTML = `<div class="empty"><div class="empty-glyph">◈</div><p>Configure your API above,<br>then start chatting.</p></div>`; return; }
  
  turns.forEach((t, i) => box.appendChild(t.role === 'user' ? makeUserMsg(t, i) : makeAiMsg(t, i)));
  
  if (!skipScroll) scrollBottom();
  else box.scrollTop = prevScroll; 
}

function makeUserMsg(t, i) {
  const row = el('div', 'msg user'), av = el('div', 'avatar'); av.textContent = '✦'; const body = el('div', 'msg-body');
  
  if (t._editing) {
    const wrap = el('div', 'edit-wrap'), ta = el('textarea'); ta.value = t.content || '';
    const actions = el('div', 'edit-actions');
    const cancelBtn = el('button'); cancelBtn.textContent = 'Cancel'; cancelBtn.onclick = () => cancelEdit(i);
    const saveBtn = el('button', 'btn-save-edit'); saveBtn.textContent = 'Save & Submit'; saveBtn.onclick = () => submitEdit(i, ta.value);
    actions.append(cancelBtn, saveBtn); wrap.append(ta, actions); body.appendChild(wrap);
  } else {
    if (t.images && t.images.length > 0) {
      const imgWrap = el('div', 'msg-images');
      t.images.forEach(src => { const img = el('img'); img.src = src; imgWrap.appendChild(img); });
      body.appendChild(imgWrap);
    }
    
    if (t.files && t.files.length > 0) {
      const fileWrap = el('div', 'msg-images'); 
      t.files.forEach(f => { 
        const chip = el('div', 'attach-chip'); 
        chip.style.color = 'var(--text)';
        chip.innerHTML = `📄 ${f.name}`; 
        fileWrap.appendChild(chip); 
      });
      body.appendChild(fileWrap);
    }

    if (t.content) {
      const bubble = el('div', 'bubble'); bubble.innerHTML = fmt(t.content);
      body.appendChild(bubble);
    }
    
    const controls = el('div', 'msg-controls');
    const editBtn = el('button', 'ctrl-btn'); editBtn.textContent = '✎ edit'; editBtn.onclick = () => startEdit(i);
    controls.append(editBtn);
    if (t.content) controls.append(mkCopy(t.content)); 
    body.appendChild(controls);
  }
  row.append(body, av); return row;
}

function makeAiMsg(t, i) {
  const row = el('div', 'msg ai'), av = el('div', 'avatar'); av.textContent = '◈'; const body = el('div', 'msg-body'); const bubble = el('div', 'bubble');
  if (t._typing || t._loading) { bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>'; body.append(bubble); row.append(av, body); return row; }

  const content = t.versions[t.idx], thinking = t.thinkVersions[t.idx], total = t.versions.length;
  if (CFG.thinking && thinking) {
    const wrap = el('div', 'thinking-wrap');
    wrap.innerHTML = `<details class="think"><summary>Reasoning</summary><div class="think-body">${esc(thinking)}</div></details>`;
    bubble.appendChild(wrap);
  }
  const txt = el('span', ''); txt.innerHTML = fmt(content); bubble.appendChild(txt);

  const controls = el('div', 'msg-controls');
  if (total > 1) {
    const pager = el('div', 'ver-pager');
    const btnPrev = el('button', 'ctrl-btn'); btnPrev.textContent = '❮'; if (t.idx === 0) btnPrev.disabled = true; btnPrev.onclick = () => prevVersion(i);
    const badge = el('span', 'ver-badge'); badge.innerHTML = `<b>${t.idx + 1}</b>/${total}`;
    const btnNext = el('button', 'ctrl-btn'); btnNext.textContent = '❯'; if (t.idx === total - 1) btnNext.disabled = true; btnNext.onclick = () => nextVersion(i);
    pager.append(btnPrev, badge, btnNext); controls.appendChild(pager);
  }
  const isLastAi = (i === turns.findLastIndex(x => x.role === 'ai'));
  if (isLastAi) { const regenBtn = el('button', 'ctrl-btn'); regenBtn.textContent = '↻ regen'; regenBtn.onclick = () => regenMessage(i); controls.appendChild(regenBtn); }
  controls.appendChild(mkCopy(content)); body.append(bubble, controls); row.append(av, body); return row;
}

// ─── Formatting & Utilities (FIXED PARSER) ────────────────
async function executeCopy(text, btnNode) {
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); ok = true; } catch(e){} }
  if (!ok) { const ta = el('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;'; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch(e){} document.body.removeChild(ta); }
  if (ok && btnNode) { const oldText = btnNode.textContent; btnNode.textContent = '✓ copied'; btnNode.classList.add('ok'); setTimeout(() => { btnNode.textContent = oldText; btnNode.classList.remove('ok'); }, 1800); } else if (!ok) { toast('Copy failed', 'err'); }
}
function mkCopy(text) { const btn = el('button', 'ctrl-btn'); btn.textContent = '⎘ copy'; btn.onclick = () => executeCopy(text, btn); return btn; }
window.copyCode = function(btn) { executeCopy(btn.closest('.code-block').querySelector('pre').textContent, btn); };
window.toggleCode = function(btn) { const block = btn.closest('.code-block'); block.classList.toggle('collapsed'); btn.textContent = block.classList.contains('collapsed') ? '▶ expand' : '▼ collapse'; };

function el(t, c) { const e = document.createElement(t); if(c) e.className = c; return e; }
function esc(s) { return (s || "").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function buildCodeBlock(lang, code) {
  return `<div class="code-block"><div class="code-header"><span class="code-lang">${lang || 'code'}</span><div class="code-actions"><button class="code-btn code-copy" onclick="copyCode(this)">⎘ copy</button><button class="code-btn code-collapse" onclick="toggleCode(this)">▼ collapse</button></div></div><pre><code>${code.trim()}</code></pre></div>`;
}

function fmt(t) {
  t = esc(t);
  let hasCode = false;
  
  // FIXED: Using RegExp here stops the literal backticks from breaking your UI parser!
  const blockRegex = new RegExp('`{3}(\\w*)\\n?([\\s\\S]*?)`{3}', 'g');
  t = t.replace(blockRegex, (_, lang, code) => { hasCode = true; return buildCodeBlock(lang, code); });
  
  if (!hasCode) { const tr = t.trim(); if (tr.startsWith('&lt;!DOCTYPE') || tr.startsWith('&lt;html') || tr.startsWith('&lt;?php')) return buildCodeBlock('html/raw', tr); }
  
  t = t.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  t = t.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  t = t.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
  t = t.replace(/^\s*[-*] (.*)/gim, '<li>$1</li>');
  
  // FIXED: Inline code fixed with RegExp too
  const inlineRegex = new RegExp('`([^`\\n]+)`', 'g');
  t = t.replace(inlineRegex, '<code>$1</code>');
  
  return t;
}

function scrollBottom() { const b = document.getElementById('chat-box'); requestAnimationFrame(() => b.scrollTop = b.scrollHeight); }
function autoResize(e) { e.style.height = 'auto'; e.style.height = Math.min(e.scrollHeight, 130) + 'px'; }
let toastTimer; function toast(msg, type = '') { const t = document.getElementById('toast'); t.textContent = msg; t.className = 'show' + (type ? ' ' + type : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = '', 2800); }
