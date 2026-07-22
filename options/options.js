/*
 * Audio无限+ - 设置页逻辑
 * 管理：主题（浅/深）、强调色、六大功能模块开关。改动即存 chrome.storage.sync.babSettings。
 */
const PRESET_ACCENTS = ['#6C5CE7', '#00A1D6', '#FB7299', '#1ABC9C', '#FF7B00', '#E74C3C'];

// 当以 ?embed=1 嵌入本地播放器页内时，隐藏自身标题栏（由播放器的覆盖层提供标题与「返回」）
if (/[?&]embed=1\b/.test(location.search) && document.body) {
  document.body.classList.add('embedded');
}

const DEFAULTS = {
  theme: 'dark',
  accent: '#6C5CE7',
  // 默认仅开启“音频增强”与“媒体控制”（显示 + 启用）；资源下载 / 实时字幕默认关闭
  modules: { enhance: true, resourcedl: false, caption: false, media: true },
  moduleHome: { enhance: true, resourcedl: false, caption: false, media: true }
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
  document.querySelectorAll('.mod-row[data-mod]').forEach((row) => {
    const mod = row.dataset.mod;
    const home = row.querySelector('input[data-role="home"]');
    if (home) home.checked = !!(settings.moduleHome && settings.moduleHome[mod]);
    // 兼容：若 HTML 仍保留“启用”开关则同步（现已移除，仅保留“显示”）
    const en = row.querySelector('input[data-role="enabled"]');
    if (en) en.checked = !!(settings.modules && settings.modules[mod]);
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
document.querySelectorAll('.mod-row[data-mod]').forEach((row) => {
  const home = row.querySelector('input[data-role="home"]');
  if (home) home.addEventListener('change', () => {
    const mod = row.dataset.mod;
    const on = !!home.checked;
    settings.moduleHome[mod] = on;
    // 显示 是 启用 的前置条件：关闭显示即关闭启用
    settings.modules[mod] = on;
    save();
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

// ---------------- 实时字幕设置 ----------------
let capSub = null;
function setSegActive(root, value, attr) {
  if (!root) return;
  root.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.getAttribute(attr) === value));
}
function fillCapLangs() {
  const opts = window.BAB_SUB.LANGS.map((l) => '<option value="' + l.code + '">' + l.name + '</option>').join('');
  $('capLang').innerHTML = opts;
}
function capTipText(engine, customType) {
  if (engine === 'webspeech') return '免费方案：使用浏览器内置语音识别，无需配置，仅麦克风输入，实时性最好。';
  if (engine === 'mimo') return '将音频编码为 WAV（16-bit PCM）后 base64 提交到小米 MiMo 的 Chat Completions 接口；仅支持 MP3 / WAV；返回 choices[0].message.content。';
  if (customType === 'custom_ws') return '通过 WebSocket 发送单声道 Float32 PCM（原生采样率），服务端需返回 JSON {text, isFinal}；连接后先发 {type:"config", lang, model}。';
  return '将音频分段（约每 4 秒）POST 到你的接口；需兼容 OpenAI Whisper 返回格式 {text} 或 {choices:[{text}]}。';
}
function hexToRgba(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + (isFinite(a) ? a : 0) + ')';
}
function updateCapPreview() {
  const prev = $('capPreview');
  prev.style.fontFamily = capSub.style.fontFamily;
  prev.style.fontSize = capSub.style.fontSize + 'px';
  prev.style.color = capSub.style.color;
  // 预览底部背景 = 字幕样式中的「背景颜色」按「背景不透明度」着色
  // （用 hexToRgba 计算，避免 color-mix 在部分环境失效导致预览恒为灰色）
  prev.style.background = hexToRgba(capSub.style.bgColor, capSub.style.bgOpacity);
  prev.style.textAlign = capSub.style.align;
  prev.style.maxHeight = (capSub.style.height || 200) + 'px';
  prev.style.overflowY = 'auto';
  prev.style.textShadow = capSub.style.textShadow ? '0 1px 3px rgba(0,0,0,.85)' : 'none';
}
function renderCap() {
  if (!capSub) return;
  // 兼容旧版：将已存储的 custom_http / custom_ws 归并到统一的 custom，并立即持久化，
  // 避免退出插件后内存中的归并结果未写回存储，导致下次打开引擎选择被重置。
  const capLegacy = (capSub.engine === 'custom_http' || capSub.engine === 'custom_ws');
  if (capLegacy) {
    capSub.custom = capSub.custom || {};
    capSub.custom.type = capSub.engine;
    capSub.engine = 'custom';
  }
  $('capEngine').value = capSub.engine;
  const isCustom = capSub.engine === 'custom';
  $('capCustom').hidden = !isCustom;
  if (isCustom) {
    capSub.custom = capSub.custom || { type: 'custom_http' };
    $('capProtoSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.proto === capSub.custom.type));
  }
  $('capEndpoint').value = capSub.custom.endpoint || '';
  $('capApiKey').value = capSub.custom.apiKey || '';
  $('capModel').value = capSub.custom.model || 'whisper-1';
  $('capHeaders').value = capSub.custom.headers || '';
  $('capTip').textContent = capTipText(capSub.engine, capSub.custom && capSub.custom.type);
  const isMimo = capSub.engine === 'mimo';
  $('capMimo').hidden = !isMimo;
  if (isMimo) {
    const m = capSub.mimo || {};
    $('capMimoUrl').value = m.url || 'https://api.xiaomimimo.com/v1/chat/completions';
    $('capMimoKey').value = m.apiKey || '';
    $('capMimoTip').textContent = capTipText('mimo');
  }
  $('capLang').value = capSub.lang;
  setSegActive($('capSrcSeg'), capSub.source, 'data-src');
  $('capFont').value = capSub.style.fontFamily;
  $('capSize').value = capSub.style.fontSize; $('capSizeVal').textContent = capSub.style.fontSize;
  $('capColor').value = capSub.style.color;
  $('capBg').value = capSub.style.bgColor;
  $('capBgOp').value = Math.round(capSub.style.bgOpacity * 100); $('capBgOpVal').textContent = Math.round(capSub.style.bgOpacity * 100);
  $('capAlignSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.align === capSub.style.align));
  $('capMaxw').value = capSub.style.maxWidth; $('capMaxwVal').textContent = capSub.style.maxWidth;
  $('capHeight').value = capSub.style.height || 200; $('capHeightVal').textContent = capSub.style.height || 200;
  $('capExportSeg').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.fmt === capSub.exportFormat));
  updateCapPreview();
  if (capLegacy) saveCap();
}
// 把设置的模型名直接写进“自定义 AI”引擎选项文案
function updateCapEngineLabels() {
  if (!capSub) return;
  const model = (capSub.custom && capSub.custom.model) || 'whisper-1';
  const sel = $('capEngine');
  if (sel) {
    const o1 = sel.querySelector('option[value="custom_http"]');
    const o2 = sel.querySelector('option[value="custom_ws"]');
    const o3 = sel.querySelector('option[value="mimo"]');
    if (o1) o1.textContent = '自定义 AI · HTTP（' + model + '）';
    if (o2) o2.textContent = '自定义 AI · WebSocket（' + model + '）';
    if (o3) o3.textContent = '小米 MiMo（' + model + '）';
  }
}
// 串行化写入：避免连续修改（如先填 Endpoint 再填 API Key）时 read-modify-write 竞态，
// 导致后一次写入覆盖前一次、把已输入的字段（如 API）静默丢弃（不启用实时字幕进入新播放页、
// 无法记忆识别引擎输入的 api）。
let capSaveChain = Promise.resolve();
function saveCap() {
  if (!capSub) return;
  capSaveChain = capSaveChain
    .then(() => new Promise((resolve) => {
      try {
        chrome.storage.sync.get('babSettings', (r) => {
          const s = (r && r.babSettings) || {};
          s.subtitle = capSub;
          chrome.storage.sync.set({ babSettings: s }, () => resolve());
        });
      } catch (e) { resolve(); }
    }))
    .catch(() => {});
}
function initCaption() {
  fillCapLangs();
  if (!window.BAB_SUB) return;
  window.BAB_SUB.loadSettings((sub) => { capSub = sub; renderCap(); });
}

$('capEngine').addEventListener('change', () => {
  capSub.engine = $('capEngine').value;
  if (capSub.engine === 'custom') capSub.custom = capSub.custom || { type: 'custom_http' };
  if (capSub.engine === 'mimo') capSub.mimo = capSub.mimo || { url: 'https://api.xiaomimimo.com/v1/chat/completions', apiKey: '', model: 'mimo-v2.5-asr' };
  $('capCustom').hidden = capSub.engine !== 'custom';
  $('capTip').textContent = capTipText(capSub.engine, capSub.custom && capSub.custom.type);
  saveCap();
  renderCap();
});
$('capProtoSeg').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (!b) return; capSub.custom.type = b.dataset.proto; $('capTip').textContent = capTipText(capSub.engine, capSub.custom.type); saveCap(); });
$('capEndpoint').addEventListener('input', () => { capSub.custom.endpoint = $('capEndpoint').value; saveCap(); });
$('capApiKey').addEventListener('input', () => { capSub.custom.apiKey = $('capApiKey').value; saveCap(); });
$('capModel').addEventListener('input', () => { capSub.custom.model = $('capModel').value; saveCap(); });
$('capHeaders').addEventListener('input', () => { capSub.custom.headers = $('capHeaders').value; saveCap(); });
$('capMimoUrl').addEventListener('input', () => { capSub.mimo = capSub.mimo || {}; capSub.mimo.url = $('capMimoUrl').value; saveCap(); });
$('capMimoKey').addEventListener('input', () => { capSub.mimo = capSub.mimo || {}; capSub.mimo.apiKey = $('capMimoKey').value; saveCap(); });
$('capLang').addEventListener('change', () => { capSub.lang = $('capLang').value; saveCap(); });
$('capSrcSeg').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (!b) return; capSub.source = b.dataset.src; setSegActive($('capSrcSeg'), capSub.source, 'data-src'); saveCap(); });
$('capFont').addEventListener('change', () => { capSub.style.fontFamily = $('capFont').value; updateCapPreview(); saveCap(); });
$('capSize').addEventListener('input', () => { capSub.style.fontSize = +$('capSize').value; $('capSizeVal').textContent = capSub.style.fontSize; updateCapPreview(); saveCap(); });
$('capColor').addEventListener('input', () => { capSub.style.color = $('capColor').value; updateCapPreview(); saveCap(); });
$('capBg').addEventListener('input', () => { capSub.style.bgColor = $('capBg').value; updateCapPreview(); saveCap(); });
$('capBgOp').addEventListener('input', () => { capSub.style.bgOpacity = +$('capBgOp').value / 100; $('capBgOpVal').textContent = $('capBgOp').value; updateCapPreview(); saveCap(); });
$('capAlignSeg').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (!b) return; capSub.style.align = b.dataset.align; setSegActive($('capAlignSeg'), capSub.style.align, 'data-align'); updateCapPreview(); saveCap(); });
$('capMaxw').addEventListener('input', () => { capSub.style.maxWidth = +$('capMaxw').value; $('capMaxwVal').textContent = capSub.style.maxWidth; updateCapPreview(); saveCap(); });
$('capHeight').addEventListener('input', () => { capSub.style.height = +$('capHeight').value; $('capHeightVal').textContent = capSub.style.height; updateCapPreview(); saveCap(); });
$('capExportSeg').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (!b) return; capSub.exportFormat = b.dataset.fmt; setSegActive($('capExportSeg'), capSub.exportFormat, 'data-fmt'); saveCap(); });

