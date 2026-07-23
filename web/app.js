import { encodeWavMono16, arrayBufferToBase64, base64ToArrayBuffer } from './wav.js';

const MODES = ['playpause', 'playrec', 'initdel', 'offset', 'speed', 'volume', 'copypaste', 'zoom'];
const SHORTCUTS = { p: 'playpause', r: 'playrec', i: 'initdel', o: 'offset', s: 'speed', v: 'volume', c: 'copypaste', z: 'zoom' };

const body = document.body;
const modeSelect = document.getElementById('modeSelect');
const gridEl = document.getElementById('grid');
const zoomLayer = document.getElementById('zoomLayer');
const startOverlay = document.getElementById('startOverlay');
const startBtn = document.getElementById('startBtn');
const startError = document.getElementById('startError');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importInput = document.getElementById('importInput');

let currentMode = 'playpause';
let uidCounter = 1;

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

let cells = [];              // array of track objects
let clipboard = null;
let zoomedId = null;
let dragSrcIndex = null;

function mod(a, n) { return ((a % n) + n) % n; }
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }
function lcm2(a, b) { return (a / gcd(a, b)) * b; }
function lcmAll(nums) { return nums.reduce((acc, n) => lcm2(acc, n), 1); }

function makeTrack() {
  return {
    id: uidCounter++,
    buffer: null,
    lengthUnits: null,
    autoPhaseOffset: 0,
    userOffset: 0,
    speedFactor: 1,
    volume: 1,
    gainNode: null,
    sourceNode: null,
    playing: false,
    recording: false,
    recordChunks: [],
    recordStartTime: null,
    loopAnchorTime: null,
    pausedPhase: 0,
    queuedAction: null,       // null | 'play' | 'stopPlay' | 'record' | 'endRecord'
    queuedTime: null,
    queuedLengthUnits: null,
    el: null,
  };
}

cells.push(makeTrack());

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
  for (const t of cells) ensureGain(t);
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
  for (const t of cells) {
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
  for (const t of cells) {
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
  for (const t of cells) {
    if (t.playing && t.buffer) scheduleTrackAt(t, now, anchor);
  }
  globalMegacycle = megacycle;
  globalNextBoundary = anchor + megacycle;
}

function scheduleTrackAt(track, atTime, anchor) {
  ensureGain(track);
  const bufDur = track.buffer.duration;
  const phase = mod((atTime - anchor) * track.speedFactor + track.autoPhaseOffset + track.userOffset, bufDur);
  if (track.sourceNode) {
    try { track.sourceNode.stop(atTime); } catch (e) { /* already stopped */ }
  }
  const src = audioCtx.createBufferSource();
  src.buffer = track.buffer;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = bufDur;
  src.playbackRate.value = track.speedFactor;
  src.connect(track.gainNode);
  src.start(atTime, phase);
  track.sourceNode = src;
  track.loopAnchorTime = anchor;
}

function trackPhase01(track, now) {
  if (!track.buffer) return 0;
  const bufDur = track.buffer.duration;
  if (!track.playing) return track.pausedPhase / bufDur;
  const anchor = track.loopAnchorTime !== null ? track.loopAnchorTime : now;
  const phase = mod((now - anchor) * track.speedFactor + track.autoPhaseOffset + track.userOffset, bufDur);
  return phase / bufDur;
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
  track.userOffset = 0;
  track.speedFactor = 1;
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

function resetTrack(track) {
  hardStop(track);
  track.buffer = null;
  track.lengthUnits = null;
  track.autoPhaseOffset = 0;
  track.userOffset = 0;
  track.speedFactor = 1;
  track.volume = 1;
  if (track.gainNode) track.gainNode.gain.value = 1;
  track.pausedPhase = 0;
}

function removeTrack(index) {
  const track = cells[index];
  hardStop(track);
  if (track.gainNode) { try { track.gainNode.disconnect(); } catch (e) {} }
  cells.splice(index, 1);
  if (!cells.some((t) => t.buffer)) {
    unitLength = null;
    masterStartTime = null;
    globalMegacycle = null;
    globalNextBoundary = null;
  }
}

// ---------- UI: mode handling ----------

function setMode(mode) {
  currentMode = mode;
  modeSelect.value = mode;
  body.className = 'mode-' + mode;
  render();
}

modeSelect.addEventListener('change', () => setMode(modeSelect.value));

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const key = e.key.toLowerCase();
  if (SHORTCUTS[key]) setMode(SHORTCUTS[key]);
});

// ---------- Grid rendering ----------

function render() {
  gridEl.innerHTML = '';
  zoomLayer.innerHTML = '';

  if (zoomedId !== null) {
    const idx = cells.findIndex((t) => t.id === zoomedId);
    if (idx === -1) { zoomedId = null; } else {
      gridEl.hidden = true;
      zoomLayer.hidden = false;
      const cell = buildCell(cells[idx], idx);
      zoomLayer.appendChild(cell);
      return;
    }
  }
  gridEl.hidden = false;
  zoomLayer.hidden = true;

  cells.forEach((track, index) => {
    gridEl.appendChild(buildCell(track, index));
  });

  const placeholder = document.createElement('div');
  placeholder.className = 'cell placeholder';
  placeholder.addEventListener('click', () => {
    if (currentMode !== 'initdel') return;
    cells.push(makeTrack());
    ensureGain(cells[cells.length - 1]);
    render();
  });
  gridEl.appendChild(placeholder);
}

