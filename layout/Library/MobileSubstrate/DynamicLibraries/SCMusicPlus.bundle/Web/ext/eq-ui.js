/* Эквалайзер на плеере SoundCloud: кнопка справа от «Next up» и всплывающая панель.

   Раньше эквалайзер жил в окне расширения (popup). Теперь интерфейс встроен прямо в страницу:
   - кнопка вставляется в плеер сразу после кнопки «Next up» (.playbackSoundBadge__showQueue);
   - панель открывается над кнопкой с плавной анимацией;
   - оформление (чёрная / белая панель) берётся по реальному цвету плеера, а если его определить
     не удалось — по теме браузера (prefers-color-scheme);
   - интерфейс лежит в Shadow DOM, поэтому стили сайта и «Свой CSS» его не ломают.

   Настройки по-прежнему хранятся в browser.storage.local под ключом "eq" — их подхватывает content.js
   и передаёт в eq-main.js (мир страницы), который и обрабатывает звук. */
(() => {
  'use strict';
  if (window.__sccEqUi) return;
  window.__sccEqUi = true;
  const APP = true;   // приложение: кнопки в плеере нет, панель открывается событием scc-eq-toggle

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

  /* безопасная вставка разметки: разбираем в изолированном документе, через DOMParser */
  const setHTML = (el, html) => {
    const d = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
    el.replaceChildren(...Array.from(d.body.childNodes).map((n) => document.importNode(n, true)));
  };
  const setSVG = (el, markup) => {
    const d = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + markup + '</svg>', 'image/svg+xml');
    el.replaceChildren(...Array.from(d.documentElement.childNodes).map((n) => document.importNode(n, true)));
  };

  const BANDS = ['60', '150', '400', '1k', '2.4k', '6k', '15k'];
  const BUILTIN = [
    { id: 'flat', name: 'Нейтральный', gains: [0, 0, 0, 0, 0, 0, 0], preamp: 0 },
    { id: 'bass', name: 'Басы', gains: [6, 5, 2, 0, -1, 0, 1], preamp: -3 },
    { id: 'treble', name: 'Высокие', gains: [-1, 0, 0, 0, 2, 5, 7], preamp: -3 },
    { id: 'vocal', name: 'Вокал', gains: [-2, -1, 1, 3, 3, 1, 0], preamp: -1 },
    { id: 'warm', name: 'Тепло', gains: [3, 2, 1, 0, -1, -2, -3], preamp: -1 },
    { id: 'club', name: 'Клуб', gains: [6, 3, 0, -1, 0, 3, 5], preamp: -4 },
  ];

  const W = 334, H = 150, PAD = 20, TOP = 16;
  const xOf = (i) => PAD + i * (W - 2 * PAD) / (BANDS.length - 1);
  const yOf = (g) => H / 2 - (g / 12) * (H / 2 - TOP);
  const gOf = (y) => ((H / 2 - y) / (H / 2 - TOP)) * 12;
  const fmt = (v) => (v > 0 ? '+' : '') + v;
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const PANEL_W = 372;

  /* ---------- состояние ---------- */

  const eq = { enabled: false, preamp: 0, gains: BANDS.map(() => 0), custom: [] };
  const shown = BANDS.map(() => 0);        // значения, которые сейчас нарисованы (плавно догоняют eq.gains)
  let accent = '#ff5500';
  let status = null;
  let theme = '';
  let isOpen = false;
  let dragIdx = -1;
  let raf = 0;
  let saveTimer = 0;
  const recentSaved = [];                  // что мы сами записали в storage (чтобы не принять своё эхо за чужое изменение)

  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    eq.enabled = !!r.enabled;
    eq.preamp = Math.max(-12, Math.min(12, Number(r.preamp) || 0));
    eq.gains = BANDS.map((_, i) => Math.max(-12, Math.min(12, Number(r.gains && r.gains[i]) || 0)));
    eq.custom = Array.isArray(r.custom) ? r.custom.filter(p => p && Array.isArray(p.gains) && p.gains.length === BANDS.length) : [];
  }

  function alive() {
    try { return !!(browser.runtime && browser.runtime.id); } catch (e) { return false; }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!alive()) return;
      recentSaved.push(JSON.stringify(eq));
      if (recentSaved.length > 6) recentSaved.shift();
      browser.storage.local.set({ eq }).catch(() => {});
    }, 40);
  }

  /* ---------- тема ---------- */

  function parseRgb(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return null;
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3 || p.slice(0, 3).some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function hexLum(hex) {
    return lum({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
  }

  /* Тема = цвет самого плеера (так учитываются и тема сайта, и цвета из этого расширения).
     Если цвет прочитать не вышло — тема браузера. */
  function playerColor() {
    const starts = [document.querySelector('.playControls__inner'), document.querySelector('.playControls'), document.body];
    for (const start of starts) {
      let el = start, depth = 0;
      while (el && depth++ < 10) {
        let c = null;
        try { c = parseRgb(getComputedStyle(el).backgroundColor); } catch (e) { /* ignore */ }
        if (c && c.a > 0.6) return c;
        el = el.parentElement;
      }
    }
    return null;
  }
  const prefersDark = () => !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  function detectTheme() {
    const c = playerColor();
    return c ? (lum(c) < 0.35 ? 'dark' : 'light') : (prefersDark() ? 'dark' : 'light');
  }

  /* ---- фон панели = фон родных плашек сайта (громкость, верхняя плашка), с учётом стилей этого расширения ---- */
  const SURFACES = ['.volume__sliderWrapper', '.userDropbar', '.dropbar__content', '.dropdownMenu'];
  const over = (c, b) => ({ r: c.r * c.a + b.r * (1 - c.a), g: c.g * c.a + b.g * (1 - c.a), b: c.b * c.a + b.b * (1 - c.a), a: 1 });
  const css = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  function surfaceVars() {
    const pc = playerColor();
    const base = pc || (prefersDark() ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });
    let found = null;
    for (const sel of SURFACES) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
      const col = parseRgb(cs.backgroundColor);
      const img = cs.backgroundImage && cs.backgroundImage.indexOf('gradient') >= 0 ? cs.backgroundImage : '';
      const stops = img ? (img.match(/rgba?\([^)]+\)/g) || []).map(parseRgb).filter(Boolean) : [];
      if ((col && col.a > 0.05) || stops.length) { found = { el, cs, col, img, stops }; break; }
    }
    let solid, colStr, imgStr = 'none', alpha = 1, cs = null;
    if (found) {
      cs = found.cs;
      const ref = found.stops.length ? found.stops[0] : found.col;
      alpha = Math.max(found.col ? found.col.a : 0, found.stops.length ? Math.min.apply(null, found.stops.map(x => x.a)) : 0);
      solid = over(ref, base);
      colStr = found.col ? `rgba(${found.col.r},${found.col.g},${found.col.b},${found.col.a})` : 'transparent';
      imgStr = found.img || 'none';
    } else {
      const dark = pc ? lum(pc) < 0.35 : prefersDark();
      solid = dark ? { r: 10, g: 10, b: 11, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
      colStr = css(solid);
    }
    const dark = lum(solid) < 0.35;
    let text = cs ? parseRgb(cs.color) : null;
    if (!text || text.a < 0.5 || contrast(over(text, solid), solid) < 4) text = dark ? { r: 245, g: 243, b: 244 } : { r: 23, g: 23, b: 27 };
    const T = css(text);
    let line = null;
    if (cs && parseFloat(cs.borderTopWidth) > 0) { const lc = parseRgb(cs.borderTopColor); if (lc && lc.a > 0.05) line = cs.borderTopColor; }
    const mix = (pct) => `color-mix(in srgb, ${T} ${pct}%, transparent)`;
    const shadowNative = cs && cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : '';
    const bfNative = cs ? (cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : '') : '';
    return {
      dark,
      vars: {
        '--bg-col': colStr, '--bg-img': imgStr, '--solid': css(solid), '--text': T,
        '--line': line || mix(16), '--muted': mix(62), '--chip': mix(8), '--chip-line': mix(17),
        '--curve-bg': mix(6), '--grid': mix(9), '--grid0': mix(26), '--track': mix(28),
        '--tip-bg': T, '--tip-tx': css(solid), '--ring': '#fff',
        '--shadow': shadowNative ? shadowNative + ', 0 20px 50px rgba(0,0,0,.35)' : (dark ? '0 28px 70px rgba(0,0,0,.7)' : '0 28px 70px rgba(0,0,0,.24)'),
        '--bf': bfNative || (alpha < 0.95 ? 'blur(14px) saturate(140%)' : 'none'),
      },
    };
  }

  function syncTheme(force) {
    const t = detectTheme();
    const onAcc = hexLum(accent) > 0.5 ? '#1a1206' : '#ffffff';
    let ff = '';
    try { ff = getComputedStyle(document.body).fontFamily; } catch (e) { /* ignore */ }
    for (const h of [btnHost, panelHost]) {
      if (!h) continue;
      h.style.setProperty('--accent', accent);
      h.style.setProperty('--on-accent', onAcc);
      if (ff) h.style.setProperty('--ff', ff);
    }
    if (force || t !== theme) {
      if (btnHost) btnHost.setAttribute('data-theme', t);
    }
    theme = t;
    if (panelHost) {
      const sv = surfaceVars();
      for (const k in sv.vars) panelHost.style.setProperty(k, sv.vars[k]);
      if (panel) panel.setAttribute('data-theme', sv.dark ? 'dark' : 'light');
    }
  }

  /* ---------- стили ---------- */

  const BTN_CSS = `
    :host { all: initial; }
    .b { all: unset; box-sizing: border-box; position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
      height: var(--sz, 30px); min-width: var(--sz, 30px); padding: 0 11px 0 9px; border-radius: 999px; color: var(--ic-h);
      background: color-mix(in srgb, var(--accent) 24%, transparent);
      font: 800 12px/1 system-ui, "Segoe UI", sans-serif; letter-spacing: .06em;
      transition: color .2s, background-color .2s, transform .2s; -webkit-tap-highlight-color: transparent; }
    .lbl { pointer-events: none; }
    :host([data-theme="dark"]) { --ic: rgba(255,255,255,.85); --ic-h: #fff; --hv: color-mix(in srgb, var(--accent) 45%, transparent); }
    :host([data-theme="light"]) { --ic: rgba(0,0,0,.75); --ic-h: #000; --hv: color-mix(in srgb, var(--accent) 38%, transparent); }
    .b:hover { background: var(--hv); }
    :host([data-new]) .b::after { content: ""; position: absolute; inset: -3px; border-radius: 999px; border: 2px solid var(--accent); opacity: 0; pointer-events: none;
      animation: pulse 1.8s ease-out infinite; }
    @keyframes pulse { 0% { transform: scale(.92); opacity: .9; } 100% { transform: scale(1.35, 1.7); opacity: 0; } }
    .b:active { transform: scale(.92); }
    .b:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .b[aria-expanded="true"] { background: var(--hv); }
    svg { width: 18px; height: 18px; display: block; overflow: visible; flex: none; }
    .rail { stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; opacity: .9; }
    .knob { fill: currentColor; transition: transform .4s cubic-bezier(.3,1.5,.5,1); }
    .b:hover .k1, .b[aria-expanded="true"] .k1 { transform: translateY(-5px); }
    .b:hover .k2, .b[aria-expanded="true"] .k2 { transform: translateY(5px); }
    .b:hover .k3, .b[aria-expanded="true"] .k3 { transform: translateY(-4px); }
    .led { position: absolute; right: 4px; top: 4px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
      box-shadow: 0 0 0 2px var(--led-ring, transparent); transform: scale(0); transition: transform .3s cubic-bezier(.3,1.6,.5,1); }
    :host([data-on]) .led { transform: scale(1); }
    @media (prefers-reduced-motion: reduce) { * { transition-duration: .01ms !important; } }
  `;

  const PANEL_CSS = `
    :host { all: initial; }
    .caret { display: none !important; }
    .panel { max-height: calc(100vh - 28px - env(safe-area-inset-bottom, 0px)); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .chip { padding: 8px 14px !important; font-size: 13px !important; }
    .mini { padding: 9px 12px !important; }
    .switch { width: 46px !important; height: 26px !important; }
    .track::before { width: 20px !important; height: 20px !important; }
    .switch input:checked + .track::before { transform: translateX(20px) !important; }
    .pre input { height: 32px; }
    * { box-sizing: border-box; }
    .panel { position: fixed; left: 12px; bottom: 80px; width: ${PANEL_W}px; max-width: calc(100vw - 24px); padding: 14px 16px 12px; border-radius: 16px; border: 1px solid var(--line);
      background-color: var(--bg-col); background-image: var(--bg-img, none); color: var(--text);
      -webkit-backdrop-filter: var(--bf, none); backdrop-filter: var(--bf, none); font: 13px/1.5 var(--ff, Inter, system-ui, "Segoe UI", sans-serif);
      letter-spacing: 0; text-transform: none; box-shadow: var(--shadow); z-index: 2147483000;
      visibility: hidden; opacity: 0; transform: translateY(14px) scale(.94); transform-origin: var(--ox, 90%) 100%; will-change: transform, opacity;
      pointer-events: none;
      transition: opacity .2s ease, transform .22s cubic-bezier(.4,0,1,1), visibility 0s linear .22s,
                  background-color .35s, color .35s, border-color .35s, box-shadow .35s; }
    .panel.open { visibility: visible; opacity: 1; transform: none; pointer-events: auto;
      transition: opacity .28s ease, transform .45s cubic-bezier(.2,1.1,.3,1), visibility 0s,
                  background-color .35s, color .35s, border-color .35s, box-shadow .35s; }
    .caret { position: absolute; bottom: -6px; left: var(--cx, 80%); width: 12px; height: 12px; margin-left: -6px; background: var(--solid);
      border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); transform: rotate(45deg); transition: background-color .35s, border-color .35s; }
    .panel.flip-hide .caret { display: none; }

    .sec { position: relative; }
    .panel.open .sec { animation: rise .55s cubic-bezier(.2,.9,.25,1) both; animation-delay: calc(var(--i, 0) * 50ms + 70ms); }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

    .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .title { font-weight: 700; font-size: 14px; }
    .status { font-size: 11px; color: var(--muted); margin-top: 1px; transition: color .25s; }
    .status.ok { color: #2fb463; }
    .status.warn { color: #e8863a; }
    .panel[data-theme="dark"] .status.ok { color: #7ddc9a; }
    .panel[data-theme="dark"] .status.warn { color: #ffb27a; }

    .switch { width: 38px; height: 22px; position: relative; flex: none; display: inline-block; cursor: pointer; }
    .switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .track { position: absolute; inset: 0; border-radius: 99px; background: var(--track); transition: background-color .25s; pointer-events: none; }
    .track::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .3s cubic-bezier(.3,1.5,.5,1); }
    .switch input:checked + .track { background: var(--accent); }
    .switch input:checked + .track::before { transform: translateX(16px); }
    .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }

    .body { transition: opacity .3s, filter .3s; }
    .panel.off .body { opacity: .5; filter: saturate(.6); }

    .chips { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 2px 1px 8px; margin-bottom: 2px; scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) transparent; overscroll-behavior: contain; cursor: grab; }
    .chips.drag { cursor: grabbing; user-select: none; }
    .chips::-webkit-scrollbar { height: 5px; }
    .chips::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 55%, transparent); border-radius: 3px; }
    .chip { all: unset; box-sizing: border-box; flex: none; cursor: pointer; white-space: nowrap; font-size: 12px; padding: 5px 11px; border-radius: 999px;
      border: 1px solid var(--chip-line); background: var(--chip); color: var(--text);
      transition: border-color .2s, background-color .2s, transform .15s; }
    .chip:hover { border-color: color-mix(in srgb, var(--accent) 65%, var(--chip-line)); }
    .chip:active { transform: scale(.95); }
    .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .chip.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 20%, var(--chip)); }
    .chip.plus { font-weight: 800; }
    .chip .x { margin-left: 6px; color: var(--muted); }
    .chip .x:hover { color: #e5484d; }

    .saveRow { display: flex; gap: 6px; margin-bottom: 8px; }
    .saveRow[hidden] { display: none; }
    .saveRow input { flex: 1; min-width: 0; background: var(--chip); border: 1px solid var(--chip-line); border-radius: 9px; color: var(--text); padding: 6px 9px; font: inherit; outline: none; }
    .saveRow input:focus { border-color: var(--accent); }
    .mini { all: unset; box-sizing: border-box; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--chip-line); background: var(--chip); color: var(--text); }
    .mini.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 700; }
    .mini:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .curve { height: 150px; border-radius: 12px; background: var(--curve-bg); border: 1px solid var(--chip-line); overflow: hidden; touch-action: none; transition: background .35s, border-color .35s; }
    .curve svg { width: 100%; height: 100%; display: block; cursor: pointer; user-select: none; }
    .g1, .gv { stroke: var(--grid); stroke-width: 1; }
    .g1 { stroke-dasharray: 3 4; }
    .g0 { stroke: var(--grid0); stroke-width: 1; }
    .s1 { stop-color: var(--accent); stop-opacity: .5; }
    .s2 { stop-color: var(--accent); stop-opacity: .03; }
    .area { opacity: 0; transition: opacity .7s ease .35s; }
    .open .area { opacity: 1; }
    .line { fill: none; stroke: var(--accent); stroke-width: 2.6; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset 1s cubic-bezier(.4,0,.2,1) .15s; }
    .open .line { stroke-dashoffset: 0; }
    .dot { transform-box: fill-box; transform-origin: center; transform: scale(0); transition: transform .5s cubic-bezier(.3,1.6,.5,1); }
    .open .dot { transform: scale(1); transition-delay: calc(var(--i) * 55ms + .35s); }
    .halo { fill: var(--accent); opacity: .18; transform-box: fill-box; transform-origin: center; transition: transform .2s, opacity .2s; }
    .core { fill: var(--accent); stroke: var(--ring); stroke-width: 1.6; }
    .dot.hot .halo { opacity: .34; transform: scale(1.55); }
    .tip { opacity: 0; transition: opacity .15s; pointer-events: none; }
    .drag .tip { opacity: 1; }
    .tipbg { fill: var(--tip-bg); }
    .tiptx { fill: var(--tip-tx); font: 600 11px var(--ff, system-ui, sans-serif); font-variant-numeric: tabular-nums; }

    .labels { position: relative; height: 16px; margin-top: 5px; font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .labels span { position: absolute; transform: translateX(-50%); white-space: nowrap; }

    .pre { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
    .pre span { flex: none; width: 64px; font-weight: 600; }
    .pre input { flex: 1; min-width: 0; accent-color: var(--accent); cursor: pointer; }
    .pre output { width: 54px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
    .hint { margin: 8px 0 0; font-size: 11px; color: var(--muted); }

    @media (prefers-reduced-motion: reduce) {
      .panel, .panel.open, .sec, .line, .area, .dot, .halo, .track::before { animation: none !important; transition-duration: .01ms !important; transition-delay: 0s !important; }
    }
  `;

  /* ---------- кнопка в плеере ---------- */

  let btnHost = null, btnRoot = null, btn = null;

  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <line class="rail" x1="5" y1="3.5" x2="5" y2="20.5"/><line class="rail" x1="12" y1="3.5" x2="12" y2="20.5"/><line class="rail" x1="19" y1="3.5" x2="19" y2="20.5"/>
    <circle class="knob k1" cx="5" cy="14" r="2.7"/><circle class="knob k2" cx="12" cy="8.5" r="2.7"/><circle class="knob k3" cx="19" cy="15.5" r="2.7"/>
  </svg>`;

  function createButton() {
    btnHost = document.createElement('span');
    btnHost.id = 'scc-eq-btn';
    btnHost.setAttribute('data-scc-own', '1');
    btnHost.style.cssText = 'display:inline-flex;flex:none;align-items:center;justify-content:center;vertical-align:middle;margin-left:4px;';
    btnRoot = btnHost.attachShadow({ mode: 'open' });
    setHTML(btnRoot, `<style>${BTN_CSS}</style>
      <button class="b" type="button" title="Эквалайзер" aria-label="Эквалайзер" aria-haspopup="dialog" aria-expanded="false">${ICON}<span class="lbl">EQ</span><span class="led"></span></button>`);
    btn = btnRoot.querySelector('.b');
    /* пока эквалайзер ни разу не открывали — кнопка пульсирует, чтобы её заметили */
    try { browser.storage.local.get('eqSeen').then((r) => { if (!r.eqSeen && btnHost) btnHost.setAttribute('data-new', ''); }).catch(() => {}); } catch (e) { /* ignore */ }
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (btnHost.hasAttribute('data-new')) { btnHost.removeAttribute('data-new'); try { browser.storage.local.set({ eqSeen: true }); } catch (err) { /* ignore */ } }
      isOpen ? closePanel() : openPanel();
    });
    /* чтобы сайт не реагировал на клики и клавиши по нашей кнопке */
    ['mousedown', 'mouseup', 'dblclick', 'keydown', 'keyup'].forEach(ev => btn.addEventListener(ev, (e) => e.stopPropagation()));
    paintLed();
  }

  function paintLed() {
    if (btnHost) btnHost.toggleAttribute('data-on', !!eq.enabled);
  }

  function findQueueBtn() {
    const direct = document.querySelector('.playbackSoundBadge__showQueue');
    if (direct) return direct;
    const pc = document.querySelector('.playControls');
    if (!pc) return null;
    for (const b of pc.querySelectorAll('a,button,[role="button"]')) {
      const t = (b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '');
      if (/next up|queue|очеред|далее|следующ/i.test(t)) return b;
    }
    return null;
  }

  function ensureButton(measure) {
    if (APP) { if (!alive()) teardown(); return; }
    if (!alive()) { teardown(); return; }
    if (!document.body) return;
    const q = findQueueBtn();
    let parent = null;
    if (q) parent = q.parentElement;
    else parent = document.querySelector('.playbackSoundBadge__actions') || document.querySelector('.playControls__soundBadge');
    if (!parent) {
      if (btnHost && btnHost.isConnected) btnHost.remove();
      if (isOpen) closePanel();
      return;
    }
    if (!btnHost) { createButton(); syncTheme(true); }
    const placed = q ? (btnHost.parentElement === parent && btnHost.previousElementSibling === q)
      : (btnHost.parentElement === parent && parent.lastElementChild === btnHost);
    if (!placed) { if (q) q.after(btnHost); else parent.append(btnHost); }

    /* размер и обтекание — как у соседней кнопки */
    if (q && (!placed || measure)) {
      try {
        const r = q.getBoundingClientRect(), cs = getComputedStyle(q);
        const sz = Math.round(Math.max(r.width, r.height));
        btnHost.style.setProperty('--sz', (sz >= 24 && sz <= 44 ? sz : 30) + 'px');
        /* расстояние от значка очереди до значка EQ — как между значками соседних кнопок (по центрам кнопок) */
        let gap = 13;
        const pv = q.previousElementSibling;
        if (pv && pv !== btnHost) {
          const pr = pv.getBoundingClientRect();
          const dc = (r.left + r.width / 2) - (pr.left + pr.width / 2);            // шаг между центрами соседних кнопок
          const icon = 18, pillPad = 9;
          const g = dc - icon - (r.width - icon) / 2 - pillPad;                      // зазор до края таблетки
          if (dc > 0 && dc < 120 && g >= 0 && g <= 60) gap = Math.round(g);
        }
        btnHost.style.marginLeft = gap + 'px';
        if (cs.float && cs.float !== 'none') btnHost.style.float = cs.float;
        else btnHost.style.float = '';
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------- панель ---------- */

  let panelHost = null, panelRoot = null, panel = null;
  let svg, lineEl, areaEl, dotEls = [], tipG, tipBg, tipTx;
  let chipsEl, saveRow, nameInput, preEl, preVal, eqOn, statusEl, statusTimer = 0;

  const PANEL_HTML = `<style>${PANEL_CSS}</style>
    <div class="panel" role="dialog" aria-label="Эквалайзер">
      <div class="sec head" style="--i:0">
        <div><div class="title">Эквалайзер</div><div class="status" id="st">Выключен</div></div>
        <label class="switch" title="Включить эквалайзер"><input type="checkbox" id="on"><span class="track"></span></label>
      </div>
      <div class="body">
        <div class="sec" style="--i:1">
          <div class="chips" id="chips"></div>
          <div class="saveRow" id="saveRow" hidden>
            <input type="text" id="pname" maxlength="24" placeholder="Название пресета" spellcheck="false">
            <button class="mini primary" id="psave" type="button">Сохранить</button>
            <button class="mini" id="pcancel" type="button">Отмена</button>
          </div>
        </div>
        <div class="sec" style="--i:2">
          <div class="curve"><svg id="curve" viewBox="0 0 ${W} ${H}"></svg></div>
          <div class="labels" id="labels"></div>
        </div>
        <div class="sec pre" style="--i:3">
          <span>Усиление</span>
          <input type="range" id="pre" min="-12" max="12" step="0.5" value="0">
          <output id="preVal">0 дБ</output>
        </div>
        <p class="sec hint" style="--i:4">Потяните точку вверх или вниз. Двойной клик — сбросить точку.</p>
      </div>
      <span class="caret"></span>
    </div>`;

  function curvePath(pts) {
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  const NS = 'http://www.w3.org/2000/svg';
  function buildCurve() {
    let g = '';
    for (const db of [-6, 0, 6]) g += `<line class="${db === 0 ? 'g0' : 'g1'}" x1="0" x2="${W}" y1="${yOf(db)}" y2="${yOf(db)}"/>`;
    BANDS.forEach((_, i) => { g += `<line class="gv" x1="${xOf(i)}" x2="${xOf(i)}" y1="0" y2="${H}"/>`; });
    let dots = '';
    BANDS.forEach((_, i) => { dots += `<g class="dot" style="--i:${i}"><circle class="halo" r="9"/><circle class="core" r="5.5"/></g>`; });
    setSVG(svg, `<defs><linearGradient id="scc-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="s1"/><stop offset="1" class="s2"/></linearGradient></defs>` +
      g + `<path class="area" fill="url(#scc-fill)"/><path class="line" pathLength="1"/>` + dots +
      `<g class="tip"><rect class="tipbg" rx="6" width="56" height="20"/><text class="tiptx" text-anchor="middle" x="28" y="14"></text></g>`);
    areaEl = svg.querySelector('.area'); lineEl = svg.querySelector('.line');
    dotEls = Array.from(svg.querySelectorAll('.dot'));
    tipG = svg.querySelector('.tip'); tipBg = svg.querySelector('.tipbg'); tipTx = svg.querySelector('.tiptx');
  }

  function render() {
    const pts = shown.map((g, i) => [xOf(i), yOf(g)]);
    const line = curvePath(pts);
    lineEl.setAttribute('d', line);
    areaEl.setAttribute('d', `${line} L${W - PAD},${H} L${PAD},${H} Z`);
    dotEls.forEach((d, i) => {
      for (const c of d.children) { c.setAttribute('cx', pts[i][0].toFixed(1)); c.setAttribute('cy', pts[i][1].toFixed(1)); }
    });
    if (dragIdx >= 0) {
      const tx = Math.max(2, Math.min(W - 58, pts[dragIdx][0] - 28));
      const ty = pts[dragIdx][1] < 40 ? pts[dragIdx][1] + 14 : pts[dragIdx][1] - 34;
      tipG.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
      tipTx.textContent = fmt(eq.gains[dragIdx]) + ' дБ';
    }
  }

  function tick() {
    raf = 0;
    let moving = false;
    for (let i = 0; i < shown.length; i++) {
      const d = eq.gains[i] - shown[i];
      if (Math.abs(d) > 0.02) { shown[i] += d * 0.3; moving = true; } else shown[i] = eq.gains[i];
    }
    render();
    if (moving) raf = requestAnimationFrame(tick);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  const local = (e) => {
    const r = svg.getBoundingClientRect();
    return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height];
  };
  const nearest = (x) => {
    let best = 0;
    for (let i = 1; i < BANDS.length; i++) if (Math.abs(xOf(i) - x) < Math.abs(xOf(best) - x)) best = i;
    return best;
  };
  function setGain(i, g) {
    eq.gains[i] = Math.round(Math.max(-12, Math.min(12, g)) * 2) / 2;
    afterChange();
  }
  function setHot(i) {
    dotEls.forEach((d, k) => d.classList.toggle('hot', k === i));
    svg.classList.toggle('drag', i >= 0);
  }

  function same(p) {
    return Math.abs((p.preamp || 0) - eq.preamp) < 0.01 && p.gains.every((g, i) => Math.abs(g - eq.gains[i]) < 0.01);
  }
  function drawChips() {
    const keepLeft = chipsEl.scrollLeft;       // пересборка списка не должна сбрасывать прокрутку
    chipsEl.replaceChildren();
    const plus = document.createElement('button');
    plus.type = 'button'; plus.className = 'chip plus'; plus.textContent = '+'; plus.title = 'Сохранить текущие настройки как пресет';
    plus.onclick = () => { saveRow.hidden = false; nameInput.focus(); };
    chipsEl.append(plus);
    for (const p of [...BUILTIN, ...eq.custom]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (same(p) ? ' active' : '');
      b.textContent = p.name;
      b.onclick = () => { eq.gains = p.gains.slice(); eq.preamp = p.preamp || 0; afterChange(); };
      if (p.custom) {
        const x = document.createElement('span');
        x.className = 'x'; x.textContent = '×'; x.title = 'Удалить пресет';
        x.onclick = (e) => { e.stopPropagation(); eq.custom = eq.custom.filter(c => c.id !== p.id); afterChange(); };
        b.append(x);
      }
      chipsEl.append(b);
    }
    chipsEl.scrollLeft = keepLeft;
  }
  function savePreset() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    eq.custom.push({ id: 'c' + Date.now(), name, custom: true, gains: eq.gains.slice(), preamp: eq.preamp });
    nameInput.value = ''; saveRow.hidden = true;
    afterChange();
  }

  function drawStatus() {
    if (!panel) return;
    panel.classList.toggle('off', !eq.enabled);
    let text = 'Выключен', cls = '';
    if (eq.enabled) {
      const fresh = status && Date.now() - status.t < 12000;
      const map = {
        active: ['Звук обрабатывается', 'ok'],
        idle: ['Включён — ждёт воспроизведения', ''],
        suspended: ['Кликните по странице SoundCloud, чтобы запустить звук', 'warn'],
        silent: ['SoundCloud не отдаёт этот источник эквалайзеру', 'warn'],
        unsupported: ['Этот источник звука эквалайзеру недоступен', 'warn'],
        off: ['Включится при воспроизведении', ''],
      };
      [text, cls] = fresh && map[status.state] ? map[status.state] : ['Включён', ''];
    }
    statusEl.textContent = text;
    statusEl.className = 'status ' + cls;
  }

  function afterChange(noSave) {
    if (panel) {
      preEl.value = eq.preamp; preVal.textContent = fmt(eq.preamp) + ' дБ';
      eqOn.checked = !!eq.enabled;
      drawChips(); drawStatus(); kick();
    }
    paintLed();
    if (!noSave) save();
  }

  function createPanel() {
    panelHost = document.createElement('div');
    panelHost.id = 'scc-eq-panel';
    panelHost.setAttribute('data-scc-own', '1');
    panelHost.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483600;';
    panelRoot = panelHost.attachShadow({ mode: 'open' });
    setHTML(panelRoot, PANEL_HTML);
    panel = panelRoot.querySelector('.panel');
    svg = panelRoot.getElementById('curve');
    chipsEl = panelRoot.getElementById('chips');
    saveRow = panelRoot.getElementById('saveRow');
    nameInput = panelRoot.getElementById('pname');
    preEl = panelRoot.getElementById('pre');
    preVal = panelRoot.getElementById('preVal');
    eqOn = panelRoot.getElementById('on');
    statusEl = panelRoot.getElementById('st');

    const labels = panelRoot.getElementById('labels');
    BANDS.forEach((b, i) => {
      const s = document.createElement('span');
      s.textContent = b; s.style.left = (xOf(i) / W * 100) + '%';
      labels.append(s);
    });
    buildCurve();

    /* перетаскивание: берём ближайшую по горизонтали точку */
    svg.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e);
      dragIdx = nearest(x);
      svg.setPointerCapture(e.pointerId);
      setHot(dragIdx);
      setGain(dragIdx, gOf(y));
    });
    svg.addEventListener('pointermove', (e) => { if (dragIdx >= 0) setGain(dragIdx, gOf(local(e)[1])); });
    const endDrag = () => { dragIdx = -1; setHot(-1); };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('dblclick', (e) => setGain(nearest(local(e)[0]), 0));

    preEl.addEventListener('input', () => { eq.preamp = Number(preEl.value); afterChange(); });
    preEl.addEventListener('dblclick', () => { eq.preamp = 0; afterChange(); });
    eqOn.addEventListener('change', () => { eq.enabled = eqOn.checked; afterChange(); });
    panelRoot.getElementById('psave').onclick = savePreset;
    panelRoot.getElementById('pcancel').onclick = () => { saveRow.hidden = true; };

    /* клавиши внутри панели не должны попадать на сайт (пробел = пауза, и т. д.) */
    ['keydown', 'keyup', 'keypress'].forEach(ev => panel.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === 'keydown') {
        if (e.key === 'Escape') { if (!saveRow.hidden) saveRow.hidden = true; else closePanel(true); }
        else if (e.key === 'Enter' && e.target === nameInput) savePreset();
      }
    }));
    ['wheel', 'contextmenu'].forEach(ev => panel.addEventListener(ev, (e) => e.stopPropagation()));

    /* список режимов: колесо мыши листает вбок, а также перетаскивание мышью (тачпад и сенсор листают сами) */
    chipsEl.addEventListener('wheel', (e) => {
      if (chipsEl.scrollWidth <= chipsEl.clientWidth) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      chipsEl.scrollLeft += d * (e.deltaMode === 1 ? 24 : 1);
      e.preventDefault();
    }, { passive: false });
    let cdrag = null, cmoved = false;
    chipsEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      cdrag = { x: e.clientX, left: chipsEl.scrollLeft }; cmoved = false;
    });
    chipsEl.addEventListener('pointermove', (e) => {
      if (!cdrag) return;
      const dx = e.clientX - cdrag.x;
      if (!cmoved && Math.abs(dx) > 5) { cmoved = true; chipsEl.classList.add('drag'); try { chipsEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (cmoved) chipsEl.scrollLeft = cdrag.left - dx;
    });
    const chipsEnd = () => { cdrag = null; chipsEl.classList.remove('drag'); };
    chipsEl.addEventListener('pointerup', chipsEnd);
    chipsEl.addEventListener('pointercancel', chipsEnd);
    chipsEl.addEventListener('click', (e) => { if (cmoved) { e.stopPropagation(); e.preventDefault(); cmoved = false; } }, true);

    (document.body || document.documentElement).appendChild(panelHost);
    syncTheme(true);
    for (let i = 0; i < shown.length; i++) shown[i] = eq.gains[i];
    afterChange();
    render();
  }

  function position() {
    if (APP) {
      if (!panel) return;
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const pw = Math.min(PANEL_W, vw - 24);
      panel.style.left = Math.max(12, (vw - pw) / 2) + 'px';
      panel.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 14px)';
      panel.style.setProperty('--cx', pw / 2 + 'px'); panel.style.setProperty('--ox', '50%');
      return;
    }
    if (!panel || !btnHost || !btnHost.isConnected) return;
    const r = btnHost.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const pw = Math.min(PANEL_W, vw - 24);
    const cxBtn = r.left + r.width / 2;
    let left = cxBtn - pw + 44;
    left = Math.max(12, Math.min(vw - pw - 12, left));
    const gap = 14;
    const bottom = Math.max(12, vh - r.top + gap);
    panel.style.left = left + 'px';
    panel.style.bottom = bottom + 'px';
    const cx = Math.max(22, Math.min(pw - 22, cxBtn - left));
    panel.style.setProperty('--cx', cx + 'px');
    panel.style.setProperty('--ox', cx + 'px');
  }

  function onDocPointer(e) {
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(panelHost) || path.includes(btnHost) || path.some((n) => n && n.getAttribute && n.getAttribute('data-scc-eq-keep') !== null)) return;
    closePanel();
  }
  function onDocKey(e) { if (e.key === 'Escape' && isOpen) closePanel(true); }
  const onReflow = () => { if (isOpen) position(); };

  function openPanel() {
    if (isOpen) return;
    if (APP && !btnHost) { createButton(); syncTheme(true); }
    if (!btnHost) return;
    if (!panel) createPanel();
    else { syncTheme(true); for (let i = 0; i < shown.length; i++) shown[i] = eq.gains[i]; render(); afterChange(true); }
    position();
    isOpen = true;
    btn.setAttribute('aria-expanded', 'true');
    /* два кадра: сначала браузер фиксирует стартовое состояние, потом запускаем анимацию */
    requestAnimationFrame(() => requestAnimationFrame(() => { if (isOpen) panel.classList.add('open'); }));
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    statusTimer = setInterval(drawStatus, 2000);
  }

  function closePanel(refocus) {
    if (!isOpen) return;
    isOpen = false;
    if (panel) panel.classList.remove('open');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus === true) btn.focus({ preventScroll: true }); }
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
    clearInterval(statusTimer);
    dragIdx = -1;
    if (svg) setHot(-1);
  }

  /* ---------- настройки и статус ---------- */

  function applySettings(s) {
    const m = (window.SCC && SCC.merge) ? SCC.merge(SCC.DEFAULTS, s || {}) : (s || {});
    const a = m && m.enabled !== false && m.colors && m.colors.accent;
    accent = HEX.test(a || '') ? a : '#ff5500';
    syncTheme();
  }

  function init() {
    browser.storage.local.get(['settings', 'eq', 'eqStatus']).then((st) => {
      normalize(st.eq);
      status = st.eqStatus || null;
      for (let i = 0; i < shown.length; i++) shown[i] = eq.gains[i];
      applySettings(st.settings);
      paintLed();
      ensureButton(true);
    }).catch(() => {});

    browser.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.eq && dragIdx < 0) {
        const raw = JSON.stringify(ch.eq.newValue || null);
        if (!recentSaved.includes(raw)) {
          /* изменение пришло не от нас (другая вкладка) */
          const before = JSON.stringify(eq);
          normalize(ch.eq.newValue);
          if (JSON.stringify(eq) !== before) afterChange(true);
        }
      }
      if (ch.eqStatus) { status = ch.eqStatus.newValue; drawStatus(); }
      if (ch.settings) applySettings(ch.settings.newValue);
    });
  }

  /* ---------- следим за плеером: SPA пересоздаёт DOM ---------- */

  let obsTimer = 0, mo = null, timer = 0, mq = null, pressed = false;
  const schedule = () => { if (!obsTimer) obsTimer = setTimeout(() => { obsTimer = 0; if (!pressed) ensureButton(); }, 150); };
  /* пока зажата кнопка мыши (перетаскивание ползунков плеера) — ничего не делаем */
  const release = () => { if (pressed) { pressed = false; schedule(); } };
  let pressGuard = 0;
  window.addEventListener('pointerdown', () => { pressed = true; clearTimeout(pressGuard); pressGuard = setTimeout(release, 20000); }, true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);

  function teardown() {
    clearInterval(timer); if (mo) mo.disconnect();
    if (isOpen) closePanel();
    if (btnHost) btnHost.remove();
    if (panelHost) panelHost.remove();
  }

  function start() {
    init();
    /* DOM плеера меняется каждую секунду (время, ползунок) — реагируем только на добавление элементов */
    mo = new MutationObserver((recs) => {
      for (const r of recs) { if (r.addedNodes.length || r.removedNodes.length) { schedule(); return; } }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    let ticks = 0;
    timer = setInterval(() => {
      if (!alive()) { teardown(); return; }
      if (document.hidden || pressed) return;
      ensureButton(false);                                   // без измерений: getBoundingClientRect / getComputedStyle заставляют браузер пересчитывать вёрстку
      if ((btnHost || panelHost) && (isOpen || ++ticks % 6 === 0)) syncTheme();   // тема плеера меняется редко
    }, 5000);
    try {
      mq = matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', () => syncTheme(true));
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('scc-eq-toggle', (e) => {
    const want = e && e.detail && typeof e.detail.open === 'boolean' ? e.detail.open : !isOpen;
    if (want) { openPanel(); try { browser.storage.local.set({ eqSeen: true }); } catch (err) { /* ignore */ } } else closePanel();
  });
  window.addEventListener('scc-eq-close', () => closePanel());
  start();
})();
