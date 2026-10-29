// The music a recording is heard as: notes on the tune's own table, instruments with wave and pulse
// programs, a filter program, rows on the tune's grid cut into patterns.
// Port of MagPlay.Transcribe/Music.cs and SidTranscriber's grid fitting from MagPlaySID by Magnar Harestad (GPL v2+).

import {
  Score, NoteTables, Pitch, PitchKind, Steps, Effects, effectKey, RowNoteKind, HardRestartKind,
  HOLD_ROW, makeRow, rowOf, makeInstrument, registerOf,
} from './score.js';

const LONGEST_HARD_RESTART = 4;
const SWEEP_CALLS = 3;
const LINED_UP_CALLS = 4;
const ON_AND_ON = Math.floor(2147483647 / 2);
const PATTERN_LENGTHS = [4, 8, 16, 32, 64];

// C#'s Math.Round: halves to even.
export function roundEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Array.BinarySearch: the index, or the complement of where it would go.
function binarySearch(table, value) {
  let low = 0, high = table.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (table[mid] === value) return mid;
    if (table[mid] < value) low = mid + 1; else high = mid - 1;
  }
  return ~low;
}

// A set of values by key, in insertion order, as a .NET HashSet of records behaves.
class KeySet {
  constructor(key, items = []) {
    this.key = key;
    this.map = new Map();
    for (const item of items) this.add(item);
  }
  add(item) { const k = this.key(item); if (!this.map.has(k)) this.map.set(k, item); }
  get size() { return this.map.size; }
  values() { return [...this.map.values()]; }
  first() { return this.map.values().next().value; }
  clone() { return new KeySet(this.key, this.values()); }
  overlaps(other) { for (const k of this.map.keys()) if (other.map.has(k)) return true; return false; }
  intersectWith(other) { for (const k of [...this.map.keys()]) if (!other.map.has(k)) this.map.delete(k); }
}

const pulseKey = (p) => `${p.set ? 1 : 0}:${p.value}`;

// ---------------------------------------------------------------- frames

const tonal = (control) => (control & 0x70) !== 0 && (control & 0x88) === 0;

// Each voice's registers after each call, and the calls its gate went on in.
export function framesOf(recording) {
  const registers = new Int32Array(0x20 * recording.chips);
  const calls = recording.calls.length;
  const count = 3 * recording.chips;
  const frames = Array.from({ length: count }, () => new Array(calls));
  const rises = Array.from({ length: count }, () => []);

  for (let c = 0; c < calls; c++) {
    const rose = new Array(count).fill(false);
    for (const write of recording.callWrites[c]) {
      const r = write.register, chip = r >> 5, own = r & 0x1f;
      if (own < 0x15 && own % 7 === 4 && (write.value & 1) !== 0 && (registers[r] & 1) === 0) rose[chip * 3 + Math.floor(own / 7)] = true;
      registers[r] = write.value;
    }
    for (let v = 0; v < count; v++) {
      const b = registerOf(v, 0);
      const control = registers[b + 4];
      frames[v][c] = {
        frequency: registers[b] | (registers[b + 1] << 8),
        pulse: registers[b + 2] | ((registers[b + 3] & 0x0f) << 8),
        control,
        attackDecay: registers[b + 5],
        sustainRelease: registers[b + 6],
        gate: (control & 1) !== 0,
        tonal: tonal(control),
      };
      if (rose[v]) rises[v].push(c);
    }
  }
  return { frames, rises };
}

// Each call's filter and volume on a chip: cutoff, resonance and routing, mode and volume.
export function globalsOf(recording, chip = 0) {
  const registers = new Int32Array(0x19);
  const globals = new Array(recording.calls.length);
  for (let c = 0; c < globals.length; c++) {
    for (const write of recording.callWrites[c]) {
      if (write.register >> 5 === chip) registers[write.register & 0x1f] = write.value;
    }
    globals[c] = { cutoff: (registers[0x15] & 7) | (registers[0x16] << 3), control: registers[0x17], modeVolume: registers[0x18] };
  }
  return globals;
}

