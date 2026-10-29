// Chord naming checks, then the notes and chords of a tune: node tools/chords.mjs [tune.sid]
import { readFileSync } from 'node:fs';
import { nameChord, voiceNotes, detectChords, PITCH_NAMES } from '../src/notation.js';
import { SidFile } from '../src/sidfile.js';
import { record } from '../src/recording.js';
import { transcription } from '../src/transcriber.js';
import { framesOf } from '../src/music.js';

const w = (pcs, bass) => { const a = new Array(12).fill(0); for (const p of pcs) a[p] += 4; return nameChord(a, bass); };
const checks = [
  [[0, 4, 7], 0, 'C'], [[9, 0, 4], 9, 'Am'], [[7, 11, 2, 5], 7, 'G7'], [[0, 4, 7], 4, 'C/E'],
  [[2, 5, 9, 0], 2, 'Dm7'], [[0, 7], 0, 'C5'], [[5, 9, 0, 4], 5, 'Fmaj7'], [[11, 2, 5], 11, 'Bdim'],
];
for (const [pcs, bass, want] of checks) {
  const got = w(pcs, bass);
  console.log(got === want ? 'ok  ' : 'FAIL', want.padEnd(6), got);
}

const f = process.argv[2];
if (f) {
  const file = SidFile.parse(readFileSync(f));
  const rec = record(file, file.startSong, 40);
  const { score, timeline } = transcription(rec);
  const { frames } = framesOf(rec);
  const voices = voiceNotes(score, timeline, frames.map((v) => v.map((fr) => fr.gate)));
  voices.forEach((notes, v) => console.log(`V${v + 1}`, notes.slice(0, 10).map((n) => `${n.start}:${n.drum ? 'x' : PITCH_NAMES[n.note % 12] + Math.floor(n.note / 12)}/${n.end - n.start}${n.arpeggio.length > 1 ? '[' + n.arpeggio.join(',') + ']' : ''}`).join(' ')));
  console.log(detectChords(voices).slice(0, 24).map((c) => `${c.start}:${c.name}`).join('  '));
}