function buildCell(track, index) {
  const cell = document.createElement('div');
  cell.className = 'cell' + (track.buffer ? '' : ' empty') + (clipboard && clipboard.sourceId === track.id ? ' copied' : '');
  cell.setAttribute('role', 'listitem');

  cell.draggable = !['offset', 'speed', 'volume'].includes(currentMode);
  cell.addEventListener('dragstart', () => { dragSrcIndex = index; cell.classList.add('dragging'); });
  cell.addEventListener('dragend', () => { cell.classList.remove('dragging'); });
  cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
  cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
  cell.addEventListener('drop', (e) => {
    e.preventDefault();
    cell.classList.remove('drag-over');
    if (dragSrcIndex === null || dragSrcIndex === index) return;
    const [moved] = cells.splice(dragSrcIndex, 1);
    cells.splice(index, 0, moved);
    dragSrcIndex = null;
    render();
  });

  if (currentMode === 'volume') {
    cell.appendChild(buildVolumeControl(track));
  } else {
    cell.appendChild(buildModuleSvg(track));
  }

  cell.addEventListener('click', (e) => onCellClick(track, index, e));
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

  const circumference = 2 * Math.PI * 42;
  const pos = svgEl('circle', {
    class: 'ring-pos', cx: 50, cy: 50, r: 42,
    'stroke-dasharray': String(circumference),
    'stroke-dashoffset': String(circumference),
  });
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

  let strobeGroup = null;
  if (currentMode === 'speed' && track.buffer) {
    strobeGroup = svgEl('g', { class: 'speed-strobe' });
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r1 = 30, r2 = 36;
      const x1 = 50 + r1 * Math.sin(a), y1 = 50 - r1 * Math.cos(a);
      const x2 = 50 + r2 * Math.sin(a), y2 = 50 - r2 * Math.cos(a);
      strobeGroup.appendChild(svgEl('line', { class: 'speed-tick', x1, y1, x2, y2 }));
    }
    svg.appendChild(strobeGroup);
  }

  const core = svgEl('circle', { class: 'core-circle core-btn', cx: 50, cy: 50, r: 22 });
  svg.appendChild(core);

  const label = svgEl('text', { class: 'core-label', x: 50, y: 52 });
  svg.appendChild(label);

  if (currentMode === 'offset' && track.buffer) {
    const handle = svgEl('circle', { class: 'offset-handle', cx: 50, cy: 8, r: 5 });
    svg.appendChild(handle);
    attachDrag(svg, handle, (angleDeg) => {
      const frac = angleDeg / 360;
      track.userOffset = frac * track.buffer.duration;
      if (track.playing) resyncAll();
    });
  }

  if (currentMode === 'speed' && track.buffer) {
    const speedHandle = svgEl('circle', { class: 'offset-handle', cx: 50, cy: 14, r: 5 });
    svg.appendChild(speedHandle);
    attachDrag(svg, speedHandle, (angleDeg) => {
      let signed = angleDeg > 180 ? angleDeg - 360 : angleDeg;
      signed = Math.max(-180, Math.min(180, signed));
      track.speedFactor = Math.pow(2, signed / 90);
      if (track.playing) resyncAll();
    });
  }

  track.el = { svg, pos, circumference, strobeGroup, core, label, ticks };
  applyVisualState(track, audioCtx ? audioCtx.currentTime : 0);
  return svg;
}

