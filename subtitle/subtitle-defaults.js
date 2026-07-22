/*
 * Audio无限+ - 字幕共享模块（subtitle-defaults.js）
 * 供 popup / options / offscreen / 浮层 / 历史页 共用：
 *  - 默认设置 DEFAULTS
 *  - 语言列表 LANGS
 *  - 设置读写（chrome.storage.sync.babSettings.subtitle）
 *  - 样式应用（applyStyle）
 *  - SRT / TXT 导出与下载
 * 同时作为普通 <script> 与 content script 入口（挂到 window.BAB_SUB）。
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: false,
    engine: 'webspeech', // webspeech | custom | mimo
    lang: 'zh-CN',
    source: 'mic',       // mic | tab
    custom: {
      type: 'custom_http', // custom_http | custom_ws
      endpoint: '',
      apiKey: '',
      model: 'whisper-1',
      headers: ''          // 额外请求头，JSON 对象字符串，如 {"X-Foo":"bar"}
    },
    mimo: {
      url: 'https://api.xiaomimimo.com/v1/chat/completions', // 可在「识别引擎 - 小米 MiMo」下修改
      apiKey: '',
      model: 'mimo-v2.5-asr'
    },
    style: {
      fontFamily: "'SimSun','Songti SC','STSong','Noto Serif CJK SC',serif",
      fontSize: 30,
      color: '#000000',
      bgColor: '#ffffff',
      bgOpacity: 0,
      position: 'bottom',  // bottom | top（UI 已移除位置调整，固定为底部）
      align: 'center',     // left | center | right
      maxWidth: 80,        // 百分比；可调范围 30% ~ 300%
      height: 200,         // 字幕框最大高度（px）
      textShadow: false,   // UI 已移除文字阴影开关
      posX: null,          // 拖拽后自定义（px）
      posY: null
    },
    exportFormat: 'srt'    // srt | txt
  };

  const LANGS = [
    { code: 'zh-CN', name: '中文（普通话）' },
    { code: 'zh-TW', name: '中文（繁体）' },
    { code: 'en-US', name: '英语（美国）' },
    { code: 'en-GB', name: '英语（英国）' },
    { code: 'ja-JP', name: '日语' },
    { code: 'ko-KR', name: '韩语' },
    { code: 'fr-FR', name: '法语' },
    { code: 'de-DE', name: '德语' },
    { code: 'es-ES', name: '西班牙语' },
    { code: 'ru-RU', name: '俄语' },
    { code: 'pt-BR', name: '葡萄牙语（巴西）' },
    { code: 'it-IT', name: '意大利语' },
    { code: 'ar-SA', name: '阿拉伯语' },
    { code: 'hi-IN', name: '印地语' },
    { code: 'th-TH', name: '泰语' },
    { code: 'vi-VN', name: '越南语' },
    { code: 'id-ID', name: '印尼语' }
  ];

  function deepMerge(base, over) {
    if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
    const out = Object.assign({}, base);
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(over)) {
      const bv = base ? base[k] : undefined;
      const ov = over[k];
      if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
        out[k] = deepMerge(bv, ov);
      } else if (ov !== undefined) {
        out[k] = ov;
      }
    }
    return out;
  }

  function loadSettings(cb) {
    try {
      chrome.storage.sync.get('babSettings', (r) => {
        const s = (r && r.babSettings) || {};
        const sub = deepMerge(DEFAULTS, s.subtitle || {});
        cb(sub, s);
      });
    } catch (e) {
      cb(deepMerge(DEFAULTS, {}), {});
    }
  }

  // 串行化写入：避免连续修改（如先填 Endpoint 再填 API Key）时 read-modify-write 竞态，
  // 导致后一次写入覆盖前一次、把已输入的字段（如 API）静默丢弃（不启用实时字幕进入新播放页、
  // 无法记忆识别引擎输入的 api）。sub 为原地修改对象，入队执行时读取的是最新引用。
  let __saveChain = Promise.resolve();
  function saveSettings(sub, cb) {
    __saveChain = __saveChain
      .then(() => new Promise((resolve) => {
        try {
          chrome.storage.sync.get('babSettings', (r) => {
            const s = (r && r.babSettings) || {};
            s.subtitle = sub;
            chrome.storage.sync.set({ babSettings: s }, () => { if (cb) cb(); resolve(); });
          });
        } catch (e) { if (cb) cb(); resolve(); }
      }))
      .catch(() => { if (cb) cb(); });
  }

  // 把 style 应用到浮层根元素（CSS 变量 + 位置）
  function applyStyle(root, st) {
    if (!root) return;
    root.style.setProperty('--bab-sub-font', st.fontFamily);
    root.style.setProperty('--bab-sub-size', st.fontSize + 'px');
    root.style.setProperty('--bab-sub-color', st.color);
    root.style.setProperty('--bab-sub-bg', st.bgColor);
    root.style.setProperty('--bab-sub-bg-op', String(st.bgOpacity));
    root.style.setProperty('--bab-sub-maxw', st.maxWidth + '%');
    root.style.setProperty('--bab-sub-align', st.align);
    root.style.setProperty('--bab-sub-height', (st.height || 200) + 'px');
    root.classList.toggle('bab-sub-shadow', !!st.textShadow);

    if (st.posX != null && st.posY != null) {
      root.style.left = st.posX + 'px';
      root.style.top = st.posY + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      root.style.transform = 'none';
    } else {
      // 默认水平居中、垂直位于屏幕中下（中间偏下），仅在拖拽记忆位置时才使用自定义坐标
      root.style.left = '50%';
      root.style.right = 'auto';
      root.style.transform = 'translateX(-50%)';
      if (st.position === 'top') {
        root.style.top = '24px';
        root.style.bottom = 'auto';
      } else {
        root.style.top = '62%';
        root.style.bottom = 'auto';
      }
    }
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtSrtTime(sec) {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + ',' + (ms < 100 ? (ms < 10 ? '00' + ms : '0' + ms) : ms);
  }

  // session: { startedAt, segments:[{start,end,text}] }
  function exportSRT(session) {
    if (!session || !session.segments) return '';
    const lines = [];
    session.segments.forEach((seg, i) => {
      const start = (typeof seg.start === 'number') ? seg.start : 0;
      const end = (typeof seg.end === 'number') ? seg.end : start + 2;
      lines.push(String(i + 1));
      lines.push(fmtSrtTime(start) + ' --> ' + fmtSrtTime(end));
      lines.push(seg.text || '');
      lines.push('');
    });
    return lines.join('\n');
  }

  function exportTXT(session, withTime) {
    if (!session || !session.segments) return '';
    return session.segments.map((seg) => {
      if (withTime) {
        const t = new Date((session.startedAt || Date.now()) + (seg.start || 0) * 1000);
        const ts = '[' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) + '] ';
        return ts + (seg.text || '');
      }
      return seg.text || '';
    }).join('\n');
  }

  function download(filename, text) {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {}
  }

  const API = {
    DEFAULTS, LANGS, deepMerge, loadSettings, saveSettings,
    applyStyle, exportSRT, exportTXT, download, fmtSrtTime
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.BAB_SUB = API;
})(typeof window !== 'undefined' ? window : this);
