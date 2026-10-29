// A tune as it played on the C64: each call's start cycle and every SID write, in a call or between.
// Port of MagPlay.Transcribe/Recording.cs from MagPlaySID by Magnar Harestad (GPL v2+).

import { Machines, WriteContext } from './c64.js';
import { SidTune, measureSongLength, MAX_SECONDS } from './sidtune.js';

const BURST_GAP = 4000;
const FEWEST_CALLS = 2, MOST_CALLS = 500;
const MOST_WRITES_PER_CALL = 128;

// Where each burst of writes starts: a write after a gap of BURST_GAP cycles.
function bursts(cycles) {
  const starts = [];
  let last = null;
  for (const cycle of cycles) {
    if (last === null || cycle - last > BURST_GAP) starts.push(cycle);
    last = cycle;
  }
  return starts;
}

// A player's calls from its bursts; when the gaps are whole frames, the silent frames are calls too.
function framed(starts, frame, until) {
  const gaps = [];
  for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
  const onFrames = gaps.filter((g) => Math.abs(g - Math.round(g / frame) * frame) <= frame / 10 && g >= frame * 0.9).length;
  if (!(gaps.length > 0 && onFrames >= gaps.length * 0.9)) return starts;

  const calls = [];
  for (let i = 0; i < starts.length; i++) {
    calls.push(starts[i]);
    if (i + 1 === starts.length) {
      for (let next = starts[i] + frame; next < until; next += frame) calls.push(next);
      break;
    }
    const gap = starts[i + 1] - starts[i];
    const frames = Math.round(gap / frame);
    for (let j = 1; j < frames; j++) calls.push(starts[i] + Math.trunc((gap * j) / frames));
  }
  return calls;
}

// What the player runs from: the IRQ when its calls write at all; else the main loop or NMI
// whose bursts come at a player's rate.
function playerOf(writes, machine) {
  if (writes.some((w) => w.context === WriteContext.Call)) return WriteContext.Call;
  if (writes.length === 0) return null;

  const seconds = Math.max(1e-3, (writes[writes.length - 1].write.cycle - writes[0].write.cycle) / Machines.clockHz(machine));
  const candidates = [WriteContext.Main, WriteContext.Nmi]
    .map((context) => ({ context, cycles: writes.filter((w) => w.context === context).map((w) => w.write.cycle) }))
    .filter((c) => {
      const b = bursts(c.cycles);
      const rate = b.length / seconds;
      return b.length >= 2 && rate >= FEWEST_CALLS && rate <= MOST_CALLS && c.cycles.length <= b.length * MOST_WRITES_PER_CALL;
    });
  if (candidates.length === 0) return null;
  // Stable: of equal counts the first listed wins.
  let best = candidates[0];
  for (const c of candidates) if (c.cycles.length > best.cycles.length) best = c;
  return best.context;
}

// What a computer has played so far, up to `end` when given.
export function recordingOf(computer, player = null, end = null) {
  const chips = 1 + Math.min(2, computer.extraSidWrites.length);
  const until = Math.min(end ?? Number.MAX_SAFE_INTEGER, computer.cycle);
  let all = computer.sidWrites.map((write, i) => ({ write, context: computer.sidWriteContexts[i] }));
  for (let chip = 1; chip < chips; chip++) {
    const writes = computer.extraSidWrites[chip - 1], contexts = computer.extraSidWriteContexts[chip - 1];
    for (let i = 0; i < writes.length; i++)
      all.push({ write: { ...writes[i], register: writes[i].register + chip * 0x20 }, context: contexts[i] });
  }
  if (chips > 1) all.sort((a, b) => a.write.cycle - b.write.cycle);
  all = all.filter((w) => w.write.cycle < until);

  if (player === null) player = playerOf(all, computer.machine);
  let calls;
  if (player === WriteContext.Call || player === null) {
    calls = computer.calls.filter((c) => c < until);
  } else {
    calls = framed(bursts(all.filter((w) => w.context === player).map((w) => w.write.cycle)), Machines.cyclesPerFrame(computer.machine), until);
  }

  const callWrites = calls.map(() => []);
  const between = [];
  let call = -1;
  for (const { write, context } of all) {
    while (call + 1 < calls.length && calls[call + 1] <= write.cycle) call++;
    if (context === player && call >= 0) callWrites[call].push(write);
    else between.push(write);
  }

  return { machine: computer.machine, chips, player, calls, callWrites, between, end: until };
}

// The first `seconds` of a tune.
export function record(file, song, seconds, options = {}) {
  const tune = SidTune.load(file, song, options);
  tune.run(Math.trunc(seconds * Machines.clockHz(tune.computer.machine)));
  return recordingOf(tune.computer);
}

// A whole tune: run until it loops, keeping its player's writes, cut to the loop or `seconds`.
export function recordWhole(file, song, { seconds = 600, maxSeconds = MAX_SECONDS, ...options } = {}) {
  const player = record(file, song, Math.min(10, seconds), options).player;
  const tune = SidTune.load(file, song, options);
  tune.computer.keep = (context) => context === player;
  const length = measureSongLength(tune, maxSeconds);

  const clock = Machines.clockHz(tune.computer.machine);
  const keep = length === null ? seconds : Math.min(seconds, length.totalSeconds + 1);
  const target = Math.trunc(keep * clock);
  if (tune.computer.cycle < target) tune.run(target - tune.computer.cycle);
  return { recording: recordingOf(tune.computer, player, target), length };
}
