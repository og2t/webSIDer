// A Commodore 64 for SID tunes: 6510, banked RAM/ROM/I/O, two CIAs, the VIC's raster IRQ and the SID.
// Port of MagPlay.C64 (C64, Cia, Vic, Kernal) from MagPlaySID by Magnar Harestad (GPL v2+).

import { Mos6502 } from './cpu.js';

export const Machine = Object.freeze({ Pal: 'pal', Ntsc: 'ntsc' });

export const Machines = {
  clockHz: (machine) => (machine === Machine.Ntsc ? 1022727.0 : 985248.0),
  cyclesPerFrame: (machine) => (machine === Machine.Ntsc ? 263 * 65 : 312 * 63),
};

// What the 6510 was running when it wrote to the SID.
export const WriteContext = Object.freeze({ Main: 0, Call: 1, Nmi: 2 });

// ---------------------------------------------------------------- the KERNAL stand-in

const KERNAL_IRQ = 0xff48;
const KERNAL_IRQ_DEFAULT = 0xea31;
const KERNAL_NMI = 0xfe43;
const KERNAL_NMI_DEFAULT = 0xfe47;
const KERNAL_BREAK = 0xfe66;

// What tunes reach into the KERNAL for, at the real addresses; the real ROM is not ours to ship.
function buildKernal() {
  const rom = new Uint8Array(0x2000);
  const put = (address, ...code) => code.forEach((b, i) => (rom[address - 0xe000 + i] = b));

  for (let entry = 0xff81; entry <= 0xfff3; entry += 3) put(entry, 0x60);
  for (const routine of [0xe544, 0xe5a0, 0xfd15, 0xfda3, 0xff5b, 0xe3bf, 0xe453]) put(routine, 0x60);

  put(KERNAL_IRQ, 0x48, 0x8a, 0x48, 0x98, 0x48, 0xba, 0xbd, 0x04, 0x01, 0x29, 0x10, 0xf0, 0x03, 0x6c, 0x16, 0x03, 0x6c, 0x14, 0x03);
  put(KERNAL_IRQ_DEFAULT, 0x4c, 0x7e, 0xea);
  put(0xea7e, 0xad, 0x0d, 0xdc);
  put(0xea81, 0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40);
  put(KERNAL_NMI, 0x78, 0x6c, 0x18, 0x03);
  put(KERNAL_NMI_DEFAULT, 0x48, 0x8a, 0x48, 0x98, 0x48, 0xad, 0x0d, 0xdd, 0x4c, 0xbc, 0xfe);
  put(0xfebc, 0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40);
  put(KERNAL_BREAK, 0x4c, 0x81, 0xea);
  put(0xfffa, KERNAL_NMI & 0xff, KERNAL_NMI >> 8, 0xe2, 0xfc, KERNAL_IRQ & 0xff, KERNAL_IRQ >> 8);
  return rom;
}

function setKernalVectors(ram) {
  const word = (address, value) => {
    ram[address] = value & 0xff;
    ram[address + 1] = value >> 8;
  };
  word(0x0314, KERNAL_IRQ_DEFAULT);
  word(0x0316, KERNAL_BREAK);
  word(0x0318, KERNAL_NMI_DEFAULT);
}

// ---------------------------------------------------------------- CIA 6526

// The two timers and the interrupt control register; the line follows an underflow by a cycle.
export class Cia {
  constructor() {
    this._cycle = 0;
    this._counterA = 0xffff; this._latchA = 0xffff;
    this._counterB = 0xffff; this._latchB = 0xffff;
    this._controlA = 0; this._controlB = 0;
    this._mask = 0; this._flags = 0;
    this._registers = new Uint8Array(16);
    this.interrupt = false;
    this.interruptSince = -1;
    this.underflowsA = 0;
  }

  get _runningA() { return (this._controlA & 1) !== 0; }
  get _runningB() { return (this._controlB & 1) !== 0; }
  get _bCountsA() { const m = this._controlB & 0x60; return m === 0x40 || m === 0x60; }

  advanceTo(cycle) {
    let cycles = cycle - this._cycle;
    if (cycles <= 0) return;

    if (!this._runningA) {
      this._advanceB(cycles);
      this._cycle = cycle;
      return;
    }

    while (cycles > 0) {
      const untilUnderflow = this._counterA + 1;
      if (untilUnderflow > cycles) {
        this._counterA -= cycles;
        if (!this._bCountsA) this._advanceB(cycles);
        break;
      }

      cycles -= untilUnderflow;
      if (!this._bCountsA) this._advanceB(untilUnderflow);
      this._cycle += untilUnderflow;

      this._counterA = this._latchA;
      this.underflowsA++;
      this._flag(1, this._cycle);
      if (this._bCountsA && this._runningB) this._countB(1);

      if ((this._controlA & 0x08) !== 0) {
        this._controlA &= ~1;
        this._advanceB(this._bCountsA ? 0 : cycles);
        break;
      }
    }
    this._cycle = cycle;
  }

