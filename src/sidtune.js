// A .sid loaded into a C64 behind a small driver, and how long it plays before it loops.
// Port of MagPlay.C64/SidTune.cs and C64SongLength.cs from MagPlaySID by Magnar Harestad (GPL v2+).

import { C64, Machine, Machines } from './c64.js';
import { SidPlaybackError } from './sidfile.js';

const DRIVER_LENGTH = 0x80;

// The KERNAL's CIA 1 timer: 60 interrupts a second on either machine.
export const kernalTimer = (machine) => (machine === Machine.Ntsc ? 0x4295 : 0x4025);

// Why a tune cannot be started here; null when it can.
export function unsupported(file) {
  if (file.isBasic) return 'This RSID is a BASIC program, and there is no BASIC interpreter here to RUN it.';
  if (file.loadAddress + file.data.length > 0x10000) return "The tune's data would run past the end of memory.";
  if (file.loadAddress < 0x0200) return 'The tune loads over the zero page and the stack.';
  return null;
}

// A page the tune leaves alone: the header's offer, or the first free page from $0400 past BASIC's.
function driverAddress(file) {
  const start = file.loadAddress, end = file.loadAddress + file.data.length;
  const free = (at) => at + DRIVER_LENGTH <= start || at >= end;
  if (file.freePage >= 0x04 && file.freePage < 0xd0 && file.freePages > 0 && free(file.freePage << 8)) return file.freePage << 8;
  for (let page = 0x04; page < 0xd0; page++) {
    if ((page < 0xa0 || page > 0xbf) && free(page << 8)) return page << 8;
  }
  throw new SidPlaybackError('The tune fills memory - there is no page left for a driver.');
}

// The banking a PSID's code is called with; all RAM for a routine in the I/O area's addresses.
function banking(file, address) {
  if (address !== undefined && address >= 0xd000 && address < 0xe000) return 0x34;
  const end = file.loadAddress + file.data.length;
  if (end > 0xe000 || file.loadAddress >= 0xd000) return 0x35;
  if (end > 0xa000 && file.loadAddress < 0xc000) return 0x36;
  return 0x37;
}

// The driver's code, and where an IRQ through $FFFE enters it (-1 when the tune has its own).
function driverCode(file, song, at, machine) {
  const code = [];
  const emit = (...bytes) => code.push(...bytes.map((b) => b & 0xff));
  const here = () => at + code.length;

  const psid = !file.isRsid && file.playAddress !== 0;
  const bank = file.isRsid ? 0x37 : banking(file);
  const timer = kernalTimer(machine);

  emit(0x78, 0xa9, bank, 0x85, 0x01);
  emit(0xa9, timer & 0xff, 0x8d, 0x04, 0xdc, 0xa9, timer >> 8, 0x8d, 0x05, 0xdc);
  emit(0xa9, 0x81, 0x8d, 0x0d, 0xdc, 0xa9, 0x11, 0x8d, 0x0e, 0xdc);

  let ramEntry = -1;
  if (psid && !file.usesCiaTimer(song)) {
    // Once a frame: CIA 1 quiet, the raster interrupt on line 0.
    emit(0xa9, 0x7f, 0x8d, 0x0d, 0xdc, 0xad, 0x0d, 0xdc);
    emit(0xa9, 0x00, 0x8d, 0x12, 0xd0, 0xad, 0x11, 0xd0, 0x29, 0x7f, 0x8d, 0x11, 0xd0);
    emit(0xa9, 0x01, 0x8d, 0x1a, 0xd0);
  }

  const vectorPatch = code.length;
  if (psid) emit(0xa9, 0, 0x8d, 0x14, 0x03, 0xa9, 0, 0x8d, 0x15, 0x03);

  const initBank = file.isRsid ? bank : banking(file, file.initAddress);
  if (initBank !== bank) emit(0xa9, initBank, 0x85, 0x01);
  emit(0xa9, Math.max(0, song - 1), 0x20, file.initAddress & 0xff, file.initAddress >> 8);
  if (initBank !== bank) emit(0xa9, bank, 0x85, 0x01);
  emit(0x58);
  const wait = here();
  emit(0x4c, wait & 0xff, wait >> 8);

  if (psid) {
    // From $FFFE with the KERNAL out: save the registers as the KERNAL would have.
    ramEntry = here();
    emit(0x48, 0x8a, 0x48, 0x98, 0x48);
    // From $0314: acknowledge the VIC and CIA 1, call play with the tune's banking, restore.
    const irqAt = here();
    emit(0xa9, 0xff, 0x8d, 0x19, 0xd0, 0xad, 0x0d, 0xdc);
    emit(0xa5, 0x01, 0x48, 0xa9, banking(file, file.playAddress), 0x85, 0x01);
    emit(0x20, file.playAddress & 0xff, file.playAddress >> 8);
    emit(0x68, 0x85, 0x01, 0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40);
    code[vectorPatch + 1] = irqAt & 0xff;
    code[vectorPatch + 6] = irqAt >> 8;
  }

  if (code.length > DRIVER_LENGTH) throw new Error('The driver outgrew its space.');
  return { code, ramEntry };
}

