// A tune played on the C64 into SID chips, rendered to samples; fast-forwards silently to seek.
// Port of MagPlay.C64/C64PlaybackEngine.cs from MagPlaySID by Magnar Harestad (GPL v2+).

import { Machines } from '../c64.js';
import { SidTune } from '../sidtune.js';
import { SidChip, ChipModel } from '../sid/sid.js';

const SLICE = 2000;
const MIX_SCALE = [0, 1, 0.7, 0.55];

export class SidEngine {
  constructor(file, song, sampleRate) {
    this.file = file;
    this.song = song;
    this.sampleRate = sampleRate;
    this.failure = null;
    this.outputSamples = 0;
    this._load();
  }

  _load() {
    const file = this.file;
    const count = 1 + Math.min(2, file.extraSids.length);
    this.tune = SidTune.load(file, this.song, { sid: this, record: false });
    this.clockHz = Machines.clockHz(this.tune.computer.machine);
    this.chips = [];
    for (let chip = 0; chip < count; chip++) {
      const is8580 = chip === 0 ? file.is8580 : file.extraSids8580[chip - 1];
      const sid = new SidChip();
      sid.setChipModel(is8580 ? ChipModel.Mos8580 : ChipModel.Mos6581);
      sid.setSamplingParameters(this.clockHz, this.sampleRate);
      this.chips.push(sid);
    }
    this.chipCycle = 0;
    this.pending = new Int16Array(8192);
    this.pendingCount = 0;
    this._one = new Int16Array(1);
    this._silent = true;
    this._fast = false;
    this.seekTarget = null;

    // Init, unheard, up to the first call (or two frames), then the chips settle from it.
    const computer = this.tune.computer;
    const until = 2 * Machines.cyclesPerFrame(computer.machine);
    while (computer.calls.length === 0 && computer.cycle < until) this.tune.run(64);
    this._clockTo(computer.cycle);
    for (const sid of this.chips) this._settle(sid);
    this._silent = false;
    this.startCycle = this.chipCycle;
    this.anchorCycle = this.startCycle;
    this.anchorSample = this.outputSamples;
  }

  // 50 ms of the chip, unheard, so the music starts without a thump.
  _settle(sid) {
    const scratch = new Int16Array(2048);
    let left = Math.trunc(this.clockHz * 0.05);
    while (left > 0) {
      const before = left;
      sid.clockAndSample(left, scratch, 0, scratch.length);
      left = sid.deltaLeft;
      if (left === before) break;
    }
  }

  // The tune's cycle at an output sample.
  cycleAt(sample) {
    return this.anchorCycle + ((sample - this.anchorSample) * this.clockHz) / this.sampleRate;
  }

  setMuted(voice, muted) {
    const chip = this.chips[Math.floor(voice / 3)];
    if (chip) chip.muted[voice % 3] = muted;
  }

  // Seeking to a cycle: back means starting again; either way the tune runs on unheard.
  seek(cycle) {
    if (cycle < this.chipCycle) {
      this.failure = null;
      this._load();
    }
    this.seekTarget = Math.max(cycle, this.chipCycle);
    this.pendingCount = 0;
  }

  // Runs a seek on by at most `budget` cycles; true once it has arrived.
  _advanceSeek(budget) {
    const target = this.seekTarget;
    this._fast = true;
    try {
      const stop = Math.min(target, this.tune.computer.cycle + budget);
      while (this.tune.computer.cycle < stop) this.tune.run(Math.min(SLICE * 10, stop - this.tune.computer.cycle));
      this._clockTo(this.tune.computer.cycle);
    } finally {
      this._fast = false;
    }
    if (this.tune.computer.cycle < target) return false;
    this.seekTarget = null;
    this.pendingCount = 0;
    this.anchorCycle = this.chipCycle;
    this.anchorSample = this.outputSamples;
    return true;
  }

  // Fills out[offset..offset+count) with samples; silence while seeking or after a failure.
  render(out, offset, count, seekBudget = 400000) {
    if (this.seekTarget !== null && !this.failure) {
      try {
        if (!this._advanceSeek(seekBudget)) {
          out.fill(0, offset, offset + count);
          return false;
        }
      } catch (error) {
        this.failure = error.message;
      }
    }

    if (!this.failure) {
      try {
        while (this.pendingCount < count) {
          this.tune.run(SLICE);
          this._clockTo(this.tune.computer.cycle);
        }
      } catch (error) {
        // What it played stays; then silence.
        this.failure = error.message;
      }
    }

    const ready = Math.min(count, this.pendingCount);
    out.set(this.pending.subarray(0, ready), offset);
    out.fill(0, offset + ready, offset + count);
    this.pending.copyWithin(0, ready, this.pendingCount);
    this.pendingCount -= ready;
    this.outputSamples += count;
    return true;
  }

  // The SID port the C64 writes and reads through.
  write(cycle, chip, register, value) {
    if (chip >= this.chips.length) return;
    this._clockTo(cycle);
    this.chips[chip].write(register, value);
  }

  read(cycle, chip, register) {
    if (chip >= this.chips.length) return 0;
    this._clockTo(cycle);
    return this.chips[chip].read(register) & 0xff;
  }

  _clockTo(cycle) {
    let cycles = Math.trunc(cycle - this.chipCycle);
    if (cycles <= 0) return;
    this.chipCycle += cycles;

    // Fast-forwarding only keeps voice 3's oscillator and envelope going, for tunes that read them.
    if (this._fast) {
      for (const sid of this.chips) sid.clockOscillators(cycles);
      return;
    }

    const chips = this.chips;
    while (cycles > 0) {
      if (this.pendingCount === this.pending.length) {
        const grown = new Int16Array(this.pending.length * 2);
        grown.set(this.pending);
        this.pending = grown;
      }
      const before = cycles;
      const sampled = chips[0].clockAndSample(cycles, this.pending, this.pendingCount, 1);
      cycles = chips[0].deltaLeft;
      if (chips.length > 1) this._mixIn(before - cycles, sampled);
      if (sampled === 0) break;
      if (this._silent) continue;
      this.pendingCount++;
    }
  }

  _mixIn(cycles, sampled) {
    let sum = sampled > 0 ? this.pending[this.pendingCount] : 0;
    for (let chip = 1; chip < this.chips.length; chip++) {
      if (this.chips[chip].clockAndSample(cycles, this._one, 0, 1) > 0) sum += this._one[0];
    }
    if (sampled > 0) this.pending[this.pendingCount] = Math.max(-32768, Math.min(32767, Math.trunc(sum * MIX_SCALE[this.chips.length])));
  }
}
