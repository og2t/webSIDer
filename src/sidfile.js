// A parsed PSID/RSID file: where its data loads, where init and play are, and how play is timed.
// Port of MagSid.Playback/SidFile.cs from MagPlaySID by Magnar Harestad (GPL v2+).

export class SidPlaybackError extends Error {}

const be16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];

function asciiField(bytes, offset) {
  let end = offset;
  while (end < offset + 32 && end < bytes.length && bytes[end] !== 0) end++;
  return String.fromCharCode(...bytes.subarray(offset, end)).trimEnd();
}

// A header's SID address byte: $Dxx0 with xx even, from $D420 to $D7E0 or at $DE00-$DFE0.
const isSidPage = (value) => (value & 1) === 0 && ((value >= 0x42 && value <= 0x7f) || (value >= 0xe0 && value <= 0xfe));

function extraSidFields(version, bytes) {
  return [
    { version: 3, address: 0x7a, modelBits: 6 },
    { version: 4, address: 0x7b, modelBits: 8 },
  ].filter((f) => version >= f.version && bytes.length > f.address && isSidPage(bytes[f.address]));
}

export class SidFile {
  static parse(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 0x76 + 2) throw new SidPlaybackError('Too short to be a .sid file - the header alone is 118 bytes.');

    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    if (magic !== 'PSID' && magic !== 'RSID') throw new SidPlaybackError(`Not a .sid file: it starts with "${magic}".`);

    const version = be16(bytes, 0x04);
    const dataOffset = be16(bytes, 0x06);
    if (dataOffset < 0x76 || dataOffset > bytes.length)
      throw new SidPlaybackError(`The header says its data starts at ${dataOffset}, which is outside the file.`);

    let loadAddress = be16(bytes, 0x08);
    const initAddress = be16(bytes, 0x0a);
    const playAddress = be16(bytes, 0x0c);
    let data = bytes.slice(dataOffset);

    // A load address of 0 means the real one is the data's first two bytes, as a .prg carries it.
    if (loadAddress === 0) {
      if (data.length < 2) throw new SidPlaybackError('The header defers the load address to the data, but there is none.');
      loadAddress = data[0] | (data[1] << 8);
      data = data.slice(2);
    }

    const flags = version >= 2 && bytes.length >= 0x78 ? be16(bytes, 0x76) : 0;
    const is8580 = ((flags >> 4) & 3) === 2;
    const fields = extraSidFields(version, bytes);

    const file = new SidFile();
    Object.assign(file, {
      isRsid: magic === 'RSID',
      version,
      name: asciiField(bytes, 0x16),
      author: asciiField(bytes, 0x36),
      released: asciiField(bytes, 0x56),
      loadAddress,
      initAddress: initAddress === 0 ? loadAddress : initAddress,
      playAddress,
      songs: Math.max(1, be16(bytes, 0x0e)),
      startSong: Math.max(1, be16(bytes, 0x10)),
      speed: ((bytes[0x12] << 24) | (bytes[0x13] << 16) | (bytes[0x14] << 8) | bytes[0x15]) >>> 0,
      data,
      is8580,
      videoStandard: (flags >> 2) & 3,
      isBasic: magic === 'RSID' && (flags & 2) !== 0,
      freePage: version >= 2 && bytes.length >= 0x7a ? bytes[0x78] : 0,
      freePages: version >= 2 && bytes.length >= 0x7a ? bytes[0x79] : 0,
      extraSids: fields.map((f) => 0xd000 | (bytes[f.address] << 4)),
      extraSids8580: fields.map((f) => {
        const bits = (flags >> f.modelBits) & 3;
        return bits === 2 ? true : bits === 1 ? false : is8580;
      }),
    });
    return file;
  }

  // Whether a song (from 1) is played on CIA 1's timer; songs past the 32nd share the last bit.
  usesCiaTimer(song) {
    return ((this.speed >>> (Math.min(Math.max(song, 1), 32) - 1)) & 1) !== 0;
  }

  // The header names NTSC alone.
  get isNtsc() {
    return this.videoStandard === 2;
  }
}
