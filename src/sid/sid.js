// The SID chip: reSID by Dag Lem (C) 2004, as translated to C# by Magnar Harestad for MagPlaySID,
// ported to JavaScript. GPL v2 or later.

import * as tables from './tables.js';

export const ChipModel = Object.freeze({ Mos6581: 6581, Mos8580: 8580 });

// ---------------------------------------------------------------- waveform generator

// The floating DAC: how long a waveform-off value holds, then how often it loses bits fading.
const FLOATING_TTL_6581 = 54000, FLOATING_FADE_6581 = 1400;
const FLOATING_TTL_8580 = 800000, FLOATING_FADE_8580 = 50000;

class WaveformGenerator {
  constructor() {
    this.syncSource = this;
    this.syncDest = null;
    this.is6581 = true;
    this.waveform = 0;
    this.setChipModel(ChipModel.Mos6581);
    this.reset();
  }

  setSyncSource(source) {
    this.syncSource = source;
    source.syncDest = this;
  }

  setChipModel(model) {
    this.is6581 = model === ChipModel.Mos6581;
    const t = this.is6581
      ? [tables.wave6581_ST, tables.wave6581_PT, tables.wave6581_PS, tables.wave6581_PST]
      : [tables.wave8580_ST, tables.wave8580_PT, tables.wave8580_PS, tables.wave8580_PST];
    [this.waveST, this.wavePT, this.wavePS, this.wavePST] = t;
  }

  reset() {
    this.accumulator = 0;
    this.shiftRegister = 0x7ffff8;
    this.freq = 0;
    this.pw = 0;
    this.test = 0;
    this.ringMod = 0;
    this.sync = 0;
    this.msbRising = false;
    this.floatingOutput = 0;
    this.floatingCycles = 0;
  }

  clock() {
    if (this.floatingCycles !== 0 && this.waveform === 0) this._ageFloating(1);
    if (this.test !== 0) return;

    const prev = this.accumulator;
    this.accumulator = (prev + this.freq) & 0xffffff;
    this.msbRising = (prev & 0x800000) === 0 && (this.accumulator & 0x800000) !== 0;

    // The noise register shifts each time accumulator bit 19 goes high.
    if ((prev & 0x080000) === 0 && (this.accumulator & 0x080000) !== 0) {
      const bit0 = ((this.shiftRegister >> 22) ^ (this.shiftRegister >> 17)) & 1;
      this.shiftRegister = ((this.shiftRegister << 1) & 0x7fffff) | bit0;
    }
  }

  clockDelta(deltaT) {
    if (this.floatingCycles !== 0 && this.waveform === 0) this._ageFloating(deltaT);
    if (this.test !== 0) return;

    const prev = this.accumulator;
    let deltaAccumulator = deltaT * this.freq;
    this.accumulator = (prev + deltaAccumulator) % 0x1000000;
    this.msbRising = (prev & 0x800000) === 0 && (this.accumulator & 0x800000) !== 0;

    let shiftPeriod = 0x100000;
    while (deltaAccumulator !== 0) {
      if (deltaAccumulator < shiftPeriod) {
        shiftPeriod = deltaAccumulator;
        if (shiftPeriod <= 0x080000) {
          if (((this.accumulator - shiftPeriod) & 0x080000) !== 0 || (this.accumulator & 0x080000) === 0) break;
        } else if (((this.accumulator - shiftPeriod) & 0x080000) !== 0 && (this.accumulator & 0x080000) === 0) {
          break;
        }
      }
      const bit0 = ((this.shiftRegister >> 22) ^ (this.shiftRegister >> 17)) & 1;
      this.shiftRegister = ((this.shiftRegister << 1) & 0x7fffff) | bit0;
      deltaAccumulator -= shiftPeriod;
    }
  }

  // A source synced itself on the cycle its MSB rises does not sync its destination.
  synchronize() {
    const dest = this.syncDest;
    if (dest && this.msbRising && dest.sync !== 0 && !(this.sync !== 0 && this.syncSource.msbRising)) dest.accumulator = 0;
  }

