import { encodeWavMono16, arrayBufferToBase64, base64ToArrayBuffer } from './wav.js';

/**
 * Minimal loop station.
 *
 * Core design choices:
 * - Shared transport uses the shortest loop length (masterLength).
 * - Every track length is an integer multiple of masterLength.
 * - UI ring shows master transport phase; all tracks share the same ring phase.
 * - Offset dot rotates the track relative to transport (audio stays continuous).
 */

const ui = {
  status: document.getElementById('status'),
  modules: document.getElementById('modules'),
  template: document.getElementById('moduleTemplate'),
  addModuleBtn: document.getElementById('addModuleBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
};

const state = {
  audioCtx: null,
  micStream: null,
  tapNode: null,
  zeroGain: null,
  masterLengthSamples: null,
  transportRunning: false,
  transportStartTime: 0,
  modules: [],
  nextId: 1,
  schedulerTimer: null,
  uiTimer: null,
};

const SCHEDULE_AHEAD_SEC = 0.25;
const SCHEDULE_INTERVAL_MS = 40;

boot();

function boot() {
  ui.addModuleBtn.addEventListener('click', () => addModule());
  ui.exportBtn.addEventListener('click', () => onExport());
  ui.importBtn.addEventListener('click', () => ui.importFile.click());
  ui.importFile.addEventListener('change', () => onImportFile());

  addModule();
  setStatus('Idle');

  state.uiTimer = requestAnimationFrame(uiLoop);
}

function setStatus(text) {
  ui.status.textContent = text;
}

async function ensureAudio() {
  await ensureAudioContext();
  await ensureMic();
}

async function ensureAudioContext() {
  if (state.audioCtx) {
    if (state.audioCtx.state !== 'running') await state.audioCtx.resume();
    return;
  }

  const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextImpl) throw new Error('WebAudio not supported');

  const audioCtx = new AudioContextImpl({ latencyHint: 'interactive' });
  state.audioCtx = audioCtx;
  await audioCtx.resume();
}

async function ensureMic() {
  if (state.micStream && state.tapNode) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Mic permissions not available');
  await ensureAudioContext();

  const audioCtx = state.audioCtx;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.micStream = stream;

  await audioCtx.audioWorklet.addModule('./audio-worklet.js');

  const micSource = audioCtx.createMediaStreamSource(stream);
  const tapNode = new AudioWorkletNode(audioCtx, 'tap-processor');
  const zeroGain = audioCtx.createGain();
  zeroGain.gain.value = 0;

  state.tapNode = tapNode;
  state.zeroGain = zeroGain;

  tapNode.port.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const chunk = new Float32Array(ev.data);
    onMicChunk(chunk);
  };

  micSource.connect(tapNode).connect(zeroGain).connect(audioCtx.destination);
  setStatus('Mic ready');
}

function onMicChunk(chunk) {
  for (const mod of state.modules) {
    const rec = mod.track.rec;
    if (!rec.active) continue;

    // Append chunk.
    rec.chunks.push(chunk);
    rec.recordedSamples += chunk.length;

    // Auto-stop if we hit the quantized boundary.
    if (rec.stopAfterSamples != null && rec.recordedSamples >= rec.stopAfterSamples) {
      finishRecording(mod);
    }
  }
}

function addModule(fromImport = null) {
  const id = state.nextId++;
  const el = ui.template.content.firstElementChild.cloneNode(true);
  const moduleTitle = el.querySelector('.moduleTitle');
  const deleteBtn = el.querySelector('.deleteBtn');
  const mainBtn = el.querySelector('.mainBtn');
  const stopBtn = el.querySelector('.stopBtn');
  const vol = el.querySelector('.vol');
  const ringProg = el.querySelector('.ringProg');
  const ringDot = el.querySelector('.ringDot');
  const ringSvg = el.querySelector('.ring');

  moduleTitle.textContent = `Loop ${id}`;

  const mod = {
    id,
    el,
    ringProg,
    ringDot,
    ringSvg,
    track: createTrack(fromImport),
  };

  deleteBtn.addEventListener('click', () => deleteModule(mod.id));
  stopBtn.addEventListener('click', () => stopModule(mod));
  mainBtn.addEventListener('click', () => onMainButton(mod, mainBtn));
  vol.addEventListener('input', () => {
    mod.track.volume = Number(vol.value);
    if (mod.track.gainNode) mod.track.gainNode.gain.value = mod.track.volume;
  });

  setupOffsetDrag(mod);

  state.modules.push(mod);
  ui.modules.appendChild(el);

  // Apply imported values if present.
  if (fromImport) {
    vol.value = String(mod.track.volume);
    mainBtn.textContent = mod.track.buffer ? 'PLAY' : 'REC';
    mainBtn.dataset.state = mod.track.buffer ? 'playing' : 'empty';
  }

  return mod;
}

