/*
 * Audio无限+ - Service Worker (MV3 后台)
 * ...
 * 2.1 修复：MV3 下 tabCapture 必须走 getMediaStreamId → getUserMedia({chromeMediaSource:'tab'})
 *         （原 chrome.tabCapture.capture 在 offscreen 文档内返回空流）。
 *         所有代码使用 ES5 function 风格，确保 CentBrowser 等旧内核兼容。
 */

// 兼容性降级：万一浏览器内核将 chrome.action 命名为 chrome.browserAction
if (typeof chrome !== 'undefined' && !chrome.action && chrome.browserAction) {
  chrome.action = chrome.browserAction;
}

var DEFAULT_STATE = { enabled: false, preset: 'balanced', masterGain: 1.0, clarity: 50, width: 100, custom: null };

function updateBadge(enabled, tabId) {
  var text = enabled ? 'ON' : '';
  var color = enabled ? '#6C5CE7' : '#7a7f8a';
  var details = { text: text };
  if (tabId != null) details.tabId = tabId;
  chrome.action.setBadgeText(details);
  var colorDetails = { color: color };
  if (tabId != null) colorDetails.tabId = tabId;
  chrome.action.setBadgeBackgroundColor(colorDetails);
}

// 安装 / 更新
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.sync.get('babSettings', function (res) {
    if (!res || !res.babSettings) {
      chrome.storage.sync.set({
        babSettings: {
          theme: 'dark',
          accent: '#6C5CE7',
          // 默认开启“音频增强”与“媒体控制”（显示 + 启用）；资源下载 / 实时字幕默认在初始界面可用
          modules: { enhance: true, resourcedl: false, caption: false, media: true },
          moduleHome: { enhance: true, resourcedl: false, caption: false, media: true }
        }
      });
    } else {
      // 升级 / 已有数据：补齐缺失的 media 默认（默认开启），保持用户其余设置不变
      var s = res.babSettings;
      var changed = false;
      if (!s.modules) s.modules = {};
      if (!s.moduleHome) s.moduleHome = {};
      if (typeof s.modules.media !== 'boolean') { s.modules.media = true; changed = true; }
      if (typeof s.moduleHome.media !== 'boolean') { s.moduleHome.media = true; changed = true; }
      // 2.3.3：恢复默认——实时字幕 / 资源下载在初始界面默认不显示（由用户在功能显示中自行开启）
      if (s.moduleHome.caption !== false) { s.moduleHome.caption = false; changed = true; }
      if (s.moduleHome.resourcedl !== false) { s.moduleHome.resourcedl = false; changed = true; }
      if (changed) chrome.storage.sync.set({ babSettings: s });
    }
  });
});

// 浏览器启动时同步全局徽标（取 global 键）
chrome.runtime.onStartup.addListener(function () {
  chrome.storage.sync.get('babState_global', function (res) {
    updateBadge(res && res.babState_global ? res.babState_global.enabled : false);
  });
});

// ---------------- 实时字幕：Offscreen 管理 + 转发 + 历史 ----------------
var CAP = { active: false, session: null, lastFlush: 0, targetTabId: null };
var CAP_OFFSCREEN_URL = chrome.runtime.getURL('offscreen/subtitle-offscreen.html');

// 实时字幕：依赖 offscreen（承载识别引擎的文档）与 tabCapture（捕获标签页音频）。
// 仅在 Chrome / Edge 等 Chromium 内核浏览器可用。

// 预取 offscreen Reason（降级为字符串）
var _REASON_USER_MEDIA = 'USER_MEDIA';
try {
  if (chrome.offscreen && chrome.offscreen.Reason && chrome.offscreen.Reason.USER_MEDIA) {
    _REASON_USER_MEDIA = chrome.offscreen.Reason.USER_MEDIA;
  }
} catch (e) {}

function ensureOffscreen(cb) {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      chrome.offscreen.hasDocument({ url: CAP_OFFSCREEN_URL }).then(function (has) {
        if (has) return cb(true);
        chrome.offscreen.createDocument({
          url: CAP_OFFSCREEN_URL,
          reasons: [_REASON_USER_MEDIA],
          justification: '捕获麦克风/标签页音频并实时转写为字幕'
        }, function () { cb(false); });
      }).catch(function () { cb(true); });
    } else cb(true);
  } catch (e) { cb(true); }
}

