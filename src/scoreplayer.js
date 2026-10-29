// Plays a score as a C64 player would, call by call, writing the SID's registers.
// Port of MagPlay.Score/ScorePlayer.cs from MagPlaySID by Magnar Harestad (GPL v2+).

import { HOLD_ROW, RowNoteKind, HardRestartKind, PitchKind, registerOf } from './score.js';
import { timedWrite } from './c64.js';

const MAX_JUMPS = 64;

const program = (step, callsLeft, add, playing = -1) => ({ step, callsLeft, add, playing });
const STOPPED = program(-1, 0, 0);

// The bits of each register the SID keeps.
const USED = Array.from({ length: 0x19 }, (_, r) => (r === 3 || r === 10 || r === 17 ? 0x0f : r === 0x15 ? 0x07 : 0xff));

export const usedBits = (register) => USED[Math.min(0x18, register & 0x1f)];

// The registers the score has: $00-$18 of each chip.
export function scoreRegisters(chips) {
  const list = [];
  for (let chip = 0; chip < chips; chip++) for (let r = 0; r < 0x19; r++) list.push(chip * 0x20 + r);
  return list;
}

const firstOf = (effects, type) => effects.find((e) => e.type === type);
const firstCalls = (effects, type, fallback) => firstOf(effects, type)?.calls ?? fallback;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

class VoiceState {
  constructor(index) {
    this.index = index;
    this.chip = Math.floor(index / 3);
    this.base = registerOf(index, 0);
    this.ended = false;
    this.entry = -1;
    this.repeatLeft = 0;
    this.pattern = null;
    this.nextRow = 0;
    this.transpose = 0;
    this.row = HOLD_ROW;
    this.rowCall = 0;
    this.rowCalls = 0;
    this.tempo = null;
    this.funkSecond = false;
    this.instrument = null;
    this.note = 0;
    this.frequency = 0;
    this.pulse = 0;
    this.control = 0;
    this.gate = false;
    this.attackDecay = 0;
    this.sustainRelease = 0;
    this.detune = 0;
    this.wave = STOPPED;
    this.pulses = STOPPED;
    this.firstCall = false;
    this.pendingFrequency = null;
    this.retrigger = false;
    this.callsSinceNote = 0;
    this.glideTarget = null;
    this.vibratoCall = 0;
    this.noteAtCall = -1;
    this.cutAtCall = -1;
  }

  get onFirstCall() { return this.firstCall && this.callsSinceNote === 0; }
}

export class ScorePlayer {
  constructor(score) {
    this._score = score;
    this._voices = Array.from({ length: 3 * score.chips }, (_, v) => new VoiceState(v));
    this._chips = Array.from({ length: score.chips }, () => ({ modeVolume: 0, cutoff: 0, filterControl: 0, filter: STOPPED }));
    this._written = new Int32Array(0x20 * score.chips);
    this._before = new Int32Array(this._written.length);
    this._writes = [];
    this._streamWrites = [];
    this._streams = [null, null, null, null];
    this._call = 0;
    this._between = 0;
    this._cyclesPerCall = Math.max(1, score.cyclesPerCall);
    this._tempo = Math.max(1, score.tempo);
    this._funk = score.funkTempo != null ? { first: this._tempo, second: score.funkTempo } : null;
    this._chips[0].modeVolume = (score.modeVolume ?? 0) & 0xff;
    for (let chip = 0; chip < this._chips.length; chip++) {
      if (score.filterPrograms[chip] >= 0) this._chips[chip].filter = program(score.filterPrograms[chip], 0, 0);
    }
    this._rawBetween = [...score.raw.between].sort((a, b) => a.cycle - b.cycle);
    this._cycle = score.callCycles && score.callCycles.length > 0 ? score.callCycles[0] : score.firstCall;

    for (const voice of this._voices) voice.ended = score.voices[voice.index].order.length === 0;

    if (score.modeVolume != null) this._write(0x18, this._chips[0].modeVolume);
    const init = [...this._writes];
    this._writes = [];
    for (; this._between < this._rawBetween.length && this._rawBetween[this._between].cycle < this._cycle; this._between++)
      init.push(this._rawBetween[this._between]);
    this.init = init;
  }

