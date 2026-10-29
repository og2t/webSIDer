// The tune heard: an AudioWorklet playing it, and where it is, in cycles, as the listener hears it.

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this._ready = null;
    this._position = null;
    this._seekingTo = null;
    this.clockHz = 985248;
    this.failure = null;
    this.onFailure = null;
  }

  // The context is made on the first user gesture; a browser keeps it silent until then.
  _ensure() {
    if (this._ready) return this._ready;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this._ready = this.ctx.audioWorklet.addModule(new URL('./sid-processor.js', import.meta.url)).then(() => {
      this.node = new AudioWorkletNode(this.ctx, 'sid-processor', { numberOfInputs: 0, outputChannelCount: [1] });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.9;
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.node.port.onmessage = (event) => this._message(event.data);
    });
    return this._ready;
  }

  _message(data) {
    if (data.type === 'loaded') {
      this.clockHz = data.clockHz;
    } else if (data.type === 'position') {
      if (data.seeking) return;
      this._position = data;
      this._seekingTo = null;
      if (data.failure && data.failure !== this.failure) {
        this.failure = data.failure;
        this.onFailure?.(data.failure);
      }
    } else if (data.type === 'failure') {
      this.failure = data.message;
      this.onFailure?.(data.message);
    }
  }

  async load(bytes, song) {
    await this._ensure();
    this._position = null;
    this._seekingTo = null;
    this.failure = null;
    this.node.port.postMessage({ type: 'load', bytes, song });
    await this.play();
  }

  get playing() {
    return this.ctx?.state === 'running';
  }

  async play() {
    await this._ensure();
    try {
      await this.ctx.resume();
    } catch {
      // Without a gesture the browser keeps it suspended; Play resumes it.
    }
  }

  async pause() {
    if (this.ctx) await this.ctx.suspend();
  }

  seek(cycle) {
    if (!this.node) return;
    this._seekingTo = cycle;
    this.node.port.postMessage({ type: 'seek', cycle });
  }

  setMuted(voice, muted) {
    this.node?.port.postMessage({ type: 'mute', voice, muted });
  }

  // The cycle being heard now: the last report, moved on by the audio clock, less the output latency.
  get cycle() {
    if (this._seekingTo !== null) return this._seekingTo;
    const p = this._position;
    if (!p || !this.ctx) return 0;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const heard = this.ctx.currentTime - latency;
    return p.cycle + (heard - p.frame / this.ctx.sampleRate) * this.clockHz;
  }
}
