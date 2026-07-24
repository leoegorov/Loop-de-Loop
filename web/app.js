import { encodeWavMono16, arrayBufferToBase64, base64ToArrayBuffer } from './wav.js';

const MODES = ['playpause', 'playrec', 'initdel', 'trim', 'volume', 'copypaste', 'zoom'];
const SHORTCUTS = { p: 'playpause', r: 'playrec', i: 'initdel', t: 'trim', v: 'volume', c: 'copypaste', z: 'zoom' };
const MIN_TRIM = 0.02;  // smallest trim window, as a fraction of the buffer
const MAX_TRIM_SPAN = 4; // largest trim window, in buffer-lengths (so up to 4x speed)

const NAME_ADJ = ['velvet', 'crimson', 'hollow', 'silent', 'neon', 'dusty', 'fractal', 'loose', 'tidal', 'amber', 'wild', 'glass', 'copper', 'faint', 'solar', 'lunar', 'static', 'warm', 'cold', 'bright'];
const NAME_NOUN = ['echo', 'loop', 'groove', 'pulse', 'drift', 'signal', 'chorus', 'tape', 'delay', 'fuzz', 'current', 'orbit', 'ember', 'wave', 'beat', 'riff', 'haze', 'spark', 'tempo', 'vinyl'];

function randomProjectName() {
  const a = NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)];
  const n = NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)];
  return `${a}-${n}`;
}

function sanitizeFilename(name) {
  const cleaned = (name || '').trim().replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'untitled';
}

const body = document.body;
const modeSelect = document.getElementById('modeSelect');
const gridEl = document.getElementById('grid');
const startOverlay = document.getElementById('startOverlay');
const startBtn = document.getElementById('startBtn');
const startError = document.getElementById('startError');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importInput = document.getElementById('importInput');
const projectNameInput = document.getElementById('projectNameInput');
const randomNameBtn = document.getElementById('randomNameBtn');
const menuBtn = document.getElementById('menuBtn');
const projectModal = document.getElementById('projectModal');
const modalCloseBtn = document.getElementById('modalCloseBtn');

let currentMode = 'playpause';
let uidCounter = 1;
let projectName = randomProjectName();

// --- Audio state ---
let audioCtx = null;
let micSource = null;
let recorderNode = null;
let recorderSilentGain = null;
let recordingTrack = null;

let unitLength = null;       // seconds; duration of one "unit" (first recorded track)
let masterStartTime = null;  // audioCtx time anchor for the shared transport, fixed for the project's life
let globalMegacycle = null;
let globalNextBoundary = null;

let tracks = [];             // array of track objects, each with a row/col position
let clipboard = null;
let dragSrcId = null;

// ---------- Zoom (click-position-based cell scaling) ----------

const ZOOM_MIN_PX = 50;
const ZOOM_MAX_PX = 500;
const ZOOM_FACTOR = 1.3;
const ZOOM_CENTER_RADIUS = 0.5; // fraction of half-screen; inside = zoom in, outside = zoom out
const INITDEL_REACH = 5;        // Chebyshev distance within which empty cells can be initialized/pasted into

let cellSizePx = null; // null until first resolved from the responsive CSS default

function currentCellSizePx() {
  if (cellSizePx !== null) return cellSizePx;
  const el = gridEl.querySelector('.cell');
  return el ? el.getBoundingClientRect().width : 180;
}

function setCellSizePx(px) {
  cellSizePx = Math.max(ZOOM_MIN_PX, Math.min(ZOOM_MAX_PX, px));
  body.style.setProperty('--cell-size', cellSizePx + 'px');
}

