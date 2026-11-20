/* Приветствие при первом запуске.
   1) Затемнённый размытый экран: логотип и название выезжают сверху, аватар, ник и подсказка — снизу.
   2) Клик в любом месте (или Esc / Enter / пробел) — экран медленно гаснет.
   3) Под панелью закреплённых расширений буква за буквой печатается подсказка со стрелкой на значок расширения.
   Показывается один раз (storage.local.welcomeSeen). Повторно: «Основные» → «Приветствие» → «Показать».
   Всё лежит в Shadow DOM с data-scc-own, «Свой CSS» его не затрагивает. */
(() => {
  /* безопасная вставка разметки: разбираем в изолированном документе, через DOMParser */
  const setHTML = (el, html) => {
    const d = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
    el.replaceChildren(...Array.from(d.body.childNodes).map((n) => document.importNode(n, true)));
  };
  const setSVG = (el, markup) => {
    const d = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + markup + '</svg>', 'image/svg+xml');
    el.replaceChildren(...Array.from(d.documentElement.childNodes).map((n) => document.importNode(n, true)));
  };

  'use strict';
  if (window !== window.top || window.__sccWelcome) return;
  window.__sccWelcome = true;

  /* Где стрелка: расстояние от правого края окна до её середины, px. Значок расширения стоит левее аватара профиля
     и меню «⋮» (и левее кнопок окна, если браузер рисует их в одной строке с адресной строкой).
     Если стрелка указывает не туда, где у вас значок, поправьте это число. */
  const ARROW_CENTER = 385;
  const BUBBLE_W = 410;

  const HOST_ID = 'scc-welcome-host';
  const HEX = /^#[0-9a-f]{6}$/i;
  const TITLE = 'Customizer for SoundCloud';
  const LEGAL = 'Неофициальное расширение: не связано с SoundCloud и не одобрено им. SoundCloud — товарный знак его владельца.';
  const CONTINUE = 'Чтобы открыть меню и настройки, нажмите на круглую кнопку у края экрана.';
  const CREDIT = 'made by 211';
  const TOUR = 'Нажми на иконку расширения, чтобы открыть настройки';
  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  let accent = '#ff5500';
  let host = null, root = null, stage = null, tour = null;
  let phase = 'idle';                  // idle | welcome | leaving | tour
  let timers = [];
  let typingToken = 0;

  const sleep = (ms) => new Promise(r => { const t = setTimeout(r, REDUCED ? Math.min(ms, 30) : ms); timers.push(t); });
  const alive = () => { try { return !!(browser.runtime && browser.runtime.id); } catch (e) { return false; } };

  /* ---------- шрифт ---------- */

  async function loadFont(text) {
    try {
      const r = await Promise.race([
        browser.runtime.sendMessage({ type: 'scc-welcome-font', text }),
        new Promise(res => setTimeout(() => res(null), 5000)),
      ]);
      if (!r || !r.ok) return;
      const bin = atob(r.b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const face = new FontFace('SCC Welcome', u8.buffer, { weight: '800' });
      await face.load();
      document.fonts.add(face);
    } catch (e) { /* останется системный шрифт */ }
  }

  /* ---------- вёрстка ---------- */

  const LOGO = (() => {
    /* [центр x, верх, низ, полуширина, «острота» кончиков] — по реальному логотипу, координаты в единицах viewBox */
    const B = [[70, 287, 403, 15.5, .17], [113, 248, 437, 16.5, .16], [157, 230, 452, 17.5, .15], [201, 230, 452, 17, .14],
      [246, 197, 455, 18.5, .12], [293, 175, 455, 18.5, .10], [341, 140, 455, 18.5, .08], [393, 125, 455, 18.5, .06],
      [447, 130, 455, 18.5, .06], [500, 85, 455, 20.5, .035]];
    const bars = B.map(([c, t, b, hv, f], i) => {
      const k = hv / 0.75, h = b - t, d = h * f;
      return `<path class="bar" style="--i:${i}" d="M${c} ${t} C${c + k} ${t + d} ${c + k} ${b - d} ${c} ${b} C${c - k} ${b - d} ${c - k} ${t + d} ${c} ${t}Z"/>`;
    }).join('');
    const cloud = '<path d="M537 70 A180.5 180.5 0 0 1 800 215 L800 227 A118 118 0 1 1 842 455 H552 Q537 455 537 440 Z"/>';
    return `<svg class="logo" viewBox="44 40 924 426" aria-hidden="true">
      <defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="48" x2="0" y2="457">
        <stop offset="0" stop-color="#ff9a14"/><stop offset=".55" stop-color="#ff6c00"/><stop offset="1" stop-color="#ff4d00"/></linearGradient></defs>
      <g fill="url(#g)">${bars}${cloud}</g></svg>`;
  })();

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; }
    .stage, .tour { font-family: "SCC Welcome", "Montserrat", "Poppins", "Segoe UI", system-ui, sans-serif; font-weight: 800; color: #fff; }

    /* ---- приветственный экран ---- */
    .stage { position: fixed; inset: 0; z-index: 2147483200; display: grid; place-items: center; cursor: pointer; overflow: hidden;
      user-select: none; -webkit-user-select: none; }
    .stage.out { pointer-events: none; }
    /* Размытие стоит на самом .stage-слое без opacity у предков (opacity ломала backdrop-filter на время анимации),
       поэтому страница размыта сразу. Плавно появляются только затемнение и содержимое. */
    .scrim { position: absolute; inset: 0; -webkit-backdrop-filter: blur(9px); backdrop-filter: blur(9px);
      transition: -webkit-backdrop-filter 1.9s ease, backdrop-filter 1.9s ease; }
    .scrim::before { content: ""; position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease;
      background:
        radial-gradient(120% 100% at 50% 46%, rgba(0,0,0,0) 34%, color-mix(in srgb, var(--accent) 38%, transparent) 72%, color-mix(in srgb, var(--accent) 62%, transparent) 100%),
        radial-gradient(90% 80% at 50% 50%, rgba(12,7,5,.52), rgba(12,7,5,.74)),
        linear-gradient(rgba(0,0,0,.4), rgba(0,0,0,.4)); }
    .stage.in .scrim::before { opacity: 1; }
    .stage.out .scrim { -webkit-backdrop-filter: blur(0); backdrop-filter: blur(0); }
    .stage.out .scrim::before { opacity: 0; transition: opacity 1.9s cubic-bezier(.45,0,.2,1); }
    .stage.out .col { opacity: 0; transition: opacity 1.9s cubic-bezier(.45,0,.2,1); }
    .col { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; }
    .top, .bot { display: flex; flex-direction: column; align-items: center; }
    .top > *, .bot > * { opacity: 0; transition: transform 1.3s cubic-bezier(.16,1,.3,1) var(--d, 0s), opacity 1s ease var(--d, 0s); }
    .top > * { transform: translateY(calc(var(--s) * -64px)); }
    .bot > * { transform: translateY(calc(var(--s) * 64px)); }
    .in .top > *, .in .bot > * { opacity: 1; transform: none; }

    .logo { width: calc(var(--s) * 310px); height: auto; display: block; overflow: visible; filter: drop-shadow(0 12px 34px color-mix(in srgb, var(--accent) 38%, transparent)); --d: .12s; }
    .bar { transform-box: fill-box; transform-origin: 50% 100%; transform: scaleY(.12); transition: transform 1s cubic-bezier(.2,1.25,.3,1) calc(var(--i) * 50ms + .55s); }
    .in .bar { transform: none; }
    .title { margin-top: calc(var(--s) * 24px); font-size: calc(var(--s) * 52px); line-height: 1.1; letter-spacing: -.012em; --d: .3s; text-shadow: 0 4px 30px rgba(0,0,0,.45); }
    .av { margin-top: calc(var(--s) * 58px); width: calc(var(--s) * 92px); height: calc(var(--s) * 92px); border-radius: 50%;
      background: rgba(255,255,255,.94) center / cover no-repeat; box-shadow: 0 10px 34px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.12); --d: .5s; }
    .name { margin-top: calc(var(--s) * 15px); font-size: calc(var(--s) * 23px); color: rgba(255,255,255,.88); max-width: 80vw; overflow-wrap: anywhere; --d: .62s; }
    .hint { margin-top: calc(var(--s) * 70px); font-size: calc(var(--s) * 17px); color: rgba(255,255,255,.8); font-weight: 700; --d: .95s; max-width: min(560px, 86vw); line-height: 1.5; font-size: calc(var(--s) * 15px); }
    .legal { margin-top: calc(var(--s) * 18px); font-size: calc(var(--s) * 11px); color: rgba(255,255,255,.5); max-width: min(520px, 86vw); line-height: 1.45; text-align: center; --d: 1.1s; }
    .in .hint { animation: breathe 2.8s ease-in-out 2.4s infinite; }
    @keyframes breathe { 0%, 100% { opacity: .95; } 50% { opacity: .65; } }

    /* ---- подсказка под панелью расширений ---- */
    .tour { position: fixed; top: 0; right: 0; z-index: 2147483200; width: min(620px, 100vw); height: 240px; pointer-events: none; opacity: 0; transition: opacity .7s ease; }
    .tour.on { opacity: 1; }
    .tour.off { opacity: 0; transition: opacity 1.1s ease; }
    .arrow { position: absolute; top: 8px; right: ${ARROW_CENTER - 22}px; width: 44px; height: 62px; overflow: visible; animation: bob 1.25s ease-in-out infinite; }
    .arrow path { fill: none; stroke: #fff; stroke-width: 4.5; stroke-linecap: round; stroke-linejoin: round; }
    @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
    .bubble { position: absolute; top: 80px; right: ${Math.max(16, ARROW_CENTER + 70 - BUBBLE_W)}px; max-width: calc(100vw - 32px); width: ${BUBBLE_W}px; padding: 15px 20px 16px; border-radius: 14px;
      background: rgba(20,16,15,.94); border: 1px solid rgba(255,255,255,.1); box-shadow: 0 10px 30px rgba(0,0,0,.35);
      font-size: 20px; line-height: 1.38; text-align: left; }
    .ghost { visibility: hidden; display: block; }
    .live { position: absolute; left: 20px; right: 20px; top: 15px; display: block; }
    .caret { display: inline-block; width: 2.5px; height: 1.05em; margin-left: 2px; vertical-align: -.17em; background: #fff; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }

    @media (prefers-reduced-motion: reduce) {
      .scrim, .scrim::before, .stage.out .col, .top > *, .bot > *, .bar, .tour, .tour.off { transition-duration: .01ms !important; transition-delay: 0s !important; }
      .arrow, .in .hint, .caret { animation: none !important; }
    }
  `;

  function fitScale() {
    if (!host) return;
    const s = Math.max(.55, Math.min(1.2, Math.min(innerWidth / 1500, innerHeight / 900)));
    host.style.setProperty('--s', s.toFixed(3));
  }

  function ensureHost() {
    const old = document.getElementById(HOST_ID);
    if (old) old.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-scc-own', '');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483200;';
    host.style.setProperty('--accent', accent);
    root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    root.append(st);
    document.documentElement.appendChild(host);
    fitScale();
    window.addEventListener('resize', fitScale);
  }

  function cleanup() {
    typingToken++;
    timers.forEach(clearTimeout); timers = [];
    window.removeEventListener('resize', fitScale);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onAnyPointer, true);
    if (host) host.remove();
    host = root = stage = tour = null;
    phase = 'idle';
  }

  /* ---------- сценарий ---------- */

  async function show() {
    if (phase !== 'idle') cleanup();
    phase = 'loading';
    const text = TITLE + CONTINUE + TOUR + CREDIT + LEGAL;
    await loadFont(text);
    if (phase !== 'loading' || !alive()) return;

    ensureHost();
    stage = document.createElement('div');
    stage.className = 'stage';
    stage.setAttribute('role', 'dialog');
    stage.setAttribute('aria-label', 'Добро пожаловать в Customizer for SoundCloud');
    setHTML(stage, `<div class="scrim"></div>
      <div class="col">
        <div class="top">${LOGO}<div class="title"></div></div>
        <div class="bot"><div class="av"></div><div class="name"></div><div class="hint"></div><div class="legal"></div></div>
      </div>`);
    stage.querySelector('.title').textContent = TITLE;
    stage.querySelector('.hint').textContent = CONTINUE;
    stage.querySelector('.legal').textContent = LEGAL;
    const nameEl = stage.querySelector('.name');
    nameEl.textContent = CREDIT;
    stage.addEventListener('click', dismissWelcome);
    stage.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    root.append(stage);
    phase = 'welcome';
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => requestAnimationFrame(() => { if (stage && phase === 'welcome') stage.classList.add('in'); }));
  }

  function onKey(e) {
    if (phase === 'welcome' && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); e.stopPropagation(); dismissWelcome();
    } else if (phase === 'tour' && e.key === 'Escape') endTour();
  }

  function dismissWelcome() {
    if (phase !== 'welcome') return;
    phase = 'leaving';
    document.removeEventListener('keydown', onKey, true);
    stage.classList.add('out');
    try { browser.storage.local.set({ welcomeSeen: true }); } catch (e) { /* ignore */ }
    sleep(1900).then(() => { if (phase === 'leaving') phase = 'idle'; });
    sleep(2100).then(() => { if (stage) { stage.remove(); stage = null; } });
  }

  async function runTour() {
    if (!root) return;
    phase = 'tour';
    tour = document.createElement('div');
    tour.className = 'tour';
    setHTML(tour, `<svg class="arrow" viewBox="0 0 44 62" aria-hidden="true"><path d="M22 58 V9 M7 25 L22 8 L37 25"/></svg>
      <div class="bubble"><span class="ghost"></span><span class="live"><span class="typed"></span><i class="caret"></i></span></div>`);
    tour.querySelector('.ghost').textContent = TOUR;
    root.append(tour);
    const typed = tour.querySelector('.typed');
    const token = ++typingToken;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onAnyPointer, true);
    requestAnimationFrame(() => requestAnimationFrame(() => tour && tour.classList.add('on')));
    await sleep(650);
    for (let i = 1; i <= TOUR.length; i++) {
      if (token !== typingToken || phase !== 'tour') return;
      typed.textContent = TOUR.slice(0, i);
      const ch = TOUR[i - 1];
      await sleep(ch === ',' ? 260 : ch === ' ' ? 55 : 34 + Math.random() * 34);
    }
    await sleep(12000);
    if (token === typingToken && phase === 'tour') endTour();
  }

  function onAnyPointer() { if (phase === 'tour') endTour(); }

  function endTour() {
    if (phase !== 'tour') return;
    phase = 'ending';
    typingToken++;
    document.removeEventListener('pointerdown', onAnyPointer, true);
    document.removeEventListener('keydown', onKey, true);
    if (tour) tour.classList.add('off');
    setTimeout(() => { if (phase === 'ending') cleanup(); }, 1300);
  }

  /* ---------- запуск ---------- */

  function readAccent(s) {
    const a = s && s.colors && s.colors.accent;
    accent = HEX.test(a || '') ? a : '#ff5500';
  }

  try {
    /* клик по значку расширения = подсказка выполнила задачу (ответа не даём: отвечает overlay.js) */
    browser.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'scc-toggle-settings' && (phase === 'tour' || phase === 'welcome')) {
        if (phase === 'welcome') { try { browser.storage.local.set({ welcomeSeen: true }); } catch (e) { /* ignore */ } cleanup(); } else endTour();
      }
    });
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.settings) { readAccent(ch.settings.newValue); if (host) host.style.setProperty('--accent', accent); }
      /* приветствие уже закрыли в другой вкладке — тихо убираем своё */
      if (ch.welcomeSeen && ch.welcomeSeen.newValue === true && (phase === 'welcome' || phase === 'loading')) cleanup();
    });
    window.addEventListener('scc-show-welcome', () => { cleanup(); show(); });
    browser.storage.local.get(['welcomeSeen', 'settings']).then((st) => {
      readAccent(st.settings);
      if (!st.welcomeSeen) show();
    }).catch(() => {});
  } catch (e) { /* расширение перезагружено */ }
})();