  _advanceB(cycles) {
    if (!this._runningB || this._bCountsA || cycles <= 0) return;
    this._countB(cycles);
  }

  _countB(counts) {
    let at = this._cycle;
    while (counts > 0 && this._runningB) {
      const untilUnderflow = this._counterB + 1;
      if (untilUnderflow > counts) {
        this._counterB -= counts;
        return;
      }
      counts -= untilUnderflow;
      at += this._bCountsA ? 0 : untilUnderflow;
      this._counterB = this._latchB;
      this._flag(2, at);
      if ((this._controlB & 0x08) !== 0) this._controlB &= ~1;
    }
  }

  _flag(bit, at) {
    this._flags |= bit;
    if ((this._mask & bit) !== 0) this._raise(at + 1);
  }

  _raise(at) {
    if (this.interrupt) return;
    this.interrupt = true;
    this.interruptSince = at;
  }

  read(register) {
    switch (register & 0x0f) {
      case 0x00: case 0x01: return 0xff;
      case 0x04: return this._counterA & 0xff;
      case 0x05: return (this._counterA >> 8) & 0xff;
      case 0x06: return this._counterB & 0xff;
      case 0x07: return (this._counterB >> 8) & 0xff;
      case 0x0d: {
        const value = this._flags | (this.interrupt ? 0x80 : 0);
        this._flags = 0;
        this.interrupt = false;
        return value;
      }
      case 0x0e: return this._controlA;
      case 0x0f: return this._controlB;
      default: return this._registers[register & 0x0f];
    }
  }

  write(register, value) {
    value &= 0xff;
    register &= 0x0f;
    this._registers[register] = value;
    switch (register) {
      case 0x04: this._latchA = (this._latchA & 0xff00) | value; break;
      case 0x05:
        this._latchA = (this._latchA & 0xff) | (value << 8);
        if (!this._runningA) this._counterA = this._latchA;
        break;
      case 0x06: this._latchB = (this._latchB & 0xff00) | value; break;
      case 0x07:
        this._latchB = (this._latchB & 0xff) | (value << 8);
        if (!this._runningB) this._counterB = this._latchB;
        break;
      case 0x0d:
        if ((value & 0x80) !== 0) this._mask |= value & 0x1f;
        else this._mask &= ~(value & 0x1f);
        if ((this._flags & this._mask) !== 0) this._raise(this._cycle + 1);
        break;
      case 0x0e:
        if ((value & 0x10) !== 0) this._counterA = this._latchA;
        this._controlA = value & ~0x10;
        break;
      case 0x0f:
        if ((value & 0x10) !== 0) this._counterB = this._latchB;
        this._controlB = value & ~0x10;
        break;
    }
  }
}

// ---------------------------------------------------------------- VIC-II

// The raster beam and its interrupt; no stolen cycles, no screen.
export class Vic {
  constructor(cyclesPerLine, lines) {
    this.cyclesPerLine = cyclesPerLine;
    this.lines = lines;
    this._registers = new Uint8Array(0x40);
    this._cycle = 0;
    this._compare = 0;
    this._flags = 0;
    this._mask = 0;
    this.interruptSince = 0;
  }

  get cyclesPerFrame() { return this.cyclesPerLine * this.lines; }
  get interrupt() { return (this._flags & this._mask & 0x0f) !== 0; }
  get raster() { return Math.floor(this._cycle / this.cyclesPerLine) % this.lines; }

  advanceTo(cycle) {
    const perLine = this.cyclesPerLine;
    let nextLine = (Math.floor(this._cycle / perLine) + 1) * perLine;
    while (nextLine <= cycle) {
      if ((nextLine / perLine) % this.lines === this._compare) this._flag(1, nextLine);
      nextLine += perLine;
    }
    this._cycle = cycle;
  }

  _flag(bits, at) {
    const was = this.interrupt;
    this._flags |= bits;
    if (this.interrupt && !was) this.interruptSince = at;
  }

  read(register) {
    register &= 0x3f;
    switch (register) {
      case 0x11: return (this._registers[0x11] & 0x7f) | ((this.raster >> 1) & 0x80);
      case 0x12: return this.raster & 0xff;
      case 0x19: return (this._flags | 0x70 | (this.interrupt ? 0x80 : 0)) & 0xff;
      case 0x1a: return (this._mask | 0xf0) & 0xff;
      default: return register >= 0x2f ? 0xff : this._registers[register];
    }
  }

