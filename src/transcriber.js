// A recording turned into a score that plays it back losslessly: the music, and a raw layer with
// whatever the music gets wrong, call by call.
// Port of MagPlay.Transcribe (Transcriber, Agreement) from MagPlaySID by Magnar Harestad (GPL v2+).

import { Score } from './score.js';
import { Machines } from './c64.js';
import { ScorePlayer, scoreRegisters, usedBits } from './scoreplayer.js';
import { ScoreTimeline } from './timeline.js';
import { musicOf } from './music.js';

const CALL_JITTER = 64;

// The values a register takes in `writes`, a write that changes nothing left out; from `from`.
function valuesFrom(writes, register, from) {
  const used = usedBits(register);
  const values = [];
  let state = from;
  for (const w of writes) {
    if (w.register !== register) continue;
    const value = w.value & used;
    if (value !== state) values.push(value);
    state = value;
  }
  return { values, end: state };
}

const sameValues = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The score's calls on the recording's: evenly spaced within the jitter, or listed one by one.
function time(score, recording) {
  const calls = recording.calls;
  score.callCycles = null;
  if (calls.length === 0) {
    score.cyclesPerCall = Machines.cyclesPerFrame(recording.machine);
    score.firstCall = recording.end + 1;
    return true;
  }
  score.firstCall = calls[0];
  if (calls.length === 1) {
    score.cyclesPerCall = Machines.cyclesPerFrame(recording.machine);
    return true;
  }
  const gaps = [];
  for (let i = 1; i < calls.length; i++) gaps.push(calls[i] - calls[i - 1]);
  gaps.sort((a, b) => a - b);
  const period = Math.max(1, gaps[gaps.length >> 1]);
  score.cyclesPerCall = Math.min(2147483647, period);
  let even = true;
  for (let i = 0; i < calls.length && even; i++) if (Math.abs(calls[i] - (calls[0] + i * period)) > CALL_JITTER) even = false;
  if (!even) score.callCycles = [...calls];
  return even;
}

// The recording as a score: `music` timed and with its raw layer filled in, or all raw.
export function transcribe(recording, music = null) {
  const score = music ?? new Score();
  score.machine = recording.machine;
  score.chips = recording.chips;
  score.modeVolume = null;
  score.raw.between = [];
  score.raw.calls = new Map();
  const even = time(score, recording);
  score.raw.between.push(...recording.between);

  const player = new ScorePlayer(score);
  const registers = scoreRegisters(score.chips);
  const tuneState = new Int32Array(0x20 * score.chips);
  const scoreState = new Int32Array(0x20 * score.chips);
  let changes = 0, musicChanges = 0, detail = 0;
  const missed = new Int32Array(0x20 * score.chips);

  for (let call = 0; call < recording.calls.length; call++) {
    const tune = recording.callWrites[call];
    const at = player.cycle;
    player.call((number, writes) => {
      const replaced = new Set();
      for (const register of registers) {
        const tuneFrom = tuneState[register], scoreFrom = scoreState[register];
        const wanted = valuesFrom(tune, register, tuneFrom);
        tuneState[register] = wanted.end;
        const made = valuesFrom(writes, register, scoreFrom);
        const tuneTo = wanted.values.length > 0 ? wanted.values[wanted.values.length - 1] : tuneFrom;
        const scoreTo = made.values.length > 0 ? made.values[made.values.length - 1] : scoreFrom;
        if (tuneTo !== tuneFrom || scoreTo !== scoreFrom) {
          changes++;
          if (tuneTo === scoreTo) musicChanges++;
          else missed[register]++;
        }
        if (sameValues(made.values, wanted.values)) continue;
        replaced.add(register);
        if (tuneTo === scoreTo) detail++;
      }
      if (replaced.size === 0) return null;
      const raw = {
        registers: replaced,
        writes: tune.filter((w) => replaced.has(w.register)).map((w) => ({ offset: w.cycle - at, register: w.register, value: w.value })),
      };
      score.raw.calls.set(number, raw);
      return raw;
    });

    for (const register of registers) scoreState[register] = valuesFrom(player.callWrites, register, scoreState[register]).end;
  }

  const report = {
    calls: recording.calls.length, changes, musicChanges, detail, between: recording.between.length, evenCalls: even, missedByRegister: missed,
    get music() { return changes === 0 ? 0 : musicChanges / changes; },
  };
  return { score, report };
}

// A recording transcribed for the view: the score, its timeline and the report.
export function transcription(recording) {
  const { score, report } = transcribe(recording, musicOf(recording));
  const timeline = ScoreTimeline.of(score, Math.max(1, recording.calls.length));
  return { score, timeline, report };
}

// How far a score's writes are a recording's, measured by playing the score.
export function agreement(recording, score) {
  const player = new ScorePlayer(score);
  const between = [...player.init];
  const tuneState = new Int32Array(0x20 * score.chips);
  const scoreState = new Int32Array(0x20 * score.chips);
  let groups = 0, same = 0;
  for (let call = 0; call < recording.calls.length || player.cycle <= recording.end; call++) {
    player.call();
    between.push(...player.betweenWrites);
    if (call >= recording.calls.length) continue;
    for (const register of scoreRegisters(score.chips)) {
      const tune = valuesFrom(recording.callWrites[call], register, tuneState[register]);
      const played = valuesFrom(player.callWrites, register, scoreState[register]);
      tuneState[register] = tune.end;
      scoreState[register] = played.end;
      if (tune.values.length === 0 && played.values.length === 0) continue;
      groups++;
      if (sameValues(tune.values, played.values)) same++;
    }
  }
  const kept = between.filter((w) => w.cycle <= recording.end);
  const key = (w) => `${w.cycle}:${w.register}:${w.value}`;
  const exactBetween = kept.length === recording.between.length && kept.every((w, i) => key(w) === key(recording.between[i]));
  return { callGroups: groups, callGroupsSame: same, between: recording.between.length, betweenExact: exactBetween, exact: groups === same && exactBetween };
}