  _ageFloating(cycles) {
    this.floatingCycles -= cycles;
    while (this.floatingCycles <= 0 && this.floatingOutput !== 0) {
      this.floatingOutput &= this.floatingOutput >> 1;
      this.floatingCycles += this.is6581 ? FLOATING_FADE_6581 : FLOATING_FADE_8580;
    }
    if (this.floatingOutput === 0) this.floatingCycles = 0;
  }

  writeFreqLo(v) { this.freq = (this.freq & 0xff00) | (v & 0xff); }
  writeFreqHi(v) { this.freq = ((v << 8) & 0xff00) | (this.freq & 0xff); }
  writePwLo(v) { this.pw = (this.pw & 0xf00) | (v & 0xff); }
  writePwHi(v) { this.pw = ((v << 8) & 0xf00) | (this.pw & 0xff); }

  writeControlReg(control) {
    const next = (control >> 4) & 0x0f;
    // Switching the waveform off keeps what it was putting out, before the test bit clears it.
    if (next === 0 && this.waveform !== 0) {
      this.floatingOutput = this.output();
      this.floatingCycles = this.is6581 ? FLOATING_TTL_6581 : FLOATING_TTL_8580;
    }
    this.waveform = next;
    this.ringMod = control & 0x04;
    this.sync = control & 0x02;

    const testNext = control & 0x08;
    if (testNext !== 0) {
      this.accumulator = 0;
      this.shiftRegister = 0;
    } else if (this.test !== 0) {
      this.shiftRegister = 0x7ffff8;
    }
    this.test = testNext;
  }

  readOsc() { return this.output() >> 4; }

  output() {
    switch (this.waveform) {
      case 0x0: return this.floatingOutput;
      case 0x1: return this._triangle();
      case 0x2: return this._sawtooth();
      case 0x3: return this.waveST[this._sawtooth()] << 4;
      case 0x4: return this._pulse();
      case 0x5: return (this.wavePT[this._triangle() >> 1] << 4) & this._pulse();
      case 0x6: return (this.wavePS[this._sawtooth()] << 4) & this._pulse();
      case 0x7: return (this.wavePST[this._sawtooth()] << 4) & this._pulse();
      case 0x8: return this._noise();
      default: return 0;
    }
  }

  // The upper 12 bits of the accumulator, the MSB folding the lower 11; ring mod EORs in the source's MSB.
  _triangle() {
    const acc = this.accumulator;
    const msb = (this.ringMod !== 0 ? acc ^ this.syncSource.accumulator : acc) & 0x800000;
    return ((msb !== 0 ? ~acc : acc) >> 11) & 0xfff;
  }

  _sawtooth() { return (this.accumulator >> 12) & 0xfff; }

  _pulse() { return this.test !== 0 || this.accumulator >> 12 >= this.pw ? 0xfff : 0; }

  _noise() {
    const s = this.shiftRegister;
    return ((s & 0x400000) >> 11) | ((s & 0x100000) >> 10) | ((s & 0x010000) >> 7) | ((s & 0x002000) >> 5)
      | ((s & 0x000800) >> 4) | ((s & 0x000080) >> 1) | ((s & 0x000010) << 1) | ((s & 0x000004) << 2);
  }
}

// ---------------------------------------------------------------- envelope generator

const RATE_COUNTER_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
const SUSTAIN_LEVEL = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
const ATTACK = 0, DECAY_SUSTAIN = 1, RELEASE = 2;

function exponentialPeriod(counter, current) {
  switch (counter) {
    case 0xff: return 1;
    case 0x5d: return 2;
    case 0x36: return 4;
    case 0x1a: return 8;
    case 0x0e: return 16;
    case 0x06: return 30;
    case 0x00: return 1;
    default: return current;
  }
}

class EnvelopeGenerator {
  constructor() { this.reset(); }

  reset() {
    this.envelopeCounter = 0;
    this.attack = 0; this.decay = 0; this.sustain = 0; this.release = 0;
    this.gate = 0;
    this.rateCounter = 0;
    this.exponentialCounter = 0;
    this.exponentialCounterPeriod = 1;
    this.state = RELEASE;
    this.ratePeriod = RATE_COUNTER_PERIOD[this.release];
    this.holdZero = true;
  }