  get cycle() { return this._cycle; }
  get cyclesPerCall() { return this._cyclesPerCall; }
  get callNumber() { return this._call; }
  get callWrites() { return this._writes; }
  get betweenWrites() { return this._streamWrites; }

  // Where a voice is after the last call.
  positionOf(voice) {
    const v = this._voices[voice];
    return {
      entry: v.entry, transpose: v.transpose, pattern: v.pattern?.number ?? -1, row: v.nextRow - 1, rowCall: v.rowCall,
      instrument: v.instrument?.number ?? 0, waveStep: v.wave.playing, pulseStep: v.pulses.playing, ended: v.ended,
    };
  }

  filterStepOf(chip) { return this._chips[chip].filter.playing; }

  // Plays one call; `raw`, given the music's writes, says which registers to write as given instead.
  call(raw = null) {
    this._writes = [];
    this._before.set(this._written);
    for (const voice of this._voices) this._playVoice(voice);

    for (let c = 0; c < this._chips.length; c++) {
      const chip = this._chips[c];
      this._stepFilter(c);
      this._write(c * 0x20 + 0x15, chip.cutoff & 0x07);
      this._write(c * 0x20 + 0x16, (chip.cutoff >> 3) & 0xff);
      this._write(c * 0x20 + 0x17, chip.filterControl);
      this._write(c * 0x20 + 0x18, chip.modeVolume);
    }

    const given = raw ? raw(this._call, this._writes) : this._score.raw.calls.get(this._call) ?? null;
    if (given) this._writeRawCall(given);

    const cycles = this._score.callCycles;
    const next = cycles && this._call + 1 < cycles.length ? cycles[this._call + 1] : this._cycle + this._cyclesPerCall;
    this._playStreams(this._cycle, next);
    for (; this._between < this._rawBetween.length && this._rawBetween[this._between].cycle < next; this._between++)
      this._streamWrites.push(this._rawBetween[this._between]);
    this._streamWrites.sort((a, b) => a.cycle - b.cycle);
    this._cycle = next;
    this._call++;
    return [...this._writes, ...this._streamWrites];
  }

  _writeRawCall(raw) {
    this._writes = this._writes.filter((w) => !raw.registers.has(w.register));
    for (const r of scoreRegisters(this._chips.length)) {
      if (!raw.registers.has(r)) continue;
      this._written[r] = this._before[r];
      this._carry(r, this._before[r]);
    }
    for (const write of raw.writes) {
      if (!this._isRegister(write.register)) continue;
      const value = write.value & 0xff;
      this._written[write.register] = value;
      this._writes.push(timedWrite(this._cycle + write.offset, write.register, value));
      this._carry(write.register, value);
    }
  }

  _isRegister(register) {
    return register >= 0 && register < 0x20 * this._chips.length && (register & 0x1f) <= 0x18;
  }

  // ---------------------------------------------------------------- voices

  _playVoice(voice) {
    if (voice.ended) return;
    if (voice.rowCall >= voice.rowCalls && !this._startRow(voice)) return;

    const call = voice.rowCall;
    if (call === voice.noteAtCall) this._startNote(voice);

    if (!voice.onFirstCall && voice.pendingFrequency != null) {
      voice.frequency = voice.pendingFrequency;
      voice.pendingFrequency = null;
    }

    if (call > 0 || voice.noteAtCall > 0) this._pitchEffects(voice, call);

    if (!voice.onFirstCall) {
      this._stepWave(voice);
      this._stepPulse(voice);
    }

    if (call === voice.cutAtCall) voice.gate = false;

    this._hardRestartBeforeNextNote(voice, call);
    this._writeVoice(voice);
    voice.callsSinceNote++;
    voice.rowCall++;
  }

  _startRow(voice) {
    const row = this._nextRow(voice, true);
    if (!row) {
      voice.ended = true;
      return false;
    }
    voice.row = row;
    voice.rowCall = 0;
    voice.rowCalls = this._rowLength(voice, row);
    voice.cutAtCall = firstCalls(row.effects, 'NoteCut', -1);
    const delay = firstCalls(row.effects, 'NoteDelay', 0);
    voice.noteAtCall = clamp(delay, 0, Math.max(0, voice.rowCalls - 1));
    voice.glideTarget = null;
    voice.vibratoCall = 0;
    return true;
  }

