# Loop de Loop

Minimal, static web audio loop station. No build step, no dependencies.

## Run

Mic access requires a secure context (localhost is fine). From the repo root:

```sh
cd web
python3 -m http.server 5173
```

Open http://localhost:5173 and click **Enable Mic & Audio**.

## Project menu

The ☰ button to the left of the mode dropdown opens a modal with the project
name field (a random name is generated on load, 🎲 rerolls it), Export, and
Import. Export uses the project name for every downloaded file.

## Grid

The grid is a 2D canvas, not a fixed-size board — drag a module toward an
edge and more space appears past it, so the layout can grow up/down/left/
right, not just to the right of the last module. Modules can be dragged to
any cell, occupied or empty (dragging onto an occupied cell swaps the two).

## Modes

Pick a mode from the dropdown or with its shortcut key. The circular button in
each loop module behaves differently per mode:

| Mode | Key | Color | Behavior |
|---|---|---|---|
| Play/Pause | `p` | green | toggle play/stop |
| Play/Rec | `r` | red | toggle record (first press) / play (after) |
| Init/Delete | `i` | pink | click any empty cell within reach to add a module there; click any existing module (recorded or still empty) to remove it completely in one click |
| Trim | `t` | yellow | pick the section of the recording that plays back each cycle — see below |
| Volume | `v` | purple | vertical slider per module |
| Copy/Paste | `c` | blue | click a module to copy; click another module, or any empty cell within reach, to paste (pasting into an empty cell creates the module there directly, no need to init it first) |
| Zoom | `z` | light blue | click near the middle of the screen to zoom in (fewer, larger cells), click near the edges to zoom out (more, smaller cells) — the cursor previews zoom-in/zoom-out before you click |

Init/Delete and Copy/Paste can reach any empty cell within 5 cells (in any
direction) of an existing module — that's the region shown with a dashed
outline and "+" in Init/Delete mode. Outside Init/Delete mode, empty cells
have no outline at all; they're just empty space.

All loop lengths are quantized to whole multiples of the first recorded loop,
so every module realigns to its "12 o'clock" start in sync.

### Trim

Two handles sit on the position ring — `[` marks where playback of the
recording starts, `]` marks where it ends — and rotate as they move so their
bottom edge always faces the center, like a spoke. The yellow span between
them is the section that plays back once per the module's fixed cycle
length. Drag either handle independently to resize the window from that
side; drag the span itself to slide both handles together without resizing.
Since the cycle length never changes, a wider window means more audio has to
fit into the same cycle (faster) and a narrower one means less does
(slower) — that derived speed is shown in the middle of the button. Dragging
the span alone never changes it; only resizing a handle does.

A handle can be dragged more than a full turn away from the other one,
selecting more than one buffer-length per cycle (up to 4x) for speeds above
1.00x — the window wraps back around the recording, shown as a solid ring
with a small gap for whatever's left over.

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
`.wav` file per recorded track, all named after the current project name.
**Import** loads a previously exported project JSON back, restoring its name.
