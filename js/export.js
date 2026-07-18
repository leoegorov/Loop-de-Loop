(function () {
  'use strict';

  var textEncoder = new TextEncoder();
  var crcTable = null;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function nowStamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    var year = Math.max(1980, date.getFullYear()) - 1980;
    var month = date.getMonth() + 1;
    var day = date.getDate();
    var hour = date.getHours();
    var minute = date.getMinutes();
    var second = Math.floor(date.getSeconds() / 2);
    return {
      time: (hour << 11) | (minute << 5) | second,
      date: (year << 9) | (month << 5) | day
    };
  }

  function makeHeader(sig, size) {
    var bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, sig, true);
    return bytes;
  }

  function setU16(bytes, offset, value) {
    new DataView(bytes.buffer).setUint16(offset, value, true);
  }

  function setU32(bytes, offset, value) {
    new DataView(bytes.buffer).setUint32(offset, value >>> 0, true);
  }

  function clampSample(v) {
    return Math.max(-1, Math.min(1, v));
  }

  function encodeWavStereo(left, right, sampleRate) {
    var frames = Math.max(left.length, right.length);
    var dataBytes = frames * 4;
    var bytes = new Uint8Array(44 + dataBytes);
    var view = new DataView(bytes.buffer);
    var i;

    bytes.set(textEncoder.encode('RIFF'), 0);
    view.setUint32(4, 36 + dataBytes, true);
    bytes.set(textEncoder.encode('WAVE'), 8);
    bytes.set(textEncoder.encode('fmt '), 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    bytes.set(textEncoder.encode('data'), 36);
    view.setUint32(40, dataBytes, true);

    var offset = 44;
    for (i = 0; i < frames; i++) {
      var l = clampSample(left[i] || 0);
      var r = clampSample(right[i] || 0);
      view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7FFF, true);
      view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
      offset += 4;
    }
    return bytes;
  }

  function writeVarLen(value) {
    var buffer = value & 0x7F;
    while ((value >>>= 7)) {
      buffer <<= 8;
      buffer |= ((value & 0x7F) | 0x80);
    }
    var out = [];
    while (true) {
      out.push(buffer & 0xFF);
      if (buffer & 0x80) buffer >>>= 8;
      else break;
    }
    return out;
  }

  function pushBytes(list, bytes) {
    for (var i = 0; i < bytes.length; i++) list.push(bytes[i]);
  }

  function encodeMidiFile(events, bpm, loopFrames, sampleRate) {
    var ppq = 480;
    var tempo = Math.max(1, Math.round(60000000 / Math.max(1, bpm)));
    var track = [];
    var absoluteTick = 0;
    var ordered = [];
    var i;

    track.push(0x00, 0xFF, 0x51, 0x03, (tempo >>> 16) & 0xFF, (tempo >>> 8) & 0xFF, tempo & 0xFF);
    for (i = 0; i < events.length; i++) {
      var ev = events[i];
      var tick = Math.max(0, Math.round((ev.off / sampleRate) * (bpm / 60) * ppq));
      ordered.push({ tick: tick, data: ev.data });
    }
    ordered.sort(function (a, b) { return a.tick - b.tick; });

    for (i = 0; i < ordered.length; i++) {
      var cur = ordered[i];
      var delta = cur.tick - absoluteTick;
      absoluteTick = cur.tick;
      pushBytes(track, writeVarLen(delta));
      track.push(cur.data[0] & 0xFF, cur.data[1] & 0xFF, cur.data[2] & 0x7F);
    }

    pushBytes(track, [0x00, 0xFF, 0x2F, 0x00]);

    var trackBytes = new Uint8Array(track);
    var bytes = new Uint8Array(22 + trackBytes.length);
    var view = new DataView(bytes.buffer);

    bytes.set([0x4D, 0x54, 0x68, 0x64], 0);
    view.setUint32(4, 6, false);
    view.setUint16(8, 0, false);
    view.setUint16(10, 1, false);
    view.setUint16(12, ppq, false);
    bytes.set([0x4D, 0x54, 0x72, 0x6B], 14);
    view.setUint32(18, trackBytes.length, false);
    bytes.set(trackBytes, 22);
    return bytes;
  }

  function buildZip(files) {
    var now = dosDateTime(new Date());
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    files.forEach(function (file) {
      var nameBytes = textEncoder.encode(file.name);
      var data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      var crc = crc32(data);
      var local = makeHeader(0x04034B50, 30);
      setU16(local, 4, 20);
      setU16(local, 6, 0);
      setU16(local, 8, 0);
      setU16(local, 10, now.time);
      setU16(local, 12, now.date);
      setU32(local, 14, crc);
      setU32(local, 18, data.length);
      setU32(local, 22, data.length);
      setU16(local, 26, nameBytes.length);
      setU16(local, 28, 0);
      localParts.push(local, nameBytes, data);

      var central = makeHeader(0x02014B50, 46);
      setU16(central, 4, 20);
      setU16(central, 6, 20);
      setU16(central, 8, 0);
      setU16(central, 10, 0);
      setU16(central, 12, now.time);
      setU16(central, 14, now.date);
      setU32(central, 16, crc);
      setU32(central, 20, data.length);
      setU32(central, 24, data.length);
      setU16(central, 28, nameBytes.length);
      setU16(central, 30, 0);
      setU16(central, 32, 0);
      setU16(central, 34, 0);
      setU16(central, 36, 0);
      setU32(central, 38, 0);
      setU32(central, 42, offset);
      centralParts.push(central, nameBytes);

      offset += local.length + nameBytes.length + data.length;
    });

    var centralSize = 0;
    for (var i = 0; i < centralParts.length; i++) centralSize += centralParts[i].length;
    var eocd = makeHeader(0x06054B50, 22);
    setU16(eocd, 4, 0);
    setU16(eocd, 6, 0);
    setU16(eocd, 8, files.length);
    setU16(eocd, 10, files.length);
    setU32(eocd, 12, centralSize);
    setU32(eocd, 16, offset);
    setU16(eocd, 20, 0);

    return new Blob(localParts.concat(centralParts).concat([eocd]), { type: 'application/zip' });
  }

  async function exportLoops(engine, strips, status) {
    if (!engine.ctx || !engine.transport) {
      if (status) status('Power on first.');
      return;
    }

    var channelInfos = strips.map(function (strip) {
      return { strip: strip, midiEvents: strip.ch.midiEvents.slice() };
    });

    var snapshots = await Promise.all(channelInfos.map(function (info) {
      return info.strip.ch.requestSnapshot().then(function (snapshot) {
        return { info: info, snapshot: snapshot };
      });
    }));

    var bpm = engine.transport.bpm;
    var sampleRate = engine.ctx.sampleRate;
    var files = [];
    var tracks = [];
    var trackNo = 0;

    snapshots.forEach(function (entry) {
      var snapshot = entry.snapshot;
      if (!snapshot || !snapshot.len || !snapshot.bufL || !snapshot.bufR) return;
      trackNo++;
      var left = new Float32Array(snapshot.bufL);
      var right = new Float32Array(snapshot.bufR);
      var stemBase = 'track-' + pad2(trackNo);
      var wavName = stemBase + '.wav';
      var midiName = stemBase + '.mid';
      files.push({ name: wavName, data: encodeWavStereo(left, right, sampleRate) });
      files.push({ name: midiName, data: encodeMidiFile(entry.info.midiEvents, bpm, snapshot.len, sampleRate) });
      tracks.push({
        track: trackNo,
        sourceState: snapshot.state,
        frames: snapshot.len,
        seconds: Math.round((snapshot.len / sampleRate) * 1000) / 1000,
        midiEvents: entry.info.midiEvents.length,
        audioFile: wavName,
        midiFile: midiName
      });
    });

    if (!tracks.length) {
      if (status) status('No finished loops to export.');
      return;
    }

    files.push({
      name: 'manifest.json',
      data: textEncoder.encode(JSON.stringify({
        exportedAt: new Date().toISOString(),
        bpm: bpm,
        sampleRate: sampleRate,
        tracks: tracks
      }, null, 2))
    });

    downloadBlob(buildZip(files), 'looping-export-' + nowStamp() + '.zip');
    if (status) status('Exported ' + tracks.length + ' loop' + (tracks.length === 1 ? '' : 's') + ' as a zip.');
  }

  window.LoopExport = {
    exportLoops: exportLoops,
    _internals: { encodeWavStereo: encodeWavStereo, encodeMidiFile: encodeMidiFile, buildZip: buildZip }
  };
})();