function createTrack(fromImport) {
  return {
    buffer: fromImport?.buffer ?? null,
    lengthSamples: fromImport?.lengthSamples ?? null,
    offsetPhase: fromImport?.offsetPhase ?? 0,
    volume: fromImport?.volume ?? 0.9,
    active: fromImport?.active ?? false,
    state: fromImport?.state ?? 'empty', // empty | recording | playing | overdubbing | stopped
    gainNode: null,
    scheduledUntilCycle: -1,
    sources: new Set(),
    rec: {
      active: false,
      mode: null, // 'initial' | 'overdub'
      chunks: [],
      recordedSamples: 0,
      stopAfterSamples: null,
      overdubWriteStartSample: 0,
    },
  };
}

function deleteModule(id) {
  const idx = state.modules.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const mod = state.modules[idx];
  stopModule(mod);
  mod.el.remove();
  state.modules.splice(idx, 1);
  maybeStopTransport();
}

function stopModule(mod) {
  const t = mod.track;
  t.active = false;
  t.state = t.buffer ? 'stopped' : 'empty';
  stopAllSources(t);
  t.scheduledUntilCycle = -1;

  const mainBtn = mod.el.querySelector('.mainBtn');
  mainBtn.textContent = t.buffer ? 'PLAY' : 'REC';
  mainBtn.dataset.state = t.state;

  if (t.rec.active) {
    t.rec.active = false;
    t.rec.mode = null;
    t.rec.chunks = [];
    t.rec.recordedSamples = 0;
    t.rec.stopAfterSamples = null;
  }

  maybeStopTransport();
}

function stopAllSources(track) {
  for (const s of track.sources) {
    try {
      s.stop();
    } catch {
      // ignore
    }
  }
  track.sources.clear();
}

async function onMainButton(mod, btnEl) {
  try {
    await ensureAudio();
  } catch (err) {
    setStatus(`Mic error: ${err?.message ?? err}`);
    return;
  }

  const t = mod.track;

  if (!t.buffer && !t.rec.active) {
    // First click for this module: start initial recording.
    startInitialRecording(mod);
    btnEl.textContent = 'REC';
    btnEl.dataset.state = 'recording';
    return;
  }

  if (t.rec.active && t.rec.mode === 'initial') {
    requestStopRecording(mod);
    btnEl.textContent = 'REC';
    btnEl.dataset.state = 'recording';
    return;
  }

  if (!t.active) {
    startPlayback(mod);
    btnEl.textContent = 'OVR';
    btnEl.dataset.state = 'playing';
    return;
  }

  // Track is active.
  if (t.rec.active && t.rec.mode === 'overdub') {
    requestStopRecording(mod);
    btnEl.textContent = 'OVR';
    btnEl.dataset.state = 'playing';
    return;
  }

  // Start overdub.
  startOverdub(mod);
  btnEl.textContent = 'OVR';
  btnEl.dataset.state = 'overdubbing';
}

function startTransportIfNeeded() {
  if (state.transportRunning) return;

  if (state.masterLengthSamples == null) {
    // Transport will start once first loop defines master length.
    return;
  }

  state.transportRunning = true;
  state.transportStartTime = state.audioCtx.currentTime;
  startScheduler();
}

