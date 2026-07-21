/*
 * Audio无限+ - 设置页逻辑（1.0 版，不含实时字幕）
 * 管理：主题（浅/深）、强调色、六大功能模块开关。改动即存 chrome.storage.sync.babSettings。
 */
const PRESET_ACCENTS = ['#6C5CE7', '#00A1D6', '#FB7299', '#1ABC9C', '#FF7B00', '#E74C3C'];

const DEFAULTS = {
  theme: 'dark',
  accent: '#6C5CE7',
  modules: { vocal: true, denoise: true, compress: true, deesser: true, air: true, surround: false }
};

const $ = (id) => document.getElementById(id);
const swatchesBox = $('swatches');
const accentInput = $('accentInput');
const themeSeg = $('themeSeg');
const eqMount = $('eqMount');

let settings = { ...DEFAULTS, modules: { ...DEFAULTS.modules } };

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

function renderTheme() {
  themeSeg.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.theme === settings.theme));
}
function renderSwatches() {
  swatchesBox.querySelectorAll('.swatch').forEach((s) =>
    s.classList.toggle('active', s.dataset.color.toLowerCase() === settings.accent.toLowerCase()));
  accentInput.value = settings.accent;
}
function renderModules() {
  document.querySelectorAll('.toggle-row[data-mod]').forEach((row) => {
    const mod = row.dataset.mod;
    row.querySelector('input').checked = !!settings.modules[mod];
  });
}

function save() {
  try { chrome.storage.sync.set({ babSettings: settings }); } catch (e) {}
}

// 预设色板
PRESET_ACCENTS.forEach((c) => {
  const s = document.createElement('div');
  s.className = 'swatch'; s.dataset.color = c; s.style.background = c;
  s.addEventListener('click', () => { settings.accent = c; applyTheme(); renderSwatches(); save(); });
  swatchesBox.appendChild(s);
});

themeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  settings.theme = btn.dataset.theme; applyTheme(); renderTheme(); save();
});
accentInput.addEventListener('input', () => { settings.accent = accentInput.value; applyTheme(); renderSwatches(); save(); });
document.querySelectorAll('.toggle-row[data-mod]').forEach((row) => {
  row.querySelector('input').addEventListener('change', (e) => {
    settings.modules[row.dataset.mod] = e.target.checked; save();
  });
});
$('resetBtn').addEventListener('click', () => {
  settings = { ...DEFAULTS, modules: { ...DEFAULTS.modules } };
  applyTheme(); renderTheme(); renderSwatches(); renderModules(); save();
});

// ---------------- 高级均衡器（内联，编辑全局 babSettings.eq） ----------------
let eqModelOpts = { model: { enabled: true, bands: [] } };
let eqHandle = null;
function loadEqModel(cb) {
  try {
    chrome.storage.sync.get('babSettings', (r) => {
      const s = (r && r.babSettings) || {};
      const eq = (s.eq && Array.isArray(s.eq.bands)) ? s.eq : (window.AudioBoosterEngine && window.AudioBoosterEngine.DEFAULT_EQ);
      eqModelOpts.model = { enabled: eq.enabled !== false, bands: eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
      if (cb) cb();
    });
  } catch (e) { if (cb) cb(); }
}
function mountEq() {
  if (!eqMount || typeof window.mountEqPanel !== 'function') return;
  loadEqModel(() => {
    eqHandle = window.mountEqPanel(eqMount, {
      getModel: () => eqModelOpts.model,
      setModel: (m) => {
        eqModelOpts.model = m;
        try {
          chrome.storage.sync.get('babSettings', (r) => {
            const s = (r && r.babSettings) || {};
            s.eq = { enabled: m.enabled, bands: m.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
            chrome.storage.sync.set({ babSettings: s });
          });
        } catch (e) {}
      }
    });
  });
}
// 弹窗 / 本地播放器改动 EQ 时同步刷新设置页面板
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.babSettings || !changes.babSettings.newValue || !changes.babSettings.newValue.eq) return;
    const s = changes.babSettings.newValue;
    const incoming = { enabled: s.eq.enabled !== false, bands: s.eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
    if (JSON.stringify(incoming) === JSON.stringify(eqModelOpts.model)) return; // 自己改的，跳过
    eqModelOpts.model = incoming;
    if (eqHandle) eqHandle.refresh();
  });
} catch (e) {}

// 初始化
try {
  chrome.storage.sync.get('babSettings', (r) => {
    const s = (r && r.babSettings) || {};
    settings = { ...DEFAULTS, ...s, modules: { ...DEFAULTS.modules, ...(s.modules || {}) } };
    applyTheme(); renderTheme(); renderSwatches(); renderModules();
  });
} catch (e) {
  applyTheme(); renderTheme(); renderSwatches(); renderModules();
}
mountEq();
