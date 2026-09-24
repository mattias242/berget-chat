class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._total = 0;
    this._target = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'config') this._target = e.data.samples | 0;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    this._chunks.push(new Float32Array(ch));
    this._total += ch.length;

    while (this._target > 0 && this._total >= this._target) {
      const out = new Float32Array(this._target);
      let off = 0;
      while (off < this._target) {
        const c = this._chunks[0];
        const need = this._target - off;
        if (c.length <= need) {
          out.set(c, off);
          off += c.length;
          this._chunks.shift();
        } else {
          out.set(c.subarray(0, need), off);
          this._chunks[0] = c.subarray(need);
          off += need;
        }
      }
      this._total -= this._target;
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PCMCaptureProcessor);
