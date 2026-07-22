/*
 * Audio无限+ - Popup 交互逻辑（2.3.1 UI 版）
 * 主界面保留 2.3.0 完整音频增强卡片 + 实时字幕卡片；
 * 实时字幕开启后展开识别引擎/语言/音源/状态；
 * 设置页为可滚动完整页面（外观 / 功能模块 / 实时字幕 / 字幕样式 / 导出）。
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
  // 主视图：实时字幕
  captionCard: $('captionCard'),
  capToggle: $('capToggle'),
  capState: $('capState'),
  capParams: $('capParams'),
  capEngine: $('capEngine'),
  capLang: $('capLang'),
  capSrcSeg: $('capSrcSeg'),
  capSrcNote: $('capSrcNote'),
  capStatus: $('capStatus'),
  // 主视图：实时字幕（API 配置统一在设置页，初始界面仅做选择）
  capApiNote: $('capApiNote'),
  openLocal: $('openLocal'),
  // 设置视图：外观
  settingsDone: $('settingsDone'),
  sThemeSeg: $('s_themeSeg'),
  sSwatches: $('s_swatches'),
  sAccentInput: $('s_accentInput'),
  // 设置视图：实时字幕基础
  sCapEngine: $('s_capEngine'),
  sCapLang: $('s_capLang'),
  sCapSrcSeg: $('s_capSrcSeg'),
  // 设置视图：自定义 AI
  sCapCustom: $('s_capCustom'),
  sCapProtoSeg: $('s_capProtoSeg'),
  sCapEndpoint: $('s_capEndpoint'),
  sCapApiKey: $('s_capApiKey'),
  sCapModel: $('s_capModel'),
  sCapHeaders: $('s_capHeaders'),
  sCapTip: $('s_capTip'),
  sCapMimo: $('s_capMimo'),
  sCapMimoUrl: $('s_capMimoUrl'),
  sCapMimoKey: $('s_capMimoKey'),
  // 设置视图：字幕样式
  sCapFont: $('s_capFont'),
  sCapSize: $('s_capSize'),
  sCapSizeVal: $('s_capSizeVal'),
  sCapColor: $('s_capColor'),
  sCapBg: $('s_capBg'),
  sCapBgOp: $('s_capBgOp'),
  sCapBgOpVal: $('s_capBgOpVal'),
  sCapAlignSeg: $('s_capAlignSeg'),
  sCapMaxw: $('s_capMaxw'),
  sCapMaxwVal: $('s_capMaxwVal'),
  sCapHeight: $('s_capHeight'),
  sCapHeightVal: $('s_capHeightVal'),
  sCapPreview: $('s_capPreview'),
  // 设置视图：导出
  sCapExportSeg: $('s_capExportSeg'),
  sExportBtn: $('s_exportBtn'),
  sOpenHistory: $('s_openHistory'),
  resetBtn: $('resetBtn'),
  // 高级 EQ
  eqDone: $('eqDone'),
  // 媒体控制
  openMedia: $('openMedia'),
  mediaPanel: $('mediaPanel'),
  mediaTrack: $('mediaTrack'),
  mediaStatus: $('mediaStatus'),
  mediaPlay: $('mediaPlay'),
  mediaSeek: $('mediaSeek'),
  mediaCur: $('mediaCur'),
  mediaDur: $('mediaDur'),
  mediaSpeed: $('mediaSpeed'),
  mediaSpeedDots: $('mediaSpeedDots'),
  mediaSpeedVal: $('mediaSpeedVal'),
  mediaVol: $('mediaVol'),
  mediaVolVal: $('mediaVolVal'),
  mediaMute: $('mediaMute'),
  mediaRescan: $('mediaRescan'),
  mediaSeekBack: $('mediaSeekBack'),
  mediaSeekFwd: $('mediaSeekFwd'),
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
let mediaDefault = false;   // 媒体控制页面状态记忆：true=下次打开默认显示媒体控制页
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
function resDlKey() { return 'babResDl_' + (tabId == null ? 'global' : tabId); }
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
  // 默认仅开启“音频增强”（显示 + 启用）；资源下载 / 实时字幕默认关闭
  modules: { enhance: true, resourcedl: false, caption: false, media: true },
  moduleHome: { enhance: true, resourcedl: false, caption: false, media: true }
};
let settings = { ...SETTINGS_DEFAULTS, modules: { ...SETTINGS_DEFAULTS.modules }, moduleHome: { ...SETTINGS_DEFAULTS.moduleHome } };

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
  document.querySelectorAll('#settingsPanel .mod-row[data-mod]').forEach((row) => {
    const mod = row.dataset.mod;
    const home = row.querySelector('input[data-role="home"]');
    if (home) home.checked = !!(settings.moduleHome && settings.moduleHome[mod]);
    // 兼容：若 HTML 仍保留“启用”开关则同步（现已移除，仅保留“显示”）
    const en = row.querySelector('input[data-role="enabled"]');
    if (en) en.checked = !!(settings.modules && settings.modules[mod]);
  });
}
// 根据「在初始界面显示」开关控制主视图各模块卡片的可见性
function applyHomeVisibility() {
  const home = settings.moduleHome || {};
  // “功能显示”开关控制主视图各模块卡片是否出现：显示=ON 才展示对应功能内容
  if (els.enhanceCard) els.enhanceCard.hidden = !isEnhancedPage || !home.enhance;
  const rc = document.getElementById('resourceCard');
  if (rc) rc.hidden = !home.resourcedl;
  const cc = document.getElementById('captionCard');
  if (cc) cc.hidden = !home.caption;
  const dlEl = document.getElementById('dlToggle');
  if (dlEl) dlEl.disabled = !home.resourcedl;
  // 媒体控制：在“功能显示”中开启才在右上角出现入口按键（默认开启）。
  // 用真值判定：media 为 false / undefined（旧数据缺省）时均隐藏按键，
  // 保证“功能显示未启用”与按键隐藏始终一致，且可正常关闭。
  if (els.openMedia) els.openMedia.hidden = !home.media;
}
function saveSettings() {
  // 读-改-写合并：仅更新主题/强调色/模块开关，保留 subtitle（识别引擎 API）、eq 等其它字段，
  // 避免整体覆盖把已保存的实时字幕 API 冲掉（不启用实时字幕进入新播放页、API 无法记忆的根因）。
  try {
    chrome.storage.sync.get('babSettings', (r) => {
      const s = (r && r.babSettings) || {};
      s.theme = settings.theme;
      s.accent = settings.accent;
      s.modules = settings.modules;
      s.moduleHome = settings.moduleHome;
      chrome.storage.sync.set({ babSettings: s });
    });
  } catch (e) {}
}

// ============ 视图切换 ============
// 媒体控制按键上下文：默认（初始界面/主视图）为播放三角；进入媒体控制页后切换为
// 「返回初始界面」插件图标。进入 EQ / 设置页时保持该插件图标，只有回到主视图才恢复播放三角。
let mediaContext = false;
const ICON_MEDIA_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.16"/><path d="M10 8.2l6 3.8-6 3.8z" fill="currentColor"/></svg>';
// 插件图标：简约 ∞（单笔画双纽线，细线条，与参考图一致）
const ICON_MEDIA_HOME = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12 C5 6 11 6 12 12 C13 6 19 6 19 12 C19 18 13 18 12 12 C11 18 5 18 5 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function setMediaButtonForView(name) {
  if (!els.openMedia) return;
  if (name === 'media') mediaContext = true;
  if (name === 'main') mediaContext = false;
  const home = mediaContext;
  els.openMedia.innerHTML = home ? ICON_MEDIA_HOME : ICON_MEDIA_PLAY;
  els.openMedia.title = home ? '返回初始界面' : '媒体控制';
  els.openMedia.setAttribute('aria-label', home ? '返回初始界面' : '媒体控制');
  els.openMedia.classList.toggle('media-home', home);
}
function showView(name) {
  view = name;
  els.mainView.hidden = name !== 'main';
  els.settingsPanel.hidden = name !== 'settings';
  els.eqPanel.hidden = name !== 'eq';
  els.mediaPanel.hidden = name !== 'media';
  // 媒体控制按钮：进入媒体页时高亮
  if (els.openMedia) els.openMedia.classList.toggle('media-active', name === 'media');
  setMediaButtonForView(name);
  if (name === 'media') { startMediaPoll(); }
  else { stopMediaPoll(); }
  if (name === 'eq' && window.__eqHandle) window.__eqHandle.refresh();
  if (name === 'settings') renderSettingsCaption();
  // 回到初始界面时同步实时字幕（确保设置页改过的识别引擎等在此即时反映）
  if (name === 'main' && capSub) renderMainCaption();
}
// 媒体控制为“首页态”时，从 EQ / 设置页返回应回到媒体控制页
function backFromSub() { showView(mediaDefault ? 'media' : 'main'); }

// ============ 实时字幕 ============
let capSub = null;
function fillLangs() {
  if (!window.BAB_SUB) return;
  const html = window.BAB_SUB.LANGS.map((l) => '<option value="' + l.code + '">' + l.name + '</option>').join('');
  els.capLang.innerHTML = html;
  els.sCapLang.innerHTML = html;
}
function capTipText(engine, customType) {
  if (engine === 'webspeech') return '免费方案：浏览器原生识别，无需配置，仅支持麦克风。';
  if (engine === 'mimo') return '将音频编码为 WAV（16-bit PCM）后 base64 提交到小米 MiMo 的 Chat Completions 接口；仅支持 MP3 / WAV；返回 choices[0].message.content。';
  if (customType === 'custom_ws') return '通过 WebSocket 发送单声道 Float32 PCM，服务端返回 JSON {text, isFinal}。';
  return '将音频分段 POST 到接口；需兼容 OpenAI Whisper 返回格式 {text} 或 {choices:[{text}]}。';
}
function renderMainCaption() {
  if (!capSub) return;
  // 兼容旧版：将已存储的 custom_http / custom_ws 归并到统一的 custom，并立即持久化，
  // 避免退出插件后内存中的归并结果未写回存储，导致下次打开引擎选择被重置。
  const capLegacy = (capSub.engine === 'custom_http' || capSub.engine === 'custom_ws');
  if (capLegacy) {
    capSub.custom = capSub.custom || {};
    capSub.custom.type = capSub.engine;
    capSub.engine = 'custom';
  }
  els.capEngine.value = capSub.engine;
  els.capLang.value = capSub.lang;
  setSegActive(els.capSrcSeg, capSub.source, 'data-src');
  els.capSrcSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.disabled = (capSub.engine === 'webspeech' && b.dataset.src === 'tab');
  });
  els.capSrcNote.textContent = capSub.engine === 'webspeech' ? 'Web Speech 仅支持麦克风' : '';
  els.capSrcNote.hidden = capSub.engine !== 'webspeech';
  // 初始界面不再提供 API 设置：仅展示提示，具体配置在「设置 → 实时字幕」完成
  if (els.capApiNote) els.capApiNote.hidden = (capSub.engine === 'webspeech');
  els.capStatus.textContent = els.capToggle.checked ? '识别中' : '已停止';
  if (capLegacy) saveCap();
}
function renderSettingsCaption() {
  if (!capSub) return;
  const capLegacy = (capSub.engine === 'custom_http' || capSub.engine === 'custom_ws');
  if (capLegacy) {
    capSub.custom = capSub.custom || {};
    capSub.custom.type = capSub.engine;
    capSub.engine = 'custom';
  }
  els.sCapEngine.value = capSub.engine;
  els.sCapLang.value = capSub.lang;
  setSegActive(els.sCapSrcSeg, capSub.source, 'data-src');
  const isCustom = capSub.engine === 'custom';
  els.sCapCustom.hidden = !isCustom;
  els.sCapTip.textContent = capTipText(capSub.engine, capSub.custom && capSub.custom.type);
  if (isCustom) {
    const c = capSub.custom || { type: 'custom_http' };
    setSegActive(els.sCapProtoSeg, c.type || 'custom_http', 'data-proto');
    els.sCapEndpoint.value = c.endpoint || '';
    els.sCapApiKey.value = c.apiKey || '';
    els.sCapModel.value = c.model || 'whisper-1';
    els.sCapHeaders.value = c.headers || '';
  }
  const isMimo = capSub.engine === 'mimo';
  els.sCapMimo.hidden = !isMimo;
  if (isMimo) {
    const m = capSub.mimo || {};
    els.sCapMimoUrl.value = m.url || 'https://api.xiaomimimo.com/v1/chat/completions';
    els.sCapMimoKey.value = m.apiKey || '';
    els.sCapMimoTip.textContent = capTipText('mimo');
  }
  renderSettingsStyle();
  const exportFmt = capSub.exportFormat || 'srt';
  setSegActive(els.sCapExportSeg, exportFmt, 'data-fmt');
  if (capLegacy) saveCap();
}
function renderSettingsStyle() {
  if (!capSub) return;
  const st = capSub.style || {};
  els.sCapFont.value = st.fontFamily || "'SimSun','Songti SC','STSong','Noto Serif CJK SC',serif";
  els.sCapSize.value = st.fontSize != null ? st.fontSize : 30; els.sCapSizeVal.textContent = els.sCapSize.value; setFill(els.sCapSize);
  els.sCapColor.value = st.color || '#000000';
  els.sCapBg.value = st.bgColor || '#ffffff';
  els.sCapBgOp.value = st.bgOpacity != null ? Math.round(st.bgOpacity * 100) : 0; els.sCapBgOpVal.textContent = els.sCapBgOp.value; setFill(els.sCapBgOp);
  setSegActive(els.sCapAlignSeg, st.align || 'center', 'data-align');
  els.sCapMaxw.value = st.maxWidth != null ? st.maxWidth : 80; els.sCapMaxwVal.textContent = els.sCapMaxw.value; setFill(els.sCapMaxw);
  els.sCapHeight.value = st.height != null ? st.height : 200; els.sCapHeightVal.textContent = els.sCapHeight.value; setFill(els.sCapHeight);
  updateStylePreview();
}
function updateStylePreview() {
  if (!els.sCapPreview) return;
  const st = capSub && capSub.style ? capSub.style : {};
  els.sCapPreview.style.fontFamily = st.fontFamily || "'SimSun','Songti SC','STSong','Noto Serif CJK SC',serif";
  els.sCapPreview.style.fontSize = (st.fontSize || 30) + 'px';
  els.sCapPreview.style.color = st.color || '#000000';
  const op = st.bgOpacity != null ? st.bgOpacity : 0;
  const hex = st.bgColor || '#ffffff';
  els.sCapPreview.style.backgroundColor = hexToRgba(hex, op);
  els.sCapPreview.style.textShadow = st.textShadow ? '0 1px 4px rgba(0,0,0,.5)' : 'none';
  els.sCapPreview.style.borderRadius = '12px';
  const maxW = st.maxWidth != null ? st.maxWidth : 80;
  els.sCapPreview.style.maxWidth = maxW + '%';
  els.sCapPreview.style.maxHeight = (st.height || 200) + 'px';
  els.sCapPreview.style.overflowY = 'auto';
  els.sCapPreview.style.margin = '0 auto';
}
function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '').match(/^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return hex;
  return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + alpha + ')';
}
// 串行化写入：避免连续修改（如先填 Endpoint 再填 API Key）时 read-modify-write 竞态，
// 导致后一次写入覆盖前一次、把已输入的字段（如 API）静默丢弃。同一页面 capSub 还在内存里、
// 看起来正常，但存储已丢字段，新开弹窗重载即从存储读到空值（即“不启用实时字幕进入新播放页，
// 无法记忆识别引擎输入的 api”）。
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
function setCapRunning(running) {
  els.capToggle.checked = running;
  els.capState.textContent = running ? '已开启' : '已关闭';
  els.capState.className = 'switch-state' + (running ? ' on' : '');
  els.capParams.hidden = !running;
  els.capStatus.textContent = running ? '识别中' : '已停止';
}
function startCap() {
  if (!capSub) return;
  let engine = capSub.engine;
  if (engine === 'custom') engine = (capSub.custom && capSub.custom.type) || 'custom_http';
  const opts = { engine: engine, lang: capSub.lang, source: capSub.source, custom: capSub.custom, mimo: capSub.mimo, targetTabId: (typeof tabId === 'number') ? tabId : null };
  try { chrome.runtime.sendMessage({ type: 'BAB_CAP_START', opts }, (res) => {
    if (res && res.ok === false) { setCapRunning(false); return; }
    setCapRunning(!!(res && res.active));
  }); } catch (e) { setCapRunning(false); }
}
function stopCap() { try { chrome.runtime.sendMessage({ type: 'BAB_CAP_STOP' }, () => setCapRunning(false)); } catch (e) { setCapRunning(false); } }
function listenCaptionMessages() {
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'BAB_SUBTITLE_STATE') {
        setCapRunning(!!msg.active);
      } else if (msg.type === 'BAB_CAP_SYNC') {
        setCapRunning(!!msg.active);
      } else if (msg.type === 'BAB_SUBTITLE_INFO') {
        if (els.capStatus && els.capToggle && els.capToggle.checked) {
          const short = String(msg.msg || '').slice(0, 30);
          els.capStatus.textContent = short || '识别中';
          clearTimeout(window.__capInfoTimer);
          window.__capInfoTimer = setTimeout(() => {
            if (els.capStatus && els.capToggle && els.capToggle.checked) els.capStatus.textContent = '识别中';
          }, 2600);
        }
      } else if (msg.type === 'BAB_SUBTITLE_ERROR') {
        if (els.capStatus) {
          const short = String(msg.msg || '字幕出错').slice(0, 22);
          els.capStatus.textContent = '出错：' + short;
          setTimeout(() => {
            if (els.capStatus && els.capToggle && els.capToggle.checked) els.capStatus.textContent = '识别中';
          }, 2600);
        }
      }
    });
  } catch (e) {}
}
function initCaption() {
  fillLangs();
  if (!window.BAB_SUB) return;
  window.BAB_SUB.loadSettings((sub) => {
    capSub = sub;
    renderMainCaption();
    try { chrome.runtime.sendMessage({ type: 'BAB_CAP_QUERY' }, (res) => setCapRunning(!!(res && res.active))); } catch (e) { setCapRunning(false); }
  });
  listenCaptionMessages();
}

function exportLatestSession() {
  if (!window.BAB_SUB) return;
  try {
    chrome.storage.local.get('babSubtitleSessions', (r) => {
      const sessions = (r && r.babSubtitleSessions) || [];
      if (!sessions.length) { alert('暂无字幕记录可导出。请先开启实时字幕并识别一段内容。'); return; }
      const latest = sessions.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
      const fmt = (capSub && capSub.exportFormat) || 'srt';
      const text = fmt === 'txt' ? window.BAB_SUB.exportTXT(latest, true) : window.BAB_SUB.exportSRT(latest);
      const d = new Date(latest.startedAt);
      const ts = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      window.BAB_SUB.download('字幕_' + ts + '.' + fmt, text);
    });
  } catch (e) {}
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
function updateEqButton() {
  if (els.openEQ) els.openEQ.classList.toggle('eq-off', !eqModel.enabled);
}
function updateMediaButton() {
  if (!els.openMedia) return;
  const home = settings.moduleHome || {};
  // 初始界面（主视图）中不存在任何已启用的功能时，返回初始界面按键的紫色线条转为白色，
  // 与高级均衡器按键（eq-off）一致；此处以「内容类功能」en2hance/资源下载/字幕 是否启用为准，
  // 媒体控制入口本身不计入（它正是该按键）。
  const homeHasFunc = !!(home.enhance || home.resourcedl || home.caption);
  els.openMedia.classList.toggle('media-off', !homeHasFunc);
}
function mountEq() {
  if (!els.eqMount || typeof window.mountEqPanel !== 'function') return;
  loadEqModel(() => {
    updateEqButton();
    window.__eqHandle = window.mountEqPanel(els.eqMount, {
      getModel: () => eqModel,
      setModel: (m) => {
        eqModel = m;
        updateEqButton();
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
      updateEqButton();
      if (window.__eqHandle) window.__eqHandle.refresh();
    });
  } catch (e) {}
}

// ============ 媒体控制（独立页面） ============
// 向当前标签页（及所有子框架）发送控制指令，返回首个检测到媒体的框架状态
async function mediaTab(id, msg) {
  const frames = await framesOf(id);
  const responses = await Promise.all(frames.map((f) => new Promise((res) => {
    chrome.tabs.sendMessage(id, msg, { frameId: f.frameId }, (r) => res(chrome.runtime.lastError ? { none: true } : (r || { none: true })));
  })));
  let biliTitle = '';
  let chosen = null;
  for (const r of responses) {
    if (!r) continue;
    if (r.isBili && r.title) biliTitle = biliTitle || r.title;
    if (r.has && !chosen) chosen = r;
  }
  if (!chosen) return { none: true };
  if (biliTitle) chosen.biliTitle = biliTitle;
  return chosen;
}
function fmtMedia(sec) {
  sec = sec || 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return h > 0 ? (h + ':' + p(m) + ':' + p(s)) : (p(m) + ':' + p(s));
}
let lastMedia = { duration: 0, currentTime: 0, muted: false };
function renderMediaState(st) {
  if (!st || st.none) {
    if (els.mediaTrack) { els.mediaTrack.hidden = false; els.mediaTrack.textContent = '未检测到当前页面的音视频'; }
    if (els.mediaStatus) els.mediaStatus.textContent = '';
    els.mediaPlay.disabled = true; els.mediaSeek.disabled = true; els.mediaVol.disabled = true; if (els.mediaMute) els.mediaMute.disabled = true;
    els.mediaPlay.textContent = '▶';
    els.mediaCur.textContent = '00:00'; els.mediaDur.textContent = '00:00';
    // 修复：未检测到媒体时，进度条填充应如实反映当前数值（seek=0 → 无紫色），
    // 避免停留在 CSS 默认 50% 而整条进度条“一半变紫”。
    if (els.mediaSeek) { els.mediaSeek.value = 0; setFill(els.mediaSeek); }
    if (els.mediaSpeed) renderSpeed(parseFloat(els.mediaSpeed.value) || 1);
    if (els.mediaVol) { setFill(els.mediaVol); if (els.mediaVolVal && document.activeElement !== els.mediaVolVal) els.mediaVolVal.value = (els.mediaVol.value || 100) + '%'; }
    return;
  }
  lastMedia = { duration: st.duration, currentTime: st.currentTime, muted: st.muted };
  // 媒体名称：仅当识别到 B站 时显示视频标题，其他网站不显示媒体名称
  if (els.mediaTrack) {
    if (st.biliTitle) { els.mediaTrack.hidden = false; els.mediaTrack.textContent = st.biliTitle; }
    else { els.mediaTrack.hidden = true; }
  }
  if (els.mediaStatus) els.mediaStatus.textContent = st.paused ? '已暂停' : '播放中';
  els.mediaPlay.disabled = false; els.mediaSeek.disabled = false; els.mediaVol.disabled = false; if (els.mediaMute) els.mediaMute.disabled = false;
  els.mediaPlay.textContent = st.paused ? '▶' : '⏸';
  els.mediaCur.textContent = fmtMedia(st.currentTime);
  els.mediaDur.textContent = st.duration ? fmtMedia(st.duration) : '∞';
  if (!mediaSeeking) {
    els.mediaSeek.value = st.duration ? ((st.currentTime / st.duration) * 100) : 0;
    setFill(els.mediaSeek);
  }
  // 音量可达 600%：滑块（进度条）上限仍为 100%，数值输入框可填至 600%，
  // 故按“有效音量”（st.volume 已包含增益，0~6）回填——滑块封顶 100%，输入框显示真实百分比。
  var effVol = (st.muted ? 0 : st.volume) || 0;
  els.mediaVol.value = Math.min(100, Math.round(effVol * 100)); setFill(els.mediaVol);
  if (els.mediaVolVal && document.activeElement !== els.mediaVolVal) els.mediaVolVal.value = Math.round(effVol * 100) + '%';
  if (els.mediaMute) { els.mediaMute.textContent = st.muted ? '取消静音' : '静音'; els.mediaMute.classList.toggle('on', !!st.muted); }
  renderSpeed(st.playbackRate);
}
async function mediaCtrl(action, extra) {
  if (typeof tabId !== 'number') return;
  const msg = Object.assign({ type: 'BAB_MEDIA_CTRL', action: action }, extra || {});
  const st = await mediaTab(tabId, msg);
  renderMediaState(st);
}
let mediaPoll = null, mediaSeeking = false;
async function mediaPollOnce() {
  if (view !== 'media' || typeof tabId !== 'number') return;
  const st = await mediaTab(tabId, { type: 'BAB_MEDIA_CTRL', action: 'state' });
  renderMediaState(st);
}
function startMediaPoll() { stopMediaPoll(); mediaPollOnce(); mediaPoll = setInterval(mediaPollOnce, 300); }
function stopMediaPoll() { if (mediaPoll) { clearInterval(mediaPoll); mediaPoll = null; } }
if (els.mediaPlay) els.mediaPlay.addEventListener('click', () => mediaCtrl('toggle'));
if (els.mediaSeek) {
  els.mediaSeek.addEventListener('input', () => {
    mediaSeeking = true;
    const t = lastMedia.duration ? (els.mediaSeek.value / 100) * lastMedia.duration : 0;
    els.mediaCur.textContent = fmtMedia(t);
    mediaCtrl('seek', { time: t });
  });
  els.mediaSeek.addEventListener('change', () => { mediaSeeking = false; });
}
// 倍速：进度条 + 档位圆圈（点击圆圈直接设速，右侧显示倍速数值）
const RATE_LEVELS = [0.5, 1, 1.25, 1.5, 2];
const SPEED_MIN = 0.5, SPEED_MAX = 2;
// 倍速数值可手动输入的范围（与进度条 0.5~2 分离：进度条保持不变，输入可更宽）
const EDIT_SPEED_MIN = 0.1, EDIT_SPEED_MAX = 16;
function fmtRate(v) { return (v % 1 === 0) ? v.toFixed(1) : String(v); }
function renderSpeed(rate) {
  const v = rate || 1;
  if (els.mediaSpeed) { els.mediaSpeed.value = v; setFill(els.mediaSpeed); }
  if (els.mediaSpeedVal && document.activeElement !== els.mediaSpeedVal) els.mediaSpeedVal.value = fmtRate(v) + '×';
  if (els.mediaSpeedDots) els.mediaSpeedDots.querySelectorAll('.speed-dot').forEach((d) => {
    d.classList.toggle('active', Math.abs(parseFloat(d.dataset.rate) - v) < 0.001);
  });
}
function buildSpeedDots() {
  if (!els.mediaSpeedDots) return;
  els.mediaSpeedDots.innerHTML = '';
  RATE_LEVELS.forEach((lv) => {
    const d = document.createElement('span');
    d.className = 'speed-dot'; d.dataset.rate = lv; d.title = fmtRate(lv) + '×';
    const pct = (lv - SPEED_MIN) / (SPEED_MAX - SPEED_MIN);
    d.style.left = 'calc(8px + (100% - 16px) * ' + pct + ')';
    els.mediaSpeedDots.appendChild(d);
  });
}
if (els.mediaSpeed) els.mediaSpeed.addEventListener('input', () => {
  const v = parseFloat(els.mediaSpeed.value);
  if (els.mediaSpeedVal && document.activeElement !== els.mediaSpeedVal) els.mediaSpeedVal.value = fmtRate(v) + '×';
  if (els.mediaSpeedDots) els.mediaSpeedDots.querySelectorAll('.speed-dot').forEach((d) => {
    d.classList.toggle('active', Math.abs(parseFloat(d.dataset.rate) - v) < 0.001);
  });
  mediaCtrl('rate', { value: v });
});
if (els.mediaSpeedDots) els.mediaSpeedDots.addEventListener('click', (e) => {
  const d = e.target.closest('.speed-dot'); if (!d) return;
  const v = parseFloat(d.dataset.rate);
  renderSpeed(v);
  mediaCtrl('rate', { value: v });
});
buildSpeedDots();
if (els.mediaVol) els.mediaVol.addEventListener('input', () => {
  if (els.mediaVolVal && document.activeElement !== els.mediaVolVal) els.mediaVolVal.value = els.mediaVol.value + '%';
  mediaCtrl('volume', { value: els.mediaVol.value / 100 });
});
if (els.mediaRescan) els.mediaRescan.addEventListener('click', () => { mediaCtrl('refresh'); });

// 倍速 / 音量数值直接编辑：点击输入具体数值（不再仅限滑动）
function applySpeedInput() {
  if (!els.mediaSpeedVal) return;
  let v = parseFloat(String(els.mediaSpeedVal.value).replace(/[^\d.]/g, ''));
  if (!isFinite(v)) v = 1;
  v = Math.min(EDIT_SPEED_MAX, Math.max(EDIT_SPEED_MIN, v));
  renderSpeed(v);
  mediaCtrl('rate', { value: v });
}
if (els.mediaSpeedVal) {
  els.mediaSpeedVal.addEventListener('focus', () => els.mediaSpeedVal.select());
  els.mediaSpeedVal.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.mediaSpeedVal.blur(); });
  els.mediaSpeedVal.addEventListener('blur', applySpeedInput);
}
function applyVolInput() {
  if (!els.mediaVolVal) return;
  let v = parseInt(String(els.mediaVolVal.value).replace(/[^\d]/g, ''), 10);
  if (!isFinite(v)) v = 100;
  // 数值输入上限 600%（滑块保持 100% 不变）；发送给媒体的 value 为 0~6，由 content 端增益节点放大。
  v = Math.min(600, Math.max(0, v));
  els.mediaVol.value = Math.min(100, v); setFill(els.mediaVol);
  if (els.mediaVolVal) els.mediaVolVal.value = v + '%';
  mediaCtrl('volume', { value: v / 100 });
}
if (els.mediaVolVal) {
  els.mediaVolVal.addEventListener('focus', () => els.mediaVolVal.select());
  els.mediaVolVal.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.mediaVolVal.blur(); });
  els.mediaVolVal.addEventListener('blur', applyVolInput);
}
// 时间进度条两侧快速调整按键：左 −5s / 右 +5s
function mediaSeekBy(delta) {
  if (typeof tabId !== 'number') return;
  const dur = lastMedia.duration || 0;
  let t = (lastMedia.currentTime || 0) + delta;
  t = dur > 0 ? Math.max(0, Math.min(dur, t)) : Math.max(0, t);
  mediaCtrl('seek', { time: t });
}
if (els.mediaSeekBack) els.mediaSeekBack.addEventListener('click', () => mediaSeekBy(-5));
if (els.mediaSeekFwd) els.mediaSeekFwd.addEventListener('click', () => mediaSeekBy(5));
function setMediaDefault(v) {
  mediaDefault = !!v;
  try {
    chrome.storage.sync.get('babSettings', (r) => {
      const s = (r && r.babSettings) || {};
      s.mediaDefault = mediaDefault;
      chrome.storage.sync.set({ babSettings: s });
    });
  } catch (e) {}
}

// ============ 初始化 ============
async function init() {
  try {
    chrome.storage.sync.get('babSettings', (r) => {
      try {
        const s = (r && r.babSettings) || {};
        settings = { ...SETTINGS_DEFAULTS, ...s, modules: { ...SETTINGS_DEFAULTS.modules, ...(s.modules || {}) }, moduleHome: { ...SETTINGS_DEFAULTS.moduleHome, ...(s.moduleHome || {}) } };
        mediaDefault = !!(s && s.mediaDefault);
        renderSettings(); applyTheme(); applyHomeVisibility(); updateMediaButton();
      } catch (e) { showError(e); }
    });

    const tab = await getActiveTab();
    tabId = tab && tab.id != null ? tab.id : 'global';
    const url = (tab && tab.url) || '';
    isEnhancedPage = ENHANCED.test(url);
    els.tabPill.textContent = isEnhancedPage ? hostOf(url) : (hostOf(url) || '任意网页');

    // 恢复本标签页「资源下载」开启状态：开启后在本网页标签页内一直保持
    try {
      chrome.storage.local.get(resDlKey(), (r) => {
        if (r && r[resDlKey()]) { if (dlToggle) dlToggle.checked = true; setDlRunning(true); startResLive(); }
      });
    } catch (e) {}

    els.boostCard.hidden = isEnhancedPage;
    applyHomeVisibility();

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
    initCaption();

    // 设置页修改主题/强调色时，当前打开的弹窗同步刷新
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes.babSettings || !changes.babSettings.newValue) return;
        const s = changes.babSettings.newValue;
        if (s.theme) settings.theme = s.theme;
        if (s.accent) settings.accent = s.accent;
        if (s.modules) settings.modules = { ...settings.modules, ...s.modules };
        if (s.moduleHome) settings.moduleHome = s.moduleHome;
        if (typeof s.mediaDefault === 'boolean') mediaDefault = s.mediaDefault;
        applyTheme();
        if (els.sThemeSeg) renderSettings();
        applyHomeVisibility(); updateMediaButton();
      });
    } catch (e) {}

    // 确保主视图可见；若记忆为媒体控制页，则默认进入媒体控制页
    showView(mediaDefault ? 'media' : 'main');
  } catch (e) {
    showError(e);
  }
}

// ============ 事件：顶部按钮 ============
// 媒体控制按键：主视图时点击进入媒体页；处于「返回初始界面」状态时点击回到主视图
els.openMedia.addEventListener('click', () => {
  if (mediaContext) { setMediaDefault(false); showView('main'); }
  else { setMediaDefault(true); showView('media'); }
});
els.openEQ.addEventListener('click', () => { if (view === 'eq') backFromSub(); else showView('eq'); });
els.eqDone.addEventListener('click', backFromSub);
els.openSettings.addEventListener('click', () => { if (view === 'settings') backFromSub(); else showView('settings'); });
els.settingsDone.addEventListener('click', backFromSub);
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

// ============ 事件：实时字幕开关 / 主视图参数 ============
els.capToggle.addEventListener('change', () => { if (els.capToggle.checked) startCap(); else stopCap(); });

// ============ 资源下载（猫爪式资源嗅探列表） ============
const dlToggle = document.getElementById('dlToggle');
const dlState = document.getElementById('dlState');
const dlParams = document.getElementById('dlParams');
const resList = document.getElementById('resList');
const resAllCheck = document.getElementById('resAllCheck');
const resRefresh = document.getElementById('resRefresh');
const resSelCount = document.getElementById('resSelCount');
let resItems = [];
let resPolling = null;

function byteToSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function extOf(url) {
  try { const p = new URL(url).pathname.split('/').pop(); const m = p.split('.'); return m.length > 1 ? m.pop().toLowerCase() : ''; } catch (e) { return ''; }
}
function sanitizeName(url, name, ext) {
  let base = name || ('media_' + Date.now());
  base = String(base).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
  if (ext && !base.toLowerCase().endsWith('.' + String(ext).toLowerCase())) base += '.' + ext;
  return base;
}
function renderRes() {
  if (!resList) return;
  resList.innerHTML = '';
  resItems.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'res-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'res-cb'; cb.checked = true; cb.dataset.i = i;
    cb.addEventListener('change', updateSelCount);
    const info = document.createElement('div'); info.className = 'res-info';
    const nm = document.createElement('div'); nm.className = 'res-name'; nm.textContent = it.name || extOf(it.url); nm.title = it.url;
    const meta = document.createElement('div'); meta.className = 'res-meta';
    meta.textContent = [it.ext ? it.ext.toUpperCase() : '', it.type ? it.type.split(';')[0] : '', byteToSize(it.size)].filter(Boolean).join('  ·  ');
    info.appendChild(nm); info.appendChild(meta);
    const acts = document.createElement('div'); acts.className = 'res-acts';
    const copyBtn = document.createElement('button'); copyBtn.className = 'icon-btn-mini'; copyBtn.textContent = '复制'; copyBtn.title = '复制链接';
    copyBtn.addEventListener('click', () => { try { navigator.clipboard.writeText(it.url); } catch (e) {} });
    const dlBtn = document.createElement('button'); dlBtn.className = 'icon-btn-mini dl'; dlBtn.textContent = '下载'; dlBtn.title = '下载';
    dlBtn.addEventListener('click', () => {
      try {
        chrome.downloads.download({ url: it.url, filename: sanitizeName(it.url, it.name, it.ext), saveAs: false }, () => {
          if (chrome.runtime.lastError) console.warn('[Audio无限+] 下载失败：', chrome.runtime.lastError.message);
        });
      } catch (e) { console.warn(e); }
    });
    acts.appendChild(copyBtn); acts.appendChild(dlBtn);
    row.appendChild(cb); row.appendChild(info); row.appendChild(acts);
    resList.appendChild(row);
  });
  if (resAllCheck) resAllCheck.checked = true;
  updateSelCount();
}
// 更新「已选/全部」计数 (a/b)
function updateSelCount() {
  if (!resSelCount) return;
  const total = resItems.length;
  let sel = 0;
  if (resList) resList.querySelectorAll('.res-cb').forEach((cb) => { if (cb.checked) sel++; });
  resSelCount.textContent = sel + '/' + total;
  if (resAllCheck) resAllCheck.checked = (total > 0 && sel === total);
}
function loadRes() {
  if (typeof tabId !== 'number') return;
  try {
    chrome.runtime.sendMessage({ type: 'BAB_GET_MEDIA', tabId: tabId }, (list) => {
      if (chrome.runtime.lastError || !Array.isArray(list)) return;
      // 最新嗅探到的排在最前
      resItems = list.slice().reverse();
      renderRes();
    });
  } catch (e) {}
}
function startResLive() {
  loadRes();
  if (resPolling) clearInterval(resPolling);
  resPolling = setInterval(loadRes, 2500);
}
function stopResLive() {
  if (resPolling) { clearInterval(resPolling); resPolling = null; }
  resItems = [];
  if (resList) resList.innerHTML = '';
}
function setDlRunning(r) {
  if (dlState) { dlState.textContent = r ? '已开启' : '已关闭'; dlState.className = 'switch-state' + (r ? ' on' : ''); }
  if (dlParams) dlParams.hidden = !r;
}
if (dlToggle) dlToggle.addEventListener('change', () => {
  if (dlToggle.checked) { setDlRunning(true); startResLive(); }
  else { setDlRunning(false); stopResLive(); }
  try { chrome.storage.local.set({ [resDlKey()]: dlToggle.checked }); } catch (e) {}
});
if (resRefresh) resRefresh.addEventListener('click', loadRes);
if (resAllCheck) resAllCheck.addEventListener('change', () => {
  if (!resList) return;
  resList.querySelectorAll('.res-cb').forEach((cb) => { cb.checked = resAllCheck.checked; });
  updateSelCount();
});
// 批量下载（并行，提高下载速度）
const resBatchDl = document.getElementById('resBatchDl');
if (resBatchDl) resBatchDl.addEventListener('click', () => {
  if (!resList) return;
  let n = 0;
  resItems.forEach((it, i) => {
    const cb = resList.querySelector('.res-cb[data-i="' + i + '"]');
    if (cb && cb.checked) {
      n++;
      try {
        chrome.downloads.download({ url: it.url, filename: sanitizeName(it.url, it.name, it.ext), saveAs: false }, () => {
          if (chrome.runtime.lastError) console.warn('[Audio无限+] 批量下载失败：', chrome.runtime.lastError.message);
        });
      } catch (e) {}
    }
  });
});

// ---------- 录制下载（重新加入：录制当前标签页音频并直接保存） ----------
const recBtn = document.getElementById('recBtn');
const recState = document.getElementById('recState');
const recTime = document.getElementById('recTime');
let recRunning = false, recTimer = null, recStartedAt = 0;
function recFmt(sec) { sec = Math.max(0, sec | 0); const m = (sec / 60) | 0, s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
function setRecRunning(r) {
  recRunning = r;
  if (recBtn) recBtn.textContent = r ? '停止并下载' : '开始录制';
  if (recState) { recState.textContent = r ? '录制中' : '未录制'; recState.className = 'switch-state' + (r ? ' on' : ''); }
}
function recTick() { if (recTime) recTime.textContent = recFmt((Date.now() - recStartedAt) / 1000); }
function stopRecIfAny() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  setRecRunning(false);
  if (recTime) recTime.textContent = '00:00';
  try { chrome.runtime.sendMessage({ type: 'BAB_DL_STOP' }); } catch (e) {}
}
function recStart() {
  try {
    chrome.runtime.sendMessage({ type: 'BAB_DL_START', targetTabId: (typeof tabId === 'number' ? tabId : null) }, (res) => {
      if (res && res.ok === false) { setRecRunning(false); if (recState) recState.textContent = res.error || '启动失败'; return; }
      setRecRunning(true); recStartedAt = Date.now(); recTick();
      if (recTimer) clearInterval(recTimer);
      recTimer = setInterval(recTick, 500);
    });
  } catch (e) { setRecRunning(false); }
}
function recStop() {
  if (!recRunning) return;
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  if (recState) recState.textContent = '正在保存…';
  try { chrome.runtime.sendMessage({ type: 'BAB_DL_STOP' }); } catch (e) {}
}
if (recBtn) recBtn.addEventListener('click', () => { if (recRunning) recStop(); else recStart(); });
// 同步后台录制状态（popup 重新打开时）
try {
  chrome.runtime.sendMessage({ type: 'BAB_DL_QUERY' }, (res) => {
    if (res && res.active) { setRecRunning(true); recStartedAt = Date.now(); recTick(); if (recTimer) clearInterval(recTimer); recTimer = setInterval(recTick, 500); }
  });
} catch (e) {}

// 实时新增资源 / 录制状态 广播
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'BAB_MEDIA_ADDED') {
      if (msg.tabId !== tabId) return;
      if (!resItems.some((it) => it.url === msg.item.url)) {
        resItems.unshift(msg.item);
        renderRes();
      }
    } else if (msg.type === 'BAB_DL_INFO') {
      if (!recState) return;
      const t = String(msg.msg || '').slice(0, 40);
      recState.textContent = t || '录制中';
      if (t.indexOf('已保存') >= 0 || t.indexOf('已停止') >= 0 || t.indexOf('失败') >= 0 || t.indexOf('错误') >= 0) {
        setRecRunning(false);
        if (recTime) recTime.textContent = '00:00';
      }
    }
  });
} catch (e) {}

function onCapEngine() {
  if (!capSub) return;
  capSub.engine = els.capEngine.value;
  if (capSub.engine === 'custom') capSub.custom = capSub.custom || { type: 'custom_http' };
  if (capSub.engine === 'mimo') capSub.mimo = capSub.mimo || { url: 'https://api.xiaomimimo.com/v1/chat/completions', apiKey: '', model: 'mimo-v2.5-asr' };
  renderMainCaption(); saveCap();
  // 未配置 API 时，跳转到「设置 → 实时字幕」让用户完成配置
  if (capSub.engine === 'mimo' && !(capSub.mimo && capSub.mimo.apiKey)) { showView('settings'); return; }
  if (capSub.engine === 'custom' && !((capSub.custom && capSub.custom.endpoint) && capSub.custom.apiKey)) { showView('settings'); return; }
}
function onCapLang() { if (!capSub) return; capSub.lang = els.capLang.value; saveCap(); }
function onCapSrc(e) { const btn = e.target.closest('.seg-btn'); if (!btn || btn.disabled) return; if (!capSub) return; capSub.source = btn.dataset.src; renderMainCaption(); saveCap(); }
els.capEngine.addEventListener('change', onCapEngine);
els.capLang.addEventListener('change', onCapLang);
els.capSrcSeg.addEventListener('click', onCapSrc);

// 初始界面不再提供 API 设置：API 配置统一在「设置 → 实时字幕」（见 renderMainCaption / onCapEngine）

// ============ 事件：设置视图 - 外观 / 模块 ============
PRESET_ACCENTS.forEach((c) => {
  const s = document.createElement('div');
  s.className = 'swatch'; s.dataset.color = c; s.style.background = c;
  s.addEventListener('click', () => { settings.accent = c; applyTheme(); renderSettings(); saveSettings(); });
  els.sSwatches.appendChild(s);
});
els.sThemeSeg.addEventListener('click', (e) => { const btn = e.target.closest('.seg-btn'); if (!btn) return; settings.theme = btn.dataset.theme; applyTheme(); renderSettings(); saveSettings(); });
els.sAccentInput.addEventListener('input', () => { settings.accent = els.sAccentInput.value; applyTheme(); renderSettings(); saveSettings(); });
// 关闭某模块的“显示”时，强制关闭其“启用”并停止正在运行的功能（显示 是 启用 的前置条件）
function stopModuleFeature(mod) {
  try {
    if (mod === 'caption') chrome.runtime.sendMessage({ type: 'BAB_CAP_STOP' });
    else if (mod === 'resourcedl') {
      if (dlToggle) dlToggle.checked = false;
      setDlRunning(false);
      stopResLive();
      stopRecIfAny();
      try { chrome.runtime.sendMessage({ type: 'BAB_CLEAR_MEDIA', tabId: (typeof tabId === 'number' ? tabId : null) }); } catch (e) {}
    }
    else if (mod === 'enhance' && current.enabled) toggleEnhance();
  } catch (e) {}
}
document.querySelectorAll('#settingsPanel .mod-row[data-mod]').forEach((row) => {
  const home = row.querySelector('input[data-role="home"]');
  if (home) home.addEventListener('change', () => {
    const mod = row.dataset.mod;
    const on = !!home.checked;
    settings.moduleHome[mod] = on;
    // 显示 是 启用 的前置条件：关闭显示即关闭启用（且停止运行中的功能）
    settings.modules[mod] = on;
    if (!on) stopModuleFeature(mod);
    // 媒体控制：关闭后隐藏右上角入口，并重置“默认进入媒体页”的记忆
    if (mod === 'media' && !on) {
      setMediaDefault(false);
      if (view === 'media') showView('main');
    }
    saveSettings(); applyHomeVisibility(); updateMediaButton();
  });
});

// ============ 事件：设置视图 - 实时字幕基础参数 ============
function onSCapEngine() { if (!capSub) return; capSub.engine = els.sCapEngine.value; if (capSub.engine === 'custom') capSub.custom = capSub.custom || { type: 'custom_http' }; if (capSub.engine === 'mimo') capSub.mimo = capSub.mimo || { url: 'https://api.xiaomimimo.com/v1/chat/completions', apiKey: '', model: 'mimo-v2.5-asr' }; renderMainCaption(); renderSettingsCaption(); saveCap(); }
function onSCapLang() { if (!capSub) return; capSub.lang = els.sCapLang.value; saveCap(); }
function onSCapSrc(e) { const btn = e.target.closest('.seg-btn'); if (!btn) return; if (!capSub) return; capSub.source = btn.dataset.src; setSegActive(els.sCapSrcSeg, capSub.source, 'data-src'); saveCap(); }
els.sCapEngine.addEventListener('change', onSCapEngine);
els.sCapLang.addEventListener('change', onSCapLang);
els.sCapSrcSeg.addEventListener('click', onSCapSrc);

// 设置视图：自定义 AI
function onSCapEndpoint() { if (!capSub) return; capSub.custom = capSub.custom || {}; capSub.custom.endpoint = els.sCapEndpoint.value; saveCap(); }
function onSCapApiKey() { if (!capSub) return; capSub.custom = capSub.custom || {}; capSub.custom.apiKey = els.sCapApiKey.value; saveCap(); }
function onSCapModel() { if (!capSub) return; capSub.custom = capSub.custom || {}; capSub.custom.model = els.sCapModel.value; saveCap(); }
function onSCapProto(e) { const btn = e.target.closest('.seg-btn'); if (!btn || !capSub) return; capSub.custom = capSub.custom || {}; capSub.custom.type = btn.dataset.proto; setSegActive(els.sCapProtoSeg, capSub.custom.type, 'data-proto'); els.sCapTip.textContent = capTipText(capSub.engine, capSub.custom.type); saveCap(); }
function onSCapHeaders() { if (!capSub) return; capSub.custom = capSub.custom || {}; capSub.custom.headers = els.sCapHeaders.value; saveCap(); }
els.sCapEndpoint.addEventListener('input', onSCapEndpoint);
els.sCapApiKey.addEventListener('input', onSCapApiKey);
els.sCapModel.addEventListener('input', onSCapModel);
els.sCapProtoSeg.addEventListener('click', onSCapProto);
els.sCapHeaders.addEventListener('input', onSCapHeaders);
function onSCapMimoUrl() { if (!capSub) return; capSub.mimo = capSub.mimo || {}; capSub.mimo.url = els.sCapMimoUrl.value; saveCap(); }
function onSCapMimoKey() { if (!capSub) return; capSub.mimo = capSub.mimo || {}; capSub.mimo.apiKey = els.sCapMimoKey.value; saveCap(); }
els.sCapMimoUrl.addEventListener('input', onSCapMimoUrl);
els.sCapMimoKey.addEventListener('input', onSCapMimoKey);

// ============ 事件：设置视图 - 字幕样式 ============
function capStyleChanged() {
  if (!capSub) return;
  capSub.style = capSub.style || {};
  capSub.style.fontFamily = els.sCapFont.value;
  capSub.style.fontSize = +els.sCapSize.value;
  capSub.style.color = els.sCapColor.value;
  capSub.style.bgColor = els.sCapBg.value;
  capSub.style.bgOpacity = (+els.sCapBgOp.value) / 100;
  capSub.style.align = (els.sCapAlignSeg.querySelector('.seg-btn.active') || {}).dataset?.align || 'center';
  capSub.style.maxWidth = +els.sCapMaxw.value;
  capSub.style.height = +els.sCapHeight.value;
  saveCap();
  updateStylePreview();
}
function onSegClick(root, cb) {
  return (e) => { const b = e.target.closest('.seg-btn'); if (!b) return; root.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b)); if (cb) cb(); };
}
els.sCapFont.addEventListener('change', capStyleChanged);
els.sCapSize.addEventListener('input', () => { els.sCapSizeVal.textContent = els.sCapSize.value; setFill(els.sCapSize); capStyleChanged(); });
els.sCapColor.addEventListener('input', capStyleChanged);
els.sCapBg.addEventListener('input', capStyleChanged);
els.sCapBgOp.addEventListener('input', () => { els.sCapBgOpVal.textContent = els.sCapBgOp.value; setFill(els.sCapBgOp); capStyleChanged(); });
els.sCapAlignSeg.addEventListener('click', onSegClick(els.sCapAlignSeg, capStyleChanged));
els.sCapMaxw.addEventListener('input', () => { els.sCapMaxwVal.textContent = els.sCapMaxw.value; setFill(els.sCapMaxw); capStyleChanged(); });
els.sCapHeight.addEventListener('input', () => { els.sCapHeightVal.textContent = els.sCapHeight.value; setFill(els.sCapHeight); capStyleChanged(); });

// 导出格式
els.sCapExportSeg.addEventListener('click', onSegClick(els.sCapExportSeg, () => {
  if (!capSub) return;
  capSub.exportFormat = (els.sCapExportSeg.querySelector('.seg-btn.active') || {}).dataset?.fmt || 'srt';
  saveCap();
}));

// 导出按钮
els.sExportBtn.addEventListener('click', exportLatestSession);
els.sOpenHistory.addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('captions/history.html') }); });

// ============ 恢复默认 ============
// 实时字幕设置保持不变（不重置），仅重置外观/模块显示
els.resetBtn.addEventListener('click', () => {
  settings = { ...SETTINGS_DEFAULTS, modules: { ...SETTINGS_DEFAULTS.modules }, moduleHome: { ...SETTINGS_DEFAULTS.moduleHome } };
  applyTheme(); renderSettings(); saveSettings(); applyHomeVisibility();
});

init();
