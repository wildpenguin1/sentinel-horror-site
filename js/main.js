/* ==========================================================================
   SENTINEL — scroll orchestration, corruption, and the thing at the end
   ========================================================================== */
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => {
    const t = clamp((v - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const body = document.body;
  const root = document.documentElement;
  const vh = () => window.innerHeight;
  const sessionStart = performance.now();

  const el = {
    header: $('#siteHeader'),
    progress: $('.progress-line i'),
    heroCam: $('#heroCam'),
    heroName: $('.cam-name'),
    chipA: $('.chip-a'),
    chipB: $('.chip-b'),
    live: $('#live'),
    camGrid: $('#camGrid'),
    liveTitle: $('#liveTitle'),
    liveNote: $('#liveNote'),
    liveStatus: $('#liveStatus'),
    pricing: $('#pricing'),
    descent: $('#descent'),
    sessionTime: $('#sessionTime'),
    descentLeave: $('#descentLeave'),
    fakeClose: $('#fakeClose'),
    fakeCloseMsg: $('#fakeCloseMsg'),
    localClock: $('#localClock'),
    deviceName: $('#deviceName'),
    intrusion: $('#intrusion'),
    intrFeed: $('#intrFeed'),
    intrSticky: $('.intr-sticky'),
    intrClock: $('#intrClock'),
    feedMsg: $('#feedMsg'),
    feedMsgText: $('#feedMsgText'),
    blackout: $('#intrBlackout'),
    blackoutLine: $('#blackoutLine'),
    flash: $('#finalFlash'),
    end: $('#end'),
    chat: $('#chat'),
    chatBody: $('#chatBody'),
    chatLog: $('#chatLog'),
    chatToggle: $('#chatToggle'),
    soundToggle: $('#soundToggle'),
    soundHint: $('#soundHint'),
    soundHintBtn: $('#soundHintBtn'),
    soundHintClose: $('#soundHintClose'),
    cursor: $('#cursorDot'),
    interject: $('#interject'),
    interjectText: $('#interjectText'),
    chatInput: $('.chat-input'),
  };

  const state = {
    applied: -1,
    heroCorrupted: false,
    liveFlags: {},
    chatShown: false,
    chatOpened: false,
    descentStep: -1,
    intrusionStage: -1,
    scared: false,
    hbBpm: null,
    staticLevel: -1,
    mood: null,
    lastAudio: 0,
    soundOn: false,
    titleStage: 0,
    interjectTimer: 0,
    lastInput: performance.now(),
    hiddenAt: 0,
    glitchTimer: 0,
    pointer: { x: innerWidth / 2, y: innerHeight / 2, cx: innerWidth / 2, cy: innerHeight / 2, active: false },
    live: null,
    descentQ: 0,
    intrusionQ: 0,
    feeds: [],
  };

  /* ------------------------------------------------------------------
     Audio bridge — all calls are safe even if the module never loaded
  ------------------------------------------------------------------ */
  const Audio = {
    ready: false,
    async enable() {
      if (!window.HorrorAudio) return false;
      try {
        await window.HorrorAudio.enable();
        this.ready = true;
        state.soundOn = true;
        el.soundToggle.setAttribute('aria-pressed', 'true');
        $('.sound-text', el.soundToggle).textContent = '声音 开';
        el.soundToggle.setAttribute('aria-label', '关闭声音');
        el.soundHint.classList.remove('show');
        try { window.HorrorAudio.chime(); } catch (e) {}
        state.mood = null;
        state.staticLevel = -1;
        state.hbBpm = null;
        updateAudio(true);
        return true;
      } catch (e) {
        return false;
      }
    },
    disable() {
      if (window.HorrorAudio && this.ready) {
        try { window.HorrorAudio.disable(); } catch (e) {}
      }
      state.soundOn = false;
      el.soundToggle.setAttribute('aria-pressed', 'false');
      $('.sound-text', el.soundToggle).textContent = '声音 关';
      el.soundToggle.setAttribute('aria-label', '开启声音');
    },
    call(fn, ...args) {
      if (!this.ready || !state.soundOn || !window.HorrorAudio) return;
      const f = window.HorrorAudio[fn];
      if (typeof f === 'function') {
        try { f.apply(window.HorrorAudio, args); } catch (e) {}
      }
    },
    setIntensity(v) { this.call('setIntensity', clamp(v)); },
    setMood(v) { this.call('setMood', v); },
    heartbeat(v) { this.call('heartbeat', v); },
    static(v) { this.call('static', clamp(v)); },
    sting() { this.call('sting'); },
    tick() { this.call('tick'); },
    whisper() { this.call('whisper'); },
  };

  function updateAudio(force = false) {
    if (!Audio.ready || !state.soundOn) return;
    const now = performance.now();
    if (!force && now - state.lastAudio < 160) return;
    state.lastAudio = now;

    const p = state.p;
    let intensity = p;
    let mood = 'calm';
    let staticLevel = 0;
    let bpm = null;

    if (p > 0.28) mood = 'unease';
    if (p > 0.5) mood = 'dread';
    if (p > 0.7) mood = 'void';
    intensity = clamp(p * 0.9);

    if (state.intrusionStage >= 0) {
      const s = state.intrusionStage;
      if (s >= 3) { mood = 'panic'; intensity = 0.75; }
      if (s >= 4) { intensity = 0.85; staticLevel = 0.18; bpm = 74; }
      if (s >= 5) { intensity = 0.95; staticLevel = 0.38; bpm = 92; }
      if (s >= 6) { mood = 'void'; intensity = 1; staticLevel = 0.72; bpm = null; }
      if (s >= 7) { mood = 'void'; intensity = 0.5; staticLevel = 0; bpm = null; }
    } else if (state.descentQ > 0.12 && state.descentQ < 0.95) {
      mood = 'dread';
      intensity = 0.45 + state.descentQ * 0.3;
      bpm = 58;
    }

    Audio.setIntensity(intensity);

    if (state.mood !== mood) {
      state.mood = mood;
      Audio.setMood(mood);
    }
    if (state.staticLevel === -1 || Math.abs(state.staticLevel - staticLevel) > 0.03) {
      state.staticLevel = staticLevel;
      Audio.static(staticLevel);
    }
    if (state.hbBpm !== bpm) {
      state.hbBpm = bpm;
      Audio.heartbeat(bpm);
    }
  }

  /* ------------------------------------------------------------------
     Camera feeds
  ------------------------------------------------------------------ */
  function initCameras() {
    const Cam = window.Cameras;
    if (!Cam || typeof Cam.Feed !== 'function') return;

    const make = (canvas, opts) => {
      try {
        const feed = new Cam.Feed(canvas, opts);
        state.feeds.push(feed);
        return feed;
      } catch (e) {
        return null;
      }
    };

    state.heroFeed = el.heroCam
      ? make(el.heroCam, { room: 'living', ir: false, seed: 3, label: 'CAM 02', clock: true })
      : null;

    state.liveFeeds = $$('.live-tile').map((tile) => {
      const canvas = $('canvas', tile);
      return make(canvas, {
        room: tile.dataset.room || 'living',
        ir: true,
        seed: 11 + Number(tile.dataset.index || 0) * 7,
        label: '',
        clock: true,
      });
    });

    // small debug hook: allows deterministic rendering for screenshots/QA
    window.__SENTINEL = {
      feeds: state.feeds,
      heroFeed: state.heroFeed,
      liveFeeds: state.liveFeeds,
      renderAll() {
        [state.heroFeed].concat(state.liveFeeds || []).forEach((feed) => {
          if (!feed) return;
          try {
            feed._visible = true;
            feed._render();
          } catch (e) {}
        });
      },
    };
  }

  function initHeroCam() {
    if (state.heroFeed) {
      try { state.heroFeed.setThreat(0); state.heroFeed.setGlitch(0); } catch (e) {}
    } else if (el.heroCam) {
      const ctx = el.heroCam.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 480, 320);
      g.addColorStop(0, '#1b2420');
      g.addColorStop(1, '#070a08');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 480, 320);
      ctx.fillStyle = 'rgba(180,200,180,.3)';
      ctx.font = '12px monospace';
      ctx.fillText('CAM 02', 22, 300);
    }
  }

  function corruptHero() {
    if (state.heroCorrupted) return;
    if (state.p < 0.42) return;
    state.heroCorrupted = true;
    if (state.heroFeed) {
      try { state.heroFeed.setThreat(0.82); state.heroFeed.setGlitch(0.32); } catch (e) {}
    }
    if (el.heroName) el.heroName.textContent = '客厅 · CAM 02 — 正在观看';
    if (el.chipA) el.chipA.innerHTML = '<span class="live-dot red"></span>AI 人形识别 · 已锁定';
    if (el.chipB) el.chipB.innerHTML = '今日已拦截 <strong>1</strong> 次异常';
  }

  /* ------------------------------------------------------------------
     Text corruption
  ------------------------------------------------------------------ */
  const SWAP_GLYPHS = '█▓▒░#/\\_∴⌁';

  function swapElement(node) {
    if (node.dataset.done) return;
    node.dataset.done = '1';
    const wrong = node.dataset.wrong;
    if (typeof wrong !== 'string' || !wrong) return;
    node.textContent = wrong;
    node.classList.add('wrong', 'swapped');
    const item = node.closest('.faq-item');
    if (item) item.classList.add('swapped');
    if (node.classList.contains('secret')) node.classList.add('lit');
    if (Math.random() > 0.55) Audio.tick();
  }

  function applyCorruptions(p) {
    if (p <= state.applied) return;
    state.applied = p;

    $$('[data-at][data-wrong]').forEach((node) => {
      if (node.closest('.site-header')) {
        const at = parseFloat(node.dataset.at);
        if (!Number.isNaN(at) && p >= at) swapElement(node);
        return;
      }
      scheduleContentSwap(node, false);
    });

    $$('.secret[data-at]').forEach((node) => scheduleContentSwap(node, true));

    if (p >= 0.42) revealChat();
    if (p >= 0.55) setTitle('SENTINEL · 正在观看', 1);
    if (p >= 0.62) setFavicon('#a32a1f');
    if (p >= 0.1) maybeCorruptPricing();
  }

  /* Corruption that happens while the visitor is actually looking at it. */
  function scheduleContentSwap(node, isSecret) {
    if (node.dataset.done || node.dataset.pending) return;
    if (state.p < 0.1) return;
    const host =
      node.closest('.faq-item, .price-card, .footer-links, .site-footer, .card, .step, .review') || node;
    const r = host.getBoundingClientRect();
    const inView = r.bottom > vh() * 0.12 && r.top < vh() * 0.88;
    if (!inView) return;
    node.dataset.pending = '1';
    const delay = 1500 + Math.random() * 1600;
    window.setTimeout(() => {
      node.dataset.pending = '';
      if (!node.isConnected) return;
      if (isSecret) node.classList.add('lit');
      else swapElement(node);
    }, delay);
  }

  function maybeCorruptPricing() {
    if (state.liveFlags.pricingScheduled || !el.pricing) return;
    if (state.p < 0.1) return;
    const r = el.pricing.getBoundingClientRect();
    if (r.top < vh() * 0.85 && r.bottom > vh() * 0.15) {
      state.liveFlags.pricingScheduled = true;
      window.setTimeout(corruptPricing, 2400);
    }
  }

  function corruptPricing() {
    if (state.liveFlags.pricing) return;
    state.liveFlags.pricing = true;
    const card = $('#cardPermanent');
    if (!card) return;
    card.classList.add('corrupted');
    const plan = $('#card3Plan');
    const title = $('#card3Title');
    const list = $('#card3List');
    const cta = $('#card3Cta');
    const price = $('.price', card);
    if (plan) plan.textContent = '永远';
    if (title) title.textContent = '守望 · 永久';
    if (price) {
      price.innerHTML = '已付<span class="per"> · 无需续费</span>';
      price.classList.add('wrong');
    }
    if (list) {
      list.innerHTML = '<li>不限机位</li><li>永久回看</li><li>不再需要醒来</li><li>它一直在线</li>';
    }
    if (cta) {
      cta.textContent = '它已经开始了';
      cta.classList.add('wrong');
    }
    const heading = $('#pricingTitle');
    if (heading) heading.textContent = '选择适合它的守护。';
    Audio.whisper();
  }

  function setTitle(text, stage) {
    if (state.titleStage >= stage) return;
    state.titleStage = stage;
    document.title = text;
  }

  function setFavicon(color) {
    if (state.faviconSet) return;
    state.faviconSet = true;
    const link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    const encoded = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a0a0a"/><circle cx="16" cy="16" r="4" fill="${color}"/></svg>`
    );
    link.href = 'data:image/svg+xml,' + encoded;
  }

  /* ------------------------------------------------------------------
     Live camera section
  ------------------------------------------------------------------ */
  function updateLiveSection() {
    if (!el.live || !el.camGrid) return;
    const gr = el.camGrid.getBoundingClientRect();
    const travel = Math.max(320, gr.height * 0.82);
    const q = clamp((vh() * 0.82 - gr.top) / travel);
    state.liveQ = q;

    const feeds = state.liveFeeds || [];
    if (feeds[0]) { try { feeds[0].setThreat(0); feeds[0].setGlitch(smooth(0.7, 1, q) * 0.15); } catch (e) {} }
    if (feeds[1]) {
      try {
        feeds[1].setThreat(smooth(0.18, 0.72, q) * 0.7);
        feeds[1].setGlitch(smooth(0.5, 0.95, q) * 0.55);
      } catch (e) {}
    }
    if (feeds[2]) {
      try {
        feeds[2].setThreat(smooth(0.45, 0.9, q) * 0.32);
        feeds[2].setGlitch(smooth(0.75, 1, q) * 0.2);
      } catch (e) {}
    }
    if (feeds[3]) { try { feeds[3].setThreat(0); feeds[3].setGlitch(smooth(0.85, 1, q) * 0.25); } catch (e) {} }

    if (q > 0.3 && !state.liveFlags.note1) {
      state.liveFlags.note1 = true;
      if (el.liveNote) el.liveNote.textContent = '画面已加密。只有它能解密。';
      if (el.liveNote) el.liveNote.classList.add('warn');
      swapStatus(1, '加密中 · 1 个未知设备');
    }
    if (q > 0.52 && !state.liveFlags.note2) {
      state.liveFlags.note2 = true;
      if (el.liveTitle) {
        el.liveTitle.textContent = '现在，它看看你的家。';
        el.liveTitle.classList.add('wrong');
      }
      swapStatus(2, '仅它可见');
      setTitle('SENTINEL · 正在观看', 1);
    }
    if (q > 0.72 && !state.liveFlags.note3) {
      state.liveFlags.note3 = true;
      if (el.liveNote) el.liveNote.textContent = '请确认您身后没有人。';
      swapStatus(3, '请勿长时间注视画面');
      Audio.whisper();
    }
    if (q > 0.9 && !state.liveFlags.note4) {
      state.liveFlags.note4 = true;
      if (el.liveNote) el.liveNote.textContent = '它一直看着。';
    }
  }

  function swapStatus(index, text) {
    const items = $$('.status-item', el.liveStatus);
    const item = items[index];
    if (!item) return;
    item.innerHTML = '<i class="ok"></i>' + text;
    item.classList.add('wrong');
  }

  /* ------------------------------------------------------------------
     Descent
  ------------------------------------------------------------------ */
  const DESCENT_STEPS = [0.035, 0.15, 0.265, 0.39, 0.53, 0.67];

  function updateDescent() {
    if (!el.descent) return;
    const rect = el.descent.getBoundingClientRect();
    const travel = Math.max(1, el.descent.offsetHeight - vh());
    const q = clamp(-rect.top / travel);
    state.descentQ = q;

    let step = 0;
    for (let i = 0; i < DESCENT_STEPS.length; i++) {
      if (q >= DESCENT_STEPS[i]) step = i + 1;
    }
    if (step !== state.descentStep) {
      state.descentStep = step;
      $$('.dline', el.descent).forEach((line) => {
        const i = Number(line.dataset.dline);
        line.classList.toggle('on', i === step - 1);
        line.classList.toggle('past', i < step - 1);
      });
      if (step > 0) Audio.tick();
      if (step >= 4 && !state.liveFlags.breath) {
        state.liveFlags.breath = true;
        Audio.whisper();
      }
    }

    const showLeave = q > 0.78;
    el.descentLeave.classList.toggle('show', showLeave);
    if (q > 0.84 && !state.liveFlags.closeOffered) {
      state.liveFlags.closeOffered = true;
      Audio.heartbeat(58);
    }
  }

  /* ------------------------------------------------------------------
     Intrusion
  ------------------------------------------------------------------ */
  const INTRUSION_STAGES = [
    { at: 0.08, text: '检测到移动 · 走廊', warn: false },
    { at: 0.2, text: '正在识别……', warn: false },
    { at: 0.34, text: '身份：未知', warn: true },
    { at: 0.48, text: '目标正在接近', warn: true },
    { at: 0.62, text: '信号不稳定', warn: true },
    { at: 0.74, text: '', warn: true },
    { at: 0.87, text: '', warn: true },
  ];

  function updateIntrusion() {
    if (!el.intrusion) return;
    const rect = el.intrusion.getBoundingClientRect();
    const travel = Math.max(1, el.intrusion.offsetHeight - vh());
    const q = clamp(-rect.top / travel);
    state.intrusionQ = q;

    let stage = 0;
    for (let i = 0; i < INTRUSION_STAGES.length; i++) {
      if (q >= INTRUSION_STAGES[i].at) stage = i + 1;
    }
    // cap at 7 (blackout)
    stage = Math.min(stage, 7);

    if (stage !== state.intrusionStage) {
      state.intrusionStage = stage;
      el.intrusion.dataset.stage = String(stage);
      el.intrSticky.classList.remove('cut');
      void el.intrSticky.offsetWidth;
      el.intrSticky.classList.add('cut');
      window.setTimeout(() => el.intrSticky.classList.remove('cut'), 240);

      if (stage >= 1 && stage <= 5) {
        el.feedMsg.classList.remove('hidden');
        el.feedMsg.classList.toggle('warn', INTRUSION_STAGES[stage - 1].warn);
        el.feedMsgText.textContent = INTRUSION_STAGES[stage - 1].text;
      }
      if (stage === 6) {
        el.feedMsg.classList.add('hidden');
        el.blackoutLine.textContent = '别回头。';
        state.hbBpm = null;
        Audio.heartbeat(null);
        Audio.static(0.72);
        Audio.whisper();
      }
      if (stage === 7) {
        el.feedMsg.classList.add('hidden');
        el.blackoutLine.textContent = '别回头。';
        Audio.static(0);
        Audio.whisper();
      }
      if (stage >= 3 && stage <= 5) Audio.tick();
    }

    if (q > 0.93 && !state.scared) {
      state.scared = true;
      triggerFlash();
    }
  }

  function triggerFlash() {
    if (!el.flash) return;
    Audio.sting();
    if (!reduced) {
      body.classList.add('shake');
      window.setTimeout(() => body.classList.remove('shake'), 520);
    }
    el.flash.classList.add('on');
    window.setTimeout(() => el.flash.classList.remove('on'), 480);
    window.setTimeout(() => {
      el.blackoutLine.style.transition = 'opacity 1.2s ease';
      el.blackoutLine.style.opacity = '0';
      setTitle('它还在。', 3);
    }, 1100);
  }

  /* ------------------------------------------------------------------
     Chat
  ------------------------------------------------------------------ */
  function revealChat() {
    if (state.chatShown || !el.chat) return;
    state.chatShown = true;
    el.chat.classList.add('available');
    if (window.innerWidth > 900) {
      window.setTimeout(() => {
        if (!state.chatOpened) openChat(true);
      }, 2600);
    }
  }

  function openChat(auto) {
    state.chatOpened = true;
    el.chat.classList.add('open');
    el.chatToggle.setAttribute('aria-expanded', 'true');
    if (auto) startChatScript();
  }

  function startChatScript() {
    if (state.chatScript) return;
    state.chatScript = true;
    const add = (text, creepy) => {
      const div = document.createElement('div');
      div.className = 'msg' + (creepy ? ' creepy' : '');
      div.textContent = text;
      el.chatLog.appendChild(div);
      el.chatLog.scrollTop = el.chatLog.scrollHeight;
      Audio.tick();
    };
    const typing = (delay, cb) => {
      window.setTimeout(() => {
        if (!el.chat.classList.contains('open')) return;
        const t = document.createElement('div');
        t.className = 'msg typing';
        t.innerHTML = '<i></i><i></i><i></i>';
        el.chatLog.appendChild(t);
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
        window.setTimeout(() => {
          t.remove();
          cb();
        }, 1100);
      }, delay);
    };
    add('您好，这里是 SENTINEL 售后。', false);
    typing(1400, () => add('检测到您的设备仍在持续观看。', false));
    typing(3900, () => add('请问，您家里现在只有您一个人吗？', true));
    typing(7600, () => add('请不要关闭页面。', true));
  }

  /* ------------------------------------------------------------------
     Interjections, cursor, clock
  ------------------------------------------------------------------ */
  function showInterject(text, duration = 2200) {
    if (!el.interject || !el.interjectText) return;
    el.interjectText.textContent = text;
    el.interject.classList.add('show');
    window.clearTimeout(state.interjectTimer);
    state.interjectTimer = window.setTimeout(() => {
      el.interject.classList.remove('show');
    }, duration);
  }

  function tickClock() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    if (el.intrClock) el.intrClock.textContent = state.intrusionQ > 0.02 ? `${date} ${time}` : `${date} ${time}`;
    if (el.localClock) el.localClock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const elapsed = Math.floor((performance.now() - sessionStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    if (el.sessionTime) el.sessionTime.textContent = `${mm}:${ss}`;

    if (state.intrusionStage >= 3 && state.intrusionStage <= 5 && Math.random() > 0.82) {
      Audio.tick();
    }
  }

  function setDevice() {
    if (!el.deviceName) return;
    const ua = navigator.userAgent;
    let os = '未知设备';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Linux/i.test(ua)) os = 'Linux';
    let br = '浏览器';
    if (/Edg\//.test(ua)) br = 'Edge';
    else if (/OPR\//.test(ua)) br = 'Opera';
    else if (/Chrome\//.test(ua)) br = 'Chrome';
    else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) br = 'Safari';
    else if (/Firefox\//.test(ua)) br = 'Firefox';
    el.deviceName.textContent = `${os} · ${br}`;
    if (el.intrClock) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      el.intrClock.textContent =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
  }

  /* ------------------------------------------------------------------
     Random text glitches in the late acts
  ------------------------------------------------------------------ */
  function scheduleGlitch() {
    window.clearInterval(state.glitchTimer);
    state.glitchTimer = window.setInterval(() => {
      if (state.p < 0.46 || state.scared) return;
      if (document.hidden) return;
      const targets = $$('.h2').filter((n) => {
        const r = n.getBoundingClientRect();
        return r.top < vh() * 0.9 && r.bottom > vh() * 0.1;
      });
      if (!targets.length) return;
      const node = targets[Math.floor(Math.random() * targets.length)];
      glitchText(node);
      if (Math.random() > 0.6) Audio.tick();
    }, 4200);
  }

  function glitchText(node) {
    if (node.dataset.glitching) return;
    node.dataset.glitching = '1';
    const nodes = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      nodes.push([walker.currentNode, walker.currentNode.nodeValue]);
    }
    if (!nodes.length) {
      delete node.dataset.glitching;
      return;
    }
    let frames = 0;
    const id = window.setInterval(() => {
      frames++;
      if (frames > 3) {
        window.clearInterval(id);
        nodes.forEach(([n, text]) => { n.nodeValue = text; });
        delete node.dataset.glitching;
        return;
      }
      nodes.forEach(([n, text]) => {
        n.nodeValue = text
          .split('')
          .map((ch) => (ch.trim() && Math.random() < 0.25 ? SWAP_GLYPHS[Math.floor(Math.random() * SWAP_GLYPHS.length)] : ch))
          .join('');
      });
    }, 45);
  }

  /* ------------------------------------------------------------------
     Main scroll loop
  ------------------------------------------------------------------ */
  function update() {
    const y = window.scrollY;
    const max = Math.max(1, document.documentElement.scrollHeight - vh());
    const p = clamp(y / max);
    state.p = p;

    root.style.setProperty('--p', p.toFixed(4));
    if (el.progress) el.progress.style.width = (p * 100).toFixed(2) + '%';

    el.header.classList.toggle('scrolled', y > 24);
    if (el.live) {
      el.header.classList.toggle('on-dark', el.live.getBoundingClientRect().top < 90);
    }
    if (el.descent) {
      const descentTop = el.descent.getBoundingClientRect().top;
      el.header.classList.toggle('header-gone', descentTop < vh() * 0.7);
      body.classList.toggle('in-descent', descentTop < vh() * 0.7);
    }
    body.classList.toggle('is-uneasy', p > 0.22);
    body.classList.toggle('is-wrong', p > 0.42);
    body.classList.toggle('is-dread', p > 0.62);
    body.classList.toggle('is-black', p > 0.7);

    // hero camera corruption
    corruptHero();
    applyCorruptions(p);
    updateLiveSection();
    updateDescent();
    updateIntrusion();
    updateAudio();

    // header pupil follows the pointer once things are wrong
    if (p > 0.3 && state.pointer.active) {
      const pupil = $('.brand-pupil');
      if (pupil) {
        const mx = clamp((state.pointer.x / innerWidth - 0.5) * 3.4, -1.7, 1.7);
        const my = clamp((state.pointer.y / innerHeight - 0.5) * 3.4, -1.7, 1.7);
        pupil.style.transform = `translate(${mx}px, ${my}px)`;
      }
    }

    // cursor follower visibility
    if (el.cursor) {
      const fine = window.matchMedia('(pointer: fine)').matches;
      const on = fine && p > 0.34 && state.pointer.active;
      el.cursor.classList.toggle('show', on);
    }
  }

  function requestUpdate() {
    if (state.raf) return;
    state.raf = true;
    requestAnimationFrame(() => {
      state.raf = false;
      update();
    });
  }

  /* ------------------------------------------------------------------
     Cursor follower
  ------------------------------------------------------------------ */
  function initCursor() {
    if (!el.cursor) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    window.addEventListener('pointermove', (e) => {
      state.pointer.active = true;
      state.pointer.x = e.clientX;
      state.pointer.y = e.clientY;
      state.lastInput = performance.now();
    }, { passive: true });

    const loop = () => {
      const pt = state.pointer;
      pt.cx += (pt.x - pt.cx) * 0.18;
      pt.cy += (pt.y - pt.cy) * 0.18;
      el.cursor.style.transform = `translate(${pt.cx}px, ${pt.cy}px) translate(-50%, -50%)`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------------------
     Idle / visibility
  ------------------------------------------------------------------ */
  function initIdle() {
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) => {
      window.addEventListener(ev, () => { state.lastInput = performance.now(); }, { passive: true });
    });

    window.setInterval(() => {
      const idle = performance.now() - state.lastInput;
      if (idle > 24000 && state.p > 0.62 && state.p < 0.92 && state.descentQ > 0.2 && state.descentQ < 0.95 && state.intrusionQ < 0.02) {
        state.lastInput = performance.now();
        showInterject('你还在吗？');
        Audio.whisper();
      }
    }, 4000);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        state.hiddenAt = Date.now();
      } else if (state.hiddenAt && state.p > 0.58) {
        const away = Math.round((Date.now() - state.hiddenAt) / 1000);
        state.hiddenAt = 0;
        if (away > 2 && away < 600) {
          window.setTimeout(() => showInterject(`你离开了 ${away} 秒。`), 800);
        }
      }
    });
  }

  /* ------------------------------------------------------------------
     Wiring
  ------------------------------------------------------------------ */
  function initReveal() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    $$('.reveal').forEach((node) => io.observe(node));

    const endIO = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          endIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });
    if (el.end) endIO.observe(el.end);
  }

  function initMenu() {
    const btn = $('#menuBtn');
    const menu = $('#mobileMenu');
    if (!btn || !menu) return;
    const close = () => {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', '打开菜单');
    };
    btn.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
      Audio.tick();
    });
    $$('a, .mm-login', menu).forEach((link) => link.addEventListener('click', close));
    window.addEventListener('scroll', () => {
      if (menu.classList.contains('open') && state.p > 0.5) close();
    }, { passive: true });
  }

  function initSound() {
    if (!window.HorrorAudio) {
      el.soundHintBtn.style.display = 'none';
    }
    window.setTimeout(() => {
      if (!state.soundOn) el.soundHint.classList.add('show');
    }, 1200);
    window.setTimeout(() => el.soundHint.classList.remove('show'), 14000);

    el.soundHintClose.addEventListener('click', () => el.soundHint.classList.remove('show'));
    el.soundHintBtn.addEventListener('click', () => Audio.enable());
    el.soundToggle.addEventListener('click', async () => {
      if (state.soundOn) {
        Audio.disable();
      } else {
        const ok = await Audio.enable();
        if (!ok) {
          el.soundToggle.querySelector('.sound-text').textContent = '声音不可用';
        }
      }
    });
  }

  function initChat() {
    el.chatToggle.addEventListener('click', () => {
      if (!state.chatShown) return;
      const open = el.chat.classList.toggle('open');
      el.chatToggle.setAttribute('aria-expanded', String(open));
      if (open) openChat(true);
    });
  }

  function initForms() {
    const form = $('#subscribeForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('input', form);
        const note = $('#subscribeNote');
        if (!input || !input.value.trim()) {
          if (note) note.textContent = '请先留下一个邮箱。它在等。';
          return;
        }
        if (note) {
          note.textContent = state.p > 0.5 ? '订阅成功。它会记住这个地址。' : '订阅成功，请查收确认邮件。';
          note.classList.toggle('wrong', state.p > 0.5);
        }
        input.value = '';
        Audio.tick();
      });
    }

    $$('[data-noop]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (state.p > 0.5) {
          showInterject('这个按钮已经不属于你了。', 1500);
        }
      });
    });

    el.fakeClose.addEventListener('click', () => {
      el.fakeCloseMsg.classList.add('show');
      el.fakeClose.textContent = '关不掉';
      el.fakeClose.classList.add('wrong');
      Audio.whisper();
      showInterject('门不在那边。', 1900);
    });

    const restart = $('#restart');
    if (restart) restart.addEventListener('click', () => location.reload());
  }

  function initScrollFx() {
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate, { passive: true });
    window.addEventListener('load', requestUpdate);
    requestUpdate();
  }

  /* ------------------------------------------------------------------
     QA mode — only active with ?qa=1 (used for automated screenshots)
  ------------------------------------------------------------------ */
  function initQA() {
    const params = new URLSearchParams(location.search);
    if (!params.has('qa')) return;
    root.classList.add('qa');
    const go = () => {
      $$('.reveal').forEach((n) => n.classList.add('in'));
      if (window.__SENTINEL) window.__SENTINEL.renderAll();
      const to = params.get('to');
      const frac = parseFloat(params.get('scroll'));
      let y = null;
      if (to) {
        const node = document.querySelector(to);
        if (node) y = node.getBoundingClientRect().top + window.scrollY + (parseFloat(params.get('off')) || 0);
      } else if (!Number.isNaN(frac)) {
        y = frac * Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      }
      if (y !== null) {
        root.style.scrollBehavior = 'auto';
        window.scrollTo(0, y);
        window.dispatchEvent(new Event('scroll'));
        update();
      }
      if (window.__SENTINEL) window.__SENTINEL.renderAll();
    };
    window.setTimeout(go, 450);
    window.setTimeout(go, 1400);
    if (params.has('flash') && el.flash) {
      window.setTimeout(() => { el.flash.style.opacity = '1'; }, 900);
    }
    if (params.has('menu')) {
      window.setTimeout(() => {
        const btn = $('#menuBtn');
        if (btn) btn.click();
      }, 900);
    }
    window.setInterval(() => {
      if (window.__SENTINEL) window.__SENTINEL.renderAll();
    }, 900);
  }

  /* ------------------------------------------------------------------
     Boot
  ------------------------------------------------------------------ */
  function boot() {
    initReveal();
    initCameras();
    initHeroCam();
    initCursor();
    initIdle();
    initSound();
    initChat();
    initMenu();
    initForms();
    initScrollFx();
    scheduleGlitch();
    tickClock();
    setDevice();
    window.setInterval(tickClock, 1000);
    if (el.feedMsg) el.feedMsg.classList.add('hidden');
    initQA();
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