// 导出最新会话 / 打开历史页
function exportLatestSession() {
  if (!SUB) return;
  try {
    chrome.storage.local.get('babSubtitleSessions', (r) => {
      const sessions = (r && r.babSubtitleSessions) || [];
      if (!sessions.length) { alert('暂无字幕记录可导出。请先开启实时字幕并识别一段内容。'); return; }
      const latest = sessions.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
      const fmt = (capSub && capSub.exportFormat) || 'srt';
      const text = fmt === 'txt' ? SUB.exportTXT(latest, true) : SUB.exportSRT(latest);
      const d = new Date(latest.startedAt);
      const ts = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      SUB.download('字幕_' + ts + '.' + fmt, text);
    });
  } catch (e) {}
}
$('exportBtn').addEventListener('click', exportLatestSession);
$('openHistoryBtn').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('captions/history.html') }); });

// 初始化
try {
  chrome.storage.sync.get('babSettings', (r) => {
    const s = (r && r.babSettings) || {};
    settings = { ...DEFAULTS, ...s, modules: { ...DEFAULTS.modules, ...(s.modules || {}) }, moduleHome: { ...DEFAULTS.moduleHome, ...(s.moduleHome || {}) } };
    applyTheme(); renderTheme(); renderSwatches(); renderModules();
  });
} catch (e) {
  applyTheme(); renderTheme(); renderSwatches(); renderModules();
}
mountEq();
initCaption();