  // One envelope step, once the rate counter reaches its period.
  _step() {
    if (this.state === ATTACK || ++this.exponentialCounter === this.exponentialCounterPeriod) {
      this.exponentialCounter = 0;
      if (this.holdZero) return;
      switch (this.state) {
        case ATTACK:
          this.envelopeCounter = (this.envelopeCounter + 1) & 0xff;
          if (this.envelopeCounter === 0xff) {
            this.state = DECAY_SUSTAIN;
            this.ratePeriod = RATE_COUNTER_PERIOD[this.decay];
          }
          break;
        case DECAY_SUSTAIN:
          if (this.envelopeCounter !== SUSTAIN_LEVEL[this.sustain]) this.envelopeCounter = (this.envelopeCounter - 1) & 0xff;
          break;
        default:
          this.envelopeCounter = (this.envelopeCounter - 1) & 0xff;
          break;
      }
      this.exponentialCounterPeriod = exponentialPeriod(this.envelopeCounter, this.exponentialCounterPeriod);
      if (this.envelopeCounter === 0) this.holdZero = true;
    }
  }

  // The ADSR delay bug: a period set below the counter makes it wrap at $8000 first.
  clock() {
    if ((++this.rateCounter & 0x8000) !== 0) this.rateCounter = (this.rateCounter + 1) & 0x7fff;
    if (this.rateCounter !== this.ratePeriod) return;
    this.rateCounter = 0;
    this._step();
  }

  clockDelta(deltaT) {
    let rateStep = this.ratePeriod - this.rateCounter;
    if (rateStep <= 0) rateStep += 0x7fff;
    while (deltaT !== 0) {
      if (deltaT < rateStep) {
        this.rateCounter += deltaT;
        if ((this.rateCounter & 0x8000) !== 0) this.rateCounter = (this.rateCounter + 1) & 0x7fff;
        return;
      }
      this.rateCounter = 0;
      deltaT -= rateStep;
      this._step();
      rateStep = this.ratePeriod;
    }
  }

  writeControlReg(control) {
    const next = control & 1;
    if (this.gate === 0 && next !== 0) {
      this.state = ATTACK;
      this.ratePeriod = RATE_COUNTER_PERIOD[this.attack];
      this.holdZero = false;
    } else if (this.gate !== 0 && next === 0) {
      this.state = RELEASE;
      this.ratePeriod = RATE_COUNTER_PERIOD[this.release];
    }
    this.gate = next;
  }

  writeAttackDecay(v) {
    this.attack = (v >> 4) & 0x0f;
    this.decay = v & 0x0f;
    if (this.state === ATTACK) this.ratePeriod = RATE_COUNTER_PERIOD[this.attack];
    else if (this.state === DECAY_SUSTAIN) this.ratePeriod = RATE_COUNTER_PERIOD[this.decay];
  }

  writeSustainRelease(v) {
    this.sustain = (v >> 4) & 0x0f;
    this.release = v & 0x0f;
    if (this.state === RELEASE) this.ratePeriod = RATE_COUNTER_PERIOD[this.release];
  }

  output() { return this.envelopeCounter; }
}

// ---------------------------------------------------------------- voice

class Voice {
  constructor() {
    this.wave = new WaveformGenerator();
    this.envelope = new EnvelopeGenerator();
    this.setChipModel(ChipModel.Mos6581);
  }

  setChipModel(model) {
    this.wave.setChipModel(model);
    // The 6581's waveform DAC "zero" and the envelope DAC's DC offset; the 8580 has neither.
    this.waveZero = model === ChipModel.Mos6581 ? 0x380 : 0x800;
    this.voiceDC = model === ChipModel.Mos6581 ? 0x800 * 0xff : 0;
  }

  writeControlReg(control) {
    this.wave.writeControlReg(control);
    this.envelope.writeControlReg(control);
  }

  // Range [-2048*255, 2047*255].
  output() { return (this.wave.output() - this.waveZero) * this.envelope.output() + this.voiceDC; }
}

// ---------------------------------------------------------------- filter

