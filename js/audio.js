/*!
 * js/audio.js — HorrorAudio
 * Pure WebAudio synthesis for the horror-marketing SPA.
 * Plain browser script: no ES modules, no libraries, no audio files, no network.
 *
 * Public API (window.HorrorAudio):
 *   await HorrorAudio.enable();                // create/resume ctx, idempotent
 *   HorrorAudio.disable();                     // fade to silence (then suspend)
 *   HorrorAudio.enabled;                       // boolean
 *   HorrorAudio.setIntensity(0..1);            // drone gain/filter, sub, texture
 *   HorrorAudio.setMood('calm'|'unease'|'dread'|'panic'|'void');
 *   HorrorAudio.heartbeat(bpm | null);         // lookahead lub-dub scheduler
 *   HorrorAudio.sting();                       // noise burst + sub drop + metal tail
 *   HorrorAudio.static(0..1);                  // continuous TV/radio static
 *   HorrorAudio.whisper();                     // breathy noise swell
 *   HorrorAudio.tick();                        // tiny UI tick
 *   HorrorAudio.chime();                       // pleasant 2-note marketing chime
 *   HorrorAudio.reset();                       // full teardown, back to defaults
 *
 * Every method is safe before enable(): state calls are remembered and applied
 * on enable, one-shots are ignored. Only enable() needs a user gesture.
 * `_debug()` is an internal diagnostics hook used by the dev test page.
 */
