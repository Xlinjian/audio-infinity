/*
 * Audio无限+ - 全局音量增强注入脚本（Volume Master 风格）
 * 由 popup 通过 chrome.scripting.executeScript 注入到“任意网页”的当前标签页。
 * 复用共享音频引擎 audio-engine.js：接管页面内所有 <video>/<audio>，
 * 在媒体元素与扬声器之间插入一个 GainNode，将音量放大至最高 600%。
 *
 * 与站内增强（B站/网盘/file://）互斥：那些页面已由 content.js 接管，
 * popup 在站内会隐藏本卡片，避免对同一媒体元素重复 createMediaElementSource。
 *
 * 2.0 新增：按标签页独立状态（babBoost_<tabId>）。
 */
(() => {
  'use strict';

  if (window.__VM_BOOSTER_INJECTED__) return;
  window.__VM_BOOSTER_INJECTED__ = true;

  const { AudioEngine, DEFAULT_STATE } = window.AudioBoosterEngine;
  const engine = new AudioEngine();
  engine.state = {
    ...DEFAULT_STATE,
    enabled: false,
    masterGain: 1.0,
    clarity: 50,
    width: 100,
    modules: { ...DEFAULT_STATE.modules, surround: false }
  };

  function getTabId() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (id) => { if (!done) { done = true; resolve(id); } };
      try {
        chrome.runtime.sendMessage({ type: 'BAB_WHOAMI' }, (r) => {
          finish(r && r.tabId != null ? r.tabId : 'global');
        });
      } catch (e) {}
      setTimeout(() => finish('global'), 150);
    });
  }

  let tabId = 'global';
  function boostKey() { return 'babBoost_' + tabId; }

  function grab() { engine.attach(document.querySelectorAll('video, audio')); }

  grab();
  const obs = new MutationObserver(grab);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(grab, 2500);

  document.addEventListener('play', () => engine.ensureContext(), true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'BAB_BOOST_SET') return;
    if (typeof msg.enabled === 'boolean') engine.state.enabled = msg.enabled;
    // 纯音量工具：开启时用放大倍数；关闭时恢复原始音量（增益 1）
    if (typeof msg.gain === 'number') engine.state.masterGain = engine.state.enabled ? msg.gain : 1;
    engine.ensureContext();
    grab();
    engine.applyAll();
    try { chrome.storage.sync.set({ [boostKey()]: { enabled: engine.state.enabled, gain: engine.state.masterGain } }); } catch (e) {}
    try { chrome.runtime.sendMessage({ type: 'BAB_STATE_CHANGED', enabled: engine.state.enabled, tabId, boost: true }); } catch (e) {}
    sendResponse({
      ok: true,
      enabled: engine.state.enabled,
      gain: engine.state.masterGain,
      mediaCount: engine.getStats().mediaCount
    });
    return true;
  });

  getTabId().then((id) => {
    tabId = id;
    try {
      chrome.storage.sync.get('babSettings', (res) => {
        const s = (res && res.babSettings) || {};
        if (s.eq && Array.isArray(s.eq.bands)) {
          engine.state.eq = { enabled: !!s.eq.enabled, bands: s.eq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
        }
      });
    } catch (e) {}
    try {
      chrome.storage.sync.get(boostKey(), (res) => {
        const b = res && res[boostKey()];
        if (b && b.enabled) {
          engine.state.enabled = true;
          engine.state.masterGain = b.gain;
          engine.applyAll();
        }
      });
    } catch (e) {}
  });
})();
