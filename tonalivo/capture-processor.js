/* global currentFrame, registerProcessor, AudioWorkletProcessor */
/**
 * Collects microphone samples into fixed-size blocks and forwards them, with
 * the AudioContext frame index of the first sample, over a MessagePort
 * (directly to the analysis worker once one is attached).
 *
 * Input 0: microphone. Input 1: the "monitor" bus (everything the app plays –
 * metronome and piano), captured sample-aligned for recordings.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024;
    this.buf = new Float32Array(this.size);
    this.mon = new Float32Array(this.size);
    this.n = 0;
    this.start = 0;
    this.out = this.port;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'port') this.out = e.data.port;
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    const mon = inputs[1] && inputs[1][0];
    for (let i = 0; i < ch.length; i++) {
      if (this.n === 0) this.start = currentFrame + i;
      this.mon[this.n] = mon ? mon[i] : 0;
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        this.out.postMessage({ type: 'audio', samples: this.buf, monitor: this.mon, start: this.start }, [this.buf.buffer, this.mon.buffer]);
        this.buf = new Float32Array(this.size);
        this.mon = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
