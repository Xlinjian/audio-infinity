/*
 * Audio无限+ - Popup 交互逻辑（1.0 版，不含实时字幕）
 * 主界面：音频增强卡片 + 全局音量增强卡片；
 * 设置页：外观 / 功能模块；高级均衡器（EQ）内联。
 */
const $ = (id) => document.getElementById(id);
const els = {
  mainView: $('mainView'),
  settingsPanel: $('settingsPanel'),
  eqPanel: $('eqPanel'),
  eqMount: $('eqMount'),
  tabPill: $('tabPill'),
  // 顶部按钮
  openEQ: $('openEQ'),
  openSettings: $('openSettings'),
  // 主视图：音频增强
  enhanceCard: $('enhanceCard'),
  enhanceToggle: $('enhanceToggle'),
  enhanceState: $('enhanceState'),
  enhanceBody: $('enhanceBody'),
  presets: $('presets'),
  clarity: $('clarity'),
  clarityVal: $('clarityVal'),
  width: $('width'),
  widthVal: $('widthVal'),
  masterGain: $('masterGain'),
  gainVal: $('gainVal'),
  mediaCount: $('mediaCount'),
  engineState: $('engineState'),
  // 主视图：全局音量
  boostCard: $('boostCard'),
  boostToggle: $('boostToggle'),
  boostState: $('boostState'),
  boostGain: $('boostGain'),
  boostVal: $('boostVal'),
  // 主视图：本地播放器入口
  openLocal: $('openLocal'),
  // 设置视图：外观
  settingsDone: $('settingsDone'),
  sThemeSeg: $('s_themeSeg'),
  sSwatches: $('s_swatches'),
  sAccentInput: $('s_accentInput'),
  // 设置视图：功能模块（由 data-mod 动态处理）
  resetBtn: $('resetBtn'),
  // 高级 EQ
  eqDone: $('eqDone'),
  // 错误提示
  errorOverlay: $('errorOverlay'),
  errorText: $('errorText'),
  body: document.body
};

const ENHANCED = /bilibili\.com|cctalk\.com|pan\.baidu\.com|file:\/\//;

let current = { enabled: false, preset: 'balanced', masterGain: 1.0, clarity: 50, width: 100 };
let boost = { enabled: false, gain: 1.5 };
let tabId = null;
let isEnhancedPage = false;
let view = 'main';
const injectedTabs = new Set();

// ============ 工具 ============
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return '本地文件'; }
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function stateKey() { return 'babState_' + (tabId == null ? 'global' : tabId); }
function boostKey() { return 'babBoost_' + (tabId == null ? 'global' : tabId); }
function setFill(el) {
  const min = +el.min, max = +el.max, v = +el.value;
  const pct = ((v - min) / (max - min)) * 100;
  el.style.setProperty('--fill', pct + '%');
}
function showError(err) {
  try {
    console.error('[Audio无限+ popup] init error:', err);
    if (els.errorOverlay && els.errorText) {
      els.errorText.textContent = (err && (err.stack || err.message || String(err))) || '未知错误';
      els.errorOverlay.classList.add('visible');
    }
  } catch (e) {}
}
function clarityLabel(v) {
  if (v < 25) return '暖';
  if (v < 45) return '偏暖';
  if (v <= 55) return '标准';
  if (v <= 72) return '清亮';
  return '极清亮';
}
function setSegActive(root, value, attr = 'data') {
  if (!root) return;
  root.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute(attr) === value);
  });
}

// ============ 跨帧消息 ============
async function framesOf(id) {
  let frames = [{ frameId: 0 }];
  try { const all = await chrome.webNavigation.getAllFrames({ tabId: id }); if (all && all.length) frames = all; } catch (e) {}
  return frames;
}
async function broadcast(id, msg) {
  const frames = await framesOf(id);
  return Promise.all(frames.map((f) => new Promise((res) => {
    chrome.tabs.sendMessage(id, msg, { frameId: f.frameId }, (r) => res(chrome.runtime.lastError ? null : r));
  })));
}
function aggregate(responses) {
  let videoCount = 0, state = null, contextState = 'none';
  responses.forEach((r) => {
    if (!r || r.error) return;
    if (typeof r.videoCount === 'number') videoCount += r.videoCount;
    if (r.state && !state) state = r.state;
    if (r.contextState) contextState = r.contextState;
  });
  return { videoCount, state, contextState };
}
async function send(msg) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return null;
  if (!ENHANCED.test(tab.url || '')) return { notSupported: true };
  const responses = await broadcast(tab.id, msg);
  return aggregate(responses);
}

