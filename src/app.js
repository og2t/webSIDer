// webSIDer: drop a .sid, see it as a tracker would write it - rows, instruments, programs, filter.

import { SidFile } from './sidfile.js';
import { Score } from './score.js';
import { ScoreTimeline } from './timeline.js';
import { Machines, Machine } from './c64.js';
import { TrackerView } from './view/tracker.js';
import { PanelView } from './view/panel.js';
import { FilterGraph } from './view/filtergraph.js';
import { SheetView } from './view/sheet.js';
import { formatTime, voiceName } from './view/format.js';
import { AudioPlayer } from './audio/player.js';

const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  bytes: null,
  song: 1,
  score: null,
  timeline: null,
  globals: null,
  length: null,
  whole: false,
  request: 0,
  voice: 0,
  muted: new Set(),
};

const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
const player = new AudioPlayer();
// A handle for the console: webSIDer.player.
window.webSIDer = { player, state };
player.onFailure = (message) => setStatus(`The tune stopped: ${message}`, true);

const tracker = new TrackerView($('tracker'), {
  onSelect: (voice) => {
    state.voice = voice;
    graph.setVoice(voice);
    sheet.setVoice(voice);
    refresh();
  },
});
const panel = new PanelView($('panels'));
$('panels').addEventListener('click', (e) => {
  const card = e.target.closest('[data-voice]');
  if (card) tracker.select(Number(card.dataset.voice));
});
const sheet = new SheetView($('sheet'), $('chord-now'));
const graph = new FilterGraph($('filter-graph'), $('filter-readout'), { onSeek: (cycle) => seek(cycle) });

// The plain objects the worker sends, given the score's and timeline's methods back.
function hydrate(data) {
  const score = Object.assign(Object.create(Score.prototype), data.score);
  delete score.chips;
  const t = data.timeline;
  return { score, timeline: new ScoreTimeline(t.cycles, t.voices, t.filterSteps, t.rows) };
}

const clockHz = () => Machines.clockHz(state.score?.machine ?? Machine.Pal);

function describe(score, report) {
  const grid = score.funkTempo != null ? `${score.tempo}/${score.funkTempo}` : `${score.tempo}`;
  return `${score.instruments.length} instruments · ${score.patterns.length} patterns · rows of ${grid} calls · `
    + `the score makes ${(report.music * 100).toFixed(1)}% of the tune's register changes, the rest is written raw`;
}

worker.onmessage = (event) => {
  const { id, kind, data, message } = event.data;
  if (id !== state.request) return;
  if (kind === 'error') {
    setStatus(`Can't play this tune: ${message}`, true);
    return;
  }

  const { score, timeline } = hydrate(data);
  const first = !state.score;
  state.score = score;
  state.timeline = timeline;
  state.globals = data.globals;
  state.whole = kind === 'whole';
  state.length = data.length;
  state.voice = Math.min(state.voice, score.voices.length - 1);

  $('stage').hidden = false;
  $('drop').hidden = true;
  tracker.setScore(score, timeline);
  graph.setData({ timeline, globals: data.globals, voices: data.voices, clockHz: clockHz(), voiceName: (v) => voiceName(v, score.voices.length) });
  graph.setVoice(state.voice);
  sheet.setData(data.sheet, timeline, (v) => voiceName(v, score.voices.length));
  sheet.setVoice(state.voice);
  setStatus(state.whole ? describe(score, data.report) : `The first seconds · ${describe(score, data.report)} · the whole tune is on its way`);
  updateTransport();
  refresh();
};

function setStatus(text, error = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', error);
}

function load(bytes, name) {
  let file;
  try {
    file = SidFile.parse(bytes);
  } catch (error) {
    setStatus(error.message, true);
    return;
  }
  state.file = file;
  state.bytes = bytes;
  state.song = file.startSong;
  $('title').textContent = file.name || name;
  $('author').textContent = [file.author, file.released].filter(Boolean).join(' · ');
  const select = $('song');
  select.innerHTML = '';
  for (let s = 1; s <= file.songs; s++) select.add(new Option(`Song ${s} of ${file.songs}`, s, s === state.song, s === state.song));
  select.hidden = file.songs < 2;
  $('chip').textContent = [file.is8580 ? '8580' : '6581', file.isNtsc ? 'NTSC' : 'PAL', file.extraSids.length ? `${file.extraSids.length + 1}SID` : '', file.isRsid ? 'RSID' : 'PSID'].filter(Boolean).join(' · ');
  analyse();
}