(function (global) {
  'use strict';

  var AC = global.AudioContext || global.webkitAudioContext;
  var SUPPORTED = typeof AC === 'function';

  /* ------------------------------------------------------------------ *
   *  Tuning
   * ------------------------------------------------------------------ */
  var MASTER_LEVEL = 0.62;      // comfortable overall level
  var ROOT_HZ = 43.65;          // F1 — dark, low root of the drone bed
  var BEAT_INTERVAL_MS = 25;    // heartbeat scheduler tick
  var BEAT_LOOKAHEAD = 0.12;    // seconds scheduled ahead

  // semis     : drone interval stack (semitones above ROOT_HZ), minor-ish
  // filter    : drone lowpass target at intensity 0 (scaled up by intensity)
  // bed       : drone level multiplier (keeps calm quieter than dread)
  // subHz     : sub-rumble frequency
  // sub       : sub-rumble multiplier (sub only exists with intensity > 0)
  // texture   : room-tone noise multiplier
  // detune    : cents of detuning between the oscillator pair -> slow beating
  var MOODS = {
    calm:   { semis: [0, 7, 12],   filter: 300, bed: 0.72, subHz: 38, sub: 0.35, texture: 0.30, detune: 4 },
    unease: { semis: [0, 3, 7],    filter: 340, bed: 0.85, subHz: 36, sub: 0.60, texture: 0.55, detune: 7 },
    dread:  { semis: [0, 1, 6],    filter: 265, bed: 0.95, subHz: 34, sub: 0.85, texture: 0.78, detune: 10 },
    panic:  { semis: [0, 6, 8],    filter: 650, bed: 1.00, subHz: 41, sub: 0.70, texture: 1.00, detune: 15 },
    void:   { semis: [0, 12, 12],  filter: 120, bed: 0.60, subHz: 31, sub: 1.00, texture: 0.22, detune: 2 }
  };

  /* ------------------------------------------------------------------ *
   *  State
   * ------------------------------------------------------------------ */
  var S = { intensity: 0, mood: 'calm', bpm: null, staticLevel: 0 };

  var ctx = null;               // AudioContext
  var G = null;                 // graph node bag
  var initDone = false;
  var enabled = false;
  var epoch = 0;                // bumped on every transition; invalidates timers
  var hiddenPaused = false;

  var beatTimer = null;
  var creakTimer = null;
  var nextBeatTime = 0;
  var currentBpm = 60;
  var targetBpm = null;

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function num(v, fallback) { v = Number(v); return isFinite(v) ? v : fallback; }
  function noop() {}
  function nowT() { return ctx ? ctx.currentTime : 0; }
  function running() { return !!(ctx && enabled && !hiddenPaused && ctx.state === 'running'); }

  function makeNoiseBuffer(seconds) {
    var len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Stereo panner when available, otherwise a unity gain (never a crash).
  function makePan(v) {
    if (typeof ctx.createStereoPanner === 'function') {
      var p = ctx.createStereoPanner();
      p.pan.value = clamp(v, -1, 1);
      return p;
    }
    return ctx.createGain();
  }

  // Click-free envelope: tiny-but-positive floor, fast linear attack,
  // exponential decay back to the floor.
  function env(gn, t, peak, attack, decay) {
    var p = gn.gain;
    var a = Math.max(0.0015, attack);
    var d = Math.max(0.003, decay);
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(Math.max(0.0002, peak), t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  /* ------------------------------------------------------------------ *
   *  Graph construction
   *  sources -> bed/fx -> gentle comp -> limiter -> master -> destination
   * ------------------------------------------------------------------ */
  function initGraph() {
    if (initDone || !SUPPORTED) return;
    ctx = new AC({ latencyHint: 'interactive' });

    var n = {};

    // --- master chain -------------------------------------------------
    n.master = ctx.createGain();
    n.master.gain.value = 0;                 // starts silent: mute-safe
    n.master.connect(ctx.destination);

    n.limiter = ctx.createDynamicsCompressor();
    n.limiter.threshold.value = -6;
    n.limiter.knee.value = 0;
    n.limiter.ratio.value = 16;
    n.limiter.attack.value = 0.002;
    n.limiter.release.value = 0.12;
    n.limiter.connect(n.master);

    n.comp = ctx.createDynamicsCompressor(); // gentle glue / clip guard
    n.comp.threshold.value = -14;
    n.comp.knee.value = 20;
    n.comp.ratio.value = 4;
    n.comp.attack.value = 0.004;
    n.comp.release.value = 0.25;
    n.comp.connect(n.limiter);

    n.bedGain = ctx.createGain();
    n.bedGain.gain.value = 0.85;
    n.bedGain.connect(n.comp);

    n.fxGain = ctx.createGain();
    n.fxGain.gain.value = 1.0;
    n.fxGain.connect(n.comp);

    n.noise = makeNoiseBuffer(2.2);

    // --- drone bed: 3 voices x 2 detuned oscillators ------------------
    n.droneFilter = ctx.createBiquadFilter();
    n.droneFilter.type = 'lowpass';
    n.droneFilter.frequency.value = 260;
    n.droneFilter.Q.value = 0.7;

    n.droneGain = ctx.createGain();
    n.droneGain.gain.value = 0.4;
    n.droneFilter.connect(n.droneGain);
    n.droneGain.connect(n.bedGain);

    n.voices = [];
    for (var i = 0; i < 3; i++) {
      var a = ctx.createOscillator();
      var b = ctx.createOscillator();
      a.type = 'sine';
      b.type = 'triangle';
      var vg = ctx.createGain();
      vg.gain.value = 0.055;
      a.connect(vg);
      b.connect(vg);
      vg.connect(n.droneFilter);
      a.start(0);
      b.start(0);
      n.voices.push({ a: a, b: b, g: vg });
    }

    // --- sub rumble (fades in with intensity) -----------------------
    n.subOsc = ctx.createOscillator();
    n.subOsc.type = 'sine';
    n.subOsc.frequency.value = 38;
    n.subGain = ctx.createGain();
    n.subGain.gain.value = 0.0001;
    n.subTrem = ctx.createGain();
    n.subTrem.gain.value = 0.8;
    n.subOsc.connect(n.subGain);
    n.subGain.connect(n.subTrem);
    n.subTrem.connect(n.bedGain);
    n.subOsc.start(0);

    // slow breathing on the sub
    n.subLfo = ctx.createOscillator();
    n.subLfo.type = 'sine';
    n.subLfo.frequency.value = 0.071;
    n.subLfoGain = ctx.createGain();
    n.subLfoGain.gain.value = 0.18;
    n.subLfo.connect(n.subLfoGain);
    n.subLfoGain.connect(n.subTrem.gain);
    n.subLfo.start(0);

    // slow drift on the drone filter
    n.filterLfo = ctx.createOscillator();
    n.filterLfo.type = 'sine';
    n.filterLfo.frequency.value = 0.043;
    n.filterLfoGain = ctx.createGain();
    n.filterLfoGain.gain.value = 16;
    n.filterLfo.connect(n.filterLfoGain);
    n.filterLfoGain.connect(n.droneFilter.frequency);
    n.filterLfo.start(0);

    // --- faint room tone --------------------------------------------
    n.roomSrc = ctx.createBufferSource();
    n.roomSrc.buffer = n.noise;
    n.roomSrc.loop = true;
    n.roomBp = ctx.createBiquadFilter();
    n.roomBp.type = 'bandpass';
    n.roomBp.frequency.value = 420;
    n.roomBp.Q.value = 0.45;
    n.roomGain = ctx.createGain();
    n.roomGain.gain.value = 0.01;
    n.roomSrc.connect(n.roomBp);
    n.roomBp.connect(n.roomGain);
    n.roomGain.connect(n.bedGain);
    n.roomSrc.start(0);

    // --- continuous TV/radio static ---------------------------------
    n.staticSrc = ctx.createBufferSource();
    n.staticSrc.buffer = n.noise;
    n.staticSrc.loop = true;
    n.staticHp = ctx.createBiquadFilter();
    n.staticHp.type = 'highpass';
    n.staticHp.frequency.value = 700;
    n.staticBp = ctx.createBiquadFilter();
    n.staticBp.type = 'bandpass';
    n.staticBp.frequency.value = 2200;
    n.staticBp.Q.value = 0.55;
    n.staticGain = ctx.createGain();
    n.staticGain.gain.value = 0.0001;
    n.staticSrc.connect(n.staticHp);
    n.staticHp.connect(n.staticBp);
    n.staticBp.connect(n.staticGain);
    n.staticGain.connect(n.fxGain);
    n.staticSrc.start(0);

    G = n;
    initDone = true;
  }

  /* ------------------------------------------------------------------ *
   *  Bed parameters (intensity + mood, always ramped)
   * ------------------------------------------------------------------ */
  function applyBedParams() {
    if (!ctx || !G) return;
    var m = MOODS[S.mood] || MOODS.calm;
    var k = clamp01(S.intensity);
    var t = nowT();

    for (var i = 0; i < G.voices.length; i++) {
      var voice = G.voices[i];
      var semis = m.semis[i % m.semis.length];
      var f = ROOT_HZ * Math.pow(2, semis / 12);
      var dt = m.detune / 2;
      voice.a.frequency.setTargetAtTime(f, t, 1.4);
      voice.b.frequency.setTargetAtTime(f, t, 1.4);
      voice.a.detune.setTargetAtTime(-dt, t, 1.0);
      voice.b.detune.setTargetAtTime(dt, t, 1.0);
    }

    G.droneFilter.frequency.setTargetAtTime(m.filter * (0.55 + 1.05 * k), t, 0.9);
    G.droneGain.gain.setTargetAtTime((0.42 + 0.62 * k) * m.bed, t, 0.55);
    G.subOsc.frequency.setTargetAtTime(m.subHz, t, 1.6);
    G.subGain.gain.setTargetAtTime(0.0001 + 0.11 * k * m.sub, t, 0.7);
    G.roomGain.gain.setTargetAtTime(Math.max(0.0015, (0.006 + 0.03 * k) * m.texture), t, 0.8);

    if (G.staticGain) {
      G.staticGain.gain.setTargetAtTime(0.0001 + S.staticLevel * 0.16, t, 0.15);
      G.staticBp.frequency.setTargetAtTime(1800 + S.staticLevel * 1500, t, 0.2);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Heartbeat: lookahead scheduler (25 ms tick / 120 ms ahead)
   * ------------------------------------------------------------------ */
  function thump(t, peak, f0, f1, dur) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur * 0.55);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 170;
    lp.Q.value = 1.1;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + 0.009);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(lp);
    lp.connect(g);
    g.connect(G.fxGain);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  function scheduleBeat(t, period) {
    // Slightly softer at high rates so a panic heartbeat never gets fatiguing.
    var fast = clamp((currentBpm - 60) / 100, 0, 1);
    var scale = 1 - 0.28 * fast;
    var gap = Math.min(0.30, Math.max(0.10, period * 0.33));
    thump(t, 0.55 * scale, 78, 32, 0.24);          // lub
    thump(t + gap, 0.36 * scale, 64, 30, 0.20);    // dub
  }

  function beatTick() {
    if (!running() || targetBpm == null) {
      return;
    }
    var t = ctx.currentTime;
    if (nextBeatTime < t) nextBeatTime = t + 0.03;
    var guard = 0;
    while (nextBeatTime < t + BEAT_LOOKAHEAD && guard < 8) {
      currentBpm += (targetBpm - currentBpm) * 0.28;  // smooth bpm changes
      currentBpm = clamp(currentBpm, 28, 240);
      var period = 60 / currentBpm;
      scheduleBeat(nextBeatTime, period);
      nextBeatTime += period;
      guard++;
    }
  }

  // 25 ms lookahead timer that schedules 120 ms of beats ahead.
  function beatLoop() {
    beatTimer = null;
    if (!enabled || targetBpm == null) return;
    try {
      beatTick();
    } catch (e) { /* never let one bad beat kill the pulse */ }
    if (enabled && targetBpm != null) {
      beatTimer = global.setTimeout(beatLoop, BEAT_INTERVAL_MS);
    }
  }

  function startHeartbeat() {
    if (!ctx || !enabled || targetBpm == null) return;
    if (beatTimer) return;
    currentBpm = targetBpm;
    nextBeatTime = nowT() + 0.07;
    beatTimer = global.setTimeout(beatLoop, BEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (beatTimer) {
      global.clearTimeout(beatTimer);
      beatTimer = null;
    }
  }

  function setHeartbeat(bpm) {
    if (bpm === null || bpm === undefined || bpm === false) {
      targetBpm = null;
      S.bpm = null;
      stopHeartbeat();
      return;
    }
    var v = Number(bpm);
    if (!isFinite(v) || v <= 0) return;       // ignore garbage
    v = clamp(v, 30, 220);
    var hadBeat = targetBpm != null;
    targetBpm = v;
    S.bpm = v;
    if (!hadBeat) currentBpm = v;
    if (!ctx || !enabled) return;
    var period = 60 / v;
    if (!hadBeat || nextBeatTime > nowT() + period * 1.3 || nextBeatTime < nowT()) {
      nextBeatTime = nowT() + 0.06;
    }
    startHeartbeat();
  }

  /* ------------------------------------------------------------------ *
   *  Distant creaks (rate scales with intensity)
   * ------------------------------------------------------------------ */
  function creakDelay() {
    var k = clamp01(S.intensity);
    var lo = 9000 - 6400 * k;   // 9s -> 2.6s
    var hi = 20000 - 13500 * k; // 20s -> 6.5s
    return lo + Math.random() * Math.max(1, hi - lo);
  }

  function scheduleCreak() {
    if (creakTimer || !enabled) return;
    var my = epoch;
    creakTimer = global.setTimeout(function () {
      creakTimer = null;
      if (my !== epoch || !enabled || !running()) return;
      creak();
      scheduleCreak();
    }, creakDelay());
  }

  function startCreaks() {
    if (creakTimer) return;
    scheduleCreak();
  }

  function stopCreaks() {
    if (creakTimer) {
      global.clearTimeout(creakTimer);
      creakTimer = null;
    }
  }

  function creak() {
    if (!running()) return;
    var t = ctx.currentTime + 0.02;
    var f0 = 110 + Math.random() * 160;

    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * (0.65 + Math.random() * 0.5), t + 0.3);

    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 600 + Math.random() * 900;
    bp.Q.value = 10;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.024 + 0.03 * clamp01(S.intensity), t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);

    var pan = makePan(Math.random() * 1.6 - 0.8);
    o.connect(bp);
    bp.connect(g);
    g.connect(pan);
    pan.connect(G.fxGain);
    o.start(t);
    o.stop(t + 0.56);
  }

  /* ------------------------------------------------------------------ *
   *  One-shot FX
   * ------------------------------------------------------------------ */
  function sting() {
    if (!running()) return;
    var t = ctx.currentTime + 0.01;

    // (a) sharp noise burst, fast attack / short decay
    var burst = ctx.createBufferSource();
    burst.buffer = G.noise;
    burst.loop = true;
    burst.playbackRate.value = 1;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1500, t);
    bp.frequency.exponentialRampToValueAtTime(620, t + 0.22);
    bp.Q.value = 0.8;
    var bg = ctx.createGain();
    env(bg, t, 0.5, 0.003, 0.26);
    var burstPan = makePan(-0.15);
    burst.connect(bp);
    bp.connect(bg);
    bg.connect(burstPan);
    burstPan.connect(G.fxGain);
    burst.start(t);
    burst.stop(t + 0.34);

    // (b) descending sub boom (~110 Hz -> 30 Hz)
    var sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(110, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + 0.9);
    var sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(0.6, t + 0.012);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
    sub.connect(sg);
    sg.connect(G.fxGain);
    sub.start(t);
    sub.stop(t + 1.12);

    // (c) short metallic tail (band-passed noise, never 4 kHz+ sine tones)
    var tail = ctx.createBufferSource();
    tail.buffer = G.noise;
    tail.loop = true;
    var m1 = ctx.createBiquadFilter();
    m1.type = 'bandpass';
    m1.frequency.value = 2350;
    m1.Q.value = 16;
    var m2 = ctx.createBiquadFilter();
    m2.type = 'bandpass';
    m2.frequency.value = 3180;
    m2.Q.value = 22;
    var tailGain = ctx.createGain();
    env(tailGain, t + 0.03, 0.13, 0.02, 0.55);
    var tailPan = makePan(0.35);
    tail.connect(m1);
    tail.connect(m2);
    m1.connect(tailGain);
    m2.connect(tailGain);
    tailGain.connect(tailPan);
    tailPan.connect(G.fxGain);
    tail.start(t);
    tail.stop(t + 0.66);
  }

  function whisper() {
    if (!running()) return;
    var t = ctx.currentTime + 0.02;
    var dur = 1.15;

    var src = ctx.createBufferSource();
    src.buffer = G.noise;
    src.loop = true;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;

    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.0;
    bp.frequency.setValueAtTime(520 + Math.random() * 220, t);
    bp.frequency.linearRampToValueAtTime(1500 + Math.random() * 500, t + 0.45);
    bp.frequency.linearRampToValueAtTime(600, t + dur);

    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 260;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.5);           // swell
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);    // die away

    // breath flutter
    var flutter = ctx.createGain();
    flutter.gain.value = 0.82;
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.5;
    var lfoG = ctx.createGain();
    lfoG.gain.value = 0.18;
    lfo.connect(lfoG);
    lfoG.connect(flutter.gain);

    var pan = makePan(Math.random() * 1.4 - 0.7);

    src.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(flutter);
    flutter.connect(pan);
    pan.connect(G.fxGain);

    src.start(t);
    src.stop(t + dur + 0.05);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }

  function tick() {
    if (!running()) return;
    var t = ctx.currentTime + 0.005;

    var s = ctx.createBufferSource();
    s.buffer = G.noise;
    s.loop = true;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    var g = ctx.createGain();
    env(g, t, 0.075, 0.0015, 0.022);
    s.connect(hp);
    hp.connect(g);
    g.connect(G.fxGain);
    s.start(t);
    s.stop(t + 0.05);

    // tiny pitched body
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1760;
    var og = ctx.createGain();
    env(og, t, 0.028, 0.0015, 0.035);
    o.connect(og);
    og.connect(G.fxGain);
    o.start(t);
    o.stop(t + 0.06);
  }

  function note(t, freq, peak, dur, type) {
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(G.fxGain);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function chime() {
    if (!running()) return;
    var t = ctx.currentTime + 0.01;
    // C5 -> E5: warm, consonant, reassuring.
    note(t, 523.25, 0.13, 0.75, 'sine');
    note(t, 1046.5, 0.028, 0.45, 'sine');
    note(t, 523.25, 0.035, 0.6, 'triangle');
    note(t + 0.14, 659.25, 0.11, 0.85, 'sine');
    note(t + 0.14, 1318.5, 0.024, 0.5, 'sine');
  }

  /* ------------------------------------------------------------------ *
   *  Public state setters (no-op safe before enable)
   * ------------------------------------------------------------------ */
  function setIntensity(x) {
    S.intensity = clamp01(num(x, 0));
    if (!ctx || !enabled) return;
    applyBedParams();
  }

  function setMood(mood) {
    if (typeof mood === 'string' && MOODS[mood]) S.mood = mood;
    if (!ctx || !enabled) return;
    applyBedParams();
  }

  function setStatic(level) {
    S.staticLevel = clamp01(num(level, 0));
    if (!ctx || !enabled) return;
    var t = nowT();
    G.staticGain.gain.setTargetAtTime(0.0001 + S.staticLevel * 0.16, t, 0.12);
    G.staticBp.frequency.setTargetAtTime(1800 + S.staticLevel * 1500, t, 0.2);
  }

  /* ------------------------------------------------------------------ *
   *  Lifecycle
   * ------------------------------------------------------------------ */
  function enable() {
    return new Promise(function (resolve) {
      if (!SUPPORTED) { resolve(false); return; }
      try {
        if (!initDone) initGraph();
        if (!ctx) { resolve(false); return; }

        var wasEnabled = enabled;
        var p = ctx.state === 'running' ? Promise.resolve() : ctx.resume();

        Promise.resolve(p).then(function () {
          enabled = true;
          hiddenPaused = false;
          epoch++;

          var t = nowT();
          applyBedParams();

          var mg = G.master.gain;
          mg.cancelScheduledValues(t);
          mg.setValueAtTime(Math.max(0.0001, mg.value), t);
          mg.linearRampToValueAtTime(MASTER_LEVEL, t + (wasEnabled ? 0.25 : 0.9));

          G.staticGain.gain.setTargetAtTime(0.0001 + S.staticLevel * 0.16, t, 0.3);

          startHeartbeat();
          startCreaks();
          resolve(true);
        }).catch(function () {
          resolve(false);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function disable() {
    if (!enabled) {
      stopHeartbeat();
      stopCreaks();
      return;
    }
    enabled = false;
    var my = ++epoch;
    stopHeartbeat();
    stopCreaks();

    if (!ctx) return;
    var t = nowT();
    var mg = G.master.gain;
    mg.cancelScheduledValues(t);
    mg.setValueAtTime(Math.max(0.0001, mg.value), t);
    mg.linearRampToValueAtTime(0.0001, t + 0.6);

    global.setTimeout(function () {
      if (my !== epoch || enabled) return;
      if (ctx && ctx.state === 'running') {
        var r = ctx.suspend();
        if (r && r.catch) r.catch(noop);
      }
    }, 700);
  }

  function onVisibility() {
    if (!ctx) return;

    if (global.document && global.document.hidden) {
      if (!enabled) return;
      hiddenPaused = true;
      var my = ++epoch;
      stopHeartbeat();
      stopCreaks();
      try {
        var t = nowT();
        var mg = G.master.gain;
        mg.cancelScheduledValues(t);
        mg.setValueAtTime(Math.max(0.0001, mg.value), t);
        mg.linearRampToValueAtTime(0.0001, t + 0.12);
      } catch (e) { /* ignore */ }
      global.setTimeout(function () {
        if (my !== epoch || !enabled || !hiddenPaused) return;
        if (ctx && ctx.state === 'running') {
          var r = ctx.suspend();
          if (r && r.catch) r.catch(noop);
        }
      }, 220);
      return;
    }

    // visible again
    if (!hiddenPaused) return;
    hiddenPaused = false;
    if (!enabled || !ctx) return;

    var resumeP = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    Promise.resolve(resumeP).then(function () {
      if (!enabled || !ctx) return;
      epoch++;
      var t = nowT();
      var mg = G.master.gain;
      mg.cancelScheduledValues(t);
      mg.setValueAtTime(0.0001, t);
      mg.linearRampToValueAtTime(MASTER_LEVEL, t + 0.4);
      startHeartbeat();
      startCreaks();
    }).catch(noop);
  }

  function reset() {
    enabled = false;
    hiddenPaused = false;
    epoch++;
    stopHeartbeat();
    stopCreaks();

    S.intensity = 0;
    S.mood = 'calm';
    S.bpm = null;
    S.staticLevel = 0;
    targetBpm = null;
    currentBpm = 60;
    nextBeatTime = 0;

    var oldCtx = ctx;
    var oldG = G;
    ctx = null;
    G = null;
    initDone = false;

    if (!oldCtx) return;
    try {
      var t = oldCtx.currentTime;
      var mg = oldG.master.gain;
      mg.cancelScheduledValues(t);
      mg.setValueAtTime(Math.max(0.0001, mg.value), t);
      mg.linearRampToValueAtTime(0.0001, t + 0.25);
    } catch (e) { /* ignore */ }

    global.setTimeout(function () {
      try {
        if (oldCtx && oldCtx.state !== 'closed') {
          var r = oldCtx.close();
          if (r && r.catch) r.catch(noop);
        }
      } catch (e) { /* ignore */ }
    }, 400);
  }

  /* ------------------------------------------------------------------ *
   *  Public API
   * ------------------------------------------------------------------ */
  var api = {
    enable: enable,
    disable: disable,
    setIntensity: setIntensity,
    setMood: setMood,
    heartbeat: setHeartbeat,
    sting: function () { if (running()) stingImpl(); },
    static: setStatic,
    whisper: function () { if (running()) whisperImpl(); },
    tick: function () { if (running()) tickImpl(); },
    chime: function () { if (running()) chimeImpl(); },
    reset: reset
  };

  // Real implementations live here so the public methods stay one-liners.
  function stingImpl() { sting(); }
  function whisperImpl() { whisper(); }
  function tickImpl() { tick(); }
  function chimeImpl() { chime(); }

  Object.defineProperty(api, 'enabled', {
    get: function () { return enabled; },
    enumerable: true
  });

  // Internal diagnostics for js/audio test page only.
  api._debug = function () {
    return {
      supported: SUPPORTED,
      hasContext: !!ctx,
      state: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : 0,
      enabled: enabled,
      hiddenPaused: hiddenPaused,
      intensity: S.intensity,
      mood: S.mood,
      bpm: S.bpm,
      staticLevel: S.staticLevel,
      heartbeatRunning: !!beatTimer,
      creakScheduled: !!creakTimer,
      masterGain: G ? Number(G.master.gain.value.toFixed(4)) : 0,
      documentHidden: !!(global.document && global.document.hidden)
    };
  };

  if (global.document && global.document.addEventListener) {
    global.document.addEventListener('visibilitychange', onVisibility, false);
  }

  global.HorrorAudio = api;
})(typeof window !== 'undefined' ? window : this);
