// webSIDer's colours: ink-blue panels, a teal accent, and a colour per voice.

export const palette = {
  background: '#0d1017',
  panel: '#131823',
  border: '#232b3b',
  title: '#eef2f8',
  subtitle: '#7d8799',
  control: '#cfd6e2',
  accent: '#59d8c5',
  resonance: '#f2c14e',
};

const VOICE_RGB = [
  [0x5e, 0xc8, 0xf2],
  [0xf2, 0x7f, 0xb2],
  [0xc4, 0xe3, 0x5b],
];

// A voice's colour, with an alpha from 0 to 255.
export const voiceColour = (voice, alpha = 255) => {
  const [r, g, b] = VOICE_RGB[voice % 3];
  return `rgba(${r},${g},${b},${alpha / 255})`;
};

export const withAlpha = (hexColour, alpha) => {
  const n = parseInt(hexColour.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 0xff},${n & 0xff},${alpha / 255})`;
};

export const MONO = '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
