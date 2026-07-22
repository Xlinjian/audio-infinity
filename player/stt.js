/*
 * Audio无限+ - 本地播放器「语音转文字」（stt.js）
 *
 * 设计思路：复用 audio-engine 的 getRecordingStream() —— 它返回一个 MediaStream，
 * 内容是“用户实际听到的、已增强后的音频”。根据设置页「识别引擎」选择：
 *   - custom_http : 用 MediaRecorder 分段录制（默认 6s/段），POST 到自定义 Whisper 兼容接口。
 *   - mimo        : 用 Web Audio 采集 PCM，编码为 WAV base64 后 POST 到小米 MiMo Chat Completions 接口。
 *   - webspeech / custom_ws : 本地播放器内暂不支持，提示用户切换引擎。
 *
 * 收集返回文本，按媒体时间生成 SRT/TXT。
 *
 * 完全离线的本地 Whisper 模型在扩展内体积过大、不现实，因此采用“本地录音 + 远端转写”
 * 的折中方案：音频不落盘、不上传原文件，仅把分片音频 POST 给用户自配的接口。
 */
(function () {
  'use strict';

  // 仅在本地播放器页面运行（避免被其它引入该脚本的页面误触发）
  if (!location.href.endsWith('player/local-player.html') && !/\/player\/local-player\.html(\?|$)/.test(location.pathname)) {
    return;
  }
  if (window.__BAB_STT_INIT__) return;
  window.__BAB_STT_INIT__ = true;

  const SUB = window.BAB_SUB;
  const $ = (id) => document.getElementById(id);

  // 默认分段时长（毫秒）：兼顾转写延迟与上下文完整性
  const SEGMENT_MS = 6000;
  // 转写并发上限：分段产出可能快于网络返回，限制并发避免雪崩
  const MAX_CONCURRENT = 2;
  // 小米 MiMo 默认接口
  const MIMO_DEFAULT_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
  const MIMO_MODEL = 'mimo-v2.5-asr';

  let settings = null;       // babSettings.subtitle
  let audioEl = null;        // <audio> 元素（用于读取 currentTime 作为时间轴）

  // ----- 通用录制状态 -----
  let recorder = null;       // MediaRecorder（custom_http）
  let chunks = [];           // 当前分片的 Blob 片段（custom_http）
  let segments = [];         // 已转写结果 [{start, end, text}]
  let queue = [];            // 待转写的 Blob 队列（custom_http）
  let activeWorkers = 0;
  let running = false;
  let startedAt = 0;
  let segStartMediaTime = 0;
  let endingSegStart = 0;
  let segTimer = null;

  // ----- MiMo 专用状态 -----
  let mimoCtx = null;
  let mimoNode = null;
  let mimoSrc = null;
  let mimoCollected = [];
  let mimoTimer = null;
  let mimoBusy = false;

  let statusEl = null, resultEl = null, countEl = null;

  // ============ 读取设置 ============
  function loadSettings(cb) {
    if (!SUB) { cb(null); return; }
    SUB.loadSettings((sub) => { settings = sub; cb(sub); });
  }

  function engineName() {
    if (!settings) return 'custom';
    return settings.engine || 'custom';
  }
  function isMimo() { return engineName() === 'mimo'; }
  function isCustomHttp() {
    const e = engineName();
    if (e === 'custom') return (settings.custom && settings.custom.type) !== 'custom_ws';
    return e === 'custom_http';
  }
  function endpointReady() {
    if (isMimo()) {
      const m = settings && settings.mimo;
      return !!(m && m.url && /^https?:\/\//i.test(m.url));
    }
    if (isCustomHttp()) {
      const c = settings && settings.custom;
      return !!(c && c.endpoint && /^https?:\/\//i.test(c.endpoint));
    }
    return false;
  }
  function engineLabel() {
    if (isMimo()) return '小米 MiMo';
    if (isCustomHttp()) return '自定义 AI · HTTP';
    return '当前引擎';
  }

  // ============ UI：在 controls 区追加「语音转文字」卡片 ============
  function ensureUI() {
    const controls = $('controls');
    if (!controls || $('sttCard')) return;
    const card = document.createElement('section');
    card.className = 'card';
    card.id = 'sttCard';
    card.innerHTML = `
      <div class="row top">
        <label class="switch">
          <input type="checkbox" id="sttToggle" />
          <span class="track"></span>
          <span class="sw-label">语音转文字</span>
        </label>
        <span class="badge" id="sttBadge">关</span>
      </div>
      <div class="file-name" id="sttHint" style="margin-top:10px;">正在加载转写配置…</div>
      <div class="row" style="margin-top:6px;align-items:center;gap:10px;flex-wrap:wrap;">
        <span class="lbl" style="width:auto;">格式</span>
        <div class="presets" id="sttFmt" style="gap:6px;">
          <button class="preset" data-fmt="srt">SRT</button>
          <button class="preset" data-fmt="txt">TXT</button>
        </div>
        <span style="flex:1"></span>
        <button class="preset" id="sttClear" style="opacity:.8;">清空</button>
        <button class="preset active" id="sttDownload" disabled style="opacity:.5;cursor:not-allowed;">下载结果</button>
      </div>
      <div class="file-name" id="sttStatus" style="margin-top:4px;">尚未开始</div>
      <div id="sttResult" style="margin-top:10px;max-height:200px;overflow:auto;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;"></div>
    `;
    // 插入到右侧栏的锚点前
    const anchor = $('sttAnchor');
    if (anchor) anchor.parentNode.insertBefore(card, anchor);
    else controls.appendChild(card);

    statusEl = $('sttStatus');
    resultEl = $('sttResult');
    countEl = $('sttBadge');

    // 格式切换
    let fmt = (settings && settings.exportFormat) || 'srt';
    const refreshFmt = () => {
      card.querySelectorAll('#sttFmt .preset').forEach((b) => b.classList.toggle('active', b.dataset.fmt === fmt));
    };
    refreshFmt();
    card.querySelector('#sttFmt').addEventListener('click', (e) => {
      const b = e.target.closest('.preset'); if (!b) return;
      fmt = b.dataset.fmt; refreshFmt();
    });
    // 清空
    $('sttClear').addEventListener('click', () => { segments = []; renderResult(); setStatus('已清空，可继续转写'); });
    // 下载
    $('sttDownload').addEventListener('click', () => {
      if (!segments.length) return;
      downloadResult(fmt);
    });
    // 开关
    $('sttToggle').addEventListener('change', (e) => {
      if (e.target.checked) start(); else stop();
    });

    refreshHint();
  }

  function refreshHint() {
    const hint = $('sttHint');
    if (!hint) return;
    if (isMimo()) {
      const m = (settings && settings.mimo) || {};
      if (endpointReady()) {
        hint.textContent = '引擎：小米 MiMo ｜ 接口：' + (m.url || MIMO_DEFAULT_ENDPOINT).replace(/^https?:\/\//, '').slice(0, 40) + '…  模型：' + (m.model || MIMO_MODEL);
      } else {
        hint.textContent = '引擎：小米 MiMo ｜ 未配置接口。请到设置页「实时字幕 → 识别引擎 → 小米 MiMo」填写 API 地址。';
      }
    } else if (isCustomHttp()) {
      const c = (settings && settings.custom) || {};
      if (endpointReady()) {
        hint.textContent = '引擎：自定义 AI · HTTP ｜ 接口：' + (c.endpoint || '').replace(/^https?:\/\//, '').slice(0, 40) + '…  模型：' + (c.model || 'whisper-1');
      } else {
        hint.textContent = '引擎：自定义 AI · HTTP ｜ 未配置接口。请到设置页「实时字幕 → 自定义 AI · HTTP」填写 API 地址。';
      }
    } else {
      hint.textContent = '当前识别引擎（' + engineLabel() + '）不支持本地播放器语音转文字，请切换到「自定义 AI · HTTP」或「小米 MiMo」。';
    }
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = (kind === 'error') ? '#e74c3c' : (kind === 'ok' ? '#2bd47d' : 'var(--muted)');
  }
  function setBadge(running) {
    const b = $('sttBadge'); if (!b) return;
    b.textContent = running ? '识别中' : (segments.length ? '已完成' : '关');
    b.className = 'badge' + (running ? ' run' : '');
  }

  // ============ MediaRecorder 录制（custom_http） ============
  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
    return '';
  }

  function startRecorder(stream) {
    if (!stream || stream.getAudioTracks().length === 0) {
      setStatus('当前没有可录制的音轨，请先播放音频。', 'error');
      setBadge(false);
      const t = $('sttToggle'); if (t) t.checked = false;
      return null;
    }
    const mime = pickMime();
    let mr;
    try {
      mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      setStatus('MediaRecorder 初始化失败：' + e.message, 'error');
      setBadge(false);
      const t = $('sttToggle'); if (t) t.checked = false;
      return null;
    }
    chunks = [];
    mr.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      chunks.push(ev.data);
    };
    mr.onstop = () => {
      if (chunks.length) {
        const blob = new Blob(chunks, { type: mime || 'audio/webm' });
        chunks = [];
        enqueueTranscribe(blob, endingSegStart);
      }
    };
    mr.onerror = (e) => {
      setStatus('录制错误：' + ((e && e.error && e.error.message) || 'unknown'), 'error');
    };
    mr.start();
    recorder = mr;
    startedAt = Date.now();
    segStartMediaTime = audioEl ? Math.max(0, audioEl.currentTime) : 0;
    endingSegStart = segStartMediaTime;
    scheduleNextSegment();
    return mr;
  }

  function scheduleNextSegment() {
    clearTimeout(segTimer);
    if (!running || !recorder || recorder.state !== 'recording') return;
    segTimer = setTimeout(() => {
      if (!running || !recorder || recorder.state !== 'recording') return;
      const t = audioEl ? audioEl.currentTime : ((Date.now() - startedAt) / 1000);
      const nextStart = Math.max(segStartMediaTime, t);
      endingSegStart = segStartMediaTime;
      try { recorder.stop(); } catch (_) {}
      try { recorder.start(); } catch (_) {}
      segStartMediaTime = nextStart;
      scheduleNextSegment();
    }, SEGMENT_MS);
  }

  // ============ 转写队列（custom_http，限并发） ============
  function enqueueTranscribe(blob, startMediaTime) {
    queue.push({ blob, startMediaTime, durMs: SEGMENT_MS });
    pumpQueue();
  }
  function pumpQueue() {
    while (activeWorkers < MAX_CONCURRENT && queue.length) {
      const item = queue.shift();
      activeWorkers++;
      transcribeOne(item.blob).then((text) => {
        activeWorkers--;
        if (text && text.trim()) {
          segments.push({ start: item.startMediaTime, end: item.startMediaTime + item.durMs / 1000, text: text.trim() });
          renderResult();
          setStatus('已转写 ' + segments.length + ' 段', 'ok');
        } else {
          setStatus('分片无识别内容（已跳过），累计 ' + segments.length + ' 段');
        }
        pumpQueue();
      }).catch((e) => {
        activeWorkers--;
        setStatus('转写失败：' + (e && e.message ? e.message : e), 'error');
        pumpQueue();
      });
    }
  }

  async function transcribeOne(blob) {
    const c = (settings && settings.custom) || {};
    const endpoint = c.endpoint || '';
    const model = c.model || 'whisper-1';
    const fd = new FormData();
    fd.append('file', blob, 'audio.webm');
    fd.append('model', model);
    if (c.language && c.language !== 'auto') fd.append('language', c.language);

    const headers = {};
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;
    if (c.headers) {
      try { Object.assign(headers, JSON.parse(c.headers)); }
      catch (e) { setStatus('额外请求头 JSON 解析失败：' + e.message, 'error'); }
    }

    let resp;
    try {
      resp = await fetch(endpoint, { method: 'POST', headers, body: fd });
    } catch (e) {
      throw new Error('请求 ' + endpoint + ' 失败：' + (e && e.message ? e.message : String(e)));
    }
    const respText = await resp.text().catch(() => '');
    if (!resp.ok) {
      const snip = respText.slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(endpoint + ' → HTTP ' + resp.status + (snip ? '：' + snip : ''));
    }
    let j = {};
    try { j = JSON.parse(respText); }
    catch (e) {
      if (respText && respText.trim()) return respText.trim();
      throw new Error(endpoint + ' 响应为空或不是 JSON');
    }
    let text = '';
    if (typeof j.text === 'string') text = j.text;
    else if (j.choices && j.choices[0]) {
      const ch = j.choices[0];
      text = ch.text || (ch.message && ch.message.content) || '';
    } else if (typeof j.transcript === 'string') text = j.transcript;
    else if (typeof j.result === 'string') text = j.result;
    else if (j.data && typeof j.data.text === 'string') text = j.data.text;
    else if (j.output && typeof j.output.text === 'string') text = j.output.text;
    return text;
  }

  // ============ 小米 MiMo 专用（WAV base64） ============
  function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    let off = 0;
    const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };
    writeStr('RIFF'); view.setUint32(off, 36 + samples.length * 2, true); off += 4;
    writeStr('WAVE'); writeStr('fmt '); view.setUint32(off, 16, true); off += 4;
    view.setUint16(off, 1, true); off += 2;
    view.setUint16(off, 1, true); off += 2;
    view.setUint32(off, sampleRate, true); off += 4;
    view.setUint32(off, sampleRate * 2, true); off += 4;
    view.setUint16(off, 2, true); off += 2;
    view.setUint16(off, 16, true); off += 2;
    writeStr('data'); view.setUint32(off, samples.length * 2, true); off += 4;
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
    }
    return buffer;
  }
  function float32ToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function resampleToMono(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const newLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) out[i] = input[Math.floor(i * ratio)];
    return out;
  }

  async function startMimo(stream) {
    const c = (settings && settings.mimo) || {};
    const endpoint = c.url || MIMO_DEFAULT_ENDPOINT;
    const model = c.model || MIMO_MODEL;
    const apiKey = c.apiKey || '';
    const langMap = { 'zh-CN': 'zh', 'zh-TW': 'zh', 'en-US': 'en', 'en-GB': 'en' };
    const capLang = settings.lang || 'auto';
    const asrLang = (capLang !== 'auto') ? (langMap[capLang] || 'auto') : 'auto';

    let actx;
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) {
      setStatus('AudioContext 初始化失败：' + e.message, 'error');
      setBadge(false); const t = $('sttToggle'); if (t) t.checked = false;
      return false;
    }

    const srcNode = actx.createMediaStreamSource(stream);
    const targetRate = 16000;
    const node = actx.createScriptProcessor(4096, 1, 1);
    mimoCollected = [];
    node.onaudioprocess = (e) => { const ch = e.inputBuffer.getChannelData(0); mimoCollected.push(new Float32Array(ch)); };
    srcNode.connect(node);
    node.connect(actx.destination);
    mimoCtx = actx; mimoNode = node; mimoSrc = srcNode;

    startedAt = Date.now();
    segStartMediaTime = audioEl ? Math.max(0, audioEl.currentTime) : 0;
    mimoTimer = setInterval(() => flushMimoSegment(endpoint, apiKey, model, asrLang, targetRate), SEGMENT_MS);
    return true;
  }

  async function flushMimoSegment(endpoint, apiKey, model, asrLang, targetRate) {
    if (mimoBusy || !mimoCollected.length) return;
    mimoBusy = true;
    const thisSegStart = segStartMediaTime;
    try {
      let total = 0;
      for (const seg of mimoCollected) total += seg.length;
      const merged = new Float32Array(total);
      let o = 0;
      for (const seg of mimoCollected) { merged.set(seg, o); o += seg.length; }
      mimoCollected.length = 0;
      const mono = resampleToMono(merged, mimoCtx.sampleRate, targetRate);
      const wav = encodeWAV(mono, targetRate);
      const b64 = float32ToBase64(wav);
      const dataUrl = 'data:audio/wav;base64,' + b64;
      const body = {
        model: model,
        messages: [
          { role: 'user', content: [ { type: 'input_audio', input_audio: { data: dataUrl, format: 'wav' } } ] }
        ],
        asr_options: { language: asrLang },
        stream: false
      };
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) { headers['api-key'] = apiKey; headers['Authorization'] = 'Bearer ' + apiKey; }

      const resp = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
      const text = await resp.text().catch(() => '');
      if (!resp.ok) {
        setStatus('MiMo HTTP ' + resp.status + '：' + text.slice(0, 200), 'error');
        return;
      }
      let j = {};
      try { j = JSON.parse(text); } catch (e) {
        if (text.trim()) {
          segments.push({ start: thisSegStart, end: thisSegStart + SEGMENT_MS / 1000, text: text.trim() });
          renderResult(); setStatus('已转写 ' + segments.length + ' 段', 'ok');
        }
        return;
      }
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (content && content.trim()) {
        segments.push({ start: thisSegStart, end: thisSegStart + SEGMENT_MS / 1000, text: content.trim() });
        renderResult(); setStatus('已转写 ' + segments.length + ' 段', 'ok');
      } else {
        setStatus('分片无识别内容（已跳过），累计 ' + segments.length + ' 段');
      }
      // 下一段起点单调钳制
      const t = audioEl ? audioEl.currentTime : ((Date.now() - startedAt) / 1000);
      segStartMediaTime = Math.max(thisSegStart, t);
    } catch (e) {
      setStatus('MiMo 请求失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      mimoBusy = false;
    }
  }

  // ============ 渲染 / 下载 ============
  function fmtTime(sec) {
    sec = Math.max(0, sec | 0);
    const m = (sec / 60) | 0, s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function renderResult() {
    if (!resultEl) return;
    if (!segments.length) { resultEl.textContent = ''; return; }
    resultEl.textContent = segments.map((seg) => '[' + fmtTime(seg.start) + '] ' + seg.text).join('\n');
    resultEl.scrollTop = resultEl.scrollHeight;
    const dl = $('sttDownload');
    if (dl) { dl.disabled = false; dl.style.opacity = '1'; dl.style.cursor = 'pointer'; }
    setBadge(running);
  }
  function downloadResult(fmt) {
    if (!SUB || !segments.length) return;
    const session = { startedAt: startedAt || Date.now(), segments: segments.slice() };
    const text = fmt === 'txt' ? SUB.exportTXT(session, false) : SUB.exportSRT(session);
    const base = (audioEl && audioEl.dataset.name) || '本地音频';
    SUB.download(base + '_转文字.' + fmt, text);
  }

  // ============ 启动 / 停止 ============
  function start() {
    if (!endpointReady()) {
      setStatus('未配置 ' + engineLabel() + ' 接口。请到设置页「实时字幕」中填写 API 地址后重试。', 'error');
      const t = $('sttToggle'); if (t) t.checked = false;
      return;
    }
    if (!isMimo() && !isCustomHttp()) {
      setStatus('当前引擎「' + engineLabel() + '」不支持本地播放器转文字，请切换到「自定义 AI · HTTP」或「小米 MiMo」。', 'error');
      const t = $('sttToggle'); if (t) t.checked = false;
      return;
    }
    if (!window.__babEngine || !window.__babEngine.getRecordingStream) {
      setStatus('音频引擎未就绪，请先选择并播放一个文件。', 'error');
      const t = $('sttToggle'); if (t) t.checked = false;
      return;
    }
    const stream = window.__babEngine.getRecordingStream();
    if (!stream) {
      setStatus('无法获取音频流，请先播放文件后再开启转写。', 'error');
      const t = $('sttToggle'); if (t) t.checked = false;
      return;
    }
    running = true;
    segments = [];
    renderResult();
    setBadge(true);
    setStatus('正在录制并转写…', 'ok');

    if (isMimo()) {
      if (!startMimo(stream)) running = false;
    } else {
      if (!startRecorder(stream)) running = false;
    }
  }
  function stop() {
    running = false;
    clearTimeout(segTimer);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (_) {}
    }
    recorder = null;
    if (mimoTimer) { clearInterval(mimoTimer); mimoTimer = null; }
    try { if (mimoNode) { mimoNode.onaudioprocess = null; mimoNode.disconnect(); } } catch (_) {}
    try { if (mimoSrc) mimoSrc.disconnect(); } catch (_) {}
    try { if (mimoCtx) mimoCtx.close(); } catch (_) {}
    mimoNode = null; mimoSrc = null; mimoCtx = null; mimoCollected = [];
    setBadge(false);
    setStatus(segments.length ? ('转写结束，共 ' + segments.length + ' 段，可下载。') : '已停止');
  }

  // ============ 初始化 ============
  function init() {
    audioEl = $('audio');
    loadSettings(() => {
      ensureUI();
      refreshHint();
    });
  }

  // 等待 DOM 与音频引擎就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
