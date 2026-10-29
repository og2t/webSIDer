// The score a tune is transcribed into: order lists, patterns of rows, instruments and tables.
// Port of MagPlay.Score (Score, Tables, Raw, Effects) from MagPlaySID by Magnar Harestad (GPL v2+).

import { Machine, Machines } from './c64.js';

// ---------------------------------------------------------------- notes

// MagSID's PAL table, C-0 to B-7.
const FREQ_HI = [
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02,
  0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x03, 0x04,
  0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x07, 0x07, 0x08,
  0x08, 0x09, 0x09, 0x0a, 0x0a, 0x0b, 0x0c, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x18, 0x19, 0x1b, 0x1c, 0x1e, 0x20,
  0x22, 0x24, 0x26, 0x28, 0x2b, 0x2d, 0x30, 0x33, 0x36, 0x39, 0x3d, 0x40,
  0x44, 0x48, 0x4c, 0x51, 0x56, 0x5b, 0x60, 0x66, 0x6c, 0x73, 0x7a, 0x81,
  0x89, 0x91, 0x99, 0xa3, 0xac, 0xb7, 0xc1, 0xcd, 0xd9, 0xe6, 0xf4, 0xff,
];
const FREQ_LO = [
  0x12, 0x23, 0x34, 0x46, 0x5a, 0x6e, 0x84, 0x9b, 0xb3, 0xcd, 0xe9, 0x06,
  0x25, 0x45, 0x68, 0x8c, 0xb3, 0xdc, 0x08, 0x36, 0x67, 0x9b, 0xd2, 0x0c,
  0x49, 0x8b, 0xd0, 0x19, 0x67, 0xb9, 0x10, 0x6c, 0xce, 0x35, 0xa3, 0x17,
  0x93, 0x15, 0x9f, 0x3c, 0xcd, 0x72, 0x20, 0xd8, 0x9c, 0x6b, 0x46, 0x2f,
  0x25, 0x2a, 0x3f, 0x64, 0x9a, 0xe3, 0x3f, 0xb1, 0x38, 0xd6, 0x8d, 0x5e,
  0x4b, 0x55, 0x7e, 0xc8, 0x34, 0xc6, 0x7f, 0x61, 0x6f, 0xac, 0x7e, 0xbc,
  0x95, 0xa9, 0xfc, 0xa1, 0x69, 0x8c, 0xfe, 0xc2, 0xdf, 0x58, 0x34, 0x78,
  0x2b, 0x53, 0xf7, 0x1f, 0xd2, 0x19, 0xfc, 0x85, 0xbd, 0xb0, 0x67, 0xff,
];
const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export const NoteTables = {
  magSidPal: () => FREQ_LO.map((lo, i) => lo | (FREQ_HI[i] << 8)),
  name: (note) => (note >= 0 && note < 96 ? NAMES[note % 12] + Math.floor(note / 12) : `#${note}`),
};

// ---------------------------------------------------------------- pitches and table steps

export const PitchKind = Object.freeze({ Relative: 0, Absolute: 1, Frequency: 2, Offset: 3 });

export const Pitch = {
  relative: (semitones) => ({ kind: PitchKind.Relative, value: semitones }),
  absolute: (note) => ({ kind: PitchKind.Absolute, value: note }),
  frequency: (value) => ({ kind: PitchKind.Frequency, value }),
  offset: (value) => ({ kind: PitchKind.Offset, value }),
  key: (p) => `${p.kind}:${p.value}`,
};

export const Steps = {
  jump: (to) => ({ type: 'jump', to }),
  wave: (control = null, pitch = null, calls = 1) => ({ type: 'wave', control, pitch, calls }),
  pulse: (width = null, add = 0, calls = 1) => ({ type: 'pulse', width, add, calls }),
  filter: (cutoff = null, control = null, mode = null, add = 0, calls = 1) => ({ type: 'filter', cutoff, control, mode, add, calls }),
  effect: (effect) => ({ type: 'effect', effect }),
  raw: (writes, calls = 1) => ({ type: 'raw', writes, calls }),
};

// ---------------------------------------------------------------- effects

const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const hexWide = (v) => (v <= 0xff ? hex(v, 2) : hex(v, 4));