function startScheduler() {
  if (state.schedulerTimer) return;
  state.schedulerTimer = window.setInterval(schedulerTick, SCHEDULE_INTERVAL_MS);
}

function stopScheduler() {
  if (!state.schedulerTimer) return;
  window.clearInterval(state.schedulerTimer);
  state.schedulerTimer = null;
}

function maybeStopTransport() {
  const anyActive = state.modules.some((m) => m.track.active || m.track.rec.active);
  if (anyActive) return;

  state.transportRunning = false;
  stopScheduler();
  setStatus('Idle');
}

function startPlayback(mod) {
  const t = mod.track;
  if (!t.buffer || t.lengthSamples == null) return;

  ensureTrackGain(t);

  if (state.masterLengthSamples == null) {
    state.masterLengthSamples = t.lengthSamples;
  }

  t.active = true;
  t.state = 'playing';
  t.scheduledUntilCycle = -1;

  if (!state.transportRunning) {
    state.transportRunning = true;
    state.transportStartTime = state.audioCtx.currentTime;
    startScheduler();
  }

  primeTrackPlayback(t);

  setStatus('Playing');
}

function ensureTrackGain(track) {
  if (track.gainNode) return;
  const g = state.audioCtx.createGain();
  g.gain.value = track.volume;
  g.connect(state.audioCtx.destination);
  track.gainNode = g;
}

function startInitialRecording(mod) {
  const t = mod.track;

  if (state.masterLengthSamples != null) {
    // Set default offset so buffer position 0 lands on the current phase.
    const phase = getMasterPhase();
    t.offsetPhase = phase;
  } else {
    t.offsetPhase = 0;
  }

  t.rec.active = true;
  t.rec.mode = 'initial';
  t.rec.chunks = [];
  t.rec.recordedSamples = 0;
  t.rec.stopAfterSamples = null;

  t.state = 'recording';
  setStatus('Recording');

  // If a master exists, start transport immediately so the phase indicator moves.
  if (state.masterLengthSamples != null && !state.transportRunning) {
    state.transportRunning = true;
    state.transportStartTime = state.audioCtx.currentTime;
    startScheduler();
  }
}

function startOverdub(mod) {
  const t = mod.track;
  if (!t.buffer || t.lengthSamples == null) return;
  if (state.masterLengthSamples == null) return;

  t.rec.active = true;
  t.rec.mode = 'overdub';
  t.rec.chunks = [];
  t.rec.recordedSamples = 0;
  t.rec.stopAfterSamples = null;

  // Where in the track buffer does "now" land?
  const writeStart = getTrackPosSamplesAtNow(t);
  t.rec.overdubWriteStartSample = writeStart;

  setStatus('Overdub');
}

function requestStopRecording(mod) {
  const t = mod.track;
  if (!t.rec.active) return;

  if (state.masterLengthSamples == null) {
    // First ever loop: stop immediately.
    finishRecording(mod);
    return;
  }

  // Quantize stop to the next multiple of master length.
  const m = state.masterLengthSamples;
  const recorded = t.rec.recordedSamples;
  const target = Math.ceil(recorded / m) * m;

  // If already on boundary, finish now.
  if (target === recorded) {
    finishRecording(mod);
    return;
  }

  t.rec.stopAfterSamples = target;
  setStatus('Stopping…');
}

