// The NMOS 6510, cycle-counted, with every access placed on the cycle it is made on.
// Port of MagSid.Playback/Mos6502.cs from MagPlaySID by Magnar Harestad (GPL v2+), bus mode only.

import { SidPlaybackError } from './sidfile.js';

// Cycles of each opcode before a page crossed or a branch taken.
const BASE_CYCLES = new Uint8Array([
  7, 6, 0, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 0, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 0, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6,
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 0, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6,
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
  2, 6, 0, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
  2, 5, 0, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 0, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
]);

// Implied, accumulator, stack, RTS and RTI: the opcode alone.
const ONE_BYTE = new Uint8Array(256);
for (let high = 0; high < 16; high++) {
  ONE_BYTE[(high << 4) | 0x08] = 1;
  ONE_BYTE[(high << 4) | 0x0a] = 1;
}
ONE_BYTE[0x40] = ONE_BYTE[0x60] = 1;

// Reads that take a cycle more when indexing crosses a page.
const PAGE_PENALTY = new Uint8Array(256);
for (const op of [
  0x11, 0x31, 0x51, 0x71, 0xb1, 0xd1, 0xf1, 0x19, 0x39, 0x59, 0x79, 0xb9, 0xd9, 0xf9,
  0x1d, 0x3d, 0x5d, 0x7d, 0xbd, 0xdd, 0xfd, 0xbc, 0xbe, 0xb3, 0xbf, 0xbb,
  0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc,
]) PAGE_PENALTY[op] = 1;

const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');

export class Mos6502 {
  constructor(bus) {
    this.bus = bus;
    this.cycles = 0;
    this.accessCycle = 0;
    this.opcode = 0;
    this.steps = 0;
    this.a = 0; this.x = 0; this.y = 0;
    this.sp = 0xfd; this.pc = 0;
    this.c = false; this.z = false; this.n = false; this.v = false; this.d = false; this.i = false;
    this._crossed = false;
    this._branchCycles = 0;
    this._start = 0;
    this._fetched = 0;
    this._at = -1;
  }

  read(address) {
    this._place();
    return this.bus.read(address & 0xffff);
  }

  write(address, value) {
    this._place();
    this.bus.write(address & 0xffff, value & 0xff);
  }

  // Places the access about to be made on its cycle.
  _place() {
    const op = this.opcode;
    const at = this._at >= 0 ? this._at : BASE_CYCLES[op] + (this._crossed && PAGE_PENALTY[op] ? 1 : 0) - 1;
    this.accessCycle = this._start + at;
    this._at = -1;
  }

  // An interrupt: PC and status pushed with B clear, I set, PC from $FFFA (NMI) or $FFFE (IRQ).
  interrupt(nmi) {
    this._start = this.cycles;
    this._at = 2; this._push(this.pc >> 8);
    this._at = 3; this._push(this.pc & 0xff);
    this._at = 4; this._push(this.status() & ~0x10);
    this.i = true;
    const vector = nmi ? 0xfffa : 0xfffe;
    this._at = 5; const low = this.read(vector);
    this._at = 6; this.pc = low | (this.read(vector + 1) << 8);
    this.cycles += 7;
  }

  step() {
    this.steps++;
    this._crossed = false;
    this._branchCycles = 0;
    this._start = this.cycles;
    this._fetched = 0;
    const op = this._fetch();
    this.opcode = op;
    // A one-byte instruction still reads the byte after it, which can acknowledge a CIA.
    if (ONE_BYTE[op]) {
      this._at = 1;
      this.read(this.pc);
    }
    this._execute(op);
    this.cycles += BASE_CYCLES[op] + (this._crossed && PAGE_PENALTY[op] ? 1 : 0) + this._branchCycles;
  }

