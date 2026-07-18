/* Effect definitions. Each build(ctx) returns { input, output, set(paramId, value), dispose() }.
   input/output are AudioNodes; the channel chains them between its worklet and gain. */
(function () {
  'use strict';

  function makeReverbIR(ctx, seconds) {
    var sr = ctx.sampleRate;
    var len = Math.max(1, Math.floor(sr * seconds));
    var ir = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = ir.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    return ir;
  }

  function distortionCurve(amount) {
    var k = amount, n = 2048, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  window.FX_DEFS = {
    lpf: {
      name: 'Low-pass Filter',
      params: [
        { id: 'freq', label: 'Cutoff', min: 100, max: 18000, def: 6000, log: true, unit: 'Hz' },
        { id: 'q', label: 'Reso', min: 0.1, max: 14, def: 0.8, unit: '' }
      ],
      build: function (ctx) {
        var f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        return {
          input: f, output: f,
          set: function (id, v) {
            if (id === 'freq') f.frequency.setTargetAtTime(v, ctx.currentTime, 0.01);
            else f.Q.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { f.disconnect(); }
        };
      }
    },

    hpf: {
      name: 'High-pass Filter',
      params: [
        { id: 'freq', label: 'Cutoff', min: 30, max: 8000, def: 300, log: true, unit: 'Hz' },
        { id: 'q', label: 'Reso', min: 0.1, max: 14, def: 0.8, unit: '' }
      ],
      build: function (ctx) {
        var f = ctx.createBiquadFilter();
        f.type = 'highpass';
        return {
          input: f, output: f,
          set: function (id, v) {
            if (id === 'freq') f.frequency.setTargetAtTime(v, ctx.currentTime, 0.01);
            else f.Q.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { f.disconnect(); }
        };
      }
    },

    delay: {
      name: 'Delay',
      params: [
        { id: 'time', label: 'Time', min: 30, max: 1500, def: 350, unit: 'ms' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.92, def: 0.35, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.3, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var dly = ctx.createDelay(2.0), fb = ctx.createGain(), wet = ctx.createGain();
        input.connect(output);            // dry
        input.connect(dly);
        dly.connect(wet); wet.connect(output);
        dly.connect(fb); fb.connect(dly);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'time') dly.delayTime.setTargetAtTime(v / 1000, ctx.currentTime, 0.05);
            else if (id === 'fb') fb.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { input.disconnect(); dly.disconnect(); fb.disconnect(); wet.disconnect(); }
        };
      }
    },

    reverb: {
      name: 'Reverb',
      params: [
        { id: 'decay', label: 'Decay', min: 0.3, max: 8, def: 2.2, unit: 's' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.35, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var conv = ctx.createConvolver(), wet = ctx.createGain();
        conv.buffer = makeReverbIR(ctx, 2.2);
        input.connect(output);            // dry
        input.connect(conv); conv.connect(wet); wet.connect(output);
        var regenTimer = null;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'mix') { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); return; }
            clearTimeout(regenTimer);
            regenTimer = setTimeout(function () { conv.buffer = makeReverbIR(ctx, v); }, 250);
          },
          dispose: function () { clearTimeout(regenTimer); input.disconnect(); conv.disconnect(); wet.disconnect(); }
        };
      }
    },

    dist: {
      name: 'Distortion',
      params: [
        { id: 'drive', label: 'Drive', min: 1, max: 120, def: 20, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var shaper = ctx.createWaveShaper(), wet = ctx.createGain(), dry = ctx.createGain();
        shaper.curve = distortionCurve(20);
        shaper.oversample = '4x';
        input.connect(dry); dry.connect(output);
        input.connect(shaper); shaper.connect(wet); wet.connect(output);
        dry.gain.value = 0; wet.gain.value = 1;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'drive') shaper.curve = distortionCurve(v);
            else {
              wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
              dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01);
            }
          },
          dispose: function () { input.disconnect(); shaper.disconnect(); wet.disconnect(); dry.disconnect(); }
        };
      }
    },

    chorus: {
      name: 'Chorus',
      params: [
        { id: 'rate', label: 'Rate', min: 0.05, max: 5, def: 0.8, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 12, def: 3.5, unit: 'ms' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var dly = ctx.createDelay(0.1), wet = ctx.createGain();
        var osc = ctx.createOscillator(), lfoGain = ctx.createGain();
        dly.delayTime.value = 0.02;
        osc.frequency.value = 0.8;
        lfoGain.gain.value = 0.0035;
        osc.connect(lfoGain); lfoGain.connect(dly.delayTime);
        osc.start();
        input.connect(output);            // dry
        input.connect(dly); dly.connect(wet); wet.connect(output);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'rate') osc.frequency.setTargetAtTime(v, ctx.currentTime, 0.05);
            else if (id === 'depth') lfoGain.gain.setTargetAtTime(v / 1000, ctx.currentTime, 0.05);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () {
            try { osc.stop(); } catch (e) {}
            input.disconnect(); dly.disconnect(); wet.disconnect(); osc.disconnect(); lfoGain.disconnect();
          }
        };
      }
    }
  };
})();
