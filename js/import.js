/* Import: load previously exported zips (WAV stems + MIDI + manifest.json) or loose
   .wav/.mid files back into fresh loop channels. Zip entries may be stored (our own
   exports) or deflate-compressed (foreign zips, via DecompressionStream). */
(function () {
  'use strict';

  var textDecoder = new TextDecoder();

  /* ---- minimal zip reader ---- */
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('compressed zip entries not supported by this browser');
    }
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    var min = Math.max(0, bytes.length - 65557);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    var entries = [];
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014B50) throw new Error('bad zip central directory');
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      var comp = bytes.subarray(dataStart, dataStart + compSize);
      var data;
      if (method === 0) data = comp;
      else if (method === 8) data = await inflateRaw(comp);
      else throw new Error('unsupported zip compression method ' + method);
      entries.push({ name: name, data: data });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* ---- minimal SMF (MIDI file) parser ---- */
  function parseMidi(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, false) !== 0x4D546864) throw new Error('not a MIDI file');
    var ntrks = dv.getUint16(10, false);
    var division = dv.getUint16(12, false);
    if (division & 0x8000) throw new Error('SMPTE-time MIDI files not supported');
    var ppq = division || 480;
    var tempo = 500000;             // µs per quarter; first tempo meta wins
    var tempoSet = false;
    var events = [];                // { tick, data: [..] }
    var p = 14;

    for (var t = 0; t < ntrks; t++) {
      if (dv.getUint32(p, false) !== 0x4D54726B) throw new Error('bad MIDI track header');
      var trackLen = dv.getUint32(p + 4, false);
      var q = p + 8;
      var end = q + trackLen;
      var tick = 0;
      var running = 0;

      function varLen() {
        var v = 0, b;
        do { b = bytes[q++]; v = (v << 7) | (b & 0x7F); } while (b & 0x80);
        return v;
      }

      while (q < end) {
        tick += varLen();
        var b0 = bytes[q];
        if (b0 === 0xFF) {                       // meta
          var type = bytes[q + 1];
          q += 2;
          var len = varLen();
          if (type === 0x51 && len === 3 && !tempoSet) {
            tempo = (bytes[q] << 16) | (bytes[q + 1] << 8) | bytes[q + 2];
            tempoSet = true;
          }
          q += len;
        } else if (b0 === 0xF0 || b0 === 0xF7) { // sysex
          q++;
          q += varLen();
        } else {
          var status = running;
          if (b0 & 0x80) { status = b0; q++; }
          running = status;
          var hi = status & 0xF0;
          if (hi === 0xC0 || hi === 0xD0) {
            events.push({ tick: tick, data: [status, bytes[q]] });
            q += 1;
          } else {
            events.push({ tick: tick, data: [status, bytes[q], bytes[q + 1]] });
            q += 2;
          }
        }
      }
      p = end;
    }
    return { ppq: ppq, tempo: tempo, events: events, bpm: 60000000 / tempo };
  }

  function midiToFrames(parsed, sampleRate) {
    var secPerTick = (parsed.tempo / 1e6) / parsed.ppq;
    return parsed.events
      .filter(function (e) {
        var hi = e.data[0] & 0xF0;
        return hi === 0x80 || hi === 0x90 || hi === 0xB0 || hi === 0xE0;
      })
      .map(function (e) {
        return { off: Math.round(e.tick * secPerTick * sampleRate), data: e.data };
      });
  }

  /* ---- tempo detection & sync ---- */

  /* ACID chunk in a RIFF/WAVE: the standard carrier of loop tempo metadata. */
  function parseWavTempo(bytes) {
    try {
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (dv.getUint32(0, false) !== 0x52494646) return null;   // 'RIFF'
      var p = 12;
      while (p + 8 <= bytes.length) {
        var id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
        var size = dv.getUint32(p + 4, true);
        if (id === 'acid' && size >= 24) {
          var flags = dv.getUint32(p + 8, true);
          var beats = dv.getUint32(p + 8 + 12, true);
          var bpm = dv.getFloat32(p + 8 + 20, true);
          if (bpm > 30 && bpm < 300) {
            return { bpm: bpm, beats: beats > 0 ? beats : null, oneshot: !!(flags & 0x01) };
          }
          return null;
        }
        p += 8 + size + (size & 1);
      }
    } catch (e) {}
    return null;
  }

  /* "loop_120bpm.wav" / "amen-140.wav" style names. */
  function filenameBPM(name) {
    var m = /(\d{2,3})(?:\.\d+)?\s*bpm/i.exec(name);
    if (!m) m = /(?:^|[-_ ])(\d{2,3})(?:[-_ .]|$)/.exec(name);
    if (!m) return null;
    var bpm = parseFloat(m[1]);
    return bpm >= 60 && bpm <= 199 ? bpm : null;
  }

  /* Onset-energy autocorrelation over 60–190 BPM. Returns { bpm, confidence }. */
  function detectBPM(x, sr) {
    var hop = 512;
    var frames = Math.floor(x.length / hop);
    if (frames < 32) return null;
    var env = new Float32Array(frames);
    for (var i = 0; i < frames; i++) {
      var s = 0, o = i * hop;
      for (var j = 0; j < hop; j++) { var v = x[o + j]; s += v * v; }
      env[i] = Math.sqrt(s / hop);
    }
    var flux = new Float32Array(frames);
    for (i = 1; i < frames; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);
    var hopSec = hop / sr;
    var minLag = Math.max(2, Math.floor(60 / 190 / hopSec));
    var maxLag = Math.min(frames - 2, Math.ceil(60 / 60 / hopSec));
    if (maxLag <= minLag) return null;
    var best = 0, bestLag = 0, sum = 0, cnt = 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var s2 = 0;
      for (i = 0; i + lag < frames; i++) s2 += flux[i] * flux[i + lag];
      s2 /= (frames - lag);
      var lag2 = lag * 2, h = 0;
      if (lag2 < frames - 1) {
        for (i = 0; i + lag2 < frames; i++) h += flux[i] * flux[i + lag2];
        h /= (frames - lag2);
      }
      s2 += 0.5 * h;
      sum += s2; cnt++;
      if (s2 > best) { best = s2; bestLag = lag; }
    }
    var mean = sum / cnt;
    if (!bestLag || mean <= 0) return null;
    return { bpm: 60 / (bestLag * hopSec), confidence: best / mean };
  }

  /* Resolve half/double-time ambiguity toward the least stretch vs the master. */
  function normalizeBPM(bpm, master) {
    var guard = 0;
    while (bpm < master / 1.45 && guard++ < 4) bpm *= 2;
    while (bpm > master * 1.45 && guard++ < 8) bpm /= 2;
    return bpm;
  }

  function resample(arr, newLen) {
    if (newLen === arr.length) return arr;
    var out = new Float32Array(newLen);
    var ratio = arr.length / newLen;
    for (var i = 0; i < newLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(arr.length - 1, i0 + 1);
      var f = pos - i0;
      out[i] = arr[i0] * (1 - f) + arr[i1] * f;
    }
    return out;
  }

  /* Varispeed the sample so srcBPM lands on the master grid, snapped to whole beats. */
  function syncToMaster(L, R, srcBPM, engine, adopt, beatsHint) {
    var sr = engine.ctx.sampleRate;
    var master = adopt ? srcBPM : engine.transport.bpm;
    var bpm = adopt ? srcBPM : normalizeBPM(srcBPM, master);
    var beats = beatsHint || Math.max(1, Math.round(L.length / sr * bpm / 60));
    var target = Math.max(1, Math.round(beats * sr * 60 / master));
    var ratio = target / L.length;
    if (ratio < 0.5 || ratio > 2) return null;   // too drastic — leave the audio alone
    return { L: resample(L, target), R: resample(R, target), len: target, beats: beats, ratio: ratio };
  }

  /* ---- tap-tempo dialog (fallback when nothing else knows the tempo) ---- */
  var tapUI = null;
  function tapTempo(fileName) {
    if (!tapUI) {
      var overlay = document.createElement('div');
      overlay.id = 'tap-overlay';
      overlay.className = 'hidden';
      overlay.innerHTML =
        '<div class="editor-box tap-box">' +
          '<div class="editor-head">' +
            '<span class="editor-title">TAP TEMPO</span>' +
            '<span class="editor-info tap-file"></span>' +
          '</div>' +
          '<p class="tap-help">No tempo found for this file — tap the beat (4+ taps):</p>' +
          '<button class="tap-pad">TAP</button>' +
          '<div class="tap-readout">— BPM</div>' +
          '<div class="editor-row editor-foot">' +
            '<span class="ed-sel"></span>' +
            '<button class="tap-skip">IMPORT UNSYNCED</button>' +
            '<button class="ed-apply tap-use" disabled>USE TEMPO</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      tapUI = {
        overlay: overlay,
        file: overlay.querySelector('.tap-file'),
        pad: overlay.querySelector('.tap-pad'),
        readout: overlay.querySelector('.tap-readout'),
        use: overlay.querySelector('.tap-use'),
        skip: overlay.querySelector('.tap-skip')
      };
    }
    return new Promise(function (resolve) {
      var taps = [];
      var bpm = null;
      tapUI.file.textContent = fileName;
      tapUI.readout.textContent = '— BPM';
      tapUI.use.disabled = true;
      tapUI.overlay.classList.remove('hidden');

      function onTap() {
        var now = performance.now();
        if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
        taps.push(now);
        if (taps.length >= 2) {
          var sum = 0;
          for (var i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1];
          bpm = 60000 / (sum / (taps.length - 1));
          tapUI.readout.textContent = bpm.toFixed(1) + ' BPM  (' + taps.length + ' taps)';
          tapUI.use.disabled = taps.length < 4;
        } else {
          tapUI.readout.textContent = '… (' + taps.length + ' tap)';
        }
      }
      function done(result) {
        tapUI.pad.removeEventListener('click', onTap);
        tapUI.use.removeEventListener('click', onUse);
        tapUI.skip.removeEventListener('click', onSkip);
        tapUI.overlay.classList.add('hidden');
        resolve(result);
      }
      function onUse() { done(bpm); }
      function onSkip() { done(null); }
      tapUI.pad.addEventListener('click', onTap);
      tapUI.use.addEventListener('click', onUse);
      tapUI.skip.addEventListener('click', onSkip);
    });
  }

  function baseName(name) {
    var slash = name.lastIndexOf('/');
    var file = slash >= 0 ? name.slice(slash + 1) : name;
    return file.replace(/\.(wav|mid|midi)$/i, '');
  }

  /* ---- main entry ---- */
  async function importFiles(engine, files, addChannelFn, status) {
    if (!engine.ctx) throw new Error('power on first');
    var sr = engine.ctx.sampleRate;

    // 1. flatten input files (unpack zips) into named entries
    var entries = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name)) {
        entries = entries.concat(await unzip(bytes));
      } else {
        entries.push({ name: f.name, data: bytes });
      }
    }

    // 2. manifest (our own exports): bpm to restore
    var manifest = null;
    entries.forEach(function (e) {
      if (/(^|\/)manifest\.json$/i.test(e.name)) {
        try { manifest = JSON.parse(textDecoder.decode(e.data)); } catch (err) {}
      }
    });

    // 3. group audio + midi by basename
    var tracks = {};
    var order = [];
    entries.forEach(function (e) {
      var isWav = /\.wav$/i.test(e.name);
      var isMid = /\.(mid|midi)$/i.test(e.name);
      if (!isWav && !isMid) return;
      var base = baseName(e.name);
      if (!tracks[base]) { tracks[base] = {}; order.push(base); }
      if (isWav) tracks[base].wav = e.data;
      else tracks[base].mid = e.data;
    });
    if (!order.length) throw new Error('no .wav or .mid files found');

    // 4. restore tempo before anything plays (only while the grid is still free)
    var bpmRestored = false;
    var bpm = manifest && manifest.bpm;
    if (bpm && !engine.transport.tempoLocked) {
      engine.transport.bpm = bpm;
      bpmRestored = true;
    }

    // 5. build a channel per track
    var loaded = 0;
    for (var o = 0; o < order.length; o++) {
      var tr = tracks[order[o]];
      var L = null, R = null, len = 0;
      var midiEvents = [];
      var parsed = null;

      if (tr.mid) {
        try {
          parsed = parseMidi(tr.mid);
          midiEvents = midiToFrames(parsed, sr);
        } catch (err) {
          if (status) status('Skipping unreadable MIDI in "' + order[o] + '": ' + err.message);
        }
      }

      if (tr.wav) {
        // decodeAudioData resamples to the context rate and handles any WAV flavor
        var audio = await engine.ctx.decodeAudioData(tr.wav.slice().buffer);
        len = audio.length;
        L = new Float32Array(audio.getChannelData(0));
        R = new Float32Array(audio.numberOfChannels > 1 ? audio.getChannelData(1) : audio.getChannelData(0));

        // tempo-sync standalone wavs (our own exports are already grid-exact)
        if (!manifest) {
          var srcInfo = null;
          var acid = parseWavTempo(tr.wav);
          if (acid && !acid.oneshot) srcInfo = { bpm: acid.bpm, beats: acid.beats, source: 'wav tempo data' };
          if (!srcInfo) {
            var fnBpm = filenameBPM(order[o]);
            if (fnBpm) srcInfo = { bpm: fnBpm, beats: null, source: 'filename' };
          }
          if (!srcInfo) {
            var mono = new Float32Array(len);
            for (var mi = 0; mi < len; mi++) mono[mi] = (L[mi] + R[mi]) * 0.5;
            var det = detectBPM(mono, sr);
            if (det && det.confidence > 1.5) srcInfo = { bpm: det.bpm, beats: null, source: 'beat detection' };
          }
          if (!srcInfo) {
            var tapped = await tapTempo(order[o]);
            if (tapped) srcInfo = { bpm: tapped, beats: null, source: 'tap tempo' };
          }
          if (srcInfo) {
            var adopt = !engine.transport.tempoLocked && !bpmRestored;
            if (adopt) {
              engine.transport.bpm = Math.max(40, Math.min(240, Math.round(srcInfo.bpm * 10) / 10));
              bpmRestored = true;
              bpm = engine.transport.bpm;
            }
            var synced = syncToMaster(L, R, srcInfo.bpm, engine, adopt, srcInfo.beats);
            if (synced) {
              L = synced.L; R = synced.R; len = synced.len;
              if (status) status('"' + order[o] + '": ' + Math.round(srcInfo.bpm) + ' BPM (' + srcInfo.source + ') → ' +
                (adopt ? 'set as master tempo' : 'synced to ' + engine.transport.bpm + ' BPM') +
                ', ' + synced.beats + ' beats' +
                (Math.abs(synced.ratio - 1) > 0.005 ? ', stretched ×' + synced.ratio.toFixed(3) : '') + '.');
            } else if (status) {
              status('"' + order[o] + '": tempo ' + Math.round(srcInfo.bpm) + ' too far from master — imported unsynced.');
            }
          } else if (status) {
            status('"' + order[o] + '" imported unsynced (no tempo).');
          }
        }
      } else if (midiEvents.length) {
        // MIDI-only track: silent audio loop, length = events rounded up to whole bars
        var evBpm = (parsed && parsed.bpm) || engine.transport.bpm;
        var barFrames = Math.round(4 * 60 / evBpm * sr);
        var lastOff = midiEvents.reduce(function (m, e) { return Math.max(m, e.off); }, 0);
        len = Math.max(1, Math.ceil((lastOff + 1) / barFrames)) * barFrames;
        L = new Float32Array(len);
        R = new Float32Array(len);
      } else {
        continue;
      }

      // keep MIDI offsets inside the loop
      midiEvents.forEach(function (e) { e.off = ((e.off % len) + len) % len; });
      midiEvents.sort(function (a, b) { return a.off - b.off; });

      var ch = addChannelFn();
      ch.midiEvents = midiEvents;
      ch.loadedNeedsAnchor = true;
      ch.node.port.postMessage(
        { cmd: 'load', bufL: L.buffer, bufR: R.buffer },
        [L.buffer, R.buffer]
      );
      loaded++;
    }

    return { tracks: loaded, bpmRestored: bpmRestored, bpm: bpm };
  }

  window.LoopImport = {
    importFiles: importFiles,
    _internals: {
      unzip: unzip, parseMidi: parseMidi, midiToFrames: midiToFrames,
      parseWavTempo: parseWavTempo, filenameBPM: filenameBPM, detectBPM: detectBPM,
      normalizeBPM: normalizeBPM, resample: resample, syncToMaster: syncToMaster
    }
  };
})();
