/*
 * Audio无限+ - 字幕浮层（content script，注入网页；也可被本地播放器/历史页以 <script> 引入）
 * 实时显示字幕、可拖拽、样式随设置，支持清除 / 历史 / 关闭。
 */
(function () {
  'use strict';

  if (document.getElementById('bab-subtitle-root')) return; // 防重复注入

  const SUB = window.BAB_SUB;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <style>
      #bab-subtitle-root {
        position: fixed; z-index: 2147483646; left: 50%; transform: translateX(-50%);
        bottom: 24px; max-width: var(--bab-sub-maxw, 80%); width: max-content;
        font-family: var(--bab-sub-font, sans-serif); pointer-events: auto;
        user-select: none; cursor: grab;
        --bab-sub-font: serif; --bab-sub-size: 30px; --bab-sub-color: #000;
        --bab-sub-bg: #fff; --bab-sub-bg-op: 0; --bab-sub-maxw: 80%; --bab-sub-align: center;
        --bab-sub-height: 200px;
      }
      #bab-subtitle-root * { box-sizing: border-box; }
      #bab-subtitle-root.bab-dragging { cursor: grabbing; }
      #bab-subtitle-root .bab-bar {
        display: flex; align-items: center; gap: 8px; justify-content: flex-end;
        padding: 2px 4px 6px; opacity: 1; transition: opacity .15s; pointer-events: auto;
        cursor: inherit; user-select: none;
      }
      #bab-subtitle-root .bab-bar::before {
        content: "⋮⋮"; font-size: 10px; color: rgba(255,255,255,.55); letter-spacing: -1px;
        margin-right: auto; padding-left: 4px;
      }
      #bab-subtitle-root .bab-bar button {
        font: 12px/1 sans-serif; color: #fff; background: rgba(20,20,28,.78);
        border: 1px solid rgba(255,255,255,.18); border-radius: 7px; padding: 4px 8px; cursor: pointer;
      }
      #bab-subtitle-root .bab-bar button:hover { background: rgba(108,92,231,.9); }
      #bab-subtitle-root .bab-box {
        background: color-mix(in srgb, var(--bab-sub-bg) calc(var(--bab-sub-bg-op) * 100%), transparent);
        color: var(--bab-sub-color); border-radius: 12px; padding: 10px 16px;
        font-size: var(--bab-sub-size); line-height: 1.45; text-align: var(--bab-sub-align);
        white-space: pre-wrap; word-break: break-word; pointer-events: auto;
        min-height: 1.6em; max-height: var(--bab-sub-height); overflow-y: auto;
        text-shadow: none;
      }
      #bab-subtitle-root.bab-sub-shadow .bab-box { text-shadow: 0 1px 3px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.9); }
      #bab-subtitle-root .bab-partial { opacity: .62; }
      #bab-subtitle-root .bab-final { opacity: 1; }
      #bab-subtitle-root .bab-toast {
        position: absolute; top: -34px; left: 50%; transform: translateX(-50%);
        background: #e74c3c; color: #fff; font: 12px/1 sans-serif; padding: 6px 10px;
        border-radius: 8px; white-space: nowrap; opacity: 0; transition: opacity .2s; pointer-events: none;
      }
      #bab-subtitle-root .bab-toast.show { opacity: 1; }
      #bab-subtitle-root .bab-toast.info { background: #2d7ff9; }
    </style>
    <div class="bab-bar">
      <button data-act="clear" title="清除当前字幕">清除</button>
      <button data-act="history" title="打开字幕历史">历史</button>
      <button data-act="close" title="关闭字幕">✕</button>
    </div>
    <div class="bab-box" id="babSubBox"></div>
    <div class="bab-toast" id="babSubToast"></div>
  `;
  wrapper.id = 'bab-subtitle-root';
  document.body.appendChild(wrapper);
  const root = wrapper;
  root.hidden = true; // 初始隐藏：仅在实时字幕真正开启（收到 active 状态）时才显示，避免打开任意页面/播放页自动露出字幕
  const box = root.querySelector('#babSubBox');
  const toast = root.querySelector('#babSubToast');

  let finals = [];   // 最近若干句 final 文本
  let partial = '';

  function render() {
    const recent = finals.slice(-6); // 增加可见行数，展示更完整的字幕内容
    let html = recent.map((t) => '<div class="bab-final">' + escapeHtml(t) + '</div>').join('');
    if (partial) html += '<div class="bab-partial">' + escapeHtml(partial) + '</div>';
    box.innerHTML = html;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  let toastTimer = null;
  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.classList.toggle('info', kind === 'info');
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), kind === 'info' ? 2600 : 3200);
  }

  // 样式
  function applyStoredStyle() {
    if (!SUB) return;
    SUB.loadSettings((sub) => { SUB.applyStyle(root, sub.style); });
  }
  applyStoredStyle();

  // 拖拽（鼠标放在字幕任意位置即可拖动；保存自定义位置到设置）
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  root.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return; // 点击按钮不触发拖拽
    dragging = true;
    const r = root.getBoundingClientRect();
    ox = r.left; oy = r.top;
    sx = e.clientX; sy = e.clientY;
    root.classList.add('bab-dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = root.offsetWidth, h = root.offsetHeight;
    const maxX = Math.max(4, window.innerWidth - w - 4);
    const maxY = Math.max(4, window.innerHeight - h - 4);
    const nx = Math.max(4, Math.min(maxX, ox + (e.clientX - sx)));
    const ny = Math.max(4, Math.min(maxY, oy + (e.clientY - sy)));
    root.style.left = nx + 'px';
    root.style.top = ny + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.transform = 'none';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('bab-dragging');
    // 不持久化拖拽位置：仅当前显示会话内生效，关闭或重开后回到默认中下位置
  });

  // 按钮
  root.querySelector('[data-act="clear"]').addEventListener('click', () => { finals = []; partial = ''; render(); });
  root.querySelector('[data-act="history"]').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('captions/history.html') });
  });
  root.querySelector('[data-act="close"]').addEventListener('click', () => {
    root.hidden = true;
    try { chrome.runtime.sendMessage({ type: 'BAB_CAP_STOP' }); } catch (_) {}
  });

  // 消息
  // 记录本标签页 id，仅响应发往本页的字幕消息，避免字幕泄漏到其它标签页
  let MY_TAB_ID = null;
  try { chrome.runtime.sendMessage({ type: 'BAB_WHOAMI' }, (r) => { if (r && typeof r.tabId === 'number') MY_TAB_ID = r.tabId; }); } catch (e) {}
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    // 仅处理发往本标签页的字幕消息（带 tabId 且不匹配的忽略），杜绝字幕泄漏到无关页面
    if (MY_TAB_ID != null && typeof msg.tabId === 'number' && msg.tabId !== MY_TAB_ID) return;
    switch (msg.type) {
      case 'BAB_SUBTITLE_STATE':
        root.hidden = !msg.active;
        if (msg.active) {
          // 不保留位置记忆：每次开启字幕都重置回默认（水平居中、垂直屏幕中下）位置
          if (SUB) {
            SUB.loadSettings((sub) => {
              sub.style.posX = null;
              sub.style.posY = null;
              SUB.saveSettings(sub);   // 清掉历史保存的位置，确保不延续上次拖拽
              SUB.applyStyle(root, sub.style);
            });
          }
        } else { finals = []; partial = ''; render(); }
        break;
      case 'BAB_SUBTITLE_PARTIAL':
        partial = msg.text || '';
        render();
        break;
      case 'BAB_SUBTITLE_FINAL':
        if (msg.text && msg.text.trim()) { finals.push(msg.text.trim()); if (finals.length > 20) finals.shift(); }
        partial = '';
        render();
        break;
      case 'BAB_SUBTITLE_CLEAR':
        finals = []; partial = ''; render();
        break;
      case 'BAB_SUBTITLE_INFO':
        showToast(msg.msg || '', 'info');
        break;
      case 'BAB_SUBTITLE_ERROR':
        showToast(msg.msg || '字幕出错', 'error');
        break;
    }
  });

  // 设置变化实时更新样式
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'sync' && ch.babSettings && ch.babSettings.newValue && ch.babSettings.newValue.subtitle) {
        const s = ch.babSettings.newValue.subtitle;
        if (s.style) SUB.applyStyle(root, s.style);
      }
    });
  } catch (_) {}
})();
