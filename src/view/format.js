// How rows, program steps and instruments read, as MagPlaySID's Retro view writes them.

import { NoteTables, PitchKind, RowNoteKind, HardRestartKind, effectLabel } from '../score.js';

const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const ON_AND_ON = Math.floor(2147483647 / 4);

export const voiceName = (voice, voices) => (voices <= 3 ? `VOICE ${voice + 1}` : `SID${Math.floor(voice / 3) + 1} V${(voice % 3) + 1}`);

export function rowText(row, played) {
  const note = row.note.kind === RowNoteKind.Note ? NoteTables.name(row.note.note + played.transpose).padEnd(3)
    : row.note.kind === RowNoteKind.GateOff ? '==='
    : row.note.kind === RowNoteKind.GateOn ? '+++'
    : '...';
  const instrument = row.instrument > 0 ? hex(row.instrument) : '..';
  const effects = row.effects.map(effectLabel).join(' ');
  return `${hex(played.row)} ${note} ${instrument} ${effects}`;
}

export const entryText = (played) =>
  played.transpose === 0 ? `P${hex(played.pattern)}` : `P${hex(played.pattern)}${played.transpose > 0 ? '+' : '-'}${Math.abs(played.transpose)}`;

export const isEmptyRow = (row) => row.note.kind === RowNoteKind.Hold && row.instrument === 0 && row.effects.length === 0;

function pitch(p) {
  if (!p) return '   ';
  switch (p.kind) {
    case PitchKind.Relative: return p.value >= 0 ? `+${p.value}` : `${p.value}`;
    case PitchKind.Absolute: return NoteTables.name(p.value);
    case PitchKind.Offset: return p.value >= 0 ? `f+${p.value.toString(16).toUpperCase()}` : `f-${(-p.value).toString(16).toUpperCase()}`;
    default: return `f=${hex(p.value, 4)}`;
  }
}

const add = (a) => (a === 0 ? '' : a > 0 ? `+${a.toString(16).toUpperCase()}` : `-${(-a).toString(16).toUpperCase()}`);
const calls = (c) => (c === 1 ? '' : c >= ON_AND_ON ? '  on' : `  x${c}`);

export function describeStep(step) {
  switch (step.type) {
    case 'wave': return `${step.control != null ? hex(step.control) : '..'} ${pitch(step.pitch)}${calls(step.calls)}`;
    case 'pulse': return `${step.width != null ? `=${hex(step.width, 3)}` : step.add === 0 ? 'hold' : '    '} ${add(step.add)}${calls(step.calls)}`;
    case 'filter':
      return `${step.cutoff != null ? `=${hex(step.cutoff, 3)}` : '    '} ${add(step.add)}`
        + `${step.control != null ? ` res ${hex(step.control)}` : ''}${step.mode != null ? ` mode ${(step.mode >> 4).toString(16).toUpperCase()}` : ''}${calls(step.calls)}`;
    case 'effect': return effectLabel(step.effect);
    case 'jump': return step.to < 0 ? 'end' : `loop to ${hex(step.to)}`;
    case 'raw': return `raw, ${step.writes.length} writes${calls(step.calls)}`;
    default: return '';
  }
}

export function instrumentLines(instrument) {
  const envelope = `AD ${hex(instrument.attackDecay)}  SR ${hex(instrument.sustainRelease)}`
    + (instrument.firstControl != null ? `  first ${hex(instrument.firstControl)}` : '');
  const restart = instrument.hardRestart === HardRestartKind.Envelope && instrument.gateTimer > 0
    ? `hard restart ${hex(instrument.hardRestartEnvelope, 4)}, ${instrument.gateTimer} before`
    : instrument.hardRestart === HardRestartKind.GateOff && instrument.gateTimer > 0
      ? `gate off ${instrument.gateTimer} before`
      : 'no hard restart';
  return { title: `INSTRUMENT ${hex(instrument.number)}`, envelope, restart };
}

// Where the program a step is in starts: the step after the jump before it.
export function programStart(table, step) {
  if (step < 0) return -1;
  let start = step;
  while (start > 0 && table[start - 1].type !== 'jump') start--;
  return start;
}

// A program's steps from `start` to its end, a window of `lines` around the sounding one.
export function programLines(table, start, sounding, lines) {
  if (start < 0 || start >= table.length) return [{ text: '  none', lit: false, none: true }];
  let end = start;
  while (end < table.length - 1 && table[end].type !== 'jump') end++;
  let from = start;
  if (end - start + 1 > lines && sounding >= start && sounding <= end)
    from = Math.min(Math.max(sounding - Math.floor(lines / 3), start), end - lines + 1);
  const out = [];
  for (let step = from; step <= end && step < from + lines; step++)
    out.push({ text: `${hex(step - start)} ${describeStep(table[step])}`, lit: step === sounding });
  return out;
}

export const formatTime = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export { hex };
