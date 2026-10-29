// Each voice's rows scrolling past the line where they sound, placed by when they play.

import { palette, voiceColour, withAlpha, MONO } from './palette.js';
import { rowText, entryText, isEmptyRow, voiceName } from './format.js';
import { HOLD_ROW } from '../score.js';

const ROW_HEIGHT = 17;
const FONT_SIZE = 13;
const HEADER_HEIGHT = 26;
const GAP = 14;

export class TrackerView {
  constructor(canvas, { onSelect }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.score = null;
    this.timeline = null;
    this.call = 0;
    this.selected = 0;
    this.muted = new Set();
    this.onSelect = onSelect;
    this.measure();
    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      for (let v = 0; v < this.voices; v++) {
        const left = v * (this.voiceWidth + GAP);
        if (x >= left && x < left + this.voiceWidth) this.select(v);
      }
    });
  }

  // The column width follows the font, so it is measured again once the web font has loaded.
  measure() {
    this.ctx.font = `${FONT_SIZE}px ${MONO}`;
    this.charWidth = this.ctx.measureText('0').width;
  }

  get voices() { return this.score?.voices.length ?? 3; }
  get voiceChars() { return this.voices <= 3 ? 26 : this.voices <= 6 ? 18 : 15; }
  get voiceWidth() { return this.voiceChars * this.charWidth; }
  get contentWidth() { return this.voices * this.voiceWidth + (this.voices - 1) * GAP; }

  setMuted(muted) {
    this.muted = muted;
    this.draw();
  }

  select(voice) {
    this.selected = Math.min(Math.max(voice, 0), this.voices - 1);
    this.onSelect?.(this.selected);
    this.draw();
  }

  setScore(score, timeline) {
    this.score = score;
    this.timeline = timeline;
    this.selected = Math.min(this.selected, this.voices - 1);
    this.resize();
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.ceil(this.contentWidth);
    const height = this.canvas.parentElement.clientHeight;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.draw();
  }

  // The call sounding at `cycle`, with the fraction to the next so the rows scroll smoothly.
  setCycle(cycle) {
    const timeline = this.timeline;
    if (!timeline) return;
    const call = timeline.callAt(cycle);
    let into = 0;
    if (call >= 0 && call + 1 < timeline.calls) {
      const from = timeline.cycleOf(call), to = timeline.cycleOf(call + 1);
      into = to > from ? Math.min(Math.max((cycle - from) / (to - from), 0), 1) : 0;
    }
    this.call = call + into;
  }

  _text(text, x, y, ink, bold = false) {
    const ctx = this.ctx;
    ctx.font = `${bold ? 'bold ' : ''}${FONT_SIZE}px ${MONO}`;
    ctx.fillStyle = ink;
    ctx.fillText(text, x, y + FONT_SIZE - 1);
  }

  draw() {
    const { ctx, width, height, score, timeline } = this;
    if (!width) return;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.fillStyle = palette.panel;
    ctx.fillRect(0, 0, width, height);
    if (!score || !timeline) return;

    const line = HEADER_HEIGHT + Math.round((height - HEADER_HEIGHT) / 3);
    // Spaced by the shorter of a funk pair, so its short rows are tall enough to read.
    const perCall = ROW_HEIGHT / Math.max(1, score.funkTempo != null ? Math.min(score.tempo, score.funkTempo) : score.tempo);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEADER_HEIGHT, width, height - HEADER_HEIGHT);
    ctx.clip();
    ctx.fillStyle = withAlpha(palette.title, 18);
    ctx.fillRect(0, line, width, ROW_HEIGHT);
    for (let v = 0; v < this.voices; v++) {
      ctx.globalAlpha = this.muted.has(v) ? 0.35 : 1;
      this._drawVoice(v, v * (this.voiceWidth + GAP), line, perCall);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    for (let v = 0; v < this.voices; v++) {
      const left = v * (this.voiceWidth + GAP);
      const selected = v === this.selected;
      const off = this.muted.has(v);
      this._text(`${voiceName(v, this.voices)}${off ? ' · off' : ''}`, left + 4, 5, voiceColour(v, off ? 90 : selected ? 255 : 140), true);
      if (selected) {
        ctx.fillStyle = voiceColour(v);
        ctx.fillRect(left, HEADER_HEIGHT - 3, this.voiceWidth, 2);
      }
    }
  }

  _drawVoice(v, left, line, perCall) {
    const { ctx, score, timeline, height } = this;
    const rows = timeline.rows[v];
    if (rows.length === 0) return;

    const now = Math.max(0, timeline.rowAt(v, Math.floor(this.call)));
    const y = (i) => line + (rows[i].call - this.call) * perCall;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left - 6, HEADER_HEIGHT, this.voiceWidth + 6, height - HEADER_HEIGHT);
    ctx.clip();

    // A row too close to the one before it, split off its grid row, is marked instead of written.
    let first = now;
    while (first > 0 && y(first - 1) > HEADER_HEIGHT - ROW_HEIGHT) first--;
    let last = -Infinity;
    for (let i = first; i < rows.length && y(i) < height; i++) {
      const top = y(i);
      const played = rows[i];
      if (played.row === 0 && top > HEADER_HEIGHT) {
        ctx.fillStyle = voiceColour(v, 70);
        ctx.fillRect(left, top - 1, this.voiceWidth, 1);
      }
      if (top - last < ROW_HEIGHT * 0.75) {
        ctx.fillStyle = voiceColour(v, 120);
        ctx.fillRect(left - 5, top, 3, 2);
        continue;
      }
      last = top;

      const row = score.patternNumber(played.pattern)?.rows[played.row] ?? HOLD_ROW;
      const sounding = i === now;
      const ink = sounding ? palette.title : isEmptyRow(row) ? withAlpha(palette.subtitle, 110) : voiceColour(v, 220);
      // The row cut to its column, and the pattern's name beside it only where both fit.
      const room = this.voiceChars - 1;
      let text = rowText(row, played).trimEnd();
      if (text.length > room) text = `${text.slice(0, room - 1)}…`;
      this._text(text, left + 4, top + 1, ink, sounding);
      if (played.row === 0) {
        const entry = entryText(played);
        if (text.length + 1 + entry.length <= room) this._text(entry, left + 4 + (room - entry.length) * this.charWidth, top + 1, voiceColour(v, 150));
      }
    }
    ctx.restore();
  }
}