function zoomDistance(clientX, clientY) {
  const dx = (clientX - window.innerWidth / 2) / (window.innerWidth / 2);
  const dy = (clientY - window.innerHeight / 2) / (window.innerHeight / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

function isZoomInAt(clientX, clientY) {
  return zoomDistance(clientX, clientY) < ZOOM_CENTER_RADIUS;
}

// Custom magnifying-glass cursors (native zoom-in/zoom-out glyphs are too
// subtle/inconsistent across browsers to read as "zoom" at a glance).
function magnifierCursor(zoomIn) {
  const sign = zoomIn
    ? '<line x1="11" y1="7" x2="11" y2="15" stroke="#7fdcff" stroke-width="2.5" stroke-linecap="round"/>'
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">`
    + `<circle cx="11" cy="11" r="8" fill="rgba(0,0,0,.55)" stroke="#7fdcff" stroke-width="2.5"/>`
    + `<line x1="17" y1="17" x2="25" y2="25" stroke="#7fdcff" stroke-width="3" stroke-linecap="round"/>`
    + `<line x1="7" y1="11" x2="15" y2="11" stroke="#7fdcff" stroke-width="2.5" stroke-linecap="round"/>`
    + `${sign}</svg>`;
  const fallback = zoomIn ? 'zoom-in' : 'zoom-out';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 11 11, ${fallback}`;
}

const ZOOM_IN_CURSOR = magnifierCursor(true);
const ZOOM_OUT_CURSOR = magnifierCursor(false);
let lastMouseX = window.innerWidth / 2;
let lastMouseY = window.innerHeight / 2;

function updateZoomCursor(clientX, clientY) {
  body.style.cursor = isZoomInAt(clientX, clientY) ? ZOOM_IN_CURSOR : ZOOM_OUT_CURSOR;
}

function mod(a, n) { return ((a % n) + n) % n; }
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }
function lcm2(a, b) { return (a / gcd(a, b)) * b; }
function lcmAll(nums) { return nums.reduce((acc, n) => lcm2(acc, n), 1); }

// Describes an SVG arc path from startFrac to endFrac (endFrac >= startFrac,
// both in absolute "laps" - can exceed 1 or be negative) on a circle of
// radius r centered at (50,50), 0 = 12 o'clock, increasing clockwise. Drawn
// as an explicit path rather than a dasharray trick, since a dasharray's
// period has to match the browser's own rendered path length exactly (which
// can drift slightly from a hand-computed 2*pi*r) or a faint duplicate strip
// shows up at the seam.
function describeArc(startFrac, endFrac, r) {
  const span = endFrac - startFrac;
  if (span <= 1e-6) return '';
  const toXY = (frac) => {
    const a = mod(frac, 1) * 2 * Math.PI;
    return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
  };
  if (span >= 1 - 1e-6) {
    // A single <path> arc command can't express a full 360 degrees, so a
    // full (or more than full) lap is drawn as two half-circle arcs.
    const [x1, y1] = toXY(startFrac);
    const [x2, y2] = toXY(startFrac + 0.5);
    return `M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2} A ${r} ${r} 0 1 1 ${x1} ${y1}`;
  }
  const [sx, sy] = toXY(startFrac);
  const [ex, ey] = toXY(endFrac);
  const largeArc = span > 0.5 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`;
}

// The trim window [trimStart, trimEnd] (fractions of the buffer) is what
// plays back once per the track's fixed nominal cycle (lengthUnits *
// unitLength). Since that cycle duration never changes, a wider window means
// more audio has to fit in the same time -> faster; a narrower one -> slower.
function updateSpeedFactor(track) {
  if (!track.buffer || !unitLength) { track.speedFactor = 1; return; }
  const trimmedDur = Math.max((track.trimEnd - track.trimStart) * track.buffer.duration, 0.001);
  track.speedFactor = trimmedDur / (track.lengthUnits * unitLength);
}

function makeTrack(row, col) {
  return {
    id: uidCounter++,
    row, col,
    buffer: null,
    lengthUnits: null,
    autoPhaseOffset: 0,
    trimStart: 0,     // fraction of buffer duration (0..1), start of the played-back section
    trimEnd: 1,       // fraction of buffer duration (0..1), end of the played-back section
    speedFactor: 1,   // derived from the trim window's width; see updateSpeedFactor()
    volume: 1,
    gainNode: null,
    sourceNode: null,
    playing: false,
    recording: false,
    recordChunks: [],
    recordStartTime: null,
    loopAnchorTime: null,
    nextOwnBoundary: null,    // set only when the trim window wraps past the buffer's end
    pausedPhase: 0,
    queuedAction: null,       // null | 'play' | 'stopPlay' | 'record' | 'endRecord'
    queuedTime: null,
    queuedLengthUnits: null,
    el: null,
  };
}

tracks.push(makeTrack(0, 0));

// ---------- Audio engine ----------

async function initAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micSource = ctx.createMediaStreamSource(stream);
    await ctx.audioWorklet.addModule('audio-worklet.js');
    recorderNode = new AudioWorkletNode(ctx, 'recorder-processor');
    recorderNode.port.onmessage = (e) => {
      if (recordingTrack) recordingTrack.recordChunks.push(e.data);
    };
    recorderSilentGain = ctx.createGain();
    recorderSilentGain.gain.value = 0;
    micSource.connect(recorderNode);
    recorderNode.connect(recorderSilentGain);
    recorderSilentGain.connect(ctx.destination);
  } catch (err) {
    try { ctx.close(); } catch (e2) { /* noop */ }
    micSource = null;
    recorderNode = null;
    recorderSilentGain = null;
    throw err;
  }

  audioCtx = ctx;
  for (const t of tracks) ensureGain(t);
}

function ensureGain(track) {
  if (!track.gainNode && audioCtx) {
    track.gainNode = audioCtx.createGain();
    track.gainNode.gain.value = track.volume;
    track.gainNode.connect(audioCtx.destination);
  }
}

// ---------- Sync engine ----------
//
// masterStartTime + unitLength define a permanent grid, fixed once the first
// loop is recorded. Every track's length is a whole multiple of unitLength.
// Starting play/record is free the instant nothing else is playing; if other
// tracks are playing, the action is queued until the next moment all of them
// are simultaneously back at their own 12 o'clock (a common multiple of their
// lengths). Ending playback or a recording is always queued the same way,
// this time including the track's own length too, so it never gets cut mid
// cycle and its resulting length is guaranteed to nest with whatever else is
// playing.

function activePlayingLengths(excludeTrack) {
  const lens = [];
  for (const t of tracks) {
    if (t !== excludeTrack && t.buffer && t.playing) lens.push(t.lengthUnits);
  }
  return lens;
}

function nextBoundaryForLengths(now, lengths) {
  if (!lengths.length) return now;
  const period = lcmAll(lengths) * unitLength;
  const k = Math.ceil((now - masterStartTime) / period - 1e-9);
  return masterStartTime + Math.max(k, 0) * period;
}

function currentMegacycle() {
  let maxLen = unitLength || 0.001;
  for (const t of tracks) {
    if (t.buffer && t.playing) maxLen = Math.max(maxLen, t.lengthUnits * unitLength);
  }
  return maxLen;
}