const CUTOFF_6581 = [
  [0, 220], [0, 220], [128, 230], [256, 250], [384, 300], [512, 420], [640, 780], [768, 1600], [832, 2300],
  [896, 3200], [960, 4300], [992, 5000], [1008, 5400], [1016, 5700], [1023, 6000], [1023, 6000], [1024, 4600],
  [1024, 4600], [1032, 4800], [1056, 5300], [1088, 6000], [1120, 6600], [1152, 7200], [1280, 9500], [1408, 12000],
  [1536, 14500], [1664, 16000], [1792, 17100], [1920, 17700], [2047, 18000], [2047, 18000],
];
const CUTOFF_8580 = [
  [0, 0], [0, 0], [128, 800], [256, 1600], [384, 2500], [512, 3300], [640, 4100], [768, 4800], [896, 5600],
  [1024, 6500], [1152, 7500], [1280, 8400], [1408, 9200], [1536, 9800], [1664, 10500], [1792, 11000],
  [1920, 11700], [2047, 12500], [2047, 12500],
];

// reSID's spline.h: a cubic spline through the points, plotted by forward differences.
function interpolate(points, plot, res) {
  for (let i2 = 2; i2 < points.length - 1; i2++) {
    const [x0, y0] = points[i2 - 2], [x1, y1] = points[i2 - 1], [x2, y2] = points[i2], [x3, y3] = points[i2 + 1];
    if (x1 === x2) continue;
    let k1, k2;
    if (x0 === x1 && x2 === x3) {
      k1 = k2 = (y2 - y1) / (x2 - x1);
    } else if (x0 === x1) {
      k2 = (y3 - y1) / (x3 - x1);
      k1 = (3 * (y2 - y1) / (x2 - x1) - k2) / 2;
    } else if (x2 === x3) {
      k1 = (y2 - y0) / (x2 - x0);
      k2 = (3 * (y2 - y1) / (x2 - x1) - k1) / 2;
    } else {
      k1 = (y2 - y0) / (x2 - x0);
      k2 = (y3 - y1) / (x3 - x1);
    }
    const dx = x2 - x1, dyy = y2 - y1;
    const a = ((k1 + k2) - 2 * dyy / dx) / (dx * dx);
    const b = ((k2 - k1) / dx - 3 * (x1 + x2) * a) / 2;
    const c = k1 - (3 * x1 * a + 2 * b) * x1;
    const d = y1 - ((x1 * a + b) * x1 + c) * x1;
    let y = ((a * x1 + b) * x1 + c) * x1 + d;
    let dy = (3 * a * (x1 + res) + 2 * b) * x1 * res + ((a * res + b) * res + c) * res;
    let d2y = (6 * a * (x1 + res) + 2 * b) * res * res;
    const d3y = 6 * a * res * res * res;
    for (let x = x1; x <= x2; x += res) {
      plot(x, y);
      y += dy;
      dy += d2y;
      d2y += d3y;
    }
  }
}

function cutoffTable(points) {
  const table = new Int32Array(2048);
  interpolate(points, (x, y) => (table[Math.trunc(x)] = Math.trunc(Math.max(0, y))), 1.0);
  return table;
}

const F0_6581 = cutoffTable(CUTOFF_6581);
const F0_8580 = cutoffTable(CUTOFF_8580);

const W0_MAX_1 = Math.trunc(2 * Math.PI * 16000 * 1.048576);

class Filter {
  constructor() {
    this.fc = 0; this.res = 0; this.filt = 0; this.voice3Off = 0; this.hpBpLp = 0; this.vol = 0;
    this.vhp = 0; this.vbp = 0; this.vlp = 0; this.vnf = 0;
    this.f0 = F0_6581;
    this.setChipModel(ChipModel.Mos6581);
  }

  setChipModel(model) {
    // The 6581 mixer's small input DC offset; none on the 8580.
    this.mixerDC = model === ChipModel.Mos6581 ? (-0xfff * 0xff / 18) >> 7 : 0;
    this.f0 = model === ChipModel.Mos6581 ? F0_6581 : F0_8580;
    this._setW0();
    this._setQ();
  }