  _rowLength(voice, row) {
    if (row.calls != null) return Math.max(1, row.calls);
    if (voice.tempo != null) return voice.tempo;
    if (this._funk) {
      voice.funkSecond = !voice.funkSecond;
      return Math.max(1, voice.funkSecond ? this._funk.first : this._funk.second);
    }
    return this._tempo;
  }

  _lengthAhead(voice, row, state) {
    if (row.calls != null) return Math.max(1, row.calls);
    if (voice.tempo != null) return voice.tempo;
    if (this._funk) {
      state.funkSecond = !state.funkSecond;
      return Math.max(1, state.funkSecond ? this._funk.first : this._funk.second);
    }
    return this._tempo;
  }

  _placeOf(voice) {
    return { entry: voice.entry, repeatLeft: voice.repeatLeft, pattern: voice.pattern, next: voice.nextRow, transpose: voice.transpose };
  }

  _nextRow(voice, advance) {
    const found = this._rowAt(voice, this._placeOf(voice));
    if (!found) return null;
    if (advance) {
      const after = found.after;
      voice.entry = after.entry;
      voice.repeatLeft = after.repeatLeft;
      voice.pattern = after.pattern;
      voice.nextRow = after.next;
      voice.transpose = after.transpose;
    }
    return found.row;
  }

  *_upcomingRows(voice) {
    let place = this._placeOf(voice);
    let found;
    while ((found = this._rowAt(voice, place))) {
      yield found.row;
      place = found.after;
    }
  }

  // The row at a place, on into the order list's next entries, and the place after it.
  _rowAt(voice, at) {
    const order = this._score.voices[voice.index].order;
    let { entry, repeatLeft, pattern, next, transpose } = at;
    for (let guard = 0; guard < order.length * 2 + 4; guard++) {
      if (pattern && next < pattern.rows.length)
        return { row: pattern.rows[next], after: { entry, repeatLeft, pattern, next: next + 1, transpose } };

      if (pattern && repeatLeft > 1) {
        repeatLeft--;
        next = 0;
        continue;
      }

      entry++;
      if (entry >= order.length) entry = this._score.voices[voice.index].loopTo;
      if (entry < 0 || entry >= order.length) return null;

      const orderEntry = order[entry];
      pattern = this._score.patternNumber(orderEntry.pattern);
      repeatLeft = Math.max(1, orderEntry.repeat);
      transpose = orderEntry.transpose;
      next = 0;
    }
    return null;
  }

  _startNote(voice) {
    const row = voice.row;
    if (row.instrument > 0) {
      const instrument = this._score.instrumentNumber(row.instrument);
      if (instrument) voice.instrument = instrument;
    }

    const last = this._score.noteTable.length - 1;
    const glide = firstOf(row.effects, 'TonePortamento');
    switch (row.note.kind) {
      case RowNoteKind.Note:
        if (glide) {
          voice.note = clamp(row.note.note + voice.transpose, 0, last);
          voice.glideTarget = this._noteFrequency(voice, voice.note);
          if (glide.speed === 0) voice.frequency = voice.glideTarget;
        } else {
          this._trigger(voice, clamp(row.note.note + voice.transpose, 0, last));
        }
        break;
      case RowNoteKind.GateOff: voice.gate = false; break;
      case RowNoteKind.GateOn: voice.gate = true; break;
    }

    for (const effect of row.effects) this._apply(voice, effect);
  }

  _trigger(voice, note) {
    voice.retrigger = voice.gate;
    voice.firstCall = false;
    voice.pendingFrequency = null;
    voice.note = note;
    voice.gate = true;
    voice.callsSinceNote = 0;
    voice.vibratoCall = 0;

    const frequency = this._noteFrequency(voice, note);
    const instrument = voice.instrument;
    if (!instrument) {
      voice.frequency = frequency;
      return;
    }

    voice.attackDecay = instrument.attackDecay;
    voice.sustainRelease = instrument.sustainRelease;
    voice.wave = instrument.waveProgram >= 0 ? program(instrument.waveProgram, 0, 0) : STOPPED;
    if (instrument.pulseProgram >= 0) voice.pulses = program(instrument.pulseProgram, 0, 0);
    if (instrument.filterProgram >= 0) this._chips[voice.chip].filter = program(instrument.filterProgram, 0, 0);
    voice.firstCall = instrument.firstControl != null;
    if (voice.firstCall) voice.pendingFrequency = frequency;
    else voice.frequency = frequency;
  }

