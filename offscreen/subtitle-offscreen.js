/*
 * Audio无限+ - 字幕 Offscreen 识别引擎
 * 在 MV3 offscreen document 中运行：捕获麦克风/标签页音频，调用识别引擎，
 * 把 partial / final 文本回传给后台（后台再转发到网页浮层 & 写入历史）。
 *
 * 引擎：
 *  - webspeech : 浏览器原生 Web Speech API（免费，仅麦克风；实时 interimResults）
 *  - custom_http : 自定义 REST 转写（兼容 OpenAI Whisper：POST audio + model + language，返回 text/choices）
 *  - custom_ws : 自定义 WebSocket 流式转写（发送单声道 Float32 PCM 帧，接收 {text,isFinal}）
 *  - mimo : 小米 MiMo Chat Completions ASR（POST WAV base64 到 /v1/chat/completions，返回 choices[].message.content）
 */
(function () {
  'use strict';

  const send = (m) => { try { chrome.runtime.sendMessage(m); } catch (e) {} };

  const st = {
    active: false, engine: null, source: null, lang: null
  };
  let rec = null;            // SpeechRecognition
  let mediaStream = null;    // getUserMedia / tabCapture
  let mediaRecorder = null;  // custom_http
  let ws = null;             // custom_ws
  let audioCtx = null;       // custom_ws / mimo
  let workletNode = null;    // custom_ws
  let mimoNode = null;       // mimo ScriptProcessor
  let mimoSrc = null;        // mimo MediaStreamSource
  let mimoTimer = null;      // mimo 定时转写

  function postPartial(text) { send({ type: 'BAB_CAP_PARTIAL', text: text }); }
  function postFinal(text) { send({ type: 'BAB_CAP_FINAL', text: text }); }
  function postError(msg) { send({ type: 'BAB_CAP_ERROR', msg: msg }); }
  function postInfo(msg) { send({ type: 'BAB_CAP_INFO', msg: msg }); }
  function postState() { send({ type: 'BAB_CAP_STATE', active: st.active, engine: st.engine }); }

  // ---------------- 音频源 ----------------
  // MV3 下 offscreen 文档无标签页上下文，chrome.tabCapture.capture 在 offscreen 内会返回空流。
  // 正确做法：由 service worker 调用 chrome.tabCapture.getMediaStreamId({targetTabId}) 拿到 streamId，
  // 传到 offscreen，这里用 getUserMedia + chromeMediaSource:'tab' 兑换为真正可用的 MediaStream。
  async function getStream(source, targetTabId) {
    if (source === 'tab') {
      let streamId = targetTabId;
      // 兼容历史调用：若 service worker 未提供 streamId，offscreen 自行向后台请求
      if (!streamId || typeof streamId === 'number') {
        try {
          streamId = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { type: 'BAB_CAP_GET_STREAMID', targetTabId: (typeof targetTabId === 'number' ? targetTabId : null) },
              (res) => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
                if (!res || !res.streamId) return reject('后台未返回 streamId');
                resolve(res.streamId);
              }
            );
          });
        } catch (e) {
          throw new Error('获取标签页音频 streamId 失败：' + (e && e.message ? e.message : e));
        }
      }
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
        }
      });
    }
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  }

  // ---------------- 引擎 1：Web Speech（免费，仅麦克风） ----------------
  function startWebSpeech(opts) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      postError('当前浏览器不支持 Web Speech API，请使用 Chrome / Edge，或在设置里改用「自定义 AI」引擎');
      st.active = false; postState(); return;
    }
    const r = new SR();
    r.lang = opts.lang || 'zh-CN';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (e) => {
      let interim = '', finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (interim) postPartial(interim);
      if (finalText) postFinal(finalText);
    };
    r.onerror = (e) => {
      const err = e && e.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        postError('麦克风权限被拒绝，请在浏览器地址栏左侧允许麦克风后重试');
        stopAll();
      } else if (err === 'language-not-supported') {
        postError('所选语言不被 Web Speech 支持，请在设置里更换语言');
      } else if (err !== 'no-speech' && err !== 'aborted') {
        postError('识别错误：' + err);
      }
    };
    r.onend = () => {
      // 断流后自动重启，保证持续识别
      if (st.active && st.engine === 'webspeech') {
        try { r.start(); } catch (_) {}
      }
    };

    st.engine = 'webspeech'; rec = r;
    try { r.start(); postState(); } catch (e) { postError('启动识别失败：' + e.message); stopAll(); }
  }

  // ---------------- 引擎 2：自定义 HTTP（兼容 Whisper） ----------------
  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
    return '';
  }

  async function httpTranscribe(opts, blob) {
    const c = opts.custom || {};
    const model = c.model || 'whisper-1';
    const endpoint = c.endpoint || '';
    postInfo('请求开始 → ' + endpoint + ' | model=' + model + ' | size=' + blob.size);

    const fd = new FormData();
    fd.append('file', blob, 'audio.webm');
    fd.append('model', model);
    const lang = opts.lang || c.language;
    if (lang && lang !== 'auto') fd.append('language', lang);

    const headers = {};
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;
    if (c.headers) {
      try { Object.assign(headers, JSON.parse(c.headers)); }
      catch (e) { postInfo('额外请求头 JSON 解析失败：' + e.message); }
    }

    let resp;
    try {
      resp = await fetch(endpoint, { method: 'POST', headers, body: fd });
    } catch (e) {
      postInfo('请求异常：' + (e && e.message ? e.message : String(e)));
      throw e;
    }

    const respText = await resp.text().catch(() => '');
    postInfo('请求结束 ← HTTP ' + resp.status + ' | 响应长度=' + respText.length);

    if (!resp.ok) {
      const snippet = respText.slice(0, 220).replace(/\s+/g, ' ');
      throw new Error('HTTP ' + resp.status + (snippet ? '：' + snippet : ''));
    }

    let j = {};
    try { j = JSON.parse(respText); } catch (e) {
      // 某些接口直接返回纯文本
      if (respText.trim()) {
        postInfo('响应非 JSON，按纯文本处理');
        return respText.trim();
      }
      throw new Error('响应为空或不是 JSON');
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

    if (!text) {
      const keys = Object.keys(j).slice(0, 10).join(', ');
      postInfo('未识别到文本字段，响应键：' + (keys || '(空)'));
    } else {
      postInfo('转写成功：' + text.slice(0, 60) + (text.length > 60 ? '…' : ''));
    }
    return text;
  }

  function startHttp(opts, stream) {
    const mime = pickMime();
    let mr;
    try {
      mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) { postError('MediaRecorder 初始化失败：' + e.message); stopAll(); return; }
    mediaRecorder = mr;
    mr.ondataavailable = async (ev) => {
      if (!ev.data || !ev.data.size) return;
      try {
        const text = await httpTranscribe(opts, ev.data);
        if (text && text.trim()) postFinal(text.trim());
      } catch (e) {
        postError('转写请求失败：' + (e && e.message ? e.message : String(e)));
      }
    };
    mr.onerror = (e) => { postError('MediaRecorder 录制错误：' + (e && e.message ? e.message : 'unknown')); };
    mr.start(4000); // 每 4 秒产出一段，分段转写
    st.engine = 'custom_http'; postState();
    postInfo('HTTP 转写已启动，mime=' + (mime || 'default'));
  }

  // ---------------- 引擎 3：自定义 WebSocket 流式 ----------------
  async function startWs(opts, stream) {
    const c = opts.custom || {};
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { postError('AudioContext 初始化失败：' + e.message); stopAll(); return; }

    const srcNode = audioCtx.createMediaStreamSource(stream);
    try {
      await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/subtitle-pcm-worklet.js'));
    } catch (e) { postError('音频处理模块加载失败：' + e.message); stopAll(); return; }

    const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
    workletNode = node;
    srcNode.connect(node);
    node.port.onmessage = (ev) => {
      const buf = ev.data && ev.data.buffer;
      if (buf && ws && ws.readyState === 1) {
        try { ws.send(buf); } catch (_) {}
      }
    };

    let wsObj;
    postInfo('WebSocket 连接中 → ' + c.endpoint);
    try { wsObj = new WebSocket(c.endpoint); }
    catch (e) { postError('WebSocket 连接失败：' + e.message); stopAll(); return; }
    ws = wsObj; ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      postInfo('WebSocket 已连接');
      try { ws.send(JSON.stringify({ type: 'config', lang: c.language || 'auto', model: c.model || '' })); } catch (_) {}
    };
    ws.onmessage = (ev) => {
      let m = {};
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      const text = m.text || m.transcript || m.result || '';
      const isFinal = !!(m.isFinal || m.final || m.type === 'final');
      if (text) {
        postInfo('WS 收到' + (isFinal ? 'final' : 'partial') + '：' + text.slice(0, 60));
        if (isFinal) postFinal(text); else postPartial(text);
      }
    };
    ws.onerror = (e) => { postError('WebSocket 连接出错（请检查地址与网络）'); };
    ws.onclose = (e) => { if (st.active) postInfo('WebSocket 断开：' + e.code + ' ' + e.reason); };

    st.engine = 'custom_ws'; postState();
  }

  // ---------------- 引擎 4：小米 MiMo（Chat Completions ASR） ----------------
  // MiMo 的 mimo-v2.5-asr 是 Chat Completions 接口，与 OpenAI Whisper 的多部件表单不同：
  //   POST https://api.xiaomimimo.com/v1/chat/completions
  //   body: { model, messages:[{role:'user', content:[{type:'input_audio', input_audio:{data:'data:audio/wav;base64,...', format:'wav'}}]}], asr_options:{language}, stream:false }
  //   header: api-key: $KEY（同时兼容 Authorization: Bearer $KEY）
  //   resp: choices[0].message.content
  // 注意：MiMo 仅接受 MP3 / WAV，不接受 webm/opus，因此这里用 Web Audio 采集 PCM 并编码为 WAV。
  const MIMO_DEFAULT_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
  const MIMO_MODEL = 'mimo-v2.5-asr';

  // 单声道 Float32 采样 -> 16-bit PCM 的 WAV ArrayBuffer
  function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    let off = 0;
    const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };
    writeStr('RIFF'); view.setUint32(off, 36 + samples.length * 2, true); off += 4;
    writeStr('WAVE'); writeStr('fmt '); view.setUint32(off, 16, true); off += 4;
    view.setUint16(off, 1, true); off += 2;            // PCM
    view.setUint16(off, 1, true); off += 2;            // 单声道
    view.setUint32(off, sampleRate, true); off += 4;
    view.setUint32(off, sampleRate * 2, true); off += 4; // 字节率
    view.setUint16(off, 2, true); off += 2;            // block align
    view.setUint16(off, 16, true); off += 2;           // 位深
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

  // 线性重采样到目标采样率（默认 16k）并转单声道
  function resampleToMono(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const newLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) out[i] = input[Math.floor(i * ratio)];
    return out;
  }

  async function startMimo(opts, stream) {
    const c = opts.custom || {};
    const m = opts.mimo || {};
    const endpoint = m.url || MIMO_DEFAULT_ENDPOINT;
    const model = m.model || MIMO_MODEL;
    const apiKey = m.apiKey || c.apiKey || '';
    const langMap = { 'zh-CN': 'zh', 'zh-TW': 'zh', 'en-US': 'en', 'en-GB': 'en' };
    const capLang = opts.lang || c.language || 'auto';
    const asrLang = (capLang !== 'auto') ? (langMap[capLang] || 'auto') : 'auto';
    postInfo('MiMo 引擎启动 → ' + endpoint + ' | model=' + model + ' | lang=' + asrLang);

    let actx;
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { postError('AudioContext 初始化失败：' + e.message); stopAll(); return; }

    const srcNode = actx.createMediaStreamSource(stream);
    const targetRate = 16000;
    const node = actx.createScriptProcessor(4096, 1, 1);
    const collected = []; // Float32Array 片段（原始采样率）
    node.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      collected.push(new Float32Array(ch)); // 拷贝，buffer 会被复用
    };
    srcNode.connect(node);
    node.connect(actx.destination); // 必须连接 destination 才会驱动 onaudioprocess
    audioCtx = actx; mimoNode = node; mimoSrc = srcNode;

    let busy = false;
    async function flushSegment() {
      if (busy || collected.length === 0) return;
      busy = true;
      try {
        let total = 0;
        for (const seg of collected) total += seg.length;
        const merged = new Float32Array(total);
        let o = 0;
        for (const seg of collected) { merged.set(seg, o); o += seg.length; }
        collected.length = 0;
        const mono = resampleToMono(merged, actx.sampleRate, targetRate);
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
        if (c.headers) { try { Object.assign(headers, JSON.parse(c.headers)); } catch (e) { postInfo('额外请求头 JSON 解析失败：' + e.message); } }
        postInfo('MiMo 请求：base64 约 ' + b64.length + ' 字符');
        const resp = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
        const text = await resp.text().catch(() => '');
        if (!resp.ok) { postError('MiMo HTTP ' + resp.status + '：' + text.slice(0, 200)); return; }
        let j = {};
        try { j = JSON.parse(text); } catch (e) { postInfo('MiMo 响应非 JSON，按纯文本处理'); if (text.trim()) postFinal(text.trim()); return; }
        const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (content && content.trim()) postFinal(content.trim());
        else postInfo('MiMo 未返回文本');
      } catch (e) {
        postError('MiMo 请求失败：' + (e && e.message ? e.message : String(e)));
      } finally {
        busy = false;
      }
    }

    st.engine = 'mimo'; postState();
    mimoTimer = setInterval(flushSegment, 4000); // 每 4 秒转写一段
  }

  // ---------------- 启动 / 停止 ----------------
  async function start(opts) {
    st.active = true; st.lang = opts.lang; st.source = opts.source;
    postInfo('启动识别：engine=' + opts.engine + ' source=' + opts.source + ' lang=' + opts.lang);
    if (opts.engine === 'webspeech') {
      if (opts.source === 'tab') postInfo('Web Speech 仅支持麦克风输入，已自动切换为麦克风');
      startWebSpeech(opts);
      return;
    }
    try {
      const stream = await getStream(opts.source, opts.streamId || opts.targetTabId);
      mediaStream = stream;
      postInfo('音频流已获取，轨道数=' + stream.getAudioTracks().length);
      if (opts.engine === 'custom_http') startHttp(opts, stream);
      else if (opts.engine === 'custom_ws') await startWs(opts, stream);
      else if (opts.engine === 'mimo') await startMimo(opts, stream);
    } catch (e) {
      postError('音频获取失败：' + (e && e.message ? e.message : e));
      stopAll();
    }
  }

  function stopAll() {
    st.active = false;
    if (mimoTimer) { clearInterval(mimoTimer); mimoTimer = null; }
    try { if (rec) { rec.onend = null; rec.stop(); } } catch (_) {}
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (_) {}
    try { if (ws) ws.close(); } catch (_) {}
    try { if (workletNode) workletNode.disconnect(); } catch (_) {}
    try { if (mimoNode) { mimoNode.onaudioprocess = null; mimoNode.disconnect(); } } catch (_) {}
    try { if (mimoSrc) mimoSrc.disconnect(); } catch (_) {}
    try { if (audioCtx) audioCtx.close(); } catch (_) {}
    try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    rec = null; mediaRecorder = null; ws = null; workletNode = null; mimoNode = null; mimoSrc = null; audioCtx = null; mediaStream = null;
    postState();
  }

  // ---------------- 资源下载：录制标签页音频，结束后将音频数据交后台直接下载 ----------------
  // 关键修复：下载不再在 offscreen 内用 blob: URL 调用 chrome.downloads.download
  // （offscreen 文档在停止后会被后台关闭，blob URL 随之失效，导致界面一直卡在“正在保存”）。
  // 改为把录音数据（ArrayBuffer）回传后台，由 Service Worker 持有 Blob 并触发下载。
  var dl = { active: false, recorder: null, chunks: [], mime: '', stream: null };
  function postDlInfo(m) { send({ type: 'BAB_DL_INFO', msg: m }); }
  function tsName() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  async function startDownload(opts) {
    dl.active = true;
    postDlInfo('开始录制：标签页音频');
    try {
      const stream = await getStream('tab', opts.streamId || opts.targetTabId);
      dl.stream = stream;
      dl.mime = pickMime();
      let mr;
      try { mr = new MediaRecorder(stream, dl.mime ? { mimeType: dl.mime } : undefined); }
      catch (e) { postDlInfo('MediaRecorder 初始化失败：' + e.message); stopDownload(); return; }
      dl.recorder = mr;
      mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) dl.chunks.push(ev.data); };
      mr.onstop = () => {
        try { if (dl.stream) dl.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        if (!dl.chunks.length) { postDlInfo('录制已停止（无音频数据）'); dl.chunks = []; return; }
        const blob = new Blob(dl.chunks, { type: dl.mime || 'audio/webm' });
        const name = '标签页音频_' + tsName() + '.webm';
        const mime = dl.mime || 'audio/webm';
        dl.chunks = [];
        const forward = (buf) => {
          send({ type: 'BAB_DL_BLOB', name: name, mime: mime, buffer: buf });
          postDlInfo('录制完成，正在保存…');
        };
        if (blob.arrayBuffer) {
          blob.arrayBuffer().then(forward).catch((e) => { postDlInfo('音频读取失败：' + ((e && e.message) || e)); });
        } else {
          const r = new FileReader();
          r.onload = () => forward(r.result);
          r.onerror = () => { postDlInfo('音频读取失败'); };
          r.readAsArrayBuffer(blob);
        }
      };
      mr.onerror = (e) => { postDlInfo('录制错误：' + ((e && e.error && e.error.message) || 'unknown')); };
      mr.start(1000);
      postDlInfo('录制中…');
    } catch (e) {
      postDlInfo('音频获取失败：' + (e && e.message ? e.message : e));
      stopDownload();
    }
  }
  function stopDownload() {
    dl.active = false;
    try { if (dl.recorder && dl.recorder.state !== 'inactive') dl.recorder.stop(); } catch (_) {}
    try { if (dl.stream) dl.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    dl.recorder = null; dl.stream = null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'BAB_CAP_START_OFF') start(msg.opts);
    else if (msg.type === 'BAB_CAP_STOP_OFF') stopAll();
    else if (msg.type === 'BAB_DL_START_OFF') startDownload(msg.opts);
    else if (msg.type === 'BAB_DL_STOP_OFF') stopDownload();
  });

  send({ type: 'BAB_OFFSCREEN_READY', kind: 'caption' });
})();
