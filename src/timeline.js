// A score played once, silently, keeping where it is on every call: what the view follows.
// Port of MagPlay.Score/ScoreTimeline.cs from MagPlaySID by Magnar Harestad (GPL v2+).

import { ScorePlayer } from './scoreplayer.js';

export class ScoreTimeline {
  constructor(cycles, voices, filterSteps, rows) {
    this._cycles = cycles;
    this._voices = voices;
    this._filterSteps = filterSteps;
    this.rows = rows;
  }

  get calls() { return this._cycles.length; }
  get voices() { return this._voices.length; }

  _clamp(call) { return Math.min(Math.max(call, 0), this._cycles.length - 1); }

  cycleOf(call) { return this._cycles[this._clamp(call)]; }

  // The last call made by `cycle`; -1 before the first.
  callAt(cycle) {
    let low = 0, high = this._cycles.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this._cycles[mid] <= cycle) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    return found;
  }

  positionOf(voice, call) { return this._voices[voice][this._clamp(call)]; }

  filterStepAt(call, chip = 0) { return this._filterSteps[chip][this._clamp(call)]; }

  // The index into rows[voice] playing on `call`; -1 before its first.
  rowAt(voice, call) {
    const rows = this.rows[voice];
    let low = 0, high = rows.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rows[mid].call <= call) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    return found;
  }

  static of(score, calls) {
    calls = Math.max(1, calls);
    const player = new ScorePlayer(score);
    const count = score.voices.length;
    const cycles = new Array(calls);
    const voices = Array.from({ length: count }, () => new Array(calls));
    const rows = Array.from({ length: count }, () => []);
    const filterSteps = Array.from({ length: score.chips }, () => new Int32Array(calls));

    for (let call = 0; call < calls; call++) {
      cycles[call] = player.cycle;
      player.call();
      for (let chip = 0; chip < score.chips; chip++) filterSteps[chip][call] = player.filterStepOf(chip);
      for (let v = 0; v < count; v++) {
        const position = player.positionOf(v);
        voices[v][call] = position;
        // A row's first call leaves it one call in.
        if (!position.ended && position.rowCall === 1 && position.pattern >= 0)
          rows[v].push({ call, entry: position.entry, transpose: position.transpose, pattern: position.pattern, row: position.row });
      }
    }
    return new ScoreTimeline(cycles, voices, filterSteps, rows);
  }
}
