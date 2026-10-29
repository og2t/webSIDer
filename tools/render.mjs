// Renders a tune's first seconds to a 16-bit WAV through the JS SID: node tools/render.mjs tune.sid out.wav [seconds]
import { readFileSync, writeFileSync } from 'node:fs';
import { SidFile } from '../src/sidfile.js';
import { SidEngine } from '../src/audio/engine.js';
const [input, output, seconds = '20'] = process.argv.slice(2);
const file = SidFile.parse(readFileSync(input));
const rate = 44100;
const engine = new SidEngine(file, file.startSong, rate);
const total = Math.round(Number(seconds) * rate);
const out = new Int16Array(total);
const t0 = performance.now();
for (let at = 0; at < total; at += 128) engine.render(out, at, Math.min(128, total - at));
console.log(`${seconds}s rendered in ${(performance.now() - t0).toFixed(0)}ms`);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + total * 2, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(total * 2, 40);
writeFileSync(output, Buffer.concat([header, Buffer.from(out.buffer)]));
