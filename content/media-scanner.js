/*
 * Audio无限+ - 媒体资源嗅探（猫爪式 DOM 扫描）
 * 在页面中扫描 <video>/<audio>/<source> 元素以及指向媒体文件的 <a> 链接，
 * 将发现到的资源上报给后台（BAB_MEDIA_FOUND），由后台与 webRequest 捕获结果合并去重。
 * 作为 webRequest 的补充：后台 Service Worker 被回收期间错过的请求，可由本脚本兜底捕获。
 */
(() => {
  'use strict';

  if (window.__BAB_MEDIA_SCANNER__) return;
  window.__BAB_MEDIA_SCANNER__ = true;

  // 媒体文件扩展名（用于判断 <a href> 是否为媒体）
  const MEDIA_RE = /\.(mp3|mp2|wav|aac|ogg|oga|opus|flac|m4a|aiff|aif|wma|ac3|eac3|caf|mp4|m4v|webm|mkv|mov|avi|flv|wmv|3gp|mpeg|mpg|ts|m3u8|m3u|mpd|f4v|ogv|m4s)(\?|#|$)/i;

  const seen = new Set();

  function send(url, type) {
    if (!url || seen.has(url)) return;
    try { new URL(url); } catch (e) { return; }
    seen.add(url);
    let base = url.split('?')[0].split('#')[0];
    let seg = '';
    try { seg = decodeURIComponent(base.split('/').pop()); } catch (e) { seg = base.split('/').pop(); }
    const parts = seg.split('.');
    const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
    try {
      chrome.runtime.sendMessage({
        type: 'BAB_MEDIA_FOUND',
        item: { url: url, name: seg, ext: ext, type: type || '', getTime: Date.now() }
      }, () => { if (chrome.runtime.lastError) { /* 无后台监听，忽略 */ } });
    } catch (e) {}
  }

  function scan() {
    try {
      // 直接带 src 的媒体元素
      document.querySelectorAll('video[src], audio[src]').forEach((el) => {
        if (el.src) send(el.src, el.tagName === 'VIDEO' ? 'video/' : 'audio/');
      });
      // <source> 子元素
      document.querySelectorAll('video > source[src], audio > source[src]').forEach((el) => {
        if (el.src) send(el.src, 'media');
      });
      // 指向媒体文件的链接
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href;
        if (href && MEDIA_RE.test(href)) send(href, '');
      });
    } catch (e) {}
  }

  function start() {
    scan();
    try {
      const obs = new MutationObserver(() => scan());
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    // 周期性兜底扫描（应对懒加载 / 后续插入）
    setInterval(scan, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