// ============ 音频增强（站内页） ============
function renderEnhance() {
  els.enhanceToggle.checked = current.enabled;
  els.enhanceState.textContent = current.enabled ? '已开启' : '已关闭';
  els.enhanceState.className = 'switch-state' + (current.enabled ? ' on' : '');
  els.enhanceBody.classList.toggle('disabled', !current.enabled);

  els.clarity.value = current.clarity; els.clarityVal.textContent = clarityLabel(current.clarity); setFill(els.clarity);
  els.width.value = current.width; els.widthVal.textContent = current.width > 100 ? current.width + '%' : '关'; setFill(els.width);
  const pct = Math.round(current.masterGain * 100);
  els.masterGain.value = pct; els.gainVal.textContent = pct + '%'; setFill(els.masterGain);
  els.presets.querySelectorAll('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === current.preset));
  els.mediaCount.textContent = current.mediaCount || 0;
  const running = current.enabled && (current.contextState === 'running' || current.contextState === 'suspended');
  els.engineState.textContent = current.enabled ? '运行中' : '未运行';
  els.engineState.className = current.enabled ? 'on' : '';
}
async function toggleEnhance() {
  const res = await send({ type: 'BAB_TOGGLE' });
  if (res && res.state) current = { ...current, ...res.state };
  renderEnhance();
}

// ============ 全局音量增强（任意网页） ============
async function broadcastBoost(id, enabled) {
  let frames = [{ frameId: 0 }];
  try { const all = await chrome.webNavigation.getAllFrames({ tabId: id }); if (all && all.length) frames = all; } catch (e) {}
  await Promise.all(frames.map((f) => new Promise((resolve) => {
    chrome.tabs.sendMessage(id, { type: 'BAB_BOOST_SET', enabled, gain: boost.gain }, { frameId: f.frameId }, () => resolve());
  })));
}
async function applyBoost() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;
  if (!boost.enabled) { if (injectedTabs.has(tab.id)) broadcastBoost(tab.id, false); renderBoost(); return; }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['audio-engine.js', 'content/booster-inject.js'], world: 'ISOLATED' });
    injectedTabs.add(tab.id);
  } catch (e) { els.boostState.textContent = '注入失败'; return; }
  await broadcastBoost(tab.id, true);
  renderBoost();
}
function renderBoost() {
  els.boostToggle.checked = boost.enabled;
  els.boostState.textContent = boost.enabled ? '已开启' : '已关闭';
  els.boostState.className = 'switch-state' + (boost.enabled ? ' on' : '');
  const pct = Math.round(boost.gain * 100);
  els.boostGain.value = pct; els.boostVal.textContent = pct + '%'; setFill(els.boostGain);
}

// ============ 设置（外观 / 模块） ============
const PRESET_ACCENTS = ['#6C5CE7', '#00A1D6', '#FB7299', '#1ABC9C', '#FF7B00', '#E74C3C'];
const SETTINGS_DEFAULTS = {
  theme: 'dark', accent: '#6C5CE7',
  modules: { vocal: true, denoise: true, compress: true, deesser: true, air: true, surround: false }
};
let settings = { ...SETTINGS_DEFAULTS, modules: { ...SETTINGS_DEFAULTS.modules } };

