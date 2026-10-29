import { readFileSync } from 'node:fs';
import { SidFile } from '../src/sidfile.js';
import { record, recordWhole } from '../src/recording.js';
import { transcription, agreement } from '../src/transcriber.js';
const whole = process.argv.includes('--whole');
for (const f of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const file = SidFile.parse(readFileSync(f));
  const t0 = performance.now();
  const rec = whole ? recordWhole(file, file.startSong).recording : record(file, file.startSong, 30);
  const t1 = performance.now();
  const { score, timeline, report } = transcription(rec);
  const t2 = performance.now();
  const ag = agreement(rec, score);
  const grid = score.funkTempo != null ? `${score.tempo}/${score.funkTempo}` : `${score.tempo}`;
  console.log(`${f.split('/').pop().padEnd(36)} ${score.instruments.length} instr, ${score.patterns.length} pat, grid ${grid}, music ${(report.music * 100).toFixed(1)}%, calls ${report.calls}, rec ${(t1 - t0).toFixed(0)}ms, tr ${(t2 - t1).toFixed(0)}ms, exact ${ag.exact} (${ag.callGroupsSame}/${ag.callGroups}, between ${ag.betweenExact})`);
}