function resyncAll(atTime) {
  if (masterStartTime === null || !audioCtx) return;
  const now = atTime !== undefined ? atTime : audioCtx.currentTime;
  const megacycle = currentMegacycle();
  const k = Math.floor((now - masterStartTime) / megacycle);
  const anchor = masterStartTime + k * megacycle;
  for (const t of tracks) {
    if (t.playing && t.buffer) scheduleTrackAt(t, now, anchor);
  }
  globalMegacycle = megacycle;
  globalNextBoundary = anchor + megacycle;
}

// A trim window can be wider than one buffer-length (speedFactor > 1, reading
// past the buffer's end and wrapping), or simply sit somewhere that wraps
// after a span-drag (e.g. trimStart=1.2). Either way, if the *wrapped*
// window crosses the buffer's physical end, Web Audio's loopStart/loopEnd
// can't express it directly (they can only bound a single sub-range), so
// that case loops the whole buffer instead and gets explicitly restarted
// every one of the track's own nominal cycles to stay aligned - see
// trackNextOwnBoundary().
function trackWrapsBuffer(track) {
  const span = track.trimEnd - track.trimStart;
  return mod(track.trimStart, 1) + span > 1 + 1e-9;
}

function trackNextOwnBoundary(track, atTime) {
  const nominalDuration = track.lengthUnits * unitLength;
  const k = Math.floor((atTime - masterStartTime) / nominalDuration + 1e-9) + 1;
  return masterStartTime + k * nominalDuration;
}

function scheduleTrackAt(track, atTime, anchor) {
  ensureGain(track);
  const bufDur = track.buffer.duration;
  const span = track.trimEnd - track.trimStart;
  const trimmedDur = Math.max(span * bufDur, 0.001);
  const phaseInTrim = mod((atTime - anchor) * track.speedFactor + track.autoPhaseOffset, trimmedDur);
  const absolutePos = track.trimStart + phaseInTrim / bufDur;
  const readPos = mod(absolutePos, 1) * bufDur;

  if (track.sourceNode) {
    try { track.sourceNode.stop(atTime); } catch (e) { /* already stopped */ }
  }
  const src = audioCtx.createBufferSource();
  src.buffer = track.buffer;
  src.loop = true;
  const wraps = trackWrapsBuffer(track);
  if (wraps) {
    src.loopStart = 0;
    src.loopEnd = bufDur;
    track.nextOwnBoundary = trackNextOwnBoundary(track, atTime);
  } else {
    const wrappedStart = mod(track.trimStart, 1);
    src.loopStart = wrappedStart * bufDur;
    src.loopEnd = (wrappedStart + span) * bufDur;
    track.nextOwnBoundary = null;
  }
  src.playbackRate.value = track.speedFactor;
  src.connect(track.gainNode);
  src.start(atTime, readPos);
  track.sourceNode = src;
  track.loopAnchorTime = anchor;
}

// Absolute (unwrapped) position, in buffer-lengths, of where playback
// currently is within the trim window - e.g. 1.3 means "30% into the second
// pass through the buffer". Used for the ring's visual arc, which needs to
// know how far past trimStart the current position is, not just its wrapped
// buffer offset.
function trackAbsolutePosition(track, now) {
  if (!track.buffer) return 0;
  const bufDur = track.buffer.duration;
  if (!track.playing) return track.pausedPhase / bufDur;
  const anchor = track.loopAnchorTime !== null ? track.loopAnchorTime : now;
  const span = track.trimEnd - track.trimStart;
  const trimmedDur = Math.max(span * bufDur, 0.001);
  const phaseInTrim = mod((now - anchor) * track.speedFactor + track.autoPhaseOffset, trimmedDur);
  return track.trimStart + phaseInTrim / bufDur;
}

function trackPhase01(track, now) {
  if (!track.buffer) return 0;
  return mod(trackAbsolutePosition(track, now), 1);
}

// ---------- Immediate actions (only ever called at the exact resolved time) ----------

function doStartPlayback(track, atTime) {
  if (!track.buffer) return;
  ensureGain(track);
  if (masterStartTime === null) masterStartTime = atTime;
  track.playing = true;
  resyncAll(atTime);
}

function doStopPlayback(track, atTime) {
  if (track.sourceNode) {
    try { track.sourceNode.stop(atTime); } catch (e) { /* noop */ }
    track.sourceNode = null;
  }
  if (track.buffer) track.pausedPhase = trackPhase01(track, atTime) * track.buffer.duration;
  track.playing = false;
}

function doStartRecording(track, atTime) {
  if (track.playing) doStopPlayback(track, atTime);
  track.recordChunks = [];
  track.recordStartTime = atTime;
  track.recording = true;
  recordingTrack = track;
  recorderNode.port.postMessage('start');
}

function concatFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function finalizeRecording(track, atTime) {
  recorderNode.port.postMessage('stop');
  track.recording = false;
  recordingTrack = null;

  const raw = concatFloat32(track.recordChunks);
  track.recordChunks = [];
  const sampleRate = audioCtx.sampleRate;

  let lengthUnits;
  const isFirstEver = unitLength === null;
  if (isFirstEver) {
    unitLength = Math.max(raw.length / sampleRate, 0.05);
    lengthUnits = 1;
    masterStartTime = track.recordStartTime;
    track.autoPhaseOffset = 0;
  } else {
    lengthUnits = track.queuedLengthUnits || Math.max(1, Math.round((raw.length / sampleRate) / unitLength));
    track.autoPhaseOffset = mod(track.recordStartTime - masterStartTime, unitLength);
  }

  const quantizedSamples = Math.round(lengthUnits * unitLength * sampleRate);
  const finalData = new Float32Array(quantizedSamples);
  finalData.set(raw.subarray(0, Math.min(raw.length, quantizedSamples)));
  const audioBuffer = audioCtx.createBuffer(1, quantizedSamples, sampleRate);
  audioBuffer.copyToChannel(finalData, 0);

  track.buffer = audioBuffer;
  track.lengthUnits = lengthUnits;
  track.trimStart = 0;
  track.trimEnd = 1;
  updateSpeedFactor(track);
  track.queuedLengthUnits = null;

  doStartPlayback(track, atTime);
  render();
}

// ---------- Queued (launch-quantized) requests ----------

function cancelQueued(track) {
  track.queuedAction = null;
  track.queuedTime = null;
  track.queuedLengthUnits = null;
}

function executeQueued(track) {
  const action = track.queuedAction;
  const time = track.queuedTime;
  track.queuedAction = null;
  track.queuedTime = null;
  if (action === 'play') doStartPlayback(track, time);
  else if (action === 'stopPlay') doStopPlayback(track, time);
  else if (action === 'record') doStartRecording(track, time);
  else if (action === 'endRecord') finalizeRecording(track, time);
}

function requestPlay(track) {
  if (!track.buffer || track.queuedAction) return;
  const now = audioCtx.currentTime;
  const others = activePlayingLengths(track);
  if (!others.length) { doStartPlayback(track, now); return; }
  track.queuedAction = 'play';
  track.queuedTime = nextBoundaryForLengths(now, others);
}

function requestStopPlay(track) {
  if (!track.playing || track.queuedAction) return;
  const now = audioCtx.currentTime;
  const lens = activePlayingLengths(track);
  lens.push(track.lengthUnits);
  track.queuedAction = 'stopPlay';
  track.queuedTime = nextBoundaryForLengths(now, lens);
}

function requestRecordStart(track) {
  if (track.queuedAction || recordingTrack) return;
  const now = audioCtx.currentTime;
  if (unitLength === null) { doStartRecording(track, now); return; }
  const others = activePlayingLengths(track);
  if (!others.length) { doStartRecording(track, now); return; }
  track.queuedAction = 'record';
  track.queuedTime = nextBoundaryForLengths(now, others);
}

function requestRecordStop(track) {
  if (!track.recording || track.queuedAction) return;
  const now = audioCtx.currentTime;
  if (unitLength === null) { finalizeRecording(track, now); return; }
  const others = activePlayingLengths(track);
  let t, n;
  if (!others.length) {
    n = Math.max(1, Math.ceil((now - track.recordStartTime) / unitLength - 1e-9));
    t = track.recordStartTime + n * unitLength;
  } else {
    const period = lcmAll(others) * unitLength;
    const k = Math.max(1, Math.ceil((now - masterStartTime) / period - 1e-9));
    t = masterStartTime + k * period;
    n = Math.round((t - track.recordStartTime) / unitLength);
  }
  track.queuedAction = 'endRecord';
  track.queuedTime = t;
  track.queuedLengthUnits = n;
}

function togglePlayPause(track) {
  if (track.queuedAction === 'play' || track.queuedAction === 'stopPlay') { cancelQueued(track); return; }
  if (!track.buffer) return;
  if (track.playing) requestStopPlay(track);
  else requestPlay(track);
}

function togglePlayRec(track) {
  if (track.queuedAction === 'record' || track.queuedAction === 'endRecord') { cancelQueued(track); return; }
  if (track.recording) { requestRecordStop(track); return; }
  if (track.buffer) { togglePlayPause(track); return; }
  requestRecordStart(track);
}

// ---------- Hard stop (used by destructive/structural edits, not queued) ----------

function hardStop(track) {
  cancelQueued(track);
  if (track.recording) {
    recorderNode.port.postMessage('stop');
    track.recording = false;
    recordingTrack = null;
    track.recordChunks = [];
  }
  if (track.sourceNode) {
    try { track.sourceNode.stop(); } catch (e) { /* noop */ }
    track.sourceNode = null;
  }
  track.playing = false;
}

function removeTrack(track) {
  hardStop(track);
  if (track.gainNode) { try { track.gainNode.disconnect(); } catch (e) {} }
  tracks = tracks.filter((t) => t !== track);
  if (!tracks.some((t) => t.buffer)) {
    unitLength = null;
    masterStartTime = null;
    globalMegacycle = null;
    globalNextBoundary = null;
  }
}

// ---------- 2D grid geometry ----------

function trackAt(row, col) {
  return tracks.find((t) => t.row === row && t.col === col) || null;
}

function gridBounds() {
  if (!tracks.length) return { minR: 0, maxR: 0, minC: 0, maxC: 0 };
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const t of tracks) {
    minR = Math.min(minR, t.row); maxR = Math.max(maxR, t.row);
    minC = Math.min(minC, t.col); maxC = Math.max(maxC, t.col);
  }
  return { minR, maxR, minC, maxC };
}