  _noteFrequency(voice, note) {
    const table = this._score.noteTable;
    return (table[clamp(note, 0, table.length - 1)] + voice.detune) & 0xffff;
  }

  _apply(voice, e) {
    const chip = this._chips[voice.chip];
    switch (e.type) {
      case 'SetAttackDecay': voice.attackDecay = e.value & 0xff; break;
      case 'SetSustainRelease': voice.sustainRelease = e.value & 0xff; break;
      case 'SetControl': voice.control = e.value & 0xff; break;
      case 'SetWaveProgram': voice.wave = program(e.step, 0, 0); break;
      case 'SetPulseProgram': voice.pulses = program(e.step, 0, 0); break;
      case 'SetFilterProgram': chip.filter = program(e.step, 0, 0); break;
      case 'FilterControl': chip.filterControl = e.value & 0xff; break;
      case 'FilterCutoff': chip.cutoff = e.value & 0x7ff; break;
      case 'MasterVolume': chip.modeVolume = (chip.modeVolume & 0xf0) | (e.value & 0x0f); break;
      case 'FilterMode': chip.modeVolume = (e.value & 0xf0) | (chip.modeVolume & 0x0f); break;
      case 'FunkTempo': this._funk = { first: Math.max(1, e.first), second: Math.max(1, e.second) }; break;
      case 'Tempo':
        if (e.thisVoiceOnly) {
          voice.tempo = Math.max(1, e.calls);
        } else {
          this._tempo = Math.max(1, e.calls);
          this._funk = null;
          for (const each of this._voices) each.tempo = null;
        }
        break;
      case 'CallRate': this._cyclesPerCall = Math.max(1, e.cycles); break;
      case 'Detune': voice.detune = e.amount; break;
      case 'SetFrequency': voice.frequency = e.value & 0xffff; break;
      case 'SetPulse': voice.pulse = e.value & 0xfff; break;
      case 'PlaySample': this._startStream(e); break;
    }
  }

  _pitchEffects(voice, call) {
    let pitched = false;
    for (const e of voice.row.effects) {
      switch (e.type) {
        case 'Portamento':
          voice.frequency = (voice.frequency + e.speed) & 0xffff;
          pitched = true;
          break;
        case 'TonePortamento':
          if (voice.glideTarget != null) {
            const target = voice.glideTarget, speed = Math.max(1, e.speed);
            voice.frequency = voice.frequency < target ? Math.min(target, voice.frequency + speed) : Math.max(target, voice.frequency - speed);
            pitched = true;
          }
          break;
        case 'Vibrato':
          this._wobble(voice, e.speed, e.depth);
          pitched = true;
          break;
        case 'Arpeggio': {
          const step = call % 3 === 0 ? 0 : call % 3 === 1 ? e.first : e.second;
          voice.frequency = this._noteFrequency(voice, voice.note + step);
          pitched = true;
          break;
        }
      }
    }
    const vibrato = voice.instrument?.vibrato;
    if (!pitched && vibrato && voice.callsSinceNote >= vibrato.delay) this._wobble(voice, vibrato.speed, vibrato.depth);
  }

  _wobble(voice, speed, depth) {
    speed = Math.max(1, speed);
    const quarter = Math.floor(voice.vibratoCall / speed) % 4;
    voice.frequency = (voice.frequency + (quarter === 0 || quarter === 3 ? depth : -depth)) & 0xffff;
    voice.vibratoCall++;
  }

