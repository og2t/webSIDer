// Each voice as sheet music, a staff a voice, scrolling past the playhead with the chords above.
// Bars are engraved by VexFlow; notes sit in proportion to time, so every staff lines up.

import { palette, voiceColour, withAlpha, MONO } from './palette.js';
import { unitAt, PITCH_NAMES } from '../notation.js';

const HEADER = 78;
const CHORD_ROW = 30;
const STAFF_H = 126;
const CHORD_STAFF_H = 198;
const BASS_TOP = 76;
const STAFF_TOP = 4;
const UNIT_W = 22;
const PAD = 30;
const BAR_UNITS = 16;
const BAR_W = PAD + BAR_UNITS * UNIT_W;
const PLAYHEAD = 0.3;
const TICKS_PER_UNIT = 1024;

const DURATIONS = [[16, 'w'], [12, 'hd'], [8, 'h'], [6, 'qd'], [4, 'q'], [3, '8d'], [2, '8'], [1, '16']];

// A length at a place in the bar as note values, larger first, beats kept whole where they can be.
function split(position, length) {
  const parts = [];
  while (length > 0) {
    let pick = DURATIONS[DURATIONS.length - 1];
    for (const d of DURATIONS) {
      const base = d[1].endsWith('d') ? (d[0] * 2) / 3 : d[0];
      if (d[0] <= length && position % Math.min(base, 4) === 0) { pick = d; break; }
    }
    parts.push({ position, units: pick[0], duration: pick[1] });
    position += pick[0];
    length -= pick[0];
  }
  return parts;
}

const CLEFS = {
  bass8vb: { clef: 'bass', shift: 12, annotation: '8vb', low: -Infinity, high: 36 },
  bass: { clef: 'bass', shift: 0, annotation: null, low: 36, high: 52 },
  treble: { clef: 'treble', shift: 0, annotation: null, low: 52, high: 81 },
  treble8va: { clef: 'treble', shift: -12, annotation: '8va', low: 81, high: Infinity },
};

// What fits on each staff with four ledger lines either side, as note numbers (C-4 is 48).
const STAFF_RANGE = { treble: [45, 74], bass: [23, 53] };

// The one clef a voice is written in: the one the most of its notes fit; the rest are folded onto it.
function barClefs(notes, bars) {
  const pitched = notes.filter((n) => !n.drum).map((n) => n.note);
  const fit = (key) => {
    const [low, high] = STAFF_RANGE[CLEFS[key].clef];
    return pitched.filter((p) => p + CLEFS[key].shift >= low && p + CLEFS[key].shift <= high).length;
  };
  let best = 'treble';
  for (const key of Object.keys(CLEFS)) if (fit(key) > fit(best)) best = key;
  return new Array(bars).fill(best);
}

export class SheetView {
  constructor(canvas, chordLabel) {
    this.canvas = canvas;
    this.chordLabel = chordLabel;
    this.ctx = canvas.getContext('2d');
    this.sheet = null;
    this.voices = [];
    this.unit = 0;
    this.cache = new Map();
    this.headers = new Map();
  }

  get available() { return typeof Vex !== 'undefined'; }

  // `sheet`: { units, voices, chords }; the staves shown are the chip of `voice`.
  setData(sheet, timeline, voiceName) {
    this.sheet = sheet;
    this.timeline = timeline;
    this.voiceName = voiceName;
    this.cache.clear();
    this.headers.clear();
    this.bars = sheet ? Math.ceil(Math.max(1, ...sheet.voices.flat().map((n) => n.end)) / BAR_UNITS) : 0;
    this.clefs = sheet ? sheet.voices.map((notes) => barClefs(notes, this.bars)) : [];
    this.resize();
  }

  setVoice(voice) {
    if (!this.sheet) return;
    const chip = Math.floor(voice / 3);
    const shown = [0, 1, 2].map((i) => chip * 3 + i).filter((v) => v < this.sheet.voices.length);
    if (shown.join() !== this.voices.join()) {
      this.voices = shown;
      this.resize();
    }
    this.selected = voice;
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.parentElement.clientWidth;
    const height = this._voicesTop() + Math.max(1, this.voices.length) * STAFF_H;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    Object.assign(this, { width, height, ratio });
    this.draw();
  }

