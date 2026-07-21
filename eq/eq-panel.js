/*
 * Audio无限+ - 可复用参量均衡器面板
 *
 * 用法（在任意扩展页内）：
 *   <link rel="stylesheet" href=".../eq/eq-panel.css">
 *   <div id="eqMount"></div>
 *   <script src=".../audio-engine.js"></script>
 *   <script src=".../eq/eq-panel.js"></script>
 *   <script>
 *     const handle = mountEqPanel(document.getElementById('eqMount'), {
 *       getModel: () => ({ enabled, bands }),   // 返回当前 EQ 模型
 *       setModel: (model) => { ... 持久化 ... }  // 用户改动后回调
 *     });
 *     // 外部（其它页面 / 标签页）改动后调用 handle.refresh() 重新渲染
 *   </script>
 *
 * 面板内部负责：启用开关、实时频率响应曲线、频段增删与逐段（类型/频率/增益/Q）编辑、快速预设。
 * 初始频段数量由 audio-engine.js 的 DEFAULT_EQ 决定（默认精简为 3 段）。
 */
(function () {
  'use strict';

  const DEFAULT_EQ = (window.AudioBoosterEngine && window.AudioBoosterEngine.DEFAULT_EQ) || {
    enabled: true,
    bands: [
      { type: 'lowshelf', freq: 100, gain: 0, q: 0.707 },
      { type: 'peaking', freq: 1000, gain: 0, q: 1.0 },
      { type: 'highshelf', freq: 10000, gain: 0, q: 0.707 }
    ]
  };

  const TYPE_LABELS = {
    lowshelf: '低频搁架', highshelf: '高频搁架', peaking: '峰值',
    lowpass: '低通', highpass: '高通', bandpass: '带通', notch: '陷波'
  };

  // 快速预设（直接替换当前频段，频段数可多于默认）
  const PRESET_BANDS = {
    warm: [
      { type: 'lowshelf', freq: 120, gain: 5, q: 0.707 },
      { type: 'peaking', freq: 250, gain: 3, q: 1 },
      { type: 'peaking', freq: 500, gain: 1, q: 1 },
      { type: 'peaking', freq: 1000, gain: 0, q: 1 },
      { type: 'peaking', freq: 2000, gain: -1, q: 1 },
      { type: 'peaking', freq: 4000, gain: -2, q: 1 },
      { type: 'peaking', freq: 8000, gain: -3, q: 1 },
      { type: 'highshelf', freq: 10000, gain: -4, q: 0.707 }
    ],
    bright: [
      { type: 'lowshelf', freq: 120, gain: -3, q: 0.707 },
      { type: 'peaking', freq: 500, gain: -1, q: 1 },
      { type: 'peaking', freq: 2000, gain: 1, q: 1 },
      { type: 'peaking', freq: 4000, gain: 3, q: 1 },
      { type: 'peaking', freq: 8000, gain: 4, q: 1 },
      { type: 'highshelf', freq: 10000, gain: 5, q: 0.707 }
    ],
    vocal: [
      { type: 'lowshelf', freq: 150, gain: -2, q: 0.707 },
      { type: 'peaking', freq: 300, gain: -1, q: 1 },
      { type: 'peaking', freq: 1500, gain: 2, q: 1 },
      { type: 'peaking', freq: 2800, gain: 4, q: 1 },
      { type: 'peaking', freq: 4500, gain: 3, q: 1 },
      { type: 'peaking', freq: 8000, gain: 2, q: 1 },
      { type: 'highshelf', freq: 12000, gain: 2, q: 0.707 }
    ],
    bass: [
      { type: 'lowshelf', freq: 80, gain: 6, q: 0.707 },
      { type: 'peaking', freq: 160, gain: 4, q: 1 },
      { type: 'peaking', freq: 400, gain: 1, q: 1 },
      { type: 'peaking', freq: 1000, gain: -1, q: 1 },
      { type: 'highshelf', freq: 12000, gain: 2, q: 0.707 }
    ]
  };

  const FMIN = 20, FMAX = 20000;
  const freqToPos = (f) => 1000 * Math.log10(f / FMIN) / Math.log10(FMAX / FMIN); // 0..1000
  const posToFreq = (p) => FMIN * Math.pow(FMAX / FMIN, p / 1000);
  function fmtHz(f) {
    return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.0+$/, '') + ' kHz' : Math.round(f) + ' Hz';
  }

  window.mountEqPanel = function (root, opts) {
    if (!root || !opts || typeof opts.getModel !== 'function' || typeof opts.setModel !== 'function') {
      console.error('[Audio无限+] mountEqPanel 参数无效');
      return { refresh() {} };
    }

    function cloneModel(m) {
      const src = (m && typeof m === 'object') ? m : {};
      return {
        enabled: src.enabled !== false,
        bands: Array.isArray(src.bands) ? src.bands.map((b) => ({
          type: b.type, freq: b.freq, gain: b.gain, q: b.q, bypass: !!b.bypass
        })) : []
      };
    }

    let model = cloneModel(opts.getModel());

    root.innerHTML = `
      <section class="panel curve-panel">
        <div class="curve-top">
          <label class="master-toggle">
            <input type="checkbox" class="eq-enabled">
            <span class="track"></span>
            <span class="master-label">启用均衡器</span>
          </label>
          <span class="curve-hint"></span>
        </div>
        <canvas class="eq-curve"></canvas>
      </section>

      <section class="panel">
        <div class="panel-title"><span>频段</span><span class="count"></span></div>
        <div class="bands"></div>
        <button class="add-band">＋ 添加频段</button>
      </section>

      <section class="panel">
        <div class="panel-title">快速预设</div>
        <div class="presets">
          <button class="ep" data-preset="flat">平直</button>
          <button class="ep" data-preset="default">默认</button>
          <button class="ep" data-preset="warm">暖声</button>
          <button class="ep" data-preset="bright">明亮</button>
          <button class="ep" data-preset="vocal">人声突出</button>
          <button class="ep" data-preset="bass">低音增强</button>
        </div>
      </section>`;

    const enabledEl = root.querySelector('.eq-enabled');
    const hintEl = root.querySelector('.curve-hint');
    const canvas = root.querySelector('.eq-curve');
    const ctx2d = canvas.getContext('2d');
    const bandsBox = root.querySelector('.bands');
    const countEl = root.querySelector('.count');

    // 与设置页一致的主题
    try {
      chrome.storage.sync.get('babSettings', (r) => {
        const s = (r && r.babSettings) || {};
        if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
        if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
      });
    } catch (e) {}

    function setFill(el) {
      const min = +el.min, max = +el.max, v = +el.value;
      el.style.setProperty('--fill', ((v - min) / (max - min) * 100) + '%');
    }

    function renderAll() {
      enabledEl.checked = model.enabled;
      countEl.textContent = model.bands.length;
      renderBands();
      drawCurve();
      updateHint();
    }

    function renderBands() {
      bandsBox.innerHTML = '';
      model.bands.forEach((b, i) => {
        const row = document.createElement('div');
        row.className = 'band';
        const optsHtml = Object.keys(TYPE_LABELS)
          .map((t) => `<option value="${t}" ${t === b.type ? 'selected' : ''}>${TYPE_LABELS[t]}</option>`).join('');
        row.innerHTML = `
          <div class="band-head">
            <span class="band-idx">${i + 1}</span>
            <select class="band-type">${optsHtml}</select>
            <label class="band-bypass"><input type="checkbox" ${b.bypass ? 'checked' : ''}> 旁路</label>
            <button class="band-del" ${model.bands.length <= 2 ? 'disabled' : ''} title="删除频段">✕</button>
          </div>
          <div class="band-ctrl">
            <div class="ctrl">
              <span class="ctrl-label">频率</span>
              <input type="range" class="range band-freq" min="0" max="1000" step="1" value="${Math.round(freqToPos(b.freq))}">
              <span class="ctrl-val band-freq-val">${fmtHz(b.freq)}</span>
            </div>
            <div class="ctrl">
              <span class="ctrl-label">增益</span>
              <input type="range" class="range band-gain" min="-12" max="12" step="0.5" value="${b.gain}">
              <span class="ctrl-val band-gain-val">${(+b.gain).toFixed(1)} dB</span>
            </div>
            <div class="ctrl">
              <span class="ctrl-label">Q 值</span>
              <input type="range" class="range band-q" min="0.1" max="18" step="0.1" value="${b.q}">
              <span class="ctrl-val band-q-val">${(+b.q).toFixed(1)}</span>
            </div>
          </div>`;

        const typeSel = row.querySelector('.band-type');
        const freqEl = row.querySelector('.band-freq');
        const gainEl = row.querySelector('.band-gain');
        const qEl = row.querySelector('.band-q');
        const bypassEl = row.querySelector('.band-bypass input');
        const delBtn = row.querySelector('.band-del');
        setFill(freqEl); setFill(gainEl); setFill(qEl);

        typeSel.addEventListener('change', () => { b.type = typeSel.value; afterChange(); });
        freqEl.addEventListener('input', () => {
          b.freq = Math.round(posToFreq(+freqEl.value));
          row.querySelector('.band-freq-val').textContent = fmtHz(b.freq);
          setFill(freqEl); afterChange();
        });
        gainEl.addEventListener('input', () => {
          b.gain = +gainEl.value;
          row.querySelector('.band-gain-val').textContent = (+b.gain).toFixed(1) + ' dB';
          setFill(gainEl); afterChange();
        });
        qEl.addEventListener('input', () => {
          b.q = +qEl.value;
          row.querySelector('.band-q-val').textContent = (+b.q).toFixed(1);
          setFill(qEl); afterChange();
        });
        bypassEl.addEventListener('change', () => { b.bypass = bypassEl.checked; afterChange(); });
        delBtn.addEventListener('click', () => {
          if (model.bands.length <= 2) return;
          model.bands.splice(i, 1);
          renderAll(); save();
        });
        bandsBox.appendChild(row);
      });
    }

    let saveTimer = null;
    function afterChange() {
      drawCurve();
      updateHint();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 250);
    }
    function updateHint() {
      const anyNonZero = model.bands.some((b) => !b.bypass && Math.abs(b.gain) > 0.01);
      hintEl.textContent = model.enabled ? (anyNonZero ? '自定义' : '平直') : '已停用';
    }
    function save() {
      opts.setModel({
        enabled: model.enabled,
        bands: model.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q }))
      });
    }

    // ---------------- 频率响应曲线 ----------------
    let _ctx = null;
    function getCtx() {
      if (!_ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) _ctx = new AC();
      }
      return _ctx;
    }
    const N = 160;
    const freqs = (function () {
      const a = new Float32Array(N);
      for (let i = 0; i < N; i++) a[i] = FMIN * Math.pow(FMAX / FMIN, i / (N - 1));
      return a;
    })();
    function computeMag(bands) {
      const ac = getCtx();
      const mag = new Float32Array(N); mag.fill(1);
      if (!ac) return mag;
      const m = new Float32Array(N), ph = new Float32Array(N);
      bands.forEach((b) => {
        if (b.bypass) return;
        const f = ac.createBiquadFilter();
        f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q; f.gain.value = b.gain;
        f.getFrequencyResponse(freqs, m, ph);
        for (let i = 0; i < N; i++) mag[i] *= m[i];
      });
      return mag;
    }
    function drawCurve() {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, W, H);
      const pad = 16, RANGE = 24;
      const xOf = (f) => pad + (Math.log10(f) - Math.log10(FMIN)) / (Math.log10(FMAX) - Math.log10(FMIN)) * (W - 2 * pad);
      const yOf = (db) => H / 2 - (Math.max(-RANGE, Math.min(RANGE, db)) / RANGE) * (H / 2 - pad);

      ctx2d.lineWidth = 1; ctx2d.font = '10px sans-serif';
      [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach((f) => {
        const x = xOf(f);
        ctx2d.strokeStyle = 'rgba(140,150,167,0.12)';
        ctx2d.beginPath(); ctx2d.moveTo(x, pad); ctx2d.lineTo(x, H - pad); ctx2d.stroke();
        ctx2d.fillStyle = 'rgba(140,150,167,0.6)'; ctx2d.textAlign = 'center';
        ctx2d.fillText(f >= 1000 ? (f / 1000) + 'k' : f, x, H - 3);
      });
      [-18, -12, -6, 0, 6, 12, 18].forEach((db) => {
        const y = yOf(db);
        ctx2d.strokeStyle = db === 0 ? 'rgba(140,150,167,0.35)' : 'rgba(140,150,167,0.12)';
        ctx2d.beginPath(); ctx2d.moveTo(pad, y); ctx2d.lineTo(W - pad, y); ctx2d.stroke();
        ctx2d.fillStyle = 'rgba(140,150,167,0.6)'; ctx2d.textAlign = 'left';
        ctx2d.fillText((db > 0 ? '+' : '') + db, 2, y - 2);
      });

      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6C5CE7';
      const mag = model.enabled ? computeMag(model.bands) : null;
      ctx2d.lineWidth = 2.5; ctx2d.strokeStyle = accent; ctx2d.beginPath();
      for (let i = 0; i < N; i++) {
        const f = freqs[i];
        const db = mag ? 20 * Math.log10(Math.max(1e-4, mag[i])) : 0;
        const x = xOf(f), y = yOf(db);
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();
      if (mag) {
        ctx2d.lineTo(xOf(FMAX), H / 2); ctx2d.lineTo(xOf(FMIN), H / 2); ctx2d.closePath();
        ctx2d.fillStyle = accent + '22'; ctx2d.fill();
      }
    }

    // ---------------- 控制 ----------------
    enabledEl.addEventListener('change', (e) => { model.enabled = e.target.checked; afterChange(); });
    root.querySelector('.add-band').addEventListener('click', () => {
      model.bands.push({ type: 'peaking', freq: 1000, gain: 0, q: 1 });
      renderAll(); save();
    });
    root.querySelector('.presets').addEventListener('click', (e) => {
      const btn = e.target.closest('.ep');
      if (!btn) return;
      const p = btn.dataset.preset;
      if (p === 'flat') model.bands.forEach((b) => { b.gain = 0; });
      else if (p === 'default') model.bands = DEFAULT_EQ.bands.map((b) => ({ ...b }));
      else if (PRESET_BANDS[p]) model.bands = PRESET_BANDS[p].map((b) => ({ ...b }));
      renderAll(); save();
    });
    window.addEventListener('resize', drawCurve);

    renderAll();

    return {
      refresh() {
        model = cloneModel(opts.getModel());
        renderAll();
      }
    };
  };
})();
