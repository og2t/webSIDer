# webSIDer

See how a Commodore 64 `.sid` tune is built, in the browser. webSIDer runs the tune's own 6502 code
on an emulated C64, records every SID register write with its cycle, and writes the tune out as a
tracker would: each voice's rows, its instruments with their wave and pulse programs, and the
filter program, with the step that is sounding lit as the tune plays. The registers are also
drawn as graphs: the filter's cutoff, resonance, routing, mode and volume, and each voice's pulse
width and waveform bits. Each voice is also written out as sheet music, a staff a voice, under
the chords the voices and their arpeggios make together: named, and written on a grand staff as
voiced, so each inversion shows as it sounds. Keys 1-3 (1-9 on multi-SID tunes) turn voices off and on. The tune is
heard through a JavaScript port of reSID in an AudioWorklet; sheet music is engraved by VexFlow.

The analysis is a JavaScript port of [MagPlaySID](https://github.com/MagnarHarestad/MagPlaySID) by
Magnar Harestad: its SID chip (reSID by Dag Lem), its C64 (6510, CIAs, VIC raster interrupt, banked memory), its transcription into
a score, and its score player. The port is checked the same way MagPlaySID checks itself: playing
the score back has to make the tune's own register writes, call for call.

## Running it

No build step. Serve the folder and open it:

```bash
node tools/serve.mjs
```

Then drop a `.sid` on the page, or open `http://localhost:8653/?sid=path/to/tune.sid`.

## Layout

```
index.html, style.css     the page
src/sidfile.js            the PSID/RSID loader
src/cpu.js                the 6510, cycle by cycle
src/c64.js                the C64: memory map, CIAs, VIC, KERNAL stand-in
src/sidtune.js            the driver that starts a tune, and its song length
src/recording.js          a tune's writes, call by call
src/music.js              notes, instruments, programs, grid and patterns
src/score*.js             the score format and its player
src/transcriber.js        music plus a raw layer: a lossless score, and its agreement check
src/timeline.js           where the score is on every call
src/notation.js           each voice's notes on a grid of sixteenths, and chord detection
src/analysis-worker.js    the analysis, off the page
src/sid/                  the SID chip: reSID, as MagPlaySID carries it
src/audio/                the tune played live in an AudioWorklet, and the clock the views follow
src/view/                 tracker rows, instrument panel, sheet music, register graphs
tools/analyse.mjs         node tools/analyse.mjs [--whole] tune.sid ... - analysis and agreement in a terminal
tools/chords.mjs          node tools/chords.mjs [tune.sid] - chord naming checks, and a tune's notes and chords
tools/render.mjs          node tools/chords.mjs          node tools/chords.mjs [tune.sid] - chord naming checks, and a tune's notes and chords
tools/render.mjs tune.sid out.wav [seconds] - the JS SID to a WAV
```

## License

GPL v2 or later, as MagPlaySID is. See [LICENSE](LICENSE).
