/* 808-style drum machine: synthesized kit (no samples) + 16-step sequencer,
   phase-locked to the engine transport (16ths of the master bar). */
(function () {
  'use strict';

  var INSTRUMENTS = [
    { id: 'bd', label: 'KICK' },
    { id: 'sd', label: 'SNARE' },
    { id: 'ch', label: 'CL HAT' },
    { id: 'oh', label: 'OP HAT' },
    { id: 'cp', label: 'CLAP' }
  ];

  function DrumMachine(engine) {
    this.engine = engine;
    this.enabled = false;
    this.pattern = {};
    this.levels = { bd: 1.0, sd: 0.8, ch: 0.55, oh: 0.55, cp: 0.75 };
    var self = this;
    INSTRUMENTS.forEach(function (inst) {
      self.pattern[inst.id] = new Array(16).fill(false);
    });
    this.out = engine.ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(engine.masterGain);
    this.schedFrom = null;
    this.openHatGain = null;   // for closed-hat choking the open hat, 808 style
    this.cells = null;         // UI step cells [instIdx][step]
    this.noiseBuf = this.makeNoise();
  }

  DrumMachine.prototype.makeNoise = function () {
    var ctx = this.engine.ctx;
    var buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  };

  DrumMachine.prototype.setVolume = function (v) {
    this.out.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  };

  DrumMachine.prototype.clearPattern = function () {
    var self = this;
    INSTRUMENTS.forEach(function (inst) {
      self.pattern[inst.id].fill(false);
    });
    if (this.cells) {
      this.cells.forEach(function (row) {
        row.forEach(function (cell) { cell.classList.remove('on'); });
      });
    }
  };

  /* ---- voices (classic 808 recipes, synthesized) ---- */

  DrumMachine.prototype.noiseSource = function (when, dur) {
    var ctx = this.engine.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start(when);
    src.stop(when + dur);
    return src;
  };

  DrumMachine.prototype.play = function (id, when, vel) {
    var ctx = this.engine.ctx;
    var out = this.out;
    var g = ctx.createGain();
    g.connect(out);

    if (id === 'bd') {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, when);
      o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      g.gain.setValueAtTime(vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.5);
      o.connect(g);
      o.start(when); o.stop(when + 0.55);

    } else if (id === 'sd') {
      var t1 = ctx.createOscillator();
      t1.type = 'triangle';
      t1.frequency.value = 185;
      var tg = ctx.createGain();
      tg.gain.setValueAtTime(vel * 0.5, when);
      tg.gain.exponentialRampToValueAtTime(0.001, when + 0.12);
      t1.connect(tg); tg.connect(out);
      t1.start(when); t1.stop(when + 0.15);
      var n = this.noiseSource(when, 0.25);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      g.gain.setValueAtTime(vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
      n.connect(bp); bp.connect(g);

    } else if (id === 'ch' || id === 'oh') {
      var dur = id === 'ch' ? 0.055 : 0.4;
      if (id === 'ch' && this.openHatGain) {
        // closed hat chokes a ringing open hat
        this.openHatGain.gain.setTargetAtTime(0.0001, when, 0.008);
        this.openHatGain = null;
      }
      var hn = this.noiseSource(when, dur + 0.05);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7500;
      g.gain.setValueAtTime(vel * 0.8, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + dur);
      hn.connect(hp); hp.connect(g);
      if (id === 'oh') this.openHatGain = g;

    } else if (id === 'cp') {
      var cn = this.noiseSource(when, 0.35);
      var cb = ctx.createBiquadFilter();
      cb.type = 'bandpass'; cb.frequency.value = 1200; cb.Q.value = 1.6;
      g.gain.setValueAtTime(0.0001, when);
      for (var i = 0; i < 3; i++) {         // three quick bursts, then the tail
        g.gain.setValueAtTime(vel, when + i * 0.011);
        g.gain.exponentialRampToValueAtTime(vel * 0.25, when + i * 0.011 + 0.009);
      }
      g.gain.setValueAtTime(vel * 0.7, when + 0.033);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
      cn.connect(cb); cb.connect(g);
    }
  };

  /* ---- sequencer: look-ahead scheduling on the transport grid ---- */
  DrumMachine.prototype.pump = function () {
    var t = this.engine.transport;
    if (!this.enabled || !t.running) { this.schedFrom = null; return; }
    var sr = t.sr;
    var nowF = t.nowFrame();
    var horizon = nowF + 0.15 * sr;
    var stepF = t.beatFrames() / 4;
    var from = (this.schedFrom === null || this.schedFrom < nowF) ? nowF : this.schedFrom;
    var k = Math.floor((from - t.origin) / stepF) + 1;
    for (var f = t.origin + k * stepF; f <= horizon; f += stepF, k++) {
      var step = ((k % 16) + 16) % 16;
      var when = f / sr;
      for (var i = 0; i < INSTRUMENTS.length; i++) {
        var id = INSTRUMENTS[i].id;
        if (this.pattern[id][step]) this.play(id, when, this.levels[id]);
      }
    }
    this.schedFrom = horizon;
  };

  /* ---- UI ---- */
  DrumMachine.prototype.mountUI = function (grid) {
    var self = this;
    this.cells = [];
    INSTRUMENTS.forEach(function (inst, row) {
      var rowEl = document.createElement('div');
      rowEl.className = 'drum-row';

      var label = document.createElement('button');
      label.className = 'drum-label';
      label.textContent = inst.label;
      label.title = 'Preview ' + inst.label;
      label.addEventListener('click', function () {
        self.play(inst.id, self.engine.ctx.currentTime + 0.02, self.levels[inst.id]);
      });
      rowEl.appendChild(label);

      var rowCells = [];
      for (var s = 0; s < 16; s++) {
        (function (s2) {
          var cell = document.createElement('button');
          cell.className = 'step' + (s2 % 4 === 0 ? ' beat1' : '');
          cell.addEventListener('click', function () {
            self.pattern[inst.id][s2] = !self.pattern[inst.id][s2];
            cell.classList.toggle('on', self.pattern[inst.id][s2]);
          });
          rowEl.appendChild(cell);
          rowCells.push(cell);
        })(s);
      }
      self.cells.push(rowCells);

      var lvl = document.createElement('input');
      lvl.type = 'range';
      lvl.min = 0; lvl.max = 1.2; lvl.step = 0.01;
      lvl.value = self.levels[inst.id];
      lvl.className = 'drum-level';
      lvl.title = inst.label + ' level';
      lvl.addEventListener('input', function () {
        self.levels[inst.id] = parseFloat(this.value);
      });
      rowEl.appendChild(lvl);

      grid.appendChild(rowEl);
    });
    this.lastStepShown = -1;
  };

  /* Called from the UI animation loop: highlight the current step column. */
  DrumMachine.prototype.updatePlayhead = function () {
    if (!this.cells) return;
    var t = this.engine.transport;
    var step = -1;
    if (this.enabled && t.running) {
      var stepF = t.beatFrames() / 4;
      step = Math.floor((t.nowFrame() - t.origin) / stepF);
      step = ((step % 16) + 16) % 16;
    }
    if (step === this.lastStepShown) return;
    var prev = this.lastStepShown;
    this.lastStepShown = step;
    this.cells.forEach(function (row) {
      if (prev >= 0) row[prev].classList.remove('now');
      if (step >= 0) row[step].classList.add('now');
    });
  };

  window.DrumMachine = DrumMachine;
})();