// The filter as a program from the first call: a step for each run the cutoff moves evenly in.
function filterProgram(score, chip, globals) {
  if (globals.every((g) => g.cutoff === 0 && g.control === 0 && g.modeVolume === 0)) return;

  score.filterPrograms[chip] = score.filterTable.length;
  let volume = 0;
  for (let c = 0; c < globals.length;) {
    const g = globals[c];
    let add = 0, run = 1;
    const same = (o) => o.control === g.control && o.modeVolume === g.modeVolume;
    if (c + 1 < globals.length && same(globals[c + 1])) {
      add = ((globals[c + 1].cutoff - g.cutoff + 0x400) & 0x7ff) - 0x400;
      while (c + run < globals.length && same(globals[c + run])
             && ((globals[c + run].cutoff - globals[c + run - 1].cutoff) & 0x7ff) === (add & 0x7ff)) run++;
    }
    if ((g.modeVolume & 0x0f) !== volume) score.filterTable.push(Steps.effect(Effects.masterVolume(g.modeVolume & 0x0f)));
    volume = g.modeVolume & 0x0f;
    score.filterTable.push(Steps.filter(g.cutoff, g.control, g.modeVolume & 0xf0, add, run));
    c += run;
  }
  score.filterTable.push(Steps.jump(-1));
}

// ---------------------------------------------------------------- the note table

