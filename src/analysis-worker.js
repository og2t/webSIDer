// Runs the analysis off the page: the opening seconds first, to show at once, then the whole tune.

import { SidFile } from './sidfile.js';
import { record, recordWhole } from './recording.js';
import { transcription } from './transcriber.js';
import { globalsOf, framesOf } from './music.js';
import { voiceNotes, detectChords, unitsOf } from './notation.js';
import { SidChip, ChipModel } from './sid/sid.js';

const OPENING_SECONDS = 10;

// What the page needs: the score without its raw layer, the timeline's arrays, the filter per call.
function payload(recording, result, length = null) {
  const { score, timeline, report } = result;
  const { raw, ...rest } = score;
  return {
    score: { ...rest, chips: score.chips, voices: score.voices, filterPrograms: score.filterPrograms },
    timeline: { cycles: timeline._cycles, voices: timeline._voices, filterSteps: timeline._filterSteps, rows: timeline.rows },
    report: { calls: report.calls, music: report.music, evenCalls: report.evenCalls },
    globals: Array.from({ length: recording.chips }, (_, chip) => {
      const list = globalsOf(recording, chip);
      return {
        cutoff: Int16Array.from(list, (g) => g.cutoff),
        control: Uint8Array.from(list, (g) => g.control),
        modeVolume: Uint8Array.from(list, (g) => g.modeVolume),
      };
    }),
    voices: voiceRegisters(recording),
    sheet: sheetOf(recording, score, timeline),
    end: recording.end,
    length: length && { totalSeconds: length.totalSeconds, loopStartSeconds: length.loopStartSeconds },
  };
}

// Each voice's notes on a grid of sixteenths, and the chords they make.
function sheetOf(recording, score, timeline) {
  if (score.patterns.length === 0) return null;
  const { frames } = framesOf(recording);
  const notes = voiceNotes(score, timeline, frames.map((voice) => voice.map((f) => f.gate)));
  return { units: unitsOf(score), voices: notes, chords: detectChords(notes) };
}

// Each voice's pulse width and control register after each call.
function voiceRegisters(recording) {
  const registers = new Int32Array(0x20 * recording.chips);
  const calls = recording.calls.length;
  const voices = Array.from({ length: 3 * recording.chips }, () => ({ pulse: new Uint16Array(calls), control: new Uint8Array(calls) }));
  for (let c = 0; c < calls; c++) {
    for (const w of recording.callWrites[c]) registers[w.register] = w.value;
    voices.forEach((voice, v) => {
      const b = (v / 3 | 0) * 0x20 + (v % 3) * 7;
      voice.pulse[c] = registers[b + 2] | ((registers[b + 3] & 0x0f) << 8);
      voice.control[c] = registers[b + 4];
    });
  }
  return voices;
}

// The chip a tune that reads voice 3's oscillator or envelope is answered from.
const sidModel = (file) => () => {
  const chip = new SidChip();
  chip.setChipModel(file.is8580 ? ChipModel.Mos8580 : ChipModel.Mos6581);
  return { clock: (cycles) => chip.clockOscillators(cycles), write: (r, v) => chip.write(r, v), read: (r) => chip.read(r) };
};

self.onmessage = (event) => {
  const { id, bytes, song } = event.data;
  try {
    const file = SidFile.parse(bytes);
    const options = { sidModel: sidModel(file) };
    const opening = record(file, song, OPENING_SECONDS, options);
    self.postMessage({ id, kind: 'opening', data: payload(opening, transcription(opening)) });
    const { recording, length } = recordWhole(file, song, options);
    self.postMessage({ id, kind: 'whole', data: payload(recording, transcription(recording), length) });
  } catch (error) {
    self.postMessage({ id, kind: 'error', message: error.message });
  }
};