function attachDrag(svg, handle, onAngle) {
  let dragging = false;
  const move = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
    angle = mod(angle, 360);
    handle.setAttribute('cx', 50 + 42 * Math.sin(angle * Math.PI / 180));
    handle.setAttribute('cy', 50 - 42 * Math.cos(angle * Math.PI / 180));
    onAngle(angle);
  };
  const onDown = (e) => {
    e.stopPropagation();
    dragging = true;
    const pt = e.touches ? e.touches[0] : e;
    move(pt.clientX, pt.clientY);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    move(pt.clientX, pt.clientY);
  };
  const onUp = () => { dragging = false; };
  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
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
  let frac = 0;
  let showTicks = false;
  let labelText = '';

  if (track.queuedAction === 'play') {
    el.core.classList.add('queued-pulse');
    frac = track.buffer ? track.pausedPhase / track.buffer.duration : 0;
    labelText = '▶ ' + fmtCountdown(now, track.queuedTime);
  } else if (track.queuedAction === 'record') {
    el.core.classList.add('queued-pulse');
    labelText = '● ' + fmtCountdown(now, track.queuedTime);
  } else if (track.queuedAction === 'stopPlay') {
    el.core.classList.add('queued-pulse', 'filled');
    frac = trackPhase01(track, now);
    labelText = '⏸ ' + fmtCountdown(now, track.queuedTime);
  } else if (track.recording || track.queuedAction === 'endRecord') {
    showTicks = true;
    el.core.classList.add('rec-pulse');
    if (track.queuedAction === 'endRecord') el.core.classList.add('end-queued');
    if (unitLength) {
      frac = mod(now - track.recordStartTime, unitLength) / unitLength;
      const elapsedUnits = Math.floor((now - track.recordStartTime) / unitLength) + 1;
      labelText = track.queuedAction === 'endRecord'
        ? 'end ' + fmtCountdown(now, track.queuedTime)
        : elapsedUnits + '…';
    } else {
      labelText = 'REC';
    }
  } else if (track.buffer) {
    el.core.classList.add('filled');
    frac = trackPhase01(track, now);
    labelText = currentMode === 'speed' ? track.speedFactor.toFixed(2) + 'x'
      : (track.lengthUnits ? track.lengthUnits + 'u' : '');
  }

  el.label.textContent = labelText;
  el.pos.setAttribute('stroke-dashoffset', String(el.circumference * (1 - frac)));
  el.ticks.style.opacity = showTicks ? '1' : '0';
  if (el.strobeGroup) {
    const wobble = (track.speedFactor - 1) * now * 60;
    el.strobeGroup.setAttribute('transform', `rotate(${wobble} 50 50)`);
  }
}

// ---------- Cell click dispatch ----------

function onCellClick(track, index) {
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
      if (track.buffer) resetTrack(track);
      else removeTrack(index);
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
    case 'zoom':
      zoomedId = zoomedId === track.id ? null : track.id;
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
    userOffset: track.userOffset,
    speedFactor: track.speedFactor,
    volume: track.volume,
  };
}

function pasteInto(track, clip) {
  hardStop(track);
  const d = clip.data;
  track.buffer = d.buffer;
  track.lengthUnits = d.lengthUnits;
  track.autoPhaseOffset = d.autoPhaseOffset;
  track.userOffset = d.userOffset;
  track.speedFactor = d.speedFactor;
  track.volume = d.volume;
  ensureGain(track);
  track.gainNode.gain.value = track.volume;
  if (track.buffer) requestPlay(track);
}

// ---------- Animation loop ----------

function tick() {
  if (audioCtx) {
    const now = audioCtx.currentTime;
    for (const t of cells) {
      if (t.queuedAction && now >= t.queuedTime) executeQueued(t);
    }
    if (masterStartTime !== null && globalNextBoundary !== null && now >= globalNextBoundary) {
      resyncAll(now);
    }
    for (const t of cells) applyVisualState(t, now);
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
  const project = {
    version: 1,
    unitLength,
    tracks: cells.map((t) => {
      if (!t.buffer) return { empty: true };
      const wav = encodeWavMono16(t.buffer.getChannelData(0), t.buffer.sampleRate);
      return {
        empty: false,
        lengthUnits: t.lengthUnits,
        autoPhaseOffset: t.autoPhaseOffset,
        userOffset: t.userOffset,
        speedFactor: t.speedFactor,
        volume: t.volume,
        sampleRate: t.buffer.sampleRate,
        audioBase64: arrayBufferToBase64(wav),
      };
    }),
  };
  downloadBlob(JSON.stringify(project), 'application/json', 'loop-de-loop-project.json');

  let delay = 300;
  cells.forEach((t, i) => {
    if (!t.buffer) return;
    const wav = encodeWavMono16(t.buffer.getChannelData(0), t.buffer.sampleRate);
    setTimeout(() => downloadBlob(wav, 'audio/wav', `loop-de-loop-track-${i + 1}.wav`), delay);
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

  for (const t of cells) { hardStop(t); if (t.gainNode) try { t.gainNode.disconnect(); } catch (e) {} }
  cells = [];
  unitLength = project.unitLength;
  masterStartTime = null;
  globalMegacycle = null;
  globalNextBoundary = null;

  for (const entry of project.tracks) {
    const track = makeTrack();
    ensureGain(track);
    if (!entry.empty) {
      const wavBuffer = base64ToArrayBuffer(entry.audioBase64);
      const audioBuffer = await audioCtx.decodeAudioData(wavBuffer);
      track.buffer = audioBuffer;
      track.lengthUnits = entry.lengthUnits;
      track.autoPhaseOffset = entry.autoPhaseOffset;
      track.userOffset = entry.userOffset;
      track.speedFactor = entry.speedFactor;
      track.volume = entry.volume;
      track.gainNode.gain.value = track.volume;
    }
    cells.push(track);
  }
  if (cells.length === 0) cells.push(makeTrack());

  masterStartTime = audioCtx.currentTime;
  for (const t of cells) if (t.buffer) doStartPlayback(t, masterStartTime);
  importInput.value = '';
  render();
});

// ---------- init ----------
setMode('playpause');
render();