function lightenColor(hex, ratio) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c) => Math.round(c * (1 - ratio) + 255 * ratio);
  const hh = (c) => c.toString(16).padStart(2, '0');
  return '#' + hh(mix(r)) + hh(mix(g)) + hh(mix(b));
}
function darkenColor(hex, ratio) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c) => Math.round(c * (1 - ratio));
  const hh = (c) => c.toString(16).padStart(2, '0');
  return '#' + hh(mix(r)) + hh(mix(g)) + hh(mix(b));
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', settings.theme);
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--accent-light', lightenColor(settings.accent, 0.35));
  document.documentElement.style.setProperty('--accent-dark', darkenColor(settings.accent, 0.25));
}
function renderSettings() {
  els.sThemeSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === settings.theme));
  els.sSwatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color.toLowerCase() === settings.accent.toLowerCase()));
  els.sAccentInput.value = settings.accent;
  document.querySelectorAll('#settingsPanel .toggle-row[data-mod]').forEach((row) => {
    row.querySelector('input').checked = !!settings.modules[row.dataset.mod];
  });
}
function saveSettings() {
  try { chrome.storage.sync.set({ babSettings: { theme: settings.theme, accent: settings.accent, modules: settings.modules } }); } catch (e) {}
}

// ============ 视图切换 ============
function showView(name) {
  view = name;
  els.mainView.hidden = name !== 'main';
  els.settingsPanel.hidden = name !== 'settings';
  els.eqPanel.hidden = name !== 'eq';
  if (name === 'eq' && window.__eqHandle) window.__eqHandle.refresh();
}

// ============ 高级均衡器（内联） ============
let eqModel = { enabled: true, bands: [] };
function loadEqModel(cb) {
  try {
    chrome.storage.sync.get('babSettings', (r) => {
      const s = (r && r.babSettings) || {};
      const eq = (s.eq && Array.isArray(s.eq.bands)) ? s.eq : (window.AudioBoosterEngine && window.AudioBoosterEngine.DEFAULT_EQ);
      eqModel = { enabled: eq.enabled !== false, bands: eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
      if (cb) cb();
    });
  } catch (e) { if (cb) cb(); }
}
function mountEq() {
  if (!els.eqMount || typeof window.mountEqPanel !== 'function') return;
  loadEqModel(() => {
    window.__eqHandle = window.mountEqPanel(els.eqMount, {
      getModel: () => eqModel,
      setModel: (m) => {
        eqModel = m;
        try { chrome.storage.sync.get('babSettings', (r) => { const s = (r && r.babSettings) || {}; s.eq = { enabled: m.enabled, bands: m.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) }; chrome.storage.sync.set({ babSettings: s }); }); } catch (e) {}
      }
    });
  });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.babSettings || !changes.babSettings.newValue || !changes.babSettings.newValue.eq) return;
      const s = changes.babSettings.newValue;
      const incoming = { enabled: s.eq.enabled !== false, bands: s.eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
      if (JSON.stringify(incoming) === JSON.stringify(eqModel)) return;
      eqModel = incoming;
      if (window.__eqHandle) window.__eqHandle.refresh();
    });
  } catch (e) {}
}

// ============ 初始化 ============
async function init() {
  try {
    chrome.storage.sync.get('babSettings', (r) => {
      try {
        const s = (r && r.babSettings) || {};
        settings = { ...SETTINGS_DEFAULTS, ...s, modules: { ...SETTINGS_DEFAULTS.modules, ...(s.modules || {}) } };
        renderSettings(); applyTheme();
      } catch (e) { showError(e); }
    });

    const tab = await getActiveTab();
    tabId = tab && tab.id != null ? tab.id : 'global';
    const url = (tab && tab.url) || '';
    isEnhancedPage = ENHANCED.test(url);
    els.tabPill.textContent = isEnhancedPage ? hostOf(url) : (hostOf(url) || '任意网页');

    els.enhanceCard.hidden = !isEnhancedPage;
    els.boostCard.hidden = isEnhancedPage;

    if (!isEnhancedPage) {
      chrome.storage.sync.get(boostKey(), (r) => {
        try {
          const b = r && r[boostKey()]; if (b) boost = { ...boost, ...b }; renderBoost(); if (boost.enabled) applyBoost();
        } catch (e) { showError(e); }
      });
    } else {
      try {
        const res = await send({ type: 'BAB_GET_STATE' });
        if (res && res.state) {
          current = { ...current, ...res.state };
          current.mediaCount = res.videoCount || 0;
          current.contextState = res.contextState || 'none';
        } else {
          chrome.storage.sync.get(stateKey(), (r) => {
            try {
              const st = r && r[stateKey()]; if (st) { current = { ...current, ...st }; renderEnhance(); }
            } catch (e) { showError(e); }
          });
        }
        renderEnhance();
      } catch (e) { showError(e); }
    }

    mountEq();

    // 设置页修改主题/强调色时，当前打开的弹窗同步刷新
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes.babSettings || !changes.babSettings.newValue) return;
        const s = changes.babSettings.newValue;
        if (s.theme) settings.theme = s.theme;
        if (s.accent) settings.accent = s.accent;
        applyTheme();
        if (els.sThemeSeg) renderSettings();
      });
    } catch (e) {}

    // 确保主视图可见（部分浏览器/版本下 hidden 属性可能异常）
    showView('main');
  } catch (e) {
    showError(e);
  }
}

