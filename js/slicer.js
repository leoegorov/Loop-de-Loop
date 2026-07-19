/* Beat-grid slicer: chop a recorded loop into grid slices, then rearrange, repeat,
   reverse or silence them. The rebuilt audio replaces the loop buffer (length and
   grid anchor unchanged), so it plays through the channel's FX chain — slicing sits
   before the effects. */
(function () {
  'use strict';

  var ui = null;
  var ed = null;        // session { engine, ch, chLabel, status, L, R, len, sr, sliceFrames, steps }
  var drag = null;      // { from, to }
  var previewNode = null;

  /* ---------------- helpers ---------------- */
  function bound(k) {
    return Math.min(ed.len, Math.round(k * ed.sliceFrames));
  }
  function stepCount() {
    return Math.ceil(ed.len / ed.sliceFrames - 1e-6);
  }
  function resetSteps() {
    ed.steps = [];
    var K = stepCount();
    for (var i = 0; i < K; i++) ed.steps.push({ src: i, rev: false, mute: false });
  }

  function sliceFramesFor(value) {
    var t = ed.engine.transport;
    if (t.tempoLocked) return t.beatFrames() / parseFloat(value);
    return ed.len / parseFloat(value);   // no grid: fixed number of equal slices
  }

  /* Rebuild the loop from the slice map (2 ms edge fades against clicks). */
  function buildBuffers() {
    var L2 = new Float32Array(ed.len), R2 = new Float32Array(ed.len);
    var F = Math.round(ed.sr * 0.002);
    ed.steps.forEach(function (st, k) {
      if (st.mute) return;
      var t0 = bound(k), t1 = bound(k + 1);
      var s0 = bound(st.src), s1 = bound(st.src + 1);
      var n = Math.min(t1 - t0, s1 - s0);
      for (var i = 0; i < n; i++) {
        var si = st.rev ? (s1 - 1 - i) : (s0 + i);
        var w = 1, tail = n - 1 - i;
        if (i < F) w = i / F;
        if (tail < F) w = Math.min(w, tail / F);
        L2[t0 + i] = ed.L[si] * w;
        R2[t0 + i] = ed.R[si] * w;
      }
    });
    return { L: L2, R: R2 };
  }

  /* ---------------- UI ---------------- */
  function buildUI() {
    var overlay = document.createElement('div');
    overlay.id = 'slicer-overlay';
    overlay.className = 'hidden';
    overlay.innerHTML =
      '<div class="editor-box">' +
        '<div class="editor-head">' +
          '<span class="editor-title slicer-title">SLICE</span>' +
          '<span class="editor-info slicer-info"></span>' +
          '<button class="ed-close slicer-close" title="Close (unapplied changes are discarded)">✕</button>' +
        '</div>' +
        '<canvas class="slicer-canvas editor-canvas" height="170"></canvas>' +
        '<div class="editor-row editor-foot">' +
          '<span class="ed-sel">click = silence · drag = copy slice · double-click = reverse</span>' +
          '<label class="seq-l">Grid <select class="slicer-div"></select></label>' +
          '<button class="slicer-shuffle" title="Random slice order">SHUFFLE</button>' +
          '<button class="slicer-reset" title="Back to the original order">RESET</button>' +
          '<button class="slicer-preview" title="Loop the sliced version (loop channel keeps playing the original until APPLY)">PREVIEW</button>' +
          '<button class="ed-apply slicer-apply" title="Write the sliced audio into the live loop (plays through the channel FX)">APPLY</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var canvas = overlay.querySelector('.slicer-canvas');
    ui = {
      overlay: overlay,
      canvas: canvas,
      g: canvas.getContext('2d'),
      title: overlay.querySelector('.slicer-title'),
      info: overlay.querySelector('.slicer-info'),
      div: overlay.querySelector('.slicer-div'),
      previewBtn: overlay.querySelector('.slicer-preview')
    };

    overlay.querySelector('.slicer-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Escape' && !overlay.classList.contains('hidden')) close();
    });

    ui.div.addEventListener('change', function () {
      if (!ed) return;
      ed.sliceFrames = sliceFramesFor(this.value);
      resetSteps();
      render();
    });
    overlay.querySelector('.slicer-reset').addEventListener('click', function () {
      if (!ed) return;
      resetSteps();
      render();
    });
    overlay.querySelector('.slicer-shuffle').addEventListener('click', function () {
      if (!ed) return;
      var order = ed.steps.map(function (s) { return s.src; });
      for (var i = order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = order[i]; order[i] = order[j]; order[j] = t;
      }
      ed.steps.forEach(function (s, k) { s.src = order[k]; s.mute = false; });
      render();
    });
    ui.previewBtn.addEventListener('click', togglePreview);
    overlay.querySelector('.slicer-apply').addEventListener('click', apply);

    function stepAt(e) {
      var rect = canvas.getBoundingClientRect();
      var x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width - 1);
      return Math.min(ed.steps.length - 1, Math.floor(x / rect.width * ed.steps.length));
    }
    canvas.addEventListener('mousedown', function (e) {
      if (!ed) return;
      drag = { from: stepAt(e), to: stepAt(e) };
    });
    window.addEventListener('mousemove', function (e) {
      if (!ed || !drag) return;
      var s = stepAt(e);
      if (s !== drag.to) { drag.to = s; render(); }
    });
    window.addEventListener('mouseup', function (e) {
      if (!ed || !drag) return;
      var d = drag;
      drag = null;
      if (d.from === d.to) {
        ed.steps[d.from].mute = !ed.steps[d.from].mute;
      } else {
        var src = ed.steps[d.from];
        ed.steps[d.to] = { src: src.src, rev: src.rev, mute: false };
      }
      render();
    });
    canvas.addEventListener('dblclick', function (e) {
      if (!ed) return;
      var s = stepAt(e);
      ed.steps[s].mute = false;      // the double click toggled mute twice already
      ed.steps[s].rev = !ed.steps[s].rev;
      render();
    });
  }

  function render() {
    var c = ui.canvas, g = ui.g;
    var W = c.width, H = c.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#14161a';
    g.fillRect(0, 0, W, H);
    var K = ed.steps.length;
    var stepW = W / K;

    for (var k = 0; k < K; k++) {
      var st = ed.steps[k];
      var x0 = k * stepW;
      var moved = st.src !== k;
      // region background
      if (st.mute) g.fillStyle = 'rgba(139,147,165,0.07)';
      else if (moved) g.fillStyle = 'rgba(181,140,255,0.12)';
      else g.fillStyle = 'transparent';
      if (g.fillStyle !== 'transparent') g.fillRect(x0, 0, stepW, H);

      // waveform of the source slice
      if (!st.mute) {
        var s0 = bound(st.src), s1 = bound(st.src + 1);
        g.strokeStyle = moved ? '#b58cff' : '#3ddc84';
        g.beginPath();
        var cols = Math.max(1, Math.floor(stepW));
        for (var px = 0; px < cols; px++) {
          var frac = px / cols;
          if (st.rev) frac = 1 - frac;
          var a0 = s0 + Math.floor(frac * (s1 - s0));
          var a1 = Math.min(s1, a0 + Math.max(1, Math.floor((s1 - s0) / cols)));
          var lo = 1, hi = -1;
          for (var i = a0; i < a1; i++) {
            var v0 = Math.min(ed.L[i], ed.R[i]), v1 = Math.max(ed.L[i], ed.R[i]);
            if (v0 < lo) lo = v0;
            if (v1 > hi) hi = v1;
          }
          if (lo > hi) { lo = 0; hi = 0; }
          g.moveTo(x0 + px + 0.5, mid - hi * (mid - 14));
          g.lineTo(x0 + px + 0.5, mid - lo * (mid - 14) + 0.5);
        }
        g.stroke();
      }

      // slice boundary + labels
      g.strokeStyle = 'rgba(216,220,230,0.25)';
      g.beginPath(); g.moveTo(x0 + 0.5, 0); g.lineTo(x0 + 0.5, H); g.stroke();
      g.fillStyle = '#8b93a5';
      g.font = '9px sans-serif';
      var label = st.mute ? '—' : String(st.src + 1) + (st.rev ? '◀' : '');
      g.fillText(label, x0 + 3, 10);
    }

    // drag feedback
    if (drag && drag.from !== drag.to) {
      g.fillStyle = 'rgba(77,163,255,0.25)';
      g.fillRect(drag.to * stepW, 0, stepW, H);
    }

    ui.info.textContent = K + ' slices · ' + (ed.len / ed.sr).toFixed(2) + 's' +
      (previewNode ? ' · PREVIEWING' : '');
  }

  /* ---------------- preview / apply ---------------- */
  function stopPreview() {
    if (previewNode) {
      try { previewNode.stop(); } catch (e) {}
      previewNode = null;
      ui.previewBtn.textContent = 'PREVIEW';
    }
  }

  function togglePreview() {
    if (!ed) return;
    if (previewNode) { stopPreview(); render(); return; }
    var ctx = ed.engine.ctx;
    var built = buildBuffers();
    var buf = ctx.createBuffer(2, ed.len, ed.sr);
    buf.getChannelData(0).set(built.L);
    buf.getChannelData(1).set(built.R);
    previewNode = ctx.createBufferSource();
    previewNode.buffer = buf;
    previewNode.loop = true;
    previewNode.connect(ed.engine.masterGain);
    previewNode.start();
    ui.previewBtn.textContent = 'STOP PRE';
    render();
  }

  function apply() {
    if (!ed) return;
    stopPreview();
    var built = buildBuffers();
    var ok = ed.ch.applyEdit(built.L, built.R, 0);
    if (!ok) {
      ed.status('Cannot apply while the loop is recording or overdubbing.');
      return;
    }
    ed.status('Sliced audio applied to loop ' + ed.chLabel + ' (playing through its FX).');
    render();
  }

  function close() {
    stopPreview();
    ui.overlay.classList.add('hidden');
    ed = null;
  }

  /* ---------------- entry ---------------- */
  async function open(engine, ch, chLabel, statusFn) {
    if (!ui) buildUI();
    if (ch.state !== 'playing' && ch.state !== 'stopped') {
      if (statusFn) statusFn('Nothing to slice on loop ' + chLabel + ' yet.');
      return;
    }
    var snap = await ch.requestSnapshot();
    if (!snap.len || !snap.bufL) {
      if (statusFn) statusFn('Loop ' + chLabel + ' has no audio.');
      return;
    }
    var L = new Float32Array(snap.bufL);
    ed = {
      engine: engine, ch: ch, chLabel: chLabel, status: statusFn || function () {},
      sr: engine.ctx.sampleRate,
      L: L, R: new Float32Array(snap.bufR), len: L.length,
      sliceFrames: 0, steps: []
    };

    // grid options depend on whether a tempo grid exists
    ui.div.innerHTML = '';
    var opts = engine.transport.tempoLocked
      ? [['1', 'Beat'], ['2', '1/8'], ['4', '1/16']]
      : [['8', '8 slices'], ['16', '16 slices'], ['32', '32 slices']];
    opts.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o[0];
      el.textContent = o[1];
      ui.div.appendChild(el);
    });
    ui.div.value = engine.transport.tempoLocked ? '2' : '16';
    ed.sliceFrames = sliceFramesFor(ui.div.value);
    resetSteps();

    ui.title.textContent = 'SLICE LOOP ' + chLabel;
    ui.overlay.classList.remove('hidden');
    ui.canvas.width = ui.canvas.clientWidth || 900;
    render();
  }

  window.BeatSlicer = { open: open };
})();
