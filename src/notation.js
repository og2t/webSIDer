// The score as sheet music: each voice's notes on a grid of sixteenths, drums told apart from
// pitched notes, and the chords the voices and their arpeggios make together.

import { RowNoteKind, PitchKind } from './score.js';

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// The grid as sixteenths: a row of a few calls is one, a very short row half of one.
export function unitsOf(score) {
  const a = score.tempo, b = score.funkTempo ?? score.tempo;
  const rowsPerUnit = Math.max(a, b) <= 3 ? 2 : 1;
  return { a, b, origin: score.gridOrigin ?? 0, rowsPerUnit, funk: a !== b, fallback: Math.max(a, b) < 2 };
}

// A call's place on the grid, in sixteenths from the origin, fractional between rows.
export function unitAt(units, call) {
  const { a, b, origin, rowsPerUnit, funk, fallback } = units;
  const c = call - origin;
  let rows;
  if (fallback) rows = c / 6;
  else if (!funk) rows = c / a;
  else {
    const period = a + b, pair = Math.floor(c / period), into = c - pair * period;
    rows = 2 * pair + (into < a ? into / a : 1 + (into - a) / b);
  }
  return rows / rowsPerUnit;
}

// The steps of the program starting at `start`, up to its end.
function programSteps(table, start) {
  const steps = [];
  for (let at = start; at >= 0 && at < table.length && table[at].type !== 'jump'; at++) steps.push(table[at]);
  return steps;
}

// What an instrument's wave program says about its notes: a drum when noise opens it, and the
// semitones an arpeggio adds.
function instrumentShape(score, instrument) {
  if (!instrument) return { drum: false, arpeggio: [0] };
  const waves = programSteps(score.waveTable, instrument.waveProgram).filter((s) => s.type === 'wave');
  const drum = waves.slice(0, 3).some((s) => s.control != null && (s.control & 0x80) !== 0);
  // Each step weighted by the calls it holds, so a pitch bend at the attack is not an arpeggio note.
  const held = new Map();
  let total = 0;
  for (const s of waves) {
    if (s.pitch?.kind !== PitchKind.Relative || (s.control != null && (s.control & 0x80) !== 0) || Math.abs(s.pitch.value) > 24) continue;
    const calls = Math.min(s.calls, 16);
    held.set(s.pitch.value, (held.get(s.pitch.value) ?? 0) + calls);
    total += calls;
  }
  const offsets = new Set([0]);
  for (const [offset, calls] of held) if (calls >= total * 0.15) offsets.add(offset);
  return { drum, arpeggio: [...offsets].sort((x, y) => x - y) };
}

// Each voice's notes: where they start and end on the grid, their pitch, and whether they are drums.
// `gates[v][call]` is whether the voice's gate was on after each call.
export function voiceNotes(score, timeline, gates) {
  const units = unitsOf(score);
  const shapes = new Map();
  const shapeOf = (number) => {
    if (!shapes.has(number)) shapes.set(number, instrumentShape(score, score.instrumentNumber(number)));
    return shapes.get(number);
  };

  return timeline.rows.map((rows, v) => {
    const starts = [];
    let instrument = 0;
    for (const played of rows) {
      const row = score.patternNumber(played.pattern)?.rows[played.row];
      if (!row) continue;
      if (row.instrument > 0) instrument = row.instrument;
      if (row.note.kind !== RowNoteKind.Note) continue;
      const delay = row.effects.find((e) => e.type === 'NoteDelay')?.calls ?? 0;
      starts.push({ call: played.call + delay, note: row.note.note + played.transpose, instrument });
    }

    const gate = gates[v];
    const notes = [];
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const next = i + 1 < starts.length ? starts[i + 1].call : timeline.calls;
      // The gate going off ends a note, unless the next one follows within half a sixteenth.
      let end = s.call + 1;
      while (end < next && gate[end]) end++;
      const start = Math.round(unitAt(units, s.call));
      const nextUnit = Math.round(unitAt(units, next));
      let stop = Math.round(unitAt(units, end));
      if (unitAt(units, next) - unitAt(units, end) <= 0.5) stop = nextUnit;
      if (stop <= start) stop = start + 1;
      if (i + 1 < starts.length) stop = Math.min(stop, Math.max(start + 1, nextUnit));
      const shape = shapeOf(s.instrument);
      notes.push({ start, end: stop, note: s.note, instrument: s.instrument, drum: shape.drum, arpeggio: shape.arpeggio, call: s.call });
    }
    // Two notes on one sixteenth: the later one sounds.
    return notes.filter((n, i) => i + 1 >= notes.length || notes[i + 1].start > n.start);
  });
}

// ---------------------------------------------------------------- chords

const TEMPLATES = [
  { suffix: '', tones: [0, 4, 7] },
  { suffix: 'm', tones: [0, 3, 7] },
  { suffix: '7', tones: [0, 4, 7, 10] },
  { suffix: 'maj7', tones: [0, 4, 7, 11] },
  { suffix: 'm7', tones: [0, 3, 7, 10] },
  { suffix: '6', tones: [0, 4, 7, 9] },
  { suffix: 'm6', tones: [0, 3, 7, 9] },
  { suffix: 'add9', tones: [0, 2, 4, 7] },
  { suffix: 'm(add9)', tones: [0, 2, 3, 7] },
  { suffix: 'sus4', tones: [0, 5, 7] },
  { suffix: 'sus2', tones: [0, 2, 7] },
  { suffix: 'dim', tones: [0, 3, 6] },
  { suffix: 'm7b5', tones: [0, 3, 6, 10] },
  { suffix: 'dim7', tones: [0, 3, 6, 9] },
  { suffix: 'aug', tones: [0, 4, 8] },
  { suffix: '5', tones: [0, 7] },
];

