// The audio thread: plays the tune live and reports which cycle each block of samples is.

import { SidFile } from '../sidfile.js';
import { SidEngine } from './engine.js';

const REPORT_EVERY = 8;

class SidProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.block = new Int16Array(128);
    this.blocks = 0;
    this.port.onmessage = (event) => this.message(event.data);
  }

  message(data) {
    try {
      switch (data.type) {
        case 'load': {
          const file = SidFile.parse(data.bytes);
          this.engine = new SidEngine(file, data.song, sampleRate);
          this.port.postMessage({ type: 'loaded', clockHz: this.engine.clockHz, startCycle: this.engine.startCycle });
          break;
        }
        case 'seek':
          this.engine?.seek(data.cycle);
          break;
        case 'mute':
          this.engine?.setMuted(data.voice, data.muted);
          break;
        case 'stop':
          this.engine = null;
          break;
      }
    } catch (error) {
      this.engine = null;
      this.port.postMessage({ type: 'failure', message: error.message });
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const engine = this.engine;
    if (!engine) {
      out.fill(0);
      return true;
    }

    const first = engine.outputSamples;
    const heard = engine.render(this.block, 0, out.length);
    for (let i = 0; i < out.length; i++) out[i] = this.block[i] / 32768;

    if (++this.blocks % REPORT_EVERY === 0 || !heard) {
      this.port.postMessage({
        type: 'position',
        frame: currentFrame,
        cycle: engine.cycleAt(first),
        seeking: engine.seekTarget !== null,
        failure: engine.failure,
      });
    }
    return true;
  }
}

registerProcessor('sid-processor', SidProcessor);