var capStartQueued = null;
function flushCapStart() {
  if (!capStartQueued) return;
  var opts = capStartQueued; capStartQueued = null;
  try { chrome.runtime.sendMessage({ type: 'BAB_CAP_START_OFF', opts: opts }); } catch (e) {}
}
function closeOffscreen() {
  try { if (chrome.offscreen && chrome.offscreen.closeDocument) chrome.offscreen.closeDocument(); } catch (e) {}
}
function activeTabId(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (t) {
    cb(t && t[0] ? t[0].id : null);
  });
}
function relayToActiveTab(message) {
  // 始终在消息上附带目标标签页 id，浮层按 tabId 过滤，杜绝字幕泄漏到无关页面
  function deliver(tid) {
    if (tid != null) message.tabId = tid;
    try { chrome.tabs.sendMessage(tid, message).catch(function () {}); } catch (e) {}
  }
  if (CAP.targetTabId != null) { deliver(CAP.targetTabId); return; }
  // 未记录目标标签页时，取当前激活标签页并记住，避免把 active:true 广播到无关页
  activeTabId(function (id) {
    if (id != null) CAP.targetTabId = id;
    deliver(id);
  });
}

// 为标签页音频源获取 MediaStreamId
function getTabStreamId(targetTabId) {
  return new Promise(function (resolve) {
    try {
      if (!chrome.tabCapture || typeof chrome.tabCapture.getMediaStreamId !== 'function') {
        resolve({ error: 'getMediaStreamId API 不可用（需 Chrome 116+ 内核）' });
        return;
      }
      var param = {
        targetTabId: (typeof targetTabId === 'number' ? targetTabId : (CAP.targetTabId || undefined))
      };
      chrome.tabCapture.getMediaStreamId(param, function (streamId) {
        if (chrome.runtime.lastError || !streamId) {
          resolve({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'getMediaStreamId 返回空' });
        } else {
          resolve({ streamId: streamId });
        }
      });
    } catch (e) {
      resolve({ error: e && e.message ? e.message : String(e) });
    }
  });
}

function saveSession() {
  if (!CAP.session) return;
  try {
    chrome.storage.local.get('babSubtitleSessions', function (r) {
      var arr = (r && r.babSubtitleSessions) || [];
      var found = false;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].startedAt === CAP.session.startedAt) { arr[i] = CAP.session; found = true; break; }
      }
      if (!found) arr.push(CAP.session);
      chrome.storage.local.set({ babSubtitleSessions: arr.slice(-50) });
    });
  } catch (e) {}
}

function flushSession(force) {
  var now = Date.now();
  if (!force && now - CAP.lastFlush < 1500) return;
  CAP.lastFlush = now;
  saveSession();
}

function startCaption(opts, sendResponse) {
  function resolveTabAndStart(targetTabId) {
    CAP.active = true;
    CAP.targetTabId = (typeof targetTabId === 'number') ? targetTabId : null;
    CAP.session = { id: Date.now(), startedAt: Date.now(), lang: opts.lang, engine: opts.engine, source: opts.source, segments: [] };
    CAP.lastFlush = 0;

    function launch(extra) {
      var fullOpts = Object.assign({}, opts, extra || {});
      capStartQueued = fullOpts;
      ensureOffscreen(function (alreadyExisted) {
        if (alreadyExisted) flushCapStart();
      });
      relayToActiveTab({ type: 'BAB_SUBTITLE_STATE', active: true });
      if (sendResponse) sendResponse({ ok: true, active: true });
    }

    if (opts.source === 'tab') {
      getTabStreamId(targetTabId).then(function (r) {
        if (r.streamId) launch({ streamId: r.streamId, targetTabId: targetTabId });
        else {
          relayToActiveTab({ type: 'BAB_SUBTITLE_ERROR', msg: '无法捕获标签页音频：' + (r.error || '请确保正在播放声音') });
          CAP.active = false;
          if (sendResponse) sendResponse({ ok: false, error: r.error || 'NO_STREAM' });
        }
      });
    } else {
      launch({});
    }
  }

  if (typeof opts.targetTabId === 'number') {
    resolveTabAndStart(opts.targetTabId);
  } else {
    activeTabId(function (id) { resolveTabAndStart(id); });
  }
  return true;
}

