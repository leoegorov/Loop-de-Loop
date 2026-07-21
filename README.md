# Loop-de-Loop

Minimal, static web audio loop station.

## Run

Mic access requires a secure context (localhost is OK). From the repo root:

```sh
cd web
python3 -m http.server 5173
```

Open:

- http://localhost:5173

## Controls

- **Add loop**: Adds a new loop module.
- **Module main button**:
  - Empty track: click to start recording
  - Recording: click to stop (quantizes to the next master-loop boundary when needed)
  - Playing: click to start overdub
  - Overdubbing: click to stop overdub
- **Drag the dot on the ring**: Offsets the track relative to the shared transport.
- **Vol slider**: Per-track volume.
- **Stop**: Stops that module.
- **Export / Import**: Save/restore a JSON file with embedded mono WAV audio.