// ============ 事件：顶部按钮 ============
els.openEQ.addEventListener('click', () => { if (view === 'eq') showView('main'); else showView('eq'); });
els.eqDone.addEventListener('click', () => showView('main'));
els.openSettings.addEventListener('click', () => { if (view === 'settings') showView('main'); else showView('settings'); });
els.settingsDone.addEventListener('click', () => showView('main'));
els.openLocal.addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('player/local-player.html') }); });

// ============ 事件：音频增强 ============
els.enhanceToggle.addEventListener('change', toggleEnhance);

els.presets.addEventListener('click', async (e) => {
  const btn = e.target.closest('.preset'); if (!btn) return;
  current.preset = btn.dataset.preset; current.clarity = 50; renderEnhance();
  await send({ type: 'BAB_SET_STATE', state: { preset: current.preset, clarity: current.clarity } });
});
function onClarity() { current.clarity = +els.clarity.value; els.clarityVal.textContent = clarityLabel(current.clarity); setFill(els.clarity); send({ type: 'BAB_SET_STATE', state: { clarity: current.clarity } }); }
function onWidth() { current.width = +els.width.value; els.widthVal.textContent = current.width > 100 ? current.width + '%' : '关'; setFill(els.width); send({ type: 'BAB_SET_STATE', state: { width: current.width } }); }
function onGain() { current.masterGain = els.masterGain.value / 100; els.gainVal.textContent = els.masterGain.value + '%'; setFill(els.masterGain); send({ type: 'BAB_SET_STATE', state: { masterGain: current.masterGain } }); }
els.clarity.addEventListener('input', onClarity);
els.width.addEventListener('input', onWidth);
els.masterGain.addEventListener('input', onGain);

// ============ 事件：全局音量 ============
els.boostToggle.addEventListener('change', () => { boost.enabled = els.boostToggle.checked; chrome.storage.sync.set({ [boostKey()]: boost }); applyBoost(); });
els.boostGain.addEventListener('input', () => { boost.gain = els.boostGain.value / 100; els.boostVal.textContent = els.boostGain.value + '%'; setFill(els.boostGain); });
els.boostGain.addEventListener('change', () => { chrome.storage.sync.set({ [boostKey()]: boost }); if (boost.enabled) applyBoost(); });

// ============ 事件：设置视图 - 外观 / 模块 ============
PRESET_ACCENTS.forEach((c) => {
  const s = document.createElement('div');
  s.className = 'swatch'; s.dataset.color = c; s.style.background = c;
  s.addEventListener('click', () => { settings.accent = c; applyTheme(); renderSettings(); saveSettings(); });
  els.sSwatches.appendChild(s);
});
els.sThemeSeg.addEventListener('click', (e) => { const btn = e.target.closest('.seg-btn'); if (!btn) return; settings.theme = btn.dataset.theme; applyTheme(); renderSettings(); saveSettings(); });
els.sAccentInput.addEventListener('input', () => { settings.accent = els.sAccentInput.value; applyTheme(); renderSettings(); saveSettings(); });
document.querySelectorAll('#settingsPanel .toggle-row[data-mod]').forEach((row) => {
  row.querySelector('input').addEventListener('change', (e) => { settings.modules[row.dataset.mod] = e.target.checked; saveSettings(); });
});

// ============ 恢复默认 ============
els.resetBtn.addEventListener('click', () => {
  settings = { ...SETTINGS_DEFAULTS, modules: { ...SETTINGS_DEFAULTS.modules } };
  applyTheme(); renderSettings(); saveSettings();
});

init();