function finishRecording(mod) {
  const t = mod.track;
  const rec = t.rec;
  if (!rec.active) return;

  rec.active = false;

  let audio = concatChunks(rec.chunks);
  if (rec.stopAfterSamples != null && audio.length > rec.stopAfterSamples) {
    audio = audio.subarray(0, rec.stopAfterSamples);
  }
  rec.chunks = [];

  if (rec.mode === 'initial') {
    if (state.masterLengthSamples == null) {
      state.masterLengthSamples = audio.length;
      state.transportRunning = true;
      state.transportStartTime = state.audioCtx.currentTime;
      startScheduler();
    }

    const lengthSamples = quantizeLengthSamplesCeil(audio.length);
    t.lengthSamples = lengthSamples;

    // Pad/cut to quantized length.
    const fitted = fitToLength(audio, lengthSamples);

    t.buffer = float32ToAudioBuffer(fitted, state.audioCtx.sampleRate);
    t.active = true;
    t.state = 'playing';
    t.scheduledUntilCycle = -1;
    ensureTrackGain(t);

    primeTrackPlayback(t);

    setStatus('Playing');

    const mainBtn = mod.el.querySelector('.mainBtn');
    mainBtn.textContent = 'OVR';
    mainBtn.dataset.state = 'playing';
  } else if (rec.mode === 'overdub') {
    if (!t.buffer) return;

    const mixed = mixOverdubIntoTrack(t, audio, rec.overdubWriteStartSample);
    t.buffer = float32ToAudioBuffer(mixed, state.audioCtx.sampleRate);
    setStatus('Playing');

    const mainBtn = mod.el.querySelector('.mainBtn');
    mainBtn.textContent = 'OVR';
    mainBtn.dataset.state = 'playing';
  }

  rec.mode = null;
  rec.recordedSamples = 0;
  rec.stopAfterSamples = null;
}