  // The chord track sits under the chord names, the voices under it.
  _voicesTop() {
    return CHORD_ROW + (this.sheet?.chords.length ? CHORD_STAFF_H : 0);
  }

  // Where the tune is, from the cycle being heard.
  setCycle(cycle) {
    const timeline = this.timeline;
    if (!timeline || !this.sheet) return;
    const call = timeline.callAt(cycle);
    let into = 0;
    if (call >= 0 && call + 1 < timeline.calls) {
      const from = timeline.cycleOf(call), to = timeline.cycleOf(call + 1);
      into = to > from ? Math.min(Math.max((cycle - from) / (to - from), 0), 1) : 0;
    }
    this.unit = unitAt(this.sheet.units, Math.max(0, call) + into);
  }

  draw() {
    const { ctx, width, height } = this;
    if (!width) return;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.fillStyle = palette.panel;
    ctx.fillRect(0, 0, width, height);
    if (!this.sheet || !this.available) {
      ctx.fillStyle = palette.subtitle;
      ctx.font = `12px ${MONO}`;
      ctx.fillText(this.available ? 'No notes to write out.' : 'The notation library did not load.', 16, 24);
      return;
    }

    const headX = HEADER + (width - HEADER) * PLAYHEAD;
    const x = (unit) => headX + (unit - this.unit) * UNIT_W;
    const firstBar = Math.max(0, Math.floor((this.unit - (headX - HEADER) / UNIT_W) / BAR_UNITS));
    const lastBar = Math.min(this.bars - 1, Math.floor((this.unit + (width - headX) / UNIT_W) / BAR_UNITS));

    // The bars, each engraved once and kept.
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER, 0, width - HEADER, height);
    ctx.clip();
    const voicesTop = this._voicesTop();
    const firstBarShown = Math.max(0, Math.floor((this.unit - (headX - HEADER) / UNIT_W + PAD / UNIT_W) / BAR_UNITS));
    if (this.sheet.chords.length) {
      for (let bar = firstBar; bar <= lastBar; bar++) {
        const image = this._chordBar(bar);
        if (image) ctx.drawImage(image, x(bar * BAR_UNITS) - PAD, CHORD_ROW, BAR_W, CHORD_STAFF_H);
      }
    }
    this.voices.forEach((v, row) => {
      const top = voicesTop + row * STAFF_H;
      for (let bar = firstBar; bar <= lastBar; bar++) {
        const image = this._bar(v, bar);
        if (image) ctx.drawImage(image, x(bar * BAR_UNITS) - PAD, top, BAR_W, STAFF_H);
      }
    });

    // Chords and bar numbers along the top.
    ctx.font = `bold 13px ${MONO}`;
    ctx.textBaseline = 'middle';
    // A name that would run into the one before drops to a second line.
    const lineEnds = [-Infinity, -Infinity];
    for (const chord of this.sheet.chords) {
      if (chord.end < this.unit - 60 || chord.start > this.unit + 80) continue;
      const cx = x(chord.start);
      const now = chord.start <= this.unit && this.unit < chord.end;
      const level = cx >= lineEnds[0] + 6 ? 0 : 1;
      ctx.font = `bold ${level === 0 ? 13 : 11}px ${MONO}`;
      ctx.fillStyle = now ? palette.accent : level === 0 ? palette.control : withAlpha(palette.control, 190);
      ctx.fillText(chord.name, cx, level === 0 ? 9 : 22);
      lineEnds[level] = cx + ctx.measureText(chord.name).width;
    }
    ctx.font = `bold 13px ${MONO}`;
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = palette.subtitle;
    for (let bar = firstBar; bar <= lastBar; bar++) ctx.fillText(String(bar + 1), x(bar * BAR_UNITS) - PAD + 2, CHORD_ROW + 8);
    ctx.restore();

