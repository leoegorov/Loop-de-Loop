# LOOPING — software loop station

A Boss RC-style loop station in the browser: unlimited spawn-on-demand loop channels,
per-channel effect chains, sample-accurate loop sync, and **MIDI clock output** to keep
a hardware synth in time.

## Run it

Any static file server works. Easiest options:

```
py -m http.server 8080        # Python
npx serve .                   # Node
```

Then open **http://localhost:8080** in **Chrome or Edge** (they support Web MIDI +
AudioWorklet). Click **POWER ON** and grant microphone + MIDI permissions.

> Double-clicking `index.html` (file://) also works in Chrome in most setups, but the
> localhost route is the reliable one.

## How to use

1. **Pick your audio input** (your interface's input) and, under *MIDI clock out*, the
   MIDI port your synth is on.
2. Hit the big round button on a loop channel:
   - empty → **REC** (red)
   - recording → **close loop & PLAY** (green)
   - playing → **OVERDUB** (orange)
   - overdubbing → back to **PLAY**
3. With **1st loop sets tempo** on (default), your first loop is recorded freely; when
   you close it, the app guesses the bar count, locks the BPM, and starts sending MIDI
   clock + Start to your synth, aligned to your loop's downbeat.
   - Prefer a fixed tempo instead? Untick it, set the BPM, and every loop is quantized
     to the grid from the start.
4. **Quantize** (Bar / Beat / Off) controls when record/overdub/play/stop actions fire.
   Loops of different lengths stay phase-locked to the master grid, RC-505 style.
5. **＋ ADD LOOP** spawns a new channel — as many as you like.
6. Per channel: volume, STOP / UNDO (one level of overdub undo) / CLEAR, and an FX
   chain (low/high-pass filter, delay, reverb, distortion, chorus — stack freely).

### MIDI-triggered recording & MIDI loops

- **ARM**: arm an empty channel and recording starts the instant the first MIDI note
  arrives from your keyboard/synth — hands never leave the keys. (Notes mapped as
  controls via MIDI LEARN don't trigger it.)
- **♪ MIDI**: with this ticked, incoming MIDI notes/CCs are captured alongside the
  audio while recording or overdubbing. When the loop plays, the captured MIDI is sent
  back out of the *MIDI clock out* port in a phase-locked loop — your synth replays the
  part itself, on top of (or instead of) the audio loop. Overdubs add MIDI layers;
  UNDO removes the last layer's MIDI together with its audio; stopping a channel sends
  All Notes Off so nothing hangs.
- The event count next to ♪ MIDI shows how many MIDI events the loop holds.
- **AUTO**: with AUTO on, a recording closes itself once your MIDI input has been
  silent for the *Auto-end* time (top bar, default 2 s). The close is retroactive:
  the loop ends at your last note — rounded up to the quantize grid when a tempo grid
  exists — and the trailing silence is trimmed, so the timeout never ends up inside
  the loop. ARM + AUTO + ♪ MIDI together give a fully hands-free take: play a phrase,
  stop, and it loops.

### Perfect loops

With **Perfect loops** on (top bar, default on), every loop is cleaned up the moment
it closes, on the audio thread:

- **Leading-silence trim** — the dead time between hitting record (or the arm
  trigger) and your first actual sound is cut, with a 5 ms pre-roll, so the loop
  starts right on the first onset. Only applied to free-length loops (quantize off,
  or the tempo-defining first loop) — grid-locked loops keep their exact bar length.
  Because it runs *before* the tempo is calculated, the BPM guess from your first
  loop gets more accurate too.
- **Seam de-click** — a ~6 ms fade at the loop start and end so the wrap point never
  clicks or pops, re-applied after every overdub layer.

### Per-loop quantize

Each channel header has a **Q** dropdown (glob / bar / beat / off) that overrides the
global Quantize setting for that loop only — e.g. keep the global setting on Bar but
let one loop close on the beat.

### 808 drums

**DRUMS** (top bar, or `D`) opens a built-in synthesized 808 kit — kick, snare,
closed/open hat (closed chokes open, like the original), clap — with a 16-step
sequencer running on 16ths of the master bar, phase-locked to the transport and the
MIDI clock. Click steps to toggle, instrument names to preview, per-instrument levels
plus a kit volume. **PLAY** starts the pattern — and starts the clock at the current
BPM if nothing is running yet, so drums-first jamming works.

### Export / import

**EXPORT** downloads a zip with one WAV stem + one MIDI file per loop and a
`manifest.json` (BPM, sample rate). **IMPORT** loads such a zip back — each track
becomes a new loop channel with its audio and MIDI, and the tempo is restored (if the
grid isn't already locked). Loose `.wav`/`.mid` files and deflate-compressed zips work
too; imported loops arrive stopped and anchor themselves to the bar grid on first
play. A MIDI-only file becomes a silent loop of whole bars that plays its notes to
the synth.

### VST?

Not possible in a browser — no plugin hosting exists in Web Audio. The realistic
routes are Web Audio Modules (a small ecosystem of web-native plugins) or porting
this design to a native JUCE app, which would also unlock ASIO latency.

### Controls

| Input | Action |
|---|---|
| `1`–`9` | Main loop button of channel 1–9 |
| `Shift` + `1`–`9` | Stop that channel |
| `N` | Add a loop channel |
| `Space` | Stop all loops (clock keeps running) |

**MIDI controller:** click **MIDI LEARN**, click any control (loop buttons, stop/clear/
undo, volume sliders, STOP ALL, ADD LOOP), then press a pad/footswitch or turn a knob.
Bindings are saved in the browser. Volume maps to CCs as continuous values; buttons
trigger on note-on or CC > 63.

### Top-bar extras

- **Monitor** — hear the live input through the master output.
- **Comp (ms)** — latency compensation: shifts recorded/overdubbed audio earlier so it
  lands where you *heard* it, not where it arrived. The default is estimated from the
  audio output latency; if overdubs feel consistently late, raise it (try 20–40 ms).
- **STOP ALL** stops playback but keeps the MIDI clock running (synth stays in sync).
  **RESET** clears everything, unlocks the tempo, and sends MIDI Stop.

## Notes & limits

- Browsers can't use **ASIO** — Chrome talks to your interface via WASAPI. Latency is
  typically 10–20 ms, fine for looping; set your interface to a small buffer anyway.
- MIDI clock is scheduled with a look-ahead queue on Web MIDI timestamps, which keeps
  jitter low (well under typical hardware clock jitter), but the browser is not an
  atomic clock — for tightest sync keep the tab focused.
- Loop channels are capped at 5 minutes each; channel count is unbounded (each channel
  costs one AudioWorklet — dozens are fine on a modern machine).
- Changing BPM after loops exist is intentionally locked (no time-stretching); RESET to
  start a new tempo.