function stopCaption(sendResponse) {
  CAP.active = false;
  try { chrome.runtime.sendMessage({ type: 'BAB_CAP_STOP_OFF' }); } catch (e) {}
  flushSession(true); saveSession();
  relayToActiveTab({ type: 'BAB_SUBTITLE_STATE', active: false });
  setTimeout(function () {
    if (!CAP.active) { closeOffscreen(); CAP.targetTabId = null; }
  }, 1200);
  if (sendResponse) sendResponse({ ok: true, active: false });
  return true;
}

// ---------------- 资源下载：标签页音频录制（录音数据由 offscreen 回传，下载在后台（SW）内完成，避免 offscreen 关闭导致 blob 失效） ----------------
var DL = { active: false, targetTabId: null, downloading: false };
function notifyDl(msg) {
  try { chrome.runtime.sendMessage({ type: 'BAB_DL_INFO', msg: msg }); } catch (e) {}
}
var dlStartQueued = null;
function flushDlStart() {
  if (!dlStartQueued) return;
  var opts = dlStartQueued; dlStartQueued = null;
  try { chrome.runtime.sendMessage({ type: 'BAB_DL_START_OFF', opts: opts }); } catch (e) {}
}
function startDownload(targetTabId, sendResponse) {
  DL.active = true;
  DL.targetTabId = (typeof targetTabId === 'number') ? targetTabId : null;
  function launch(extra) {
    var fullOpts = Object.assign({}, extra || {});
    dlStartQueued = fullOpts;
    ensureOffscreen(function (alreadyExisted) {
      if (alreadyExisted) flushDlStart();
    });
    if (sendResponse) sendResponse({ ok: true, active: true });
  }
  if (DL.targetTabId != null) {
    getTabStreamId(DL.targetTabId).then(function (r) {
      if (r.streamId) launch({ streamId: r.streamId, targetTabId: DL.targetTabId });
      else { DL.active = false; if (sendResponse) sendResponse({ ok: false, error: r.error || 'NO_STREAM' }); }
    });
  } else {
    activeTabId(function (id) { DL.targetTabId = id; launch({}); });
  }
  return true;
}
function stopDownload(sendResponse) {
  DL.active = false;
  try { chrome.runtime.sendMessage({ type: 'BAB_DL_STOP_OFF' }); } catch (e) {}
  setTimeout(function () {
    if (!CAP.active && !DL.active && !DL.downloading) { closeOffscreen(); DL.targetTabId = null; }
  }, 1200);
  if (sendResponse) sendResponse({ ok: true });
  return true;
}

// ---------------- 资源下载：猫爪式资源嗅探（基于 webRequest + DOM 扫描） ----------------
// 按标签页缓存嗅探到的媒体资源（音视频 / m3u8 / mpd 等），popup 通过 BAB_GET_MEDIA 取用。
var MEDIA = new Map();        // tabId -> [{ url, name, ext, type, size, getTime }]
var MEDIA_URL_SET = new Map(); // tabId -> Set(url) 用于去重
var MEDIA_MAX = 2000;          // 单标签缓存上限，控制内存

// 媒体扩展名集合
var MEDIA_EXT = new Set([
  'mp3', 'mp2', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aiff', 'aif', 'wma',
  'ac3', 'eac3', 'caf',
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', '3gp', 'mpeg', 'mpg', 'ts',
  'm3u8', 'm3u', 'mpd', 'f4v', 'ogv', 'm4s', 'mpd'
]);
// 媒体 MIME 前缀 / 精确类型（octet-stream 较宽泛，仅当扩展名命中时才保留）
var MEDIA_TYPE = [
  'audio/', 'video/',
  'application/x-mpegurl', 'application/vnd.apple.mpegurl',
  'application/dash+xml', 'application/vnd.ms-sstr+xml'
];

