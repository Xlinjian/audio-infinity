/*
 * Audio无限+ - Content Script
 * 在 B站 / 百度网盘 / 本地 file:// 页面的媒体元素上注入实时音频增强。
 * 音频处理核心逻辑见共享模块 audio-engine.js（已通过 manifest 在本脚本前加载）。
 *
 * 2.0 新增：按标签页独立状态（babState_<tabId>），不同标签页互不干扰。
 */
(() => {
  'use strict';

  if (window.__BAB_INJECTED__) return;
  window.__BAB_INJECTED__ = true;

  const LOG = (...a) => console.debug('[Audio无限+]', ...a);
  const { AudioEngine, PRESETS, DEFAULT_STATE, DEFAULT_MODULES } = window.AudioBoosterEngine;

  const engine = new AudioEngine();

  // ---------------- 获取自身 tabId（用于分标签页状态） ----------------
  function getTabId() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (id) => { if (!done) { done = true; resolve(id); } };
      try {
        chrome.runtime.sendMessage({ type: 'BAB_WHOAMI' }, (r) => {
          finish(r && r.tabId != null ? r.tabId : 'global');
        });
      } catch (e) { /* ignore */ }
      // 兜底：若后台未响应，使用全局键，保证功能可用
      setTimeout(() => finish('global'), 150);
    });
  }

  // ---------------- 媒体元素发现 ----------------
  function grabMedia() {
    engine.attach(document.querySelectorAll('video, audio'));
    return engine.getStats().mediaCount;
  }

  // 统一的状态响应（含媒体计数）
  function stateResponse() {
    grabMedia();
    return {
      ok: true,
      state: engine.state,
      videoCount: engine.getStats().mediaCount,
      contextState: engine.ctx ? engine.ctx.state : 'none'
    };
  }

  const observer = new MutationObserver(() => { grabMedia(); });
  function startObserving() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  const resumeOnce = () => {
    engine.ensureContext();
    window.removeEventListener('click', resumeOnce);
    window.removeEventListener('keydown', resumeOnce);
  };
  window.addEventListener('click', resumeOnce);
  window.addEventListener('keydown', resumeOnce);

  // ---------------- 状态持久化（按标签页） ----------------
  let tabId = 'global';
  function stateKey() { return 'babState_' + tabId; }

  function cloneEq(eq) {
    if (!eq || !Array.isArray(eq.bands)) return null;
    return { enabled: !!eq.enabled, bands: eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get('babSettings', (res) => {
        const s = (res && res.babSettings) || {};
        if (s.modules) engine.state.modules = { ...DEFAULT_MODULES, ...s.modules };
        const eq = cloneEq(s.eq);
        if (eq) engine.state.eq = eq;
        applyThemeFromSettings(s);
      });
    } catch (e) {}
  }
  function applyThemeFromSettings(s) {
    if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
    if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
  }

  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(stateKey(), (res) => {
          const st = res && res[stateKey()];
          if (st) engine.state = { ...DEFAULT_STATE, modules: { ...DEFAULT_MODULES }, ...st };
          if (st && st.modules) engine.state.modules = { ...DEFAULT_MODULES, ...st.modules };
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }
  function saveState() {
    try {
      chrome.storage.sync.set({ [stateKey()]: engine.state });
    } catch (e) {}
    try {
      chrome.runtime.sendMessage({ type: 'BAB_STATE_CHANGED', enabled: engine.state.enabled, tabId });
    } catch (e) {}
  }

  // 设置页 / 高级均衡器修改模块开关或 EQ 时实时同步
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.babSettings) {
        const s = changes.babSettings.newValue || {};
        if (s.modules) engine.state.modules = { ...DEFAULT_MODULES, ...s.modules };
        const eq = cloneEq(s.eq);
        if (eq) engine.state.eq = eq;
        applyThemeFromSettings(s);
        engine.applyAll();
      }
    });
  } catch (e) {}

  // ---------------- 消息通信 ----------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'BAB_GET_STATE':
        sendResponse({
          state: engine.state,
          presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.label])),
          videoCount: engine.getStats().mediaCount,
          contextState: engine.ctx ? engine.ctx.state : 'none'
        });
        break;
      case 'BAB_SET_STATE':
        engine.state = { ...engine.state, ...msg.state };
        engine.ensureContext();
        grabMedia();
        engine.applyAll();
        sendResponse(stateResponse());
        saveState();
        break;
      case 'BAB_TOGGLE':
        engine.state.enabled = !engine.state.enabled;
        engine.ensureContext();
        grabMedia();
        engine.applyAll();
        sendResponse(stateResponse());
        saveState();
        break;
      default:
        break;
    }
    return true; // 异步响应
  });

  // ---------------- 启动 ----------------
  getTabId().then((id) => {
    tabId = id;
    loadSettings();
    loadState().then(() => {
      grabMedia();
      startObserving();
      setInterval(grabMedia, 2500);
      LOG('已加载（tab=' + tabId + '），当前状态：', engine.state.enabled ? '开启' : '关闭');
    });
  });
})();
