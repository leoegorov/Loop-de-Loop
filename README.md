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

## Export / Import

**Export** downloads a single JSON file with the full project state and every
track's audio embedded as WAV. **Import** loads that file back.
