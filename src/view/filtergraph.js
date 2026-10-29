// The registers over time: the filter's cutoff and resonance as graphs, routing and mode as lanes,
// the volume as steps; the selected voice's pulse width and waveform bits; and the whole tune to seek in.

import { palette, voiceColour, withAlpha, MONO } from './palette.js';
import { hex } from './format.js';

const GUTTER = 44;
const OVERVIEW = 26;
const PLOT = 96;
const LANE = 7;
const LANE_GAP = 3;
const VOLUME = 22;
const PLAYHEAD = 0.3;

const LANES = [
  { label: 'V1', reg: 'control', bit: 0, colour: () => voiceColour(0) },
  { label: 'V2', reg: 'control', bit: 1, colour: () => voiceColour(1) },
  { label: 'V3', reg: 'control', bit: 2, colour: () => voiceColour(2) },
  { label: 'EXT', reg: 'control', bit: 3, colour: () => palette.subtitle },
  { label: 'LP', reg: 'modeVolume', bit: 4, colour: () => palette.control },
  { label: 'BP', reg: 'modeVolume', bit: 5, colour: () => palette.control },
  { label: 'HP', reg: 'modeVolume', bit: 6, colour: () => palette.control },
  { label: '3OFF', reg: 'modeVolume', bit: 7, colour: () => palette.subtitle },
];

const VOICE_LANES = [
  { label: 'TRI', bit: 4 }, { label: 'SAW', bit: 5 }, { label: 'PUL', bit: 6 }, { label: 'NOI', bit: 7 },
  { label: 'RING', bit: 2 }, { label: 'SYNC', bit: 1 }, { label: 'TEST', bit: 3 }, { label: 'GATE', bit: 0 },
];
const PULSE_PLOT = 56;
const SECTION_TITLE = 26;

export const FILTER_GRAPH_HEIGHT = OVERVIEW + 18 + PLOT + 10 + LANES.length * (LANE + LANE_GAP) + 4 + VOLUME
  + SECTION_TITLE + PULSE_PLOT + 10 + VOICE_LANES.length * (LANE + LANE_GAP) + 6;