  // The gate goes off, and the envelope falls for an envelope restart, a gate timer before the next note.
  _hardRestartBeforeNextNote(voice, call) {
    const instrument = voice.instrument;
    if (!instrument || instrument.gateTimer <= 0 || instrument.hardRestart === HardRestartKind.None) return;

    let until;
    const row = voice.row;
    if (row.note.kind === RowNoteKind.Note && call < voice.noteAtCall) {
      if (firstOf(row.effects, 'TonePortamento')) return;
      until = voice.noteAtCall - call;
    } else {
      if (call === voice.noteAtCall && row.note.kind === RowNoteKind.Note) return;
      until = voice.rowCalls - call;
      const state = { funkSecond: voice.funkSecond };
      let found = false;
      for (const next of this._upcomingRows(voice)) {
        if (next.note.kind === RowNoteKind.Note) {
          if (firstOf(next.effects, 'TonePortamento')) return;
          until += firstCalls(next.effects, 'NoteDelay', 0);
          found = true;
          break;
        }
        if (next.note.kind !== RowNoteKind.Hold || until > instrument.gateTimer) return;
        until += this._lengthAhead(voice, next, state);
      }
      if (!found) return;
    }

    if (until !== instrument.gateTimer) return;
    voice.gate = false;
    if (instrument.hardRestart === HardRestartKind.Envelope) {
      voice.attackDecay = (instrument.hardRestartEnvelope >> 8) & 0xff;
      voice.sustainRelease = instrument.hardRestartEnvelope & 0xff;
    }
  }

  // ---------------------------------------------------------------- programs

  _stepWave(voice) {
    voice.wave = this._step(voice.wave, this._score.waveTable, (step) => {
      switch (step.type) {
        case 'wave':
          if (step.control != null) voice.control = step.control & 0xff;
          if (step.pitch) {
            const p = step.pitch;
            voice.frequency =
              p.kind === PitchKind.Relative ? this._noteFrequency(voice, voice.note + p.value)
              : p.kind === PitchKind.Absolute ? this._noteFrequency(voice, p.value)
              : p.kind === PitchKind.Offset ? (this._noteFrequency(voice, voice.note) + p.value) & 0xffff
              : p.value & 0xffff;
          }
          return [Math.max(1, step.calls), 0];
        case 'effect':
          this._apply(voice, step.effect);
          return [0, 0];
        case 'raw':
          this._writeRaw(voice.chip, voice, step.writes);
          return [Math.max(1, step.calls), 0];
        default:
          return [1, 0];
      }
    }, () => {});
  }

  _stepPulse(voice) {
    voice.pulses = this._step(voice.pulses, this._score.pulseTable, (step) => {
      switch (step.type) {
        case 'pulse':
          voice.pulse = step.width != null ? step.width & 0xfff : (voice.pulse + step.add) & 0xfff;
          return [Math.max(1, step.calls), step.add];
        case 'effect':
          this._apply(voice, step.effect);
          return [0, 0];
        default:
          return [1, 0];
      }
    }, (add) => (voice.pulse = (voice.pulse + add) & 0xfff));
  }

  _stepFilter(c) {
    const chip = this._chips[c];
    chip.filter = this._step(chip.filter, this._score.filterTable, (step) => {
      switch (step.type) {
        case 'filter':
          if (step.control != null) chip.filterControl = step.control & 0xff;
          if (step.mode != null) chip.modeVolume = (step.mode & 0xf0) | (chip.modeVolume & 0x0f);
          chip.cutoff = step.cutoff != null ? step.cutoff & 0x7ff : (chip.cutoff + step.add) & 0x7ff;
          return [Math.max(1, step.calls), step.add];
        case 'effect':
          this._apply(this._voices[c * 3], step.effect);
          return [0, 0];
        case 'raw':
          this._writeRaw(c, null, step.writes);
          return [Math.max(1, step.calls), 0];
        default:
          return [1, 0];
      }
    }, (add) => (chip.cutoff = (chip.cutoff + add) & 0x7ff));
  }

  // One call of a program: a step still holding adds again; else the next step runs, through jumps.
  _step(prog, table, run, hold) {
    if (prog.step < 0) return prog;
    if (prog.callsLeft > 0) {
      hold(prog.add);
      return { ...prog, callsLeft: prog.callsLeft - 1 };
    }

    let at = prog.step;
    const stopped = { ...STOPPED, playing: prog.playing };
    for (let jumps = 0; jumps < MAX_JUMPS; jumps++) {
      if (at < 0 || at >= table.length) return stopped;
      const step = table[at];
      if (step.type === 'jump') {
        if (step.to < 0) return stopped;
        at = step.to;
        continue;
      }
      const [calls, add] = run(step);
      if (calls === 0) {
        at++;
        continue;
      }
      return program(at + 1, calls - 1, add, at);
    }
    return stopped;
  }

