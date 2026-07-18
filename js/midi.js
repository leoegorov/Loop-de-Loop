/* MIDI: clock output (24 ppqn, lookahead-scheduled) + MIDI-learn input mapping. */
(function () {
  'use strict';

  var MIDI_CLOCK = 0xF8, MIDI_START = 0xFA, MIDI_STOP = 0xFC;

  function MidiManager(engine) {
    this.engine = engine;
    this.access = null;
    this.output = null;

    // clock
    this.clockRunning = false;
    this.nextTick = 0;         // performance.now() ms of next clock tick
    this.timer = null;
    this.onClockState = null;

    // learn / mapping
    this.map = {};             // "cc:<ch>:<num>" | "note:<ch>:<num>" -> actionId
    this.learnTarget = null;   // actionId currently being armed
    this.onLearned = null;     // (key, actionId) -> void
    this.dispatch = null;      // (actionId, value01orNull) -> void
    this.ccState = {};         // edge detection for CC-as-button

    try {
      var saved = localStorage.getItem('looping-midi-map');
      if (saved) this.map = JSON.parse(saved);
    } catch (e) {}
  }

  MidiManager.prototype.init = async function () {
    if (!navigator.requestMIDIAccess) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      return false;
    }
    var self = this;
    this.access.inputs.forEach(function (input) {
      input.onmidimessage = function (e) { self.onMessage(e); };
    });
    this.access.onstatechange = function () {
      self.access.inputs.forEach(function (input) {
        input.onmidimessage = function (e) { self.onMessage(e); };
      });
    };
    return true;
  };

  MidiManager.prototype.getOutputs = function () {
    var list = [];
    if (this.access) this.access.outputs.forEach(function (o) { list.push(o); });
    return list;
  };

  MidiManager.prototype.setOutput = function (id) {
    this.output = null;
    if (this.access && id) this.output = this.access.outputs.get(id) || null;
  };

  /* ---- clock ---- */
  MidiManager.prototype.tickMs = function () {
    return 60000 / (this.engine.transport.bpm * 24);
  };

  /* Start the clock phase-aligned so a tick lands exactly on the transport origin frame. */
  MidiManager.prototype.startClock = function (originFrame) {
    var originPerf = this.engine.frameToPerf(originFrame);
    var now = performance.now();
    var tick = this.tickMs();
    // find first tick >= now on the grid anchored at originPerf
    var k = Math.max(0, Math.ceil((now - originPerf) / tick));
    this.nextTick = originPerf + k * tick;
    if (this.output) {
      // Start message just before the first tick; synth begins on that tick
      this.output.send([MIDI_START], Math.max(now, this.nextTick - 2));
    }
    this.clockRunning = true;
    this.ensureTimer();
    if (this.onClockState) this.onClockState(true);
  };

  MidiManager.prototype.rebase = function () {
    // BPM changed while running: keep phase continuous from nextTick
    // (nextTick stays, only the interval changes — handled naturally in pump)
  };

  MidiManager.prototype.stopClock = function () {
    if (this.output && this.clockRunning) this.output.send([MIDI_STOP]);
    this.clockRunning = false;
    if (this.onClockState) this.onClockState(false);
  };

  MidiManager.prototype.sendStop = function () {
    if (this.output) this.output.send([MIDI_STOP]);
  };

  MidiManager.prototype.ensureTimer = function () {
    if (this.timer) return;
    var self = this;
    this.timer = setInterval(function () { self.pump(); }, 20);
  };

  MidiManager.prototype.pump = function () {
    if (!this.clockRunning || !this.output) return;
    var horizon = performance.now() + 120;
    var tick = this.tickMs();
    var guard = 0;
    while (this.nextTick < horizon && guard++ < 400) {
      this.output.send([MIDI_CLOCK], Math.max(this.nextTick, performance.now()));
      this.nextTick += tick;
    }
  };

  /* ---- input handling: learn + dispatch ---- */
  MidiManager.prototype.onMessage = function (e) {
    var d = e.data;
    if (!d || d.length < 2) return;
    var status = d[0] & 0xF0;
    var ch = d[0] & 0x0F;
    var key = null, value = null, isButtonPress = false;

    if (status === 0x90 && d[2] > 0) {            // note on
      key = 'note:' + ch + ':' + d[1];
      isButtonPress = true;
      value = d[2] / 127;
    } else if (status === 0xB0) {                 // CC
      key = 'cc:' + ch + ':' + d[1];
      value = d[2] / 127;
      var prev = this.ccState[key] || 0;
      isButtonPress = d[2] > 63 && prev <= 63;    // rising edge for button-style use
      this.ccState[key] = d[2];
    } else if (status === 0x80 || status === 0x90) { // note off (incl. vel-0 note-on): forward raw
      if (this.onRaw) this.onRaw([d[0], d[1], d[2] || 0], e.timeStamp);
      return;
    } else {
      return;
    }

    if (this.learnTarget) {
      // remove any old binding of this control and of this action
      for (var k in this.map) if (this.map[k] === this.learnTarget) delete this.map[k];
      this.map[key] = this.learnTarget;
      this.save();
      var target = this.learnTarget;
      this.learnTarget = null;
      if (this.onLearned) this.onLearned(key, target);
      return;
    }

    var actionId = this.map[key];
    if (actionId && this.dispatch) {
      var continuous = actionId.indexOf(':vol') >= 0 || actionId === 'global:masterVol';
      if (continuous) {
        this.dispatch(actionId, value);
      } else if (isButtonPress) {
        this.dispatch(actionId, null);
      }
      return; // consumed as a control — don't also treat as performance MIDI
    }

    // unmapped performance MIDI (notes for arm-trigger, notes/CCs for MIDI-loop capture)
    if (this.onRaw && (status === 0x90 || status === 0xB0)) {
      this.onRaw([d[0], d[1], d[2] || 0], e.timeStamp);
    }
  };

  MidiManager.prototype.arm = function (actionId) { this.learnTarget = actionId; };
  MidiManager.prototype.disarm = function () { this.learnTarget = null; };
  MidiManager.prototype.save = function () {
    try { localStorage.setItem('looping-midi-map', JSON.stringify(this.map)); } catch (e) {}
  };
  MidiManager.prototype.bindingFor = function (actionId) {
    for (var k in this.map) if (this.map[k] === actionId) return k;
    return null;
  };

  window.MidiManager = MidiManager;
})();