function quantizeLengthSamplesCeil(samples) {
  if (state.masterLengthSamples == null) return samples;
  const m = state.masterLengthSamples;
  if (samples <= m) return m;
  return Math.ceil(samples / m) * m;
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function fitToLength(audio, length) {
  if (audio.length === length) return audio;
  const out = new Float32Array(length);
  out.set(audio.subarray(0, Math.min(audio.length, length)), 0);
  return out;
}

function float32ToAudioBuffer(float32, sampleRate) {
  const buf = state.audioCtx.createBuffer(1, float32.length, sampleRate);
  buf.copyToChannel(float32, 0, 0);
  return buf;
}

function mixOverdubIntoTrack(track, overdubAudio, writeStartSample) {
  // Mix overdubAudio into the existing track audio, wrapping as needed.
  const base = new Float32Array(track.buffer.length);
  track.buffer.copyFromChannel(base, 0, 0);

  const len = base.length;
  let w = writeStartSample % len;

  for (let i = 0; i < overdubAudio.length; i++) {
    const v = base[w] + overdubAudio[i];
    base[w] = clamp(v, -1, 1);
    w++;
    if (w >= len) w = 0;
  }

  return base;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function schedulerTick() {
  if (!state.transportRunning) return;
  if (state.masterLengthSamples == null) return;

  const now = state.audioCtx.currentTime;
  const lookaheadEnd = now + SCHEDULE_AHEAD_SEC;

  const masterLenSec = masterLengthSec();
  const start = state.transportStartTime;

  const startCycle = Math.floor((now - start) / masterLenSec);
  const endCycle = Math.floor((lookaheadEnd - start) / masterLenSec);

  for (const mod of state.modules) {
    const t = mod.track;
    if (!t.active || !t.buffer || t.lengthSamples == null) continue;

    ensureTrackGain(t);

    for (let c = startCycle; c <= endCycle; c++) {
      if (c <= t.scheduledUntilCycle) continue;
      scheduleTrackCycle(t, c);
      t.scheduledUntilCycle = c;
    }
  }
}

function scheduleTrackCycle(track, cycleIndex) {
  const audioCtx = state.audioCtx;
  const masterLenSec = masterLengthSec();
  const trackLenSec = track.lengthSamples / audioCtx.sampleRate;
  const offsetSec = track.offsetPhase * masterLenSec;

  const cycleStart = state.transportStartTime + cycleIndex * masterLenSec;
  if (cycleStart < audioCtx.currentTime - 0.05) return;

  // At cycleStart, buffer playback position should be rotated so that
  // buffer position 0 occurs at (cycleStart + offsetSec).
  const rotation = ((trackLenSec - (offsetSec % trackLenSec)) % trackLenSec);

  const bufOffset = (cycleIndex * masterLenSec + rotation) % trackLenSec;

  const remain = trackLenSec - bufOffset;
  if (remain >= masterLenSec) {
    createSource(track, cycleStart, bufOffset, masterLenSec);
  } else {
    createSource(track, cycleStart, bufOffset, remain);
    createSource(track, cycleStart + remain, 0, masterLenSec - remain);
  }
}

function primeTrackPlayback(track) {
  if (!state.transportRunning || state.masterLengthSamples == null) return;
  if (!track.buffer || track.lengthSamples == null) return;
  ensureTrackGain(track);

  const audioCtx = state.audioCtx;
  const masterLenSec = masterLengthSec();

  const now = audioCtx.currentTime;
  const tSec = now - state.transportStartTime;
  const cycleIndex = Math.floor(tSec / masterLenSec);
  const cycleStart = state.transportStartTime + cycleIndex * masterLenSec;
  const cycleEnd = cycleStart + masterLenSec;
  const dur = Math.max(0, cycleEnd - now);
  if (dur <= 0.002) return;

  const trackLenSec = track.lengthSamples / audioCtx.sampleRate;
  const offsetSec = track.offsetPhase * masterLenSec;
  const rotation = ((trackLenSec - (offsetSec % trackLenSec)) % trackLenSec);
  const posSec = ((tSec + rotation) % trackLenSec + trackLenSec) % trackLenSec;

  const remain = trackLenSec - posSec;
  if (remain >= dur) {
    createSource(track, now, posSec, dur);
  } else {
    createSource(track, now, posSec, remain);
    createSource(track, now + remain, 0, dur - remain);
  }
}

function createSource(track, when, offset, dur) {
  if (dur <= 0.0005) return;
  const s = state.audioCtx.createBufferSource();
  s.buffer = track.buffer;
  s.connect(track.gainNode);
  s.onended = () => track.sources.delete(s);
  track.sources.add(s);
  try {
    s.start(when, offset, dur);
  } catch {
    // ignore
  }
}

function masterLengthSec() {
  return state.masterLengthSamples / state.audioCtx.sampleRate;
}

function getMasterPhase() {
  if (!state.transportRunning || state.masterLengthSamples == null) return 0;
  const t = state.audioCtx.currentTime - state.transportStartTime;
  const m = masterLengthSec();
  const phase = ((t % m) + m) % m;
  return phase / m;
}

function getTrackPosSamplesAtNow(track) {
  // Returns the current playback position (samples) in the track buffer.
  if (!state.transportRunning || state.masterLengthSamples == null) return 0;

  const audioCtx = state.audioCtx;
  const masterLenSec = masterLengthSec();
  const trackLenSec = track.lengthSamples / audioCtx.sampleRate;
  const offsetSec = track.offsetPhase * masterLenSec;

  const tSec = audioCtx.currentTime - state.transportStartTime;
  const rotation = ((trackLenSec - (offsetSec % trackLenSec)) % trackLenSec);
  const posSec = (tSec + rotation) % trackLenSec;
  return Math.floor(posSec * audioCtx.sampleRate);
}

function uiLoop() {
  const phase = getMasterPhase();

  for (const mod of state.modules) {
    // Progress arc.
    const C = 301.6;
    mod.ringProg.style.strokeDashoffset = String(C - phase * C);

    // Offset dot.
    const dotPhase = mod.track.offsetPhase;
    const angle = dotPhase * Math.PI * 2 - Math.PI / 2;
    const cx = 60;
    const cy = 60;
    const r = 48;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    mod.ringDot.setAttribute('cx', x.toFixed(2));
    mod.ringDot.setAttribute('cy', y.toFixed(2));

    // Button labels/state.
    const mainBtn = mod.el.querySelector('.mainBtn');
    if (mod.track.rec.active && mod.track.rec.mode === 'initial') {
      mainBtn.textContent = 'REC';
      mainBtn.dataset.state = 'recording';
    } else if (mod.track.rec.active && mod.track.rec.mode === 'overdub') {
      mainBtn.textContent = 'OVR';
      mainBtn.dataset.state = 'overdubbing';
    } else if (!mod.track.buffer) {
      mainBtn.textContent = 'REC';
      mainBtn.dataset.state = 'empty';
    } else if (mod.track.active) {
      mainBtn.textContent = 'OVR';
      mainBtn.dataset.state = 'playing';
    } else {
      mainBtn.textContent = 'PLAY';
      mainBtn.dataset.state = 'stopped';
    }
  }

  state.uiTimer = requestAnimationFrame(uiLoop);
}

function setupOffsetDrag(mod) {
  const dot = mod.ringDot;
  const svg = mod.ringSvg;

  const onPointerMove = (ev) => {
    const pt = clientToSvg(svg, ev.clientX, ev.clientY);
    const dx = pt.x - 60;
    const dy = pt.y - 60;
    const angle = Math.atan2(dy, dx);

    // Convert angle to phase in [0,1) where -pi/2 is 0.
    let phase = (angle + Math.PI / 2) / (Math.PI * 2);
    phase = ((phase % 1) + 1) % 1;

    mod.track.offsetPhase = phase;
  };

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    if (pointerId != null) dot.releasePointerCapture?.(pointerId);
    pointerId = null;
  };

  let pointerId = null;

  dot.addEventListener('pointerdown', (ev) => {
    pointerId = ev.pointerId;
    dot.setPointerCapture?.(pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });
}

function clientToSvg(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * 120;
  const y = ((clientY - rect.top) / rect.height) * 120;
  return { x, y };
}

async function onExport() {
  try {
    await ensureAudioContext();
  } catch (err) {
    setStatus(`Export failed: ${err?.message ?? err}`);
    return;
  }

  const sampleRate = state.audioCtx.sampleRate;

  const payload = {
    v: 1,
    sampleRate,
    masterLengthSamples: state.masterLengthSamples,
    modules: [],
  };

  for (const mod of state.modules) {
    const t = mod.track;
    const item = {
      id: mod.id,
      lengthSamples: t.lengthSamples,
      offsetPhase: t.offsetPhase,
      volume: t.volume,
      active: false,
      wavBase64: null,
    };

    if (t.buffer) {
      const floats = new Float32Array(t.buffer.length);
      t.buffer.copyFromChannel(floats, 0, 0);
      const wav = encodeWavMono16(floats, sampleRate);
      item.wavBase64 = arrayBufferToBase64(wav);
    }

    payload.modules.push(item);
  }

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'loop-de-loop.json';
  a.click();
  URL.revokeObjectURL(url);

  setStatus('Exported');
}

async function onImportFile() {
  const file = ui.importFile.files?.[0];
  ui.importFile.value = '';
  if (!file) return;

  try {
    await ensureAudioContext();
  } catch (err) {
    setStatus(`Import error: ${err?.message ?? err}`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setStatus('Import error: invalid JSON');
    return;
  }

  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.modules)) {
    setStatus('Import error: unsupported file');
    return;
  }

  // Reset.
  for (const mod of state.modules) {
    stopModule(mod);
    mod.el.remove();
  }
  state.modules = [];

  state.masterLengthSamples = parsed.masterLengthSamples ?? null;
  state.transportRunning = false;
  stopScheduler();

  // Recreate.
  for (const item of parsed.modules) {
    const fromImport = {
      buffer: null,
      lengthSamples: item.lengthSamples ?? null,
      offsetPhase: item.offsetPhase ?? 0,
      volume: item.volume ?? 0.9,
      active: false,
      state: item.wavBase64 ? 'stopped' : 'empty',
    };

    if (item.wavBase64) {
      const wavBuf = base64ToArrayBuffer(item.wavBase64);
      try {
        const decoded = await state.audioCtx.decodeAudioData(wavBuf.slice(0));
        // Ensure mono.
        const ch0 = decoded.getChannelData(0);
        fromImport.buffer = float32ToAudioBuffer(new Float32Array(ch0), state.audioCtx.sampleRate);
        fromImport.lengthSamples = fromImport.buffer.length;
      } catch {
        // ignore track if decode fails.
      }
    }

    const mod = addModule(fromImport);
    // Update nextId to avoid collisions.
    state.nextId = Math.max(state.nextId, mod.id + 1);
  }

  if (state.modules.length === 0) addModule();

  setStatus('Imported');
}
