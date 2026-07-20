/* Effects + FxRack: a shared effect-chain component with per-parameter LFO
  automation for loop channels.

   Effect contract: def.build(ctx, engine) -> { input, output, set(id, v),
   tick(transport)?, dispose() }. Params are range sliders ({min,max,def,log,
   unit,auto}) or selects ({type:'select', options:[[value,label],...]}).
   Automation runs on a single shared ticker, phase-locked to the transport. */
(function () {
  'use strict';

  var RATE_BEATS = {
    '1/16': 0.25, '1/8': 0.5, '1/8.': 0.75, '1/4': 1,
    '1/2': 2, '1/1': 4, '2/1': 8, '4/1': 16
  };
  var SYNC_OPTS = [['off', 'free'], ['1/16', '1/16'], ['1/8', '1/8'], ['1/8.', '1/8.'],
    ['1/4', '1/4'], ['1/2', '1/2'], ['1/1', '1 bar']];

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

  /* ---------------- sample-level DSP worklet ----------------
     Bitcrusher, frequency shifter (Hilbert SSB) and a granular pitch shifter —
     the effects that need per-sample math. Loaded once; node effects fall back
     to a passthrough/approximation if it isn't ready. */
  var FX_DSP_SRC = [
    'class Crush extends AudioWorkletProcessor {',
    '  static get parameterDescriptors(){ return [',
    '    {name:"bits",defaultValue:8,minValue:1,maxValue:16,automationRate:"k-rate"},',
    '    {name:"reduce",defaultValue:0.5,minValue:0.02,maxValue:1,automationRate:"k-rate"}]; }',
    '  constructor(){ super(); this.hl=0; this.hr=0; this.ph=1; }',
    '  process(inputs,outputs,p){ var I=inputs[0],O=outputs[0]; if(!I||!I[0])return true;',
    '    var il=I[0], ir=I[1]||I[0], ol=O[0], orr=O[1]||O[0];',
    '    var bits=p.bits[0], red=p.reduce[0], step=Math.pow(2,bits-1);',
    '    for(var i=0;i<il.length;i++){ this.ph+=red; if(this.ph>=1){ this.ph-=1; this.hl=il[i]; this.hr=ir[i]; }',
    '      ol[i]=Math.round(this.hl*step)/step; orr[i]=Math.round(this.hr*step)/step; } return true; } }',
    'registerProcessor("fx-crush", Crush);',
    'class FShift extends AudioWorkletProcessor {',
    '  static get parameterDescriptors(){ return [{name:"shift",defaultValue:0,minValue:-3000,maxValue:3000,automationRate:"k-rate"}]; }',
    '  constructor(){ super(); this.N=65; this.c=(this.N-1)>>1; this.h=new Float32Array(this.N);',
    '    for(var n=0;n<this.N;n++){ var k=n-this.c, v=0; if(k!==0 && (k&1)) v=2/(Math.PI*k);',
    '      this.h[n]=v*(0.54-0.46*Math.cos(2*Math.PI*n/(this.N-1))); }',
    '    this.bl=new Float32Array(this.N); this.br=new Float32Array(this.N); this.pos=0; this.phase=0; }',
    '  process(inputs,outputs,p){ var I=inputs[0],O=outputs[0]; if(!I||!I[0])return true;',
    '    var il=I[0], ir=I[1]||I[0], ol=O[0], orr=O[1]||O[0], f=p.shift[0], N=this.N, c=this.c;',
    '    for(var i=0;i<il.length;i++){ this.bl[this.pos]=il[i]; this.br[this.pos]=ir[i];',
    '      var iml=0, imr=0; for(var k=0;k<N;k++){ var idx=(this.pos-k+2*N)%N; iml+=this.h[k]*this.bl[idx]; imr+=this.h[k]*this.br[idx]; }',
    '      var rel=this.bl[(this.pos-c+2*N)%N], rer=this.br[(this.pos-c+2*N)%N];',
    '      this.phase+=2*Math.PI*f/sampleRate; if(this.phase>Math.PI)this.phase-=2*Math.PI; else if(this.phase<-Math.PI)this.phase+=2*Math.PI;',
    '      var cs=Math.cos(this.phase), sn=Math.sin(this.phase);',
    '      ol[i]=rel*cs-iml*sn; orr[i]=rer*cs-imr*sn; this.pos=(this.pos+1)%N; } return true; } }',
    'registerProcessor("fx-fshift", FShift);',
    'class Pitch extends AudioWorkletProcessor {',
    '  static get parameterDescriptors(){ return [{name:"ratio",defaultValue:1,minValue:0.5,maxValue:2,automationRate:"k-rate"}]; }',
    '  constructor(){ super(); this.G=Math.round(sampleRate*0.05); this.size=this.G*4;',
    '    this.bl=new Float32Array(this.size); this.br=new Float32Array(this.size); this.w=0; this.t=0; }',
    '  read(buf,rp){ rp=((rp%this.size)+this.size)%this.size; var i0=Math.floor(rp), i1=(i0+1)%this.size, fr=rp-i0; return buf[i0]*(1-fr)+buf[i1]*fr; }',
    '  process(inputs,outputs,p){ var I=inputs[0],O=outputs[0]; if(!I||!I[0])return true;',
    '    var il=I[0], ir=I[1]||I[0], ol=O[0], orr=O[1]||O[0], ratio=p.ratio[0], G=this.G, half=G/2;',
    '    for(var i=0;i<il.length;i++){ this.bl[this.w]=il[i]; this.br[this.w]=ir[i]; var aL=0,aR=0;',
    '      for(var s=0;s<2;s++){ var ph=(this.t+s*half)%G; var wnd=1-Math.abs(2*ph/G-1);',
    '        var rp=this.w-1-(G-ph)+ph*(1-ratio); aL+=this.read(this.bl,rp)*wnd; aR+=this.read(this.br,rp)*wnd; }',
    '      ol[i]=aL; orr[i]=aR; this.w=(this.w+1)%this.size; this.t++; if(this.t>=G)this.t-=G; } return true; } }',
    'registerProcessor("fx-pitch", Pitch);'
  ].join('\n');

  var fxDspPromise = null;
  window.FXDSP = {
    ready: false,
    load: function (ctx) {
      if (!fxDspPromise) {
        var url = URL.createObjectURL(new Blob([FX_DSP_SRC], { type: 'application/javascript' }));
        fxDspPromise = ctx.audioWorklet.addModule(url).then(function () { window.FXDSP.ready = true; })
          .catch(function (e) { /* effects fall back if this fails */ });
      }
      return fxDspPromise;
    }
  };
  function dspNode(ctx, name, opts) {
    try { return new AudioWorkletNode(ctx, name, opts || {}); } catch (e) { return null; }
  }

  function beatsToSec(div, bpm) { return RATE_BEATS[div] * 60 / bpm; }
  /* ---------------- effect definitions ---------------- */
  window.FX_DEFS = {
    filter: {
      name: 'Filter',
      params: [
        { id: 'type', label: 'Type', type: 'select', def: 'lp', options: [['lp', 'Low-pass'], ['hp', 'High-pass'], ['bp', 'Band-pass']] },
        { id: 'freq', label: 'Cutoff', min: 40, max: 18000, def: 2400, log: true, unit: 'Hz' },
        { id: 'q', label: 'Reso', min: 0.1, max: 14, def: 0.8, unit: '' }
      ],
      build: function (ctx) {
        var f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        return {
          input: f, output: f,
          set: function (id, v) {
            if (id === 'type') f.type = v === 'hp' ? 'highpass' : v === 'bp' ? 'bandpass' : 'lowpass';
            else if (id === 'freq') f.frequency.setTargetAtTime(v, ctx.currentTime, 0.01);
            else f.Q.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { f.disconnect(); }
        };
      }
    },

    delay: {
      name: 'Delay',
      params: [
        { id: 'sync', label: 'Sync', type: 'select', def: 'off', options: SYNC_OPTS },
        { id: 'time', label: 'Time', min: 30, max: 1500, def: 350, unit: 'ms' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.92, def: 0.35, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.3, unit: '' }
      ],
      build: function (ctx, engine) {
        var input = ctx.createGain(), output = ctx.createGain();
        var dly = ctx.createDelay(4.0), fb = ctx.createGain(), wet = ctx.createGain();
        input.connect(output);
        input.connect(dly);
        dly.connect(wet); wet.connect(output);
        dly.connect(fb); fb.connect(dly);
        var st = { sync: 'off', time: 350, applied: 0 };
        function applyTime(bpm) {
          var sec = st.sync === 'off' ? st.time / 1000 : Math.min(3.9, beatsToSec(st.sync, bpm));
          if (Math.abs(sec - st.applied) > 0.001) {
            st.applied = sec;
            dly.delayTime.setTargetAtTime(sec, ctx.currentTime, 0.05);
          }
        }
        applyTime(engine.transport ? engine.transport.bpm : 120);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'time') { st.time = v; applyTime(engine.transport.bpm); }
            else if (id === 'sync') { st.sync = v; applyTime(engine.transport.bpm); }
            else if (id === 'fb') fb.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          tick: function (t) { if (st.sync !== 'off') applyTime(t.bpm); },
          dispose: function () { input.disconnect(); dly.disconnect(); fb.disconnect(); wet.disconnect(); }
        };
      }
    },

    reverb: {
      name: 'Reverb',
      params: [
        { id: 'sync', label: 'Sync', type: 'select', def: 'off', options: [['off', 'free'], ['1/2', '1/2'], ['1/1', '1 bar'], ['2/1', '2 bars']] },
        { id: 'decay', label: 'Decay', min: 0.3, max: 8, def: 2.2, unit: 's', auto: false },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.35, unit: '' }
      ],
      build: function (ctx, engine) {
        var input = ctx.createGain(), output = ctx.createGain();
        var conv = ctx.createConvolver(), wet = ctx.createGain();
        conv.buffer = makeReverbIR(ctx, 2.2);
        input.connect(output);
        input.connect(conv); conv.connect(wet); wet.connect(output);
        var st = { sync: 'off', decay: 2.2, applied: 2.2, lastRegen: 0 };
        var regenTimer = null;
        function regen(sec) {
          sec = Math.max(0.3, Math.min(10, sec));
          if (Math.abs(sec - st.applied) / st.applied < 0.05) return;
          var now = Date.now();
          if (now - st.lastRegen < 400) return;
          st.applied = sec;
          st.lastRegen = now;
          conv.buffer = makeReverbIR(ctx, sec);
        }
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'mix') { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); return; }
            if (id === 'sync') { st.sync = v; if (v !== 'off') regen(beatsToSec(v, engine.transport.bpm)); return; }
            st.decay = v;
            clearTimeout(regenTimer);
            regenTimer = setTimeout(function () { if (st.sync === 'off') regen(st.decay); }, 250);
          },
          tick: function (t) { if (st.sync !== 'off') regen(beatsToSec(st.sync, t.bpm)); },
          dispose: function () { clearTimeout(regenTimer); input.disconnect(); conv.disconnect(); wet.disconnect(); }
        };
      }
    },

    dist: {
      name: 'Distortion',
      params: [
        { id: 'drive', label: 'Drive', min: 1, max: 120, def: 20, unit: '', auto: false },
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

    flanger: {
      name: 'Flanger',
      params: [
        { id: 'rate', label: 'Rate', min: 0.05, max: 2, def: 0.25, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 3, def: 1.5, unit: 'ms' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.85, def: 0.4, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var dly = ctx.createDelay(0.05), wet = ctx.createGain(), fb = ctx.createGain();
        var osc = ctx.createOscillator(), lfoGain = ctx.createGain();
        dly.delayTime.value = 0.004;
        osc.frequency.value = 0.25;
        lfoGain.gain.value = 0.0015;
        osc.connect(lfoGain); lfoGain.connect(dly.delayTime);
        osc.start();
        input.connect(output);
        input.connect(dly); dly.connect(wet); wet.connect(output);
        dly.connect(fb); fb.connect(dly);
        fb.gain.value = 0.4;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'rate') osc.frequency.setTargetAtTime(v, ctx.currentTime, 0.05);
            else if (id === 'depth') lfoGain.gain.setTargetAtTime(v / 2000, ctx.currentTime, 0.05);
            else if (id === 'fb') fb.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () {
            try { osc.stop(); } catch (e) {}
            input.disconnect(); dly.disconnect(); wet.disconnect(); fb.disconnect(); osc.disconnect(); lfoGain.disconnect();
          }
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
        input.connect(output);
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
    },

    phaser: {
      name: 'Phaser',
      params: [
        { id: 'rate', label: 'Rate', min: 0.05, max: 8, def: 0.5, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 1, def: 0.7, unit: '' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.9, def: 0.3, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), fb = ctx.createGain();
        var N = 6, stages = [];
        for (var i = 0; i < N; i++) { var ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = 400 + i * 350; stages.push(ap); }
        for (i = 0; i < N - 1; i++) stages[i].connect(stages[i + 1]);
        var lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 0.5; lg.gain.value = 700;
        stages.forEach(function (ap) { lg.connect(ap.frequency); });
        lfo.connect(lg); lfo.start();
        input.connect(output);
        input.connect(stages[0]); stages[N - 1].connect(wet); wet.connect(output);
        stages[N - 1].connect(fb); fb.connect(stages[0]); fb.gain.value = 0.3;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'rate') lfo.frequency.setTargetAtTime(v, ctx.currentTime, 0.05);
            else if (id === 'depth') lg.gain.setTargetAtTime(v * 1100, ctx.currentTime, 0.05);
            else if (id === 'fb') fb.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { try { lfo.stop(); } catch (e) {} input.disconnect(); wet.disconnect(); fb.disconnect(); lfo.disconnect(); lg.disconnect(); stages.forEach(function (s) { s.disconnect(); }); }
        };
      }
    },

    tremolo: {
      name: 'Tremolo',
      params: [
        { id: 'rate', label: 'Rate', min: 0.1, max: 20, def: 5, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 1, def: 0.7, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), amp = ctx.createGain();
        var lfo = ctx.createOscillator(), lg = ctx.createGain();
        input.connect(amp); amp.connect(output);
        lfo.frequency.value = 5; lfo.connect(lg); lg.connect(amp.gain); lfo.start();
        var depth = 0.7;
        function apply() { amp.gain.setTargetAtTime(1 - depth * 0.5, ctx.currentTime, 0.02); lg.gain.setTargetAtTime(depth * 0.5, ctx.currentTime, 0.02); }
        apply();
        return {
          input: input, output: output,
          set: function (id, v) { if (id === 'rate') lfo.frequency.setTargetAtTime(v, ctx.currentTime, 0.02); else { depth = v; apply(); } },
          dispose: function () { try { lfo.stop(); } catch (e) {} input.disconnect(); amp.disconnect(); lfo.disconnect(); lg.disconnect(); }
        };
      }
    },

    vibrato: {
      name: 'Vibrato',
      params: [
        { id: 'rate', label: 'Rate', min: 0.1, max: 12, def: 5, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 8, def: 3, unit: 'ms' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), dly = ctx.createDelay(0.05);
        var lfo = ctx.createOscillator(), lg = ctx.createGain();
        dly.delayTime.value = 0.006; lfo.frequency.value = 5; lg.gain.value = 0.0015;
        input.connect(dly); dly.connect(output);
        lfo.connect(lg); lg.connect(dly.delayTime); lfo.start();
        return {
          input: input, output: output,
          set: function (id, v) { if (id === 'rate') lfo.frequency.setTargetAtTime(v, ctx.currentTime, 0.02); else lg.gain.setTargetAtTime(v / 2000, ctx.currentTime, 0.02); },
          dispose: function () { try { lfo.stop(); } catch (e) {} input.disconnect(); dly.disconnect(); lfo.disconnect(); lg.disconnect(); }
        };
      }
    },

    ringmod: {
      name: 'Ring mod',
      params: [
        { id: 'freq', label: 'Freq', min: 20, max: 4000, def: 300, log: true, unit: 'Hz' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), ring = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
        var carrier = ctx.createOscillator();
        ring.gain.value = 0; carrier.frequency.value = 300; carrier.connect(ring.gain); carrier.start();
        input.connect(ring); ring.connect(wet); wet.connect(output);
        input.connect(dry); dry.connect(output); dry.gain.value = 0; wet.gain.value = 1;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'freq') carrier.frequency.setTargetAtTime(v, ctx.currentTime, 0.01);
            else { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01); }
          },
          dispose: function () { try { carrier.stop(); } catch (e) {} input.disconnect(); ring.disconnect(); wet.disconnect(); dry.disconnect(); carrier.disconnect(); }
        };
      }
    },

    wah: {
      name: 'Wah-wah',
      params: [
        { id: 'freq', label: 'Position', min: 200, max: 3000, def: 900, log: true, unit: 'Hz' },
        { id: 'q', label: 'Reso', min: 2, max: 18, def: 9, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.9, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), bpf = ctx.createBiquadFilter(), wet = ctx.createGain(), dry = ctx.createGain();
        bpf.type = 'bandpass'; bpf.frequency.value = 900; bpf.Q.value = 9;
        input.connect(bpf); bpf.connect(wet); wet.connect(output);
        input.connect(dry); dry.connect(output); dry.gain.value = 0.1; wet.gain.value = 0.9;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'freq') bpf.frequency.setTargetAtTime(v, ctx.currentTime, 0.02);
            else if (id === 'q') bpf.Q.setTargetAtTime(v, ctx.currentTime, 0.02);
            else { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01); }
          },
          dispose: function () { input.disconnect(); bpf.disconnect(); wet.disconnect(); dry.disconnect(); }
        };
      }
    },

    autowah: {
      name: 'Auto-wah',
      params: [
        { id: 'base', label: 'Base', min: 100, max: 1500, def: 350, log: true, unit: 'Hz' },
        { id: 'sens', label: 'Sens', min: 0, max: 6000, def: 3000, unit: '' },
        { id: 'q', label: 'Reso', min: 2, max: 18, def: 8, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.85, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), bpf = ctx.createBiquadFilter(), wet = ctx.createGain(), dry = ctx.createGain();
        bpf.type = 'bandpass'; bpf.frequency.value = 350; bpf.Q.value = 8;
        // envelope follower: |x| -> lowpass -> sens gain -> drives the cutoff
        var shaper = ctx.createWaveShaper(), curve = new Float32Array(1024);
        for (var i = 0; i < 1024; i++) { var x = i / 1023 * 2 - 1; curve[i] = Math.abs(x); }
        shaper.curve = curve;
        var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 12;
        var sens = ctx.createGain(); sens.gain.value = 3000;
        input.connect(shaper); shaper.connect(lp); lp.connect(sens); sens.connect(bpf.frequency);
        input.connect(bpf); bpf.connect(wet); wet.connect(output);
        input.connect(dry); dry.connect(output); dry.gain.value = 0.15; wet.gain.value = 0.85;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'base') bpf.frequency.setTargetAtTime(v, ctx.currentTime, 0.02);
            else if (id === 'sens') sens.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
            else if (id === 'q') bpf.Q.setTargetAtTime(v, ctx.currentTime, 0.02);
            else { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01); }
          },
          dispose: function () { input.disconnect(); shaper.disconnect(); lp.disconnect(); sens.disconnect(); bpf.disconnect(); wet.disconnect(); dry.disconnect(); }
        };
      }
    },

    rotary: {
      name: 'Rotary speaker',
      params: [
        { id: 'rate', label: 'Speed', min: 0.5, max: 9, def: 6, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 1, def: 0.6, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), dly = ctx.createDelay(0.02), amp = ctx.createGain(), pan = ctx.createStereoPanner();
        var lfo = ctx.createOscillator(), pd = ctx.createGain(), ad = ctx.createGain(), pnd = ctx.createGain();
        dly.delayTime.value = 0.006; lfo.frequency.value = 6;
        pd.gain.value = 0.0018; ad.gain.value = 0.25; pnd.gain.value = 0.6;
        lfo.connect(pd); pd.connect(dly.delayTime);
        lfo.connect(ad); ad.connect(amp.gain); amp.gain.value = 0.85;
        lfo.connect(pnd); pnd.connect(pan.pan); lfo.start();
        input.connect(dly); dly.connect(amp); amp.connect(pan); pan.connect(output);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'rate') lfo.frequency.setTargetAtTime(v, ctx.currentTime, 0.1);
            else if (id === 'depth') { ad.gain.setTargetAtTime(v * 0.35, ctx.currentTime, 0.05); pnd.gain.setTargetAtTime(v, ctx.currentTime, 0.05); pd.gain.setTargetAtTime(v * 0.003, ctx.currentTime, 0.05); }
            else output.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { try { lfo.stop(); } catch (e) {} input.disconnect(); dly.disconnect(); amp.disconnect(); pan.disconnect(); lfo.disconnect(); pd.disconnect(); ad.disconnect(); pnd.disconnect(); }
        };
      }
    },

    fshift: {
      name: 'Frequency shifter',
      params: [
        { id: 'shift', label: 'Shift', min: -1000, max: 1000, def: 100, unit: 'Hz' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
        input.connect(dry); dry.connect(output); dry.gain.value = 0; wet.gain.value = 1;
        var node = dspNode(ctx, 'fx-fshift', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        if (node) { input.connect(node); node.connect(wet); wet.connect(output); }
        else {
          // fallback: ring modulation (no worklet)
          var ring = ctx.createGain(), carrier = ctx.createOscillator();
          ring.gain.value = 0; carrier.frequency.value = 100; carrier.connect(ring.gain); carrier.start();
          input.connect(ring); ring.connect(wet); wet.connect(output); node = { _osc: carrier };
        }
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'shift') { if (node.parameters) node.parameters.get('shift').setValueAtTime(v, ctx.currentTime); else if (node._osc) node._osc.frequency.setTargetAtTime(Math.abs(v), ctx.currentTime, 0.01); }
            else { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01); }
          },
          dispose: function () { try { if (node._osc) node._osc.stop(); } catch (e) {} input.disconnect(); wet.disconnect(); dry.disconnect(); try { node.disconnect(); } catch (e) {} }
        };
      }
    },

    pitch: {
      name: 'Pitch shifter',
      params: [
        { id: 'semi', label: 'Pitch', min: -12, max: 12, def: 7, unit: 'st' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
        input.connect(dry); dry.connect(output); dry.gain.value = 0; wet.gain.value = 1;
        var node = dspNode(ctx, 'fx-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        if (node) { input.connect(node); node.connect(wet); wet.connect(output); }
        else { input.connect(wet); wet.connect(output); }   // fallback: dry-through
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'semi') { if (node && node.parameters) node.parameters.get('ratio').setValueAtTime(Math.pow(2, v / 12), ctx.currentTime); }
            else { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01); }
          },
          dispose: function () { input.disconnect(); wet.disconnect(); dry.disconnect(); try { node.disconnect(); } catch (e) {} }
        };
      }
    },

    multitap: {
      name: 'Multitap',
      params: [
        { id: 'sync', label: 'Sync', type: 'select', def: '1/8', options: SYNC_OPTS },
        { id: 'time', label: 'Time', min: 40, max: 800, def: 200, unit: 'ms' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.85, def: 0.3, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.4, unit: '' }
      ],
      build: function (ctx, engine) {
        var input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), fb = ctx.createGain();
        var taps = [], gains = [], NT = 3;
        for (var i = 0; i < NT; i++) {
          var d = ctx.createDelay(4.0), g = ctx.createGain();
          g.gain.value = Math.pow(0.6, i);
          input.connect(d); d.connect(g); g.connect(wet); taps.push(d); gains.push(g);
        }
        wet.connect(output); input.connect(output);
        taps[NT - 1].connect(fb); fb.connect(input); fb.gain.value = 0.3;
        var st = { sync: '1/8', time: 200, applied: 0 };
        function apply(bpm) {
          var base = st.sync === 'off' ? st.time / 1000 : Math.min(1.3, beatsToSec(st.sync, bpm));
          if (Math.abs(base - st.applied) < 0.001) return;
          st.applied = base;
          taps.forEach(function (d, k) { d.delayTime.setTargetAtTime(base * (k + 1), ctx.currentTime, 0.05); });
        }
        apply(engine.transport ? engine.transport.bpm : 120);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'time') { st.time = v; apply(engine.transport.bpm); }
            else if (id === 'sync') { st.sync = v; apply(engine.transport.bpm); }
            else if (id === 'fb') fb.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          tick: function (t) { if (st.sync !== 'off') apply(t.bpm); },
          dispose: function () { input.disconnect(); wet.disconnect(); fb.disconnect(); taps.forEach(function (d) { d.disconnect(); }); gains.forEach(function (g) { g.disconnect(); }); }
        };
      }
    },

    pingpong: {
      name: 'Ping-pong',
      params: [
        { id: 'sync', label: 'Sync', type: 'select', def: '1/8', options: SYNC_OPTS },
        { id: 'time', label: 'Time', min: 40, max: 800, def: 250, unit: 'ms' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.9, def: 0.45, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.35, unit: '' }
      ],
      build: function (ctx, engine) {
        var input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain();
        var dl = ctx.createDelay(4.0), dr = ctx.createDelay(4.0), fbL = ctx.createGain(), fbR = ctx.createGain();
        var merger = ctx.createChannelMerger(2);
        input.connect(dl);
        dl.connect(fbR); fbR.connect(dr);   // left tail bounces to right
        dr.connect(fbL); fbL.connect(dl);   // right tail bounces to left
        dl.connect(merger, 0, 0); dr.connect(merger, 0, 1);
        merger.connect(wet); wet.connect(output); input.connect(output);
        fbL.gain.value = 0.45; fbR.gain.value = 0.45;
        var st = { sync: '1/8', time: 250, applied: 0 };
        function apply(bpm) {
          var sec = st.sync === 'off' ? st.time / 1000 : Math.min(1.3, beatsToSec(st.sync, bpm));
          if (Math.abs(sec - st.applied) < 0.001) return;
          st.applied = sec;
          dl.delayTime.setTargetAtTime(sec, ctx.currentTime, 0.05);
          dr.delayTime.setTargetAtTime(sec, ctx.currentTime, 0.05);
        }
        apply(engine.transport ? engine.transport.bpm : 120);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'time') { st.time = v; apply(engine.transport.bpm); }
            else if (id === 'sync') { st.sync = v; apply(engine.transport.bpm); }
            else if (id === 'fb') { fbL.gain.setTargetAtTime(v, ctx.currentTime, 0.01); fbR.gain.setTargetAtTime(v, ctx.currentTime, 0.01); }
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          tick: function (t) { if (st.sync !== 'off') apply(t.bpm); },
          dispose: function () { input.disconnect(); wet.disconnect(); dl.disconnect(); dr.disconnect(); fbL.disconnect(); fbR.disconnect(); merger.disconnect(); }
        };
      }
    },

    exciter: {
      name: 'Exciter',
      params: [
        { id: 'freq', label: 'Focus', min: 800, max: 8000, def: 3000, log: true, unit: 'Hz' },
        { id: 'drive', label: 'Drive', min: 1, max: 60, def: 20, unit: '', auto: false },
        { id: 'amount', label: 'Amount', min: 0, max: 1, def: 0.4, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), hp = ctx.createBiquadFilter(), shaper = ctx.createWaveShaper(), wet = ctx.createGain();
        hp.type = 'highpass'; hp.frequency.value = 3000; shaper.curve = distortionCurve(20); shaper.oversample = '2x';
        input.connect(output);
        input.connect(hp); hp.connect(shaper); shaper.connect(wet); wet.connect(output); wet.gain.value = 0.4;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'freq') hp.frequency.setTargetAtTime(v, ctx.currentTime, 0.02);
            else if (id === 'drive') shaper.curve = distortionCurve(v);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { input.disconnect(); hp.disconnect(); shaper.disconnect(); wet.disconnect(); }
        };
      }
    },

    bitcrush: {
      name: 'Bitcrusher',
      params: [
        { id: 'bits', label: 'Bits', min: 1, max: 16, def: 8, unit: '' },
        { id: 'rate', label: 'Rate', min: 0.02, max: 1, def: 0.35, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
        input.connect(dry); dry.connect(output); dry.gain.value = 0; wet.gain.value = 1;
        var node = dspNode(ctx, 'fx-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        if (node) { input.connect(node); node.connect(wet); wet.connect(output); }
        else {
          // fallback: bit-depth crush only, via waveshaper
          var sh = ctx.createWaveShaper(), curve = new Float32Array(1024);
          for (var i = 0; i < 1024; i++) { var x = i / 1023 * 2 - 1; curve[i] = Math.round(x * 8) / 8; }
          sh.curve = curve; input.connect(sh); sh.connect(wet); wet.connect(output); node = { _sh: sh };
        }
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'bits') { if (node.parameters) node.parameters.get('bits').setValueAtTime(v, ctx.currentTime); }
            else if (id === 'rate') { if (node.parameters) node.parameters.get('reduce').setValueAtTime(v, ctx.currentTime); }
            else { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01); }
          },
          dispose: function () { input.disconnect(); wet.disconnect(); dry.disconnect(); try { node.disconnect(); } catch (e) {} }
        };
      }
    },

    widener: {
      name: 'Stereo widener',
      params: [{ id: 'width', label: 'Width', min: 0, max: 2, def: 1.4, unit: '' }],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
        // mid/side: M=(L+R)/2, S=(L-R)/2 ; widen S ; L=M+S, R=M-S
        var mid = ctx.createGain(), sideP = ctx.createGain(), sideN = ctx.createGain(), sideW = ctx.createGain();
        var invR = ctx.createGain(); invR.gain.value = -1;
        input.connect(split);
        split.connect(mid, 0); split.connect(mid, 1); mid.gain.value = 0.5;
        split.connect(sideP, 0); split.connect(invR, 1); invR.connect(sideP); sideP.gain.value = 0.5;  // S = (L-R)/2
        sideP.connect(sideW); sideW.gain.value = 1.4;
        // L = M + S
        mid.connect(merge, 0, 0); sideW.connect(merge, 0, 0);
        // R = M - S
        var sideWneg = ctx.createGain(); sideWneg.gain.value = -1; sideW.connect(sideWneg);
        mid.connect(merge, 0, 1); sideWneg.connect(merge, 0, 1);
        merge.connect(output);
        return {
          input: input, output: output,
          set: function (id, v) { sideW.gain.setTargetAtTime(v, ctx.currentTime, 0.02); },
          dispose: function () { input.disconnect(); split.disconnect(); mid.disconnect(); sideP.disconnect(); sideN.disconnect(); sideW.disconnect(); sideWneg.disconnect(); invR.disconnect(); merge.disconnect(); }
        };
      }
    },

    haas: {
      name: 'Haas',
      params: [
        { id: 'delay', label: 'Delay', min: 1, max: 35, def: 15, unit: 'ms' },
        { id: 'side', label: 'Side', type: 'select', def: 'R', options: [['L', 'left'], ['R', 'right']] }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
        var dly = ctx.createDelay(0.05); dly.delayTime.value = 0.015;
        var side = 'R';
        input.connect(split);
        // route: delayed channel vs dry channel to L/R
        function wire() {
          try { split.disconnect(); dly.disconnect(); } catch (e) {}
          split.connect(dly, side === 'R' ? 1 : 0);
          if (side === 'R') { split.connect(merge, 0, 0); dly.connect(merge, 0, 1); }
          else { dly.connect(merge, 0, 0); split.connect(merge, 1, 1); }
        }
        wire(); merge.connect(output);
        return {
          input: input, output: output,
          set: function (id, v) { if (id === 'delay') dly.delayTime.setTargetAtTime(v / 1000, ctx.currentTime, 0.02); else { side = v; wire(); } },
          dispose: function () { input.disconnect(); split.disconnect(); dly.disconnect(); merge.disconnect(); }
        };
      }
    },

    panner: {
      name: 'Panner',
      params: [{ id: 'pan', label: 'Pan', min: -1, max: 1, def: 0, unit: '' }],
      build: function (ctx) {
        var p = ctx.createStereoPanner();
        return { input: p, output: p, set: function (id, v) { p.pan.setTargetAtTime(v, ctx.currentTime, 0.02); }, dispose: function () { p.disconnect(); } };
      }
    },

    autopan: {
      name: 'Auto-panner',
      params: [
        { id: 'rate', label: 'Rate', min: 0.05, max: 10, def: 1, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 1, def: 0.8, unit: '' }
      ],
      build: function (ctx) {
        var p = ctx.createStereoPanner(), lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 1; lg.gain.value = 0.8; lfo.connect(lg); lg.connect(p.pan); lfo.start();
        return {
          input: p, output: p,
          set: function (id, v) { if (id === 'rate') lfo.frequency.setTargetAtTime(v, ctx.currentTime, 0.02); else lg.gain.setTargetAtTime(v, ctx.currentTime, 0.02); },
          dispose: function () { try { lfo.stop(); } catch (e) {} p.disconnect(); lfo.disconnect(); lg.disconnect(); }
        };
      }
    },

    comp: {
      name: 'Compressor',
      params: [
        { id: 'thresh', label: 'Thresh', min: -60, max: 0, def: -22, unit: 'dB', auto: false },
        { id: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, unit: '', auto: false },
        { id: 'attack', label: 'Attack', min: 0, max: 100, def: 6, unit: 'ms', auto: false },
        { id: 'release', label: 'Release', min: 10, max: 600, def: 180, unit: 'ms', auto: false },
        { id: 'makeup', label: 'Makeup', min: 0, max: 24, def: 0, unit: 'dB' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), comp = ctx.createDynamicsCompressor(), makeup = ctx.createGain();
        comp.knee.value = 12; comp.threshold.value = -22; comp.ratio.value = 4;
        comp.attack.value = 0.006; comp.release.value = 0.18;
        input.connect(comp); comp.connect(makeup);
        return {
          input: input, output: makeup,
          set: function (id, v) {
            if (id === 'thresh') comp.threshold.setTargetAtTime(v, ctx.currentTime, 0.01);
            else if (id === 'ratio') comp.ratio.setTargetAtTime(v, ctx.currentTime, 0.01);
            else if (id === 'attack') comp.attack.setTargetAtTime(v / 1000, ctx.currentTime, 0.01);
            else if (id === 'release') comp.release.setTargetAtTime(v / 1000, ctx.currentTime, 0.01);
            else makeup.gain.setTargetAtTime(Math.pow(10, v / 20), ctx.currentTime, 0.01);
          },
          dispose: function () { input.disconnect(); comp.disconnect(); makeup.disconnect(); }
        };
      }
    }
  };

  /* category grouping for the add-effect menu */
  window.FX_CATEGORY = {
    filter: 'Filter', comp: 'Dynamics',
    phaser: 'Modulation', flanger: 'Modulation', chorus: 'Modulation', wah: 'Modulation',
    autowah: 'Modulation', tremolo: 'Modulation', vibrato: 'Modulation', rotary: 'Modulation',
    ringmod: 'Modulation', fshift: 'Modulation', pitch: 'Modulation',
    delay: 'Delay', multitap: 'Delay', pingpong: 'Delay', reverb: 'Delay',
    dist: 'Distortion', exciter: 'Distortion', bitcrush: 'Distortion',
    widener: 'Spatial', haas: 'Spatial', panner: 'Spatial', autopan: 'Spatial'
  };

  /* ---------------- FxRack ---------------- */
  function fmtVal(p, v) {
    return (v >= 100 ? Math.round(v) : Math.round(v * 100) / 100) + (p.unit || '');
  }
  var racks = [];
  var ticker = null;
  var TICK_MS = 25;

  function tickAll() {
    var t = racks.length ? racks[0].engine.transport : null;
    if (!t) return;
    for (var r = 0; r < racks.length; r++) {
      var rack = racks[r];
      for (var f = 0; f < rack.fx.length; f++) {
        var entry = rack.fx[f];
        if (entry.inst.tick) entry.inst.tick(t);
      }
    }
  }

  function FxRack(engine) {
    this.engine = engine;
    this.input = engine.ctx.createGain();
    this.output = engine.ctx.createGain();
    this.input.connect(this.output);
    this.fx = [];        // { key, def, inst, values, card, outEls }
    this.listEl = null;
    racks.push(this);
    if (!ticker) ticker = setInterval(tickAll, TICK_MS);
  }

  FxRack.prototype.addFx = function (key) {
    var def = window.FX_DEFS[key];
    if (!def) return null;
    var inst = def.build(this.engine.ctx, this.engine);
    var values = {};
    def.params.forEach(function (p) {
      values[p.id] = p.def;
      inst.set(p.id, p.def);
    });
    var entry = {
      key: key, def: def, inst: inst,
      values: values, card: null, outEls: {}
    };
    this.fx.push(entry);
    this.rebuild();
    if (this.listEl) this.buildCard(entry);
    return entry;
  };

  FxRack.prototype.removeFx = function (entry) {
    var i = this.fx.indexOf(entry);
    if (i < 0) return;
    this.fx.splice(i, 1);
    this.rebuild();
    entry.inst.dispose();
    if (entry.card) entry.card.remove();
  };

  FxRack.prototype.rebuild = function () {
    this.input.disconnect();
    this.fx.forEach(function (e) { e.inst.output.disconnect(); });
    var prev = this.input;
    for (var i = 0; i < this.fx.length; i++) {
      prev.connect(this.fx[i].inst.input);
      prev = this.fx[i].inst.output;
    }
    prev.connect(this.output);
  };

  FxRack.prototype.dispose = function () {
    this.fx.forEach(function (e) {
      e.inst.dispose();
    });
    this.fx = [];
    this.input.disconnect();
    this.output.disconnect();
    var i = racks.indexOf(this);
    if (i >= 0) racks.splice(i, 1);
  };

  /* ---------------- rack UI ---------------- */
  FxRack.prototype.mountUI = function (root) {
    var self = this;
    var add = document.createElement('div');
    add.className = 'fx-add';
    var sel = document.createElement('select');
    var cats = window.FX_CATEGORY || {}, order = ['Filter', 'Dynamics', 'Modulation', 'Delay', 'Distortion', 'Spatial'];
    var groups = {};
    Object.keys(window.FX_DEFS).forEach(function (key) {
      var cat = cats[key] || 'Other';
      (groups[cat] = groups[cat] || []).push(key);
    });
    order.concat(Object.keys(groups).filter(function (c) { return order.indexOf(c) < 0; })).forEach(function (cat) {
      if (!groups[cat]) return;
      var og = document.createElement('optgroup'); og.label = cat;
      groups[cat].forEach(function (key) {
        var opt = document.createElement('option');
        opt.value = key; opt.textContent = window.FX_DEFS[key].name;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    var btn = document.createElement('button');
    btn.textContent = '+';
    btn.title = 'Add effect';
    btn.addEventListener('click', function () { self.addFx(sel.value); });
    add.appendChild(sel); add.appendChild(btn);
    root.appendChild(add);
    this.listEl = document.createElement('div');
    this.listEl.className = 'fx-list';
    root.appendChild(this.listEl);
    this.fx.forEach(function (e) { self.buildCard(e); });
  };

  FxRack.prototype.buildCard = function (entry) {
    var self = this;
    var card = document.createElement('div');
    card.className = 'fx-card';
    var head = document.createElement('div');
    head.className = 'fx-head';
    head.innerHTML = '<span class="fx-name">' + entry.def.name + '</span>';
    var rm = document.createElement('button');
    rm.className = 'fx-remove';
    rm.textContent = '✕';
    rm.addEventListener('click', function () { self.removeFx(entry); });
    head.appendChild(rm);
    card.appendChild(head);

    entry.def.params.forEach(function (p) {
      if (p.type === 'select') {
        var srow = document.createElement('div');
        srow.className = 'fx-param';
        var slbl = document.createElement('span');
        slbl.textContent = p.label;
        var ssel = document.createElement('select');
        ssel.className = 'fx-sel';
        p.options.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o[0]; opt.textContent = o[1];
          ssel.appendChild(opt);
        });
        ssel.value = p.def;
        ssel.addEventListener('change', function () {
          entry.values[p.id] = this.value;
          entry.inst.set(p.id, this.value);
        });
        srow.appendChild(slbl); srow.appendChild(ssel);
        srow.appendChild(document.createElement('span'));
        srow.appendChild(document.createElement('span'));
        card.appendChild(srow);
        return;
      }

      var row = document.createElement('div');
      row.className = 'fx-param';
      var lbl = document.createElement('span');
      lbl.textContent = p.label;
      var input = document.createElement('input');
      input.type = 'range';
      if (p.log) {
        input.min = Math.log(p.min); input.max = Math.log(p.max);
        input.step = (Math.log(p.max) - Math.log(p.min)) / 200;
        input.value = Math.log(p.def);
      } else {
        input.min = p.min; input.max = p.max;
        input.step = (p.max - p.min) / 200;
        input.value = p.def;
      }
      var val = document.createElement('span');
      val.className = 'val';
      val.textContent = fmtVal(p, p.def);
      entry.outEls[p.id] = val;
      input.addEventListener('input', function () {
        var v = parseFloat(this.value);
        if (p.log) v = Math.exp(v);
        entry.values[p.id] = v;
        entry.inst.set(p.id, v);
        val.textContent = fmtVal(p, v);
      });
      row.appendChild(lbl); row.appendChild(input); row.appendChild(val);
      row.appendChild(document.createElement('span'));
      card.appendChild(row);

    });

    entry.card = card;
    this.listEl.appendChild(card);
  };

  window.FxRack = FxRack;
})();