function analyse() {
  state.request++;
  state.score = null;
  state.timeline = null;
  state.length = null;
  state.muted = new Set();
  tracker.setMuted(state.muted);
  setStatus('Running the tune on the C64…');
  worker.postMessage({ id: state.request, bytes: state.bytes.slice(), song: state.song });
  player.load(state.bytes.slice(), state.song).then(updateTransport);
}

function seek(cycle) {
  if (!state.timeline) return;
  const last = state.timeline.cycleOf(state.timeline.calls - 1);
  player.seek(Math.min(Math.max(cycle, 0), last));
  refresh();
}

function seekSeconds(delta) {
  seek(viewCycle() + delta * clockHz());
}

// The cycle the views show: past the recording's end the tune plays on in its loop, so it maps back.
function viewCycle() {
  const timeline = state.timeline;
  const cycle = player.cycle;
  const first = timeline.cycleOf(0), last = timeline.cycleOf(timeline.calls - 1);
  if (cycle <= last || !state.whole || !state.length) return Math.min(cycle, last);
  const loop = first + state.length.loopStartSeconds * clockHz();
  const end = first + state.length.totalSeconds * clockHz();
  if (end <= loop || cycle < end) return Math.min(cycle, last);
  return loop + ((cycle - end) % (end - loop));
}

// The voices of the selected voice's chip: the ones the cards and staves show.
function chipVoices() {
  const chip = Math.floor(state.voice / 3);
  return [0, 1, 2].map((i) => chip * 3 + i).filter((v) => v < state.score.voices.length);
}

// A voice turned off or on again: silenced in the mix, its rows and card dimmed.
function toggleMute(voice) {
  if (state.muted.has(voice)) state.muted.delete(voice); else state.muted.add(voice);
  player.setMuted(voice, state.muted.has(voice));
  tracker.setMuted(state.muted);
  refresh();
}

function refresh() {
  if (!state.timeline) return;
  const cycle = viewCycle();
  tracker.setCycle(cycle);
  tracker.draw();
  panel.render(state.score, state.timeline, chipVoices(), state.voice, state.muted, tracker.call);
  graph.setCycle(cycle);
  graph.draw();
  sheet.setCycle(cycle);
  sheet.draw();
  const seconds = (cycle - state.timeline.cycleOf(0)) / clockHz();
  const total = state.length ? ` / ${formatTime(state.length.totalSeconds)}` : '';
  const time = `${formatTime(seconds)}${total}`;
  if ($('time').textContent !== time) $('time').textContent = time;
}

function updateTransport() {
  $('play').textContent = player.playing ? 'Pause' : 'Play';
  $('play').setAttribute('aria-pressed', String(player.playing));
}

function frame() {
  if (state.timeline) refresh();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- input

$('open').addEventListener('click', () => $('file').click());
$('drop-open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) load(new Uint8Array(await f.arrayBuffer()), f.name);
  e.target.value = '';
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (e.target === document.documentElement || e.relatedTarget === null) document.body.classList.remove('dragging');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) load(new Uint8Array(await f.arrayBuffer()), f.name);
});

$('song').addEventListener('change', (e) => {
  state.song = Number(e.target.value);
  analyse();
});

$('play').addEventListener('click', () => {
  if (!state.bytes) return;
  (player.playing ? player.pause() : player.play()).then(updateTransport);
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
  if (e.key === ' ') {
    e.preventDefault();
    $('play').click();
  } else if (e.key === 'ArrowLeft') {
    seekSeconds(e.shiftKey ? -10 : -2);
  } else if (e.key === 'ArrowRight') {
    seekSeconds(e.shiftKey ? 10 : 2);
  } else if (/^[1-9]$/.test(e.key) && state.score && Number(e.key) <= state.score.voices.length) {
    toggleMute(Number(e.key) - 1);
  }
});

document.fonts.ready.then(() => {
  tracker.measure();
  tracker.resize();
  refresh();
});

window.addEventListener('resize', () => {
  sheet.resize();
  tracker.resize();
  graph.resize();
  refresh();
});

// A tune named in the address loads at once: ?sid=path/to/tune.sid
const named = new URLSearchParams(location.search).get('sid');
if (named) {
  fetch(named)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
    .then((buffer) => load(new Uint8Array(buffer), named.split('/').pop()))
    .catch((error) => setStatus(`Couldn't load ${named}: ${error.message}`, true));
}