  _execute(op) {
    switch (op) {
      // load / store
      case 0xa9: this._lda(this._fetch()); break;
      case 0xa5: this._lda(this.read(this._zp())); break;
      case 0xb5: this._lda(this.read(this._zpx())); break;
      case 0xad: this._lda(this.read(this._abs())); break;
      case 0xbd: this._lda(this.read(this._absx())); break;
      case 0xb9: this._lda(this.read(this._absy())); break;
      case 0xa1: this._lda(this.read(this._indx())); break;
      case 0xb1: this._lda(this.read(this._indy())); break;

      case 0xa2: this._ldx(this._fetch()); break;
      case 0xa6: this._ldx(this.read(this._zp())); break;
      case 0xb6: this._ldx(this.read(this._zpy())); break;
      case 0xae: this._ldx(this.read(this._abs())); break;
      case 0xbe: this._ldx(this.read(this._absy())); break;

      case 0xa0: this._ldy(this._fetch()); break;
      case 0xa4: this._ldy(this.read(this._zp())); break;
      case 0xb4: this._ldy(this.read(this._zpx())); break;
      case 0xac: this._ldy(this.read(this._abs())); break;
      case 0xbc: this._ldy(this.read(this._absx())); break;

      case 0x85: this.write(this._zp(), this.a); break;
      case 0x95: this.write(this._zpx(), this.a); break;
      case 0x8d: this.write(this._abs(), this.a); break;
      case 0x9d: this.write(this._absx(), this.a); break;
      case 0x99: this.write(this._absy(), this.a); break;
      case 0x81: this.write(this._indx(), this.a); break;
      case 0x91: this.write(this._indy(), this.a); break;

      case 0x86: this.write(this._zp(), this.x); break;
      case 0x96: this.write(this._zpy(), this.x); break;
      case 0x8e: this.write(this._abs(), this.x); break;

      case 0x84: this.write(this._zp(), this.y); break;
      case 0x94: this.write(this._zpx(), this.y); break;
      case 0x8c: this.write(this._abs(), this.y); break;

      // transfers
      case 0xaa: this.x = this.a; this._zn(this.x); break;
      case 0xa8: this.y = this.a; this._zn(this.y); break;
      case 0x8a: this.a = this.x; this._zn(this.a); break;
      case 0x98: this.a = this.y; this._zn(this.a); break;
      case 0xba: this.x = this.sp; this._zn(this.x); break;
      case 0x9a: this.sp = this.a; break;

      // stack
      case 0x48: this._push(this.a); break;
      case 0x68: this.a = this._pop(); this._zn(this.a); break;
      case 0x08: this._push(this.status() | 0x10); break;
      case 0x28: this.setStatus(this._pop()); break;

      // logic
      case 0x29: this.a &= this._fetch(); this._zn(this.a); break;
      case 0x25: this.a &= this.read(this._zp()); this._zn(this.a); break;
      case 0x35: this.a &= this.read(this._zpx()); this._zn(this.a); break;
      case 0x2d: this.a &= this.read(this._abs()); this._zn(this.a); break;
      case 0x3d: this.a &= this.read(this._absx()); this._zn(this.a); break;
      case 0x39: this.a &= this.read(this._absy()); this._zn(this.a); break;
      case 0x21: this.a &= this.read(this._indx()); this._zn(this.a); break;
      case 0x31: this.a &= this.read(this._indy()); this._zn(this.a); break;

      case 0x09: this.a |= this._fetch(); this._zn(this.a); break;
      case 0x05: this.a |= this.read(this._zp()); this._zn(this.a); break;
      case 0x15: this.a |= this.read(this._zpx()); this._zn(this.a); break;
      case 0x0d: this.a |= this.read(this._abs()); this._zn(this.a); break;
      case 0x1d: this.a |= this.read(this._absx()); this._zn(this.a); break;
      case 0x19: this.a |= this.read(this._absy()); this._zn(this.a); break;
      case 0x01: this.a |= this.read(this._indx()); this._zn(this.a); break;
      case 0x11: this.a |= this.read(this._indy()); this._zn(this.a); break;

      case 0x49: this.a ^= this._fetch(); this._zn(this.a); break;
      case 0x45: this.a ^= this.read(this._zp()); this._zn(this.a); break;
      case 0x55: this.a ^= this.read(this._zpx()); this._zn(this.a); break;
      case 0x4d: this.a ^= this.read(this._abs()); this._zn(this.a); break;
      case 0x5d: this.a ^= this.read(this._absx()); this._zn(this.a); break;
      case 0x59: this.a ^= this.read(this._absy()); this._zn(this.a); break;
      case 0x41: this.a ^= this.read(this._indx()); this._zn(this.a); break;
      case 0x51: this.a ^= this.read(this._indy()); this._zn(this.a); break;

      case 0x24: this._bit(this.read(this._zp())); break;
      case 0x2c: this._bit(this.read(this._abs())); break;

      // arithmetic
      case 0x69: this._adc(this._fetch()); break;
      case 0x65: this._adc(this.read(this._zp())); break;
      case 0x75: this._adc(this.read(this._zpx())); break;
      case 0x6d: this._adc(this.read(this._abs())); break;
      case 0x7d: this._adc(this.read(this._absx())); break;
      case 0x79: this._adc(this.read(this._absy())); break;
      case 0x61: this._adc(this.read(this._indx())); break;
      case 0x71: this._adc(this.read(this._indy())); break;

      case 0xe9: this._sbc(this._fetch()); break;
      case 0xe5: this._sbc(this.read(this._zp())); break;
      case 0xf5: this._sbc(this.read(this._zpx())); break;
      case 0xed: this._sbc(this.read(this._abs())); break;
      case 0xfd: this._sbc(this.read(this._absx())); break;
      case 0xf9: this._sbc(this.read(this._absy())); break;
      case 0xe1: this._sbc(this.read(this._indx())); break;
      case 0xf1: this._sbc(this.read(this._indy())); break;

      case 0xc9: this._cmp(this.a, this._fetch()); break;
      case 0xc5: this._cmp(this.a, this.read(this._zp())); break;
      case 0xd5: this._cmp(this.a, this.read(this._zpx())); break;
      case 0xcd: this._cmp(this.a, this.read(this._abs())); break;
      case 0xdd: this._cmp(this.a, this.read(this._absx())); break;
      case 0xd9: this._cmp(this.a, this.read(this._absy())); break;
      case 0xc1: this._cmp(this.a, this.read(this._indx())); break;
      case 0xd1: this._cmp(this.a, this.read(this._indy())); break;

      case 0xe0: this._cmp(this.x, this._fetch()); break;
      case 0xe4: this._cmp(this.x, this.read(this._zp())); break;
      case 0xec: this._cmp(this.x, this.read(this._abs())); break;

      case 0xc0: this._cmp(this.y, this._fetch()); break;
      case 0xc4: this._cmp(this.y, this.read(this._zp())); break;
      case 0xcc: this._cmp(this.y, this.read(this._abs())); break;

      // increment / decrement
      case 0xe6: this._modify(this._zp(), INC); break;
      case 0xf6: this._modify(this._zpx(), INC); break;
      case 0xee: this._modify(this._abs(), INC); break;
      case 0xfe: this._modify(this._absx(), INC); break;

      case 0xc6: this._modify(this._zp(), DEC); break;
      case 0xd6: this._modify(this._zpx(), DEC); break;
      case 0xce: this._modify(this._abs(), DEC); break;
      case 0xde: this._modify(this._absx(), DEC); break;

      case 0xe8: this.x = (this.x + 1) & 0xff; this._zn(this.x); break;
      case 0xca: this.x = (this.x - 1) & 0xff; this._zn(this.x); break;
      case 0xc8: this.y = (this.y + 1) & 0xff; this._zn(this.y); break;
      case 0x88: this.y = (this.y - 1) & 0xff; this._zn(this.y); break;

      // shifts and rotates
      case 0x0a: this.a = this._asl(this.a); break;
      case 0x06: this._modify(this._zp(), ASL); break;
      case 0x16: this._modify(this._zpx(), ASL); break;
      case 0x0e: this._modify(this._abs(), ASL); break;
      case 0x1e: this._modify(this._absx(), ASL); break;

      case 0x4a: this.a = this._lsr(this.a); break;
      case 0x46: this._modify(this._zp(), LSR); break;
      case 0x56: this._modify(this._zpx(), LSR); break;
      case 0x4e: this._modify(this._abs(), LSR); break;
      case 0x5e: this._modify(this._absx(), LSR); break;

      case 0x2a: this.a = this._rol(this.a); break;
      case 0x26: this._modify(this._zp(), ROL); break;
      case 0x36: this._modify(this._zpx(), ROL); break;
      case 0x2e: this._modify(this._abs(), ROL); break;
      case 0x3e: this._modify(this._absx(), ROL); break;

      case 0x6a: this.a = this._ror(this.a); break;
      case 0x66: this._modify(this._zp(), ROR); break;
      case 0x76: this._modify(this._zpx(), ROR); break;
      case 0x6e: this._modify(this._abs(), ROR); break;
      case 0x7e: this._modify(this._absx(), ROR); break;

      // jumps
      case 0x00:
        this._fetch();
        this._push(this.pc >> 8);
        this._push(this.pc & 0xff);
        this._push(this.status() | 0x10);
        this.i = true;
        this.pc = this.read(0xfffe) | (this.read(0xffff) << 8);
        break;
      case 0x4c: this.pc = this._abs(); break;
      case 0x6c: this.pc = this._indirectJump(); break;
      case 0x20: this._jsr(); break;
      case 0x60: this.pc = ((this._pop() | (this._pop() << 8)) + 1) & 0xffff; break;
      case 0x40: this.setStatus(this._pop()); this.pc = this._pop() | (this._pop() << 8); break;

      // branches
      case 0x10: this._branch(!this.n); break;
      case 0x30: this._branch(this.n); break;
      case 0x50: this._branch(!this.v); break;
      case 0x70: this._branch(this.v); break;
      case 0x90: this._branch(!this.c); break;
      case 0xb0: this._branch(this.c); break;
      case 0xd0: this._branch(!this.z); break;
      case 0xf0: this._branch(this.z); break;

      // flags
      case 0x18: this.c = false; break;
      case 0x38: this.c = true; break;
      case 0x58: this.i = false; break;
      case 0x78: this.i = true; break;
      case 0xd8: this.d = false; break;
      case 0xf8: this.d = true; break;
      case 0xb8: this.v = false; break;
      case 0xea: break;

      // undocumented read-modify-write
      case 0xe7: this._isc(this._zp()); break;
      case 0xf7: this._isc(this._zpx()); break;
      case 0xef: this._isc(this._abs()); break;
      case 0xff: this._isc(this._absx()); break;
      case 0xfb: this._isc(this._absy()); break;
      case 0xe3: this._isc(this._indx()); break;
      case 0xf3: this._isc(this._indy()); break;

      case 0x07: this._slo(this._zp()); break;
      case 0x17: this._slo(this._zpx()); break;
      case 0x0f: this._slo(this._abs()); break;
      case 0x1f: this._slo(this._absx()); break;
      case 0x1b: this._slo(this._absy()); break;
      case 0x03: this._slo(this._indx()); break;
      case 0x13: this._slo(this._indy()); break;

      case 0x27: this._rla(this._zp()); break;
      case 0x37: this._rla(this._zpx()); break;
      case 0x2f: this._rla(this._abs()); break;
      case 0x3f: this._rla(this._absx()); break;
      case 0x3b: this._rla(this._absy()); break;
      case 0x23: this._rla(this._indx()); break;
      case 0x33: this._rla(this._indy()); break;

      case 0x47: this._sre(this._zp()); break;
      case 0x57: this._sre(this._zpx()); break;
      case 0x4f: this._sre(this._abs()); break;
      case 0x5f: this._sre(this._absx()); break;
      case 0x5b: this._sre(this._absy()); break;
      case 0x43: this._sre(this._indx()); break;
      case 0x53: this._sre(this._indy()); break;

      case 0x67: this._rra(this._zp()); break;
      case 0x77: this._rra(this._zpx()); break;
      case 0x6f: this._rra(this._abs()); break;
      case 0x7f: this._rra(this._absx()); break;
      case 0x7b: this._rra(this._absy()); break;
      case 0x63: this._rra(this._indx()); break;
      case 0x73: this._rra(this._indy()); break;

      case 0xc7: this._dcp(this._zp()); break;
      case 0xd7: this._dcp(this._zpx()); break;
      case 0xcf: this._dcp(this._abs()); break;
      case 0xdf: this._dcp(this._absx()); break;
      case 0xdb: this._dcp(this._absy()); break;
      case 0xc3: this._dcp(this._indx()); break;
      case 0xd3: this._dcp(this._indy()); break;

      // undocumented loads and stores
      case 0xa7: this._lax(this.read(this._zp())); break;
      case 0xb7: this._lax(this.read(this._zpy())); break;
      case 0xaf: this._lax(this.read(this._abs())); break;
      case 0xbf: this._lax(this.read(this._absy())); break;
      case 0xa3: this._lax(this.read(this._indx())); break;
      case 0xb3: this._lax(this.read(this._indy())); break;

      case 0x87: this.write(this._zp(), this.a & this.x); break;
      case 0x97: this.write(this._zpy(), this.a & this.x); break;
      case 0x8f: this.write(this._abs(), this.a & this.x); break;
      case 0x83: this.write(this._indx(), this.a & this.x); break;

      // undocumented immediates
      case 0x0b: case 0x2b: this.a &= this._fetch(); this._zn(this.a); this.c = this.n; break;
      case 0x4b: this.a = this._lsr(this.a & this._fetch()); break;
      case 0x6b: this._arr(this._fetch()); break;
      case 0xcb: this._sbx(this._fetch()); break;
      case 0xeb: this._sbc(this._fetch()); break;

      // undocumented and unstable, as a C64 usually behaves ($EE as the magic constant)
      case 0x8b: this.a = (this.a | 0xee) & this.x & this._fetch(); this._zn(this.a); break;
      case 0xab: this._lax((this.a | 0xee) & this._fetch()); break;
      case 0xbb: this._las(this.read(this._absy())); break;
      case 0x9f: this._storeHigh(this._word(), this.y, this.a & this.x); break;
      case 0x93: this._storeHigh(this._indirectBase(), this.y, this.a & this.x); break;
      case 0x9e: this._storeHigh(this._word(), this.y, this.x); break;
      case 0x9c: this._storeHigh(this._word(), this.x, this.y); break;
      case 0x9b: this.sp = this.a & this.x; this._storeHigh(this._word(), this.y, this.sp); break;

      // undocumented NOPs, operands still fetched
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: this._fetch(); break;
      case 0x04: case 0x44: case 0x64: this._fetch(); break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: this._fetch(); break;
      case 0x0c: this._word(); break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: this._absx(); break;

      case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
      case 0x62: case 0x72: case 0x92: case 0xb2: case 0xd2: case 0xf2:
        throw new SidPlaybackError(`Opcode $${hex(op, 2)} at $${hex((this.pc - 1) & 0xffff, 4)} halts the 6510 (JAM) - the tune has run into something that is not code.`);

      default:
        throw new SidPlaybackError(`Opcode $${hex(op, 2)} at $${hex((this.pc - 1) & 0xffff, 4)} is not implemented.`);
    }
  }