  writeFcLo(v) { this.fc = (this.fc & 0x7f8) | (v & 7); this._setW0(); }
  writeFcHi(v) { this.fc = ((v << 3) & 0x7f8) | (this.fc & 7); this._setW0(); }
  writeResFilt(v) { this.res = (v >> 4) & 0x0f; this._setQ(); this.filt = v & 0x0f; }
  writeModeVol(v) { this.voice3Off = v & 0x80; this.hpBpLp = (v >> 4) & 7; this.vol = v & 0x0f; }

  // w0 scaled by 1.048576 so dividing by a million is a shift by 20; capped at 16 kHz for stability.
  _setW0() {
    const w0 = Math.trunc(2 * Math.PI * this.f0[this.fc] * 1.048576);
    this.w0Ceil1 = w0 <= W0_MAX_1 ? w0 : W0_MAX_1;
  }

  _setQ() { this.div1024Q = Math.trunc(1024.0 / (0.707 + (1.0 * this.res) / 0x0f)); }

  clock(voice1, voice2, voice3, extIn) {
    voice1 >>= 7;
    voice2 >>= 7;
    // Voice 3 is not silenced by 3OFF when it goes through the filter.
    voice3 = this.voice3Off !== 0 && (this.filt & 4) === 0 ? 0 : voice3 >> 7;
    extIn >>= 7;

    let vi = 0, vnf = 0;
    const f = this.filt;
    if (f & 1) vi += voice1; else vnf += voice1;
    if (f & 2) vi += voice2; else vnf += voice2;
    if (f & 4) vi += voice3; else vnf += voice3;
    if (f & 8) vi += extIn; else vnf += extIn;
    this.vnf = vnf;

    // Math.imul wraps at 32 bits as C#'s int arithmetic does.
    const dVbp = Math.imul(this.w0Ceil1, this.vhp) >> 20;
    const dVlp = Math.imul(this.w0Ceil1, this.vbp) >> 20;
    this.vbp = (this.vbp - dVbp) | 0;
    this.vlp = (this.vlp - dVlp) | 0;
    this.vhp = ((Math.imul(this.vbp, this.div1024Q) >> 10) - this.vlp - vi) | 0;
  }

  output() {
    let vf;
    switch (this.hpBpLp) {
      case 0: vf = 0; break;
      case 1: vf = this.vlp; break;
      case 2: vf = this.vbp; break;
      case 3: vf = this.vlp + this.vbp; break;
      case 4: vf = this.vhp; break;
      case 5: vf = this.vlp + this.vhp; break;
      case 6: vf = this.vbp + this.vhp; break;
      default: vf = this.vlp + this.vbp + this.vhp; break;
    }
    return (this.vnf + vf + this.mixerDC) * this.vol;
  }
}

// ---------------------------------------------------------------- external filter

class ExternalFilter {
  constructor() {
    this.vlp = 0; this.vhp = 0; this.vo = 0;
    this.w0Lp = 104858;
    this.w0Hp = 105;
  }

  clock(vi) {
    const dVlp = Math.imul(this.w0Lp >> 8, vi - this.vlp) >> 12;
    const dVhp = Math.imul(this.w0Hp, this.vlp - this.vhp) >> 20;
    this.vo = this.vlp - this.vhp;
    this.vlp += dVlp;
    this.vhp += dVhp;
  }

  output() { return this.vo; }
}

// ---------------------------------------------------------------- the chip

const FIXP_SHIFT = 16;
const FIXP_MASK = 0xffff;

export class SidChip {
  constructor() {
    this.voices = [new Voice(), new Voice(), new Voice()];
    this.voices[0].wave.setSyncSource(this.voices[2].wave);
    this.voices[1].wave.setSyncSource(this.voices[0].wave);
    this.voices[2].wave.setSyncSource(this.voices[1].wave);
    this.filter = new Filter();
    this.extFilter = new ExternalFilter();
    this.muted = [false, false, false];
    this.busValue = 0;
    this.busValueTtl = 0;
    this.deltaLeft = 0;
    this.setSamplingParameters(985248, 44100);
  }