    // The playhead, and each staff's clef and name at the left.
    ctx.fillStyle = withAlpha(palette.accent, 200);
    ctx.fillRect(Math.round(headX), 4, 1.5, height - 8);
    ctx.fillStyle = palette.panel;
    ctx.fillRect(0, 0, HEADER, height);
    if (this.sheet.chords.length) {
      ctx.drawImage(this._chordHeader(), 0, CHORD_ROW, HEADER, CHORD_STAFF_H);
      ctx.font = `bold 10px ${MONO}`;
      ctx.fillStyle = palette.accent;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('CHORDS', 6, CHORD_ROW + 12);
    }
    this.voices.forEach((v, row) => {
      const top = voicesTop + row * STAFF_H;
      // The clef of the bar at the left edge, where the staff starts.
      const bar = Math.min(this.bars - 1, firstBarShown);
      const header = this._header(this.clefs[v][bar] ?? 'treble');
      if (header) ctx.drawImage(header, 0, top, HEADER, STAFF_H);
      ctx.font = `bold 10px ${MONO}`;
      ctx.fillStyle = voiceColour(v, v === this.selected ? 255 : 150);
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(this.voiceName(v), 6, top + 12);
    });

    const current = this.sheet.chords.find((c) => c.start <= this.unit && this.unit < c.end);
    const label = current ? current.name : '–';
    if (this.chordLabel.textContent !== label) this.chordLabel.textContent = label;
  }

  _canvas(width, height = STAFF_H) {
    const canvas = document.createElement('canvas');
    const renderer = new Vex.Flow.Renderer(canvas, Vex.Flow.Renderer.Backends.CANVAS);
    renderer.resize(width, height);
    return { canvas, context: renderer.getContext() };
  }

  _header(key) {
    if (this.headers.has(key)) return this.headers.get(key);
    const VF = Vex.Flow;
    const { canvas, context } = this._canvas(HEADER);
    const { clef, annotation } = CLEFS[key];
    context.setFillStyle(withAlpha(palette.subtitle, 255));
    context.setStrokeStyle(withAlpha(palette.subtitle, 255));
    const stave = new VF.Stave(0, STAFF_TOP, HEADER, { left_bar: false });
    stave.setBegBarType(VF.Barline.type.NONE).setEndBarType(VF.Barline.type.NONE);
    stave.addClef(clef, 'default', annotation ?? undefined);
    stave.setContext(context).draw();
    this.headers.set(key, canvas);
    return canvas;
  }

  // The grand staff the chords are written on: treble and bass, braced.
  _chordHeader() {
    if (this.headers.has('chords')) return this.headers.get('chords');
    const VF = Vex.Flow;
    const { canvas, context } = this._canvas(HEADER, CHORD_STAFF_H);
    context.setFillStyle(palette.subtitle);
    context.setStrokeStyle(palette.subtitle);
    const treble = new VF.Stave(14, STAFF_TOP, HEADER - 14).addClef('treble');
    const bass = new VF.Stave(14, BASS_TOP, HEADER - 14).addClef('bass');
    for (const stave of [treble, bass]) stave.setBegBarType(VF.Barline.type.NONE).setEndBarType(VF.Barline.type.NONE).setContext(context).draw();
    new VF.StaveConnector(treble, bass).setType('brace').setContext(context).draw();
    this.headers.set('chords', canvas);
    return canvas;
  }

  // One bar of the chord track: each chord as voiced, notes from C-4 up on the treble staff and
  // the rest on the bass, held for as long as the chord lasts and tied over bar lines.
  _chordBar(bar) {
    const key = `chords:${bar}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const VF = Vex.Flow;
    const ink = palette.accent;
    const { canvas, context } = this._canvas(BAR_W, CHORD_STAFF_H);
    const from = bar * BAR_UNITS, to = from + BAR_UNITS;

    context.setFillStyle(withAlpha(palette.subtitle, 160));
    context.setStrokeStyle(withAlpha(palette.subtitle, 160));
    const staves = {
      treble: new VF.Stave(0, STAFF_TOP, BAR_W).setBegBarType(VF.Barline.type.NONE),
      bass: new VF.Stave(0, BASS_TOP, BAR_W).setBegBarType(VF.Barline.type.NONE),
    };
    for (const stave of Object.values(staves)) stave.setContext(context).draw();

    const pieces = [];
    let at = from;
    for (const chord of this.sheet.chords) {
      if (chord.end <= from || chord.start >= to || chord.pitches.length === 0) continue;
      const start = Math.max(chord.start, from), end = Math.min(chord.end, to);
      if (start > at) pieces.push({ start: at, end: start });
      pieces.push({ start, end, chord, tieIn: chord.start < from, tieOut: chord.end > to });
      at = end;
    }
    if (at < to) pieces.push({ start: at, end: to });

    try {
      for (const clef of ['treble', 'bass']) {
        const stave = staves[clef];
        const [lowest, highest] = STAFF_RANGE[clef];
        const tickables = [], ties = [];
        const sharps = new Map();
        for (const piece of pieces) {
          // This staff's share of the chord, folded by octaves onto it where it reaches past the ledger lines.
          let pitches = [];
          if (piece.chord) {
            const share = piece.chord.pitches.filter((p) => (clef === 'treble' ? p >= 48 : p < 48));
            pitches = [...new Set(share.map((p) => {
              while (p > highest) p -= 12;
              while (p < lowest) p += 12;
              return p;
            }))].sort((a, b) => a - b);
          }
          const parts = split(piece.start - from, piece.end - piece.start);
          let previous = null;
          parts.forEach((part, i) => {
            const duration = part.duration.replace('d', '');
            let note;
            if (pitches.length === 0) {
              note = new VF.StaveNote({ keys: [clef === 'bass' ? 'd/3' : 'b/4'], duration: `${duration}r`, clef });
            } else {
              const keys = pitches.map((p) => {
                const name = PITCH_NAMES[((p % 12) + 12) % 12];
                return `${name[0].toLowerCase()}${name[1] ?? ''}/${Math.floor(p / 12)}`;
              });
              note = new VF.StaveNote({ keys, duration, clef, auto_stem: true });
              if (i === 0 && !piece.tieIn) {
                pitches.forEach((p, index) => {
                  const name = PITCH_NAMES[((p % 12) + 12) % 12];
                  const line = `${name[0]}/${Math.floor(p / 12)}`;
                  const sharp = name.length > 1;
                  if (sharp && !sharps.get(line)) note.addModifier(new VF.Accidental('#'), index);
                  if (!sharp && sharps.get(line)) note.addModifier(new VF.Accidental('n'), index);
                  sharps.set(line, sharp);
                });
              }
              const all = pitches.map((_, index) => index);
              if (previous) ties.push([previous, note, all]);
              if (i === 0 && piece.tieIn) ties.push([null, note, all]);
              if (i === parts.length - 1 && piece.tieOut) ties.push([note, null, all]);
              previous = note;
            }
            if (part.duration.endsWith('d')) VF.Dot.buildAndAttach([note], { all: true });
            note.setStyle({ fillStyle: ink, strokeStyle: ink });
            note.__units = part.position;
            tickables.push(note);
            if (pitches.length === 0) previous = null;
          });
        }

        const voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT).addTickables(tickables);
        new VF.Formatter().joinVoices([voice]).format([voice], BAR_W - PAD);
        for (const note of tickables) note.getTickContext().setX(note.__units * UNIT_W + PAD - stave.getNoteStartX());
        context.setFillStyle(ink);
        context.setStrokeStyle(ink);
        voice.draw(context, stave);
        for (const [first, last, indices] of ties) {
          new VF.StaveTie({ first_note: first, last_note: last, first_indices: indices, last_indices: indices }).setContext(context).draw();
        }
      }
    } catch (error) {
      console.warn(`Bar ${bar + 1} of the chords could not be engraved:`, error);
    }

    this.cache.set(key, canvas);
    return canvas;
  }

  // One bar of one voice, engraved: notes and rests, ties across the bar line, beams, accidentals.
  _bar(v, bar) {
    const key = `${v}:${bar}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const VF = Vex.Flow;
    const colour = voiceColour(v);
    const { canvas, context } = this._canvas(BAR_W);
    const clefKey = this.clefs[v][bar];
    const { clef, shift, annotation } = CLEFS[clefKey];
    const from = bar * BAR_UNITS, to = from + BAR_UNITS;

    context.setFillStyle(withAlpha(palette.subtitle, 160));
    context.setStrokeStyle(withAlpha(palette.subtitle, 160));
    const stave = new VF.Stave(0, STAFF_TOP, BAR_W);
    stave.setBegBarType(VF.Barline.type.NONE);
    // A small clef where the clef changes from the bar before.
    if (bar > 0 && this.clefs[v][bar - 1] !== clefKey) stave.addClef(clef, 'small', annotation ?? undefined);
    stave.setContext(context).draw();

    // The bar as pieces: notes cut at the bar lines, and rests in the gaps.
    const pieces = [];
    let at = from;
    for (const n of this.sheet.voices[v]) {
      // A drum is a hit: one sixteenth, the rest of its length silence.
      const stop = n.drum ? n.start + 1 : n.end;
      if (stop <= from || n.start >= to) continue;
      const start = Math.max(n.start, from), end = Math.min(stop, to);
      if (start > at) pieces.push({ start: at, end: start, rest: true });
      pieces.push({ start, end, note: n, tieIn: n.start < from, tieOut: stop > to });
      at = end;
    }
    if (at < to) pieces.push({ start: at, end: to, rest: true });

    const tickables = [], ties = [];
    const sharps = new Map();
    const restKey = clef === 'bass' ? 'd/3' : 'b/4';
    let folded = false;
    for (const piece of pieces) {
      const parts = split(piece.start - from, piece.end - piece.start);
      let previous = null;
      parts.forEach((part, i) => {
        let staveNote;
        if (piece.rest) {
          staveNote = new VF.StaveNote({ keys: [restKey], duration: `${part.duration.replace('d', '')}r`, clef });
        } else if (piece.note.drum) {
          staveNote = new VF.StaveNote({ keys: [`${clef === 'bass' ? 'b/3' : 'g/5'}/x2`], duration: part.duration.replace('d', ''), clef, stem_direction: 1 });
        } else {
          // A note beyond the ledger lines is folded by octaves onto the staff, and drawn dimmer.
          const [lowest, highest] = STAFF_RANGE[clef];
          let pitch = piece.note.note + shift;
          while (pitch > highest) pitch -= 12;
          while (pitch < lowest) pitch += 12;
          folded = pitch !== piece.note.note + shift;
          const name = PITCH_NAMES[((pitch % 12) + 12) % 12];
          const octave = Math.floor(pitch / 12);
          const letter = `${name[0].toLowerCase()}/${octave}`;
          staveNote = new VF.StaveNote({ keys: [`${name[0].toLowerCase()}${name[1] ?? ''}/${octave}`], duration: part.duration.replace('d', ''), clef, auto_stem: true });
          // A sharp once a bar; a natural where the line was sharpened earlier in the bar.
          const sharp = name.length > 1;
          if (i === 0 && !piece.tieIn) {
            if (sharp && !sharps.get(letter)) staveNote.addModifier(new VF.Accidental('#'), 0);
            if (!sharp && sharps.get(letter)) staveNote.addModifier(new VF.Accidental('n'), 0);
            sharps.set(letter, sharp);
          }
        }
        if (part.duration.endsWith('d')) VF.Dot.buildAndAttach([staveNote], { all: true });
        const ink = !piece.rest && folded ? voiceColour(v, 130) : colour;
        folded = false;
        staveNote.setStyle({ fillStyle: ink, strokeStyle: ink });
        staveNote.setLedgerLineStyle?.({ strokeStyle: withAlpha(palette.subtitle, 160) });
        staveNote.__units = part.position;
        tickables.push(staveNote);
        if (!piece.rest && !piece.note.drum) {
          if (previous) ties.push([previous, staveNote]);
          if (i === 0 && piece.tieIn) ties.push([null, staveNote]);
          if (i === parts.length - 1 && piece.tieOut) ties.push([staveNote, null]);
        }
        previous = staveNote;
      });
    }

    try {
      const voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT).addTickables(tickables);
      const formatter = new VF.Formatter().joinVoices([voice]);
      formatter.format([voice], BAR_W - PAD);
      // In proportion to time: each tick context where its sixteenth falls.
      for (const note of tickables) note.getTickContext().setX(note.__units * UNIT_W + PAD - stave.getNoteStartX());
      // Beams by the beat, broken by rests.
      const beams = VF.Beam.generateBeams(tickables, { beam_rests: false, maintain_stem_directions: false });
      context.setFillStyle(colour);
      context.setStrokeStyle(colour);
      voice.draw(context, stave);
      for (const beam of beams) beam.setStyle({ fillStyle: colour, strokeStyle: colour }).setContext(context).draw();
      for (const [first, last] of ties) {
        new VF.StaveTie({ first_note: first, last_note: last, first_indices: [0], last_indices: [0] }).setContext(context).draw();
      }
    } catch (error) {
      console.warn(`Bar ${bar + 1} of voice ${v + 1} could not be engraved:`, error);
    }

    this.cache.set(key, canvas);
    return canvas;
  }
}
