// A card per voice with its instrument, wave and pulse programs, and one for its chip's filter
// program, the step sounding lit.

import { voiceColour } from './palette.js';
import { instrumentLines, programLines, programStart, voiceName } from './format.js';

const WAVE_LINES = 8;
const PULSE_LINES = 6;
const FILTER_LINES = 12;

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class PanelView {
  constructor(element) {
    this.element = element;
    this._key = '';
  }

  // The cards for `voices` (one chip's), `selected` marked, the muted ones dimmed.
  render(score, timeline, voices, selected, muted, call) {
    if (!score || !timeline) {
      this._key = '';
      this.element.innerHTML = '';
      return;
    }
    call = Math.max(0, Math.floor(call));
    const chip = Math.min(Math.floor(voices[0] / 3), score.chips - 1);
    const filterStep = timeline.filterStepAt(call, chip);
    const positions = voices.map((v) => timeline.positionOf(v, call));
    const key = [selected, chip, filterStep, ...voices.map((v, i) => `${v}:${muted.has(v)}:${positions[i].instrument}:${positions[i].waveStep}:${positions[i].pulseStep}`)].join('|');
    if (key === this._key) return;
    this._key = key;

    const cards = voices.map((v, i) => this._voiceCard(score, v, positions[i], v === selected, muted.has(v)));
    cards.push(this._filterCard(score, chip, filterStep));
    this.element.innerHTML = cards.join('');
  }

  _voiceCard(score, voice, position, selected, muted) {
    const lines = [];
    const line = (text, cls = '') => lines.push(`<div class="line ${cls}">${escape(text)}</div>`);
    // Every card has the same lines, short programs padded, so the page below never moves.
    const program = (list, count) => {
      list.forEach((l) => line(l.text, l.lit ? 'lit' : l.none ? 'dim' : ''));
      for (let i = list.length; i < count; i++) line('');
    };

    const instrument = score.instrumentNumber(position.instrument);
    if (!instrument) {
      line('No instrument yet', 'dim');
      for (let i = 1; i < 3 + 2 + WAVE_LINES + PULSE_LINES; i++) line('');
    } else {
      const { title, envelope, restart } = instrumentLines(instrument);
      line(title, 'title');
      line(envelope);
      line(restart, 'dim');
      line('WAVE', 'heading');
      program(programLines(score.waveTable, instrument.waveProgram, position.waveStep, WAVE_LINES), WAVE_LINES);
      line('PULSE', 'heading');
      const pulse = instrument.pulseProgram >= 0 ? instrument.pulseProgram : programStart(score.pulseTable, position.pulseStep);
      program(programLines(score.pulseTable, pulse, position.pulseStep, PULSE_LINES), PULSE_LINES);
    }
    const name = voiceName(voice, score.voices.length);
    const classes = ['card', selected ? 'selected' : '', muted ? 'muted' : ''].join(' ');
    return `<section class="${classes}" style="--voice:${voiceColour(voice % 3)}" data-voice="${voice}">`
      + `<div class="card-head">${escape(name)}${muted ? ' <span class="off">off</span>' : ''}</div>${lines.join('')}</section>`;
  }

  _filterCard(score, chip, filterStep) {
    const lines = [];
    const program = score.filterPrograms[chip];
    const start = program >= 0 ? program : programStart(score.filterTable, filterStep);
    for (const l of programLines(score.filterTable, start, filterStep, FILTER_LINES))
      lines.push(`<div class="line ${l.lit ? 'lit' : l.none ? 'dim' : ''}">${escape(l.text)}</div>`);
    const title = score.chips > 1 ? `FILTER, SID${chip + 1}` : 'FILTER';
    return `<section class="card filter-card" style="--voice:var(--title)"><div class="card-head">${title}</div>${lines.join('')}</section>`;
  }
}