function isMediaExt(ext) {
  if (!ext) return false;
  return MEDIA_EXT.has(String(ext).toLowerCase());
}
function isMediaType(type) {
  if (!type) return false;
  type = String(type).toLowerCase().split(';')[0].trim();
  for (var i = 0; i < MEDIA_TYPE.length; i++) {
    if (type.indexOf(MEDIA_TYPE[i]) === 0) return true;
  }
  return false;
}
function fileNameParse(pathname) {
  try { pathname = decodeURIComponent(pathname); } catch (e) {}
  var seg = pathname.split('?')[0].split('#')[0].split('/').pop() || '';
  var parts = seg.split('.');
  var ext = parts.length > 1 ? parts.pop().toLowerCase() : undefined;
  return [seg, ext];
}
function getResponseHeader(headers, name) {
  if (!headers || !headers.length) return undefined;
  name = String(name).toLowerCase();
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].name && headers[i].name.toLowerCase() === name) return headers[i].value;
  }
  return undefined;
}
function addMedia(tabId, item) {
  if (tabId == null || typeof tabId !== 'number' || tabId < 0) return;
  if (!item || !item.url) return;
  if (!MEDIA.has(tabId)) { MEDIA.set(tabId, []); MEDIA_URL_SET.set(tabId, new Set()); }
  var set = MEDIA_URL_SET.get(tabId);
  if (set.has(item.url)) return; // 去重
  set.add(item.url);
  var list = MEDIA.get(tabId);
  list.push(item);
  if (list.length > MEDIA_MAX) list.splice(0, list.length - MEDIA_MAX);
  // 广播给正在打开的 popup（无接收方时静默忽略）
  try {
    var p = chrome.runtime.sendMessage({ type: 'BAB_MEDIA_ADDED', tabId: tabId, item: item });
    if (p && typeof p.catch === 'function') p.catch(function () { /* 无 popup 监听，忽略 */ });
  } catch (e) {}
}

// webRequest 捕获：收到首个响应字节时根据扩展名 / Content-Type 判断是否为媒体资源
if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
  chrome.webRequest.onResponseStarted.addListener(function (details) {
    try {
      var url = details.url;
      if (!url) return;
      // 跳过扩展自身 / 浏览器特殊页面
      if (url.indexOf('chrome-extension://') === 0 || url.indexOf('chrome://') === 0 || url.indexOf('moz-extension://') === 0) return;
      var headers = details.responseHeaders;
      var type = getResponseHeader(headers, 'content-type');
      var sizeStr = getResponseHeader(headers, 'content-length') || '';
      var rangeStr = getResponseHeader(headers, 'content-range');
      var size = parseInt(sizeStr, 10);
      if (isNaN(size) && rangeStr) {
        var rng = String(rangeStr).split('/')[1];
        if (rng && rng !== '*') size = parseInt(rng, 10);
      }
      var parsed = fileNameParse(new URL(url).pathname);
      var name = parsed[0], ext = parsed[1];
      if (!isMediaExt(ext) && !isMediaType(type)) return;
      if (!ext && type) { var sl = type.split('/'); ext = sl[1] ? sl[1].split(';')[0] : ext; }
      addMedia(details.tabId, {
        url: url,
        name: name || ('media_' + Date.now()),
        ext: ext,
        type: type || '',
        size: isNaN(size) ? undefined : size,
        getTime: Date.now()
      });
    } catch (e) {}
  }, { urls: ['<all_urls>'] }, ['responseHeaders']);
}

// 标签页关闭时清理缓存
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    MEDIA.delete(tabId); MEDIA_URL_SET.delete(tabId);
  });
}

function onCapPartial(text) { relayToActiveTab({ type: 'BAB_SUBTITLE_PARTIAL', text: text }); }
function onCapFinal(text) {
  if (!CAP.session) CAP.session = { id: Date.now(), startedAt: Date.now(), lang: '?', engine: '?', source: '?', segments: [] };
  var startSec = (Date.now() - CAP.session.startedAt) / 1000;
  CAP.session.segments.push({ start: startSec, end: startSec, text: text });
  relayToActiveTab({ type: 'BAB_SUBTITLE_FINAL', text: text });
  flushSession(false);
}