function isReachableSlot(row, col) {
  for (const t of tracks) {
    if (Math.max(Math.abs(t.row - row), Math.abs(t.col - col)) <= INITDEL_REACH) return true;
  }
  return false;
}

// ---------- UI: mode handling ----------

function updateBodyClasses() {
  body.className = 'mode-' + currentMode + (clipboard ? ' clipboard-active' : '');
}

function setMode(mode) {
  currentMode = mode;
  modeSelect.value = mode;
  if (mode === 'zoom') updateZoomCursor(lastMouseX, lastMouseY);
  else body.style.cursor = '';
  render();
}

modeSelect.addEventListener('change', () => setMode(modeSelect.value));

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const key = e.key.toLowerCase();
  if (SHORTCUTS[key]) setMode(SHORTCUTS[key]);
});

// Zoom mode: clicking near the middle of the screen zooms in (fewer,
// larger cells); clicking near the edges zooms out (more, smaller cells).
// The cursor (a magnifying glass with +/-) previews which one a click will do.
window.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  if (currentMode !== 'zoom') return;
  updateZoomCursor(e.clientX, e.clientY);
});
gridEl.addEventListener('click', (e) => {
  if (currentMode !== 'zoom') return;
  const zoomIn = isZoomInAt(e.clientX, e.clientY);
  const px = currentCellSizePx();
  setCellSizePx(zoomIn ? px * ZOOM_FACTOR : px / ZOOM_FACTOR);
  render();
});

// ---------- Project menu modal ----------

menuBtn.addEventListener('click', () => { projectModal.hidden = false; });
modalCloseBtn.addEventListener('click', () => { projectModal.hidden = true; });
projectModal.addEventListener('click', (e) => {
  if (e.target === projectModal) projectModal.hidden = true;
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !projectModal.hidden) projectModal.hidden = true;
});

// ---------- Project name ----------

projectNameInput.value = projectName;
projectNameInput.addEventListener('input', () => { projectName = projectNameInput.value; });
randomNameBtn.addEventListener('click', () => {
  projectName = randomProjectName();
  projectNameInput.value = projectName;
});

// ---------- Grid rendering ----------

function render() {
  updateBodyClasses();
  gridEl.innerHTML = '';

  // Init/delete and copy/paste can reach further than the plain 1-cell
  // padding used elsewhere (which just gives drag-to-extend room).
  const pad = (currentMode === 'initdel' || currentMode === 'copypaste') ? INITDEL_REACH : 1;
  const { minR, maxR, minC, maxC } = gridBounds();
  const r0 = minR - pad, r1 = maxR + pad, c0 = minC - pad, c1 = maxC + pad;
  const rows = r1 - r0 + 1, cols = c1 - c0 + 1;
  gridEl.style.gridTemplateColumns = `repeat(${cols}, var(--cell-size))`;
  gridEl.style.gridTemplateRows = `repeat(${rows}, var(--cell-size))`;

  let centerEl = null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const track = trackAt(r, c);
      const cellEl = track ? buildModuleCell(track) : buildSlotCell(r, c, isReachableSlot(r, c));
      cellEl.style.gridRow = String(r - r0 + 1);
      cellEl.style.gridColumn = String(c - c0 + 1);
      gridEl.appendChild(cellEl);
      if (track && (centerEl === null || track.id === tracks[0].id)) centerEl = cellEl;
    }
  }
  if (centerEl) centerEl.scrollIntoView({ block: 'center', inline: 'center' });
}

function setupDragTarget(cell, getRow, getCol) {
  cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
  cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
  cell.addEventListener('drop', (e) => {
    e.preventDefault();
    cell.classList.remove('drag-over');
    if (dragSrcId === null) return;
    const dragged = tracks.find((t) => t.id === dragSrcId);
    dragSrcId = null;
    if (!dragged) return;
    const row = getRow(), col = getCol();
    if (dragged.row === row && dragged.col === col) return;
    const occupant = trackAt(row, col);
    if (occupant && occupant !== dragged) {
      occupant.row = dragged.row; occupant.col = dragged.col;
    }
    dragged.row = row; dragged.col = col;
    render();
  });
}

function buildSlotCell(row, col, reachable) {
  const cell = document.createElement('div');
  cell.className = 'cell slot' + (reachable ? ' reachable' : '');
  cell.setAttribute('role', 'listitem');
  cell.draggable = false;
  setupDragTarget(cell, () => row, () => col);
  cell.addEventListener('click', () => {
    if (!audioCtx || !reachable) return;
    if (currentMode === 'initdel') {
      const t = makeTrack(row, col);
      ensureGain(t);
      tracks.push(t);
      render();
    } else if (currentMode === 'copypaste' && clipboard) {
      const t = makeTrack(row, col);
      tracks.push(t);
      pasteInto(t, clipboard);
      clipboard = null;
      render();
    }
  });
  return cell;
}

function buildModuleCell(track) {
  const cell = document.createElement('div');
  cell.className = 'cell module' + (track.buffer ? '' : ' empty') + (clipboard && clipboard.sourceId === track.id ? ' copied' : '');
  cell.setAttribute('role', 'listitem');

  cell.draggable = !['trim', 'volume'].includes(currentMode);
  cell.addEventListener('dragstart', () => { dragSrcId = track.id; cell.classList.add('dragging'); });
  cell.addEventListener('dragend', () => { cell.classList.remove('dragging'); });
  setupDragTarget(cell, () => track.row, () => track.col);

  if (currentMode === 'volume') {
    cell.appendChild(buildVolumeControl(track));
  } else {
    cell.appendChild(buildModuleSvg(track));
  }

  cell.addEventListener('click', () => onCellClick(track));
  return cell;
}

