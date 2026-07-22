/*
 * Audio无限+ - 共享音频引擎（与平台无关）
 *
 * 同时被以下场景复用：
 *   1. Content Script（B站 / 百度网盘 / 本地 file:// 页面）
 *   2. 全局音量增强注入脚本（任意网页，Volume Master 风格）
 *   3. 扩展内置「本地播放器」页面（player/local-player.html）
 *
 * 音频链路：
 *   media → MediaElementSource
 *        → [参数均衡器 EQ 链（多频段，可关）]
 *        → 噪声高通 → 低频Shelf → 人声Peaking → 高频Shelf → 齿音Peaking
 *        → 压缩器(音量均衡) → Makeup增益 → 主音量
 *        → [环绕音效 MS-Widener] → 输出
 *
 * 环绕音效：当开启且 width>100 时，用 Mid/Side 技术拓宽声场（声像更宽、更有空间感）；
 *          width=100 时为完全透明（恒等变换），不影响单声道内容。
 *
 * 关键约束：一个 media 元素只能创建一次 MediaElementSourceNode，
 * 因此对已接管的 media 做缓存，重复调用不会报错。
 */
(function (global) {
  'use strict';

  const PRESETS = {
    balanced: {
      label: '标准均衡',
      noiseHighpass: 80,
      lowShelfFreq: 120,
      lowShelfGain: 1,
      vocalFreq: 3000,
      vocalGain: 4,
      vocalQ: 0.9,
      highShelfFreq: 9000,
      highShelfGain: 3,
      deEsserFreq: 6500,
      deEsserGain: -2,
      compThreshold: -24,
      compRatio: 3,
      compAttack: 0.005,
      compRelease: 0.12,
      makeupGain: 1.2
    },
    voice: {
      label: '人声优先',
      noiseHighpass: 90,
      lowShelfFreq: 150,
      lowShelfGain: -1,
      vocalFreq: 2800,
      vocalGain: 4.5,
      vocalQ: 0.9,
      highShelfFreq: 10000,
      highShelfGain: 3,
      deEsserFreq: 6500,
      deEsserGain: -2.5,
      compThreshold: -28,
      compRatio: 4,
      compAttack: 0.004,
      compRelease: 0.1,
      makeupGain: 1.3
    },
    music: {
      label: '音乐/影视',
      noiseHighpass: 40,
      lowShelfFreq: 100,
      lowShelfGain: 4.5,
      vocalFreq: 3500,
      vocalGain: 2.5,
      vocalQ: 0.8,
      highShelfFreq: 10000,
      highShelfGain: 3.5,
      deEsserFreq: 8000,
      deEsserGain: -1.5,
      compThreshold: -20,
      compRatio: 2,
      compAttack: 0.01,
      compRelease: 0.2,
      makeupGain: 1.1
    },
    denoise: {
      label: '强力降噪',
      noiseHighpass: 120,
      lowShelfFreq: 180,
      lowShelfGain: -3,
      vocalFreq: 2800,
      vocalGain: 4,
      vocalQ: 1.0,
      highShelfFreq: 9000,
      highShelfGain: 2.5,
      deEsserFreq: 6500,
      deEsserGain: -3,
      compThreshold: -30,
      compRatio: 5,
      compAttack: 0.003,
      compRelease: 0.08,
      makeupGain: 1.35
    }
  };

  // 模块总开关（可由设置页统一控制）
  const DEFAULT_MODULES = {
    enhance: true    // 音频增强总开关（派生 vocal/denoise/compress/deesser/air/surround 全部细粒度处理）
  };

  // 参数均衡器（高级设置页）：多频段参量 EQ，每频段可调类型/频率/增益/Q
  // 初始仅 3 段（低架 / 峰值 / 高架），用户可在弹窗内随时“＋ 添加频段”扩展
  const DEFAULT_EQ = {
    enabled: true,
    bands: [
      { type: 'lowshelf',  freq: 100,   gain: 0, q: 0.707 },
      { type: 'peaking',   freq: 1000,  gain: 0, q: 1.0 },
      { type: 'highshelf', freq: 10000, gain: 0, q: 0.707 }
    ]
  };

  const DEFAULT_STATE = {
    enabled: false,
    preset: 'balanced',
    masterGain: 1.0,     // 用户主音量微调 0.5~6.0（最高 600%）
    clarity: 50,         // 人声清晰度 0(模糊/暖) ~ 100(清亮/亮)，50=预设基线
    width: 100,          // 环绕音效 100(关/透明) ~ 300(%)
    custom: null,
    modules: { ...DEFAULT_MODULES },
    eq: { enabled: true, bands: DEFAULT_EQ.bands.map((b) => ({ ...b })) }
  };

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.nodes = new WeakMap();   // media -> bundle
      this.active = new Set();      // 当前接管的 media 集合
      this.state = { ...DEFAULT_STATE, modules: { ...DEFAULT_MODULES } };
      // 录音/转写共用 tap：一个 MediaStreamAudioDestinationNode，汇总所有媒体已处理的输出
      // （disabled=原始音，enabled=增强后的音）。供本地播放器的“录制 & 下载”“语音转文字”复用。
      this.recordDest = null;
    }

    ensureContext() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      // 延迟创建录音 tap（仅在有 AudioContext 后；任意页面都能拿到，但仅在被请求时才有意义）
      if (!this.recordDest) {
        try { this.recordDest = this.ctx.createMediaStreamDestination(); } catch (e) { this.recordDest = null; }
      }
      return this.ctx;
    }

    // 返回包含“已处理音频”的 MediaStream，供 MediaRecorder 录制 / WS 推流。
    // 没有任何媒体被接管或上下文不可用时返回 null。
    getRecordingStream() {
      this.ensureContext();
      return (this.recordDest && this.recordDest.stream) ? this.recordDest.stream : null;
    }

    // 为单个 media 建立处理节点（仅一次）
    buildChain(media) {
      if (this.nodes.has(media)) return this.nodes.get(media);

      const ctx = this.ensureContext();
      if (!ctx) return null;

      let source;
      try {
        source = ctx.createMediaElementSource(media);
      } catch (e) {
        console.debug('[Audio无限+] createMediaElementSource 失败，跳过该媒体', e && e.message);
        return null;
      }

      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';

      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';

      const vocal = ctx.createBiquadFilter();
      vocal.type = 'peaking';

      const highShelf = ctx.createBiquadFilter();
      highShelf.type = 'highshelf';

      const deEsser = ctx.createBiquadFilter();
      deEsser.type = 'peaking';

      const comp = ctx.createDynamicsCompressor();

      const makeup = ctx.createGain();
      const master = ctx.createGain();

      // ---- 环绕音效 MS-Widener ----
      // upmix：强制 2 声道，单声道输入会被复制为双声道，避免环绕时丢声道
      const upmix = ctx.createGain();
      try {
        upmix.channelCount = 2;
        upmix.channelCountMode = 'explicit';
        upmix.channelInterpretation = 'speakers';
      } catch (e) { /* 老浏览器忽略 */ }

      const splitter = ctx.createChannelSplitter(2);
      const gLL = ctx.createGain();
      const gLR = ctx.createGain();
      const gRL = ctx.createGain();
      const gRR = ctx.createGain();
      const merger = ctx.createChannelMerger(2);

      // 串联主链
      source.connect(highpass);
      highpass.connect(lowShelf);
      lowShelf.connect(vocal);
      vocal.connect(highShelf);
      highShelf.connect(deEsser);
      deEsser.connect(comp);
      comp.connect(makeup);
      makeup.connect(master);

      // 串联环绕音效（始终经过，width=100 时为恒等变换，透明无染）
      master.connect(upmix);
      upmix.connect(splitter);
      splitter.connect(gLL, 0);
      splitter.connect(gLR, 1);
      splitter.connect(gRL, 0);
      splitter.connect(gRR, 1);
      gLL.connect(merger, 0, 0);
      gLR.connect(merger, 0, 1);
      gRL.connect(merger, 0, 0);
      gRR.connect(merger, 0, 1);
      merger.connect(ctx.destination);

      const bundle = {
        source, highpass, lowShelf, vocal, highShelf,
        deEsser, comp, makeup, master,
        upmix, splitter, gLL, gLR, gRL, gRR, merger,
        eqNodes: []
      };
      // 标记角色，便于测试与调试定位
      source._role = 'source'; highpass._role = 'highpass'; lowShelf._role = 'lowShelf';
      vocal._role = 'vocal'; highShelf._role = 'highShelf'; deEsser._role = 'deEsser';
      comp._role = 'comp'; makeup._role = 'makeup'; master._role = 'master';
      upmix._role = 'upmix'; splitter._role = 'splitter'; merger._role = 'merger';
      gLL._role = 'gLL'; gLR._role = 'gLR'; gRL._role = 'gRL'; gRR._role = 'gRR';

      this.nodes.set(media, bundle);
      this.active.add(media);
      return bundle;
    }

    // 将当前 state 应用到某个 media 的链路
    applyToMedia(media) {
      const b = this.nodes.get(media) || this.buildChain(media);
      if (!b) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const s = this.state;
      const mods = s.modules || DEFAULT_MODULES;
      // 功能模块重构：单一的「音频增强」总开关派生出全部细粒度处理节点。
      // 旧设置（vocal/denoise/...）无 enhance 键时视为开启，保证老用户音频不丢。
      const enhance = mods.enhance !== false;
      const m = {
        vocal: enhance, denoise: enhance, compress: enhance, deesser: enhance, air: enhance,
        surround: enhance
      };

      // 每次重布线前先断开 source / merger / EQ 节点，避免“开→关→再开”残留错误连接
      try { b.source.disconnect(); } catch (e) {}
      try { b.merger.disconnect(); } catch (e) {}
      b.eqNodes.forEach((n) => { try { n.disconnect(); } catch (e) {} });

      if (!s.enabled || !enhance) {
        // 关闭或「音频增强」模块未启用：source 直接连到扬声器（彻底旁路整条处理链），音频原样输出，绝不发闷
        b.source.connect(ctx.destination);
        // 录音/转写 tap：旁路时录到的也是原始音频，与用户听到的一致
        if (this.recordDest) b.source.connect(this.recordDest);
        // 仍把各节点参数置为透明，便于下次启用时状态干净（不影响已被旁路的音频）
        b.highpass.frequency.setTargetAtTime(20, t, 0.02);
        b.lowShelf.gain.setTargetAtTime(0, t, 0.02);
        b.vocal.gain.setTargetAtTime(0, t, 0.02);
        b.highShelf.gain.setTargetAtTime(0, t, 0.02);
        b.deEsser.gain.setTargetAtTime(0, t, 0.02);
        b.comp.threshold.setTargetAtTime(0, t, 0.02);
        b.comp.ratio.setTargetAtTime(1, t, 0.02);
        b.makeup.gain.setTargetAtTime(1, t, 0.02);
        b.master.gain.setTargetAtTime(s.masterGain, t, 0.02);
        return;
      }

      // 参数均衡器：按当前启用状态排好链路（source → EQ 链 → highpass，或 source → highpass）
      this._applyEqRouting(b, ctx);
      b.merger.connect(ctx.destination);
      // 录音/转写 tap：把最终混合输出并行送到 recordDest，录制/转写拿到的就是已增强的音频
      if (this.recordDest) b.merger.connect(this.recordDest);

      const p = { ...PRESETS[s.preset] };
      if (s.custom) Object.assign(p, s.custom);

      // ---- 人声清晰度（clarity）：以预设为基线，向“模糊/暖”或“清亮/亮”两端调制 ----
      const cl = (typeof s.clarity === 'number') ? s.clarity : 50;
      const d = (cl - 50) / 50; // -1(最暖) ~ +1(最亮)
      let vocalGain = p.vocalGain + d * 3.5;
      let vocalFreq = p.vocalFreq + (d > 0 ? d * 600 : 0);
      let highShelfGain = p.highShelfGain + d * 3.8;
      let deEsserGain = p.deEsserGain + d * 1.5; // 越亮，齿音抑制越轻
      let lowShelfGain = p.lowShelfGain - d * 2.5; // 越亮，低频略收；越暖，低频略加
      let noiseHighpass = p.noiseHighpass + (d > 0 ? d * 40 : 0); // 越亮，切掉更多隆隆

      // 模块总开关：关闭则对应节点透明
      if (!m.vocal) vocalGain = 0;
      if (!m.air) highShelfGain = 0;
      if (!m.deesser) deEsserGain = 0;
      if (!m.denoise) { noiseHighpass = 20; lowShelfGain = 0; }
      if (!m.compress) { p.compThreshold = 0; p.compRatio = 1; }

      const ramp = 0.03; // 平滑过渡，避免爆音
      b.highpass.frequency.setTargetAtTime(noiseHighpass, t, ramp);
      b.highpass.Q.setTargetAtTime(0.707, t, ramp);

      b.lowShelf.frequency.setTargetAtTime(p.lowShelfFreq, t, ramp);
      b.lowShelf.gain.setTargetAtTime(lowShelfGain, t, ramp);

      b.vocal.frequency.setTargetAtTime(vocalFreq, t, ramp);
      b.vocal.Q.setTargetAtTime(p.vocalQ, t, ramp);
      b.vocal.gain.setTargetAtTime(vocalGain, t, ramp);

      b.highShelf.frequency.setTargetAtTime(p.highShelfFreq, t, ramp);
      b.highShelf.gain.setTargetAtTime(highShelfGain, t, ramp);

      b.deEsser.frequency.setTargetAtTime(p.deEsserFreq, t, ramp);
      b.deEsser.Q.setTargetAtTime(4.0, t, ramp);
      b.deEsser.gain.setTargetAtTime(deEsserGain, t, ramp);

      b.comp.threshold.setTargetAtTime(p.compThreshold, t, ramp);
      b.comp.ratio.setTargetAtTime(p.compRatio, t, ramp);
      b.comp.attack.setTargetAtTime(p.compAttack, t, ramp);
      b.comp.release.setTargetAtTime(p.compRelease, t, ramp);
      b.comp.knee.setTargetAtTime(30, t, ramp);

      b.makeup.gain.setTargetAtTime(p.makeupGain, t, ramp);
      b.master.gain.setTargetAtTime(s.masterGain, t, ramp);

      // 参数均衡器：写入各频段类型/频率/增益/Q
      this._applyEqParams(b, t);

      // ---- 环绕音效：由初始界面「环绕音效」滑块（width）控制，仅 width>100 时拓宽 ----
      const w = (s.width > 100) ? s.width : 100;
      this._applyWidth(b, w, t);
    }

    _applyWidth(b, widthPct, t) {
      const k = (widthPct || 100) / 100; // >=1
      const g = 0.03;
      b.gLL.gain.setTargetAtTime((1 + k) / 2, t, g);
      b.gLR.gain.setTargetAtTime((1 - k) / 2, t, g);
      b.gRL.gain.setTargetAtTime((1 - k) / 2, t, g);
      b.gRR.gain.setTargetAtTime((1 + k) / 2, t, g);
    }

    // 参数均衡器：串联/跳过的路由（source → EQ 链 → highpass，或 source → highpass）
    _applyEqRouting(b, ctx) {
      const eq = this.state.eq;
      const bands = (eq && eq.enabled && Array.isArray(eq.bands) && eq.bands.length) ? eq.bands : [];

      // 先断开 source 与所有 EQ 节点，再根据频段数重连
      try { b.source.disconnect(); } catch (e) { /* 尚未连接 */ }
      b.eqNodes.forEach((n) => { try { n.disconnect(); } catch (e) { } });

      if (!bands.length) {
        b.source.connect(b.highpass);
        return;
      }

      // 频段数量动态增减，复用已创建节点
      while (b.eqNodes.length < bands.length) {
        const n = ctx.createBiquadFilter();
        n._role = 'eq';
        b.eqNodes.push(n);
      }
      while (b.eqNodes.length > bands.length) {
        b.eqNodes.pop();
      }

      b.source.connect(b.eqNodes[0]);
      for (let i = 0; i < b.eqNodes.length; i++) {
        if (i < b.eqNodes.length - 1) b.eqNodes[i].connect(b.eqNodes[i + 1]);
      }
      b.eqNodes[b.eqNodes.length - 1].connect(b.highpass);
    }

    // 参数均衡器：写入每频段的类型/频率/增益/Q
    _applyEqParams(b, t) {
      const eq = this.state.eq;
      if (!eq || !eq.enabled || !Array.isArray(eq.bands) || !eq.bands.length) return;
      const g = 0.02;
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      eq.bands.forEach((band, i) => {
        const n = b.eqNodes[i];
        if (!n) return;
        try { n.type = band.type || 'peaking'; } catch (e) { /* 旧浏览器忽略非法类型 */ }
        n.frequency.setTargetAtTime(clamp(+band.freq || 1000, 20, 20000), t, g);
        n.Q.setTargetAtTime(clamp(+band.q || 1, 0.0001, 30), t, g);
        n.gain.setTargetAtTime(clamp(+band.gain || 0, -24, 24), t, g);
      });
    }

    applyAll() {
      this.ensureContext();
      if (!this.ctx) return;
      this.active.forEach((m) => {
        if (typeof document !== 'undefined' && document.contains && !document.contains(m)) {
          this.active.delete(m);
        } else {
          this.applyToMedia(m);
        }
      });
    }

    // 接管一批 media 元素（video/audio），返回新接入的数量
    attach(mediaList) {
      let added = 0;
      Array.prototype.forEach.call(mediaList, (m) => {
        if (!this.nodes.has(m)) {
          const b = this.buildChain(m);
          if (b) {
            added++;
            m.addEventListener('play', () => this.ensureContext(), { once: true });
          }
        }
      });
      if (added) this.applyAll();
      return added;
    }

    getStats() {
      return {
        mediaCount: this.active.size,
        contextState: this.ctx ? this.ctx.state : 'none'
      };
    }
  }

  const api = { AudioEngine, PRESETS, DEFAULT_STATE, DEFAULT_MODULES, DEFAULT_EQ };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.AudioBoosterEngine = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