// 消息中枢
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'BAB_WHOAMI') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return true;
  }

  if (msg.type === 'BAB_STATE_CHANGED') {
    updateBadge(!!msg.enabled, msg.tabId != null ? msg.tabId : undefined);
    sendResponse({ ok: true });
    return true;
  }

  // ---- 资源下载（录制标签页音频） ----
  if (msg.type === 'BAB_DL_BLOB') {
    // offscreen 回传的录音数据：由后台（SW）持有 Blob 并触发下载，避免 offscreen 关闭导致 blob 失效
    try {
      var blob = new Blob([msg.buffer], { type: msg.mime || 'audio/webm' });
      var url = URL.createObjectURL(blob);
      DL.downloading = true;
      notifyDl('正在保存音频…');
      chrome.downloads.download({ url: url, filename: msg.name || ('标签页音频_' + Date.now() + '.webm'), saveAs: true }, function () {
        DL.downloading = false;
        if (chrome.runtime.lastError) notifyDl('下载失败：' + chrome.runtime.lastError.message);
        else notifyDl('已保存（' + Math.round(blob.size / 1024) + ' KB）');
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) {} }, 30000);
      });
    } catch (e) {
      DL.downloading = false;
      notifyDl('下载调用失败：' + (e && e.message ? e.message : e));
    }
    return true;
  }
  if (msg.type === 'BAB_DL_START') {
    return startDownload(msg.targetTabId || null, sendResponse);
  }
  if (msg.type === 'BAB_DL_STOP') {
    return stopDownload(sendResponse);
  }
  if (msg.type === 'BAB_DL_QUERY') {
    sendResponse({ active: DL.active });
    return true;
  }

  // ---- 实时字幕 ----
  if (msg.type === 'BAB_CAP_START') {
    return startCaption(msg.opts || {}, sendResponse);
  }
  if (msg.type === 'BAB_CAP_STOP') {
    return stopCaption(sendResponse);
  }

  // ---- 资源下载（猫爪式资源嗅探） ----
  if (msg.type === 'BAB_GET_MEDIA') {
    var gTid = (typeof msg.tabId === 'number') ? msg.tabId : (sender.tab ? sender.tab.id : null);
    sendResponse(gTid != null ? (MEDIA.get(gTid) || []) : []);
    return true;
  }
  if (msg.type === 'BAB_CLEAR_MEDIA') {
    var cTid = (typeof msg.tabId === 'number') ? msg.tabId : null;
    if (cTid != null) { MEDIA.delete(cTid); MEDIA_URL_SET.delete(cTid); }
    else { MEDIA.clear(); MEDIA_URL_SET.clear(); }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'BAB_MEDIA_FOUND') {
    // 来自 content script 的 DOM 嗅探
    var fTid = (typeof msg.tabId === 'number') ? msg.tabId : (sender.tab ? sender.tab.id : null);
    if (msg.item && msg.item.url) addMedia(fTid, msg.item);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'BAB_CAP_QUERY') {
    sendResponse({ active: CAP.active });
    return true;
  }
  if (msg.type === 'BAB_CAP_PARTIAL') { onCapPartial(msg.text); return; }
  if (msg.type === 'BAB_CAP_FINAL') { onCapFinal(msg.text); return; }
  if (msg.type === 'BAB_CAP_ERROR') { relayToActiveTab({ type: 'BAB_SUBTITLE_ERROR', msg: msg.msg }); return; }
  if (msg.type === 'BAB_CAP_INFO') { relayToActiveTab({ type: 'BAB_SUBTITLE_INFO', msg: msg.msg }); return; }
  if (msg.type === 'BAB_CAP_STATE') {
    CAP.active = !!msg.active;
    // 仅把字幕状态发给目标标签页的浮层（消息带 tabId，浮层按 tabId 过滤，杜绝泄漏到其它页）。
    // 弹窗自身状态用专用消息同步，避免泄漏。
    if (CAP.active && CAP.targetTabId == null) {
      activeTabId(function (id) { if (id != null) CAP.targetTabId = id; relayToActiveTab({ type: 'BAB_SUBTITLE_STATE', active: true }); });
      try { chrome.runtime.sendMessage({ type: 'BAB_CAP_SYNC', active: CAP.active }); } catch (e) {}
      return;
    }
    relayToActiveTab({ type: 'BAB_SUBTITLE_STATE', active: CAP.active });
    try { chrome.runtime.sendMessage({ type: 'BAB_CAP_SYNC', active: CAP.active }); } catch (e) {}
    return;
  }
  if (msg.type === 'BAB_CAP_GET_STREAMID') {
    getTabStreamId(msg.targetTabId || (sender.tab && sender.tab.id)).then(function (r) {
      sendResponse(r);
    });
    return true;
  }
  if (msg.type === 'BAB_OFFSCREEN_READY') { flushCapStart(); return; }

  return true;
});

// 监听存储变化
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'sync') return;
  var keys = Object.keys(changes);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var m = /^babState_(.+)$/.exec(key);
    if (m) {
      var nv = changes[key].newValue;
      var tid = m[1] === 'global' ? undefined : parseInt(m[1], 10);
      if (nv) updateBadge(nv.enabled, tid);
    }
  }
});