// The tune's own frequency for each note, MagSID's table shifted by the tune's tuning elsewhere.
export function noteTableOf(frames) {
  const standard = NoteTables.magSidPal();
  const held = [];
  for (const voice of frames) {
    for (let c = 1; c < voice.length; c++) {
      const f = voice[c];
      if (f.gate && f.tonal && f.frequency >= 0x100 && f.frequency === voice[c - 1].frequency) held.push(f.frequency);
    }
  }

  const tuning = tuningOf(held, standard);
  const table = standard.map((s) => Math.min(0xffff, roundEven(s * Math.pow(2, tuning / 12))));

  const groups = new Map();
  for (const f of held) {
    const n = nearest(f, standard, tuning);
    if (n < 0) continue;
    if (!groups.has(n)) groups.set(n, new Map());
    const counts = groups.get(n);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  for (const [n, counts] of groups) {
    let best = -1, bestCount = -1;
    for (const [f, count] of counts) if (count > bestCount || (count === bestCount && f < best)) { best = f; bestCount = count; }
    table[n] = best;
  }

  // Each note above the one below, so a frequency names one note at most.
  for (let n = 1; n < table.length; n++) table[n] = Math.min(0xffff, Math.max(table[n], table[n - 1] + 1));
  return table;
}

// The semitones the held frequencies sit from the standard, as a circular mean.
function tuningOf(held, standard) {
  let sin = 0, cos = 0;
  for (const f of held) {
    const semitones = 12 * Math.log2(f / standard[0]);
    const angle = 2 * Math.PI * (semitones - roundEven(semitones));
    sin += Math.sin(angle);
    cos += Math.cos(angle);
  }
  return held.length < 16 || Math.sqrt(sin * sin + cos * cos) < held.length * 0.5 ? 0 : Math.atan2(sin, cos) / (2 * Math.PI);
}

function nearest(frequency, standard, tuning) {
  if (frequency <= 0) return -1;
  const n = roundEven(12 * Math.log2(frequency / standard[0]) - tuning);
  return n >= 0 && n < standard.length ? n : -1;
}

// ---------------------------------------------------------------- the grid (SidTranscriber)

const MAX_FUNK_DIFFERENCE = 5;
const MIN_STARTS_FOR_FUNK = 64;

// Lexicographic max over keys; the first of equals wins, as LINQ's MaxBy.
function maxBy(items, keyOf) {
  let best = items[0], bestKey = keyOf(best);
  for (let i = 1; i < items.length; i++) {
    const key = keyOf(items[i]);
    for (let k = 0; k < key.length; k++) {
      if (key[k] > bestKey[k]) { best = items[i]; bestKey = key; break; }
      if (key[k] < bestKey[k]) break;
    }
  }
  return best;
}

// The phase that puts most starts on a row; from 4 calls a row, a call either side counts.
function bestPhase(starts, a, b) {
  const period = a === b ? a : a + b;
  const rows = a === b ? [0] : [0, a];
  const tolerant = Math.min(a, b) >= 4;
  const counts = new Int32Array(period);
  for (const s of starts) counts[s % period]++;

  const near = (p) => rows.reduce((sum, r) => sum + (tolerant
    ? counts[(p + r) % period] + counts[(p + r + 1) % period] + counts[(p + r + period - 1) % period]
    : counts[(p + r) % period]), 0);
  const on = (p) => rows.reduce((sum, r) => sum + counts[(p + r) % period], 0);
  const onOrLate = (p) => rows.reduce((sum, r) => sum + counts[(p + r) % period] + counts[(p + r + 1) % period], 0);

  const phases = Array.from({ length: period }, (_, p) => p);
  const best = a === b ? maxBy(phases, (p) => [near(p), on(p)]) : maxBy(phases, (p) => [onOrLate(p), near(p), on(p)]);
  return { phase: best, aligned: near(best), exact: onOrLate(best), on: on(best) };
}

function gridFitting(starts) {
  if (starts.length === 0) return null;
  const swingShows = starts.length >= MIN_STARTS_FOR_FUNK;
  for (let pair = 32; pair >= 4; pair--) {
    if (pair % 2 === 0 && pair / 2 <= 16 && bestPhase(starts, pair / 2, pair / 2).aligned >= starts.length * 0.9)
      return { a: pair / 2, funk: null };
    if (!swingShows) continue;

    const fits = [];
    for (let a = 2; a < pair - 1; a++) {
      const b = pair - a;
      if (a === b || a > 16 || b > 16 || Math.abs(a - b) > MAX_FUNK_DIFFERENCE) continue;
      const fit = bestPhase(starts, a, b);
      if (fit.aligned >= starts.length * 0.9 && fit.exact >= starts.length * 0.9) fits.push({ a, b, fit });
    }
    if (fits.length > 0) {
      const best = maxBy(fits, (g) => [g.fit.exact, g.fit.on, g.a]);
      return { a: best.a, funk: best.b };
    }
  }
  return null;
}

export function suggestGrid(starts) {
  if (starts.length === 0) return { a: 6, funk: null };
  return gridFitting(starts) ?? { a: 1, funk: null };
}

const GAPS_ON_ROWS = 0.9;
const SHIFT_HOLDS = 3;

// Where the rows fall: rows of A calls (A and B in turn with funk tempo) from the origin.
class Grid {
  constructor(a, b, origin, shifts = null) {
    this.a = a;
    this.b = b;
    this.origin = origin;
    this.shifts = shifts;
  }

  get funk() { return this.a !== this.b; }
  get period() { return this.funk ? this.a + this.b : this.a; }

  callOf(row) {
    return this.origin + Math.trunc(row / (this.funk ? 2 : 1)) * this.period + (this.funk && (row & 1) === 1 ? this.a : 0);
  }

  static of(rises) {
    const starts = rises.flat().sort((x, y) => x - y);
    const { a, funk } = suggestGrid(starts);
    const b = funk ?? a;
    if (starts.length === 0) return new Grid(a, b, 0);
    if (a === 1 && funk === null) {
      const shifting = Grid._shifting([...new Set(starts)]);
      if (shifting) return shifting;
    }

    let grid = null, least = Infinity;
    for (let phase = 0; phase < a + (funk === null ? 0 : b); phase++) {
      const candidates = funk === null ? [new Grid(a, b, phase)] : [new Grid(a, b, phase), new Grid(b, a, phase)];
      for (const g of candidates) {
        const d = g._delays(starts);
        if (d < least) { least = d; grid = g; }
      }
    }
    while (grid.origin + grid.period <= starts[0]) grid = new Grid(grid.a, grid.b, grid.origin + grid.period, grid.shifts);
    return grid;
  }

  // The longest row length nine gaps in ten are whole rows of, starting again where the notes move.
  static _shifting(starts) {
    if (starts.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
    let length = 0;
    for (let a = 16; a >= 2; a--) {
      if (gaps.filter((g) => g % a === 0).length >= gaps.length * GAPS_ON_ROWS) { length = a; break; }
    }
    if (length === 0) return null;

    const shifts = [];
    let phase = starts[0];
    for (let i = 1; i < starts.length; i++) {
      const start = starts[i];
      if ((start - phase) % length === 0) continue;
      const after = starts.slice(i + 1, i + 1 + SHIFT_HOLDS);
      if (after.length === SHIFT_HOLDS && after.every((t) => (t - start) % length === 0)) {
        shifts.push(start);
        phase = start;
      }
    }
    return new Grid(length, length, starts[0], shifts);
  }

  _delays(starts) {
    let total = 0;
    for (const start of starts) {
      const from = this.origin + Math.floor((start - this.origin) / this.period) * this.period;
      const into = start - from;
      total += this.funk && into >= this.a ? into - this.a : into;
    }
    return total;
  }

  // A voice's notes laid on the grid up to `end`, each row with the grid row it is in.
  lay(notes, end) {
    const rows = [];
    let next = 0, gridRow = -1;
    const region = (from, to, own) => {
      const inside = [];
      while (next < notes.length && notes[next].start < to) inside.push(notes[next++]);
      if (inside.length === 0) {
        rows.push({ gridRow, row: own ? { ...HOLD_ROW, calls: to - from } : HOLD_ROW });
        return;
      }
      for (let i = 0; i < inside.length; i++) {
        const rowFrom = i === 0 ? from : inside[i].start;
        const rowTo = i + 1 < inside.length ? inside[i + 1].start : to;
        const delay = inside[i].start - rowFrom;
        const row = delay > 0 ? { ...inside[i].row, effects: [...inside[i].row.effects, Effects.noteDelay(delay)] } : inside[i].row;
        rows.push({ gridRow, row: own || inside.length > 1 ? { ...row, calls: rowTo - rowFrom } : row });
      }
    };

    if (this.origin > 0) region(0, this.origin, true);
    if (!this.shifts || this.shifts.length === 0) {
      for (gridRow = 0; this.callOf(gridRow) < end; gridRow++) region(this.callOf(gridRow), this.callOf(gridRow + 1), this.funk);
      return rows;
    }

    let at = this.origin, shift = 0;
    const shifts = this.shifts;
    for (gridRow = 0; at < end; gridRow++) {
      while (shift < shifts.length && shifts[shift] <= at) shift++;
      let to = at + this.a;
      const cut = shift < shifts.length && shifts[shift] < to;
      if (cut) to = shifts[shift];
      region(at, to, cut);
      at = to;
    }
    return rows;
  }
}

// ---------------------------------------------------------------- patterns

const shapeOf = (row, based) =>
  `${row.note.kind}${row.note.kind === RowNoteKind.Note ? row.note.note - based : 0}/${row.instrument}/${row.calls ?? ''}/${row.effects.map(effectKey).join(',')}`;

// Each voice's rows cut into patterns of `length` grid rows, a stretch played again its pattern
// again; into `score`, or only counted when there is none.
function arrange(score, voices, length) {
  const made = new Map();
  let cost = 0;
  for (let v = 0; v < voices.length; v++) {
    const rows = voices[v];
    if (!rows) continue;

    const stretches = [];
    let lastKey = null;
    for (const r of rows) {
      const key = r.gridRow < 0 ? -1 : Math.trunc(r.gridRow / length);
      if (key !== lastKey) { stretches.push([]); lastKey = key; }
      stretches[stretches.length - 1].push(r.row);
    }

    const order = [];
    for (const stretch of stretches) {
      const based = stretch.find((r) => r.note.kind === RowNoteKind.Note)?.note.note ?? 0;
      const shape = stretch.map((r) => shapeOf(r, based)).join('|');
      let pattern = made.get(shape);
      if (!pattern) {
        pattern = { number: made.size + 1, base: based };
        made.set(shape, pattern);
        cost += stretch.length;
        if (score) score.patterns.push({ number: pattern.number, rows: [...stretch] });
      }

      const transpose = based - pattern.base;
      const last = order[order.length - 1];
      if (last && last.pattern === pattern.number && last.transpose === transpose) last.repeat++;
      else order.push({ pattern: pattern.number, transpose, repeat: 1 });
    }

    cost += order.length;
    if (score) {
      score.voices[v].order.push(...order);
      score.voices[v].loopTo = -1;
    }
  }
  return cost;
}

function patternLength(voices) {
  let best = PATTERN_LENGTHS[0], least = Infinity;
  for (const length of PATTERN_LENGTHS) {
    const cost = arrange(null, voices, length);
    if (cost <= least) { least = cost; best = length; }
  }
  return best;
}

// ---------------------------------------------------------------- notes and instruments

// The pulse width on the calls from `call` is where the sweep before was going.
function carriesPulseOn(frames, call, end) {
  if (call < 2) return false;
  for (let c = call; c < Math.min(end, call + SWEEP_CALLS); c++) {
    if (frames[c].pulse !== ((2 * frames[c - 1].pulse - frames[c - 2].pulse) & 0xfff)) return false;
  }
  return true;
}

// The calls at a note's end, before the next, that the gate is off for: the tune's hard restart.
function tailOf(frames, start, end) {
  let tail = 0;
  while (tail < LONGEST_HARD_RESTART && end - 1 - tail > start && !frames[end - 1 - tail].gate) tail++;
  return tail < LONGEST_HARD_RESTART && end - 1 - tail > start ? tail : 0;
}

const delta = (from, to) => ((to - from + 0x800) & 0xfff) - 0x800;

function pitchesOf(table, note, frequency) {
  const pitches = new KeySet(Pitch.key);
  const n = binarySearch(table, frequency);
  if (n >= 0) {
    pitches.add(Pitch.relative(n - note));
    pitches.add(Pitch.absolute(n));
  }
  pitches.add(Pitch.offset(frequency - table[note]));
  pitches.add(Pitch.frequency(frequency));
  return pitches;
}

// Some way of saying each call fits both, past mine's end the one its last call holds on with.
function fits(mine, theirs) {
  let held = null;
  for (let c = 0; c < theirs.length; c++) {
    if (c < mine.length - 1) {
      if (!mine[c].overlaps(theirs[c])) return false;
      continue;
    }
    held ??= mine[mine.length - 1].clone();
    held.intersectWith(theirs[c]);
    if (held.size === 0) return false;
  }
  return true;
}

const KIND_ORDER = { [PitchKind.Relative]: 0, [PitchKind.Absolute]: 1, [PitchKind.Offset]: 2, [PitchKind.Frequency]: 3 };

function chosen(pitches) {
  let best = null;
  for (const p of pitches.values()) {
    if (!best || KIND_ORDER[p.kind] < KIND_ORDER[best.kind] || (KIND_ORDER[p.kind] === KIND_ORDER[best.kind] && Math.abs(p.value) < Math.abs(best.value)))
      best = p;
  }
  return best;
}

// The note a note is: the table pitch it holds longest with a tonal waveform, else its first.
function baseNote(table, frames, start, end) {
  let held = -1, longest = 0;
  for (let c = start; c < end;) {
    let run = 1;
    while (c + run < end && frames[c + run].frequency === frames[c].frequency && frames[c + run].tonal === frames[c].tonal) run++;
    if (frames[c].tonal && run > longest) {
      const n = binarySearch(table, frames[c].frequency);
      if (n >= 0) { held = n; longest = run; }
    }
    c += run;
  }
  if (held >= 0) return held;

  for (let c = start; c < end; c++) {
    const n = binarySearch(table, frames[c].frequency);
    if (n >= 0) return n;
  }
  const n = binarySearch(table, frames[start].frequency);
  return Math.min(Math.max(n < 0 ? ~n : n, 0), table.length - 1);
}

// What a voice does while a note sounds, call by call, and how it is quietened before the next.
class Sound {
  static hear(table, frames, span) {
    const sounding = span.end - span.tail;
    const note = baseNote(table, frames, span.program, sounding);
    const wave = [];
    let was = frames[span.start];
    for (let c = span.program; c < sounding; c++) {
      const f = frames[c];
      wave.push({
        control: f.control,
        attackDecay: f.attackDecay !== was.attackDecay ? f.attackDecay : null,
        sustainRelease: f.sustainRelease !== was.sustainRelease ? f.sustainRelease : null,
        pitches: pitchesOf(table, note, f.frequency),
        frequency: f.frequency,
      });
      was = f;
    }

    let pulse = null;
    if (span.pulseCalls >= 0) {
      pulse = [];
      let before = span.program > 0 ? frames[span.program - 1].pulse : 0;
      for (let c = span.program; c < span.program + span.pulseCalls; c++) {
        pulse.push(new KeySet(pulseKey, [{ set: true, value: frames[c].pulse }, { set: false, value: delta(before, frames[c].pulse) }]));
        before = frames[c].pulse;
      }
    }

    const quiet = span.tail > 0 ? frames[sounding] : { attackDecay: 0, sustainRelease: 0 };
    const sounded = span.tail > 0 ? frames[sounding - 1] : { attackDecay: 0, sustainRelease: 0 };
    const sound = new Sound();
    Object.assign(sound, {
      note,
      first: span.keepsFirstCall ? frames[span.start].control : null,
      attackDecay: frames[span.start].attackDecay,
      sustainRelease: frames[span.start].sustainRelease,
      wave,
      pulse,
      tail: span.tail,
      tailEnvelope: quiet.attackDecay === sounded.attackDecay && quiet.sustainRelease === sounded.sustainRelease
        ? -1 : (quiet.attackDecay << 8) | quiet.sustainRelease,
    });
    return sound;
  }

  // Plays the other's note as it sounds; the note it is then, or null.
  plays(other, table) {
    if (other.first !== this.first || other.tail !== this.tail || other.tailEnvelope !== this.tailEnvelope) return null;
    if ((other.pulse === null) !== (this.pulse === null)) return null;
    if (this.pulse && !fits(this.pulse, other.pulse)) return null;

    for (let c = 0; c < other.wave.length; c++) {
      const mine = this.wave[Math.min(c, this.wave.length - 1)];
      const theirs = other.wave[c];
      if (mine.control !== theirs.control || mine.attackDecay !== theirs.attackDecay || mine.sustainRelease !== theirs.sustainRelease) return null;
    }

    const pitches = this.wave.map((w) => w.pitches);
    for (const note of this._notesFor(other, table)) {
      if (fits(pitches, other.wave.map((w) => pitchesOf(table, note, w.frequency)))) return note;
    }
    return null;
  }

  // The notes the other could be: its own, then those that line its first pitches up with these.
  *_notesFor(other, table) {
    yield other.note;
    const calls = Math.min(LINED_UP_CALLS, Math.min(this.wave.length, other.wave.length));
    for (let c = 0; c < calls; c++) {
      const heard = binarySearch(table, other.wave[c].frequency);
      if (heard < 0) continue;
      for (const pitch of this.wave[c].pitches.values()) {
        const note = heard - pitch.value;
        if (pitch.kind === PitchKind.Relative && note >= 0 && note < table.length && note !== other.note) yield note;
      }
    }
  }

  // Takes the other's note on: only the ways of saying each call that fit it too are kept.
  join(other, table, note) {
    for (let c = 0; c < other.wave.length; c++)
      this.wave[Math.min(c, this.wave.length - 1)].pitches.intersectWith(pitchesOf(table, note, other.wave[c].frequency));
    if (this.pulse) {
      for (let c = 0; c < other.pulse.length; c++) this.pulse[Math.min(c, this.pulse.length - 1)].intersectWith(other.pulse[c]);
    }
  }

  toInstrument(score) {
    const instrument = makeInstrument({
      number: score.instruments.length + 1,
      attackDecay: this.attackDecay,
      sustainRelease: this.sustainRelease,
      firstControl: this.first,
      gateTimer: this.tail,
      hardRestart: this.tail === 0 ? HardRestartKind.None : this.tailEnvelope < 0 ? HardRestartKind.GateOff : HardRestartKind.Envelope,
      hardRestartEnvelope: Math.max(0, this.tailEnvelope),
      waveProgram: score.waveTable.length,
    });

    const steps = this.wave.map((w) => ({ control: w.control, pitch: chosen(w.pitches), attackDecay: w.attackDecay, sustainRelease: w.sustainRelease }));
    for (let c = 0; c < steps.length;) {
      const { control, pitch, attackDecay, sustainRelease } = steps[c];
      if (attackDecay !== null) score.waveTable.push(Steps.effect(Effects.setAttackDecay(attackDecay)));
      if (sustainRelease !== null) score.waveTable.push(Steps.effect(Effects.setSustainRelease(sustainRelease)));
      let run = 1;
      while (c + run < steps.length) {
        const s = steps[c + run];
        if (s.control !== control || s.pitch.kind !== pitch.kind || s.pitch.value !== pitch.value || s.attackDecay !== null || s.sustainRelease !== null) break;
        run++;
      }
      score.waveTable.push(Steps.wave(control, pitch, run));
      c += run;
    }
    score.waveTable.push(Steps.jump(-1));

    if (this.pulse) {
      instrument.pulseProgram = score.pulseTable.length;
      pulses(score, this.pulse);
    }
    return instrument;
  }
}

// A pulse program: a width set and each run it moves evenly after, the last run on and on.
function pulses(score, pulse) {
  const calls = pulse.map((ways, c) => ways.values().find((w) => w.set === (c === 0)) ?? ways.first());
  for (let c = 0; c < calls.length;) {
    const width = calls[c].set ? calls[c].value : null;
    const next = width === null ? c : c + 1;
    const add = next < calls.length && !calls[next].set ? calls[next].value : 0;
    let end = next;
    while (end < calls.length && !calls[end].set && calls[end].value === add) end++;
    end = Math.max(end, c + 1);
    score.pulseTable.push(Steps.pulse(width, add, end >= calls.length && add !== 0 ? ON_AND_ON : end - c));
    c = end;
  }
  score.pulseTable.push(Steps.jump(-1));
}

// One voice's notes as rows on the grid, each on the first instrument that plays it as the tune does.
function voiceRows(score, frames, rises, sounds, grid) {
  if (rises.length === 0) return null;

  const spans = rises.map((start, i) => {
    const end = i + 1 < rises.length ? rises[i + 1] : frames.length;
    const tail = i + 1 < rises.length ? tailOf(frames, start, end) : 0;
    const keeps = start > 0 && end - tail - start >= 2
      && frames[start].frequency === frames[start - 1].frequency && frames[start].pulse === frames[start - 1].pulse;
    return { start, end, tail, keepsFirstCall: keeps, pulseCalls: 0, width: null, program: start + (keeps ? 1 : 0) };
  });

  // A note restarts the pulse unless its program's first calls carry the sweep before it on.
  const restarts = [];
  for (let i = 0; i < spans.length; i++) if (i === 0 || !carriesPulseOn(frames, spans[i].program, spans[i].end)) restarts.push(i);

  // A width held all the while needs no program once the one before has stopped moving.
  let held = true;
  for (let r = 0; r < restarts.length; r++) {
    const span = spans[restarts[r]];
    const until = r + 1 < restarts.length ? spans[restarts[r + 1]].program : frames.length;
    const width = frames[span.program].pulse, before = span.program > 0 ? frames[span.program - 1].pulse : 0;
    let constant = true;
    for (let c = span.program; c < until; c++) if (frames[c].pulse !== width) { constant = false; break; }
    if (held && constant && (!span.keepsFirstCall || width === before)) {
      spans[restarts[r]] = { ...span, pulseCalls: -1, width: width !== before ? width : null };
      restarts.splice(r--, 1);
      continue;
    }
    spans[restarts[r]] = { ...span, pulseCalls: until - span.program };
    held = until - span.program >= 2 && frames[until - 1].pulse === frames[until - 2].pulse;
  }
  const restartSet = new Set(restarts);
  for (let i = 0; i < spans.length; i++) {
    if (!restartSet.has(i) && spans[i].pulseCalls >= 0) spans[i] = { ...spans[i], pulseCalls: -1 };
  }

  // Longest first, so an instrument is made from the most of its program there is.
  const order = spans.map((_, i) => i);
  const length = (s) => s.end - s.tail - s.start + Math.max(0, s.pulseCalls);
  order.sort((x, y) => length(spans[y]) - length(spans[x]) || x - y);

  const rows = new Array(spans.length);
  for (const i of order) {
    const heard = Sound.hear(score.noteTable, frames, spans[i]);
    let note = heard.note;
    let number = -1;
    for (let s = 0; s < sounds.length; s++) {
      const named = sounds[s].plays(heard, score.noteTable);
      if (named !== null) { note = named; number = s; break; }
    }
    if (number < 0) {
      sounds.push(heard);
      number = sounds.length - 1;
      note = heard.note;
    } else {
      sounds[number].join(heard, score.noteTable, note);
    }
    // A note sounding with another envelope than its instrument's sets it on its row.
    const sound = sounds[number];
    const effects = [];
    if (heard.attackDecay !== sound.attackDecay) effects.push(Effects.setAttackDecay(heard.attackDecay));
    if (heard.sustainRelease !== sound.sustainRelease) effects.push(Effects.setSustainRelease(heard.sustainRelease));
    if (spans[i].width !== null) effects.push(Effects.setPulse(spans[i].width));
    rows[i] = rowOf(note, number + 1, effects);
  }

  return grid.lay(spans.map((span, i) => ({ start: span.start, row: rows[i] })), frames.length);
}

// The score's music for a recording, without timing or raw layer; null with too few calls.
export function musicOf(recording) {
  if (recording.calls.length < 2) return null;

  const { frames, rises } = framesOf(recording);
  const table = noteTableOf(frames);
  const score = new Score();
  score.machine = recording.machine;
  score.noteTable = table;
  score.chips = recording.chips;
  const sounds = [];
  const grid = Grid.of(rises);
  score.tempo = grid.a;
  score.funkTempo = grid.funk ? grid.b : null;
  score.gridOrigin = grid.origin;
  const voices = frames.map((voice, v) => voiceRows(score, voice, rises[v], sounds, grid));
  arrange(score, voices, patternLength(voices));

  for (const sound of sounds) score.instruments.push(sound.toInstrument(score));
  for (let chip = 0; chip < recording.chips; chip++) filterProgram(score, chip, globalsOf(recording, chip));
  return score;
}

export { makeRow };