  // addressing modes

  _fetch() {
    this._at = this._fetched++;
    const value = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  _word() {
    const low = this._fetch();
    return low | (this._fetch() << 8);
  }

  _zp() { return this._fetch(); }
  _zpx() { return (this._fetch() + this.x) & 0xff; }
  _zpy() { return (this._fetch() + this.y) & 0xff; }
  _abs() { return this._word(); }
  _absx() { return this._indexed(this._word(), this.x); }
  _absy() { return this._indexed(this._word(), this.y); }

  _indexed(base, index) {
    const address = (base + index) & 0xffff;
    this._crossed = (address & 0xff00) !== (base & 0xff00);
    // Crossing a page, the 6510 first reads the address with the high byte not yet carried.
    if (this._crossed) {
      this._at = BASE_CYCLES[this.opcode] + (PAGE_PENALTY[this.opcode] ? 1 : 0) - 2;
      this.read((base & 0xff00) | (address & 0xff));
    }
    return address;
  }

  _indx() {
    const pointer = (this._fetch() + this.x) & 0xff;
    return this.read(pointer) | (this.read((pointer + 1) & 0xff) << 8);
  }

  _indy() {
    const pointer = this._fetch();
    const address = this.read(pointer) | (this.read((pointer + 1) & 0xff) << 8);
    return this._indexed(address, this.y);
  }

  // JMP (abs) with the page-boundary bug: the high byte comes from the same page as the low.
  _indirectJump() {
    const pointer = this._word();
    const high = (pointer & 0xff00) | ((pointer + 1) & 0xff);
    this._at = 3;
    const low = this.read(pointer);
    return low | (this.read(high) << 8);
  }

  // operations

  _lda(v) { this.a = v & 0xff; this._zn(this.a); }
  _ldx(v) { this.x = v & 0xff; this._zn(this.x); }
  _ldy(v) { this.y = v & 0xff; this._zn(this.y); }

  // A read-modify-write's read, and the unchanged value the 6510 writes back before the new one.
  _readModify(address) {
    const last = BASE_CYCLES[this.opcode] - 1;
    this._at = last - 2;
    const value = this.read(address);
    this._at = last - 1;
    this._place();
    this.bus.write(address & 0xffff, value);
    return value;
  }

  _modify(address, operation) {
    const result = operation(this, this._readModify(address)) & 0xff;
    this.write(address, result);
    this._zn(result);
  }

  _asl(v) { this.c = (v & 0x80) !== 0; const r = (v << 1) & 0xff; this._zn(r); return r; }
  _lsr(v) { this.c = (v & 1) !== 0; const r = (v >> 1) & 0xff; this._zn(r); return r; }
  _rol(v) { const r = ((v << 1) | (this.c ? 1 : 0)) & 0xff; this.c = (v & 0x80) !== 0; this._zn(r); return r; }
  _ror(v) { const r = ((v >> 1) | (this.c ? 0x80 : 0)) & 0xff; this.c = (v & 1) !== 0; this._zn(r); return r; }

  _bit(v) {
    this.z = (this.a & v) === 0;
    this.n = (v & 0x80) !== 0;
    this.v = (v & 0x40) !== 0;
  }

  _adc(value) {
    const carryIn = this.c ? 1 : 0;
    const a = this.a;
    if (this.d) {
      let low = (a & 0x0f) + (value & 0x0f) + carryIn;
      let high = (a >> 4) + (value >> 4);
      if (low > 9) { low -= 10; high++; }
      this.z = ((a + value + carryIn) & 0xff) === 0;
      this.n = ((high << 4) & 0x80) !== 0;
      this.v = ((a ^ value) & 0x80) === 0 && ((a ^ (high << 4)) & 0x80) !== 0;
      this.c = high > 9;
      if (this.c) high -= 10;
      this.a = ((high << 4) | (low & 0x0f)) & 0xff;
      return;
    }
    const sum = a + value + carryIn;
    this.c = sum > 0xff;
    this.v = ((a ^ sum) & (value ^ sum) & 0x80) !== 0;
    this.a = sum & 0xff;
    this._zn(this.a);
  }

  _sbc(value) {
    const carryIn = this.c ? 1 : 0;
    const a = this.a;
    if (this.d) {
      let low = (a & 0x0f) - (value & 0x0f) - (1 - carryIn);
      let high = (a >> 4) - (value >> 4);
      if ((low & 0x10) !== 0) { low -= 6; high--; }
      if ((high & 0x10) !== 0) high -= 6;
      const binary = a - value - (1 - carryIn);
      this.c = (binary & 0x100) === 0;
      this.v = ((a ^ binary) & (~value ^ binary) & 0x80) !== 0;
      this.z = (binary & 0xff) === 0;
      this.n = (binary & 0x80) !== 0;
      this.a = ((high << 4) | (low & 0x0f)) & 0xff;
      return;
    }
    const result = a - value - (1 - carryIn);
    this.c = (result & 0x100) === 0;
    this.v = ((a ^ result) & (~value ^ result) & 0x80) !== 0;
    this.a = result & 0xff;
    this._zn(this.a);
  }

  _cmp(register, value) {
    const result = register - value;
    this.c = result >= 0;
    this._zn(result & 0xff);
  }

  _isc(address) {
    const value = (this._readModify(address) + 1) & 0xff;
    this.write(address, value);
    this._sbc(value);
  }

  _slo(address) {
    const value = this._asl(this._readModify(address));
    this.write(address, value);
    this.a |= value;
    this._zn(this.a);
  }

  _rla(address) {
    const value = this._rol(this._readModify(address));
    this.write(address, value);
    this.a &= value;
    this._zn(this.a);
  }

  _sre(address) {
    const value = this._lsr(this._readModify(address));
    this.write(address, value);
    this.a ^= value;
    this._zn(this.a);
  }

  _rra(address) {
    const value = this._ror(this._readModify(address));
    this.write(address, value);
    this._adc(value);
  }

  _dcp(address) {
    const value = (this._readModify(address) - 1) & 0xff;
    this.write(address, value);
    this._cmp(this.a, value);
  }

  _lax(v) { this.a = this.x = v & 0xff; this._zn(this.a); }
  _las(v) { this.a = this.x = this.sp = v & this.sp; this._zn(this.a); }

  _sbx(value) {
    const and = this.a & this.x;
    this.c = and >= value;
    this.x = (and - value) & 0xff;
    this._zn(this.x);
  }

  // ARR: AND, then rotate right, with the decimal-mode fixups "No More Secrets" gives.
  _arr(value) {
    const and = this.a & value;
    let rotated = ((and >> 1) | (this.c ? 0x80 : 0)) & 0xff;
    if (!this.d) {
      this.a = rotated;
      this._zn(this.a);
      this.c = (this.a & 0x40) !== 0;
      this.v = (((this.a >> 6) ^ (this.a >> 5)) & 1) !== 0;
      return;
    }
    this.n = this.c;
    this.z = rotated === 0;
    this.v = ((rotated ^ and) & 0x40) !== 0;
    if ((and & 0x0f) + (and & 0x01) > 0x05) rotated = (rotated & 0xf0) | ((rotated + 0x06) & 0x0f);
    if ((and & 0xf0) + (and & 0x10) > 0x50) {
      rotated = (rotated & 0x0f) | ((rotated + 0x60) & 0xf0);
      this.c = true;
    } else {
      this.c = false;
    }
    this.a = rotated & 0xff;
  }

  // SHA, SHX, SHY, TAS: the value ANDed with the base's high byte plus one, which is also the
  // high byte the store goes to when indexing crossed a page.
  _storeHigh(base, index, value) {
    let address = (base + index) & 0xffff;
    const stored = value & ((base >> 8) + 1) & 0xff;
    if ((base & 0xff00) !== (address & 0xff00)) address = (stored << 8) | (address & 0xff);
    this.write(address, stored);
  }

  _indirectBase() {
    const pointer = this._fetch();
    return this.read(pointer) | (this.read((pointer + 1) & 0xff) << 8);
  }

  _jsr() {
    const target = this._word();
    const ret = (this.pc - 1) & 0xffff;
    this._push(ret >> 8);
    this._push(ret & 0xff);
    this.pc = target;
  }

  _branch(taken) {
    const raw = this._fetch();
    if (!taken) return;
    const offset = raw < 0x80 ? raw : raw - 0x100;
    const target = (this.pc + offset) & 0xffff;
    this._branchCycles = (target & 0xff00) === (this.pc & 0xff00) ? 1 : 2;
    this.pc = target;
  }

  _zn(v) {
    this.z = (v & 0xff) === 0;
    this.n = (v & 0x80) !== 0;
  }

  _push(value) {
    this._place();
    this.bus.write(0x100 + (this.sp & 0xff), value & 0xff);
    this.sp = (this.sp - 1) & 0xff;
  }

  _pop() {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(0x100 + (this.sp & 0xff));
  }

  status() {
    return (this.c ? 1 : 0) | (this.z ? 2 : 0) | (this.i ? 4 : 0) | (this.d ? 8 : 0) | 0x20 | (this.v ? 0x40 : 0) | (this.n ? 0x80 : 0);
  }

  setStatus(v) {
    this.c = (v & 1) !== 0;
    this.z = (v & 2) !== 0;
    this.i = (v & 4) !== 0;
    this.d = (v & 8) !== 0;
    this.v = (v & 0x40) !== 0;
    this.n = (v & 0x80) !== 0;
  }
}

const INC = (_, v) => v + 1;
const DEC = (_, v) => v - 1;
const ASL = (cpu, v) => cpu._asl(v);
const LSR = (cpu, v) => cpu._lsr(v);
const ROL = (cpu, v) => cpu._rol(v);
const ROR = (cpu, v) => cpu._ror(v);
