/*
 * Audio无限+ - 本地播放器页面逻辑
 * 复用共享音频引擎 audio-engine.js，对“用户选择的本地文件”做实时增强。
 * 不修改、不上传原文件，仅播放时实时处理。
 */
(() => {
  'use strict';

  const { AudioEngine, PRESETS, DEFAULT_STATE, DEFAULT_MODULES } = window.AudioBoosterEngine;
  const engine = new AudioEngine();
  engine.state = { ...DEFAULT_STATE, modules: { ...DEFAULT_MODULES } };
  // 暴露给 stt.js / recorder.js 复用（它们需要 getRecordingStream() 拿到已增强的音频流）
  window.__babEngine = engine;

  const $ = (id) => document.getElementById(id);
  const fileInput = $('fileInput');
  const pickBtn = $('pickBtn');
  const dropZone = $('dropZone');
  const controls = $('controls');
  const audio = $('audio');
  const enableToggle = $('enableToggle');
  const engineBadge = $('engineBadge');
  const presetsBox = $('presets');
  const clarity = $('clarity');
  const clarityVal = $('clarityVal');
  const width = $('width');
  const widthVal = $('widthVal');
  const masterGain = $('masterGain');
  const masterVal = $('masterVal');
  const fileNameEl = $('fileName');
  const openSettings = $('openSettings');
  const eqMount = $('eqMount');

  const mediaTrack = $('mediaTrack');
  const mediaPlay = $('mediaPlay');
  const mediaSeek = $('mediaSeek');
  const mediaCur = $('mediaCur');
  const mediaDur = $('mediaDur');
  const mediaVol = $('mediaVol');
  const mediaMute = $('mediaMute');
  const mediaSpeed = $('mediaSpeed');
  const mediaSpeedVal = $('mediaSpeedVal');
  const mediaSpeedDots = $('mediaSpeedDots');

  const STORE_KEY = 'babState_local';
  let currentURL = null;
  let surroundOn = true; // 环绕音效改由初始界面「环绕音效」滑块（width）控制，始终可用
  let eqHandle = null;
  let mediaSeeking = false;
  const RATE_LEVELS = [0.5, 1, 1.25, 1.5, 2];
  const SPEED_MIN = 0.5, SPEED_MAX = 2;

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
    try {
      chrome.storage.sync.get('babSettings', (r) => {
        const s = (r && r.babSettings) || {};
        if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
        if (s.accent) {
          document.documentElement.style.setProperty('--accent', s.accent);
          document.documentElement.style.setProperty('--accent-light', lightenColor(s.accent, 0.35));
          document.documentElement.style.setProperty('--accent-dark', darkenColor(s.accent, 0.25));
        }
        syncWidthEnabled();
      });
    } catch (e) {}
  }
  function setFill(el) {
    const min = +el.min, max = +el.max, v = +el.value;
    el.style.setProperty('--fill', ((v - min) / (max - min)) * 100 + '%');
  }
  function clarityLabel(v) {
    if (v < 25) return '暖'; if (v < 45) return '偏暖';
    if (v <= 55) return '标准'; if (v <= 72) return '清亮'; return '极清亮';
  }
  function syncWidthEnabled() {
    if (!surroundOn) {
      width.disabled = true; widthVal.textContent = '需开启环绕模块';
      width.style.opacity = '.45';
    } else {
      width.disabled = false; width.style.opacity = '1';
      widthVal.textContent = engine.state.width > 100 ? engine.state.width + '%' : '关';
    }
  }

  // ---------------- 预设 ----------------
  Object.entries(PRESETS).forEach(([key, p]) => {
    const btn = document.createElement('button');
    btn.className = 'preset'; btn.dataset.preset = key; btn.textContent = p.label;
    btn.addEventListener('click', () => {
      engine.state.preset = key;
      engine.state.clarity = 50; // 切预设回到基线
      applyUI(); engine.applyAll(); save();
    });
    presetsBox.appendChild(btn);
  });
  function markActivePreset(key) {
    presetsBox.querySelectorAll('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === key));
  }

  // ---------------- 文件载入 ----------------
  function loadFile(file) {
    if (!file) return;
    if (currentURL) URL.revokeObjectURL(currentURL);
    currentURL = URL.createObjectURL(file);
    audio.src = currentURL;
    audio.dataset.name = file.name.replace(/\.[^.]+$/, ''); // 去扩展名，供 stt 下载命名
    const displayName = file.name;
    fileNameEl.textContent = '当前文件：' + displayName;
    if (mediaTrack) mediaTrack.textContent = displayName;
    controls.hidden = false; audio.hidden = false; audio.load();
    engine.attach([audio]);
    if (eqHandle) eqHandle.refresh(); // 显示后按实际尺寸重绘曲线
    setBadge('idle');
  }
  pickBtn.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('click', (e) => { if (e.target === pickBtn) return; fileInput.click(); });
  fileInput.addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); }));
  dropZone.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });

  // ---------------- 控制 ----------------
  enableToggle.addEventListener('change', () => {
    engine.state.enabled = enableToggle.checked; engine.ensureContext(); engine.applyAll(); save();
  });
  clarity.addEventListener('input', () => {
    engine.state.clarity = +clarity.value;
    clarityVal.textContent = clarityLabel(engine.state.clarity); setFill(clarity);
    engine.applyAll(); save();
  });
  width.addEventListener('input', () => {
    engine.state.width = +width.value;
    widthVal.textContent = engine.state.width > 100 ? engine.state.width + '%' : '关'; setFill(width);
    engine.applyAll(); save();
  });
  masterGain.addEventListener('input', () => {
    const v = parseInt(masterGain.value, 10);
    engine.state.masterGain = v / 100; masterVal.textContent = v + '%'; setFill(masterGain);
    engine.applyAll(); save();
  });
  audio.addEventListener('play', () => { engine.ensureContext(); engine.applyAll(); setBadge('run'); });
  audio.addEventListener('pause', () => setBadge(engine.state.enabled ? 'on' : 'idle'));

  function setBadge(state) {
    const map = { idle: ['待播放', ''], on: ['已开启（未播放）', 'on'], run: ['运行中', 'run'] };
    const [text, cls] = map[state] || map.idle;
    engineBadge.textContent = text; engineBadge.className = 'badge ' + cls;
  }

  function applyUI() {
    enableToggle.checked = engine.state.enabled;
    clarity.value = engine.state.clarity; clarityVal.textContent = clarityLabel(engine.state.clarity); setFill(clarity);
    width.value = engine.state.width; setFill(width);
    masterGain.value = Math.round(engine.state.masterGain * 100); masterVal.textContent = masterGain.value + '%'; setFill(masterGain);
    markActivePreset(engine.state.preset);
    syncWidthEnabled();
  }

  // ---------------- 持久化 ----------------
  function save() {
    try { chrome.storage.sync.set({ [STORE_KEY]: engine.state }); } catch (e) {}
  }
  function load() {
    applyTheme();
    try {
      chrome.storage.sync.get([STORE_KEY, 'babSettings'], (res) => {
        if (res && res[STORE_KEY]) {
          engine.state = { ...DEFAULT_STATE, modules: { ...DEFAULT_MODULES }, ...res[STORE_KEY] };
          if (res[STORE_KEY].modules) engine.state.modules = { ...DEFAULT_MODULES, ...res[STORE_KEY].modules };
        }
        // 与全局均衡器保持一致（弹窗/设置页改过的 EQ 在本地播放器同样生效）
        const s = res && res.babSettings;
        if (s && s.eq && Array.isArray(s.eq.bands)) {
          engine.state.eq = { enabled: s.eq.enabled !== false, bands: s.eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
        }
        applyUI(); setBadge('idle');
        mountLocalEq();
      });
    } catch (e) { applyUI(); mountLocalEq(); }

    // 设置页 / 弹窗修改模块开关或 EQ 时实时同步
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'sync' || !ch.babSettings) return;
        const s = ch.babSettings.newValue || {};
        syncWidthEnabled();
        if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
        if (s.accent) {
          document.documentElement.style.setProperty('--accent', s.accent);
          document.documentElement.style.setProperty('--accent-light', lightenColor(s.accent, 0.35));
          document.documentElement.style.setProperty('--accent-dark', darkenColor(s.accent, 0.25));
        }
        if (s.eq && Array.isArray(s.eq.bands)) {
          const incoming = { enabled: s.eq.enabled !== false, bands: s.eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
          const cur = { enabled: engine.state.eq.enabled !== false, bands: engine.state.eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
          if (JSON.stringify(incoming) === JSON.stringify(cur)) return; // 自己改的，跳过
          engine.state.eq = incoming;
          engine.applyAll();
          if (eqHandle) eqHandle.refresh();
        }
      });
    } catch (e) {}
  }

  // ---------------- 内联高级均衡器（与全局 EQ 共享） ----------------
  function mountLocalEq() {
    if (eqHandle || !eqMount || typeof window.mountEqPanel !== 'function') return;
    eqHandle = window.mountEqPanel(eqMount, {
      getModel: () => engine.state.eq,
      setModel: (m) => {
        engine.state.eq = m;
        engine.applyAll();
        save();
        // 同步写回全局，使弹窗 / 其它标签页共享同一套 EQ
        try {
          chrome.storage.sync.get('babSettings', (r) => {
            const s = (r && r.babSettings) || {};
            s.eq = { enabled: m.enabled, bands: m.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
            chrome.storage.sync.set({ babSettings: s });
          });
        } catch (e) {}
      }
    });
  }

  // ---------------- 设置：在当前页内打开（覆盖层 + iframe 复用 options 页） ----------------
  const settingsOverlay = $('settingsOverlay');
  const settingsBack = $('settingsBack');
  const settingsFrame = $('settingsFrame');
  let settingsFrameLoaded = false;

  function openSettingsPanel() {
    if (!settingsFrameLoaded) {
      // 懒加载，避免页面打开时即拉起 options 页
      settingsFrame.src = '../options/options.html?embed=1';
      settingsFrameLoaded = true;
    }
    settingsOverlay.hidden = false;
    document.body.classList.add('settings-open');
  }
  function closeSettingsPanel() {
    settingsOverlay.hidden = true;
    document.body.classList.remove('settings-open');
    // 关闭后回写：刷新主题/强调色与 EQ，确保页内改动即时生效
    applyTheme();
    if (eqHandle) eqHandle.refresh();
  }
  if (openSettings) openSettings.addEventListener('click', (e) => { e.preventDefault(); openSettingsPanel(); });
  if (settingsBack) settingsBack.addEventListener('click', (e) => { e.preventDefault(); closeSettingsPanel(); });
  // 按 Esc 关闭设置
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOverlay && !settingsOverlay.hidden) closeSettingsPanel();
  });

  // ---------------- 媒体控制（本地 <audio>） ----------------
  function fmtMedia(sec) {
    sec = sec || 0;
    const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return h > 0 ? (h + ':' + p(m) + ':' + p(s)) : (p(m) + ':' + p(s));
  }
  function renderMedia() {
    if (mediaCur) mediaCur.textContent = fmtMedia(audio.currentTime);
    if (mediaDur) mediaDur.textContent = audio.duration ? fmtMedia(audio.duration) : '00:00';
    if (mediaSeek && !mediaSeeking) {
      mediaSeek.value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      setFill(mediaSeek);
    }
    if (mediaVol) { mediaVol.value = Math.round(audio.volume * 100); setFill(mediaVol); }
    if (mediaMute) {
      mediaMute.textContent = audio.muted ? '取消静音' : '静音';
      mediaMute.classList.toggle('on', audio.muted);
    }
    if (mediaPlay) mediaPlay.textContent = audio.paused ? '▶' : '⏸';
    renderSpeed(audio.playbackRate);
  }
  function fmtRate(v) { return (v % 1 === 0) ? v.toFixed(1) : String(v); }
  function renderSpeed(rate) {
    const v = rate || 1;
    if (mediaSpeed) { mediaSpeed.value = v; setFill(mediaSpeed); }
    if (mediaSpeedVal) mediaSpeedVal.textContent = fmtRate(v) + '×';
    if (mediaSpeedDots) {
      mediaSpeedDots.querySelectorAll('.speed-dot').forEach((d) => {
        d.classList.toggle('active', Math.abs(parseFloat(d.dataset.rate) - v) < 0.001);
      });
    }
  }
  function buildSpeedDots() {
    if (!mediaSpeedDots) return;
    mediaSpeedDots.innerHTML = '';
    RATE_LEVELS.forEach((lv) => {
      const d = document.createElement('span');
      d.className = 'speed-dot'; d.dataset.rate = lv; d.title = fmtRate(lv) + '×';
      const pct = (lv - SPEED_MIN) / (SPEED_MAX - SPEED_MIN);
      d.style.left = 'calc(8px + (100% - 16px) * ' + pct + ')';
      mediaSpeedDots.appendChild(d);
    });
  }

  if (mediaPlay) mediaPlay.addEventListener('click', () => { if (audio.paused) audio.play(); else audio.pause(); });
  if (mediaSeek) {
    mediaSeek.addEventListener('input', () => {
      mediaSeeking = true;
      const t = audio.duration ? (mediaSeek.value / 100) * audio.duration : 0;
      audio.currentTime = t; mediaCur.textContent = fmtMedia(t);
    });
    mediaSeek.addEventListener('change', () => { mediaSeeking = false; });
  }
  if (mediaVol) mediaVol.addEventListener('input', () => { audio.volume = mediaVol.value / 100; });
  if (mediaMute) mediaMute.addEventListener('click', () => { audio.muted = !audio.muted; });
  if (mediaSpeed) mediaSpeed.addEventListener('input', () => { const v = parseFloat(mediaSpeed.value); audio.playbackRate = v; renderSpeed(v); });
  if (mediaSpeedDots) mediaSpeedDots.addEventListener('click', (e) => {
    const d = e.target.closest('.speed-dot'); if (!d) return;
    const v = parseFloat(d.dataset.rate); audio.playbackRate = v; renderSpeed(v);
  });
  audio.addEventListener('timeupdate', renderMedia);
  audio.addEventListener('durationchange', renderMedia);
  audio.addEventListener('volumechange', renderMedia);
  audio.addEventListener('ratechange', renderMedia);
  audio.addEventListener('loadedmetadata', renderMedia);
  buildSpeedDots();

  load();
})();
