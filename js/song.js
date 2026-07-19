/* Song arranger: a bar-grid arrangement timeline. Each track (loop channels, the
   808 drums, the 303 bass) has a lane of bars you paint active/inactive. Playing the
   song schedules every track's mute/unmute up front on the audio clock (sample-
   accurate), so the whole arrangement stays locked in time. */
(function () {
  'use strict';

  var GUTTER = 78, ROW_H = 26, RULER = 16, CELL_W = 20;
  var COLORS = { loop: '#4da3ff', drums: '#ffa229', bass: '#3ddc84' };

  var ui = null;
  var ctx = null;           // { engine, drums, bass, drumsGate, bassGate, loopTracks, setDrums, setBass, status }
  var tracks = [];          // [{ key, label, kind, color, cells:Uint8Array, gate, ch }]
  var savedCells = {};      // key -> Uint8Array, persists across opens
  var bars = 32;
  var playing = false;
  var startF = 0;
  var loopSong = false;
  var passTimer = null;
  var rafOn = false;

  /* ---------------- tracks ---------------- */
  function cellsFor(key) {
    var src = savedCells[key];
    var out = new Uint8Array(bars);
    if (src) out.set(src.subarray(0, Math.min(bars, src.length)));
    savedCells[key] = out;
    return out;
  }

  function buildTracks() {
    tracks = [];
    ctx.loopTracks().forEach(function (lt) {
      var key = 'loop:' + lt.id;   // stable across added/removed channels
      tracks.push({ key: key, label: lt.label, kind: 'loop', color: COLORS.loop,
        cells: cellsFor(key), gate: lt.gate, ch: lt.ch });
    });
    tracks.push({ key: 'drums', label: 'DRUMS', kind: 'drums', color: COLORS.drums,
      cells: cellsFor('drums'), gate: ctx.drumsGate });
    tracks.push({ key: 'bass', label: '303', kind: 'bass', color: COLORS.bass,
      cells: cellsFor('bass'), gate: ctx.bassGate });
  }

  /* ---------------- UI ---------------- */
  function buildUI() {
    var panel = document.createElement('section');
    panel.id = 'song-panel';
    panel.className = 'hidden';
    panel.innerHTML =
      '<div class="drum-head">' +
        '<span class="drum-title song-title">SONG</span>' +
        '<label>Bars <select class="song-bars">' +
          '<option>8</option><option>16</option><option selected>32</option><option>64</option>' +
        '</select></label>' +
        '<button class="song-play">▶ PLAY SONG</button>' +
        '<button class="song-stop">■ STOP</button>' +
        '<label class="chk"><input type="checkbox" class="song-loop"> loop song</label>' +
        '<button class="song-clear">CLEAR</button>' +
        '<span class="hint">paint bars per track · loops play in phase, drums/303 gate in and out</span>' +
      '</div>' +
      '<div class="song-scroll"><canvas class="song-canvas"></canvas></div>';
    document.body.insertBefore(panel, document.getElementById('channels'));

    var canvas = panel.querySelector('.song-canvas');
    ui = {
      panel: panel,
      canvas: canvas,
      g: canvas.getContext('2d'),
      bars: panel.querySelector('.song-bars'),
      loop: panel.querySelector('.song-loop')
    };

    ui.bars.addEventListener('change', function () {
      bars = parseInt(this.value, 10);
      buildTracks();
      layout();
      render();
    });
    ui.loop.addEventListener('change', function () { loopSong = this.checked; });
    panel.querySelector('.song-play').addEventListener('click', play);
    panel.querySelector('.song-stop').addEventListener('click', stop);
    panel.querySelector('.song-clear').addEventListener('click', function () {
      tracks.forEach(function (t) { t.cells.fill(0); });
      render();
    });

    // paint
    var painting = false, paintVal = 1;
    function cellAt(e) {
      var rect = canvas.getBoundingClientRect();
      var x = (e.clientX - rect.left) * (canvas.width / rect.width);
      var y = (e.clientY - rect.top) * (canvas.height / rect.height);
      var bar = Math.floor((x - GUTTER) / CELL_W);
      var row = Math.floor((y - RULER) / ROW_H);
      if (bar < 0 || bar >= bars || row < 0 || row >= tracks.length) return null;
      return { bar: bar, row: row };
    }
    canvas.addEventListener('pointerdown', function (e) {
      var c = cellAt(e);
      if (!c) return;
      painting = true;
      canvas.setPointerCapture(e.pointerId);
      paintVal = tracks[c.row].cells[c.bar] ? 0 : 1;
      tracks[c.row].cells[c.bar] = paintVal;
      render();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!painting) return;
      var c = cellAt(e);
      if (!c) return;
      if (tracks[c.row].cells[c.bar] !== paintVal) {
        tracks[c.row].cells[c.bar] = paintVal;
        render();
      }
    });
    canvas.addEventListener('pointerup', function () { painting = false; });
    canvas.addEventListener('pointercancel', function () { painting = false; });
  }

  function layout() {
    ui.canvas.width = GUTTER + bars * CELL_W;
    ui.canvas.height = RULER + tracks.length * ROW_H;
  }

  function render() {
    var g = ui.g, W = ui.canvas.width, H = ui.canvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#14161a';
    g.fillRect(0, 0, W, H);

    // ruler
    g.fillStyle = '#8b93a5';
    g.font = '9px sans-serif';
    for (var b = 0; b < bars; b += 4) {
      var x = GUTTER + b * CELL_W;
      g.fillText(String(b + 1), x + 2, 11);
    }

    // rows
    for (var r = 0; r < tracks.length; r++) {
      var t = tracks[r];
      var y = RULER + r * ROW_H;
      g.fillStyle = r % 2 ? 'rgba(255,255,255,0.02)' : 'transparent';
      if (r % 2) g.fillRect(0, y, W, ROW_H);
      // label
      g.fillStyle = t.color;
      g.font = '10px sans-serif';
      g.fillText(t.label, 6, y + ROW_H / 2 + 3);
      // cells
      for (var bi = 0; bi < bars; bi++) {
        var cx = GUTTER + bi * CELL_W;
        if (t.cells[bi]) {
          g.fillStyle = t.color;
          g.globalAlpha = 0.85;
          g.fillRect(cx + 1, y + 2, CELL_W - 2, ROW_H - 4);
          g.globalAlpha = 1;
        }
      }
    }

    // grid lines (every bar, stronger every 4)
    for (var s = 0; s <= bars; s++) {
      g.strokeStyle = s % 4 === 0 ? 'rgba(216,220,230,0.22)' : 'rgba(216,220,230,0.07)';
      var gx = GUTTER + s * CELL_W;
      g.beginPath(); g.moveTo(gx + 0.5, 0); g.lineTo(gx + 0.5, H); g.stroke();
    }
    g.strokeStyle = 'rgba(216,220,230,0.22)';
    g.beginPath(); g.moveTo(GUTTER + 0.5, 0); g.lineTo(GUTTER + 0.5, H); g.stroke();
    for (var rr = 0; rr <= tracks.length; rr++) {
      var ly = RULER + rr * ROW_H;
      g.beginPath(); g.moveTo(0, ly + 0.5); g.lineTo(W, ly + 0.5); g.stroke();
    }

    // playhead
    if (playing) {
      var bar = songBar();
      if (bar >= 0 && bar <= bars) {
        var px = GUTTER + bar * CELL_W;
        g.strokeStyle = '#ff4747';
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
        g.lineWidth = 1;
      }
    }
  }

  function songBar() {
    var t = ctx.engine.transport;
    var bf = t.barFrames();
    var rel = (t.nowFrame() - startF) / bf;
    if (loopSong) return ((rel % bars) + bars) % bars;
    return rel;
  }

  /* ---------------- playback ---------------- */
  function scheduleGate(gate, cells, sf) {
    var sr = ctx.engine.ctx.sampleRate;
    var bf = ctx.engine.transport.barFrames();
    var g = gate.gain;
    var now = ctx.engine.ctx.currentTime;
    var t0 = Math.max(now, sf / sr);
    g.cancelScheduledValues(now);
    var cur = cells[0] ? 1 : 0;
    g.setValueAtTime(cur, t0);
    for (var b = 1; b < bars; b++) {
      var target = cells[b] ? 1 : 0;
      if (target !== cur) {
        var tb = (sf + b * bf) / sr;
        if (tb <= t0) { g.setValueAtTime(target, t0); }
        else { g.setValueAtTime(cur, tb); g.linearRampToValueAtTime(target, tb + 0.005); }
        cur = target;
      }
    }
    // gate off at song end
    var tend = (sf + bars * bf) / sr;
    g.setValueAtTime(cur, tend);
    g.linearRampToValueAtTime(0, tend + 0.005);
  }

  function armPass(sf) {
    var anyDrums = tracks.some(function (t) { return t.kind === 'drums' && hasCells(t); });
    var anyBass = tracks.some(function (t) { return t.kind === 'bass' && hasCells(t); });
    if (anyDrums) ctx.setDrums(true);
    if (anyBass) ctx.setBass(true);
    tracks.forEach(function (t) {
      if (t.kind === 'loop' && hasCells(t) && t.ch) t.ch.songPlayAt(sf);
      scheduleGate(t.gate, t.cells, sf);
    });
    // drums/bass pumps schedule strictly after schedFrom — include the song's first bar
    if (anyDrums) ctx.drums.schedFrom = sf - 1;
    if (anyBass) ctx.bass.schedFrom = sf - 1;

    var sr = ctx.engine.ctx.sampleRate;
    var bf = ctx.engine.transport.barFrames();
    var msToEnd = ((sf + bars * bf) / sr - ctx.engine.ctx.currentTime) * 1000;
    clearTimeout(passTimer);
    passTimer = setTimeout(function () {
      if (!playing) return;
      if (loopSong) armPass(sf + bars * bf);
      else stop();
    }, Math.max(50, msToEnd - 60));
  }

  function hasCells(t) {
    for (var i = 0; i < t.cells.length; i++) if (t.cells[i]) return true;
    return false;
  }

  function play() {
    if (!ctx) return;
    if (playing) stop();
    var t = ctx.engine.transport;
    if (!t.running) {
      startF = Math.round(t.nowFrame() + 0.06 * t.sr);
      t.startAt(startF);
      t.tempoLocked = true;
      if (ctx.engine.onTransportStart) ctx.engine.onTransportStart(startF);
    } else {
      startF = t.nextBoundary('bar');
    }
    playing = true;
    armPass(startF);
    ctx.status('Playing song (' + bars + ' bars' + (loopSong ? ', looping' : '') + ').');
    if (!rafOn) { rafOn = true; requestAnimationFrame(frame); }
  }

  function stop() {
    playing = false;
    clearTimeout(passTimer);
    var now = ctx.engine.ctx.currentTime;
    // release all gates back to audible, stop loops and instruments
    tracks.forEach(function (t) {
      t.gate.gain.cancelScheduledValues(now);
      t.gate.gain.setTargetAtTime(1, now, 0.01);
    });
    ctx.engine.stopAll();
    ctx.setDrums(false);
    ctx.setBass(false);
    ctx.status('Song stopped.');
    render();
  }

  function frame() {
    if (!playing) { rafOn = false; render(); return; }
    render();
    requestAnimationFrame(frame);
  }

  /* ---------------- entry ---------------- */
  function open(context) {
    ctx = context;
    if (!ui) buildUI();
    bars = parseInt(ui.bars.value, 10);
    buildTracks();
    layout();
    render();
    ui.panel.classList.remove('hidden');
  }
  function toggle(context) {
    if (!ui) { open(context); return; }
    if (ui.panel.classList.contains('hidden')) open(context);
    else ui.panel.classList.add('hidden');
  }

  window.SongArranger = {
    open: open, toggle: toggle, stop: stop,
    isPlaying: function () { return playing; }
  };
})();
