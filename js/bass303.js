/* TB-303-style bass synth: mono saw/square voice → resonant lowpass with envelope
   modulation, accent and slide, driven by a 16-step pattern (pitch per step + ACC /
   SLIDE rows), phase-locked to the engine transport like the 808 drums. */
(function () {
  'use strict';

  var PITCH_HI = 59, PITCH_LO = 36;          // B3 .. C2
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function noteName(p) { return NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1); }
  function midiFreq(p) { return 440 * Math.pow(2, (p - 69) / 12); }

  function Bass303(engine) {
    this.engine = engine;
    this.enabled = false;
    this.schedFrom = null;
    this.pattern = [];
    for (var i = 0; i < 16; i++) this.pattern.push({ pitch: null, acc: false, slide: false });
    this.patterns = [null, null, null, null];   // bank A/B/C/D, each = 16-step snapshot
    this.curSlot = 0;
    this.songSource = null;   // when set: fn(frame)->16-step pattern or null (song playback)

    // knobs
    this.cutoff = 700;
    this.reso = 12;
    this.envMod = 0.6;
    this.decay = 0.25;

    var ctx = engine.ctx;
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.cutoff;
    this.filter.Q.value = this.reso;
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.osc.connect(this.filter);
    this.filter.connect(this.vca);
    this.vca.connect(this.out);
    this.out.connect(engine.masterGain);
    this.osc.start();

    this.cells = null;       // [row][col] pitch cells
    this.accCells = null;
    this.slideCells = null;
    this.headCells = null;   // playhead markers
    this.lastStepShown = -1;
  }

  Bass303.prototype.setVolume = function (v) {
    this.out.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  };
  Bass303.prototype.setWave = function (w) { this.osc.type = w; };
  Bass303.prototype.setReso = function (q) {
    this.reso = q;
    this.filter.Q.setTargetAtTime(q, this.engine.ctx.currentTime, 0.01);
  };

  Bass303.prototype.silence = function () {
    var t = this.engine.ctx.currentTime;
    this.vca.gain.cancelScheduledValues(t);
    this.vca.gain.setTargetAtTime(0, t, 0.01);
  };

  Bass303.prototype.clearPattern = function () {
    this.pattern.forEach(function (s) { s.pitch = null; s.acc = false; s.slide = false; });
    this.refreshGrid();
  };

  /* ---- pattern bank (A/B/C/D) ---- */
  Bass303.prototype.snapshot = function () {
    return this.pattern.map(function (s) { return { pitch: s.pitch, acc: s.acc, slide: s.slide }; });
  };
  Bass303.prototype.syncSlot = function () { this.patterns[this.curSlot] = this.snapshot(); };
  Bass303.prototype.slotHasContent = function (i) {
    var p = this.patterns[i];
    return !!(p && p.some(function (s) { return s.pitch !== null; }));
  };
  Bass303.prototype.loadSlot = function (i) {
    var snap = this.patterns[i];
    for (var s = 0; s < 16; s++) {
      var src = snap && snap[s] ? snap[s] : { pitch: null, acc: false, slide: false };
      this.pattern[s].pitch = src.pitch; this.pattern[s].acc = src.acc; this.pattern[s].slide = src.slide;
    }
    this.refreshGrid();
  };
  Bass303.prototype.switchSlot = function (i) {
    this.syncSlot();
    this.curSlot = i;
    this.loadSlot(i);
  };

  /* ---- voice scheduling ---- */
  Bass303.prototype.trigger = function (t, dur, st, prev, next) {
    var f = this.filter.frequency, g = this.vca.gain, o = this.osc.frequency;
    var freq = midiFreq(st.pitch);
    var slidInto = prev && prev.pitch !== null && prev.slide;
    var level = st.acc ? 1.0 : 0.65;

    if (slidInto) o.setTargetAtTime(freq, t, 0.025);   // glide, no retrigger
    else o.setValueAtTime(freq, t);

    g.cancelScheduledValues(t);
    if (slidInto) {
      g.setValueAtTime(level, t);
    } else {
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(level, t + 0.004);
      var base = this.cutoff;
      var peak = Math.min(14000, base + this.envMod * 9000 * (st.acc ? 1.6 : 1));
      f.cancelScheduledValues(t);
      f.setValueAtTime(peak, t);
      f.setTargetAtTime(base, t + 0.004, Math.max(0.03, this.decay * (st.acc ? 0.5 : 1)));
    }

    var slideOut = st.slide && next && next.pitch !== null;
    if (!slideOut) {
      var gateEnd = t + dur * 0.55;
      g.setValueAtTime(level, gateEnd);
      g.setTargetAtTime(0, gateEnd, 0.012);
    }
  };

  Bass303.prototype.previewStep = function (st) {
    if (this.enabled || st.pitch === null) return;
    var t = this.engine.ctx.currentTime + 0.02;
    this.trigger(t, 0.22, st, null, null);
  };

  /* ---- sequencer pump (look-ahead, same grid as the drums) ---- */
  Bass303.prototype.pump = function () {
    var t = this.engine.transport;
    if (!this.enabled || !t.running) {
      if (this.schedFrom !== null) { this.silence(); this.schedFrom = null; }
      return;
    }
    var sr = t.sr;
    var nowF = t.nowFrame();
    var horizon = nowF + 0.15 * sr;
    var stepF = t.beatFrames() / 4;
    var from = (this.schedFrom === null || this.schedFrom < nowF) ? nowF : this.schedFrom;
    var k = Math.floor((from - t.origin) / stepF) + 1;
    for (var fr = t.origin + k * stepF; fr <= horizon; fr += stepF, k++) {
      var pat = this.pattern;
      if (this.songSource) {
        pat = this.songSource(fr);
        if (!pat) continue;   // song says silent this bar
      }
      var step = ((k % 16) + 16) % 16;
      var st = pat[step];
      var prev = pat[(step + 15) % 16];
      var next = pat[(step + 1) % 16];
      var when = fr / sr;
      if (st.pitch !== null) {
        this.trigger(when, stepF / sr, st, prev, next);
      } else if (prev.pitch !== null && prev.slide) {
        // slide into a rest: close the still-open gate
        this.vca.gain.setTargetAtTime(0, when, 0.012);
      }
    }
    this.schedFrom = horizon;
  };

  /* ---- UI ---- */
  Bass303.prototype.mountUI = function (grid) {
    var self = this;
    var rows = [];
    this.cells = [];
    this.headCells = [];

    var head = document.createElement('div');
    head.className = 'drum-row bass-row';
    head.appendChild(labelEl(''));
    for (var h = 0; h < 16; h++) {
      var hc = document.createElement('div');
      hc.className = 'bass-head-cell' + (h % 4 === 0 ? ' beat1' : '');
      head.appendChild(hc);
      this.headCells.push(hc);
    }
    grid.appendChild(head);

    function labelEl(text) {
      var el = document.createElement('span');
      el.className = 'bass-label';
      el.textContent = text;
      return el;
    }

    for (var p = PITCH_HI; p >= PITCH_LO; p--) {
      (function (pitch) {
        var rowEl = document.createElement('div');
        rowEl.className = 'drum-row bass-row' + (pitch % 12 === 0 ? ' c-row' : '');
        rowEl.appendChild(labelEl(noteName(pitch)));
        var rowCells = [];
        for (var s = 0; s < 16; s++) {
          (function (col) {
            var cell = document.createElement('button');
            cell.className = 'step bass-step' + (col % 4 === 0 ? ' beat1' : '');
            cell.addEventListener('click', function () {
              var st = self.pattern[col];
              st.pitch = st.pitch === pitch ? null : pitch;
              self.refreshGrid();
              self.previewStep(st);
            });
            rowEl.appendChild(cell);
            rowCells.push(cell);
          })(s);
        }
        self.cells.push(rowCells);
        rows.push(rowEl);
        grid.appendChild(rowEl);
      })(p);
    }

    var makeModRow = function (name, key) {
      var rowEl = document.createElement('div');
      rowEl.className = 'drum-row bass-row mod-row';
      rowEl.appendChild(labelEl(name));
      var cells = [];
      for (var s = 0; s < 16; s++) {
        (function (col) {
          var cell = document.createElement('button');
          cell.className = 'step bass-step mod' + (col % 4 === 0 ? ' beat1' : '');
          cell.addEventListener('click', function () {
            self.pattern[col][key] = !self.pattern[col][key];
            self.refreshGrid();
          });
          rowEl.appendChild(cell);
          cells.push(cell);
        })(s);
      }
      grid.appendChild(rowEl);
      return cells;
    };
    this.accCells = makeModRow('ACC', 'acc');
    this.slideCells = makeModRow('SLD', 'slide');
    this.refreshGrid();
  };

  Bass303.prototype.refreshGrid = function () {
    var self = this;
    if (!this.cells) return;
    for (var r = 0; r < this.cells.length; r++) {
      var pitch = PITCH_HI - r;
      for (var c = 0; c < 16; c++) {
        this.cells[r][c].classList.toggle('on', this.pattern[c].pitch === pitch);
      }
    }
    for (var s = 0; s < 16; s++) {
      this.accCells[s].classList.toggle('on', this.pattern[s].acc);
      this.slideCells[s].classList.toggle('on', this.pattern[s].slide);
    }
  };

  Bass303.prototype.updatePlayhead = function () {
    if (!this.headCells) return;
    var t = this.engine.transport;
    var step = -1;
    if (this.enabled && t.running) {
      var stepF = t.beatFrames() / 4;
      step = Math.floor((t.nowFrame() - t.origin) / stepF);
      step = ((step % 16) + 16) % 16;
    }
    if (step === this.lastStepShown) return;
    if (this.lastStepShown >= 0) this.headCells[this.lastStepShown].classList.remove('now');
    if (step >= 0) this.headCells[step].classList.add('now');
    this.lastStepShown = step;
  };

  window.Bass303 = Bass303;
})();