// The chord a weighting of pitch classes is, with the bass it stands on; null with too little to go on.
export function nameChord(weights, bass) {
  return chordOf(weights, bass)?.name ?? null;
}

// The chord's name and its pitch classes.
function chordOf(weights, bass) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return null;
  const present = weights.map((w) => w / total >= 0.08);
  if (present.filter(Boolean).length < 2) return null;

  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const t of TEMPLATES) {
      const tones = new Set(t.tones.map((i) => (root + i) % 12));
      let inside = 0, outside = 0, missing = 0;
      for (let pc = 0; pc < 12; pc++) {
        const share = weights[pc] / total;
        if (tones.has(pc)) inside += share; else outside += share;
      }
      for (const pc of tones) if (!present[pc]) missing++;
      let score = inside - 1.2 * outside - 0.22 * missing - 0.04 * (t.tones.length - 3);
      if (root === bass) score += 0.12;
      if (!present[root]) score -= 0.3;
      if (!best || score > best.score) best = { root, suffix: t.suffix, tones, score };
    }
  }
  if (best.score < 0.25) return null;
  const slash = bass >= 0 && bass !== best.root && best.tones.has(bass) ? `/${PITCH_NAMES[bass]}` : '';
  return { name: `${PITCH_NAMES[best.root]}${best.suffix}${slash}`, tones: best.tones };
}

// The chord as voiced: the chord tones that sound, at their own octaves, the light ones left out.
function voicing(pitchWeights, tones) {
  const inChord = [...pitchWeights].filter(([pitch]) => tones.has(((pitch % 12) + 12) % 12));
  if (inChord.length === 0) return [];
  const heaviest = Math.max(...inChord.map(([, w]) => w));
  const kept = inChord.filter(([, w]) => w >= heaviest * 0.15).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const lowest = inChord.reduce((low, entry) => (entry[0] < low[0] ? entry : low));
  if (!kept.includes(lowest) && lowest[1] >= heaviest * 0.08) kept[kept.length - 1] = lowest;
  return kept.map(([pitch]) => pitch).sort((a, b) => a - b);
}

// The chords, a beat at a time: every pitched note sounding weighted by how long it sounds, an
// arpeggio's notes as much as the note itself, then runs of one chord joined.
export function detectChords(voices, beat = 4) {
  let end = 0;
  for (const notes of voices) for (const n of notes) end = Math.max(end, n.end);
  const beats = Math.ceil(end / beat);
  const chords = [];
  for (let k = 0; k < beats; k++) {
    const from = k * beat, to = from + beat;
    const weights = new Array(12).fill(0);
    const pitchWeights = new Map();
    let bass = -1, lowest = Infinity, sounding = 0, arpeggio = false;
    for (const notes of voices) {
      let heard = false;
      for (const n of notes) {
        if (n.drum || n.end <= from || n.start >= to) continue;
        const overlap = Math.min(n.end, to) - Math.max(n.start, from);
        const classes = new Set(n.arpeggio.map((offset) => (((n.note + offset) % 12) + 12) % 12));
        for (const pc of classes) weights[pc] += overlap;
        for (const offset of new Set(n.arpeggio)) pitchWeights.set(n.note + offset, (pitchWeights.get(n.note + offset) ?? 0) + overlap);
        if (classes.size >= 3) arpeggio = true;
        // The bass is the lowest pitch that sounds, an arpeggio's below its note included.
        const low = n.note + Math.min(...n.arpeggio);
        if (low < lowest) { lowest = low; bass = ((low % 12) + 12) % 12; }
        heard = true;
      }
      if (heard) sounding++;
    }
    // A melody alone makes no chord: two voices together, or an arpeggio, do.
    if (sounding < 2 && !arpeggio) {
      chords.push(null);
      continue;
    }
    if (bass >= 0) weights[bass] += beat * 0.5;
    const chord = chordOf(weights, bass);
    chords.push(chord && { ...chord, pitchWeights });
  }

  // A one-beat chord between two of the same is the same chord.
  const nameAt = (k) => chords[k]?.name ?? null;
  for (let k = 1; k + 1 < chords.length; k++) {
    if (nameAt(k - 1) && nameAt(k - 1) === nameAt(k + 1) && nameAt(k) !== nameAt(k - 1))
      chords[k] = { ...chords[k - 1], pitchWeights: chords[k]?.pitchWeights ?? new Map() };
  }

  const runs = [];
  for (let k = 0; k < chords.length; k++) {
    const chord = chords[k];
    if (!chord) continue;
    let last = runs[runs.length - 1];
    if (last && last.name === chord.name && last.end === k * beat) {
      last.end += beat;
    } else {
      last = { start: k * beat, end: (k + 1) * beat, name: chord.name, tones: chord.tones, weights: new Map() };
      runs.push(last);
    }
    for (const [pitch, w] of chord.pitchWeights) last.weights.set(pitch, (last.weights.get(pitch) ?? 0) + w);
  }
  return runs.map(({ start, end, name, tones, weights }) => ({ start, end, name, pitches: voicing(weights, tones) }));
}

export { PITCH_NAMES };