// The effect in a tracker's column: GoatTracker's numbers where it has the command.
export function effectLabel(e) {
  switch (e.type) {
    case 'Portamento': return e.speed >= 0 ? `1${hexWide(e.speed)}` : `2${hexWide(-e.speed)}`;
    case 'TonePortamento': return `3${hexWide(e.speed)}`;
    case 'Vibrato': return `4${e.speed.toString(16).toUpperCase()}${hexWide(e.depth)}`;
    case 'SetAttackDecay': return `5${hex(e.value)}`;
    case 'SetSustainRelease': return `6${hex(e.value)}`;
    case 'SetControl': return `7${hex(e.value)}`;
    case 'SetWaveProgram': return `8${hex(e.step)}`;
    case 'SetPulseProgram': return `9${hex(e.step)}`;
    case 'SetFilterProgram': return `A${hex(e.step)}`;
    case 'FilterControl': return `B${hex(e.value)}`;
    case 'FilterCutoff': return `C${hexWide(e.value)}`;
    case 'MasterVolume': return `D${hex(e.value)}`;
    case 'FunkTempo': return `E${e.first.toString(16).toUpperCase()}${e.second.toString(16).toUpperCase()}`;
    case 'Tempo': return `F${hex(e.thisVoiceOnly ? e.calls | 0x80 : e.calls)}`;
    case 'FilterMode': return `M${hex(e.value)}`;
    case 'Arpeggio': return `0${e.first.toString(16).toUpperCase()}${e.second.toString(16).toUpperCase()}`;
    case 'NoteDelay': return `ND${e.calls.toString(16).toUpperCase()}`;
    case 'NoteCut': return `NC${e.calls.toString(16).toUpperCase()}`;
    case 'Detune': return `DT${e.amount < 0 ? '-' : '+'}${Math.abs(e.amount).toString(16).toUpperCase()}`;
    case 'SetFrequency': return `F=${hex(e.value, 4)}`;
    case 'SetPulse': return `P=${hex(e.value, 3)}`;
    case 'CallRate': return `CR${hex(e.cycles, 4)}`;
    case 'PlaySample': return e.sample < 0 ? `S${e.stream}--` : `S${e.stream}${hex(e.sample)}`;
    default: return '?';
  }
}

export const effectKey = (e) => JSON.stringify(e);

export const Effects = {
  setAttackDecay: (value) => ({ type: 'SetAttackDecay', value }),
  setSustainRelease: (value) => ({ type: 'SetSustainRelease', value }),
  setPulse: (value) => ({ type: 'SetPulse', value }),
  masterVolume: (value) => ({ type: 'MasterVolume', value }),
  noteDelay: (calls) => ({ type: 'NoteDelay', calls }),
};

// ---------------------------------------------------------------- rows and the score

export const RowNoteKind = Object.freeze({ Hold: 0, Note: 1, GateOff: 2, GateOn: 3 });

export const HardRestartKind = Object.freeze({ GateOff: 0, Envelope: 1, None: 2 });

// A row of one voice; calls is null when the row lasts the tempo's.
export const makeRow = ({ note = { kind: RowNoteKind.Hold, note: 0 }, instrument = 0, effects = [], calls = null } = {}) =>
  ({ note, instrument, effects, calls });

export const HOLD_ROW = makeRow();

export const rowOf = (note, instrument = 0, effects = []) =>
  makeRow({ note: { kind: RowNoteKind.Note, note }, instrument, effects });

export function makeInstrument(fields = {}) {
  return {
    number: 0,
    name: '',
    attackDecay: 0,
    sustainRelease: 0,
    waveProgram: -1,
    pulseProgram: -1,
    filterProgram: -1,
    firstControl: null,
    gateTimer: 2,
    hardRestart: HardRestartKind.Envelope,
    hardRestartEnvelope: 0x0f00,
    vibrato: null,
    ...fields,
  };
}

// The register a voice's register 0-6 is, counted across the chips.
export const registerOf = (voice, register) => Math.floor(voice / 3) * 0x20 + (voice % 3) * 7 + register;

export class Score {
  constructor() {
    this.title = '';
    this.machine = Machine.Pal;
    this.cyclesPerCall = Machines.cyclesPerFrame(Machine.Pal);
    this.firstCall = 0;
    this.callCycles = null;
    this.raw = { between: [], calls: new Map() };
    this.noteTable = NoteTables.magSidPal();
    this.tempo = 6;
    this.funkTempo = null;
    this.modeVolume = 0x0f;
    this.instruments = [];
    this.patterns = [];
    this.waveTable = [];
    this.pulseTable = [];
    this.filterTable = [];
    this.samples = [];
    this._chips = 1;
    this.voices = [newVoice(), newVoice(), newVoice()];
    this.filterPrograms = [-1];
  }

  get callsPerSecond() { return Machines.clockHz(this.machine) / this.cyclesPerCall; }

  get chips() { return this._chips; }

  set chips(value) {
    this._chips = Math.min(Math.max(value, 1), 3);
    this.voices = Array.from({ length: 3 * this._chips }, (_, v) => (v < this.voices.length ? this.voices[v] : newVoice()));
    this.filterPrograms = Array.from({ length: this._chips }, (_, c) => (c < this.filterPrograms.length ? this.filterPrograms[c] : -1));
  }

  instrumentNumber(number) { return this.instruments.find((i) => i.number === number) ?? null; }

  patternNumber(number) { return this.patterns.find((p) => p.number === number) ?? null; }
}

const newVoice = () => ({ order: [], loopTo: 0 });

// One call's raw writes: `registers` is the set it replaces, `writes` their {offset, register, value}.
export const rawCall = (registers, writes) => ({ registers, writes });
