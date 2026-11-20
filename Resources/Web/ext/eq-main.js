/* Эквалайзер SoundCloud. Работает в «мире страницы» (world: MAIN), потому что аудио-элементы
   SoundCloud создаёт сам сайт (new Audio()) и из изолированного мира расширения до них не достучаться.

   Важно: плеер SoundCloud сам вызывает AudioContext.createMediaElementSource(<audio>) (для фейдов громкости),
   а браузер разрешает это ровно один раз на элемент. Поэтому «захватить» элемент второй раз нельзя —
   вместо этого мы перехватываем вызов сайта и вставляем цепочку эквалайзера прямо в его аудиограф:
       <audio> -> [наша цепочка: фильтры 60 Гц … 15 кГц -> лимитер] -> то, куда сайт подключал источник.
   Для элементов, которые сайт к Web Audio не подключает, остаётся запасной путь: свой AudioContext.
   Настройки приходят сообщениями от content.js. */
(() => {
  'use strict';
  if (window.__sccEq) return;
  window.__sccEq = true;

  /* не трогаем встроенные плееры SoundCloud на чужих сайтах (в Firefox нет location.ancestorOrigins) */
  const isScHost = (h) => /(^|\.)soundcloud\.com$/.test(h);
  const embeddedElsewhere = () => {
    if (window === window.top) return false;
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return !isScHost(new URL(ao[ao.length - 1]).hostname);
    } catch (e) { /* ignore */ }
    try { return !isScHost(window.top.location.hostname); } catch (e) { /* верхняя страница другого origin */ }
    try { if (document.referrer) return !isScHost(new URL(document.referrer).hostname); } catch (e) { /* ignore */ }
    return false;
  };
  if (embeddedElsewhere()) return;

  const LOG = () => {};   // отладочный вывод отключён

  const BANDS = [
    { f: 60, type: 'lowshelf' }, { f: 150, type: 'peaking' }, { f: 400, type: 'peaking' },
    { f: 1000, type: 'peaking' }, { f: 2400, type: 'peaking' }, { f: 6000, type: 'peaking' },
    { f: 15000, type: 'highshelf' },
  ];

  let cfg = { enabled: false, preamp: 0, gains: BANDS.map(() => 0) };
  const chains = new Set();          // все цепочки эквалайзера (в контексте сайта и собственная)
  const elChain = new WeakMap();     // <audio> -> цепочка, через которую идёт его звук
  const pageOwned = new WeakSet();   // элементы, которые сайт сам подключил к Web Audio
  const ownPending = new WeakSet();
  const tracked = [];                // WeakRef на все найденные медиа-элементы
  let own = null;                    // запасная цепочка в нашем собственном AudioContext
  let origCreate = null;             // оригинальный createMediaElementSource
  let status = '', lastPost = 0;

  function setStatus(s) {
    if (s === status && Date.now() - lastPost < 4000) return;   // раз в 4 с подтверждаем, что вкладка жива
    status = s; lastPost = Date.now();
    window.postMessage({ __scc: 'eq-status', state: s }, location.origin && location.origin !== 'null' ? location.origin : '*');
  }

  /* ---------- цепочка эквалайзера ---------- */

  function buildChain(ctx, owner) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const pre = ctx.createGain();
    const eqGain = ctx.createGain();       // путь через эквалайзер
    const directGain = ctx.createGain();   // обход (эквалайзер выключен)
    eqGain.gain.value = 0;
    directGain.gain.value = 1;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 4; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.25;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    input.connect(pre);
    let node = pre;
    const filters = BANDS.map((b) => {
      const flt = ctx.createBiquadFilter();
      flt.type = b.type; flt.frequency.value = b.f; flt.Q.value = b.type === 'peaking' ? 1.1 : 0.7; flt.gain.value = 0;
      node.connect(flt); node = flt;
      return flt;
    });
    node.connect(limiter); limiter.connect(eqGain); eqGain.connect(output);
    input.connect(directGain); directGain.connect(output);
    output.connect(analyser);

    const ch = { ctx, owner, input, output, pre, filters, eqGain, directGain, analyser };
    chains.add(ch);
    applyChain(ch, true);
    return ch;
  }

  function applyChain(ch, instant) {
    const t = ch.ctx.currentTime, k = instant ? 0.001 : 0.03;
    const on = !!cfg.enabled;
    ch.eqGain.gain.setTargetAtTime(on ? 1 : 0, t, k);
    ch.directGain.gain.setTargetAtTime(on ? 0 : 1, t, k);
    ch.pre.gain.setTargetAtTime(Math.pow(10, (Number(cfg.preamp) || 0) / 20), t, k);
    ch.filters.forEach((f, i) => f.gain.setTargetAtTime(Number(cfg.gains[i]) || 0, t, k));
  }

  function applyAll(instant) { chains.forEach(ch => applyChain(ch, instant)); }

  function addTracked(el) {
    if (!tracked.some(r => r.deref() === el)) tracked.push(new WeakRef(el));
  }

  /* ---------- основной путь: встраиваемся в аудиограф сайта ---------- */

  function adopt(src, ctx, el) {
    if (!el || !(el instanceof HTMLMediaElement) || pageOwned.has(el)) return;
    pageOwned.add(el);
    addTracked(el);

    const ch = buildChain(ctx, 'page');
    elChain.set(el, ch);

    const origConnect = src.connect;
    const origDisconnect = src.disconnect;
    let wired = false;

    /* Всё, что сайт подключает к источнику, теперь идёт через нашу цепочку. */
    src.connect = function (dest) {
      if (!wired) { origConnect.call(src, ch.input); wired = true; }
      ch.output.connect.apply(ch.output, arguments);
      return dest instanceof AudioNode ? dest : undefined;
    };
    src.disconnect = function () {
      if (!arguments.length) {
        try { ch.output.disconnect(); } catch (e) { /* ignore */ }
        try { ch.output.connect(ch.analyser); } catch (e) { /* ignore */ }
        try { origDisconnect.call(src); } catch (e) { /* ignore */ }
        wired = false;
        return undefined;
      }
      ch.output.disconnect.apply(ch.output, arguments);
      return undefined;
    };
    LOG('эквалайзер встроен в аудиограф сайта для', el.currentSrc || el.src || '<audio>');
  }

  function installHooks() {
    const protos = [window.AudioContext && AudioContext.prototype, window.BaseAudioContext && BaseAudioContext.prototype]
      .filter(Boolean);
    for (const p of protos) {
      const d = Object.getOwnPropertyDescriptor(p, 'createMediaElementSource');
      if (!d || typeof d.value !== 'function') continue;
      const orig = d.value;
      if (!origCreate) origCreate = orig;
      Object.defineProperty(p, 'createMediaElementSource', Object.assign({}, d, {
        value: function createMediaElementSource(el) {
          const src = orig.apply(this, arguments);          // ошибки сайта пробрасываем как обычно
          try { adopt(src, this, el); } catch (e) { LOG('adopt', e); }
          return src;
        },
      }));
    }

    /* вариант с конструктором: new MediaElementAudioSourceNode(ctx, { mediaElement }) */
    try {
      const Orig = window.MediaElementAudioSourceNode;
      if (Orig) {
        window.MediaElementAudioSourceNode = new Proxy(Orig, {
          construct(target, args, newTarget) {
            const node = Reflect.construct(target, args, newTarget);
            try { adopt(node, args[0], args[1] && args[1].mediaElement); } catch (e) { LOG('adopt', e); }
            return node;
          },
        });
      }
    } catch (e) { /* ignore */ }
  }
  installHooks();

  /* ---------- запасной путь: свой AudioContext для элементов, которые сайт не подключал ---------- */

  function ownChain() {
    if (own) return own;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC({ latencyHint: 'playback' });
    own = buildChain(ctx, 'own');
    own.output.connect(ctx.destination);
    return own;
  }

  /* Захват элемента необратим. Если источник чужой и без CORS, звук после захвата пропадёт навсегда —
     такие элементы не трогаем. */
  function capturable(el) {
    const src = el.currentSrc || el.src || '';
    if (!src || /^(blob|data):/i.test(src)) return true;
    try { if (new URL(src, location.href).origin === location.origin) return true; } catch (e) { /* ignore */ }
    return el.crossOrigin !== null;
  }

  function connectOwn(el) {
    if (elChain.has(el) || pageOwned.has(el) || !origCreate) return;
    if (!capturable(el)) return;
    const ch = ownChain();
    if (!ch) return;
    try {
      const src = origCreate.call(ch.ctx, el);
      src.connect(ch.input);
      elChain.set(el, ch);
      el.addEventListener('play', resume);
      LOG('эквалайзер подключён к элементу напрямую', el.currentSrc || el.src);
    } catch (e) { LOG('не удалось подключить элемент', e); }
    resume();
  }

  /* С задержкой: сайт мог вызвать play() раньше, чем createMediaElementSource, — не мешаем ему. */
  function scheduleOwn(el) {
    if (elChain.has(el) || pageOwned.has(el) || ownPending.has(el)) return;
    ownPending.add(el);
    setTimeout(() => {
      ownPending.delete(el);
      if (cfg.enabled && !pageOwned.has(el) && !el.paused) connectOwn(el);
    }, 1500);
  }

  function resume() { if (own && own.ctx.state !== 'running') own.ctx.resume().catch(() => {}); }
  ['pointerdown', 'keydown', 'click'].forEach(ev => window.addEventListener(ev, resume, true));

  function track(el) {
    if (!el || !(el instanceof HTMLMediaElement)) return;
    addTracked(el);
    if (cfg.enabled) scheduleOwn(el);
  }

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try { track(this); } catch (e) { /* ignore */ }
    return origPlay.apply(this, args);
  };
  document.addEventListener('playing', (e) => { if (e.target instanceof HTMLMediaElement) track(e.target); }, true);

  /* ---------- статус для окна расширения ---------- */

  let silentTicks = 0;
  const buf = new Uint8Array(256);
  setInterval(() => {
    if (!cfg.enabled) { setStatus('off'); return; }
    const live = [];
    let blocked = false;
    for (const r of tracked) {
      const el = r.deref();
      if (!el || el.paused || el.muted || el.volume <= 0 || el.readyState <= 2) continue;
      const ch = elChain.get(el);
      if (ch) live.push(ch); else if (!pageOwned.has(el) && !capturable(el)) blocked = true;
    }
    if (!live.length) { setStatus(blocked ? 'unsupported' : 'idle'); silentTicks = 0; return; }
    let peak = 0;
    for (const ch of live) {
      ch.analyser.getByteTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
    }
    silentTicks = peak <= 1 ? silentTicks + 1 : 0;
    const running = live.every(ch => ch.ctx.state === 'running');
    setStatus(silentTicks >= 4 ? 'silent' : (running ? 'active' : 'suspended'));
  }, 1000);

  /* ---------- настройки от content.js ---------- */

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__scc !== 'eq' || !e.data.cfg) return;
    const c = e.data.cfg;
    cfg = {
      enabled: !!c.enabled,
      preamp: Math.max(-12, Math.min(12, Number(c.preamp) || 0)),
      gains: BANDS.map((_, i) => Math.max(-12, Math.min(12, Number(c.gains && c.gains[i]) || 0))),
    };
    if (cfg.enabled) {
      tracked.forEach(r => { const el = r.deref(); if (el && !el.paused) scheduleOwn(el); });
      // элементы, которые уже лежат в DOM, но play() ещё не вызывали
      document.querySelectorAll('audio,video').forEach(el => { if (!el.paused) track(el); });
    }
    applyAll(false);
  });

  window.postMessage({ __scc: 'eq-hello' }, location.origin && location.origin !== 'null' ? location.origin : '*');
})();