export class SidTune {
  constructor(computer, file, song, driver) {
    this.computer = computer;
    this.file = file;
    this.song = song;
    this.driver = driver;
  }

  // `options` go to the C64: sid, record, sidModel.
  static load(file, song, options = {}) {
    const reason = unsupported(file);
    if (reason) throw new SidPlaybackError(reason);

    const machine = new C64(file.isNtsc ? Machine.Ntsc : Machine.Pal, { extraSids: file.extraSids, ...options });
    machine.ram.set(file.data, file.loadAddress);

    const driver = driverAddress(file);
    const { code, ramEntry } = driverCode(file, song, driver, machine.machine);
    machine.ram.set(code, driver);

    // The hardware IRQ vector under the KERNAL, for a tune that banks it out, unless the tune is there.
    if (ramEntry >= 0 && file.loadAddress + file.data.length <= 0xfffe) {
      machine.ram[0xfffe] = ramEntry & 0xff;
      machine.ram[0xffff] = ramEntry >> 8;
    }
    machine.cpu.sp = 0xff;
    machine.cpu.i = true;
    machine.cpu.pc = driver;
    return new SidTune(machine, file, song, driver);
  }

  run(cycles) {
    this.computer.runUntil(this.computer.cycle + cycles);
  }
}

// ---------------------------------------------------------------- song length

// Twenty minutes of the tune: SOS repeats after 14:20.
export const MAX_SECONDS = 20 * 60;
const SLICE = 100000;

export function songLengthResult(totalFrames, loopStartFrame, callsPerSecond = 50) {
  return {
    totalFrames,
    loopStartFrame,
    callsPerSecond,
    get totalSeconds() { return totalFrames / callsPerSecond; },
    get loopStartSeconds() { return loopStartFrame / callsPerSecond; },
  };
}

// A hash of the pages that count: two 32-bit lanes over the RAM's words.
function hashPages(words, pages) {
  let h1 = 0x811c9dc5 | 0, h2 = 0x2545f491 | 0;
  for (let page = 0; page < 256; page++) {
    if (!pages[page]) continue;
    for (let i = page << 6, end = i + 64; i < end; i++) {
      const w = words[i];
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = Math.imul(h2 ^ w, 0x5bd1e995) ^ (h2 >>> 15);
    }
  }
  return (h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff);
}

// The tune's length, run from where it is until its memory at a call's start repeats.
export function measureSongLength(tune, maxSeconds = MAX_SECONDS) {
  const file = tune.file, computer = tune.computer;
  const pages = new Uint8Array(256);
  pages[0] = 1;
  for (let page = file.loadAddress >> 8; page <= Math.min(0xff, (file.loadAddress + file.data.length - 1) >> 8); page++) pages[page] = 1;
  pages[1] = 0;

  const words = new Uint32Array(computer.ram.buffer, computer.ram.byteOffset, 0x4000);
  const seen = new Map();
  let calls = 0;
  let found = null;
  const watch = () => {
    if (found) return;
    let grew = false;
    for (let page = 2; page < 256; page++) {
      if (!pages[page] && computer.pageWritten(page)) pages[page] = grew = true;
    }
    if (grew) seen.clear();

    const hash = hashPages(words, pages);
    const first = seen.get(hash);
    if (first !== undefined) {
      const cycles = computer.calls;
      const seconds = (cycles[cycles.length - 1] - cycles[0]) / Machines.clockHz(computer.machine);
      found = songLengthResult(calls, first, seconds > 0 ? calls / seconds : 50);
      return;
    }
    seen.set(hash, calls++);
  };

  const end = maxSeconds * Machines.clockHz(computer.machine);
  computer.onCallStarting = watch;
  try {
    while (!found && computer.cycle < end) tune.run(SLICE);
  } catch (e) {
    if (e instanceof SidPlaybackError) return null;
    throw e;
  } finally {
    computer.onCallStarting = null;
  }
  return found;
}