function buildVolumeControl(track) {
  const wrap = document.createElement('div');
  wrap.className = 'volume-wrap';
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'volume-slider';
  input.draggable = false;
  input.min = '0';
  input.max = '1.5';
  input.step = '0.01';
  input.value = String(track.volume);
  const stop = (e) => e.stopPropagation();
  input.addEventListener('click', stop);
  input.addEventListener('mousedown', stop);
  input.addEventListener('touchstart', stop, { passive: true });
  input.addEventListener('dragstart', (e) => e.preventDefault());
  input.addEventListener('input', () => {
    track.volume = parseFloat(input.value);
    ensureGain(track);
    if (track.gainNode) track.gainNode.gain.value = track.volume;
  });
  wrap.appendChild(input);
  return wrap;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function buildModuleSvg(track) {
  const svg = svgEl('svg', { viewBox: '0 0 100 100', class: 'module-svg' });
  const bg = svgEl('circle', { class: 'ring-bg', cx: 50, cy: 50, r: 42 });
  svg.appendChild(bg);

  if (currentMode === 'trim' && track.buffer) {
    const spanArc = svgEl('path', { class: 'trim-span' });
    svg.appendChild(spanArc);
    buildTrimHandles(svg, track, spanArc);
  }

  const pos = svgEl('path', { class: 'ring-pos' });
  svg.appendChild(pos);

  // Quarter-cycle tick marks: shown while recording to hint that the loop
  // can only actually end on one of these marks (or 12 o'clock), not just
  // whenever the ring happens to complete a lap.
  const ticks = svgEl('g', { class: 'quarter-ticks' });
  ticks.style.opacity = '0';
  [0, 90, 180, 270].forEach((deg) => {
    const rad = (deg * Math.PI) / 180;
    const r1 = 36, r2 = 44;
    const x1 = 50 + r1 * Math.sin(rad), y1 = 50 - r1 * Math.cos(rad);
    const x2 = 50 + r2 * Math.sin(rad), y2 = 50 - r2 * Math.cos(rad);
    ticks.appendChild(svgEl('line', { x1, y1, x2, y2 }));
  });
  svg.appendChild(ticks);

  const core = svgEl('circle', { class: 'core-circle core-btn', cx: 50, cy: 50, r: 22 });
  svg.appendChild(core);

  const label = svgEl('text', { class: 'core-label', x: 50, y: 52 });
  svg.appendChild(label);

  track.el = { svg, pos, core, label, ticks };
  applyVisualState(track, audioCtx ? audioCtx.currentTime : 0);
  return svg;
}

// Trim mode: a yellow span between two draggable handles ('[' and ']') marks
// the section of the buffer that plays back once per the track's fixed
// nominal cycle. Dragging a handle resizes the window from that end (which
// changes the derived speed); dragging the span translates both handles
// together, keeping the window's width - and therefore the speed - fixed.
function buildTrimHandles(svg, track, spanArc) {
  const startHandle = svgEl('text', { class: 'trim-handle', x: 50, y: 8 });
  startHandle.textContent = '[';
  const endHandle = svgEl('text', { class: 'trim-handle', x: 50, y: 8 });
  endHandle.textContent = ']';

  function placeHandle(el, frac) {
    const angleDeg = mod(frac, 1) * 360;
    const angle = (angleDeg * Math.PI) / 180;
    const x = 50 + 42 * Math.sin(angle);
    const y = 50 - 42 * Math.cos(angle);
    el.setAttribute('x', String(x));
    el.setAttribute('y', String(y));
    // Rotate so the glyph's bottom edge always faces the circle's center,
    // like a spoke, instead of staying upright as it moves around the ring.
    el.setAttribute('transform', `rotate(${angleDeg} ${x} ${y})`);
  }

  function redraw() {
    spanArc.setAttribute('d', describeArc(track.trimStart, track.trimEnd, 42));
    placeHandle(startHandle, track.trimStart);
    placeHandle(endHandle, track.trimEnd);
  }
  redraw();

  // Rotary drags accumulate the continuous (unwrapped) angle turned, rather
  // than snapping to an absolute 0-360 reading, so a handle can be dragged
  // more than a full turn away from the other one (span > 1 buffer-length,
  // i.e. faster than 1.00x).
  attachRotaryDrag(svg, startHandle, () => track.trimStart, (value) => {
    let start = Math.min(value, track.trimEnd - MIN_TRIM);
    start = Math.max(start, track.trimEnd - MAX_TRIM_SPAN);
    track.trimStart = start;
    updateSpeedFactor(track);
    if (track.playing) resyncAll();
    redraw();
  });

  attachRotaryDrag(svg, endHandle, () => track.trimEnd, (value) => {
    let end = Math.max(value, track.trimStart + MIN_TRIM);
    end = Math.min(end, track.trimStart + MAX_TRIM_SPAN);
    track.trimEnd = end;
    updateSpeedFactor(track);
    if (track.playing) resyncAll();
    redraw();
  });

  let dragStartTrimStart = 0;
  let dragStartTrimEnd = 1;
  attachSpanDrag(svg, spanArc,
    () => { dragStartTrimStart = track.trimStart; dragStartTrimEnd = track.trimEnd; },
    (deltaFrac) => {
      const span = dragStartTrimEnd - dragStartTrimStart;
      track.trimStart = dragStartTrimStart + deltaFrac;
      track.trimEnd = track.trimStart + span;
      // Span width (and therefore speed) is unchanged by this drag.
      if (track.playing) resyncAll();
      redraw();
    });

  svg.appendChild(startHandle);
  svg.appendChild(endHandle);
}

// Like attachDrag, but reports a continuously accumulating (unwrapped) value
// instead of an absolute 0-360 angle, so dragging past the seam keeps going
// instead of snapping back - needed so a handle can be wound more than a
// full turn away from the other one.
function attachRotaryDrag(svg, target, getValue, onValue) {
  let dragging = false;
  let lastAngle = 0;
  let value = 0;
  const angleAt = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return mod(Math.atan2(clientX - cx, -(clientY - cy)) * (180 / Math.PI), 360);
  };
  const onDown = (e) => {
    e.stopPropagation();
    dragging = true;
    value = getValue();
    const pt = e.touches ? e.touches[0] : e;
    lastAngle = angleAt(pt.clientX, pt.clientY);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    const angle = angleAt(pt.clientX, pt.clientY);
    let delta = angle - lastAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    value += delta / 360;
    lastAngle = angle;
    onValue(value);
  };
  const onUp = () => { dragging = false; };
  target.addEventListener('mousedown', onDown);
  target.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
}

