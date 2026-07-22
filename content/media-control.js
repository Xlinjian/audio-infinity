/*
 * Audio无限+ - 媒体控制 content script
 * 监听 BAB_MEDIA_CTRL 消息，对当前页面（任意 http/https/file 页面）的
 * <video> / <audio> 元素执行：播放 / 暂停 / 进度跳转 / 倍速 / 音量 / 静音，
 * 并回报当前播放状态。控制的是真实 DOM 媒体元素（隔离世界共享 DOM，故可操作）。
 */
(function () {
  'use strict';

  function mediaList() {
    try { return Array.prototype.slice.call(document.querySelectorAll('video, audio')); }
    catch (e) { return []; }
  }
  function pick() {
    var all = mediaList();
    if (!all.length) return null;
    // 优先沿用上一次选中的、且仍在播放的元素
    if (window.__babMedia && all.indexOf(window.__babMedia) >= 0 && !window.__babMedia.paused) return window.__babMedia;
    var playing = all.filter(function (m) { return !m.paused; });
    var chosen = playing[0] || all[0];
    window.__babMedia = chosen;
    return chosen;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 音量可达 600%：HTMLMediaElement.volume 上限为 100%，>100% 借助 Web Audio GainNode 放大。
  var __audioCtx = null;
  var __gainMap = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function gainCtx() {
    if (!__audioCtx) {
      try { __audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { __audioCtx = null; }
    }
    if (__audioCtx && __audioCtx.state === 'suspended') { try { __audioCtx.resume(); } catch (e) {} }
    return __audioCtx;
  }
  // value ∈ [0, 6]（即 0%~600%）。≤1 直接控制元素音量；>1 由增益节点放大。
  function setMediaVolume(m, value) {
    var v = clamp(value, 0, 6);
    if (v <= 1) {
      try { var ex = __gainMap && __gainMap.get(m); if (ex) ex.gain.gain.value = 1; } catch (e) {}
      m.volume = v; m.muted = false;
      try { m.__babVol = v; } catch (e) {}
      return;
    }
    var ctx = gainCtx();
    if (!ctx) { m.volume = 1; m.muted = false; try { m.__babVol = 1; } catch (e) {} return; }
    var entry = __gainMap && __gainMap.get(m);
    if (!entry) {
      try {
        var src = ctx.createMediaElementSource(m);
        var g = ctx.createGain(); g.gain.value = 1;
        src.connect(g); g.connect(ctx.destination);
        entry = { gain: g };
        if (__gainMap) __gainMap.set(m, entry);
      } catch (e) {
        // 元素已被其他脚本接管（如全局音量增强），降级为 100%
        m.volume = 1; m.muted = false; try { m.__babVol = 1; } catch (e) {} return;
      }
    }
    m.volume = 1; m.muted = false; // 元素满音量，由增益节点放大
    try { entry.gain.gain.value = v; } catch (e) {}
    try { m.__babVol = v; } catch (e) {}
  }
  function labelOf(m) {
    var s = (m.currentSrc || m.src || '').split('/').pop().split('?')[0] || m.tagName;
    return s;
  }
  function pageMeta() {
    return {
      isBili: /bilibili\.com/.test(location.hostname),
      title: document.title || ''
    };
  }
  function snapshot() {
    var m = pick();
    var meta = pageMeta();
    if (!m) return Object.assign({ none: true }, meta);
    return Object.assign({
      has: true,
      tag: m.tagName,
      label: labelOf(m),
      paused: m.paused,
      currentTime: m.currentTime || 0,
      duration: (isFinite(m.duration) && m.duration > 0) ? m.duration : 0,
      playbackRate: m.playbackRate || 1,
      volume: (m.__babVol != null) ? m.__babVol : ((m.volume == null) ? 1 : m.volume),
      muted: !!m.muted
    }, meta);
  }
  function act(msg) {
    var m = pick();
    if (!m) return { none: true };
    try {
      if (msg.action === 'toggle') { if (m.paused) m.play(); else m.pause(); }
      else if (msg.action === 'play') { m.play(); }
      else if (msg.action === 'pause') { m.pause(); }
      else if (msg.action === 'seek') { m.currentTime = clamp(msg.time, 0, (isFinite(m.duration) && m.duration > 0) ? m.duration : m.currentTime); }
      else if (msg.action === 'rate') { m.playbackRate = clamp(msg.value, 0.1, 16); }
      else if (msg.action === 'volume') { setMediaVolume(m, msg.value); }
      else if (msg.action === 'mute') { m.muted = !!msg.value; }
      else if (msg.action === 'refresh') { window.__babMedia = null; }
    } catch (e) {}
    return snapshot();
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'BAB_MEDIA_CTRL') return;
    try { sendResponse(act(msg)); } catch (e) { sendResponse({ none: true }); }
    return true;
  });
})();