  // ---------------------------------------------------------------- writing

  _writeVoice(voice) {
    const b = voice.base;
    this._write(b + 0, voice.frequency & 0xff);
    this._write(b + 1, (voice.frequency >> 8) & 0xff);
    this._write(b + 2, voice.pulse & 0xff);
    this._write(b + 3, (voice.pulse >> 8) & 0x0f);
    this._write(b + 5, voice.attackDecay);
    this._write(b + 6, voice.sustainRelease);

    const first = voice.instrument?.firstControl;
    const control = voice.onFirstCall && first != null ? first & 0xff : voice.control & (voice.gate ? 0xff : 0xfe);

    // A note started with the gate still on: off and on again in this call, so the attack restarts.
    const last = this._written[b + 4];
    if (voice.retrigger && (control & 1) !== 0 && (last & 1) !== 0) this._write(b + 4, last & 0xfe, true);
    voice.retrigger = false;
    this._write(b + 4, control);
  }

  _writeRaw(chip, voice, writes) {
    for (const [register, value] of writes) {
      if (register < 0 || register > 0x18) continue;
      const target = register <= 6 && voice ? voice.base + register : chip * 0x20 + register;
      this._write(target, value & 0xff, true);
      this._carry(target, value);
    }
  }

  // The voice or chip state a write to a register sets.
  _carry(target, value) {
    const chip = this._chips[target >> 5];
    const register = target & 0x1f;
    if (register < 0x15) {
      const owner = this._voices[(target >> 5) * 3 + Math.floor(register / 7)];
      switch (register % 7) {
        case 0: owner.frequency = (owner.frequency & 0xff00) | (value & 0xff); break;
        case 1: owner.frequency = (owner.frequency & 0x00ff) | ((value & 0xff) << 8); break;
        case 2: owner.pulse = (owner.pulse & 0xf00) | (value & 0xff); break;
        case 3: owner.pulse = (owner.pulse & 0x0ff) | ((value & 0x0f) << 8); break;
        case 4: owner.control = value & 0xff; owner.gate = (value & 1) !== 0; break;
        case 5: owner.attackDecay = value & 0xff; break;
        default: owner.sustainRelease = value & 0xff; break;
      }
      return;
    }
    switch (register) {
      case 0x15: chip.cutoff = (chip.cutoff & 0x7f8) | (value & 0x07); break;
      case 0x16: chip.cutoff = (chip.cutoff & 0x007) | ((value & 0xff) << 3); break;
      case 0x17: chip.filterControl = value & 0xff; break;
      default: chip.modeVolume = value & 0xff; break;
    }
  }

  _write(register, value, force = false) {
    const used = usedBits(register);
    if (!force && (this._written[register] & used) === (value & used)) return;
    this._written[register] = value;
    this._writes.push(timedWrite(this._cycle, register, value));
  }

  // ---------------------------------------------------------------- digis

  _startStream(play) {
    const stream = clamp(play.stream, 0, this._streams.length - 1);
    const sample = play.sample >= 0 && play.sample < this._score.samples.length ? this._score.samples[play.sample] : null;
    this._streams[stream] = sample ? { sample, next: this._cycle, position: 0 } : null;
  }

  _playStreams(from, to) {
    this._streamWrites = [];
    for (let s = 0; s < this._streams.length; s++) {
      const stream = this._streams[s];
      if (!stream) continue;
      const sample = stream.sample;
      while (stream.next < to) {
        if (stream.position >= sample.values.length) {
          if (sample.loopFrom < 0 || sample.loopFrom >= sample.values.length) {
            this._streams[s] = null;
            break;
          }
          stream.position = sample.loopFrom;
        }
        let value = sample.values[stream.position++];
        if (sample.volumeNibble && (sample.register & 0x1f) === 0x18 && sample.register >> 5 < this._chips.length)
          value = (this._chips[sample.register >> 5].modeVolume & 0xf0) | (value & 0x0f);
        this._streamWrites.push(timedWrite(Math.max(from, Math.floor(stream.next)), sample.register, value & 0xff));
        stream.next += Math.max(1, sample.cyclesPerValue);
      }
    }
  }
}