  write(register, value) {
    register &= 0x3f;
    value &= 0xff;
    this._registers[register] = value;
    switch (register) {
      case 0x11: this._compare = (this._compare & 0xff) | ((value & 0x80) << 1); break;
      case 0x12: this._compare = (this._compare & 0x100) | value; break;
      case 0x19: this._flags &= ~value; break;
      case 0x1a: {
        const was = this.interrupt;
        this._mask = value & 0x0f;
        if (this.interrupt && !was) this.interruptSince = this._cycle;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the machine

// A SID write and the CPU cycle it happens on; registers numbered $20 a chip.
export const timedWrite = (cycle, register, value) => ({ cycle, register, value });

export class C64 {
  // `sid` plays every write into a chip; `sidModel` makes the chip that answers voice 3 reads.
  constructor(machine, { extraSids = [], sid = null, record = true, sidModel = null } = {}) {
    this.machine = machine;
    this.ram = new Uint8Array(0x10000);
    this._kernal = buildKernal();
    this._basic = new Uint8Array(0x2000);
    this._colour = new Uint8Array(0x400);
    this.sidRegisters = new Uint8Array(0x20);
    this.sidWrites = [];
    this.sidWriteContexts = [];
    this._extraSids = [...extraSids];
    this.extraSidWrites = this._extraSids.map(() => []);
    this.extraSidWriteContexts = this._extraSids.map(() => []);
    this.calls = [];
    this._interrupts = [];
    this._chip = sid;
    this._sidModel = sidModel;
    this._sid = null;
    this._sidCycle = 0;
    this._writtenPages = new Uint8Array(256);
    this._record = record;
    this._synced = 0;
    this._nmiEdge = -1;
    this._maskedBefore = true;
    this._port = 0x37;
    this._direction = 0x2f;
    this.keep = null;
    this.onCallStarting = null;
    this.vic = machine === Machine.Ntsc ? new Vic(65, 263) : new Vic(63, 312);
    this.cia1 = new Cia();
    this.cia2 = new Cia();
    this.cpu = new Mos6502(this);
    setKernalVectors(this.ram);
    this.ram[0] = this._direction;
    this.ram[1] = this._port;
  }

  get cycle() { return this.cpu.cycles; }

  pageWritten(page) { return this._writtenPages[page & 0xff] !== 0; }

  // Runs until `cycle`; the 6510 looks at its interrupt lines on an instruction's second-last
  // cycle, and CLI, SEI and PLP change I only after that look.
  runUntil(cycle) {
    const cpu = this.cpu, cia1 = this.cia1, cia2 = this.cia2, vic = this.vic;
    while (cpu.cycles < cycle) {
      const now = cpu.cycles;
      this._sync(now);
      const seen = now - 2;

      // An NMI is taken on the line's falling edge, which the 6510 latches.
      if (cia2.interruptSince > this._nmiEdge && cia2.interruptSince <= seen) {
        this._nmiEdge = cia2.interruptSince;
        this._enter(true);
        cpu.interrupt(true);
        continue;
      }

      const op = cpu.opcode;
      const masked = op === 0x58 || op === 0x78 || op === 0x28 ? this._maskedBefore : cpu.i;
      if (!masked && ((cia1.interrupt && cia1.interruptSince <= seen) || (vic.interrupt && vic.interruptSince <= seen))) {
        this._enter(false);
        cpu.interrupt(false);
        this._maskedBefore = true;
        continue;
      }

      this._maskedBefore = cpu.i;
      cpu.step();
      if (cpu.opcode === 0x40) this._unwind();
    }
    this._sync(cpu.cycles);
  }

  // An interrupt about to be taken: a call when it is an IRQ and none is being run.
  _enter(nmi) {
    this._unwind();
    if (!nmi && !this._interrupts.some((i) => !i.nmi)) {
      this.calls.push(this.cpu.cycles);
      if (this.onCallStarting) this.onCallStarting();
    }
    this._interrupts.push({ nmi, sp: this.cpu.sp & 0xff });
  }

  // The interrupts left are those whose stack pointer the stack is back at or above.
  _unwind() {
    const list = this._interrupts, sp = this.cpu.sp & 0xff;
    while (list.length > 0 && list[list.length - 1].sp <= sp) list.pop();
  }

  _context() {
    this._unwind();
    const list = this._interrupts;
    if (list.length === 0) return WriteContext.Main;
    return list[list.length - 1].nmi ? WriteContext.Nmi : WriteContext.Call;
  }

  _sync(now) {
    if (now <= this._synced) return;
    this.cia1.advanceTo(now);
    this.cia2.advanceTo(now);
    this.vic.advanceTo(now);
    this._synced = now;
  }

  // LORAM, HIRAM and CHAREN as the port drives them; an input pin floats high.
  get _banking() { return (this._port | ~this._direction) & 7; }

  read(address) {
    if (address === 0) return this._direction;
    if (address === 1) return ((this._port & this._direction) | (~this._direction & 0x17)) & 0xff;
    const banking = this._banking;
    if (address >= 0xa000 && address < 0xc000 && (banking === 3 || banking === 7)) return this._basic[address - 0xa000];
    if (address >= 0xd000 && address < 0xe000 && banking >= 5) return this._readIo(address);
    if (address >= 0xe000 && (banking & 2) !== 0) return this._kernal[address - 0xe000];
    return this.ram[address];
  }

  write(address, value) {
    value &= 0xff;
    if (address === 0) this._direction = value;
    else if (address === 1) this._port = value;

    if (address >= 0xd000 && address < 0xe000 && this._banking >= 5) {
      this._writeIo(address, value);
      return;
    }
    this.ram[address] = value;
    this._writtenPages[address >> 8] = 1;
  }

  _readIo(address) {
    this._sync(this.cpu.accessCycle);
    if (address < 0xd400) return this.vic.read(address);
    const chip = this._extraSid(address);
    if (chip >= 0) return this._readSid(chip + 1, address & 0x1f);
    if (address < 0xd800) return this._readSid(0, address & 0x1f);
    if (address < 0xdc00) return this._colour[address - 0xd800] | 0xf0;
    if (address < 0xdd00) return this.cia1.read(address);
    if (address < 0xde00) return this.cia2.read(address);
    return 0xff;
  }

  _writeIo(address, value) {
    this._sync(this.cpu.accessCycle);
    if (address < 0xd400) {
      this.vic.write(address, value);
      return;
    }
    const chip = this._extraSid(address);
    if (chip >= 0) {
      const register = address & 0x1f;
      if (register > 0x18) return;
      if (this._chip) this._chip.write(this.cpu.accessCycle, chip + 1, register, value);
      if (this._record) {
        const context = this._context();
        if (!this.keep || this.keep(context)) {
          this.extraSidWrites[chip].push(timedWrite(this.cpu.accessCycle, register, value));
          this.extraSidWriteContexts[chip].push(context);
        }
      }
      return;
    }
    if (address < 0xd800) this._writeSid(address & 0x1f, value);
    else if (address < 0xdc00) this._colour[address - 0xd800] = value & 0x0f;
    else if (address < 0xdd00) this.cia1.write(address, value);
    else if (address < 0xde00) this.cia2.write(address, value);
  }

  _extraSid(address) {
    const base = address & ~0x1f;
    for (let i = 0; i < this._extraSids.length; i++) if (base === this._extraSids[i]) return i;
    return -1;
  }

  _writeSid(register, value) {
    if (register > 0x18) return;
    this.sidRegisters[register] = value;
    if (this._chip) this._chip.write(this.cpu.accessCycle, 0, register, value);
    if (!this._record) return;
    if (this._sid) {
      this._clockSidTo(this.cpu.accessCycle);
      this._sid.write(register, value);
    }

    const context = this._context();
    if (this.keep && !this.keep(context)) return;
    this.sidWrites.push(timedWrite(this.cpu.accessCycle, register, value));
    this.sidWriteContexts.push(context);
  }

  _readSid(chip, register) {
    switch (register) {
      case 0x19: case 0x1a: return 0xff;
      case 0x1b: case 0x1c:
        if (this._chip) return this._chip.read(this.cpu.accessCycle, chip, register);
        if (chip > 0 || !this._sidModel) return 0;
        this._ensureSid();
        this._clockSidTo(this.cpu.accessCycle);
        return this._sid.read(register) & 0xff;
      default: return 0;
    }
  }

  // The chip, started the first time a tune reads it and brought up to now with every write kept.
  _ensureSid() {
    if (this._sid) return;
    this._sid = this._sidModel();
    this._sidCycle = 0;
    for (const w of this.sidWrites) {
      this._clockSidTo(w.cycle);
      this._sid.write(w.register, w.value);
    }
  }

  _clockSidTo(cycle) {
    if (cycle > this._sidCycle) {
      this._sid.clock(cycle - this._sidCycle);
      this._sidCycle = cycle;
    }
  }
}
