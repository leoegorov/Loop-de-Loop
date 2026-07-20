# LOOPING — software loop station

A browser loop station with unlimited audio loop channels, per-channel FX chains,
waveform editing, automation loops, built-in drums, bass synth, PRIZM synth, and a
bar-based song arranger.

## Run it

Any static file server works:

```bash
py -m http.server 8080
# or
npx serve .
```

Open `http://localhost:8080` in Chrome or Edge, then click **POWER ON** and grant microphone access.

## How to use

1. Pick your audio input.
2. Hit a channel’s main loop button:
   - empty → **REC**
   - recording → **close loop & PLAY**
   - playing → **OVERDUB**
   - overdubbing → **PLAY**
3. Use **Quantize** (Bar / Beat / Off) and **1st loop sets tempo** as needed.
4. Add channels with **+ ADD AUDIO LOOP**.
5. Per loop: volume, pitch transpose, STOP / UNDO / CLEAR, and FX.

## Effects & automation

FX available on loops and instruments: Filter, Delay, Reverb, Distortion, Flanger,
Chorus. Parameters can be automated with drawable automation loops.

## Waveform editor

Use **EDIT** on a finished loop to open the waveform editor. Available tools:
TRIM, TRIM SIL, CUT, SILENCE, FADE IN/OUT, REVERSE, NORM, APPLY GAIN, SET START,
plus editor UNDO/RESET/APPLY.

## Instruments

- **DRUMS**: 808-style drum machine with pattern slots, per-row controls, samples,
  and polyrhythm step counts.
- **303**: TB-303-style bass synth with pattern slots and accent/slide controls.
- **PRIZM**: Dual refraction synth with on-screen keyboard/computer keyboard play,
  optional routing into the loop input bus.

## Song arranger

Use **SONG** to arrange loops, drums, bass, and automation on a bar timeline.
Supports 8–64 bars, zoom, loop playback, and per-track rendering.

## Export / import

- **EXPORT**: downloads a zip with one WAV stem per loop plus `manifest.json`.
- **IMPORT**: loads exported zips and loose `.wav` files.

## Controls

| Input | Action |
|---|---|
| `1`–`9` | Main loop button of channel 1–9 |
| `Shift` + `1`–`9` | Stop that channel |
| `N` | Add a loop channel |
| `P` | Play all: loops + drums + 303 together |
| `Space` | Stop all: loops, drums, and 303 |
| `D` | Show/hide drum machine |
| `B` | Show/hide 303 |

## Deploy to GitHub Pages

This repo includes `.github/workflows/deploy-pages.yml` for static deployment.
Set Pages source to **GitHub Actions**, then push to `main` or run the workflow.