export class FilterGraph {
  constructor(canvas, readout, { onSeek }) {
    this.canvas = canvas;
    this.readout = readout;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.chip = 0;
    this.voice = 0;
    this.cycle = 0;
    this.windowSeconds = 8;
    this.onSeek = onSeek;
    this._overview = null;

    canvas.addEventListener('wheel', (e) => {
      // A pinch arrives as ctrl+wheel; a plain wheel scrolls the page.
      if (!this.data || !(e.ctrlKey || e.metaKey || e.altKey)) return;
      e.preventDefault();
      this.windowSeconds = Math.min(120, Math.max(1, this.windowSeconds * Math.exp(e.deltaY * 0.002)));
      this.draw();
    }, { passive: false });

    let dragging = false;
    const seek = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (!this.data) return false;
      if (y <= OVERVIEW || dragging) {
        const t = Math.min(Math.max((x - GUTTER) / (this.width - GUTTER), 0), 1);
        this.onSeek?.(this._first + t * (this._last - this._first));
        return true;
      }
      return false;
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (seek(e)) {
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointermove', (e) => dragging && seek(e));
    canvas.addEventListener('pointerup', () => (dragging = false));
  }

  // `data`: { timeline, globals, voices, clockHz, voiceName }.
  setData(data) {
    this.data = data;
    this._overview = null;
    if (data) {
      this._first = data.timeline.cycleOf(0);
      this._last = data.timeline.cycleOf(data.timeline.calls - 1);
    }
    this.resize();
  }

  setVoice(voice) {
    const chip = Math.floor(voice / 3);
    if (chip !== this.chip) this._overview = null;
    this.chip = chip;
    this.voice = voice;
    this.draw();
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.parentElement.clientWidth;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${FILTER_GRAPH_HEIGHT}px`;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(FILTER_GRAPH_HEIGHT * ratio);
    this.width = width;
    this.height = FILTER_GRAPH_HEIGHT;
    this.ratio = ratio;
    this._overview = null;
    this.draw();
  }

  setCycle(cycle) {
    this.cycle = cycle;
  }

  draw() {
    const { ctx, width, height, data } = this;
    if (!width) return;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.fillStyle = palette.panel;
    ctx.fillRect(0, 0, width, height);
    if (!data) return;

    const g = data.globals[Math.min(this.chip, data.globals.length - 1)];
    const timeline = data.timeline;
    const plotWidth = width - GUTTER;
    const pxPerCycle = plotWidth / (this.windowSeconds * data.clockHz);
    const headX = GUTTER + plotWidth * PLAYHEAD;
    const x = (cycle) => headX + (cycle - this.cycle) * pxPerCycle;
    const fromCycle = this.cycle - (headX - GUTTER) / pxPerCycle;
    const toCycle = this.cycle + (width - headX) / pxPerCycle;
    const firstCall = Math.max(0, timeline.callAt(fromCycle));
    const lastCall = Math.min(timeline.calls - 1, timeline.callAt(toCycle) + 1);
    const endX = (c) => (c + 1 < timeline.calls ? x(timeline.cycleOf(c + 1)) : x(timeline.cycleOf(c)) + 2);

    this._drawOverview(g, plotWidth);

    ctx.font = `10px ${MONO}`;
    ctx.textBaseline = 'middle';
    let top = OVERVIEW + 18;

    // Cutoff, 0 to $7FF, filled; resonance, 0 to 15, as steps over it.
    const plotTop = top, plotBottom = top + PLOT;
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const yy = Math.round(plotBottom - f * PLOT) + 0.5;
      ctx.beginPath();
      ctx.moveTo(GUTTER, yy);
      ctx.lineTo(width, yy);
      ctx.stroke();
    }
    ctx.fillStyle = palette.subtitle;
    ctx.fillText('CUT', 6, plotTop + 8);
    ctx.fillText('7FF', 6, plotTop + 22);
    ctx.fillStyle = palette.resonance;
    ctx.fillText('RES', 6, plotBottom - 8);

    if (lastCall >= firstCall) {
      const cy = (v) => plotBottom - (v / 0x7ff) * PLOT;
      ctx.beginPath();
      ctx.moveTo(Math.max(GUTTER, x(timeline.cycleOf(firstCall))), plotBottom);
      for (let c = firstCall; c <= lastCall; c++) {
        const yy = cy(g.cutoff[c]);
        ctx.lineTo(Math.max(GUTTER, x(timeline.cycleOf(c))), yy);
        ctx.lineTo(Math.max(GUTTER, endX(c)), yy);
      }
      ctx.lineTo(Math.max(GUTTER, endX(lastCall)), plotBottom);
      ctx.closePath();
      ctx.fillStyle = withAlpha(palette.title, 34);
      ctx.fill();

      ctx.beginPath();
      for (let c = firstCall; c <= lastCall; c++) {
        const yy = cy(g.cutoff[c]);
        const x0 = Math.max(GUTTER, x(timeline.cycleOf(c)));
        if (c === firstCall) ctx.moveTo(x0, yy); else ctx.lineTo(x0, yy);
        ctx.lineTo(Math.max(GUTTER, endX(c)), yy);
      }
      ctx.strokeStyle = palette.title;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      for (let c = firstCall; c <= lastCall; c++) {
        const yy = plotBottom - ((g.control[c] >> 4) / 15) * PLOT;
        const x0 = Math.max(GUTTER, x(timeline.cycleOf(c)));
        if (c === firstCall) ctx.moveTo(x0, yy); else ctx.lineTo(x0, yy);
        ctx.lineTo(Math.max(GUTTER, endX(c)), yy);
      }
      ctx.strokeStyle = withAlpha(palette.resonance, 210);
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    top = plotBottom + 10;

    // A lane a bit, filled where the bit is set.
    const lane = (label, colour, values, bit) => {
      ctx.fillStyle = withAlpha(palette.border, 160);
      ctx.fillRect(GUTTER, top, plotWidth, LANE);
      ctx.fillStyle = colour;
      ctx.fillText(label, 6, top + LANE / 2);
      let runStart = -1;
      for (let c = firstCall; c <= lastCall + 1; c++) {
        const on = c <= lastCall && ((values[c] >> bit) & 1) === 1;
        if (on && runStart < 0) runStart = c;
        if (!on && runStart >= 0) {
          const x0 = Math.max(GUTTER, x(timeline.cycleOf(runStart)));
          const x1 = Math.max(GUTTER, endX(c - 1));
          ctx.fillRect(x0, top, Math.max(1, x1 - x0), LANE);
          runStart = -1;
        }
      }
      top += LANE + LANE_GAP;
    };

    // A value held from each call to the next, as steps.
    const steps = (values, valueY) => {
      ctx.beginPath();
      for (let c = firstCall; c <= lastCall; c++) {
        const yy = valueY(values[c]);
        const x0 = Math.max(GUTTER, x(timeline.cycleOf(c)));
        if (c === firstCall) ctx.moveTo(x0, yy); else ctx.lineTo(x0, yy);
        ctx.lineTo(Math.max(GUTTER, endX(c)), yy);
      }
    };

    for (const l of LANES) lane(l.label, l.colour(), g[l.reg], l.bit);
    top += 4;

    // Volume, 0 to 15, as steps.
    ctx.fillStyle = palette.subtitle;
    ctx.fillText('VOL', 6, top + VOLUME / 2);
    ctx.fillStyle = withAlpha(palette.border, 160);
    ctx.fillRect(GUTTER, top, plotWidth, VOLUME);
    if (lastCall >= firstCall) {
      ctx.beginPath();
      for (let c = firstCall; c <= lastCall; c++) {
        const yy = top + VOLUME - ((g.modeVolume[c] & 15) / 15) * (VOLUME - 2) - 1;
        const x0 = Math.max(GUTTER, x(timeline.cycleOf(c)));
        if (c === firstCall) ctx.moveTo(x0, yy); else ctx.lineTo(x0, yy);
        ctx.lineTo(Math.max(GUTTER, endX(c)), yy);
      }
      ctx.strokeStyle = palette.control;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    top += VOLUME;

    // The selected voice: pulse width, 0 to $FFF, and its control register's bits.
    const voice = data.voices[Math.min(this.voice, data.voices.length - 1)];
    const colour = voiceColour(this.voice);
    ctx.fillStyle = palette.border;
    ctx.fillRect(0, top + 8, width, 1);
    ctx.font = `bold 11px ${MONO}`;
    ctx.fillStyle = colour;
    ctx.fillText(data.voiceName(this.voice), 6, top + 18);
    ctx.font = `10px ${MONO}`;
    top += SECTION_TITLE;
    ctx.fillStyle = withAlpha(palette.border, 160);
    ctx.fillRect(GUTTER, top, plotWidth, PULSE_PLOT);
    ctx.fillStyle = palette.subtitle;
    ctx.fillText('PW', 6, top + 8);
    ctx.fillText('FFF', 6, top + 20);
    if (lastCall >= firstCall) {
      const bottom = top + PULSE_PLOT;
      steps(voice.pulse, (v) => bottom - (v / 0xfff) * (PULSE_PLOT - 2) - 1);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    top += PULSE_PLOT + 10;
    for (const l of VOICE_LANES) lane(l.label, l.bit === 0 ? palette.control : colour, voice.control, l.bit);

    // The playhead, and the seconds either side.
    ctx.fillStyle = withAlpha(palette.title, 200);
    ctx.fillRect(Math.round(headX), OVERVIEW + 14, 1, height - OVERVIEW - 18);
    ctx.fillStyle = palette.subtitle;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${this.windowSeconds.toFixed(this.windowSeconds < 10 ? 1 : 0)} s`, width - 44, OVERVIEW + 12);

    this._readout(g, voice, Math.max(0, timeline.callAt(this.cycle)));
  }

