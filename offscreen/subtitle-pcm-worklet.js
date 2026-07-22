/*
 * Audio无限+ - 字幕 PCM 采集 AudioWorklet
 * 将任意声道的输入混为单声道 Float32，按 ~20ms 一帧 postMessage 出去（原生采样率）。
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.max(128, Math.round(0.02 * sampleRate));
    this.chunk = null;
    this.off = 0;
  }
  process(inputs) {
    const input = inputs && inputs[0];
    if (!input || !input.length || !input[0] || input[0].length === 0) return true;
    const ch = input.length;
    const len = input[0].length;
    if (!this.chunk) this.chunk = new Float32Array(this.chunkSize);
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += input[c][i];
      const v = ch > 0 ? s / ch : 0;
      this.chunk[this.off++] = v;
      if (this.off >= this.chunkSize) {
        const out = this.chunk;
        this.chunk = new Float32Array(this.chunkSize);
        this.off = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
