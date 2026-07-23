# Loop de Loop

Minimal, static web audio loop station. No build step, no dependencies.

## Run

Mic access requires a secure context (localhost is fine). From the repo root:

```sh
cd web
python3 -m http.server 5173
```

Open http://localhost:5173 and click **Enable Mic & Audio**.

## Modes

Pick a mode from the dropdown or with its shortcut key. The circular button in
each loop module behaves differently per mode:

| Mode | Key | Color | Behavior |
|---|---|---|---|
| Play/Pause | `p` | green | toggle play/stop |
| Play/Rec | `r` | red | toggle record (first press) / play (after) |
| Init/Delete | `i` | pink | click empty cell to add a module; click a filled button to clear it; click an empty button to remove the module |
| Offset | `o` | yellow | drag the outer handle to shift a track's start point |
| Speed | `s` | orange | drag the strobe handle to change playback rate |
| Volume | `v` | purple | vertical slider per module |
| Copy/Paste | `c` | blue | click a module to copy, click another to paste |
| Zoom | `z` | light blue | click a module to fill the viewport, click again to exit |

All loop lengths are quantized to whole multiples of the first recorded loop,
so every module realigns to its "12 o'clock" start in sync.

### Launch quantization

Starting play or record is free the instant nothing else is playing. If other
modules are already playing, the click is deferred ("queued") until the next
moment they're all simultaneously back at their own 12 o'clock — the button
shows a pulsing dashed ring with a countdown while it waits. Ending playback
or a recording works the same way in reverse: it's always deferred to the
next valid boundary, never cut off mid-cycle, so a track's final length keeps
nesting cleanly with everything else already playing. Click a queued/pending
button again to cancel it.

A track that's actively recording pulses red and its position ring cycles
once per unit length with quarter-tick marks — a full lap does **not** mean
the recording is about to stop, only that it's crossed one more unit; it
keeps recording (and can be built up in whole-unit multiples) until you
request the end, which itself is queued the same way.

## Export / Import

**Export** downloads a JSON project file (full project state, with every
track's audio also embedded as WAV for re-import) plus a separate standalone
`.wav` file per recorded track. **Import** loads a previously exported
project JSON back.
