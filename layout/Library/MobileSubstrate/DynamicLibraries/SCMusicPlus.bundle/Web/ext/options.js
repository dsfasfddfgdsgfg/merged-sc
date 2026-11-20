(async () => {
  'use strict';

  /* безопасная вставка разметки (через DOMParser) */
  const setHTML = (el, html) => {
    const d = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
    el.replaceChildren(...Array.from(d.body.childNodes).map((n) => document.importNode(n, true)));
  };
  const setSVG = (el, markup) => {
    const d = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + markup + '</svg>', 'image/svg+xml');
    el.replaceChildren(...Array.from(d.documentElement.childNodes).map((n) => document.importNode(n, true)));
  };

  const { DEFAULTS, COLOR_FIELDS, PRESETS, merge, HEX } = SCC;

  const stored = await browser.storage.local.get(['settings', 'assets']);
  let settings = stored.settings ? SCC.sanitizeSettings(stored.settings) : SCC.defaultSettings();
  let assets = SCC.sanitizeAssets(stored.assets);
  document.documentElement.style.setProperty('--accent', settings.colors.accent || '#ff5500');

  /* Приложение: страница открыта нативным окном; «закрыть» и действия уходят в приложение через мост */
  const APP = !!window.__sccApp;
  const EMBED = APP || (/[?&]embed=1/.test(location.search) && window.parent !== window);
  const toParent = (type, extra) => { if (APP) { try { browser.runtime.sendMessage(Object.assign({ type: 'scc-ui', action: type }, extra || {})); } catch (e) { /* ignore */ } } };
  if (EMBED) {
    document.documentElement.classList.add('embed');
    document.getElementById('close').addEventListener('click', () => toParent('close'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toParent('close'); });
  }
  const APPDEF = { siteMode: 'desktop', vpWidth: 600, tapOpen: true, tapSel: '', coverBg: false, cbBright: 55, cbBlur: 3, cbSpeed: 45, cbSat: 150,
    fpBlur: 30, fpDim: 45, fpLayout: 'auto' };
  let appCfg = Object.assign({}, APPDEF, (await browser.storage.local.get('appCfg')).appCfg || {});

  /* ---------- вспомогательное ---------- */

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  }

  
  let flashTimer;
  function flash(msg, bad) {
    const statusEl = document.getElementById('toast');
    statusEl.textContent = msg;
    statusEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => statusEl.classList.remove('show'), bad ? 5000 : 3200);
  }

  /* ---------- шрифт самой страницы настроек = выбранный в разделе «Шрифт» ---------- */

  let uiFaces = [], uiFontSig = '';
  function applyUiFont() {
    const f = settings.font || {};
    const files = SCC.activeFontFiles(settings, assets);
    const sys = String(f.system || '').replace(/["'\\{};<>\r\n]/g, '').trim();
    const sig = [f.mode, sys, f.letterSpacing, assets.fontSource, files.length, files[0] ? files[0].data.length : 0].join('|');
    if (sig === uiFontSig) return;
    uiFontSig = sig;
    for (const face of uiFaces) { try { document.fonts.delete(face); } catch (e) { /* ignore */ } }
    uiFaces = [];
    let fam = '';
    if (f.mode === 'system' && sys) fam = SCC.familyCss(sys) + ', ';
    else if (files.length) {
      for (const file of files) {
        try {
          const d = { weight: file.weight || 'normal', style: file.style || 'normal' };
          if (file.unicodeRange) d.unicodeRange = file.unicodeRange;
          const face = new FontFace('SCC UI Font', b64ToBuf(file.data), d);
          document.fonts.add(face);
          face.load().catch(() => {});
          uiFaces.push(face);
        } catch (e) { /* битый файл шрифта */ }
      }
      if (uiFaces.length) fam = '"SCC UI Font", ';
    }
    const r = document.documentElement.style;
    r.setProperty('--ui-font', fam + 'Inter, system-ui, "Segoe UI", Roboto, sans-serif');
    const ls = f.letterSpacing;
    document.body.style.letterSpacing = ls !== '' && ls != null && isFinite(Number(ls)) ? Number(ls) + 'px' : '';
  }
  function b64ToBuf(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  let saveTimer;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await browser.storage.local.set({ settings }); flash('Сохранено. Если изменения не видны — обновите страницу'); applyUiFont(); }
      catch (e) { flash('Ошибка сохранения: ' + e.message, true); }
    }, 120);
  }
  async function saveAssets() {
    try { await browser.storage.local.set({ assets }); flash('Сохранено. Если изменения не видны — обновите страницу'); }
    catch (e) { flash('Ошибка сохранения: ' + e.message, true); }
  }

  /* ---------- свой видео-файл ----------
     Лежит в storage.local кусками по 6 МБ в base64 (ключи vid_<метка>_<n>) + описание в vidmeta. Отдельно от settings / assets,
     чтобы скрипты на сайте не тянули многомегабайтный файл при каждой загрузке страницы; собирает его только страница bgvideo.html. */
  const VCH = 6 * 1024 * 1024, VMAX = 200 * 1024 * 1024;
  async function dropVideoChunks(m) {
    const keys = [];
    if (m && m.chunks > 0 && m.chunks <= 4000) for (let i = 0; i < m.chunks; i++) keys.push('vid_' + m.id + '_' + i);
    if (keys.length) await browser.storage.local.remove(keys);
  }
  async function dropVideoFile() {
    const m = (await browser.storage.local.get('vidmeta')).vidmeta;
    await dropVideoChunks(m);
    await browser.storage.local.remove('vidmeta');
  }
  async function saveVideoFile(file, progress) {
    const id = Date.now(), n = Math.ceil(file.size / VCH);
    const old = (await browser.storage.local.get('vidmeta')).vidmeta;
    try {
      for (let i = 0; i < n; i++) {
        const url = await readAsDataURL(file.slice(i * VCH, (i + 1) * VCH));
        await browser.storage.local.set({ ['vid_' + id + '_' + i]: url.slice(url.indexOf(',') + 1) });
        progress(i + 1, n);
      }
      await browser.storage.local.set({ vidmeta: { id, name: file.name.slice(0, 120), type: file.type || '', size: file.size, chunks: n } });
    } catch (e) {
      try { await dropVideoChunks({ id, chunks: n }); } catch (e2) { /* ignore */ }
      throw e;
    }
    if (old && old.id !== id) { try { await dropVideoChunks(old); } catch (e) { /* ignore */ } }
    return id;
  }
  /* проверяем, что браузер вообще открывает этот файл (кодек), до сохранения */
  function probeVideo(file) {
    return new Promise((res) => {
      const v = document.createElement('video');
      const u = URL.createObjectURL(file);
      const done = (ok) => { clearTimeout(t); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(u); res(ok); };
      const t = setTimeout(() => done(false), 10000);
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => done(v.videoWidth > 0);
      v.onerror = () => done(false);
      v.src = u;
    });
  }

  function readAsDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  function bufToB64(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function imageToDataUrl(file) {
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') return readAsDataURL(file);
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * k));
    cv.height = Math.max(1, Math.round(bmp.height * k));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/webp', 0.9));
    return readAsDataURL(blob);
  }

  async function loadGoogleFont(family, onStatus) {
    const fam = family.trim().split(/\s+/).map(encodeURIComponent).join('+');
    const urls = [
      'https://fonts.googleapis.com/css2?family=' + fam + ':wght@400;700&display=swap',
      'https://fonts.googleapis.com/css2?family=' + fam + '&display=swap',
    ];
    let css = '';
    for (const u of urls) {
      const r = await fetch(u);
      if (r.ok) { css = await r.text(); break; }
    }
    if (!css) throw new Error('Шрифт «' + family + '» не найден в Google Fonts');

    const blocks = [];
    for (const m of css.matchAll(/(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
      const body = m[2];
      const url = (/url\(([^)]+)\)/.exec(body) || [])[1];
      if (!url) continue;
      blocks.push({
        subset: (m[1] || '').trim(),
        url: url.replace(/["']/g, ''),
        weight: ((/font-weight:\s*([^;]+);/.exec(body) || [])[1] || '400').trim(),
        style: ((/font-style:\s*([^;]+);/.exec(body) || [])[1] || 'normal').trim(),
        range: ((/unicode-range:\s*([^;]+);/.exec(body) || [])[1] || '').trim(),
      });
    }
    const WANT = ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext'];
    let pick = blocks.filter(b => WANT.includes(b.subset));
    if (!pick.length) pick = blocks.slice(0, 24);
    if (!pick.length) throw new Error('Не удалось разобрать ответ Google Fonts');

    const files = [];
    let i = 0;
    for (const b of pick) {
      onStatus('Загрузка ' + (++i) + ' из ' + pick.length + '…');
      const r = await fetch(b.url);
      if (!r.ok) throw new Error('Не удалось скачать файл шрифта');
      const file = { weight: b.weight, style: b.style, data: bufToB64(await r.arrayBuffer()) };
      if (b.range) file.unicodeRange = b.range;
      files.push(file);
    }
    return files;
  }

  /* ---------- строительные блоки интерфейса ---------- */

  function setAccent() {
    document.documentElement.style.setProperty('--accent', settings.colors.accent || '#ff5500');
  }

  function sec(title, hint, ...rows) {
    return h('section', { class: 'sec' }, title ? h('h3', { class: 'sec-t', text: title }) : null,
      hint ? h('p', { class: 'sec-hint' }, hint) : null, ...rows);
  }

  function setRow(label, desc, ...controls) {
    return h('div', { class: 'set' },
      h('div', { class: 'set-l' }, h('div', { class: 'set-n', text: label }), desc ? h('div', { class: 'set-d', text: desc }) : null),
      h('div', { class: 'set-c' }, ...controls));
  }

  function toggle(get, set) {
    const cb = h('input', { type: 'checkbox', checked: !!get(), onchange: () => { set(cb.checked); saveSettings(); } });
    const el = h('label', { class: 'switch' }, cb, h('span', { class: 'track' }));
    el.cb = cb;
    return el;
  }

  function seg(options, get, set) {
    const box = h('div', { class: 'seg' });
    const paint = () => [...box.children].forEach((b, i) => b.classList.toggle('on', options[i][0] === get()));
    options.forEach(([v, t]) => box.append(h('button', { type: 'button', text: t, onclick: () => { set(v); paint(); saveSettings(); } })));
    paint();
    return box;
  }

  function sliderRow(label, desc, get, set, min, max, step, unit) {
    const out = h('span', { class: 'val', text: get() + unit });
    const inp = h('input', {
      type: 'range', min, max, step, value: get(),
      oninput: () => { set(Number(inp.value)); out.textContent = inp.value + unit; saveSettings(); },
    });
    return setRow(label, desc, h('div', { class: 'sl' }, inp, out));
  }

  function flagRow(label, desc, key) {
    return setRow(label, desc, toggle(() => settings.flags[key], v => { settings.flags[key] = v; }));
  }

  /* ---------- страницы ---------- */

  function pageMain() {
    return [
      sec('Расширение', null,
        setRow('Кастомизация включена', 'Общий выключатель — отключает все изменения на SoundCloud',
          toggle(() => settings.enabled, v => { settings.enabled = v; }))),
      sec('Подсветка при наведении', 'Строка трека в списках (чарты, плейлисты, очередь) при наведении курсора.',
        flagRow('Подсвечивать цветом акцента', 'Вместо серого фона — акцентный цвет', 'hoverAccent'),
        sliderRow('Сила подсветки', '0% — без подсветки, 100% — чистый акцентный цвет',
          () => settings.flags.hoverStrength, v => { settings.flags.hoverStrength = v; }, 0, 100, 1, '%')),
      sec('Страница', null,
        flagRow('Скрыть панель «Artist tools»', 'Рекламный блок с кнопками Amplify, Replace, Distribute, Master', 'hideArtistTools')),
      sec('Инструменты', null,
        setRow('Выбрать элемент на странице', EMBED
          ? 'Панель закроется — наведите курсор на нужное место сайта и кликните: CSS-селектор скопируется в буфер (для раздела «Свой CSS»). Esc — отмена.'
          : 'Работает в панели поверх SoundCloud: откройте soundcloud.com и нажмите на значок расширения.',
        h('button', { class: 'btn', type: 'button', text: 'Выбрать', disabled: !EMBED, onclick: () => toParent('pick') })),
        setRow('Приветствие', 'Показать стартовый экран и подсказку про значок расширения ещё раз',
          h('button', { class: 'btn', type: 'button', text: 'Показать', disabled: !EMBED, onclick: () => toParent('welcome') }))),
    ];
  }

  function pageUi() {
    return [
      sec('Панель настроек', 'Как выглядит окно настроек поверх сайта. Изменения видны сразу, пока панель открыта.',
        sliderRow('Прозрачность панели', '100% — сплошная, меньше — сквозь неё виден сайт',
          () => 100 - settings.ui.opacity, v => { settings.ui.opacity = 100 - v; }, 0, 60, 1, '%'),
        sliderRow('Размытие за панелью', 'Матовое стекло', () => settings.ui.blur, v => { settings.ui.blur = v; }, 0, 40, 1, 'px'),
        sliderRow('Затемнение сайта', 'Тонировка цветом акцента под панелью', () => settings.ui.dim, v => { settings.ui.dim = v; }, 0, 100, 1, '%'),
        sliderRow('Ширина панели', null, () => settings.ui.width, v => { settings.ui.width = v; }, 640, 1300, 10, 'px')),
      sec('Цвет панели', null,
        setRow('Подстраивается под акцент', 'Цвет панели, затемнение и подсветка берутся из цвета «Акцент» в разделе «Цвета»',
          h('button', { class: 'btn', type: 'button', text: 'К цветам', onclick: () => goto('colors') }))),
    ];
  }

  function pageThemes() {
    const grid = h('div', { class: 'themes' });
    PRESETS.forEach(p => {
      const b = h('button', {
        class: 'theme' + (settings.presetName === p.name ? ' on' : ''), type: 'button',
        onclick: () => {
          settings.colors = Object.assign({}, p.colors);
          settings.flags = Object.assign({}, settings.flags, p.flags);
          settings.presetName = p.name;
          if (p.cardOpacity != null) settings.bg.cardOpacity = p.cardOpacity;
          setAccent();
          saveSettings();
          renderPage();
        },
      }, h('span', { class: 'pair' }, h('i', { style: 'background:' + p.swatch[1] }), h('i', { style: 'background:' + p.swatch[2] })), p.name);
      grid.append(b);
    });
    return [sec('Готовые темы', 'Один клик задаёт все цвета сразу. Дальше любой цвет можно поправить в разделе «Цвета». Шрифт и фон-картинка не затрагиваются.', grid)];
  }

  function colorRow(key, label, def) {
    const cur = settings.colors[key];
    const picker = h('input', { type: 'color', class: 'circle', value: cur || def });
    const hex = h('input', { type: 'text', class: 'hex', value: cur || def, maxlength: 7, spellcheck: false });
    const tg = toggle(() => !!cur, () => {});
    const row = h('div', { class: 'set' + (cur ? '' : ' off') },
      h('div', { class: 'set-l' }, h('div', { class: 'set-n', text: label })),
      h('div', { class: 'set-c' }, tg, hex, picker));
    const cb = tg.cb;
    const commit = () => {
      if (cb.checked) settings.colors[key] = picker.value; else delete settings.colors[key];
      row.classList.toggle('off', !cb.checked);
      if (key === 'accent') setAccent();
      saveSettings();
    };
    cb.onchange = commit;
    picker.addEventListener('input', () => { hex.value = picker.value; cb.checked = true; commit(); });
    hex.addEventListener('input', () => {
      let v = hex.value.trim();
      if (v && v[0] !== '#') v = '#' + v;
      if (HEX.test(v)) { picker.value = v.toLowerCase(); cb.checked = true; commit(); }
    });
    return row;
  }

  function pageColors() {
    const out = [h('p', { class: 'sec-hint' }, 'Включите переключатель у цвета, который хотите заменить. Без него остаётся оригинальный цвет SoundCloud.')];
    COLOR_FIELDS.forEach((g, i) => {
      out.push(sec(g.group, null, ...g.items.map(([k, l, d]) => colorRow(k, l, d)),
        i === 0 ? [flagRow('Canvas-сцена под акцент', 'Страница трека: фоновая canvas-сцена', 'sceneFollowsAccent'),
          flagRow('Градиентные верхние плашки', 'Ник при прокрутке профиля, шапка «Лайки»', 'styledTopBars')] : null));
      if (i === 0) {
        out.push(sec('Карточки', 'Карточки треков, боковые блоки, комментарии. Работает при включённом цвете «Фон карточек, меню и панелей» — и с картинкой фона, и без неё.',
          sliderRow('Непрозрачность карточек', '0% — карточки прозрачные, 100% — сплошные',
            () => settings.bg.cardOpacity, v => { settings.bg.cardOpacity = v; }, 0, 100, 1, '%')));
      }
    });
    return out;
  }

  /* ---------- шрифты: вкладки категорий и плитки «Aa» ---------- */

  /* System — установленные в системе (+ встроенный Pixelify Sans). Остальные вкладки — Google Fonts с кириллицей:
     шрифт скачивается один раз по клику и дальше хранится внутри расширения. */
  const FONT_TABS = [
    ['system', 'System', [['Default', 'default'], ['Inter'], ['Arial'], ['Segoe UI'], ['Roboto'], ['Helvetica Neue'], ['Tahoma'], ['Verdana'],
      ['San Francisco', '-apple-system'], ['Calibri'], ['Lucida Sans'], ['Arial Black'], ['Arial Narrow'], ['Segoe UI Light'],
      ['Segoe UI Semibold'], ['Pixelify Sans', 'pixel']]],
    ['modern', 'Modern', ['Montserrat', 'Nunito', 'Raleway', 'Manrope', 'Rubik', 'Lexend', 'Jost', 'Unbounded', 'Golos Text', 'Onest', 'Commissioner']],
    ['serif', 'Serif', ['Playfair Display', 'Merriweather', 'Lora', 'PT Serif', 'Cormorant Garamond', 'Noto Serif', 'EB Garamond', 'Bitter', 'Spectral', 'Literata', 'Source Serif 4', 'Old Standard TT']],
    ['mono', 'Mono', ['JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Roboto Mono', 'Source Code Pro', 'PT Mono', 'Ubuntu Mono', 'Cousine', 'Anonymous Pro', 'Fira Mono', 'Noto Sans Mono']],
    ['hand', 'Hand', ['Caveat', 'Marck Script', 'Pacifico', 'Kalam', 'Amatic SC', 'Neucha', 'Bad Script', 'Lobster', 'Pangolin']],
    ['deco', 'Deco', ['Bebas Neue', 'Oswald', 'Russo One', 'Yeseva One', 'Rubik Mono One', 'Ruslan Display', 'Stalinist One', 'Days One', 'Montserrat Alternates', 'Philosopher', 'Kelly Slab']],
    ['game', 'Game', ['Press Start 2P', 'VT323', 'Orbitron', 'Exo 2', 'Oxanium', 'Play', 'Jura']],
  ];
  let fontTab = null;
  const gfLoaded = new Set();
  let pxPreview = false;

  function tilesOf(tab) {
    if (tab[0] === 'system') {
      return tab[2].map(([name, v]) => v === 'default' ? { name, kind: 'default' } : v === 'pixel' ? { name, kind: 'pixel' }
        : { name, kind: 'system', value: v || name });
    }
    return tab[2].map(name => ({ name, kind: 'google', value: name }));
  }

  function tileFamily(t) {
    if (t.kind === 'default') return 'inherit';
    if (t.kind === 'pixel') return '"SCC Preview Pixel"';
    return SCC.familyCss(t.value);
  }

  function isTileOn(t) {
    const f = settings.font;
    if (t.kind === 'default') return f.mode === 'default';
    if (t.kind === 'pixel') return f.mode === 'pixel';
    if (t.kind === 'system') return f.mode === 'system' && f.system === t.value;
    return f.mode === 'google' && f.google === t.value;
  }

  /* Шрифт Pixelify Sans лежит внутри расширения; кладём его в хранилище как обычный файл шрифта. */
  async function applyPixel() {
    try {
      const r = await fetch(browser.runtime.getURL('fonts/pixelify-sans.ttf'));
      if (!r.ok) throw new Error('не найден файл шрифта');
      assets.fontFiles = [{ weight: '100 900', style: 'normal', data: bufToB64(await r.arrayBuffer()) }];
      assets.fontSource = 'pixel';
      await saveAssets();
      saveSettings();
    } catch (e) { flash('Не удалось загрузить шрифт: ' + e.message, true); }
  }

  function ensurePreviews(tab) {
    if (tab[0] === 'system') {
      if (!pxPreview) {
        pxPreview = true;
        try {
          const ff = new FontFace('SCC Preview Pixel', 'url(' + browser.runtime.getURL('fonts/pixelify-sans.ttf') + ')');
          document.fonts.add(ff); ff.load().catch(() => {});
        } catch (e) { /* ignore */ }
      }
    } else if (!gfLoaded.has(tab[0])) {
      gfLoaded.add(tab[0]);
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?' + tab[2].map(n => 'family=' + encodeURIComponent(n).replace(/%20/g, '+')).join('&') + '&text=Aa&display=swap';
      document.head.append(l);
    }
  }

  function pageFont() {
    const note = h('div', { class: 'note' });
    if (settings.font.mode === 'pixel' && assets.fontSource !== 'pixel') applyPixel();

    if (!fontTab) {
      const f = settings.font;
      fontTab = f.mode === 'google' ? ((FONT_TABS.find(t => t[0] !== 'system' && t[2].includes(f.google)) || FONT_TABS[0])[0]) : 'system';
    }

    const grid = h('div', { class: 'ftiles' });
    const tabs = h('div', { class: 'ftabs' });

    const paintTiles = () => [...grid.children].forEach(b => b.classList.toggle('on', isTileOn(b._tile)));

    async function pick(t, btn) {
      const f = settings.font;
      if (t.kind === 'default') { f.mode = 'default'; }
      else if (t.kind === 'system') { f.mode = 'system'; f.system = t.value; }
      else if (t.kind === 'pixel') { f.mode = 'pixel'; paintTiles(); saveSettings(); await applyPixel(); return; }
      else {
        btn.classList.add('busy');
        note.textContent = 'Загрузка «' + t.name + '»…';
        try {
          const files = await loadGoogleFont(t.value, x => { note.textContent = '«' + t.name + '»: ' + x; });
          assets.fontFiles = files; assets.fontSource = 'google';
          f.mode = 'google'; f.google = t.value;
          await saveAssets();
          note.textContent = '';
        } catch (e) { note.textContent = 'Ошибка: ' + e.message; btn.classList.remove('busy'); return; }
        btn.classList.remove('busy');
      }
      paintTiles(); saveSettings();
    }

    function drawGrid() {
      const tab = FONT_TABS.find(t => t[0] === fontTab) || FONT_TABS[0];
      ensurePreviews(tab);
      grid.replaceChildren(...tilesOf(tab).map(t => {
        const b = h('button', { type: 'button', class: 'ftile', title: t.name, onclick: () => pick(t, b) },
          h('span', { class: 'aa', text: 'Aa', style: 'font-family:' + tileFamily(t) }), h('span', { class: 'fn', text: t.name }));
        b._tile = t;
        return b;
      }));
      paintTiles();
      [...tabs.children].forEach((b, i) => b.classList.toggle('on', FONT_TABS[i][0] === tab[0]));
    }

    FONT_TABS.forEach(t => tabs.append(h('button', { type: 'button', class: 'ftab', text: t[1], onclick: () => { fontTab = t[0]; drawGrid(); } })));

    /* свой файл шрифта — иконка справа от вкладок */
    const fileInp = h('input', {
      type: 'file', accept: '.ttf,.otf,.woff,.woff2', style: 'display:none',
      onchange: async () => {
        const f = fileInp.files && fileInp.files[0];
        if (!f) return;
        try {
          assets.fontFiles = [{ weight: '100 900', style: 'normal', data: bufToB64(await f.arrayBuffer()) }];
          assets.fontSource = 'file';
          settings.font.fileName = f.name; settings.font.mode = 'file';
          await saveAssets(); saveSettings(); paintTiles();
          fileNote.textContent = 'Загружен: ' + f.name;
        } catch (e) { flash('Ошибка: ' + e.message, true); }
      },
    });
    const fileNote = h('div', { class: 'set-d', text: assets.fontSource === 'file' && settings.font.fileName ? 'Загружен: ' + settings.font.fileName : 'Файл не выбран' });
    const upBtn = h('button', { type: 'button', class: 'fup', title: 'Загрузить свой файл шрифта (.ttf, .otf, .woff, .woff2)', onclick: () => fileInp.click() },
      (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '18'); s.setAttribute('height', '18');
        setSVG(s, '<path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'); return s; })());

    drawGrid();

    const card = h('div', { class: 'fcat' },
      h('div', { class: 'fcat-head' }, h('div', { class: 'fcat-title', text: 'Категория' }), h('div', { class: 'fcat-right' }, tabs, upBtn, fileInp)),
      grid);

    /* свои названия */
    const sysInp = h('input', {
      type: 'text', class: 'wide', value: settings.font.mode === 'system' ? settings.font.system : '', placeholder: 'Например: Comic Sans MS, Consolas',
      oninput: () => { settings.font.mode = 'system'; settings.font.system = sysInp.value; paintTiles(); saveSettings(); },
    });
    const gInp = h('input', { type: 'text', class: 'wide', value: settings.font.google, placeholder: 'Например: Comfortaa, Inter' });
    const gBtn = h('button', {
      class: 'btn primary', type: 'button', text: 'Скачать и применить',
      onclick: async () => {
        const name = gInp.value.trim();
        if (!name) return;
        gBtn.disabled = true;
        note.textContent = 'Загрузка…';
        try {
          const files = await loadGoogleFont(name, t => { note.textContent = t; });
          assets.fontFiles = files; assets.fontSource = 'google';
          settings.font.mode = 'google'; settings.font.google = name;
          await saveAssets(); saveSettings(); paintTiles();
          note.textContent = 'Готово: «' + name + '» (' + files.length + ' файл.) применён.';
        } catch (e) { note.textContent = 'Ошибка: ' + e.message; }
        finally { gBtn.disabled = false; }
      },
    });

    const ls = h('input', {
      type: 'number', step: '0.1', min: '-3', max: '10', style: 'width:90px',
      value: settings.font.letterSpacing, placeholder: '0',
      oninput: () => { settings.font.letterSpacing = ls.value; saveSettings(); },
    });

    return [
      sec('Шрифт', 'Применяется на всём SoundCloud и на этой странице настроек.', card, note),
      sec('Свой шрифт', null,
        setRow('Системный по названию', 'Должно точно совпадать с названием шрифта в системе', sysInp),
        setRow('Google Fonts по названию', 'Скачивается один раз и хранится внутри расширения', gInp, gBtn),
        setRow('Файл шрифта', null, h('button', { class: 'btn', type: 'button', text: 'Выбрать файл…', onclick: () => fileInp.click() })),
        h('div', { class: 'set col' }, fileNote)),
      sec('Размер', null, sliderRow('Размер шрифта', 'Масштаб текста на SoundCloud: 100% — как есть.', () => settings.font.size == null ? 100 : settings.font.size, v => { settings.font.size = v; }, 70, 200, 5, '%')),
      sec('Интервал', null, setRow('Межбуквенный интервал', 'В пикселях, пусто — как есть', ls)),
    ];
  }

  function pageBg() {
    const preview = h('div', { class: 'preview' });
    const refreshPreview = () => {
      const src = assets.bgImage || settings.bg.url;
      preview.textContent = src ? '' : 'Картинка не выбрана';
      preview.style.backgroundImage = src ? 'url("' + String(src).replace(/"/g, '%22') + '")' : '';
    };
    const en = toggle(() => settings.bg.enabled, v => { settings.bg.enabled = v; });
    const urlInp = h('input', {
      type: 'text', class: 'wide', value: settings.bg.url, placeholder: 'https://…',
      oninput: () => { settings.bg.url = urlInp.value.trim(); saveSettings(); refreshPreview(); },
    });
    const bgNote = h('div', { class: 'set-d', text: assets.bgName ? 'Загружен: ' + assets.bgName : 'Файл не выбран' });
    const fInp = h('input', {
      type: 'file', accept: 'image/*', style: 'display:none',
      onchange: async () => {
        const f = fInp.files && fInp.files[0];
        if (!f) return;
        try {
          assets.bgImage = await imageToDataUrl(f);
          assets.bgName = f.name;
          bgNote.textContent = 'Загружен: ' + f.name;
          settings.bg.enabled = true;
          en.cb.checked = true;
          await saveAssets();
          saveSettings();
          refreshPreview();
        } catch (e) { flash('Не удалось загрузить картинку: ' + e.message, true); }
        fInp.value = '';
      },
    });
    const pickBtn = h('button', { class: 'btn', type: 'button', text: 'Выбрать файл…', onclick: () => fInp.click() });
    const clearBtn = h('button', {
      class: 'btn', type: 'button', text: 'Убрать',
      onclick: async () => {
        delete assets.bgImage; delete assets.bgName; bgNote.textContent = 'Файл не выбран';
        settings.bg.url = ''; urlInp.value = '';
        await saveAssets(); saveSettings(); refreshPreview();
      },
    });
    const overlayColor = h('input', {
      type: 'color', class: 'circle', value: settings.bg.overlayColor,
      oninput: () => { settings.bg.overlayColor = overlayColor.value; saveSettings(); },
    });
    refreshPreview();

    /* видео-фон: ссылка (файл / YouTube / VK) или свой файл; проверка сразу при вводе */
    const vNote = h('div', { class: 'set-d' });
    const vFileNote = h('div', { class: 'set-d' });
    const checkVideo = () => {
      const b = settings.bg;
      const v = (b.videoUrl || '').trim();
      const fileOn = b.videoSource === 'file' && b.videoFileId > 0;
      vFileNote.textContent = b.videoFileId > 0 && b.videoFileName
        ? 'Загружен: ' + b.videoFileName + (fileOn ? ' (используется)' : ' (не используется — активна ссылка)') : 'Файл не выбран';
      if (fileOn) { vNote.textContent = 'Сейчас играет свой файл. Ссылка ниже не используется, пока вы не уберёте файл или не вставите новую ссылку.'; return; }
      if (!v) { vNote.textContent = 'Ссылка не задана — видео не используется.'; return; }
      const sp = SCC.videoSpec(b);
      if (!sp) { vNote.textContent = 'Ссылка не подходит.'; return; }
      if (sp.kind === 'youtube') vNote.textContent = 'YouTube: видео принято. Играет без звука. Если вместо видео ошибка — автор запретил встраивание этого ролика, возьмите другой.';
      else if (sp.kind === 'vk') vNote.textContent = 'VK: видео принято. Играет без звука.' + (sp.hash ? '' : ' Если видео не открывается — во VK нажмите «Поделиться» → «Экспортировать» и вставьте сюда код вставки целиком: в нём есть ключ доступа.');
      else vNote.textContent = 'Ссылка принята. Видео появится на сайте (включите «Включить свой фон»).';
    };
    const badLink = (raw) => {
      if (/^https?:\/\/(www\.|m\.)?(vimeo\.com|rutube\.ru|tiktok\.com)/i.test(raw)) return 'Vimeo, Rutube и TikTok не поддерживаются. Подойдёт прямая ссылка на файл (.mp4 / .webm), YouTube, VK или свой файл.';
      if (/^https?:\/\/([\w-]+\.)?(youtube\.com|youtu\.be|vk\.com|vk\.ru|vkvideo\.ru)/i.test(raw)) return 'Не удалось распознать ссылку. Нужна ссылка на конкретное видео: youtube.com/watch?v=…, youtu.be/…, vk.com/video…';
      return 'Ссылка должна начинаться с https:// и вести на видеофайл, YouTube или VK.';
    };
    const videoInp = h('input', {
      type: 'text', class: 'wide', value: settings.bg.videoUrl || '', placeholder: 'https://…/video.mp4, ссылка YouTube или VK',
      oninput: () => {
        const raw = SCC.extractVideoInput(videoInp.value);       // можно вставить и код вставки <iframe …>
        if (raw !== videoInp.value.trim()) videoInp.value = raw;
        settings.bg.videoUrl = SCC.parseVideo(raw) ? SCC.safeVideoUrl(raw) : '';   // в настройки попадает только допустимая ссылка
        if (settings.bg.videoUrl) { settings.bg.videoSource = 'url'; settings.bg.enabled = true; en.cb.checked = true; }   // видео включается сразу, без отдельного «Включить фон»
        checkVideo();
        if (raw && !settings.bg.videoUrl) vNote.textContent = badLink(raw);
        if (!raw || settings.bg.videoUrl) saveSettings();
      },
    });
    const vFileInp = h('input', {
      type: 'file', accept: 'video/mp4,video/webm,video/ogg,video/*', style: 'display:none',
      onchange: async () => {
        const f = vFileInp.files && vFileInp.files[0];
        vFileInp.value = '';
        if (!f) return;
        if (!/^video\//i.test(f.type) && !/\.(mp4|m4v|webm|ogv|ogg|mov)$/i.test(f.name)) { flash('Это не видеофайл', true); return; }
        if (f.size > VMAX) { flash('Файл больше 200 МБ — возьмите короче или сожмите его', true); return; }
        pickV.disabled = true;
        try {
          vFileNote.textContent = 'Проверяю файл…';
          if (!(await probeVideo(f))) throw new Error('браузер не открывает этот файл (кодек). Лучше всего подходит mp4 (H.264) или webm');
          const id = await saveVideoFile(f, (i, n) => { vFileNote.textContent = 'Сохраняю файл… ' + Math.round(i / n * 100) + '%'; });
          settings.bg.videoSource = 'file'; settings.bg.videoFileId = id; settings.bg.videoFileName = f.name.slice(0, 120).replace(/[<>]/g, '');
          settings.bg.enabled = true; en.cb.checked = true;
          saveSettings();
        } catch (e) { flash('Не удалось загрузить видео: ' + e.message, true); }
        finally { pickV.disabled = false; checkVideo(); }
      },
    });
    const pickV = h('button', { class: 'btn', type: 'button', text: 'Выбрать файл…', onclick: () => vFileInp.click() });
    const clearV = h('button', {
      class: 'btn', type: 'button', text: 'Убрать',
      onclick: async () => {
        settings.bg.videoSource = 'url'; settings.bg.videoFileId = 0; settings.bg.videoFileName = '';
        saveSettings(); checkVideo();
        try { await dropVideoFile(); } catch (e) { /* ignore */ }
      },
    });
    const videoScroll = toggle(() => settings.bg.videoPauseScroll !== false, v => { settings.bg.videoPauseScroll = v; });
    const videoKeep = toggle(() => settings.bg.videoInBackground, v => { settings.bg.videoInBackground = v; });
    checkVideo();
    /* размытие и яркость на видео работают на каждом кадре — предупреждаем, когда они включены */
    const loadNote = h('div', { class: 'set-d' });
    const refreshLoad = () => {
      const on = (settings.bg.videoBlur || 0) > 0 || (settings.bg.videoBright || 0) !== 0;
      loadNote.textContent = on
        ? '⚠ Размытие и яркость пересчитываются на каждом кадре видео и могут заметно нагрузить видеокарту и процессор, особенно на слабых ПК и при высоком разрешении видео. Если сайт начал тормозить — верните оба ползунка на 0%.'
        : 'Размытие и яркость видео по умолчанию выключены (0%). Если их включить, они могут нагрузить компьютер — это касается именно видео-фона.';
      loadNote.style.color = on ? '#ffb454' : '';
    };
    refreshLoad();

    return [
      sec('Видео-фон', 'Вместо картинки можно поставить видео: по прямой ссылке (.mp4 / .webm), ссылку на YouTube или VK, либо свой файл. Видео играет без звука по кругу и экономит ресурсы: когда окно свёрнуто или закрыто другим окном, оно стоит на паузе. Для минимальной нагрузки берите файл до 1080p (для фона хватает и 720p), 30 к/с, формат H.264 или VP9 с небольшим битрейтом. Видео 4K сильно грузит компьютер — сайт будет тормозить.',
        setRow('Ссылка на видео', 'Прямая ссылка на файл, YouTube или VK', videoInp),
        setRow('Или свой видео-файл', 'Хранится внутри расширения, до 200 МБ. Лучше mp4 (H.264) или webm', pickV, clearV, vFileInp),
        h('div', { class: 'set col' }, vFileNote),
        h('div', { class: 'set col' }, vNote),
        setRow('Пауза при прокрутке', 'Пока страницу крутят, видео стоит на паузе — сайт меньше лагает. Рекомендуется оставить включённым.', videoScroll),
        setRow('Играть, когда окно свёрнуто', 'Выключено — видео ставится на паузу и не грузит процессор и видеокарту. Включите, если нужно, чтобы оно не прерывалось.', videoKeep),
        sliderRow('Размытие видео', null, () => settings.bg.videoBlur, v => { settings.bg.videoBlur = v; refreshLoad(); }, 0, 100, 1, '%'),
        sliderRow('Яркость видео', 'Изменение относительно оригинала: 0% — без изменений, минус — темнее, плюс — ярче.', () => settings.bg.videoBright, v => { settings.bg.videoBright = v; refreshLoad(); }, -80, 50, 1, '%'),
        h('div', { class: 'set col' }, loadNote),
        h('div', { class: 'set col' }, h('div', { class: 'set-d', text: 'К видео также применяются «Размер», «Положение» и затемнение. Видео работает и на странице трека (внутри iframe). Если в системе включено «Уменьшить движение», видео остановится само. Картинка из раздела ниже показывается, пока видео загружается.' }))),
      sec('Фон-картинка', 'Картинка ставится на весь сайт. Чтобы текст читался, используйте затемнение и полупрозрачные карточки (включите цвет «Фон карточек» в разделе «Цвета»).',
        setRow('Включить свой фон', null, en),
        h('div', { class: 'set col' }, preview),
        setRow('Файл картинки', null, pickBtn, clearBtn, fInp),
        h('div', { class: 'set col' }, bgNote),
        setRow('Или ссылка на картинку', null, urlInp)),
      sec('Расположение', null,
        setRow('Размер', null, seg([['cover', 'Заполнить'], ['contain', 'Вписать'], ['repeat', 'Плиткой']], () => settings.bg.size, v => { settings.bg.size = v; })),
        setRow('Положение', null, seg([['center center', 'Центр'], ['center top', 'Верх'], ['center bottom', 'Низ'], ['left center', 'Лево'], ['right center', 'Право']], () => settings.bg.position, v => { settings.bg.position = v; })),
        flagLike('Не прокручивать вместе со страницей', () => settings.bg.fixed, v => { settings.bg.fixed = v; })),
      sec('Эффекты', null,
        sliderRow('Размытие', null, () => settings.bg.blur, v => { settings.bg.blur = v; }, 0, 40, 1, 'px'),
        sliderRow('Яркость', null, () => settings.bg.brightness, v => { settings.bg.brightness = v; }, 20, 150, 1, '%'),
        setRow('Цвет затемнения', null, overlayColor),
        sliderRow('Сила затемнения', null, () => settings.bg.overlayOpacity, v => { settings.bg.overlayOpacity = v; }, 0, 90, 1, '%')),
    ];
  }

  function flagLike(label, get, set) { return setRow(label, null, toggle(get, set)); }

  function pageCss() {
    const ta = h('textarea', {
      spellcheck: false,
      placeholder: '/* Любой свой CSS. Он применяется последним и перебивает всё остальное. */\n.soundTitle__title { font-size: 20px !important; }',
      oninput: () => { settings.customCss = ta.value; saveSettings(); },
    });
    ta.value = settings.customCss;
    return [sec('Свой CSS', 'Для всего, чего нет в настройках. Названия классов SoundCloud могут меняться — чтобы узнать нужный, откройте SoundCloud, откройте «Основные» → «Выбрать элемент на странице» и кликните по нужному месту сайта: селектор скопируется в буфер.',
      h('div', { class: 'set col' }, ta))];
  }

  function pageBackup() {
    const note = h('div', { class: 'note' });
    const importInp = h('input', {
      type: 'file', accept: 'application/json,.json', style: 'display:none',
      onchange: async () => {
        const f = importInp.files && importInp.files[0];
        importInp.value = '';
        if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          if (!data || typeof data !== 'object' || !data.settings) throw new Error('это не файл бэкапа расширения');
          if (f.size > 80 * 1024 * 1024) throw new Error('файл слишком большой');
          const next = SCC.sanitizeSettings(data.settings);
          /* свой CSS из чужого файла может запрашивать внешние адреса (так можно следить за пользователем) — спрашиваем */
          if (SCC.cssHasExternal(next.customCss) &&
              !confirm('В файле есть «Свой CSS» с внешними адресами (@import или url(http…)). Через них сторонний сервер может узнать, что вы открыли SoundCloud.\n\nИмпортировать этот CSS? «Отмена» — импорт без него.')) {
            next.customCss = '';
          }
          /* свой видео-файл в резервную копию не входит: оставляем его, только если он тот же, что лежит в расширении */
          if (next.bg.videoSource === 'file') {
            const vm = (await browser.storage.local.get('vidmeta')).vidmeta;
            if (!(vm && vm.id === next.bg.videoFileId)) { next.bg.videoSource = 'url'; next.bg.videoFileId = 0; next.bg.videoFileName = ''; }
          }
          settings = next;
          assets = SCC.sanitizeAssets(data.assets);
          await browser.storage.local.set({ settings, assets });
          setAccent(); applyUiFont(); renderPage();
          flash('Импортировано');
        } catch (e) { note.textContent = 'Ошибка импорта: ' + e.message; }
      },
    });
    return [sec('Резервная копия', 'Экспорт сохраняет все настройки вместе с картинкой фона и шрифтом в один файл. Свой видео-файл в копию не входит.',
      setRow('Экспорт и импорт', null,
        h('button', {
          class: 'btn', type: 'button', text: 'Экспорт в файл',
          onclick: () => {
            if (APP) { toParent('export', { name: 'soundcloud-customizer-backup.json', text: JSON.stringify({ version: 1, settings, assets }) }); return; }
            const blob = new Blob([JSON.stringify({ version: 1, settings, assets })], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: 'soundcloud-customizer-backup.json' });
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          },
        }),
        h('button', { class: 'btn', type: 'button', text: 'Импорт из файла', onclick: () => importInp.click() }),
        importInp),
      setRow('Сбросить всё', 'Настройки, картинка фона, видео-файл и шрифт', h('button', {
        class: 'btn danger', type: 'button', text: 'Сбросить',
        onclick: async () => {
          if (!confirm('Сбросить все настройки, картинку фона и шрифт?')) return;
          await browser.storage.local.remove(['settings', 'assets']);
          try { await dropVideoFile(); } catch (e) { /* ignore */ }
          settings = SCC.defaultSettings();
          assets = {};
          setAccent(); applyUiFont(); renderPage();
          flash('Сброшено');
        },
      })),
      note)];
  }

  /* ---------- навигация ---------- */

  const ICONS = {
    ui: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14 4v16"/><path d="M17 9h1M17 12h1"/>',
    main: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    themes: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 1.5-2-.6-1.2.2-2.5 1.6-2.5H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
    colors: '<path d="M12 3s6 6.2 6 10.5a6 6 0 0 1-12 0C6 9.2 12 3 12 3z"/>',
    app: '<rect x="7" y="3" width="10" height="18" rx="2.6"/><path d="M10.5 17.5h3"/>',
    font: '<path d="M5 19 12 5l7 14M8.5 14h7"/>',
    bg: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    css: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>',
    backup: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  };

  /* ---------- «Приложение»: настройки, которых нет у расширения для браузера ---------- */
  let appTimer;
  function saveApp() {
    clearTimeout(appTimer);
    appTimer = setTimeout(async () => {
      try { await browser.storage.local.set({ appCfg }); flash('Сохранено'); } catch (e) { flash('Ошибка сохранения: ' + e.message, true); }
    }, 120);
  }
  function appToggle(label, desc, key) {
    const cb = h('input', { type: 'checkbox', checked: !!appCfg[key], onchange: () => { appCfg[key] = cb.checked; saveApp(); } });
    return setRow(label, desc, h('label', { class: 'switch' }, cb, h('span', { class: 'track' })));
  }
  function appSlider(label, desc, key, min, max, step, unit) {
    const out = h('span', { class: 'val', text: appCfg[key] + unit });
    const inp = h('input', { type: 'range', min, max, step, value: appCfg[key],
      oninput: () => { appCfg[key] = Number(inp.value); out.textContent = inp.value + unit; saveApp(); } });
    return setRow(label, desc, h('div', { class: 'sl' }, inp, out));
  }
  function appSeg(label, desc, key, options, after) {
    const box = h('div', { class: 'seg' });
    const paint = () => [...box.children].forEach((b, i) => b.classList.toggle('on', options[i][0] === appCfg[key]));
    options.forEach(([v, t]) => box.append(h('button', { type: 'button', text: t, onclick: () => { appCfg[key] = v; paint(); saveApp(); if (after) after(); } })));
    paint();
    return setRow(label, desc, box);
  }
  function pageApp() {
    const selInp = h('input', { type: 'text', class: 'wide', value: appCfg.tapSel || '', placeholder: 'например .miniPlayer',
      oninput: () => { appCfg.tapSel = selInp.value.trim().slice(0, 200); saveApp(); } });
    return [
      sec('Фон под обложку', 'Фон приложения плавно переливается цветами обложки играющего трека. В плеере на весь экран он отключается — там свой фон.',
        appToggle('Включить', 'Размытая обложка медленно вращается и перетекает при смене трека', 'coverBg'),
        appSlider('Яркость', 'Чем меньше — тем темнее фон и лучше читается текст', 'cbBright', 20, 100, 1, '%'),
        appSlider('Насыщенность', 'Яркость цветов обложки', 'cbSat', 80, 260, 5, '%'),
        appSlider('Мягкость', 'Размытие переходов между цветами', 'cbBlur', 1, 10, 1, ''),
        appSlider('Скорость', 'Как быстро переливается фон', 'cbSpeed', 0, 100, 1, '%')),
      sec('Плеер на весь экран', 'Как в Spicetify «Full App Display»: слева обложка, справа название и управление; на вертикальном экране — обложка сверху. Внутри плеера открывается эквалайзер.',
        appToggle('Открывать по нажатию на трек', 'Нажмите на название или обложку в мини-плеере внизу', 'tapOpen'),
        setRow('Свой селектор мини-плеера', 'Если нажатие не срабатывает: CSS-селектор области мини-плеера (инструмент «Выбрать элемент» подскажет)', selInp),
        appSlider('Размытие фона', 'Размытие обложки за плеером', 'fpBlur', 0, 80, 1, 'px'),
        appSlider('Яркость фона', 'Затемнение обложки за плеером', 'fpDim', 15, 100, 1, '%'),
        appSeg('Раскладка', 'Автоматически: по ориентации экрана', 'fpLayout', [['auto', 'Авто'], ['side', 'Сбоку'], ['stack', 'Столбцом']])),
      sec('Сайт', 'Компьютерная версия — работают все настройки оформления расширения. Мобильная версия — родной вид SoundCloud, но часть правок оформления может не примениться.',
        appSeg('Версия SoundCloud', 'Страница перезагрузится сама', 'siteMode', [['desktop', 'Компьютерная'], ['mobile', 'Мобильная']]),
        appSlider('Ширина страницы', 'Только для компьютерной версии: меньше — крупнее текст', 'vpWidth', 380, 1100, 10, 'px')),
      sec('Кнопка меню', null,
        setRow('Положение кнопки', 'Её можно перетащить к любому краю экрана', h('button', { class: 'btn', type: 'button', text: 'Вернуть на место',
          onclick: async () => { await browser.storage.local.remove('appFab'); flash('Готово'); } }))),
    ];
  }

  const PAGES = [
    { g: '', id: 'main', t: 'Основные', render: pageMain },
    { g: '', id: 'ui', t: 'Оформление', render: pageUi },
    { g: '', id: 'themes', t: 'Темы', render: pageThemes },
    { g: '', id: 'colors', t: 'Цвета', render: pageColors },
    { g: '', id: 'font', t: 'Шрифт', render: pageFont },
    { g: '', id: 'bg', t: 'Фон', render: pageBg },
    { g: 'Дополнительно', id: 'css', t: 'Свой CSS', render: pageCss },
    { g: 'Дополнительно', id: 'backup', t: 'Резервная копия', render: pageBackup },
  ];

  if (APP) PAGES.splice(1, 0, { g: '', id: 'app', t: 'Приложение', render: pageApp });
  let cur = 'main';
  try { const s = localStorage.getItem('scc-page'); if (PAGES.some(p => p.id === s)) cur = s; } catch (e) { /* ignore */ }

  function goto(id) {
    cur = id;
    try { localStorage.setItem('scc-page', cur); } catch (e) { /* ignore */ }
    renderNav(); renderPage();
    window.scrollTo(0, 0);
    const pg = document.querySelector('.page'); if (pg) pg.scrollTop = 0;
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.replaceChildren();
    let lastG = '';
    for (const p of PAGES) {
      if (p.g !== lastG) {
        if (p.g) { nav.append(h('div', { class: 'nav-div' })); nav.append(h('div', { class: 'nav-g', text: p.g })); }
        lastG = p.g;
      }
      const b = h('button', { class: 'nav-i' + (p.id === cur ? ' on' : ''), type: 'button', onclick: () => goto(p.id) });
      setHTML(b, '<svg viewBox="0 0 24 24">' + ICONS[p.id === 'main' ? 'main' : p.id] + '</svg>');
      b.append(p.t);
      nav.append(b);
    }
  }

  function renderPage() {
    const page = PAGES.find(p => p.id === cur) || PAGES[0];
    const root = document.getElementById('page');
    root.replaceChildren(...page.render());
    if (APP) {
      const foot = h('div', { class: 'app-foot' });
      document.querySelectorAll('.side .tip-btn, .side .legal-note').forEach((n) => foot.append(n.cloneNode(true)));
      foot.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); toParent('open-url', { url: a.href }); }));
      root.append(foot);
    }
  }

  setAccent();
  applyUiFont();
  renderNav();
  renderPage();

  // «Включено» могли переключить в другой копии настроек — обновляем страницу
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || !changes.settings.newValue) return;
    const en = changes.settings.newValue.enabled;
    if (typeof en === 'boolean' && en !== settings.enabled) {
      settings.enabled = en;
      if (cur === 'main') renderPage();
    }
  });
})();
