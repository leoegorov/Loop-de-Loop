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
    _internals: { unzip: unzip, parseMidi: parseMidi, midiToFrames: midiToFrames }
  };
})();