  setChipModel(model) {
    for (const v of this.voices) v.setChipModel(model);
    this.filter.setChipModel(model);
  }

  setSamplingParameters(clockFreq, sampleFreq) {
    this.cyclesPerSample = Math.trunc((clockFreq / sampleFreq) * (1 << FIXP_SHIFT) + 0.5);
    this.sampleOffset = 0;
    this.samplePrev = 0;
  }

  // 16-bit AUDIO OUT.
  output() {
    const sample = Math.trunc(this.extFilter.output() / Math.trunc(((4095 * 255) >> 7) * 3 * 15 * 2 / 65536));
    return sample >= 32768 ? 32767 : sample < -32768 ? -32768 : sample;
  }

  read(offset) {
    if (offset === 0x1b) return this.voices[2].wave.readOsc();
    if (offset === 0x1c) return this.voices[2].envelope.output();
    return this.busValue;
  }

  write(offset, value) {
    this.busValue = value;
    this.busValueTtl = 0x2000;
    if (offset <= 0x14) {
      const voice = this.voices[Math.floor(offset / 7)];
      switch (offset % 7) {
        case 0: voice.wave.writeFreqLo(value); break;
        case 1: voice.wave.writeFreqHi(value); break;
        case 2: voice.wave.writePwLo(value); break;
        case 3: voice.wave.writePwHi(value); break;
        case 4: voice.writeControlReg(value); break;
        case 5: voice.envelope.writeAttackDecay(value); break;
        default: voice.envelope.writeSustainRelease(value); break;
      }
      return;
    }
    switch (offset) {
      case 0x15: this.filter.writeFcLo(value); break;
      case 0x16: this.filter.writeFcHi(value); break;
      case 0x17: this.filter.writeResFilt(value); break;
      case 0x18: this.filter.writeModeVol(value); break;
    }
  }

  // One cycle.
  clock() {
    if (--this.busValueTtl <= 0) {
      this.busValue = 0;
      this.busValueTtl = 0;
    }
    const [v0, v1, v2] = this.voices;
    v0.envelope.clock(); v1.envelope.clock(); v2.envelope.clock();
    v0.wave.clock(); v1.wave.clock(); v2.wave.clock();
    v0.wave.synchronize(); v1.wave.synchronize(); v2.wave.synchronize();
    this.filter.clock(
      this.muted[0] ? 0 : v0.output(),
      this.muted[1] ? 0 : v1.output(),
      this.muted[2] ? 0 : v2.output(),
      0,
    );
    this.extFilter.clock(this.filter.output());
  }

  // Only the oscillators and envelopes, a stretch at a time: for answering voice 3 reads fast.
  clockOscillators(deltaT) {
    for (const v of this.voices) {
      v.envelope.clockDelta(deltaT);
      v.wave.clockDelta(deltaT);
    }
  }

  // Clocks up to deltaT cycles, sampling with linear interpolation into buf; returns the
  // samples written and leaves the cycles not used in this.deltaLeft.
  clockAndSample(deltaT, buf, offset, n) {
    let s = 0, i;
    while (true) {
      const nextSampleOffset = this.sampleOffset + this.cyclesPerSample;
      const deltaTSample = nextSampleOffset >> FIXP_SHIFT;
      if (deltaTSample > deltaT) break;
      if (s >= n) {
        this.deltaLeft = deltaT;
        return s;
      }
      for (i = 0; i < deltaTSample - 1; i++) this.clock();
      if (i < deltaTSample) {
        this.samplePrev = this.output();
        this.clock();
      }
      deltaT -= deltaTSample;
      this.sampleOffset = nextSampleOffset & FIXP_MASK;
      const now = this.output();
      buf[offset + s++] = (this.samplePrev + (Math.imul(this.sampleOffset, now - this.samplePrev) >> FIXP_SHIFT)) << 16 >> 16;
      this.samplePrev = now;
    }
    for (i = 0; i < deltaT - 1; i++) this.clock();
    if (i < deltaT) {
      this.samplePrev = this.output();
      this.clock();
    }
    this.sampleOffset -= deltaT << FIXP_SHIFT;
    this.deltaLeft = 0;
    return s;
  }
}
