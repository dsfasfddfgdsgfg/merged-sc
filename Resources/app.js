/* Интерфейс приложения (изолированный мир, только верхняя страница):
   1) круглая кнопка меню; 2) меню-шторка; 3) плеер на весь экран как «Full App Display» в Spicetify
   (слева обложка, справа текст и управление; на вертикальном экране — столбцом; фон — размытая затемнённая обложка с плавной сменой);
   4) фон приложения под цвет обложки. Всё в Shadow DOM с data-scc-own — «Свой CSS» этого не касается. */
(() => {
  'use strict';
  if (window !== window.top || window.__sccAppUi) return;
  window.__sccAppUi = true;

  const HEX = /^#[0-9a-fA-F]{6}$/;
  const ORIGIN = location.origin && location.origin !== 'null' ? location.origin : '*';
  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const setHTML = (el, html) => {
    const d = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
    el.replaceChildren(...Array.from(d.body.childNodes).map((n) => document.importNode(n, true)));
  };
  const send = (action, extra) => { try { browser.runtime.sendMessage(Object.assign({ type: 'scc-ui', action }, extra || {})); } catch (e) { /* ignore */ } };
  const haptic = () => send('haptic');
  const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  const safeUrl = (u) => (/^https:\/\/[^\s"'()\\]+$/.test(u || '') ? u : '');

  const APPDEF = { tapOpen: true, tapSel: '', coverBg: false, cbBright: 55, cbBlur: 3, cbSpeed: 45, cbSat: 150, fpBlur: 30, fpDim: 45, fpLayout: 'auto' };
  let cfg = Object.assign({}, APPDEF);
  let settings = null, eqOn = false, fabPos = { side: 'r', y: 0.7 };

  /* ---------- тема из настроек расширения ---------- */
  const hexLum = (h) => { const n = parseInt(h.slice(1), 16); return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255; };
  function theme() {
    let c = {}, on = true;
    try { const m = SCC.merge(SCC.DEFAULTS, settings || {}); c = (m && m.colors) || {}; on = !m || m.enabled !== false; } catch (e) { /* ignore */ }
    const pick = (k, d) => (on && HEX.test(c[k] || '') ? c[k] : d);
    const surface = pick('surfaceBg', '#1c1c1e');
    const light = hexLum(surface) > 0.6;
    let ff = ''; try { ff = getComputedStyle(document.body).fontFamily; } catch (e) { /* ignore */ }
    return { accent: pick('accent', '#ff5500'), onAcc: hexLum(pick('accent', '#ff5500')) > 0.5 ? '#1a1206' : '#ffffff',
      page: pick('pageBg', '#121212'), surface, light, ff,
      fg: light ? '#16161a' : '#f4f4f6', fg2: light ? 'rgba(22,22,26,.62)' : 'rgba(244,244,246,.64)', line: light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.12)',
      glass: light ? 'rgba(255,255,255,.86)' : 'rgba(26,24,24,.84)' };
  }
  const hosts = [];
  function paintTheme() {
    const t = theme();
    for (const h of hosts) {
      const s = h.style;
      s.setProperty('--accent', t.accent); s.setProperty('--on-accent', t.onAcc); s.setProperty('--fg', t.fg); s.setProperty('--fg2', t.fg2);
      s.setProperty('--line', t.line); s.setProperty('--glass', t.glass); if (t.ff) s.setProperty('--ff', t.ff);
    }
    if (cbHost) cbHost.style.background = t.page;
  }
  function makeHost(id, css, html, z) {
    const host = document.createElement('div');
    host.id = id; host.setAttribute('data-scc-own', '1');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:' + z + ';';
    const root = host.attachShadow({ mode: 'open' });
    setHTML(root, '<style>:host{all:initial}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}button{all:unset;box-sizing:border-box;cursor:pointer}' + css + '</style>' + html);
    hosts.push(host);
    (document.body || document.documentElement).appendChild(host);
    paintTheme();
    return { host, root };
  }
  const ICO = {
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    eq: '<path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="14" r="2.4" fill="currentColor"/><circle cx="12" cy="8" r="2.4" fill="currentColor"/><circle cx="19" cy="15" r="2.4" fill="currentColor"/>',
    play: '<path d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.6-6.8a.6.6 0 0 0 0-1L8.92 4.7A.6.6 0 0 0 8 5.2z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
    next: '<path d="M6 6l9 6-9 6z" fill="currentColor" stroke="none"/><path d="M18 5.5v13"/>',
    prev: '<path d="M18 6l-9 6 9 6z" fill="currentColor" stroke="none"/><path d="M6 5.5v13"/>',
    down: '<path d="M5 9l7 7 7-7"/>', heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    wave: '<path d="M3 12c3-6 5-6 7 0s4 6 7 0 3-4 4-2"/>', pick: '<path d="M5 4l5 15 2.2-6.2L18.5 11z"/>',
    back: '<path d="M15 5l-7 7 7 7"/>', fwd: '<path d="M9 5l7 7-7 7"/>', reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  };
  const svg = (k, w) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICO[k] + '</svg>';

  /* ---------- что играет (мир страницы → сюда) ---------- */
  let np = null, npTimer = 0, npRate = 0, npSeq = 0;
  const npListeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__scc !== 'np-state' || !e.data.s) return;
    np = e.data.s; npSeq++;
    for (const fn of Array.from(npListeners)) { try { fn(np); } catch (err) { /* ignore */ } }
  });
  const npAsk = () => window.postMessage({ __scc: 'np', op: 'get' }, ORIGIN);
  const npCmd = (cmd, value) => { window.postMessage({ __scc: 'np', op: 'cmd', cmd, value }, ORIGIN); setTimeout(npAsk, 120); };
  function npPoll() {
    const want = playerOpen ? 500 : menuOpen ? 800 : cfg.coverBg ? 1500 : 0;
    if (want === npRate) return;
    npRate = want; clearInterval(npTimer); npTimer = 0;
    if (want) { npAsk(); npTimer = setInterval(() => { if (!document.hidden) npAsk(); }, want); }
  }
  function artUrl(s) {
    if (!s || !s.art || !s.art.length) return '';
    let best = s.art[s.art.length - 1], bw = 0;
    for (const a of s.art) { const w = parseInt(a.sizes, 10) || 0; if (w >= bw) { bw = w; best = a; } }
    let u = safeUrl(best.src);
    u = u.replace(/-(?:large|badge|small|tiny|crop|t\d+x\d+|original)\./, '-t500x500.');
    return u;
  }

  /* ---------- кнопка меню ---------- */
  let fab = null, menuOpen = false, playerOpen = false, idleT = 0;
  const FAB_CSS = `
    .f{position:fixed;width:48px;height:48px;border-radius:50%;display:grid;place-items:center;color:var(--fg);
      background:var(--glass);border:1px solid var(--line);-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);
      box-shadow:0 6px 22px rgba(0,0,0,.4),0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent);touch-action:none;user-select:none;-webkit-user-select:none;
      transition:opacity .35s,transform .2s,left .28s cubic-bezier(.2,.9,.3,1),top .05s;opacity:.95}
    .f.idle{opacity:.5}.f.drag{transition:none;transform:scale(1.08)}.f.hide{opacity:0;pointer-events:none;transform:scale(.6)}
    .f svg{width:23px;height:23px;color:var(--accent)}
    .f::after{content:"";position:absolute;inset:-1px;border-radius:50%;border:2px solid var(--accent);opacity:0;animation:pulse 2.4s ease-out 1.2s 3}
    @keyframes pulse{0%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(1.6)}}`;
  function fabPlace() {
    if (!fab) return;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, m = 10, sz = 48;
    const x = fabPos.side === 'l' ? m : vw - sz - m;
    const y = Math.max(60, Math.min(vh - sz - 90, fabPos.y * vh));
    fab.el.style.left = x + 'px'; fab.el.style.top = y + 'px';
  }
  function makeFab() {
    const r = makeHost('scc-fab', FAB_CSS, '<button class="f" type="button" aria-label="Меню" aria-haspopup="dialog">' + svg('sliders', 2) + '</button>', 2147483000);
    fab = { host: r.host, el: r.root.querySelector('.f') };
    fabPlace();
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, down = false;
    const wake = () => { fab.el.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => fab && fab.el.classList.add('idle'), 3500); };
    wake();
    fab.el.addEventListener('pointerdown', (e) => {
      down = true; moved = false; sx = e.clientX; sy = e.clientY;
      const b = fab.el.getBoundingClientRect(); ox = b.left; oy = b.top;
      try { fab.el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      wake();
    });
    fab.el.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) { moved = true; fab.el.classList.add('drag'); }
      if (moved) { fab.el.style.left = (ox + e.clientX - sx) + 'px'; fab.el.style.top = (oy + e.clientY - sy) + 'px'; }
    });
    const end = (e) => {
      if (!down) return; down = false; fab.el.classList.remove('drag');
      if (moved) {
        const b = fab.el.getBoundingClientRect(), vw = document.documentElement.clientWidth;
        fabPos = { side: b.left + 24 < vw / 2 ? 'l' : 'r', y: Math.max(0.08, Math.min(0.9, b.top / window.innerHeight)) };
        fabPlace(); try { browser.storage.local.set({ appFab: fabPos }); } catch (err) { /* ignore */ }
      } else if (e.type === 'pointerup') { haptic(); openMenu(); }
      wake();
    };
    fab.el.addEventListener('pointerup', end); fab.el.addEventListener('pointercancel', end);
    window.addEventListener('resize', fabPlace);
    window.addEventListener('orientationchange', () => setTimeout(fabPlace, 300));
  }
  const fabVis = () => { if (fab) fab.el.classList.toggle('hide', menuOpen || playerOpen); };

  /* ---------- меню ---------- */
  let menu = null;
  const MENU_CSS = `
    .bd{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;visibility:hidden;transition:opacity .28s,visibility 0s .28s}
    .bd.on{opacity:1;visibility:visible;transition:opacity .28s}
    .sh{position:fixed;left:50%;bottom:0;width:min(560px,100vw);max-height:88vh;overflow-y:auto;overscroll-behavior:contain;transform:translate(-50%,105%);
      padding:10px 14px calc(14px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;color:var(--fg);font:15px/1.4 var(--ff,-apple-system,system-ui,sans-serif);
      background:var(--glass);border:1px solid var(--line);border-bottom:0;-webkit-backdrop-filter:blur(26px) saturate(1.6);backdrop-filter:blur(26px) saturate(1.6);
      box-shadow:0 -12px 40px rgba(0,0,0,.45);transition:transform .38s cubic-bezier(.2,.9,.25,1)}
    .sh.on{transform:translate(-50%,0)}
    .gr{width:40px;height:5px;border-radius:3px;background:var(--line);margin:2px auto 12px}
    .np{display:flex;align-items:center;gap:12px;padding:10px;border-radius:16px;background:color-mix(in srgb,var(--fg) 7%,transparent);margin-bottom:10px;cursor:pointer}
    .np .cv{width:54px;height:54px;border-radius:10px;flex:none;background:color-mix(in srgb,var(--accent) 35%,#222) center/cover}
    .np .tx{min-width:0;flex:1}.np .t{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.np .a{font-size:13px;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .np .go{width:36px;height:36px;display:grid;place-items:center;color:var(--accent)}.np svg{width:22px;height:22px}
    .it{display:flex;align-items:center;gap:14px;width:100%;padding:13px 10px;border-radius:14px;color:var(--fg);transition:background .15s}
    .it:active{background:color-mix(in srgb,var(--accent) 18%,transparent)}
    .it .ic{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex:none;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
    .it .ic svg{width:21px;height:21px}.it .lb{flex:1;min-width:0}.it .n{font-weight:600}.it .d{font-size:12.5px;color:var(--fg2)}
    .sw{width:50px;height:30px;border-radius:99px;background:color-mix(in srgb,var(--fg) 22%,transparent);position:relative;flex:none;transition:background .25s}
    .sw::before{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35);transition:transform .3s cubic-bezier(.3,1.5,.5,1)}
    .sw.on{background:var(--accent)}.sw.on::before{transform:translateX(20px)}
    .nav{display:flex;gap:8px;margin-top:8px}.nav button{flex:1;height:46px;border-radius:14px;display:grid;place-items:center;background:color-mix(in srgb,var(--fg) 7%,transparent);color:var(--fg)}
    .nav button:active{background:color-mix(in srgb,var(--accent) 20%,transparent)}.nav svg{width:22px;height:22px}`;
  function makeMenu() {
    const items = [
      ['player', 'full', 'Плеер на весь экран', 'Обложка, управление и эквалайзер'],
      ['eq', 'eq', 'Эквалайзер', ''], ['settings', 'gear', 'Настройки', 'Оформление, цвета, шрифт, фон, приложение'],
      ['cbg', 'wave', 'Фон под обложку', 'Фон переливается цветами обложки'], ['pick', 'pick', 'Выбрать элемент', 'Селектор для «Свой CSS»'],
    ];
    const rows = items.map(([id, ic, n, d]) => '<button class="it" type="button" data-id="' + id + '"><span class="ic">' + svg(ic) + '</span><span class="lb"><div class="n">' + n +
      '</div><div class="d">' + d + '</div></span>' + (id === 'cbg' ? '<span class="sw"></span>' : '') + '</button>').join('');
    const r = makeHost('scc-menu', MENU_CSS, '<div class="bd"></div><div class="sh" role="dialog" aria-label="Меню"><div class="gr"></div>' +
      '<div class="np" data-id="player"><div class="cv"></div><div class="tx"><div class="t">Ничего не играет</div><div class="a"></div></div></div>' + rows +
      '<div class="nav"><button type="button" data-id="back" aria-label="Назад">' + svg('back') + '</button><button type="button" data-id="reload" aria-label="Обновить">' + svg('reload') +
      '</button><button type="button" data-id="fwd" aria-label="Вперёд">' + svg('fwd') + '</button></div></div>', 2147483300);
    const root = r.root;
    menu = { host: r.host, bd: root.querySelector('.bd'), sh: root.querySelector('.sh'), cv: root.querySelector('.cv'), t: root.querySelector('.np .t'), a: root.querySelector('.np .a'),
      sw: root.querySelector('.sw'), eqd: root.querySelector('[data-id=eq] .d') };
    menu.bd.addEventListener('click', closeMenu);
    root.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-id]'); if (!b) return;
      const id = b.getAttribute('data-id'); haptic();
      if (id === 'cbg') { cfg.coverBg = !cfg.coverBg; saveCfg(); paintMenu(); applyCb(); return; }
      closeMenu();
      setTimeout(() => {
        if (id === 'player') openPlayer(); else if (id === 'eq') window.dispatchEvent(new CustomEvent('scc-eq-toggle', { detail: { open: true } }));
        else if (id === 'settings') send('open-settings'); else if (id === 'pick') send('pick-here');
        else send(id);   // back | fwd | reload
      }, 260);
    });
    let sy = 0, dy = 0, drag = false;
    menu.sh.addEventListener('touchstart', (e) => { if (menu.sh.scrollTop <= 0) { drag = true; sy = e.touches[0].clientY; dy = 0; menu.sh.style.transition = 'none'; } }, { passive: true });
    menu.sh.addEventListener('touchmove', (e) => { if (!drag) return; dy = Math.max(0, e.touches[0].clientY - sy); menu.sh.style.transform = 'translate(-50%,' + dy + 'px)'; }, { passive: true });
    const te = () => { if (!drag) return; drag = false; menu.sh.style.transition = ''; menu.sh.style.transform = ''; if (dy > 90) closeMenu(); };
    menu.sh.addEventListener('touchend', te); menu.sh.addEventListener('touchcancel', te);
  }
  function paintMenu() {
    if (!menu) return;
    menu.sw.classList.toggle('on', !!cfg.coverBg);
    menu.eqd.textContent = eqOn ? 'Включён' : 'Выключен';
    const u = artUrl(np);
    menu.cv.style.backgroundImage = u ? 'url("' + u + '")' : '';
    menu.t.textContent = np && np.title ? np.title : 'Ничего не играет';
    menu.a.textContent = np && np.artist ? np.artist : 'Нажмите, чтобы открыть плеер';
  }
  function openMenu() {
    if (menuOpen || playerOpen) return;
    if (!menu) makeMenu();
    menuOpen = true; paintTheme(); paintMenu(); fabVis(); npPoll();
    npListeners.add(paintMenu);
    requestAnimationFrame(() => requestAnimationFrame(() => { if (menuOpen) { menu.bd.classList.add('on'); menu.sh.classList.add('on'); } }));
  }
  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false; npListeners.delete(paintMenu);
    menu.bd.classList.remove('on'); menu.sh.classList.remove('on'); fabVis(); npPoll();
  }

  /* ---------- плеер на весь экран (Full App Display) ---------- */
  let fp = null, dragSeek = -1;
  const FP_CSS = `
    .fp{position:fixed;inset:0;color:#fff;font-family:var(--ff,-apple-system,system-ui,sans-serif);overflow:hidden;background:#000;touch-action:none;
      transform:translateY(100%);visibility:hidden;transition:transform .42s cubic-bezier(.2,.9,.25,1),visibility 0s .42s;
      padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);display:flex;flex-direction:column}
    .fp.on{transform:none;visibility:visible;transition:transform .42s cubic-bezier(.2,.9,.25,1)}
    .bg{position:absolute;inset:0;overflow:hidden}
    .bgi{position:absolute;inset:-12%;background:center/cover no-repeat;filter:blur(var(--fpblur,30px)) brightness(var(--fpdim,.45)) saturate(1.25);opacity:0;transition:opacity 1s ease;transform:scale(1.08)}
    .bgi.on{opacity:1}
    .bar{position:relative;display:flex;align-items:center;justify-content:space-between;padding:10px 12px 0;flex:none}
    .ib{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;color:#fff;background:rgba(255,255,255,.12);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
    .ib:active{background:rgba(255,255,255,.24)}.ib svg{width:24px;height:24px}.ib.eq.live{color:var(--accent)}
    .hd{font-size:11.5px;font-weight:700;letter-spacing:.14em;opacity:.7}
    .main{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:clamp(14px,3vh,28px);padding:8px clamp(20px,6vw,40px) 18px}
    .art{position:relative;align-self:center;width:min(86vw,44vh);aspect-ratio:1;border-radius:14px;overflow:hidden;flex:none;box-shadow:0 22px 60px rgba(0,0,0,.55);background:color-mix(in srgb,var(--accent) 30%,#1a1a1a)}
    .arti{position:absolute;inset:0;background:center/cover no-repeat;opacity:0;transition:opacity .7s ease}.arti.on{opacity:1}
    .art.bump{animation:bump .5s cubic-bezier(.3,1.4,.5,1)}@keyframes bump{from{transform:scale(.94)}to{transform:none}}
    .info{display:flex;flex-direction:column;gap:clamp(12px,2.4vh,22px);min-width:0}
    .t{font-size:clamp(24px,7vw,46px);line-height:1.12;font-weight:800;letter-spacing:-.01em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
    .a{font-size:clamp(16px,4.4vw,24px);font-weight:600;opacity:.82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .al{font-size:14px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pr{display:flex;align-items:center;gap:10px;font-size:12.5px;font-variant-numeric:tabular-nums;opacity:.9}
    .tr{position:relative;flex:1;height:30px;display:flex;align-items:center;touch-action:none}
    .tr::before{content:"";position:absolute;left:0;right:0;height:5px;border-radius:3px;background:rgba(255,255,255,.22)}
    .fl{position:absolute;left:0;height:5px;border-radius:3px;background:#fff;width:0}
    .kn{position:absolute;left:0;width:15px;height:15px;margin-left:-7px;border-radius:50%;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.5);transform:scale(.85);transition:transform .15s}
    .tr.d .kn{transform:scale(1.35)}.tr.d .fl{background:var(--accent)}
    .ct{display:flex;align-items:center;justify-content:space-between;gap:6px}
    .cb{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;color:#fff;flex:none;transition:transform .15s,background .2s}
    .cb:active{transform:scale(.88);background:rgba(255,255,255,.14)}.cb svg{width:30px;height:30px}
    .cb.big{width:76px;height:76px;background:#fff;color:#111}.cb.big svg{width:38px;height:38px}.cb.big:active{background:#e6e6e6}
    .cb.sm svg{width:26px;height:26px;opacity:.85}.cb.like.on{color:var(--accent)}.cb.like.on svg{fill:var(--accent)}.cb[hidden]{visibility:hidden;display:grid}
    @media (min-aspect-ratio:1/1){
      .fp:not([data-lay=stack]) .main{flex-direction:row;align-items:center;justify-content:center;gap:clamp(24px,6vw,72px)}
      .fp:not([data-lay=stack]) .art{width:min(44vw,calc(100vh - 120px - env(safe-area-inset-top) - env(safe-area-inset-bottom)))}
      .fp:not([data-lay=stack]) .info{flex:1;max-width:560px}.fp:not([data-lay=stack]) .t{font-size:clamp(26px,4.2vw,52px)}
    }
    .fp[data-lay=side] .main{flex-direction:row;align-items:center;justify-content:center;gap:5vw}
    .fp[data-lay=side] .art{width:min(42vw,calc(100vh - 120px))}.fp[data-lay=side] .info{flex:1}
    @media (max-height:430px){.cb.big{width:62px;height:62px}.cb{width:46px;height:46px}.hd{display:none}}`;
  const FP_HTML = '<div class="fp" role="dialog" aria-label="Сейчас играет"><div class="bg"><div class="bgi"></div><div class="bgi"></div></div>' +
    '<div class="bar"><button class="ib" type="button" data-a="close" aria-label="Свернуть">' + svg('down', 2.4) + '</button><div class="hd">СЕЙЧАС ИГРАЕТ</div>' +
    '<button class="ib eq" type="button" data-a="eq" data-scc-eq-keep aria-label="Эквалайзер">' + svg('eq') + '</button></div>' +
    '<div class="main"><div class="art"><div class="arti"></div><div class="arti"></div></div><div class="info"><div><div class="t">—</div><div class="a"></div><div class="al"></div></div>' +
    '<div class="pr"><span class="cur">0:00</span><div class="tr"><div class="fl"></div><div class="kn"></div></div><span class="dur">0:00</span></div>' +
    '<div class="ct"><button class="cb sm like" type="button" data-a="like" aria-label="Нравится">' + svg('heart') + '</button>' +
    '<button class="cb" type="button" data-a="prev" aria-label="Предыдущий">' + svg('prev') + '</button>' +
    '<button class="cb big" type="button" data-a="toggle" aria-label="Играть/пауза"><span class="pp">' + svg('play') + '</span></button>' +
    '<button class="cb" type="button" data-a="next" aria-label="Следующий">' + svg('next') + '</button>' +
    '<button class="cb sm" type="button" data-a="eq" data-scc-eq-keep aria-label="Эквалайзер">' + svg('eq') + '</button></div></div></div></div>';
  let fpArt = '', fpFlip = 0, fpArtFlip = 0, fpPlaying = null;
  function makeFp() {
    const r = makeHost('scc-player', FP_CSS, FP_HTML, 2147483500);
    const q = (s) => r.root.querySelector(s);
    fp = { host: r.host, el: q('.fp'), bgs: Array.from(r.root.querySelectorAll('.bgi')), arts: Array.from(r.root.querySelectorAll('.arti')), art: q('.art'),
      t: q('.t'), a: q('.a'), al: q('.al'), cur: q('.cur'), dur: q('.dur'), tr: q('.tr'), fl: q('.fl'), kn: q('.kn'), pp: q('.pp'), like: q('.like'), eqb: q('.ib.eq') };
    r.root.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-a]'); if (!b) return;
      const a = b.getAttribute('data-a'); haptic();
      if (a === 'close') closePlayer();
      else if (a === 'eq') window.dispatchEvent(new CustomEvent('scc-eq-toggle'));
      else npCmd(a);
    });
    const frac = (e) => { const b = fp.tr.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)); };
    fp.tr.addEventListener('pointerdown', (e) => { if (!np || !np.duration) return; try { fp.tr.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } fp.tr.classList.add('d'); dragSeek = frac(e); drawProgress(); });
    fp.tr.addEventListener('pointermove', (e) => { if (dragSeek >= 0) { dragSeek = frac(e); drawProgress(); } });
    const up = () => { if (dragSeek < 0) return; const f = dragSeek; dragSeek = -1; fp.tr.classList.remove('d'); if (np && np.duration) npCmd('seek', f * np.duration); };
    fp.tr.addEventListener('pointerup', up); fp.tr.addEventListener('pointercancel', up);
    // смахнуть вниз — свернуть
    let sy = 0, dy = 0, drag = false;
    const bar = q('.bar'), hit = [bar, fp.art];
    hit.forEach((n) => {
      n.addEventListener('touchstart', (e) => { drag = true; sy = e.touches[0].clientY; dy = 0; fp.el.style.transition = 'none'; }, { passive: true });
      n.addEventListener('touchmove', (e) => { if (!drag) return; dy = Math.max(0, e.touches[0].clientY - sy); fp.el.style.transform = 'translateY(' + dy + 'px)'; }, { passive: true });
      const end = () => { if (!drag) return; drag = false; fp.el.style.transition = ''; fp.el.style.transform = ''; if (dy > 110) closePlayer(); };
      n.addEventListener('touchend', end); n.addEventListener('touchcancel', end);
    });
  }
  function drawProgress() {
    if (!fp || !np) return;
    const dur = np.duration || 0;
    const f = dragSeek >= 0 ? dragSeek : (dur ? Math.min(1, np.position / dur) : 0);
    fp.fl.style.width = f * 100 + '%'; fp.kn.style.left = f * 100 + '%';
    fp.cur.textContent = fmt(dragSeek >= 0 ? dragSeek * dur : np.position); fp.dur.textContent = fmt(dur);
  }
  function setLayers(layers, url, flipKey) {
    const idx = flipKey === 'bg' ? (fpFlip ^= 1) : (fpArtFlip ^= 1);
    const nx = layers[idx], old = layers[idx ^ 1];
    nx.style.backgroundImage = url ? 'url("' + url + '")' : '';
    nx.classList.toggle('on', !!url); old.classList.remove('on');
  }
  function paintPlayer() {
    if (!fp || !np) return;
    fp.t.textContent = np.title || 'Ничего не играет';
    fp.a.textContent = np.artist || ''; fp.al.textContent = np.album || '';
    const u = artUrl(np);
    if (u !== fpArt) {
      fpArt = u;
      const im = new Image(); im.decoding = 'async';
      const apply = () => { if (u !== fpArt) return; setLayers(fp.bgs, u, 'bg'); setLayers(fp.arts, u, 'art'); fp.art.classList.remove('bump'); void fp.art.offsetWidth; fp.art.classList.add('bump'); };
      im.onload = apply; im.onerror = () => { if (u === fpArt) { setLayers(fp.bgs, '', 'bg'); setLayers(fp.arts, '', 'art'); } };
      im.src = u || '';
      if (!u) apply();
    }
    if (fpPlaying !== np.playing) { fpPlaying = np.playing; setHTML(fp.pp, svg(np.playing ? 'pause' : 'play')); }
    fp.like.hidden = !np.like || !np.like.has; fp.like.classList.toggle('on', !!(np.like && np.like.on));
    drawProgress();
  }
  function openPlayer() {
    if (playerOpen) return;
    closeMenu();
    if (!fp) makeFp();
    playerOpen = true; paintTheme(); fabVis(); applyCb(); npPoll();
    fp.el.setAttribute('data-lay', cfg.fpLayout || 'auto');
    fp.el.style.setProperty('--fpblur', (Number(cfg.fpBlur) || 0) + 'px'); fp.el.style.setProperty('--fpdim', (Number(cfg.fpDim) || 45) / 100);
    fp.eqb.classList.toggle('live', eqOn);
    npListeners.add(paintPlayer); fpArt = '\u0000'; fpPlaying = null; paintPlayer();
    requestAnimationFrame(() => requestAnimationFrame(() => { if (playerOpen) fp.el.classList.add('on'); }));
    document.addEventListener('keydown', onKey, true);
  }
  function closePlayer() {
    if (!playerOpen) return;
    playerOpen = false; npListeners.delete(paintPlayer);
    window.dispatchEvent(new CustomEvent('scc-eq-close'));
    fp.el.classList.remove('on'); fabVis(); applyCb(); npPoll();
    document.removeEventListener('keydown', onKey, true);
  }
  const onKey = (e) => { if (e.key === 'Escape') closePlayer(); };

  /* нажатие на трек в мини-плеере SoundCloud открывает наш плеер */
  const BADGE = '.playbackSoundBadge, .playControls__soundBadge, [class*="playbackSoundBadge"]';
  document.addEventListener('click', (e) => {
    if (!cfg.tapOpen || playerOpen) return;
    const t = e.target; if (!(t instanceof Element)) return;
    let sel = BADGE;
    if (cfg.tapSel) { try { document.querySelector(cfg.tapSel); sel += ',' + cfg.tapSel; } catch (err) { /* плохой селектор */ } }
    let hit = null; try { hit = t.closest(sel); } catch (err) { return; }
    if (!hit) return;
    const EX = 'button,[role="button"],input,.sc-button,[class*="like" i],[class*="queue" i],[class*="Control" i]:not(.playControls)';
    for (let n = t; n && n !== hit.parentElement; n = n.parentElement) { try { if (n.matches(EX)) return; } catch (err) { /* ignore */ } }
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    haptic(); openPlayer();
  }, true);

  /* ---------- фон под обложку ---------- */
  let cbHost = null, cbRoot = null, cbSlot = 0, cbUrl = '';
  const CB_CSS = `
    .w{position:absolute;inset:0;overflow:hidden}
    .s{position:absolute;inset:0;opacity:0;transition:opacity 1.8s ease}.s.on{opacity:1}
    .c{position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px 0 0 -24px;will-change:transform;
      filter:blur(var(--bl,3px)) saturate(var(--sat,1.5));transform:rotate(0) scale(var(--k,20))}
    .c1{animation:a1 var(--d1,120s) linear infinite}.c2{opacity:.6;animation:a2 var(--d2,160s) linear infinite}
    @keyframes a1{from{transform:rotate(0) scale(var(--k,20))}to{transform:rotate(360deg) scale(var(--k,20))}}
    @keyframes a2{from{transform:rotate(200deg) translate(14%,8%) scale(var(--k,20))}to{transform:rotate(-160deg) translate(14%,8%) scale(var(--k,20))}}
    .w.p .c{animation-play-state:paused}.sh{position:absolute;inset:0;background:#000;opacity:var(--sh,.45)}
    @media (prefers-reduced-motion:reduce){.c{animation:none!important}}`;
  const WRAP = '#app,#content,.l-container,.l-content,.l-main,.l-listen-wrapper,.l-fluid-fixed,.l-two-column-fixed';
  function cbStyle() {
    if (document.getElementById('scc-cb-style')) return;
    const st = document.createElement('style'); st.id = 'scc-cb-style'; st.setAttribute('data-scc-own', '1');
    st.textContent = 'html.scc-cb,html.scc-cb body,' + WRAP.split(',').map((s) => 'html.scc-cb ' + s).join(',') + '{background-color:transparent!important;background-image:none!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  function cbLayout() {
    if (!cbHost) return;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, S = Math.max(vw, vh) * 1.3;
    const s = cbHost.style;
    s.setProperty('--k', (S / 48).toFixed(2));
    s.setProperty('--bl', (Number(cfg.cbBlur) || 3) + 'px'); s.setProperty('--sat', (Number(cfg.cbSat) || 150) / 100);
    s.setProperty('--sh', (1 - (Number(cfg.cbBright) || 55) / 100).toFixed(2));
    const sp = Math.max(0, Math.min(100, Number(cfg.cbSpeed))) / 100, d1 = 260 - sp * 215;
    s.setProperty('--d1', d1.toFixed(0) + 's'); s.setProperty('--d2', (d1 * 1.4).toFixed(0) + 's');
  }
  function cbPaint(url) {
    if (!cbRoot || !url || url === cbUrl) return;
    cbUrl = url;
    const im = new Image(); im.decoding = 'async';
    im.onload = () => {
      if (url !== cbUrl || !cbRoot) return;
      const slots = cbRoot.querySelectorAll('.s'); cbSlot ^= 1;
      const nx = slots[cbSlot], old = slots[cbSlot ^ 1];
      const w = im.naturalWidth || 1, h = im.naturalHeight || 1;
      const cs = nx.querySelectorAll('canvas');
      try {
        cs[0].getContext('2d').drawImage(im, 0, 0, 48, 48);
        cs[1].getContext('2d').drawImage(im, w * 0.22, h * 0.22, w * 0.56, h * 0.56, 0, 0, 48, 48);
      } catch (e) { /* ignore */ }
      nx.classList.add('on'); old.classList.remove('on');
    };
    im.src = url;
  }
  function applyCb() {
    const on = !!cfg.coverBg;
    document.documentElement.classList.toggle('scc-cb', on);
    if (on) {
      cbStyle();
      if (!cbHost) {
        cbHost = document.createElement('div'); cbHost.id = 'scc-cover-bg'; cbHost.setAttribute('data-scc-own', '1');
        cbHost.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;';
        cbRoot = cbHost.attachShadow({ mode: 'open' });
        setHTML(cbRoot, '<style>' + CB_CSS + '</style><div class="w"><div class="s"><canvas class="c c1" width="48" height="48"></canvas><canvas class="c c2" width="48" height="48"></canvas></div>' +
          '<div class="s"><canvas class="c c1" width="48" height="48"></canvas><canvas class="c c2" width="48" height="48"></canvas></div><div class="sh"></div></div>');
        document.documentElement.appendChild(cbHost);
        npListeners.add(cbOnNp);
      }
      cbLayout(); paintTheme();
      cbHost.style.display = playerOpen ? 'none' : '';     // в плеере на весь экран фон не работает
      cbRoot.querySelector('.w').classList.toggle('p', document.hidden || playerOpen);
      if (np) cbPaint(artUrl(np));
    } else if (cbHost) {
      npListeners.delete(cbOnNp); cbHost.remove(); cbHost = cbRoot = null; cbUrl = '';
    }
    npPoll();
  }
  const cbOnNp = (s) => cbPaint(artUrl(s));
  document.addEventListener('visibilitychange', () => { if (cbRoot) cbRoot.querySelector('.w').classList.toggle('p', document.hidden || playerOpen); });
  window.addEventListener('resize', () => { cbLayout(); });

  /* ---------- настройки ---------- */
  let saveT = 0;
  function saveCfg() { clearTimeout(saveT); saveT = setTimeout(() => { try { browser.storage.local.set({ appCfg: cfg }); } catch (e) { /* ignore */ } }, 150); }
  function readCfg(c) {
    cfg = Object.assign({}, APPDEF, c || {});
    if (fp) {
      fp.el.setAttribute('data-lay', cfg.fpLayout || 'auto');
      fp.el.style.setProperty('--fpblur', (Number(cfg.fpBlur) || 0) + 'px'); fp.el.style.setProperty('--fpdim', (Number(cfg.fpDim) || 45) / 100);
    }
    applyCb(); paintMenu();
  }
  function start() {
    browser.storage.local.get(['appCfg', 'settings', 'eq', 'appFab']).then((st) => {
      settings = st.settings || null; eqOn = !!(st.eq && st.eq.enabled);
      if (st.appFab && (st.appFab.side === 'l' || st.appFab.side === 'r') && isFinite(st.appFab.y)) fabPos = st.appFab;
      makeFab(); readCfg(st.appCfg);
    }).catch(() => {});
    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.appCfg) readCfg(ch.appCfg.newValue);
      if (ch.settings) { settings = ch.settings.newValue || null; paintTheme(); }
      if (ch.eq) { eqOn = !!(ch.eq.newValue && ch.eq.newValue.enabled); if (fp) fp.eqb.classList.toggle('live', eqOn); paintMenu(); }
      if (ch.appFab && ch.appFab.newValue === undefined) { fabPos = { side: 'r', y: 0.7 }; fabPlace(); }
    });
    // SoundCloud — SPA и может пересоздать body: проверяем, что наши узлы на месте
    setInterval(() => { for (const h of hosts) if (!h.isConnected) (document.body || document.documentElement).appendChild(h); }, 4000);
  }
  start();
})();
