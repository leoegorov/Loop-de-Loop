# LOOPING - software loop station

A browser loop station with unlimited audio loop channels, per-channel FX chains,
and waveform editing.

## Run it

Any static file server works:

```bash
py -m http.server 8080
# or
npx serve .
```

Open http://localhost:8080 in Chrome or Edge, then click POWER ON and grant microphone access.

## How to use

1. Pick your audio input.
2. Hit a channel's main loop button:
   - empty -> REC
   - recording -> close loop & PLAY
   - playing -> OVERDUB
   - overdubbing -> PLAY
3. Use Quantize (Bar / Beat / Off) and 1st loop sets tempo as needed.
4. Add channels with + ADD AUDIO LOOP.
5. Per loop: volume, pitch transpose, STOP / UNDO / CLEAR, and FX.

## Effects

FX available on loop channels: Filter, Delay, Reverb, Distortion, Flanger, Chorus.

## Waveform editor

Use EDIT on a finished loop to open the waveform editor. Available tools:
TRIM, TRIM SIL, CUT, SILENCE, FADE IN/OUT, REVERSE, NORM, APPLY GAIN, SET START,
plus editor UNDO/RESET/APPLY.

## Export / import

- EXPORT: downloads a zip with one WAV stem per loop plus manifest.json.
- IMPORT: loads exported zips and loose .wav files.

## Controls

| Input | Action |
|---|---|
| 1-9 | Main loop button of channel 1-9 |
| Shift + 1-9 | Stop that channel |
| N | Add a loop channel |
| P | Play all stopped loops together |
| Space | Stop all loops |

## Deploy to GitHub Pages

This repo includes .github/workflows/deploy-pages.yml for static deployment.
Set Pages source to GitHub Actions, then push to main or run the workflow.
