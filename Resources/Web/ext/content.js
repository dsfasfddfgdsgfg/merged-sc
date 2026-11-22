/* Content script: применяет настройки на soundcloud.com + инструмент «выбрать элемент». */
(() => {
  'use strict';

  /* Работаем и внутри iframe SoundCloud (страница трека открывается в iframe#__WEBI_IFRAME_PRELOADED_),
     но не трогаем встроенные плееры SoundCloud на чужих сайтах. */
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

  const STYLE_ID = 'scc-style';
  const FONT_ALIAS = 'SCC Font';
  const current = { settings: null, assets: {}, css: '' };

  /* Документы под нашим управлением: свой + доступные (same-origin) дочерние iframe.
     Если собственный content script в iframe по какой-то причине не запустился
     (about:blank / srcdoc / blob / документ переписан через document.write),
     родительская страница сама докидывает стили внутрь iframe. */
  const managed = new Set();
  const states = new WeakMap();      // doc -> { root, body, mo: [] }
  const fontFaces = new Map();       // doc -> FontFace[]
  const hookedWins = new WeakSet();
  const hookedFrames = new WeakSet();
  let scanTimer = 0;
  let cssVer = 0;
  let lastShadowWalk = 0;


  /* ---------- шрифты (через FontFace из памяти: не зависит от CSP сайта) ---------- */

  function b64ToBuf(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  function syncFonts(doc) {
    const old = fontFaces.get(doc) || [];
    for (const face of old) {
      try { doc.fonts.delete(face); } catch (e) { /* ignore */ }
    }
    const list = [];
    fontFaces.set(doc, list);
    const { settings, assets } = current;
    if (!settings || !settings.enabled) return;
    const FF = (doc.defaultView && doc.defaultView.FontFace) || FontFace;
    for (const file of SCC.activeFontFiles(settings, assets)) {
      try {
        const desc = { weight: file.weight || 'normal', style: file.style || 'normal' };
        if (file.unicodeRange) desc.unicodeRange = file.unicodeRange;
        const face = new FF(FONT_ALIAS, b64ToBuf(file.data), desc);
        doc.fonts.add(face);
        face.load().catch(() => {});
        list.push(face);
      } catch (e) { /* битый файл шрифта — пропускаем */ }
    }
  }

  /* ---------- стили ---------- */

  /* Стили через constructed stylesheet (adoptedStyleSheets): CSP сайта (style-src без 'unsafe-inline') их не блокирует,
     а обновляются они на месте (replaceSync) — без перезагрузки страницы. Используется, когда обычный <style> заблокирован
     (Firefox режет <style>, созданный скриптом расширения). */
  const adoptedSheets = new Map();   // root (document | shadowRoot) -> { sh, ver, on }
  let cspSeen = false;

  function adoptCss(root, css) {
    try {
      const doc = root.nodeType === 9 ? root : root.ownerDocument;
      const w = doc && doc.defaultView;
      if (!w || typeof w.CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in root)) return false;
      let st = adoptedSheets.get(root);
      if (!st) { st = { sh: new w.CSSStyleSheet(), ver: -1, on: false }; adoptedSheets.set(root, st); }
      if (st.ver !== cssVer) { st.sh.replaceSync(css); st.ver = cssVer; }
      if (!st.on) { root.adoptedStyleSheets = Array.from(root.adoptedStyleSheets).concat([st.sh]); st.on = true; }
      return true;
    } catch (e) { return false; }
  }

  function dropAdopted(root) {
    const st = adoptedSheets.get(root);
    if (!st) return;
    adoptedSheets.delete(root);
    try { root.adoptedStyleSheets = Array.from(root.adoptedStyleSheets).filter((x) => x !== st.sh); } catch (e) { /* документ закрыт */ }
  }

  /* <style> не применился (CSP) — у такого элемента нет .sheet */
  function styleDead(el) { return cspSeen || !el.sheet; }

  function ensureStyle(doc) {
    const parent = doc.head || doc.documentElement;
    if (!parent) return;
    try {   // iframe-документ: нужен CSS, который не закрывает видео-фон верхней страницы
      const w = doc.defaultView;
      if (w && w !== w.top && doc.documentElement && !doc.documentElement.hasAttribute('data-scc-frame')) doc.documentElement.setAttribute('data-scc-frame', '1');
    } catch (e) { /* ignore */ }
    let el = doc.getElementById(STYLE_ID);
    if (!current.css) { if (el) el.remove(); dropAdopted(doc); return; }
    if (!el) {
      el = doc.createElement('style');
      el.id = STYLE_ID;
    }
    if (el.__sccVer !== cssVer) { el.textContent = current.css; el.__sccVer = cssVer; }
    if (el.parentNode !== parent) { parent.appendChild(el); lastMove = Date.now(); }
    /* Перенос <style> в конец заставляет браузер пересчитать стили всей страницы, поэтому делаем это редко
       (MUI постоянно дописывает свои стили в <head>, и частый перенос заметно тормозил сайт). Наши правила с !important. */
    else if (doc.head && doc.head.lastElementChild !== el && Date.now() - lastMove > 30000) {
      lastMove = Date.now();
      parent.appendChild(el);
    }
    /* сайт заблокировал <style> — кладём те же правила constructed-стилем; не получилось — просим фон (insertCSS) */
    if (styleDead(el)) {
      if (!adoptCss(doc, current.css) && doc === document && !cspFallback) { cspFallback = true; syncFallback(); }
    } else dropAdopted(doc);
  }
  let lastMove = 0;

  /* Shadow DOM (в том числе closed): в него обычные стили страницы не попадают — кладём стиль внутрь. */
  function shadowOf(node) {
    try {
      if (node.openOrClosedShadowRoot !== undefined) return node.openOrClosedShadowRoot;   // Firefox: доступ и к closed Shadow DOM
    } catch (e) { /* ignore */ }
    return node.shadowRoot || null;
  }

  function eachShadow(doc, cb) {
    if (!doc.documentElement) return;
    const stack = [doc.documentElement];
    let guard = 0;
    while (stack.length && guard < 40000) {
      const root = stack.pop();
      const tw = doc.createTreeWalker(root, 1);
      let node = root.nodeType === 1 ? root : tw.nextNode();
      while (node && guard++ < 40000) {
        const sr = shadowOf(node);
        /* собственные оболочки расширения (панель эквалайзера) не стилизуем пользовательским CSS */
        if (sr && !(node.hasAttribute && node.hasAttribute('data-scc-own'))) { cb(sr); stack.push(sr); }
        node = tw.nextNode();
      }
    }
  }

  /* Обход всего DOM в поисках Shadow DOM дорогой — результат кешируем (обновляем при полном обходе или раз в 10 с). */
  const shadowCache = new WeakMap();
  function shadowRoots(doc, fresh) {
    let c = shadowCache.get(doc);
    if (!c || fresh || Date.now() - c.t > 10000) {
      const list = [];
      eachShadow(doc, (sr) => list.push(sr));
      c = { t: Date.now(), list };
      shadowCache.set(doc, c);
    }
    return c.list.filter((sr) => sr.host && sr.host.isConnected);
  }

  function styleShadows(doc, fresh) {
    shadowRoots(doc, fresh).forEach((sr) => {
      let el = sr.getElementById ? sr.getElementById(STYLE_ID) : null;
      if (!current.css) { if (el) el.remove(); dropAdopted(sr); return; }
      if (!el) { el = doc.createElement('style'); el.id = STYLE_ID; sr.appendChild(el); }
      if (el.__sccVer !== cssVer) { el.textContent = current.css; el.__sccVer = cssVer; }
      if (styleDead(el)) adoptCss(sr, current.css); else dropAdopted(sr);
    });
  }

  /* Полное снятие кастомизации: стили, пометки, шрифты, наблюдатели — как будто расширения нет. */
  function removeShadowStyles(doc) {
    eachShadow(doc, (sr) => { const el = sr.getElementById ? sr.getElementById(STYLE_ID) : null; if (el) el.remove(); dropAdopted(sr); });
  }
  function teardown() {
    clearTimeout(scanTimer); scanTimer = 0;
    for (const doc of managed) {
      try {
        const st = states.get(doc);
        if (st) { st.mo.forEach(m => m.disconnect()); states.delete(doc); }
        const el = doc.getElementById(STYLE_ID);
        if (el) el.remove();
        dropAdopted(doc);
        removeShadowStyles(doc);
        clearAllMarks(doc);
        syncFonts(doc);
      } catch (e) { /* документ мог быть закрыт */ }
    }
  }

  /* ---------- фон на странице трека и др.: снимаем сплошной фон с крупных блоков ---------- */

  const KEEP_SEL = '.header,.playControls,.dropdownMenu,.dropbar,.userDropbar,.l-top.g-z-index-fixed,.queue,.modal,.modal__modal,' +
    '.soundList__item,.sidebarModule,.badgeList__item,.compactTrackList__item,.searchList__item,.commentForm,' +
    '.waveform,.playbackTimeline,.volume,#onetrust-consent-sdk,#scc-picker-root';

  /* баннер / шапка профиля: свою картинку и фон оставляем как есть (и при включённом фоне страницы, и при выключенном) */
  const BANNER_SEL = '.profileHeader,[class*="profileHeader"],[class*="ProfileHeader"],[class*="banner" i],[class*="userHeader" i],[class*="Header" i]';

  function isOpaque(color) {
    if (!color || color === 'transparent') return false;
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const p = m[1].split(/[,/\s]+/).filter(Boolean);
    const a = p.length > 3 ? parseFloat(p[3]) : 1;
    return a > 0.05;
  }

  function clearScan(doc) {
    doc.querySelectorAll('[data-scc-clear]').forEach(n => n.removeAttribute('data-scc-clear'));
  }

  function clearAllMarks(doc) {
    clearFontScale(doc);
    doc.querySelectorAll('[data-scc-clear],[data-scc-card],[data-scc-hide],[data-scc-at],[data-scc-sb],[data-scc-sfill],[data-scc-sstroke]').forEach(n => {
      ['data-scc-clear', 'data-scc-card', 'data-scc-sb', 'data-scc-sfill', 'data-scc-sstroke'].forEach(a => n.removeAttribute(a));
      if (n.style) n.style.removeProperty('--scc-rgb');
      n.removeAttribute('data-scc-hide'); n.removeAttribute('data-scc-at');
    });
  }

  /* Кастомная полоса прокрутки на странице трека — это svg внутри div (div > svg).
     Находим узкие длинные svg и помечаем их закрашенные / обведённые фигуры: CSS перекрасит их в акцент. */
  function alphaOf(color) {
    if (!color || color === 'none' || color === 'transparent') return 0;
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const p = m[1].split(/[,/\s]+/).filter(Boolean);
    return p.length > 3 ? parseFloat(p[3]) : 1;
  }

  const SB_SKIP = 'button,a,[role="button"],label,.sc-button';

  function markScrollbars(doc, win) {
    const roots = [doc].concat(shadowRoots(doc, false));
    for (const root of roots) {
      root.querySelectorAll('div > svg').forEach(svg => {
        let bar = false;
        if (!svg.classList.contains('MuiSvgIcon-root') && !svg.closest(SB_SKIP)) {
          const r = svg.getBoundingClientRect();
          const mn = Math.min(r.width, r.height), mx = Math.max(r.width, r.height);
          bar = (mn === 0) ? !!svg.querySelector('rect,path,line,circle')   // скрыт до прокрутки
            : (mn <= 40 && mx >= 40 && mx >= 3 * mn);                         // узкая длинная полоса
        }
        if (!bar) { if (svg.hasAttribute('data-scc-sb')) svg.removeAttribute('data-scc-sb'); return; }
        svg.setAttribute('data-scc-sb', '1');
        /* красим любые видимые фигуры: ползунок может быть полупрозрачным или заданным через currentColor */
        svg.querySelectorAll('path,rect,circle,ellipse,polygon,polyline,line').forEach(sh => {
          const cs = win.getComputedStyle(sh);
          sh.toggleAttribute('data-scc-sfill', cs.fill !== 'none' && alphaOf(cs.fill) > 0.02);
          sh.toggleAttribute('data-scc-sstroke', cs.stroke !== 'none' && alphaOf(cs.stroke) > 0.02 && parseFloat(cs.strokeWidth) > 0);
        });
      });
    }
  }

  function scanBackgrounds(doc, only) {
    const { settings, assets } = current;
    if (!settings || !SCC.hasBgImage(settings, assets)) { clearScan(doc); return; }
    const body = doc.body;
    const win = doc.defaultView;
    if (!body || !win) return;
    const vw = win.innerWidth;
    const vh = win.innerHeight;

    const visit = (el, depth) => {
      if (depth > 12 || el.nodeType !== 1) return;
      if (el.matches(KEEP_SEL)) return;
      if (el.matches(BANNER_SEL) && !/hero|listen/i.test(String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className))) return;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'svg' || tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO' || tag === 'IFRAME') return;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5) return;            // узкие блоки и их потомков не трогаем
      const cs = win.getComputedStyle(el);
      if (cs.position === 'fixed' && !(r.width >= vw * 0.9 && r.height >= vh * 0.9)) return;
      if (r.height >= 100) {
        const bgImg = cs.backgroundImage;
        const hasUrl = bgImg && bgImg.indexOf('url(') >= 0;
        const hasGrad = bgImg && bgImg.indexOf('gradient') >= 0;
        const heroLike = /hero|listen/i.test(String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className));
        /* блок со своей картинкой (баннер и т.п.) не трогаем, если он не «hero / listen» страницы трека */
        if (hasUrl && !heroLike) { /* оставляем как есть */ }
        else if (isOpaque(cs.backgroundColor) || hasGrad || (hasUrl && heroLike)) {
          el.setAttribute('data-scc-clear', '1');
        }
      }
      for (const ch of el.children) visit(ch, depth + 1);
    };
    if (only) { for (const r of only) { if (!r.closest(KEEP_SEL)) visit(r, 0); } }
    else for (const ch of body.children) visit(ch, 0);
  }

  /* Сплошные панели страницы трека (комментарии, «Fans» и т.п.) имеют генерируемые классы, которые заранее не угадать.
     При картинке фона находим их по факту: непрозрачный фон + заметный размер + не всплывающее окно — и помечаем.
     CSS делает их такими же прозрачными, как карточки («Карточки» в настройках). */
  const CARD_TAGS = 'div,section,aside,article,ul,ol,main';
  const CARD_SKIP = '[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],[role="alertdialog"],' +
    '.MuiPopover-root,.MuiModal-root,.MuiMenu-root,.MuiDialog-root,.MuiDrawer-root,.MuiPopper-root,.MuiSnackbar-root,' +
    '.sc-button,.sc-input,.sc-tag,.dropdownMenu,.dropbar,.userDropbar,.headerMenu,.sc-popover,.volume__sliderWrapper,.queue,.modal,.dialog,' +
    '.playControls,.header,.waveform,.tagInput__inputWrapper,#scc-picker-root,#scc-settings-host,' +
    '.profileHeader,[class*="profileHeader"],[class*="banner" i],[class*="hero" i],[class*="visual" i],[class*="userInfo" i],[class*="userBadge" i]';
  let lastCardScan = 0, cardRetry = 0;

  function rememberRgb(el, win) { /* родной цвет утерян (React перерисовал style) — берём то, что есть */
    const m = win.getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
    const p = m ? m[1].split(/[,/\s]+/).filter(Boolean) : [];
    if (p.length >= 3) el.style.setProperty('--scc-rgb', p[0] + ',' + p[1] + ',' + p[2]);
  }

  function markPanels(doc, win, force, only) {
    const now = Date.now();
    if (!force && now - lastCardScan < 900) { if (!cardRetry) cardRetry = setTimeout(() => { cardRetry = 0; scheduleScan(); }, 950); return; }
    lastCardScan = now;
    const body = doc.body;
    if (!body) return;
    let n = 0;
    let list;
    if (only) {
      list = [];
      for (const r of only) {
        if (r.matches && r.matches(CARD_TAGS)) list.push(r);
        if (r.querySelectorAll) for (const x of r.querySelectorAll(CARD_TAGS)) { list.push(x); if (list.length > 1200) break; }
        if (list.length > 1200) break;
      }
    } else list = body.querySelectorAll(CARD_TAGS);
    for (let i = 0; i < list.length && n < 4000; i++, n++) {
      const el = list[i];
      let want = false;
      const marked = el.hasAttribute('data-scc-card');
      if (marked) {
        want = true;                                   // уже помеченный (его фон сейчас наш) — оставляем
        if (!el.style.getPropertyValue('--scc-rgb')) rememberRgb(el, win);
      } else if (!el.hasAttribute('data-scc-clear')) {
        const cs = win.getComputedStyle(el);
        const bi = cs.backgroundImage;
        const plain = !bi || bi === 'none';          // блоки с картинкой / градиентом (баннер профиля и т.п.) не трогаем
        if (plain && isOpaque(cs.backgroundColor) && cs.position !== 'fixed' && cs.display !== 'none') {
          const r = el.getBoundingClientRect();
          /* страничные обёртки (почти во всю ширину окна) не трогаем: под ними должен остаться фон страницы */
          if (r.width >= 160 && r.height >= 40 && r.width < win.innerWidth * 0.9 && !el.closest(CARD_SKIP)) {
            const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
            const p = m ? m[1].split(/[,/\s]+/).filter(Boolean) : [];
            if (p.length >= 3) el.style.setProperty('--scc-rgb', p[0] + ',' + p[1] + ',' + p[2]);
            want = true;
          }
        }
      }
      if (want !== marked) el.toggleAttribute('data-scc-card', want);
    }
  }

  /* Панель «Artist tools»: находим заголовок по тексту и поднимаемся к самому большому предку, в котором нет ничего,
     кроме её содержимого (заголовок, плитки Amplify / Replace / Distribute / Master, строка «Unlock…»). Соседние секции
     и комментарии в такой предок не попадают — иначе он бы содержал и их текст. Скрываем только его. */
  const AT_RE = /^\s*artist tools\s*$/i;
  const AT_WORDS = /artist tools|amplify|replace|distribute|master|unlock|from|per|month|[€$£]|[\d.,/]+|\s+/gi;
  let lastAtScan = 0, atRetry = 0;

  function findArtistTools(doc, win, only) {
    const hits = [];
    let seen = 0;
    for (const start of (only || [doc.body])) {
      const walker = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode()) && seen++ < 60000) {
        const v = node.nodeValue;
        if (v && v.length >= 12 && v.length <= 20 && AT_RE.test(v)) {
          const el = node.parentElement;
          if (el && !el.closest('.playControls,.header,#scc-settings-host')) hits.push(el);
        }
      }
    }
    return hits;
  }

  function markArtistTools(doc, win, force, only) {
    const flag = current.settings && current.settings.flags && current.settings.flags.hideArtistTools === true;
    /* панель скрыта (data-scc-hide) или, если скрытие выключено, помечена для оформления (data-scc-at) — без :has() в CSS */
    const attr = flag ? 'data-scc-hide' : 'data-scc-at', other = flag ? 'data-scc-at' : 'data-scc-hide';
    const old = doc.querySelectorAll('[' + attr + ']');
    if (!only) doc.querySelectorAll('[' + other + ']').forEach(n => n.removeAttribute(other));
    const now = Date.now();
    if (!force && now - lastAtScan < 900) { if (!atRetry) atRetry = setTimeout(() => { atRetry = 0; scheduleScan(); }, 950); return; }
    lastAtScan = now;
    if (!doc.body) return;
    const found = new Set();
    for (const h of findArtistTools(doc, win, only)) {
      let best = h;
      for (let p = h.parentElement, i = 0; p && p !== doc.body && p !== doc.documentElement && i < 8; p = p.parentElement, i++) {
        const t = p.textContent || '';
        if (t.length > 400 || t.replace(AT_WORDS, '').length > 12) break;     // в предке уже что-то лишнее
        if (p.querySelector('textarea,input:not([type=checkbox]),audio,video,canvas.waveform')) break;
        best = p;
      }
      if (best.getBoundingClientRect().height > 700) continue;                   // страховка: слишком большой блок не скрываем
      found.add(best);
    }
    if (!only) old.forEach(n => { if (!found.has(n)) n.removeAttribute(attr); });
    found.forEach(n => { if (!n.hasAttribute(attr)) n.setAttribute(attr, '1'); });
  }

  /* ---------- размер шрифта: каждому элементу с текстом задаём font-size = исходный × масштаб ---------- */
  const FS_SKIP = '#scc-settings-host,#scc-eq-panel,#scc-picker-root,[data-scc-own]';
  function fontScale() {
    const f = current.settings && current.settings.font;
    const p = f ? Number(f.size) : 100;
    return isFinite(p) && p > 0 && p !== 100 ? Math.max(0.7, Math.min(2, p / 100)) : 1;
  }
  /* исходное inline-значение font-size запоминаем в data-scc-fs и возвращаем при снятии масштаба */
  function restoreFs(n) {
    const o = n.getAttribute('data-scc-fs') || '';
    const i = o.indexOf('|');
    const val = i < 0 ? '' : o.slice(0, i), pr = i < 0 ? '' : o.slice(i + 1);
    if (val) n.style.setProperty('font-size', val, pr); else n.style.removeProperty('font-size');
  }
  function clearFontScale(doc) {
    doc.querySelectorAll('[data-scc-fs]').forEach((n) => { restoreFs(n); n.removeAttribute('data-scc-fs'); });
  }
  function scaleFonts(doc, only) {
    const k = fontScale();
    if (!doc.body) return;
    if (k === 1) { clearFontScale(doc); return; }
    /* 1) снимаем наши размеры в области обхода (и у отмеченных предков), чтобы измерить исходные значения;
       всё в одном синхронном блоке — браузер ничего не рисует между снятием и установкой */
    const targets = new Set();
    const roots = only || [doc.body];
    for (const r of roots) {
      if (r.nodeType !== 1) continue;
      if (r.hasAttribute('data-scc-fs')) targets.add(r);
      r.querySelectorAll('[data-scc-fs]').forEach((n) => targets.add(n));
      for (let p = r.parentElement; p; p = p.parentElement) if (p.hasAttribute('data-scc-fs')) targets.add(p);
      r.querySelectorAll('input,textarea,select').forEach((n) => targets.add(n));
      const tw = doc.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      let n, seen = 0;
      while ((n = tw.nextNode()) && seen++ < 60000) {
        const v = n.nodeValue;
        if (v && v.trim()) { const el = n.parentElement; if (el) targets.add(el); }
      }
    }
    const list = Array.from(targets).filter((el) => el.isConnected && !(el.closest && el.closest(FS_SKIP)) && !/^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH)$/i.test(el.tagName));
    const orig = list.map((el) => (el.hasAttribute('data-scc-fs') ? null : el.style.getPropertyValue('font-size') + '|' + el.style.getPropertyPriority('font-size')));
    list.forEach((el) => { if (el.hasAttribute('data-scc-fs')) restoreFs(el); });
    const win = doc.defaultView;
    const sizes = list.map((el) => parseFloat(win.getComputedStyle(el).fontSize));
    list.forEach((el, i) => {
      const px = sizes[i];
      if (!isFinite(px) || px <= 0) return;
      el.style.setProperty('font-size', Math.round(px * k * 100) / 100 + 'px', 'important');
      if (orig[i] !== null) el.setAttribute('data-scc-fs', orig[i]);
    });
  }

  /* Каждый шаг обхода изолирован: если после обновления SoundCloud один из них сломается (изменилась вёрстка),
     остальные продолжают работать, а страница не страдает. */
  const safe = (fn) => { try { fn(); } catch (e) { /* вёрстка сайта изменилась или документ закрыт */ } };
  let scanDelay = 250;

  /* Обход страницы — инкрементальный: плеер SoundCloud обновляет DOM каждую секунду, и полный обход на каждое изменение
     вызывал подлагивания (в том числе ползунка воспроизведения). Теперь:
       • изменения внутри плеера и текстовые правки вообще не запускают обход;
       • при добавлении элементов обходятся только эти новые поддеревья;
       • полный обход — при смене настроек / размера окна / адреса страницы и не чаще раза в 20 с;
       • работа идёт в простое браузера (requestIdleCallback), а не в момент отрисовки кадра. */
  const dirty = new Set();
  let fullNeeded = true, lastFull = 0;
  const IGNORE_SEL = '.playControls,.playbackTimeline,.volume,#scc-bg-video,#scc-settings-host,#scc-eq-panel,#scc-picker-root,[data-scc-own]';

  function markDirty(n) {
    if (fullNeeded) return;
    if (dirty.size > 250) { fullNeeded = true; dirty.clear(); return; }
    dirty.add(n);
  }
  function scanFull() { fullNeeded = true; dirty.clear(); scheduleScan(); }

  function onContentMutations(recs) {
    let hit = false;
    for (const r of recs) {
      if (!r.addedNodes.length) continue;               // удаления и правки текста обход не требуют
      const t = r.target;
      if (!t || t.nodeType !== 1) continue;
      if (t.closest && t.closest(IGNORE_SEL)) continue;
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && !(n.id && n.id.indexOf('scc-') === 0)) { markDirty(n); hit = true; }
      }
    }
    if (hit) scheduleScan();
  }

  /* Пока зажата кнопка мыши (перетаскивание ползунка перемотки / громкости, прокрутка за полосу) расширение ничего не обходит
     и не пересчитывает: любая работа в основном потоке в этот момент даёт рывки. Всё накопленное делаем сразу после отпускания. */
  let pointerDown = false, releaseTimer = 0, pressGuard = 0;
  function onPress() { pointerDown = true; clearTimeout(pressGuard); pressGuard = setTimeout(onRelease, 20000); }   // страховка: событие отпускания могло потеряться
  function onRelease() {
    if (!pointerDown) return;
    pointerDown = false;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { if (current.css && (fullNeeded || dirty.size)) scheduleScan(); }, 400);
  }
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('pointercancel', onRelease, true);
  window.addEventListener('dragend', onRelease, true);
  window.addEventListener('blur', onRelease);

  function scanAll() {
    scanTimer = 0;
    if (pointerDown) return;                                   // продолжим после отпускания кнопки мыши
    const t0 = performance.now();
    const now = Date.now();
    const full = fullNeeded || (dirty.size > 0 && now - lastFull > 20000);
    const roots = full ? null : Array.from(dirty);
    dirty.clear();
    if (full) { fullNeeded = false; lastFull = now; }
    for (const doc of managed) {
      try {
        const win = doc.defaultView;
        if (!win) continue;
        if (!current.css) { clearAllMarks(doc); continue; }
        if (doc.hidden) { fullNeeded = true; continue; }                  // фоновая вкладка: обход потом, при возвращении
        const mine = full ? null : roots.filter((n) => n.ownerDocument === doc && n.isConnected);
        if (!full && !mine.length) continue;
        safe(() => scanBackgrounds(doc, mine));
        safe(() => markPanels(doc, win, true, mine));
        safe(() => markArtistTools(doc, win, true, mine));
        if (full && doc.body && win !== win.top) safe(() => markScrollbars(doc, win));   // только внутри iframe
        safe(() => styleShadows(doc, full));
        safe(() => scaleFonts(doc, full ? null : mine));
      } catch (e) { /* документ мог быть закрыт */ }
    }
    lastShadowWalk = Date.now();
    /* тяжёлая страница — реже обходим её (но не реже раза в 4 с) */
    const spent = performance.now() - t0;
    scanDelay = Math.min(4000, Math.max(500, Math.round(spent * 8)));
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      if (pointerDown) { scanTimer = 0; return; }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(scanAll, { timeout: 2500 });
      else scanAll();
    }, scanDelay);
  }

  let maintainTimer = 0;
  function scheduleMaintain() {
    if (maintainTimer) return;
    maintainTimer = setTimeout(() => { maintainTimer = 0; if (!pointerDown) maintain(); }, 400);
  }

  /* ---------- управление документами (свой + iframe) ---------- */

  function watch(doc) {
    const root = doc.documentElement;
    if (!root) return;
    let st = states.get(doc);
    if (st && st.root === root && st.body === doc.body && st.head === doc.head) return;
    if (st) st.mo.forEach(m => m.disconnect());     // документ перезаписан (document.open / смена body) — наблюдаем заново
    st = { root, body: doc.body, head: doc.head, mo: [] };
    states.set(doc, st);

    fullNeeded = true;
    const structural = new MutationObserver(() => { scheduleMaintain(); });
    structural.observe(root, { childList: true });
    if (doc.head) structural.observe(doc.head, { childList: true });
    st.mo.push(structural);
    if (doc.body) {
      const content = new MutationObserver(onContentMutations);
      content.observe(doc.body, { childList: true, subtree: true });
      st.mo.push(content);
    }

    const win = doc.defaultView;
    if (win && !hookedWins.has(win)) {
      hookedWins.add(win);
      for (const ev of ['resize', 'load', 'popstate', 'pageshow']) win.addEventListener(ev, scanFull);
      doc.addEventListener('visibilitychange', () => { if (!doc.hidden) scanFull(); });
      /* кастомная полоса прокрутки появляется при прокрутке — красим сразу, не дожидаясь общего обхода */
      let sbTimer = 0;
      doc.addEventListener('scroll', () => {
        if (sbTimer || !current.css || win === win.top) return;
        sbTimer = setTimeout(() => { sbTimer = 0; try { markScrollbars(doc, win); } catch (e) { /* ignore */ } }, 300);
      }, true);
    }
    scheduleScan();
  }

  function adopt(doc) {
    if (managed.has(doc)) return;
    managed.add(doc);
    syncFonts(doc);
  }

  function prune() {
    for (const doc of Array.from(managed)) {
      if (doc !== document && !doc.defaultView) {
        managed.delete(doc);
        fontFaces.delete(doc);
      }
    }
  }

  /* Почему видео не видно на странице трека: у страницы в iframe своя цветовая схема (тёмная), а у самого элемента iframe
     в верхней странице — другая. Когда схемы различаются, Chrome закрашивает iframe сплошным фоном, и видео под ним не видно.
     Выравниваем схему элемента iframe по схеме его документа (только при видео-фоне; иначе возвращаем как было). */
  function videoOn() {
    const s = current.settings;
    return !!(s && s.enabled && s.bg && s.bg.enabled && SCC.videoSpec(s.bg) && current.css);
  }
  function syncFrameScheme(ifr, cd) {
    try {
      if (videoOn()) {
        const cs = (cd.defaultView.getComputedStyle(cd.documentElement).colorScheme || 'normal').trim() || 'normal';
        if (ifr.style.getPropertyValue('color-scheme') !== cs) ifr.style.setProperty('color-scheme', cs, 'important');
        ifr.setAttribute('data-scc-cs', '1');
      } else if (ifr.hasAttribute('data-scc-cs')) {
        ifr.style.removeProperty('color-scheme');
        ifr.removeAttribute('data-scc-cs');
      }
    } catch (e) { /* ignore */ }
  }

  function bridge(doc, depth) {
    if (depth > 3) return;
    let frames;
    try { frames = doc.querySelectorAll('iframe'); } catch (e) { return; }
    for (const ifr of frames) {
      if (!hookedFrames.has(ifr)) {
        hookedFrames.add(ifr);
        ifr.addEventListener('load', () => { maintain(); scanFull(); });
      }
      let cd = null;
      try { cd = ifr.contentDocument; } catch (e) { cd = null; }   // чужой origin — сюда не достучаться
      if (cd && cd.documentElement && cd.defaultView) {
        syncFrameScheme(ifr, cd);
        adopt(cd);
        bridge(cd, depth + 1);
      }
    }
  }

  function maintain() {
    if (!browser.runtime || !browser.runtime.id) { clearInterval(timer); return; }   // расширение перезагружено
    if (!current.settings || !current.css) return;
    prune();
    safe(syncVideo);
    bridge(document, 0);
    for (const doc of managed) {
      try { ensureStyle(doc); watch(doc); } catch (e) { /* ignore */ }
    }
  }

  /* Страницы со строгим CSP: <style> от расширения блокируется (Firefox) — тогда правила вставляет фон через scripting.insertCSS */
  let cspFallback = false, sentCss = '';
  function syncFallback() {
    if (!cspFallback) return;
    const css = current.css || '';
    if (css === sentCss) return;
    const prev = sentCss;
    sentCss = css;
    try { browser.runtime.sendMessage({ type: 'scc-css-fallback', css, prev }).catch(() => {}); } catch (e) { /* расширение перезагружено */ }
  }
  document.addEventListener('securitypolicyviolation', (e) => {
    if (cspSeen || !/^style-src/.test(e.violatedDirective || '') || (e.blockedURI !== 'inline' && e.blockedURI !== '')) return;
    cspSeen = true;
    safe(maintain);       // сразу переключаем доставку стилей на constructed stylesheet
    scanFull();
  }, true);

  function apply() {
    if (!current.settings) return;
    current.css = SCC.buildCss(current.settings, current.assets);
    cssVer++;
    syncFallback();
    adopt(document);
    if (!current.css) { safe(vidRemove); teardown(); return; }       // выключено: убираем всё, дальше ничего не работает
    for (const doc of managed) {
      try { syncFonts(doc); } catch (e) { /* ignore */ }
    }
    maintain();
    scanFull();
  }

  /* Раз в секунду проверяем, что стиль на месте (SPA и document.write могут его сносить),
     и подхватываем новые iframe. Раз в 3 секунды — обход Shadow DOM. */
  let ticks = 0;
  const timer = setInterval(() => {
    if (pointerDown) return;
    maintain();
    /* раз в минуту — полный обход (на случай нового Shadow DOM и подобного), только в активной вкладке */
    if (++ticks % 20 === 0 && current.css && !document.hidden) scanFull();
  }, 3000);

  /* ---------- эквалайзер: настройки из storage -> скрипт в мире страницы (eq-main.js) ---------- */
  let eqCfg = null;
  const MSG_ORIGIN = location.origin && location.origin !== 'null' ? location.origin : '*';
  function sendEq() {
    if (eqCfg) window.postMessage({ __scc: 'eq', cfg: eqCfg }, MSG_ORIGIN);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    if (e.data.__scc === 'eq-hello') sendEq();
    if (e.data.__scc === 'eq-status' && window === window.top) {
      const st = String(e.data.state);
      if (['off', 'idle', 'active', 'suspended', 'silent', 'unsupported'].indexOf(st) < 0) return;   // сайт мог прислать что угодно
      try { browser.storage.local.set({ eqStatus: { state: st, t: Date.now() } }); } catch (err) { /* ignore */ }
    }
  });
  browser.storage.local.get('eq').then(r => { eqCfg = r.eq || null; sendEq(); }).catch(() => {});

  let loadTimer = 0;
  async function load() {
    try {
      const r = await browser.storage.local.get(['settings', 'assets']);
      current.settings = r.settings ? SCC.sanitizeSettings(r.settings) : SCC.defaultSettings();
      current.assets = SCC.sanitizeAssets(r.assets);
      apply();
    } catch (e) { /* расширение перезагружено — вкладку нужно обновить */ }
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.eq) { eqCfg = changes.eq.newValue || null; sendEq(); }
    /* несколько событий подряд (настройки + картинка) склеиваем и применяем уже вне обработчика события */
    if (changes.settings || changes.assets) { clearTimeout(loadTimer); loadTimer = setTimeout(load, 60); }
  });
  load();

  /* ---------- видео-фон ----------
     Экономия ресурсов: видео без звука и без управления, один элемент на вкладку; пока окно скрыто / свёрнуто
     (или в системе включено «меньше движения») воспроизведение стоит — настройка «играть в свёрнутом окне» это отключает;
     никаких фильтров (размытие видео сильно грузит видеокарту), подмены кадров скриптом и таймеров — только события. */
  const VID_ID = 'scc-bg-video';
  let vidFx = '', vidEl = null, vidFrame = null, vidKey = '', vidKeep = false, vidHooked = false, vidFell = false, vidSpec = null, vidEmbedSrc = '', vidOpts = null;
  const still = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  /* Размытие и яркость видео по желанию пользователя (по умолчанию 0 — без фильтров, без нагрузки на видеокарту). */
  function vidFilterCss(blurPx, vr) {
    const f = [];
    if (blurPx > 0) f.push('blur(' + blurPx + 'px)');
    if (vr !== 0) f.push('brightness(' + (100 + vr) + '%)');
    return (f.length ? 'filter:' + f.join(' ') + ';' : '') + (blurPx > 0 ? 'transform:scale(1.08);' : '');   // scale прячет размытые края
  }

  /* Загрузка и декодирование видео начинаются только после загрузки страницы и в простое — сайт не замедляется. */
  function whenIdle(fn) {
    const go = () => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2500 });
      else setTimeout(fn, 400);
    };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
  }

  /* Состояние «стоп»: окно скрыто (если не включено «играть в свёрнутом»), «меньше движения» в системе или идёт прокрутка. */
  let scrolling = false, scrollTimer = 0;
  function vidHardStop() { return (document.hidden && !vidKeep) || !!(still && still.matches); }

  function vidSync() {
    const hard = vidHardStop(), stop = hard || scrolling;
    if (vidFrame) sendHost();
    if (!vidEl) return;
    if (vidEl.tagName === 'IFRAME') { embedPause(stop, hard); return; }
    try { if (stop) vidEl.pause(); else if (vidEl.paused) vidEl.play().catch(() => {}); } catch (e) { /* ignore */ }
  }

  /* Прокрутка страницы поверх идущего видео заставляет браузер пересобирать каждый кадр — сайт «лагает».
     Пока страницу крутят (и ещё 0,25 с), видео стоит на паузе. Прокрутка внутри iframe (страница трека) сообщается верхней странице. */
  let vidPauseScroll = true;
  function onScroll() {
    if (window !== window.top) { try { window.top.postMessage({ __scc: 'scroll' }, '*'); } catch (e) { /* ignore */ } return; }
    if (!vidKey || !vidPauseScroll) return;
    if (!scrolling) { scrolling = true; vidSync(); }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { scrolling = false; vidSync(); }, 250);
  }
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  if (window === window.top) {
    window.addEventListener('message', (e) => {
      if (!e.data || e.data.__scc !== 'scroll' || !e.source || e.source === window) return;
      let ok = false;
      try { ok = /(^|\.)soundcloud\.com$/.test(new URL(e.origin).hostname); } catch (err) { /* ignore */ }
      if (ok) onScroll();
    });
  }

  function vidDrop() {
    if (vidEl) { vidEl._dead = true; }
    if (vidEl) {
      try { if (vidEl.tagName === 'VIDEO') { vidEl.pause(); vidEl.removeAttribute('src'); vidEl.load(); } } catch (e) { /* ignore */ }
      vidEl.remove(); vidEl = null;
    }
  }

  function vidRemove() {
    vidDrop();
    if (vidFrame) { vidFrame.remove(); vidFrame = null; }
    vidKey = ''; vidFell = false; vidFx = ''; vidSpec = null; vidEmbedSrc = ''; vidOpts = null; scrolling = false;
  }

  /* Положение и размер плеера YouTube / VK (16:9): «Заполнить» — как cover, «Вписать» — как contain. */
  function embedCss(o) {
    const p = (o.pos || 'center center').split(' ');
    const hx = p[0], vy = p[1] || 'center';
    const left = hx === 'left' ? '0' : hx === 'right' ? '100%' : '50%', tx = hx === 'left' ? '0%' : hx === 'right' ? '-100%' : '-50%';
    const top = vy === 'top' ? '0' : vy === 'bottom' ? '100%' : '50%', ty = vy === 'top' ? '0%' : vy === 'bottom' ? '-100%' : '-50%';
    const fn = o.fit === 'contain' ? 'min' : 'max';
    const f = [];
    if (o.blurPx > 0) f.push('blur(' + o.blurPx + 'px)');
    if (o.vr !== 0) f.push('brightness(' + (100 + o.vr) + '%)');
    return 'position:fixed;left:' + left + ';top:' + top + ';width:' + fn + '(100vw,177.78vh);height:' + fn + '(100vh,56.25vw);border:0;' +
      'z-index:-2;pointer-events:none;background:transparent;color-scheme:normal;' +
      'transform:translate(' + tx + ',' + ty + ')' + (o.blurPx > 0 ? ' scale(1.08)' : '') + ';' + (f.length ? 'filter:' + f.join(' ') + ';' : '');
  }

  function vidCss(kind, o) {
    if (kind === 'direct') {
      return 'position:fixed;inset:0;width:100vw;height:100vh;z-index:-2;pointer-events:none;background:transparent;' +
        'object-fit:' + o.fit + ';object-position:' + o.pos + ';contain:strict;' + vidFilterCss(o.blurPx, o.vr);
    }
    if (kind === 'host') {   // iframe страницы расширения: размытие и яркость — на самом iframe, остальное ему передаётся сообщением
      return 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:-2;pointer-events:none;background:transparent;color-scheme:normal;' + vidFilterCss(o.blurPx, o.vr);
    }
    return embedCss(o);
  }

  /* настройки «на лету» для проигрывателя в iframe расширения: без перезагрузки видео */
  function sendHost() {
    if (!vidFrame || !vidOpts || !vidFrame.contentWindow) return;
    try {
      const org = new URL(browser.runtime.getURL('bgvideo.html')).origin;
      vidFrame.contentWindow.postMessage({ __scc: 'vid', fit: vidOpts.fit, pos: vidOpts.pos, keep: vidOpts.keep, scroll: scrolling }, org);
    } catch (e) { /* ignore */ }
  }

  /* запасной путь: сайт не пустил видео из-за CSP (или это свой файл) — играем в iframe страницы расширения */
  function vidFallback(spec, o) {
    if (vidFell || !vidKey) return;
    vidFell = true;
    vidDrop();
    const f = document.createElement('iframe');
    f.id = VID_ID;
    f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.style.cssText = vidCss('host', o);
    f.addEventListener('load', sendHost);
    f.src = browser.runtime.getURL('bgvideo.html') + '?' + (spec.kind === 'local' ? 'l=' + spec.id : 'u=' + encodeURIComponent(spec.src)) +
      '&f=' + o.fit + '&p=' + encodeURIComponent(o.pos) + '&k=' + (o.keep ? '1' : '0');
    document.documentElement.appendChild(f);
    vidFrame = f;
  }

  /* YouTube умеет паузу по postMessage (enablejsapi=1); у VK паузы нет — гасим плеер, пока окно скрыто, и запускаем заново
     (на прокрутку VK не реагирует: перезагрузка роликa дороже, чем он стоит). */
  function embedPause(stop, hard) {
    if (!vidEl || vidEl.tagName !== 'IFRAME' || !vidSpec) return;
    if (vidSpec.kind === 'youtube') {
      try { vidEl.contentWindow.postMessage(JSON.stringify({ event: 'command', func: stop ? 'pauseVideo' : 'playVideo', args: [] }), 'https://www.youtube.com'); } catch (e) { /* ignore */ }
    } else if (vidSpec.kind === 'vk' && vidEmbedSrc) {
      const want = hard ? 'about:blank' : vidEmbedSrc;
      if (vidEl.getAttribute('src') !== want) vidEl.setAttribute('src', want);
    }
  }

  function syncVideo() {
    if (window !== window.top) return;
    const s = current.settings;
    const spec = s && s.enabled && s.bg && s.bg.enabled ? SCC.videoSpec(s.bg) : null;
    if (!spec) { if (vidKey) vidRemove(); return; }
    const fit = s.bg.size === 'contain' ? 'contain' : 'cover';
    const pos = ['center center', 'center top', 'center bottom', 'left center', 'right center'].indexOf(s.bg.position) >= 0 ? s.bg.position : 'center center';
    const vb = Math.max(0, Math.min(100, Number(s.bg.videoBlur) || 0));
    const vr = Math.max(-80, Math.min(50, Number(s.bg.videoBright) || 0));
    const blurPx = Math.round(vb * 0.4 * 10) / 10;
    const o = { fit, pos, keep: !!s.bg.videoInBackground, blurPx, vr };
    vidKeep = o.keep;
    vidPauseScroll = s.bg.videoPauseScroll !== false;
    if (!vidPauseScroll && scrolling) { scrolling = false; clearTimeout(scrollTimer); }
    /* перезагрузка видео — только при смене самого видео; размер, положение, размытие, яркость и «играть в свёрнутом» меняются «на лету» */
    if (spec.key !== vidKey) {
      vidRemove();
      vidKey = spec.key; vidSpec = spec; vidOpts = o; vidFx = JSON.stringify(o);
      if (spec.kind === 'local') {
        vidFallback(spec, o);            // свой файл читает страница расширения
      } else if (spec.kind === 'direct') {
        const v = document.createElement('video');
        v.id = VID_ID;
        v.muted = true; v.defaultMuted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
        v.preload = 'auto'; v.controls = false; v.disablePictureInPicture = true; v.disableRemotePlayback = true;
        v.setAttribute('aria-hidden', 'true'); v.tabIndex = -1;
        v.style.cssText = vidCss('direct', o);
        v.addEventListener('error', () => { if (v._dead || vidEl !== v) return; vidFallback(spec, vidOpts || o); });
        v.addEventListener('canplay', vidSync);
        document.documentElement.appendChild(v);
        vidEl = v;
        const key = spec.key;
        whenIdle(() => { if (vidEl === v && vidKey === key) { v.src = spec.url; vidSync(); } });
      } else {
        /* YouTube / VK: плеер сайта в iframe. Без звука, без управления и без разрешения на автозапуск со звуком. */
        const f = document.createElement('iframe');
        f.id = VID_ID;
        f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
        f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');   // YouTube без источника запроса отвечает ошибкой 153
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
        f.setAttribute('allow', 'encrypted-media; picture-in-picture');
        f.setAttribute('scrolling', 'no');
        f.style.cssText = vidCss(spec.kind, o);
        f.addEventListener('load', vidSync);
        document.documentElement.appendChild(f);
        vidEl = f;
        const key = spec.key;
        vidEmbedSrc = SCC.embedUrl(spec, location.origin);
        whenIdle(() => { if (vidEl === f && vidKey === key) { f.setAttribute('src', vidEmbedSrc); vidSync(); } });
      }
    } else {
      const fx = JSON.stringify(o);
      if (fx !== vidFx) {
        vidFx = fx; vidOpts = o;
        if (vidEl) vidEl.style.cssText = vidCss(spec.kind, o);
        else if (vidFrame) { vidFrame.style.cssText = vidCss('host', o); sendHost(); }
      }
    }
    if (!vidHooked) {
      vidHooked = true;
      document.addEventListener('visibilitychange', vidSync);
      if (still && still.addEventListener) still.addEventListener('change', vidSync);
    }
    const node = vidEl || vidFrame;
    if (node && !node.isConnected) document.documentElement.appendChild(node);   // SPA / document.write мог убрать элемент
    vidSync();
  }

  /* Сайт не разрешил встраивать плеер (frame-src / child-src) — переносим его в страницу расширения. */
  document.addEventListener('securitypolicyviolation', (e) => {
    if (window !== window.top || !vidSpec || !vidEl || vidEl.tagName !== 'IFRAME' || vidFell) return;
    if (!/^(frame-src|child-src)/.test(e.violatedDirective || '') || !/youtube|vk\.com|vk\.ru|vkvideo/i.test(e.blockedURI || '')) return;
    vidFallback(vidSpec, vidOpts);
  }, true);

  /* ---------- «Выбрать элемент»: показывает CSS-селектор элемента под курсором ---------- */

  function part(el) {
    let s = el.tagName.toLowerCase();
    if (el.id && !/\d{4,}/.test(el.id)) return s + '#' + CSS.escape(el.id);
    const cls = Array.from(el.classList).filter(c => !c.startsWith('scc-')).slice(0, 3);
    for (const c of cls) s += '.' + CSS.escape(c);
    return s;
  }

  function describe(el) {
    const chain = [];
    let n = el;
    for (let i = 0; i < 4 && n && n.nodeType === 1 && n !== document.body; i++, n = n.parentElement) chain.push(part(n));
    return chain.join('  <  ');
  }

  function bestSelector(el) {
    const p = part(el);
    if (p.includes('.') || p.includes('#')) return p;
    const parent = el.parentElement;
    return parent && parent !== document.body ? part(parent) + ' > ' + p : p;
  }

  function startPicker() {
    if (document.getElementById('scc-picker-root')) return;

    /* Без оверлея: слушаем события документа в capture-фазе. Так каждый фрейм (в т.ч. iframe страницы трека)
       выбирает элементы сам, а не подсвечивает iframe целиком. */
    const root = document.createElement('div');
    root.id = 'scc-picker-root';
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #ff5500;background:rgba(255,85,0,.18);z-index:2147483647;left:0;top:0;width:0;height:0;display:none;';
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;left:12px;bottom:12px;max-width:min(720px,92vw);background:#111;color:#fff;font:12px/1.5 ui-monospace,Consolas,monospace;padding:10px 12px;border-radius:8px;z-index:2147483647;pointer-events:none;white-space:pre-wrap;word-break:break-all;box-shadow:0 4px 24px rgba(0,0,0,.5);letter-spacing:0;text-transform:none;';
    const hint = 'Наведите на элемент и кликните — селектор скопируется в буфер. Esc — отмена.';
    tip.textContent = hint;
    root.append(box, tip);
    document.documentElement.appendChild(root);

    const EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'auxclick', 'dblclick'];
    let done = false;

    const targetOf = (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const el = path[0] || e.target;
      return el && el.nodeType === 1 ? el : null;
    };
    const hideVisuals = (v) => { box.style.display = v ? 'none' : 'block'; tip.style.display = v ? 'none' : 'block'; };
    const frameNote = () => (window === window.top ? '' : 'Фрейм: ' + location.href + '\n');

    function cleanup() {
      if (done) return;
      done = true;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseover', onMove, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      EVENTS.forEach(ev => document.removeEventListener(ev, block, true));
      root.remove();
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } }
    /* Фокус ушёл в iframe (кликнули там) — этот экземпляр больше не нужен. */
    function onBlur() { setTimeout(() => { if (!done && !document.hasFocus()) cleanup(); }, 50); }
    function block(e) {
      if (done) return;
      const el = targetOf(e);
      if (el && el.tagName === 'IFRAME') return;     // клик по iframe обработает сам iframe
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    }

    function onMove(e) {
      const el = targetOf(e);
      if (!el || el === document.documentElement || el === document.body) return;
      if (el.tagName === 'IFRAME') { hideVisuals(true); return; }   // дальше подсвечивает скрипт внутри iframe
      hideVisuals(false);
      const r = el.getBoundingClientRect();
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
      tip.textContent = frameNote() + describe(el);
    }

    async function onClick(e) {
      const el = targetOf(e);
      if (!el || el.tagName === 'IFRAME' || done) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const sel = bestSelector(el);
      let copied = false;
      try { await navigator.clipboard.writeText(sel); copied = true; } catch (err) { /* ниже запасной вариант */ }
      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = sel; ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
          document.documentElement.appendChild(ta); ta.select();
          copied = document.execCommand('copy');
          ta.remove();
        } catch (err) { /* ignore */ }
      }
      tip.textContent = (copied ? 'Скопировано: ' : 'Селектор: ') + sel + '\n\n' + frameNote() + 'Цепочка: ' + describe(el);
      box.remove();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseover', onMove, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      /* ещё какое-то время гасим mouseup/click, чтобы сайт не отреагировал на клик */
      setTimeout(() => { EVENTS.forEach(ev => document.removeEventListener(ev, block, true)); }, 400);
      setTimeout(() => { done = true; root.remove(); }, 7000);
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseover', onMove, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    EVENTS.forEach(ev => document.addEventListener(ev, ev === 'click' ? onClick : block, true));
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (sender && sender.id && sender.id !== browser.runtime.id) return;
    if (msg && msg.type === 'scc-pick') startPicker();
  });
})();