// Like attachDrag, but reports the angular delta from where the drag began
// instead of an absolute angle - used to translate a span without resizing it.
function attachSpanDrag(svg, target, onStart, onDeltaFrac) {
  let dragging = false;
  let startAngle = 0;
  const angleAt = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return mod(Math.atan2(clientX - cx, -(clientY - cy)) * (180 / Math.PI), 360);
  };
  const onDown = (e) => {
    e.stopPropagation();
    dragging = true;
    onStart();
    const pt = e.touches ? e.touches[0] : e;
    startAngle = angleAt(pt.clientX, pt.clientY);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    let deltaDeg = angleAt(pt.clientX, pt.clientY) - startAngle;
    if (deltaDeg > 180) deltaDeg -= 360;
    if (deltaDeg < -180) deltaDeg += 360;
    onDeltaFrac(deltaDeg / 360);
  };
  const onUp = () => { dragging = false; };
  target.addEventListener('mousedown', onDown);
  target.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
}

// ---------- Per-frame visual state (ring position, recording/queued hints) ----------

function fmtCountdown(now, until) {
  return Math.max(0, until - now).toFixed(1) + 's';
}

function applyVisualState(track, now) {
  const el = track.el;
  if (!el) return;

  el.core.classList.remove('filled', 'rec-pulse', 'queued-pulse', 'end-queued');
  let arcStart = 0;
  let arcEnd = 0;
  let showTicks = false;
  let labelText = '';

  if (track.queuedAction === 'play') {
    el.core.classList.add('queued-pulse');
    arcEnd = track.buffer ? track.pausedPhase / track.buffer.duration : 0;
    labelText = '▶ ' + fmtCountdown(now, track.queuedTime);
  } else if (track.queuedAction === 'record') {
    el.core.classList.add('queued-pulse');
    labelText = '● ' + fmtCountdown(now, track.queuedTime);
  } else if (track.queuedAction === 'stopPlay') {
    el.core.classList.add('queued-pulse', 'filled');
    arcStart = track.trimStart;
    arcEnd = trackAbsolutePosition(track, now);
    labelText = '⏸ ' + fmtCountdown(now, track.queuedTime);
  } else if (track.recording || track.queuedAction === 'endRecord') {
    showTicks = true;
    el.core.classList.add('rec-pulse');
    if (track.queuedAction === 'endRecord') el.core.classList.add('end-queued');
    if (unitLength) {
      arcEnd = mod(now - track.recordStartTime, unitLength) / unitLength;
      const elapsedUnits = Math.floor((now - track.recordStartTime) / unitLength) + 1;
      labelText = track.queuedAction === 'endRecord'
        ? 'end ' + fmtCountdown(now, track.queuedTime)
        : elapsedUnits + '…';
    } else {
      labelText = 'REC';
    }
  } else if (track.buffer) {
    el.core.classList.add('filled');
    // The arc grows from trimStart (not 12 o'clock) to the current absolute
    // (possibly >1, if the window wraps) position - drawing it from 0
    // instead would show a stray extra sliver alongside the trim span.
    arcStart = track.trimStart;
    arcEnd = trackAbsolutePosition(track, now);
    labelText = currentMode === 'trim' ? track.speedFactor.toFixed(2) + 'x'
      : (track.lengthUnits ? track.lengthUnits + 'u' : '');
  }

  el.label.textContent = labelText;
  el.pos.setAttribute('d', describeArc(arcStart, arcEnd, 42));
  el.ticks.style.opacity = showTicks ? '1' : '0';
}

// ---------- Cell click dispatch ----------

function onCellClick(track) {
  if (!audioCtx) return;
  switch (currentMode) {
    case 'playpause':
      togglePlayPause(track);
      render();
      break;
    case 'playrec':
      togglePlayRec(track);
      render();
      break;
    case 'initdel':
      removeTrack(track);
      render();
      break;
    case 'copypaste':
      if (clipboard && clipboard.sourceId === track.id) {
        clipboard = null;
      } else if (clipboard) {
        pasteInto(track, clipboard);
        clipboard = null;
      } else if (track.buffer) {
        clipboard = { sourceId: track.id, data: snapshotTrack(track) };
      }
      render();
      break;
    default:
      break;
  }
}

