/* Waveform editor: view and edit a loop's audio after recording.
   Non-destructive while open — edits live on copies and are written into the
   playing loop only on APPLY (worklet "replace", grid alignment preserved via
   anchorDelta). MIDI events captured with the loop follow trims/cuts/rotations. */
(function () {
  'use strict';

  var ui = null;      // { overlay, canvas, ctx2d, title, info, selLabel, gainSlider, gainLabel }
  var ed = null;      // active session

  /* ---------------- UI construction (once) ---------------- */
  function buildUI() {
    var overlay = document.createElement('div');
    overlay.id = 'editor-overlay';
    overlay.className = 'hidden';
    overlay.innerHTML =
      '<div class="editor-box">' +
        '<div class="editor-head">' +
          '<span class="editor-title">EDIT</span>' +
          '<span class="editor-info"></span>' +
          '<button class="ed-close" title="Close (unapplied edits are discarded)">✕</button>' +
        '</div>' +
        '<canvas class="editor-canvas" height="170"></canvas>' +
        '<div class="editor-row editor-tools">' +
          '<button data-op="trim" title="Keep only the selection; loop start moves to the selection start">TRIM</button>' +
          '<button data-op="cut" title="Remove the selection and join the remainder">CUT</button>' +
          '<button data-op="silence" title="Silence the selection (MIDI events inside are dropped)">SILENCE</button>' +
          '<button data-op="fadein" title="Fade in across the selection">FADE IN</button>' +
          '<button data-op="fadeout" title="Fade out across the selection">FADE OUT</button>' +
          '<button data-op="reverse" title="Reverse the selection (or the whole loop)">REVERSE</button>' +
          '<button data-op="normalize" title="Normalize the whole loop">NORM</button>' +
          '<button data-op="setstart" title="Rotate the loop so the selection start becomes the loop start (keeps grid alignment)">SET START</button>' +
          '<label class="ed-gain">Gain <input type="range" min="-24" max="24" step="0.5" value="0"><span>0.0 dB</span></label>' +
          '<button data-op="gain" title="Apply the gain amount to the selection (or the whole loop)">APPLY GAIN</button>' +
        '</div>' +
        '<div class="editor-row editor-foot">' +
          '<span class="ed-sel">no selection — drag on the waveform</span>' +
          '<button class="ed-undo" disabled>UNDO</button>' +
          '<button class="ed-reset" title="Back to how it was when the editor opened">RESET</button>' +
          '<button class="ed-apply" title="Write the edit into the live loop">APPLY</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var canvas = overlay.querySelector('.editor-canvas');
    ui = {
      overlay: overlay,
      canvas: canvas,
      ctx2d: canvas.getContext('2d'),
      title: overlay.querySelector('.editor-title'),
      info: overlay.querySelector('.editor-info'),
      selLabel: overlay.querySelector('.ed-sel'),
      undoBtn: overlay.querySelector('.ed-undo'),
      gainSlider: overlay.querySelector('.ed-gain input'),
      gainLabel: overlay.querySelector('.ed-gain span')
    };

    overlay.querySelector('.ed-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Escape' && !overlay.classList.contains('hidden')) close();
    });

    ui.gainSlider.addEventListener('input', function () {
      ui.gainLabel.textContent = parseFloat(this.value).toFixed(1) + ' dB';
    });

    overlay.querySelectorAll('[data-op]').forEach(function (btn) {
      btn.addEventListener('click', function () { runOp(this.getAttribute('data-op')); });
    });
    ui.undoBtn.addEventListener('click', undo);
    overlay.querySelector('.ed-reset').addEventListener('click', reset);
    overlay.querySelector('.ed-apply').addEventListener('click', apply);

    // selection by drag
    var dragging = false;
    canvas.addEventListener('mousedown', function (e) {
      if (!ed) return;
      dragging = true;
      ed.selA = frameAt(e);
      ed.selB = ed.selA;
      render();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging || !ed) return;
      ed.selB = frameAt(e);
      render();
    });
    window.addEventListener('mouseup', function (e) {
      if (!dragging || !ed) return;
      dragging = false;
      ed.selB = frameAt(e);
      if (Math.abs(ed.selB - ed.selA) < ed.len / ui.canvas.width * 3) {
        ed.selA = ed.selB = null;   // treat as a click: clear selection
      }
      render();
    });
  }

  function frameAt(e) {
    var rect = ui.canvas.getBoundingClientRect();
    var x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    return Math.round(x / rect.width * ed.len);
  }

  function selection() {
    if (!ed || ed.selA === null || ed.selB === null || ed.selA === ed.selB) return null;
    var a = Math.max(0, Math.min(ed.selA, ed.selB));
    var b = Math.min(ed.len, Math.max(ed.selA, ed.selB));
    return b - a > 0 ? { a: a, b: b } : null;
  }

  /* ---------------- rendering ---------------- */
  function render() {
    var c = ui.canvas, g = ui.ctx2d;
    var W = c.width, H = c.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#14161a';
    g.fillRect(0, 0, W, H);

    // bar grid (loop start = bar boundary when recorded on the grid)
    var t = ed.engine.transport;
    if (t.tempoLocked) {
      var bf = t.barFrames();
      g.strokeStyle = 'rgba(77,163,255,0.18)';
      for (var f = bf; f < ed.len - 1; f += bf) {
        var x = f / ed.len * W;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }
    }

    // selection
    var sel = selection();
    if (sel) {
      g.fillStyle = 'rgba(181,140,255,0.20)';
      g.fillRect(sel.a / ed.len * W, 0, (sel.b - sel.a) / ed.len * W, H);
    }

    // waveform (combined stereo min/max per column)
    g.strokeStyle = '#3ddc84';
    g.beginPath();
    var step = ed.len / W;
    for (var px = 0; px < W; px++) {
      var s0 = Math.floor(px * step);
      var s1 = Math.min(ed.len, Math.max(s0 + 1, Math.floor((px + 1) * step)));
      var lo = 1, hi = -1;
      for (var i = s0; i < s1; i++) {
        var vL = ed.L[i], vR = ed.R[i];
        var v0 = Math.min(vL, vR), v1 = Math.max(vL, vR);
        if (v0 < lo) lo = v0;
        if (v1 > hi) hi = v1;
      }
      if (lo > hi) { lo = 0; hi = 0; }
      g.moveTo(px + 0.5, mid - hi * (mid - 4));
      g.lineTo(px + 0.5, mid - lo * (mid - 4) + 0.5);
    }
    g.stroke();

    // center line + MIDI event ticks
    g.strokeStyle = 'rgba(139,147,165,0.35)';
    g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
    if (ed.midi.length) {
      g.fillStyle = '#ffa229';
      ed.midi.forEach(function (ev) {
        if ((ev.data[0] & 0xF0) === 0x90 && ev.data[2] > 0) {
          g.fillRect(ev.off / ed.len * W - 1, H - 6, 2, 6);
        }
      });
    }

    updateLabels();
  }

  function fmtSec(frames) {
    return (frames / ed.sr).toFixed(2) + 's';
  }

  function updateLabels() {
    ui.info.textContent = fmtSec(ed.len) + ' · ' + ed.len + ' smp' +
      (ed.midi.length ? ' · ♪' + ed.midi.length : '') +
      (ed.dirty ? ' · unapplied edits' : '');
    var sel = selection();
    ui.selLabel.textContent = sel
      ? 'selection: ' + fmtSec(sel.a) + ' – ' + fmtSec(sel.b) + '  (' + fmtSec(sel.b - sel.a) + ')'
      : 'no selection — drag on the waveform';
    ui.undoBtn.disabled = !ed.undoStack.length;
  }

  /* ---------------- edit operations ---------------- */
  function pushUndo() {
    ed.undoStack.push({
      L: ed.L.slice(), R: ed.R.slice(), len: ed.len,
      midi: ed.midi.map(function (e) { return { off: e.off, data: e.data }; }),
      anchorDelta: ed.anchorDelta
    });
    if (ed.undoStack.length > 12) ed.undoStack.shift();
    ed.dirty = true;
  }

  function needSel(statusMsg) {
    var sel = selection();
    if (!sel && ed.status) ed.status(statusMsg);
    return sel;
  }

  function runOp(op) {
    if (!ed) return;
    var sel, i, w, n;
    var MIN_LEN = Math.round(ed.sr * 0.15);

    if (op === 'trim') {
      sel = needSel('Trim needs a selection.');
      if (!sel || sel.b - sel.a < MIN_LEN) { if (sel && ed.status) ed.status('Selection too short for a loop.'); return; }
      pushUndo();
      ed.L = ed.L.slice(sel.a, sel.b);
      ed.R = ed.R.slice(sel.a, sel.b);
      ed.midi = ed.midi.filter(function (e) { return e.off >= sel.a && e.off < sel.b; })
        .map(function (e) { return { off: e.off - sel.a, data: e.data }; });
      ed.anchorDelta += sel.a;
      ed.len = ed.L.length;

    } else if (op === 'cut') {
      sel = needSel('Cut needs a selection.');
      if (!sel) return;
      if (ed.len - (sel.b - sel.a) < MIN_LEN) { if (ed.status) ed.status('Cannot cut — loop would get too short.'); return; }
      pushUndo();
      n = ed.len - (sel.b - sel.a);
      var nl = new Float32Array(n), nr = new Float32Array(n);
      nl.set(ed.L.subarray(0, sel.a)); nl.set(ed.L.subarray(sel.b), sel.a);
      nr.set(ed.R.subarray(0, sel.a)); nr.set(ed.R.subarray(sel.b), sel.a);
      ed.L = nl; ed.R = nr; ed.len = n;
      ed.midi = ed.midi.filter(function (e) { return e.off < sel.a || e.off >= sel.b; })
        .map(function (e) { return { off: e.off < sel.a ? e.off : e.off - (sel.b - sel.a), data: e.data }; });

    } else if (op === 'silence') {
      sel = needSel('Silence needs a selection.');
      if (!sel) return;
      pushUndo();
      ed.L.fill(0, sel.a, sel.b);
      ed.R.fill(0, sel.a, sel.b);
      ed.midi = ed.midi.filter(function (e) { return e.off < sel.a || e.off >= sel.b; });

    } else if (op === 'fadein' || op === 'fadeout') {
      sel = needSel('Fades need a selection.');
      if (!sel) return;
      pushUndo();
      n = sel.b - sel.a;
      for (i = 0; i < n; i++) {
        w = i / n;
        if (op === 'fadeout') w = 1 - w;
        ed.L[sel.a + i] *= w;
        ed.R[sel.a + i] *= w;
      }

    } else if (op === 'reverse') {
      pushUndo();
      sel = selection() || { a: 0, b: ed.len };
      for (i = 0; i < (sel.b - sel.a) >> 1; i++) {
        var x = sel.a + i, y = sel.b - 1 - i, tv;
        tv = ed.L[x]; ed.L[x] = ed.L[y]; ed.L[y] = tv;
        tv = ed.R[x]; ed.R[x] = ed.R[y]; ed.R[y] = tv;
      }

    } else if (op === 'normalize') {
      var peak = 0;
      for (i = 0; i < ed.len; i++) {
        var m = Math.max(Math.abs(ed.L[i]), Math.abs(ed.R[i]));
        if (m > peak) peak = m;
      }
      if (peak < 0.0001) { if (ed.status) ed.status('Nothing to normalize — the loop is silent.'); return; }
      pushUndo();
      var k = 0.97 / peak;
      for (i = 0; i < ed.len; i++) { ed.L[i] *= k; ed.R[i] *= k; }

    } else if (op === 'gain') {
      var db = parseFloat(ui.gainSlider.value);
      if (!db) return;
      pushUndo();
      var gk = Math.pow(10, db / 20);
      sel = selection() || { a: 0, b: ed.len };
      for (i = sel.a; i < sel.b; i++) { ed.L[i] *= gk; ed.R[i] *= gk; }

    } else if (op === 'setstart') {
      sel = needSel('Set start needs a selection (its left edge becomes the loop start).');
      if (!sel || sel.a === 0) return;
      pushUndo();
      var rl = new Float32Array(ed.len), rr = new Float32Array(ed.len);
      rl.set(ed.L.subarray(sel.a)); rl.set(ed.L.subarray(0, sel.a), ed.len - sel.a);
      rr.set(ed.R.subarray(sel.a)); rr.set(ed.R.subarray(0, sel.a), ed.len - sel.a);
      ed.L = rl; ed.R = rr;
      ed.midi = ed.midi.map(function (e) {
        return { off: ((e.off - sel.a) % ed.len + ed.len) % ed.len, data: e.data };
      });
      ed.anchorDelta += sel.a;
    }

    if (op === 'trim' || op === 'cut' || op === 'setstart') { ed.selA = ed.selB = null; }
    render();
  }

  function undo() {
    if (!ed || !ed.undoStack.length) return;
    var s = ed.undoStack.pop();
    ed.L = s.L; ed.R = s.R; ed.len = s.len;
    ed.midi = s.midi; ed.anchorDelta = s.anchorDelta;
    ed.selA = ed.selB = null;
    ed.dirty = ed.undoStack.length > 0;
    render();
  }

  function reset() {
    if (!ed) return;
    ed.L = ed.origL.slice(); ed.R = ed.origR.slice(); ed.len = ed.origL.length;
    ed.midi = ed.origMidi.map(function (e) { return { off: e.off, data: e.data }; });
    ed.anchorDelta = 0;
    ed.undoStack = [];
    ed.dirty = false;
    ed.selA = ed.selB = null;
    render();
  }

  function apply() {
    if (!ed) return;
    var ok = ed.ch.applyEdit(
      ed.L.slice(), ed.R.slice(), ed.anchorDelta,
      ed.midi.map(function (e) { return { off: e.off, data: e.data }; })
    );
    if (!ok) {
      if (ed.status) ed.status('Cannot apply while the loop is recording or overdubbing.');
      return;
    }
    // applied state becomes the new baseline
    ed.origL = ed.L.slice(); ed.origR = ed.R.slice();
    ed.origMidi = ed.midi.map(function (e) { return { off: e.off, data: e.data }; });
    ed.anchorDelta = 0;
    ed.undoStack = [];
    ed.dirty = false;
    if (ed.status) ed.status('Edit applied to loop ' + ed.chLabel + '.');
    render();
  }

  function close() {
    ui.overlay.classList.add('hidden');
    ed = null;
  }

  /* ---------------- entry ---------------- */
  async function open(engine, ch, chLabel, statusFn) {
    if (!ui) buildUI();
    if (ch.state !== 'playing' && ch.state !== 'stopped') {
      if (statusFn) statusFn('Nothing to edit on loop ' + chLabel + ' yet.');
      return;
    }
    var snap = await ch.requestSnapshot();
    if (!snap.len || !snap.bufL) {
      if (statusFn) statusFn('Loop ' + chLabel + ' has no audio.');
      return;
    }
    var L = new Float32Array(snap.bufL);
    var R = new Float32Array(snap.bufR);
    ed = {
      engine: engine,
      ch: ch,
      chLabel: chLabel,
      sr: engine.ctx.sampleRate,
      L: L, R: R, len: L.length,
      midi: ch.midiEvents.map(function (e) { return { off: e.off, data: e.data }; }),
      origL: L.slice(), origR: R.slice(),
      origMidi: ch.midiEvents.map(function (e) { return { off: e.off, data: e.data }; }),
      anchorDelta: 0,
      undoStack: [],
      dirty: false,
      selA: null, selB: null,
      status: statusFn
    };
    ui.title.textContent = 'EDIT LOOP ' + chLabel;
    ui.gainSlider.value = 0;
    ui.gainLabel.textContent = '0.0 dB';
    ui.overlay.classList.remove('hidden');
    ui.canvas.width = ui.canvas.clientWidth || 900;
    render();
  }

  window.WaveEditor = { open: open };
})();