  // The whole tune's cutoff as an envelope per column, the window and the playhead on it.
  _drawOverview(g, plotWidth) {
    const { ctx, data } = this;
    const timeline = data.timeline;
    const span = Math.max(1, this._last - this._first);
    if (!this._overview || this._overview.width !== plotWidth) {
      const lo = new Float32Array(plotWidth).fill(1), hi = new Float32Array(plotWidth).fill(-1);
      for (let c = 0; c < timeline.calls; c++) {
        const col = Math.min(plotWidth - 1, Math.floor(((timeline.cycleOf(c) - this._first) / span) * plotWidth));
        const v = g.cutoff[c] / 0x7ff;
        if (v < lo[col]) lo[col] = v;
        if (v > hi[col]) hi[col] = v;
      }
      this._overview = { width: plotWidth, lo, hi };
    }
    const { lo, hi } = this._overview;
    ctx.fillStyle = palette.background;
    ctx.fillRect(GUTTER, 2, plotWidth, OVERVIEW - 4);
    ctx.fillStyle = withAlpha(palette.title, 120);
    const h = OVERVIEW - 6;
    for (let col = 0; col < plotWidth; col++) {
      if (hi[col] < 0) continue;
      const y0 = 3 + h - hi[col] * h, y1 = 3 + h - lo[col] * h;
      ctx.fillRect(GUTTER + col, y0, 1, Math.max(1, y1 - y0));
    }
    const at = (cycle) => GUTTER + ((cycle - this._first) / span) * plotWidth;
    const windowCycles = this.windowSeconds * data.clockHz;
    const x0 = at(this.cycle - windowCycles * PLAYHEAD), x1 = at(this.cycle + windowCycles * (1 - PLAYHEAD));
    ctx.fillStyle = withAlpha(palette.title, 26);
    ctx.fillRect(Math.max(GUTTER, x0), 2, Math.min(this.width, x1) - Math.max(GUTTER, x0), OVERVIEW - 4);
    ctx.fillStyle = palette.title;
    ctx.fillRect(Math.round(at(this.cycle)), 1, 1.5, OVERVIEW - 2);
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = palette.subtitle;
    ctx.textBaseline = 'middle';
    ctx.fillText('ALL', 6, OVERVIEW / 2);
  }

  _readout(g, voice, call) {
    const control = g.control[call], mv = g.modeVolume[call];
    const routed = ['V1', 'V2', 'V3', 'EXT'].filter((_, i) => (control >> i) & 1).join(' ') || 'none';
    const modes = ['LP', 'BP', 'HP'].filter((_, i) => (mv >> (4 + i)) & 1).join('+') || 'off';
    const text = `cutoff ${hex(g.cutoff[call], 3)}  res ${(control >> 4).toString(16).toUpperCase()}  route ${routed}  mode ${modes}${mv & 0x80 ? ' 3OFF' : ''}  vol ${(mv & 15).toString(16).toUpperCase()}   ·   pulse ${hex(voice.pulse[call], 3)}  control ${hex(voice.control[call])}`;
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }
}