function snapshotTrack(track) {
  return {
    buffer: track.buffer,
    lengthUnits: track.lengthUnits,
    autoPhaseOffset: track.autoPhaseOffset,
    trimStart: track.trimStart,
    trimEnd: track.trimEnd,
    volume: track.volume,
  };
}

function pasteInto(track, clip) {
  hardStop(track);
  const d = clip.data;
  track.buffer = d.buffer;
  track.lengthUnits = d.lengthUnits;
  track.autoPhaseOffset = d.autoPhaseOffset;
  track.trimStart = d.trimStart;
  track.trimEnd = d.trimEnd;
  track.volume = d.volume;
  updateSpeedFactor(track);
  ensureGain(track);
  track.gainNode.gain.value = track.volume;
  if (track.buffer) requestPlay(track);
}

// ---------- Animation loop ----------

function tick() {
  if (audioCtx) {
    const now = audioCtx.currentTime;
    for (const t of tracks) {
      if (t.queuedAction && now >= t.queuedTime) executeQueued(t);
    }
    if (masterStartTime !== null && globalNextBoundary !== null && now >= globalNextBoundary) {
      resyncAll(now);
    }
    // Tracks whose trim window wraps past the buffer's end need their own,
    // possibly more frequent, restart to stay aligned - see trackWrapsBuffer().
    for (const t of tracks) {
      if (t.playing && t.nextOwnBoundary !== null && now >= t.nextOwnBoundary) {
        scheduleTrackAt(t, now, masterStartTime);
      }
    }
    for (const t of tracks) applyVisualState(t, now);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- Start overlay ----------

startBtn.addEventListener('click', async () => {
  try {
    await initAudio();
    startOverlay.hidden = true;
    render();
  } catch (err) {
    startError.textContent = 'Mic/audio permission failed: ' + err.message;
  }
});

// ---------- Export / Import ----------

function downloadBlob(data, mime, filename) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener('click', () => {
  const base = sanitizeFilename(projectName);
  const project = {
    version: 1,
    name: projectName,
    unitLength,
    tracks: tracks.map((t) => {
      if (!t.buffer) return { empty: true, row: t.row, col: t.col };
      const wav = encodeWavMono16(t.buffer.getChannelData(0), t.buffer.sampleRate);
      return {
        empty: false,
        row: t.row,
        col: t.col,
        lengthUnits: t.lengthUnits,
        autoPhaseOffset: t.autoPhaseOffset,
        trimStart: t.trimStart,
        trimEnd: t.trimEnd,
        volume: t.volume,
        sampleRate: t.buffer.sampleRate,
        audioBase64: arrayBufferToBase64(wav),
      };
    }),
  };
  downloadBlob(JSON.stringify(project), 'application/json', `${base}.json`);

  let delay = 300;
  tracks.forEach((t, i) => {
    if (!t.buffer) return;
    const wav = encodeWavMono16(t.buffer.getChannelData(0), t.buffer.sampleRate);
    setTimeout(() => downloadBlob(wav, 'audio/wav', `${base}-track-${i + 1}.wav`), delay);
    delay += 300;
  });
});

importBtn.addEventListener('click', () => importInput.click());

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  if (!file) return;
  const text = await file.text();
  const project = JSON.parse(text);

  if (!audioCtx) {
    try {
      await initAudio();
      startOverlay.hidden = true;
    } catch (err) {
      startError.textContent = 'Mic/audio permission failed: ' + err.message;
      return;
    }
  }

  for (const t of tracks) { hardStop(t); if (t.gainNode) try { t.gainNode.disconnect(); } catch (e) {} }
  tracks = [];
  unitLength = project.unitLength;
  masterStartTime = null;
  globalMegacycle = null;
  globalNextBoundary = null;

  if (project.name) {
    projectName = project.name;
    projectNameInput.value = projectName;
  }

  let nextRow = 0;
  for (const entry of project.tracks) {
    const row = Number.isFinite(entry.row) ? entry.row : nextRow;
    const col = Number.isFinite(entry.col) ? entry.col : 0;
    nextRow = Math.max(nextRow, row + 1);
    const track = makeTrack(row, col);
    ensureGain(track);
    if (!entry.empty) {
      const wavBuffer = base64ToArrayBuffer(entry.audioBase64);
      const audioBuffer = await audioCtx.decodeAudioData(wavBuffer);
      track.buffer = audioBuffer;
      track.lengthUnits = entry.lengthUnits;
      track.autoPhaseOffset = entry.autoPhaseOffset;
      track.trimStart = entry.trimStart;
      track.trimEnd = entry.trimEnd;
      updateSpeedFactor(track);
      track.volume = entry.volume;
      track.gainNode.gain.value = track.volume;
    }
    tracks.push(track);
  }
  if (tracks.length === 0) tracks.push(makeTrack(0, 0));

  masterStartTime = audioCtx.currentTime;
  for (const t of tracks) if (t.buffer) doStartPlayback(t, masterStartTime);
  importInput.value = '';
  render();
});

// ---------- init ----------
setMode('playpause');
render();
