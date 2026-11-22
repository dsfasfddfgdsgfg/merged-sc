/* Общий модуль: настройки по умолчанию, пресеты и генератор CSS для SoundCloud.
   Подключается и в content script, и на странице настроек. */
(function (root) {
  'use strict';

  const HEX = /^#[0-9a-fA-F]{6}$/;

  /* [ключ, подпись, цвет по умолчанию для пикера] */
  const COLOR_FIELDS = [
    { group: 'Акцент и общий вид', items: [
      ['accent', 'Акцентный цвет (вместо оранжевого)', '#ff5500'],
      ['accentText', 'Текст на акцентных кнопках', '#ffffff'],
      ['pageBg', 'Фон страницы', '#121212'],
      ['surfaceBg', 'Фон карточек, меню и панелей', '#1c1c1e'],
      ['border', 'Линии и границы', '#2c2c2e'],
    ] },
    { group: 'Текст', items: [
      ['text', 'Основной текст', '#f2f2f2'],
      ['textMuted', 'Второстепенный текст', '#9a9a9f'],
      ['link', 'Ссылки при наведении', '#ff5500'],
    ] },
    { group: 'Верхняя панель', items: [
      ['headerBg', 'Фон шапки', '#000000'],
      ['headerText', 'Текст и ссылки шапки', '#ffffff'],
      ['headerActive', 'Активный пункт / наведение', '#ff5500'],
      ['searchBg', 'Фон строки поиска', '#2a2a2d'],
      ['searchText', 'Текст в строке поиска', '#ffffff'],
    ] },
    { group: 'Панель вкладок (Лайки, Плейлисты, Альбомы…)', items: [
      ['tabsBg', 'Фон панели вкладок', '#121212'],
      ['tabsText', 'Текст вкладок', '#b5b5b9'],
      ['tabsActive', 'Активная вкладка / наведение', '#ff5500'],
    ] },
    { group: 'Кнопки (лайк, репост, поделиться…)', items: [
      ['buttonBg', 'Фон кнопок', '#2a2a2d'],
      ['buttonText', 'Текст кнопок', '#f2f2f2'],
      ['buttonBorder', 'Рамка кнопок', '#3a3a3d'],
      ['likeActive', 'Цвет нажатого лайка / репоста', '#ff5500'],
    ] },
    { group: 'Плеер (нижняя панель)', items: [
      ['playerBg', 'Фон плеера', '#161618'],
      ['playerText', 'Текст плеера', '#f2f2f2'],
      ['progress', 'Полоса прогресса и громкости', '#ff5500'],
    ] },
  ];

  const DEFAULTS = {
    enabled: true,
    colors: {}, // только включённые цвета: { ключ: '#rrggbb' }
    flags: {
      sceneFollowsAccent: true,
      styledTopBars: true,
      hoverAccent: true,   // подсветка строки трека при наведении — цветом акцента
      hoverStrength: 0,    // насыщенность подсветки, % (0 = без подсветки, 100 = чистый акцент)
      hideArtistTools: false, // скрывать рекламную панель «Artist tools» (её находит content.js)
    },
    presetName: '',
    font: {
      mode: 'default', // default | system | google | file
      system: '',
      google: '',
      fileName: '',
      letterSpacing: '',
      size: 100,       // масштаб текста, % (100 = как есть); применяет content.js
    },
    bg: {
      enabled: false,
      url: '',
      size: 'cover', // cover | contain | repeat
      position: 'center center',
      fixed: true,
      blur: 0,
      brightness: 100,
      overlayColor: '#000000',
      overlayOpacity: 25,
      videoUrl: '',             // https-ссылка: прямая на видеофайл (mp4 / webm), YouTube или VK
      videoSource: 'url',       // 'url' — ссылка из videoUrl, 'file' — свой файл, загруженный в расширение
      videoFileName: '',        // имя загруженного файла (только для показа в настройках)
      videoFileId: 0,           // метка загруженного файла (по ней видео перезагружается при замене файла)
      videoPauseScroll: true,   // ставить видео на паузу, пока страницу прокручивают (меньше лагов)
      videoInBackground: false, // играть, когда окно свёрнуто / скрыто
      videoBlur: 0,             // размытие видео, % (0–100 → 0–40 px); по умолчанию выключено
      videoBright: 0,           // изменение яркости видео, % (−80…+50); по умолчанию без изменений
      cardOpacity: 0,      // непрозрачность карточек, % (0 = карточки прозрачные); работает и без картинки фона
    },
    customCss: '',
    ui: {
      opacity: 75,   // непрозрачность стекла панели настроек, % (в настройках показана прозрачность 25%)
      dim: 25,       // сила затемнения сайта под панелью, %
      blur: 10,      // размытие за панелью, px
      width: 940,    // ширина панели, px
    },
  };

  /* ---------- утилиты ---------- */

  function merge(base, extra) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        const v = extra[k];
        if (v === undefined) continue;
        if (v && typeof v === 'object' && !Array.isArray(v) &&
            base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
          out[k] = merge(base[k], v);
        } else {
          out[k] = v;
        }
      }
    }
    return out;
  }

  function clamp(n, a, b) {
    n = Number(n);
    if (!isFinite(n)) n = a;
    return Math.min(b, Math.max(a, n));
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }

  function mix(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(A.map((v, i) => Math.round(v + (B[i] - v) * t)));
  }

  function rgba(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(2) + ')';
  }

  function rgbToHsl(rgb) {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  /* Иконки/волна у SoundCloud оранжевые (#f50, оттенок ~16°). Чтобы перекрасить картинку,
     поворачиваем оттенок фильтром. Для почти серых цветов — просто делаем иконку серой/светлой. */
  function hueFilter(hex) {
    const hsl = rgbToHsl(hexToRgb(hex));
    if (hsl[1] < 0.2) {
      return 'grayscale(1) brightness(' + (0.25 + hsl[2] * 1.5).toFixed(2) + ')';
    }
    return 'hue-rotate(' + Math.round(hsl[0] - 16) + 'deg)';
  }

  function lumOf(hex) {
    const c = hexToRgb(hex);
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  }

  /* контраст по WCAG: 1 (одинаковые) … 21 (чёрный на белом) */
  function relLum(hex) {
    const c = hexToRgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const l1 = relLum(a), l2 = relLum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  /* цвет значка на акцентной заливке: желаемый, если он читается, иначе лучший из белого / чёрного */
  function glyphOn(bg, wanted) {
    if (wanted && HEX.test(wanted) && contrast(wanted, bg) >= 3) return wanted;
    if (contrast('#ffffff', bg) >= 3) return '#ffffff';   // белый значок предпочтителен, если он вообще читается
    return contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
  }

  function safeUrl(u) {
    u = String(u || '').trim();
    if (!/^(https:\/\/|data:image\/(png|jpe?g|webp|gif|avif|svg\+xml)[;,])/i.test(u)) return '';
    return u.replace(/["\\\r\n]/g, ch => encodeURIComponent(ch));
  }

  function cleanName(n) {
    return String(n || '').replace(/["'\\{};<>\r\n]/g, '').trim();
  }

  /* Общие семейства (system-ui, -apple-system …) пишутся без кавычек, иначе браузер ищет шрифт с таким именем. */
  function familyCss(n) {
    n = cleanName(n);
    return /^(system-ui|-apple-system|ui-sans-serif|ui-serif|ui-monospace|ui-rounded)$/i.test(n) ? n : '"' + n + '"';
  }

  function activeFontFiles(s, assets) {
    const mode = s.font && s.font.mode;
    if ((mode === 'google' || mode === 'file' || mode === 'pixel') && assets && assets.fontSource === mode &&
        Array.isArray(assets.fontFiles) && assets.fontFiles.length) {
      return assets.fontFiles;
    }
    return [];
  }

  /* ---------- пресеты ---------- */

  function darkPreset(name, accent, bg, surface, o) {
    o = o || {};
    const text = o.text || '#f2f2f2';
    return {
      name: name,
      swatch: [bg, surface, accent],
      colors: {
        accent: accent,
        accentText: o.accentText || '#ffffff',
        pageBg: bg,
        surfaceBg: surface,
        border: mix(surface, '#ffffff', 0.12),
        text: text,
        textMuted: o.muted || '#9a9a9f',
        link: accent,
        headerBg: o.header || mix(bg, '#000000', 0.5),
        headerText: '#ffffff',
        headerActive: accent,
        searchBg: mix(bg, '#ffffff', 0.1),
        searchText: '#ffffff',
        tabsText: '#b5b5b9',
        tabsActive: accent,
        buttonBg: mix(surface, '#ffffff', 0.06),
        buttonText: text,
        buttonBorder: mix(surface, '#ffffff', 0.16),
        likeActive: accent,
        playerBg: o.player || mix(bg, '#000000', 0.25),
        playerText: text,
        progress: accent,
      },
    };
  }

  const PRESETS = [
    darkPreset('Графит', '#ff5500', '#121212', '#1c1c1e'),
    darkPreset('Фиолетовая ночь', '#a78bfa', '#0f0a1f', '#1a1333', { muted: '#a39bc0' }),
    darkPreset('Неон', '#ff2bd6', '#07040f', '#120a22', { muted: '#a08ab8', text: '#f6eaff' }),
    darkPreset('Мята', '#2dd4bf', '#0a1211', '#121d1c', { accentText: '#042f2a', muted: '#8fa8a5' }),
    darkPreset('AMOLED', '#ffffff', '#000000', '#0a0a0a', { accentText: '#000000', header: '#000000', player: '#000000' }),
    {
      name: 'Cherry',
      swatch: ['#000000', '#0a0a0a', '#ca1212'],
      cardOpacity: 0,
      flags: { sceneFollowsAccent: true, styledTopBars: true },
      colors: {
        accent: '#ca1212', accentText: '#000000', pageBg: '#000000', surfaceBg: '#0a0a0a', border: '#272727',
        text: '#d51515', textMuted: '#9a9a9f', link: '#d21414',
        headerBg: '#000000', headerText: '#d41111', headerActive: '#dd0e0e',
        searchBg: '#1a1a1a', searchText: '#d40808',
        tabsBg: '#121212', tabsText: '#b5b5b9', tabsActive: '#cd0e0e',
        buttonBg: '#4d0505', buttonText: '#f00000', buttonBorder: '#532d2d', likeActive: '#370101',
        playerBg: '#000000', playerText: '#da0b0b', progress: '#cf1717',
      },
    },
    {
      name: 'Светлая тёплая',
      swatch: ['#faf6f0', '#ffffff', '#ff5500'],
      colors: {
        accent: '#ff5500', accentText: '#ffffff', pageBg: '#faf6f0', surfaceBg: '#ffffff',
        border: '#e7dfd2', text: '#2a2118', textMuted: '#85796b', link: '#ff5500',
        headerBg: '#2a2118', headerText: '#ffffff', headerActive: '#ff7a3d',
        searchBg: '#3d3226', searchText: '#ffffff',
        tabsText: '#85796b', tabsActive: '#ff5500',
        buttonBg: '#ffffff', buttonText: '#2a2118', buttonBorder: '#e0d6c6', likeActive: '#ff5500',
        playerBg: '#ffffff', playerText: '#2a2118', progress: '#ff5500',
      },
    },
  ];

  function lightPreset(name, accent, bg, surface, o) {
    const text = o.text, muted = o.muted;
    return {
      name: name,
      swatch: [bg, surface, accent],
      colors: {
        accent: accent,
        accentText: o.accentText || '#ffffff',
        pageBg: bg,
        surfaceBg: surface,
        border: o.border,
        text: text,
        textMuted: muted,
        link: accent,
        headerBg: o.header,
        headerText: '#ffffff',
        headerActive: o.headerActive || accent,
        searchBg: mix(o.header, '#ffffff', 0.14),
        searchText: '#ffffff',
        tabsBg: bg,
        tabsText: muted,
        tabsActive: accent,
        buttonBg: surface,
        buttonText: text,
        buttonBorder: o.border,
        likeActive: accent,
        playerBg: o.player || surface,
        playerText: text,
        progress: accent,
      },
    };
  }

  /* Новые темы: цвета подобраны так, чтобы тексту, акценту и значкам везде хватало контраста
     (проверено скриптом: основной текст ≥ 7:1, второстепенный и акцент ≥ 4.5:1 / 3:1, текст на акценте ≥ 4.5:1). */
  PRESETS.push(
    (function () {
      const p = darkPreset('Глубина', '#38bdf8', '#071721', '#0d2634',
        { muted: '#86a9bd', text: '#e8f4fb', accentText: '#04202e', header: '#040f16', player: '#061c29' });
      p.colors.tabsBg = '#071721'; p.colors.headerActive = '#7dd3fc'; return p;
    })(),
    (function () {
      const p = darkPreset('Хвоя', '#a3e635', '#0c140e', '#16231a',
        { muted: '#92a893', text: '#eef5ea', accentText: '#14210a', header: '#070d08', player: '#101c13' });
      p.colors.tabsBg = '#0c140e'; p.colors.headerActive = '#bef264'; return p;
    })(),
    (function () {
      const p = darkPreset('Рассвет', '#ff7a90', '#1a0f17', '#281722',
        { muted: '#b497a5', text: '#fbeef2', accentText: '#2d0712', header: '#12080f', player: '#20121b' });
      p.colors.tabsBg = '#1a0f17'; p.colors.headerActive = '#ffa3b3'; return p;
    })(),
    (function () {
      const p = darkPreset('Мокко', '#e8a54b', '#16100c', '#231a14',
        { muted: '#ab9783', text: '#f6ece0', accentText: '#2b1903', header: '#0e0a07', player: '#1d1510' });
      p.colors.tabsBg = '#16100c'; p.colors.headerActive = '#f2c17a'; return p;
    })(),
    lightPreset('Сакура', '#d6246e', '#fdf1f5', '#ffffff',
      { text: '#3a1020', muted: '#86606f', border: '#f1d3de', header: '#3a1020', headerActive: '#ff7aa8' }),
    lightPreset('Иней', '#4f46e5', '#eef2fb', '#ffffff',
      { text: '#161b36', muted: '#5f6a8a', border: '#d9e0f2', header: '#1a2047', headerActive: '#a5b4fc' })
  );

  /* Видео-фон: только прямая https-ссылка на файл, без кавычек / пробелов / управляющих символов. */
  function safeVideoUrl(u) {
    u = typeof u === 'string' ? u.trim() : '';
    if (!u || u.length > 2000 || /[\s"'<>\\`\u0000-\u001f]/.test(u)) return '';
    return /^https:\/\/[^/]+\//i.test(u) ? u : '';
  }

  /* Какое видео выбрано. Результат: null или { kind, key, … }:
       local   — свой файл из расширения (id);
       youtube — { id };  vk — { oid, id, hash };
       direct  — { url } прямая ссылка на файл.
     Для youtube / vk / direct в поле src лежит проверенная исходная ссылка (её передаём запасному проигрывателю). */
  function extractVideoInput(raw) {
    raw = typeof raw === 'string' ? raw.trim() : '';
    if (/<iframe/i.test(raw)) {            // вставили целиком код вставки (например, из «Экспортировать» во VK)
      const m = raw.match(/\ssrc\s*=\s*["']([^"']+)["']/i);
      if (m) return m[1].replace(/&amp;/g, '&').trim();
    }
    return raw;
  }

  function parseVideo(raw) {
    const u = safeVideoUrl(extractVideoInput(raw));
    if (!u) return null;
    let x;
    try { x = new URL(u); } catch (e) { return null; }
    const host = x.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const path = x.pathname;
    if (/^(vimeo\.com|rutube\.ru|tiktok\.com|player\.vimeo\.com)$/.test(host)) return null;   // страницы этих сайтов не воспроизвести
    let yid = '';
    if (host === 'youtu.be') yid = path.split('/')[1] || '';
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (path === '/watch') yid = x.searchParams.get('v') || '';
      else { const m = path.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})(?:[/?]|$)/); if (m) yid = m[1]; }
    }
    if (/^[\w-]{11}$/.test(yid)) return { kind: 'youtube', id: yid, src: u, key: 'youtube:' + yid };
    if (host === 'vk.com' || host === 'vk.ru' || host === 'vkvideo.ru') {
      let oid = '', id = '', hash = '';
      if (/\/video_ext\.php$/.test(path)) {
        oid = x.searchParams.get('oid') || ''; id = x.searchParams.get('id') || ''; hash = x.searchParams.get('hash') || '';
      } else {
        const m = (path + ' ' + (x.searchParams.get('z') || '') + ' ' + (x.searchParams.get('video') || '')).match(/video(-?\d+)_(\d+)(?:_([0-9a-f]{6,40}))?/i);
        if (m) { oid = m[1]; id = m[2]; hash = m[3] || ''; }
      }
      if (/^-?\d{1,12}$/.test(oid) && /^\d{1,12}$/.test(id) && (!hash || /^[0-9a-f]{6,40}$/i.test(hash))) {
        return { kind: 'vk', oid: oid, id: id, hash: hash, src: u, key: 'vk:' + oid + '_' + id + '_' + hash };
      }
      return null;
    }
    return { kind: 'direct', url: u, src: u, key: 'direct:' + u };
  }

  function videoSpec(bg) {
    if (!bg) return null;
    const id = Math.floor(Number(bg.videoFileId));
    if (bg.videoSource === 'file' && isFinite(id) && id > 0) return { kind: 'local', id: id, key: 'local:' + id };
    return parseVideo(bg.videoUrl);
  }

  /* Адрес плеера для встраивания (YouTube / VK). Звука быть не должно: у YouTube — mute=1, а iframe без allow="autoplay"
     не может запустить звук без нажатия пользователя. origin передаём только со страницы сайта. */
  function embedUrl(spec, origin) {
    if (!spec) return '';
    if (spec.kind === 'youtube') {
      return 'https://www.youtube.com/embed/' + spec.id + '?autoplay=1&mute=1&loop=1&playlist=' + spec.id +
        '&controls=0&disablekb=1&fs=0&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1' +
        (origin && /^https:\/\/[\w.-]+$/.test(origin) ? '&origin=' + encodeURIComponent(origin) : '');
    }
    if (spec.kind === 'vk') {
      return 'https://vk.com/video_ext.php?oid=' + spec.oid + '&id=' + spec.id + (spec.hash ? '&hash=' + spec.hash : '') +
        '&autoplay=1&loop=1&hd=3';
    }
    return '';
  }

  function hasBgImage(raw, assets) {
    const s = merge(DEFAULTS, raw || {});
    assets = assets || {};
    if (!s.enabled || !s.bg.enabled) return false;
    if (videoSpec(s.bg)) return true;
    if (typeof assets.bgImage === 'string' && safeUrl(assets.bgImage)) return true;
    return !!safeUrl(s.bg.url);
  }

  /* ---------- точная перекраска иконок под любой цвет (CSS-filter из чёрного) ---------- */
  /* Иконки SoundCloud — картинки, цвет у них не поменять. Подбираем цепочку filter, которая
     превращает чёрный в нужный цвет (SPSA-оптимизация, генератор случайных чисел с фиксированным зерном). */
  function Col(r, g, b) { this.set(r, g, b); }
  const c255 = function (v) { return v > 255 ? 255 : (v < 0 ? 0 : v); };
  Col.prototype.set = function (r, g, b) { this.r = c255(r); this.g = c255(g); this.b = c255(b); };
  Col.prototype.mul = function (m) {
    const r = c255(this.r * m[0] + this.g * m[1] + this.b * m[2]);
    const g = c255(this.r * m[3] + this.g * m[4] + this.b * m[5]);
    const b = c255(this.r * m[6] + this.g * m[7] + this.b * m[8]);
    this.r = r; this.g = g; this.b = b;
  };
  Col.prototype.hueRotate = function (deg) {
    const a = deg / 180 * Math.PI, sn = Math.sin(a), cs = Math.cos(a);
    this.mul([0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
      0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
      0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072]);
  };
  Col.prototype.sepia = function (v) {
    const k = 1 - v;
    this.mul([0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k,
      0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k,
      0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]);
  };
  Col.prototype.saturate = function (v) {
    this.mul([0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v,
      0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v,
      0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v]);
  };
  Col.prototype.linear = function (slope, icpt) {
    icpt = icpt || 0;
    this.r = c255(this.r * slope + icpt * 255); this.g = c255(this.g * slope + icpt * 255); this.b = c255(this.b * slope + icpt * 255);
  };
  Col.prototype.contrast = function (v) { this.linear(v, -(0.5 * v) + 0.5); };
  Col.prototype.invert = function (v) {
    this.r = c255((v + this.r / 255 * (1 - 2 * v)) * 255);
    this.g = c255((v + this.g / 255 * (1 - 2 * v)) * 255);
    this.b = c255((v + this.b / 255 * (1 - 2 * v)) * 255);
  };
  Col.prototype.hsl = function () {
    const r = this.r / 255, g = this.g / 255, b = this.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, sat = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h * 100, s: sat * 100, l: l * 100 };
  };

  function solveFilter(hex) {
    const rgb = hexToRgb(hex);
    const target = new Col(rgb[0], rgb[1], rgb[2]);
    const tHsl = target.hsl();
    const probe = new Col(0, 0, 0);
    let seed = 1234567;
    const rnd = function () { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const loss = function (f) {
      probe.set(0, 0, 0);
      probe.invert(f[0] / 100); probe.sepia(f[1] / 100); probe.saturate(f[2] / 100);
      probe.hueRotate(f[3] * 3.6); probe.linear(f[4] / 100); probe.contrast(f[5] / 100);
      const h = probe.hsl();
      return Math.abs(probe.r - target.r) + Math.abs(probe.g - target.g) + Math.abs(probe.b - target.b) +
        Math.abs(h.h - tHsl.h) + Math.abs(h.s - tHsl.s) + Math.abs(h.l - tHsl.l);
    };
    const fix = function (v, i) {
      let max = 100;
      if (i === 2) max = 7500; else if (i === 4 || i === 5) max = 200;
      if (i === 3) { if (v > max) v %= max; else if (v < 0) v = max + v % max; }
      else if (v < 0) v = 0; else if (v > max) v = max;
      return v;
    };
    const spsa = function (A, a, c, values, iters) {
      let best = null, bestLoss = Infinity;
      const d = [], hi = [], lo = [];
      for (let k = 0; k < iters; k++) {
        const ck = c / Math.pow(k + 1, 0.16667);
        for (let i = 0; i < 6; i++) { d[i] = rnd() > 0.5 ? 1 : -1; hi[i] = values[i] + ck * d[i]; lo[i] = values[i] - ck * d[i]; }
        const diff = loss(hi) - loss(lo);
        for (let i = 0; i < 6; i++) {
          const g = diff / (2 * ck) * d[i];
          values[i] = fix(values[i] - a[i] / Math.pow(A + k + 1, 1) * g, i);
        }
        const l = loss(values);
        if (l < bestLoss) { best = values.slice(); bestLoss = l; }
      }
      return { values: best, loss: bestLoss };
    };
    let wide = { loss: Infinity };
    for (let i = 0; wide.loss > 25 && i < 3; i++) {
      const r = spsa(5, [60, 180, 18000, 600, 1.2, 1.2], 15, [50, 20, 3750, 50, 100, 100], 1000);
      if (r.loss < wide.loss) wide = r;
    }
    const A1 = wide.loss + 1;
    const res = spsa(wide.loss, [0.25 * A1, 0.25 * A1, A1, 0.25 * A1, 0.2 * A1, 0.2 * A1], 2, wide.values, 500);
    const f = res.values, R = Math.round;
    return 'brightness(0) saturate(100%) invert(' + R(f[0]) + '%) sepia(' + R(f[1]) + '%) saturate(' + R(f[2]) +
      '%) hue-rotate(' + R(f[3] * 3.6) + 'deg) brightness(' + R(f[4]) + '%) contrast(' + R(f[5]) + '%)';
  }

  const iconCache = {};
  function iconFilter(hex) {
    if (!iconCache[hex]) iconCache[hex] = solveFilter(hex);
    return iconCache[hex];
  }

  /* ---------- генератор CSS ---------- */

  function buildCss(raw, assets) {
    const s = merge(DEFAULTS, raw || {});
    assets = assets || {};
    if (!s.enabled) return '';

    const c = {};
    for (const k of Object.keys(s.colors || {})) {
      if (HEX.test(s.colors[k])) c[k] = s.colors[k];
    }
    const f = s.flags || {};
    const out = [];
    const add = function (sel) {
      const d = Array.prototype.slice.call(arguments, 1).filter(Boolean).join(';');
      if (d) out.push(sel + '{' + d + '}');
    };
    const I = function (prop, val) { return val ? prop + ':' + val + ' !important' : ''; };

    /* --- фон страницы / картинка --- */
    let bgSrc = '';
    if (typeof assets.bgImage === 'string' && assets.bgImage.indexOf('data:image/') === 0) bgSrc = safeUrl(assets.bgImage);
    if (!bgSrc) bgSrc = safeUrl(s.bg.url);
    const hasVideo = !!(s.bg.enabled && videoSpec(s.bg));
    const hasImg = !!(s.bg.enabled && (bgSrc || hasVideo));
    const WRAP = '#app,#content,.l-container,.l-content,.l-main,.l-listen-wrapper,.l-fluid-fixed,.l-two-column-fixed';

    if (hasImg) {
      const POS = ['center center', 'center top', 'center bottom', 'left center', 'right center'];
      const pos = POS.indexOf(s.bg.position) >= 0 ? s.bg.position : 'center center';
      const blur = clamp(s.bg.blur, 0, 60);
      const bright = clamp(s.bg.brightness, 10, 200);
      const fixed = !!s.bg.fixed;
      const inset = fixed && blur ? '-' + (blur * 2) + 'px' : '0';
      const size = s.bg.size === 'repeat' ? 'auto' : (s.bg.size === 'contain' ? 'contain' : 'cover');
      const repeat = s.bg.size === 'repeat' ? 'repeat' : 'no-repeat';
      const filters = [];
      if (blur) filters.push('blur(' + blur + 'px)');
      if (bright !== 100) filters.push('brightness(' + bright + '%)');

      add('html', I('background-color', c.pageBg || '#000000'), 'background-image:none !important');
      add('body,' + WRAP, 'background:transparent !important');
      /* крупные блоки, которые content.js находит сам (страница трека, hero и т.п.) */
      add('html body [data-scc-clear]', 'background-color:transparent !important', 'background-image:none !important');
      if (!fixed) add('body', 'position:relative !important', 'min-height:100vh');
      add('body::before',
        'content:""',
        'position:' + (fixed ? 'fixed' : 'absolute'),
        'top:' + inset, 'left:' + inset, 'right:' + inset, 'bottom:' + inset,
        'z-index:' + (hasVideo ? '-3' : '-2'), 'pointer-events:none',
        bgSrc ? 'background-image:url("' + bgSrc + '")' : '',
        'background-size:' + size,
        'background-position:' + pos,
        'background-repeat:' + repeat,
        filters.length ? 'filter:' + filters.join(' ') : '');
      if (hasVideo) {
        /* Видео играет в верхней странице. Документы-iframe (страница трека) не должны закрывать его своим фоном,
           картинкой и затемнением: content.js помечает такие документы атрибутом data-scc-frame. */
        add('html[data-scc-frame],html[data-scc-frame] body', 'background:transparent !important', 'background-image:none !important');
        add('html[data-scc-frame] body::before,html[data-scc-frame] body::after', 'display:none !important');
        add('html body iframe', 'background:transparent !important');
      }
      const ov = clamp(s.bg.overlayOpacity, 0, 95);
      if (ov > 0 && HEX.test(s.bg.overlayColor)) {
        add('body::after',
          'content:""',
          'position:' + (fixed ? 'fixed' : 'absolute'),
          'top:0', 'left:0', 'right:0', 'bottom:0',
          'z-index:-1', 'pointer-events:none',
          'background:' + s.bg.overlayColor,
          'opacity:' + (ov / 100).toFixed(2));
      }
    } else if (c.pageBg) {
      add('html,body,' + WRAP, I('background-color', c.pageBg));
    }

    /* Сплошные панели страницы трека (комментарии, «Fans», «Related tracks»…): их находит content.js (data-scc-card).
       Привязаны к «Цвета» → «Карточки» (непрозрачность карточек), с картинкой фона и без неё. Цвет — «Фон карточек» темы;
       если цветов темы нет — родной цвет панели (content.js запоминает его в --scc-rgb). */
    {
      const pa = clamp(s.bg.cardOpacity, 0, 100) / 100;
      const pc = c.surfaceBg || c.pageBg;
      if (pc) add('html body [data-scc-card]', 'background-color:' + rgba(pc, pa) + ' !important');
      else if (pa < 1) add('html body [data-scc-card]', 'background-color:rgba(var(--scc-rgb,0,0,0),' + pa.toFixed(2) + ') !important');
    }

    /* Рекламная панель «Artist tools»: блок помечает content.js (data-scc-hide) — скрываем только его, соседние секции не трогаем. */
    if (f.hideArtistTools === true) add('html body [data-scc-hide]', 'display:none !important');

    /* --- карточки, меню, панели --- */
    const FLOAT = '.dropdownMenu,.dropbar,.dropbar__content,.queue,.modal__modal,.modal__content';
    const CARDS = '.soundList__item,.sidebarModule,.badgeList__item,.compactTrackList__item,.searchList__item,.commentForm';
    if (c.surfaceBg) {
      add(FLOAT, I('background-color', c.surfaceBg));
      const a = clamp(s.bg.cardOpacity, 0, 100) / 100;     // работает и без картинки фона
      add(CARDS, 'background-color:' + (a < 1 ? rgba(c.surfaceBg, a) : c.surfaceBg) + ' !important');
    }
    if (c.border) {
      add('.soundList__item,.sc-border-light,.sc-border-light-bottom,.sc-border-light-top,.sc-border-light-left,.sc-border-light-right,.sidebarModule,.g-tabs',
        I('border-color', c.border));
    }

    /* Градиент у «.soundBadge__additional» (затухание под кнопками справа): родной уходил в чёрный.
       Делаем его от прозрачного к цвету карточки; если карточки прозрачные — градиента нет. */
    {
      const ca = clamp(s.bg.cardOpacity, 0, 100) / 100;
      const bb = c.surfaceBg && ca > 0 ? c.surfaceBg : null;
      add('html body .soundBadge__additional',
        bb ? 'background:linear-gradient(to right,' + rgba(bb, 0) + ' 0,' + rgba(bb, ca) + ' 28px) !important' : 'background:transparent !important',
        'box-shadow:none !important');
    }


    /* --- текст и ссылки --- */
    add('body', I('color', c.text));
    add('.sc-link-dark,.sc-text-primary,.sc-text-h1,.sc-text-h2,.sc-text-h3,.sc-text-h4,.soundTitle__title,.soundTitle__title span,.soundTitle__username,.userBadge__title,.sidebarHeader__title',
      I('color', c.text));
    add('.sc-link-light,.sc-link-medium,.sc-text-secondary,.sc-text-light,.sc-ministats,.soundTitle__info,.soundTitle__uploadTime,.soundContext__usernameLink',
      I('color', c.textMuted));
    add('.sc-link-dark:hover,.sc-link-light:hover,.sc-link-medium:hover,.sc-link-primary:hover,.soundTitle__title:hover,.soundTitle__username:hover',
      I('color', c.link));
    /* трек, который играет сейчас: название того же цвета, что и при наведении, а не оранжевое */
    add('html body .trackItem.m-active .trackItem__trackTitle,html body .trackItem.m-active .sc-link-primary,html body .trackItem.m-active .sc-link-dark,html body .trackItem.m-active a.sc-link-primary,html body .trackItem.m-active .queueItemView__title,html body .trackItem.m-active .soundTitle__title,html body .trackItem.m-active .playableTile__heading,html body .trackItem.m-active a.trackItem__trackTitle span,html body .trackItem.m-playing .trackItem__trackTitle,html body .trackItem.m-playing .sc-link-primary,html body .trackItem.m-playing .sc-link-dark,html body .trackItem.m-playing a.sc-link-primary,html body .trackItem.m-playing .queueItemView__title,html body .trackItem.m-playing .soundTitle__title,html body .trackItem.m-playing .playableTile__heading,html body .trackItem.m-playing a.trackItem__trackTitle span,html body .trackItem.active .trackItem__trackTitle,html body .trackItem.active .sc-link-primary,html body .trackItem.active .sc-link-dark,html body .trackItem.active a.sc-link-primary,html body .trackItem.active .queueItemView__title,html body .trackItem.active .soundTitle__title,html body .trackItem.active .playableTile__heading,html body .trackItem.active a.trackItem__trackTitle span,html body .trackItem.sc-playing .trackItem__trackTitle,html body .trackItem.sc-playing .sc-link-primary,html body .trackItem.sc-playing .sc-link-dark,html body .trackItem.sc-playing a.sc-link-primary,html body .trackItem.sc-playing .queueItemView__title,html body .trackItem.sc-playing .soundTitle__title,html body .trackItem.sc-playing .playableTile__heading,html body .trackItem.sc-playing a.trackItem__trackTitle span,html body .trackItem.playing .trackItem__trackTitle,html body .trackItem.playing .sc-link-primary,html body .trackItem.playing .sc-link-dark,html body .trackItem.playing a.sc-link-primary,html body .trackItem.playing .queueItemView__title,html body .trackItem.playing .soundTitle__title,html body .trackItem.playing .playableTile__heading,html body .trackItem.playing a.trackItem__trackTitle span,html body .trackList__item.m-active .trackItem__trackTitle,html body .trackList__item.m-active .sc-link-primary,html body .trackList__item.m-active .sc-link-dark,html body .trackList__item.m-active a.sc-link-primary,html body .trackList__item.m-active .queueItemView__title,html body .trackList__item.m-active .soundTitle__title,html body .trackList__item.m-active .playableTile__heading,html body .trackList__item.m-active a.trackItem__trackTitle span,html body .trackList__item.m-playing .trackItem__trackTitle,html body .trackList__item.m-playing .sc-link-primary,html body .trackList__item.m-playing .sc-link-dark,html body .trackList__item.m-playing a.sc-link-primary,html body .trackList__item.m-playing .queueItemView__title,html body .trackList__item.m-playing .soundTitle__title,html body .trackList__item.m-playing .playableTile__heading,html body .trackList__item.m-playing a.trackItem__trackTitle span,html body .trackList__item.active .trackItem__trackTitle,html body .trackList__item.active .sc-link-primary,html body .trackList__item.active .sc-link-dark,html body .trackList__item.active a.sc-link-primary,html body .trackList__item.active .queueItemView__title,html body .trackList__item.active .soundTitle__title,html body .trackList__item.active .playableTile__heading,html body .trackList__item.active a.trackItem__trackTitle span,html body .trackList__item.sc-playing .trackItem__trackTitle,html body .trackList__item.sc-playing .sc-link-primary,html body .trackList__item.sc-playing .sc-link-dark,html body .trackList__item.sc-playing a.sc-link-primary,html body .trackList__item.sc-playing .queueItemView__title,html body .trackList__item.sc-playing .soundTitle__title,html body .trackList__item.sc-playing .playableTile__heading,html body .trackList__item.sc-playing a.trackItem__trackTitle span,html body .trackList__item.playing .trackItem__trackTitle,html body .trackList__item.playing .sc-link-primary,html body .trackList__item.playing .sc-link-dark,html body .trackList__item.playing a.sc-link-primary,html body .trackList__item.playing .queueItemView__title,html body .trackList__item.playing .soundTitle__title,html body .trackList__item.playing .playableTile__heading,html body .trackList__item.playing a.trackItem__trackTitle span,html body .compactTrackList__item.m-active .trackItem__trackTitle,html body .compactTrackList__item.m-active .sc-link-primary,html body .compactTrackList__item.m-active .sc-link-dark,html body .compactTrackList__item.m-active a.sc-link-primary,html body .compactTrackList__item.m-active .queueItemView__title,html body .compactTrackList__item.m-active .soundTitle__title,html body .compactTrackList__item.m-active .playableTile__heading,html body .compactTrackList__item.m-active a.trackItem__trackTitle span,html body .compactTrackList__item.m-playing .trackItem__trackTitle,html body .compactTrackList__item.m-playing .sc-link-primary,html body .compactTrackList__item.m-playing .sc-link-dark,html body .compactTrackList__item.m-playing a.sc-link-primary,html body .compactTrackList__item.m-playing .queueItemView__title,html body .compactTrackList__item.m-playing .soundTitle__title,html body .compactTrackList__item.m-playing .playableTile__heading,html body .compactTrackList__item.m-playing a.trackItem__trackTitle span,html body .compactTrackList__item.active .trackItem__trackTitle,html body .compactTrackList__item.active .sc-link-primary,html body .compactTrackList__item.active .sc-link-dark,html body .compactTrackList__item.active a.sc-link-primary,html body .compactTrackList__item.active .queueItemView__title,html body .compactTrackList__item.active .soundTitle__title,html body .compactTrackList__item.active .playableTile__heading,html body .compactTrackList__item.active a.trackItem__trackTitle span,html body .compactTrackList__item.sc-playing .trackItem__trackTitle,html body .compactTrackList__item.sc-playing .sc-link-primary,html body .compactTrackList__item.sc-playing .sc-link-dark,html body .compactTrackList__item.sc-playing a.sc-link-primary,html body .compactTrackList__item.sc-playing .queueItemView__title,html body .compactTrackList__item.sc-playing .soundTitle__title,html body .compactTrackList__item.sc-playing .playableTile__heading,html body .compactTrackList__item.sc-playing a.trackItem__trackTitle span,html body .compactTrackList__item.playing .trackItem__trackTitle,html body .compactTrackList__item.playing .sc-link-primary,html body .compactTrackList__item.playing .sc-link-dark,html body .compactTrackList__item.playing a.sc-link-primary,html body .compactTrackList__item.playing .queueItemView__title,html body .compactTrackList__item.playing .soundTitle__title,html body .compactTrackList__item.playing .playableTile__heading,html body .compactTrackList__item.playing a.trackItem__trackTitle span,html body .systemPlaylistTrackList__item.m-active .trackItem__trackTitle,html body .systemPlaylistTrackList__item.m-active .sc-link-primary,html body .systemPlaylistTrackList__item.m-active .sc-link-dark,html body .systemPlaylistTrackList__item.m-active a.sc-link-primary,html body .systemPlaylistTrackList__item.m-active .queueItemView__title,html body .systemPlaylistTrackList__item.m-active .soundTitle__title,html body .systemPlaylistTrackList__item.m-active .playableTile__heading,html body .systemPlaylistTrackList__item.m-active a.trackItem__trackTitle span,html body .systemPlaylistTrackList__item.m-playing .trackItem__trackTitle,html body .systemPlaylistTrackList__item.m-playing .sc-link-primary,html body .systemPlaylistTrackList__item.m-playing .sc-link-dark,html body .systemPlaylistTrackList__item.m-playing a.sc-link-primary,html body .systemPlaylistTrackList__item.m-playing .queueItemView__title,html body .systemPlaylistTrackList__item.m-playing .soundTitle__title,html body .systemPlaylistTrackList__item.m-playing .playableTile__heading,html body .systemPlaylistTrackList__item.m-playing a.trackItem__trackTitle span,html body .systemPlaylistTrackList__item.active .trackItem__trackTitle,html body .systemPlaylistTrackList__item.active .sc-link-primary,html body .systemPlaylistTrackList__item.active .sc-link-dark,html body .systemPlaylistTrackList__item.active a.sc-link-primary,html body .systemPlaylistTrackList__item.active .queueItemView__title,html body .systemPlaylistTrackList__item.active .soundTitle__title,html body .systemPlaylistTrackList__item.active .playableTile__heading,html body .systemPlaylistTrackList__item.active a.trackItem__trackTitle span,html body .systemPlaylistTrackList__item.sc-playing .trackItem__trackTitle,html body .systemPlaylistTrackList__item.sc-playing .sc-link-primary,html body .systemPlaylistTrackList__item.sc-playing .sc-link-dark,html body .systemPlaylistTrackList__item.sc-playing a.sc-link-primary,html body .systemPlaylistTrackList__item.sc-playing .queueItemView__title,html body .systemPlaylistTrackList__item.sc-playing .soundTitle__title,html body .systemPlaylistTrackList__item.sc-playing .playableTile__heading,html body .systemPlaylistTrackList__item.sc-playing a.trackItem__trackTitle span,html body .systemPlaylistTrackList__item.playing .trackItem__trackTitle,html body .systemPlaylistTrackList__item.playing .sc-link-primary,html body .systemPlaylistTrackList__item.playing .sc-link-dark,html body .systemPlaylistTrackList__item.playing a.sc-link-primary,html body .systemPlaylistTrackList__item.playing .queueItemView__title,html body .systemPlaylistTrackList__item.playing .soundTitle__title,html body .systemPlaylistTrackList__item.playing .playableTile__heading,html body .systemPlaylistTrackList__item.playing a.trackItem__trackTitle span,html body .chartTracks__item.m-active .trackItem__trackTitle,html body .chartTracks__item.m-active .sc-link-primary,html body .chartTracks__item.m-active .sc-link-dark,html body .chartTracks__item.m-active a.sc-link-primary,html body .chartTracks__item.m-active .queueItemView__title,html body .chartTracks__item.m-active .soundTitle__title,html body .chartTracks__item.m-active .playableTile__heading,html body .chartTracks__item.m-active a.trackItem__trackTitle span,html body .chartTracks__item.m-playing .trackItem__trackTitle,html body .chartTracks__item.m-playing .sc-link-primary,html body .chartTracks__item.m-playing .sc-link-dark,html body .chartTracks__item.m-playing a.sc-link-primary,html body .chartTracks__item.m-playing .queueItemView__title,html body .chartTracks__item.m-playing .soundTitle__title,html body .chartTracks__item.m-playing .playableTile__heading,html body .chartTracks__item.m-playing a.trackItem__trackTitle span,html body .chartTracks__item.active .trackItem__trackTitle,html body .chartTracks__item.active .sc-link-primary,html body .chartTracks__item.active .sc-link-dark,html body .chartTracks__item.active a.sc-link-primary,html body .chartTracks__item.active .queueItemView__title,html body .chartTracks__item.active .soundTitle__title,html body .chartTracks__item.active .playableTile__heading,html body .chartTracks__item.active a.trackItem__trackTitle span,html body .chartTracks__item.sc-playing .trackItem__trackTitle,html body .chartTracks__item.sc-playing .sc-link-primary,html body .chartTracks__item.sc-playing .sc-link-dark,html body .chartTracks__item.sc-playing a.sc-link-primary,html body .chartTracks__item.sc-playing .queueItemView__title,html body .chartTracks__item.sc-playing .soundTitle__title,html body .chartTracks__item.sc-playing .playableTile__heading,html body .chartTracks__item.sc-playing a.trackItem__trackTitle span,html body .chartTracks__item.playing .trackItem__trackTitle,html body .chartTracks__item.playing .sc-link-primary,html body .chartTracks__item.playing .sc-link-dark,html body .chartTracks__item.playing a.sc-link-primary,html body .chartTracks__item.playing .queueItemView__title,html body .chartTracks__item.playing .soundTitle__title,html body .chartTracks__item.playing .playableTile__heading,html body .chartTracks__item.playing a.trackItem__trackTitle span,html body .queueItemView.m-active .trackItem__trackTitle,html body .queueItemView.m-active .sc-link-primary,html body .queueItemView.m-active .sc-link-dark,html body .queueItemView.m-active a.sc-link-primary,html body .queueItemView.m-active .queueItemView__title,html body .queueItemView.m-active .soundTitle__title,html body .queueItemView.m-active .playableTile__heading,html body .queueItemView.m-active a.trackItem__trackTitle span,html body .queueItemView.m-playing .trackItem__trackTitle,html body .queueItemView.m-playing .sc-link-primary,html body .queueItemView.m-playing .sc-link-dark,html body .queueItemView.m-playing a.sc-link-primary,html body .queueItemView.m-playing .queueItemView__title,html body .queueItemView.m-playing .soundTitle__title,html body .queueItemView.m-playing .playableTile__heading,html body .queueItemView.m-playing a.trackItem__trackTitle span,html body .queueItemView.active .trackItem__trackTitle,html body .queueItemView.active .sc-link-primary,html body .queueItemView.active .sc-link-dark,html body .queueItemView.active a.sc-link-primary,html body .queueItemView.active .queueItemView__title,html body .queueItemView.active .soundTitle__title,html body .queueItemView.active .playableTile__heading,html body .queueItemView.active a.trackItem__trackTitle span,html body .queueItemView.sc-playing .trackItem__trackTitle,html body .queueItemView.sc-playing .sc-link-primary,html body .queueItemView.sc-playing .sc-link-dark,html body .queueItemView.sc-playing a.sc-link-primary,html body .queueItemView.sc-playing .queueItemView__title,html body .queueItemView.sc-playing .soundTitle__title,html body .queueItemView.sc-playing .playableTile__heading,html body .queueItemView.sc-playing a.trackItem__trackTitle span,html body .queueItemView.playing .trackItem__trackTitle,html body .queueItemView.playing .sc-link-primary,html body .queueItemView.playing .sc-link-dark,html body .queueItemView.playing a.sc-link-primary,html body .queueItemView.playing .queueItemView__title,html body .queueItemView.playing .soundTitle__title,html body .queueItemView.playing .playableTile__heading,html body .queueItemView.playing a.trackItem__trackTitle span,html body .soundList__item.m-active .trackItem__trackTitle,html body .soundList__item.m-active .sc-link-primary,html body .soundList__item.m-active .sc-link-dark,html body .soundList__item.m-active a.sc-link-primary,html body .soundList__item.m-active .queueItemView__title,html body .soundList__item.m-active .soundTitle__title,html body .soundList__item.m-active .playableTile__heading,html body .soundList__item.m-active a.trackItem__trackTitle span,html body .soundList__item.m-playing .trackItem__trackTitle,html body .soundList__item.m-playing .sc-link-primary,html body .soundList__item.m-playing .sc-link-dark,html body .soundList__item.m-playing a.sc-link-primary,html body .soundList__item.m-playing .queueItemView__title,html body .soundList__item.m-playing .soundTitle__title,html body .soundList__item.m-playing .playableTile__heading,html body .soundList__item.m-playing a.trackItem__trackTitle span,html body .soundList__item.active .trackItem__trackTitle,html body .soundList__item.active .sc-link-primary,html body .soundList__item.active .sc-link-dark,html body .soundList__item.active a.sc-link-primary,html body .soundList__item.active .queueItemView__title,html body .soundList__item.active .soundTitle__title,html body .soundList__item.active .playableTile__heading,html body .soundList__item.active a.trackItem__trackTitle span,html body .soundList__item.sc-playing .trackItem__trackTitle,html body .soundList__item.sc-playing .sc-link-primary,html body .soundList__item.sc-playing .sc-link-dark,html body .soundList__item.sc-playing a.sc-link-primary,html body .soundList__item.sc-playing .queueItemView__title,html body .soundList__item.sc-playing .soundTitle__title,html body .soundList__item.sc-playing .playableTile__heading,html body .soundList__item.sc-playing a.trackItem__trackTitle span,html body .soundList__item.playing .trackItem__trackTitle,html body .soundList__item.playing .sc-link-primary,html body .soundList__item.playing .sc-link-dark,html body .soundList__item.playing a.sc-link-primary,html body .soundList__item.playing .queueItemView__title,html body .soundList__item.playing .soundTitle__title,html body .soundList__item.playing .playableTile__heading,html body .soundList__item.playing a.trackItem__trackTitle span,html body .playableTile.m-active .trackItem__trackTitle,html body .playableTile.m-active .sc-link-primary,html body .playableTile.m-active .sc-link-dark,html body .playableTile.m-active a.sc-link-primary,html body .playableTile.m-active .queueItemView__title,html body .playableTile.m-active .soundTitle__title,html body .playableTile.m-active .playableTile__heading,html body .playableTile.m-active a.trackItem__trackTitle span,html body .playableTile.m-playing .trackItem__trackTitle,html body .playableTile.m-playing .sc-link-primary,html body .playableTile.m-playing .sc-link-dark,html body .playableTile.m-playing a.sc-link-primary,html body .playableTile.m-playing .queueItemView__title,html body .playableTile.m-playing .soundTitle__title,html body .playableTile.m-playing .playableTile__heading,html body .playableTile.m-playing a.trackItem__trackTitle span,html body .playableTile.active .trackItem__trackTitle,html body .playableTile.active .sc-link-primary,html body .playableTile.active .sc-link-dark,html body .playableTile.active a.sc-link-primary,html body .playableTile.active .queueItemView__title,html body .playableTile.active .soundTitle__title,html body .playableTile.active .playableTile__heading,html body .playableTile.active a.trackItem__trackTitle span,html body .playableTile.sc-playing .trackItem__trackTitle,html body .playableTile.sc-playing .sc-link-primary,html body .playableTile.sc-playing .sc-link-dark,html body .playableTile.sc-playing a.sc-link-primary,html body .playableTile.sc-playing .queueItemView__title,html body .playableTile.sc-playing .soundTitle__title,html body .playableTile.sc-playing .playableTile__heading,html body .playableTile.sc-playing a.trackItem__trackTitle span,html body .playableTile.playing .trackItem__trackTitle,html body .playableTile.playing .sc-link-primary,html body .playableTile.playing .sc-link-dark,html body .playableTile.playing a.sc-link-primary,html body .playableTile.playing .queueItemView__title,html body .playableTile.playing .soundTitle__title,html body .playableTile.playing .playableTile__heading,html body .playableTile.playing a.trackItem__trackTitle span',
      I('color', c.link || c.accent));
    /* Подписи на тёмных плашках (ник и город в шапке профиля) у SoundCloud всегда светлые на тёмном.
       Тёмный «основной текст» светлой темы делал их нечитаемыми. */
    add('html body [class*="g-type-shrinkwrap"],html body [class*="g-type-shrinkwrap"] *,' +
      'html body .profileHeaderInfo__userName,html body .profileHeaderInfo__userName *',
      'color:#ffffff !important');

    /* --- шапка --- */
    add('.header,.header__inner', I('background-color', c.headerBg));
    add('.header a,.header button,.header .header__link', I('color', c.headerText));
    add('.header a:hover,.header .header__link:hover,.header .header__link.active', I('color', c.headerActive));
    add('.headerSearch__input,.headerSearch__input:focus', I('background-color', c.searchBg), I('color', c.searchText));
    if (c.searchText) add('.headerSearch__input::placeholder', I('color', c.searchText), 'opacity:.6');

    /* --- выезжающее окно поиска (подсказки) — на любой странице --- */
    {
      const sb = c.surfaceBg || c.pageBg;
      if (sb) {
        const acc = c.accent || '';
        const ac2 = acc || '#ffffff';
        const bd = c.border || mix(sb, '#ffffff', 0.16);
        const AC = 'html body div.searchAutocomplete,html body .searchAutocomplete.lazyLoadingList,html body div[class*="searchMenu"]:not(a):not(span),html body .headerSearch [role="listbox"],html body .MuiAutocomplete-popper .MuiPaper-root,html body .MuiAutocomplete-listbox';
        const inner = function (suf) { return AC.split(',').map(function (x) { return x + suf; }).join(','); };
        add(AC, 'background:' + sb + ' !important', 'background-color:' + sb + ' !important', 'background-image:none !important',
          'border-color:' + bd + ' !important', 'box-shadow:0 8px 28px rgba(0,0,0,.45) !important', I('color', c.text));
        /* всё внутри — без собственных серых подложек */
        add(inner(' *:not(svg):not(svg *):not(img):not(.sc-artwork):not([class*="rtwork"]):not([class*="image"]):not([style*="background-image"])'), 'background:transparent !important', 'background-color:transparent !important',
          'background-image:none !important', 'box-shadow:none !important');
        add([inner(' a'), inner(' a *'), inner(' li'), inner(' span'), inner(' div')].join(','), I('color', c.text));
        add('html body a.searchMenu__searchForText,html body a.searchMenu__searchForText *', I('color', c.text));
        add([inner(' svg'), inner(' svg *')].join(','), 'fill:' + (c.text || ac2) + ' !important');
        /* строка «Search for …» и строки под курсором — оттенок акцента */
        const ROW = ['li:has(.searchMenu__searchForText)', 'a.searchMenu__searchForText', '[class*="searchMenu"][class*="active"]', '[class*="searchMenu"][class*="selected"]',
          '[class*="searchMenu"][class*="focus"]', '[class*="searchMenu"][class*="highlight"]', '[aria-selected="true"]', 'li:hover', 'a:hover', '[role="option"]:hover']
          .map(function (x) { return inner(' ' + x); }).join(',');
        add(ROW, 'background-color:' + rgba(ac2, 0.2) + ' !important', I('color', c.headerActive || c.text));
        add([inner(' li:hover a'), inner(' a:hover *')].join(','), I('color', c.headerActive || c.text));
      }
    }

    /* --- страница результатов поиска: кнопки-категории слева (Все / Люди / Альбомы …) — полупрозрачные --- */
    {
      const sb = c.surfaceBg || c.pageBg;
      if (sb) {
        const acc = c.accent || '';
        const ac2 = acc || '#ffffff';
        const NAV = 'html body .searchOptions__navigation li.g-nav-item,html body li.g-nav-item[class*="searchOptions__navigation-"]';
        const navTxt = c.buttonText || c.text;
        const by = function (suf) { return NAV.split(',').map(function (x) { return x + suf; }).join(','); };
        add(NAV, 'background:' + rgba(ac2, 0.07) + ' !important', 'background-color:' + rgba(ac2, 0.07) + ' !important', 'background-image:none !important',
          'border-color:' + rgba(ac2, 0.18) + ' !important', 'box-shadow:none !important', I('color', navTxt));
        add([by(' a'), by(' .g-nav-link'), by(' span')].join(','), 'background:transparent !important', 'background-color:transparent !important', I('color', navTxt));
        add(by(':hover'), 'background-color:' + rgba(ac2, 0.16) + ' !important');
        add([by(':hover a'), by(':hover span')].join(','), I('color', c.headerActive || navTxt));
        const ON = ['.active', '.selected', '.m-active', '[aria-current]', ':has(.active)', ':has(.selected)', ':has([aria-current])'].map(by).join(',');
        add(ON, 'background-color:' + rgba(ac2, 0.26) + ' !important', 'border-color:' + rgba(ac2, 0.45) + ' !important');
      }
    }

    /* --- панель вкладок (Лайки / Плейлисты / Альбомы …) --- */
    add('.g-tabs,.collectionNav', I('background-color', c.tabsBg));
    add('.g-tabs-link', I('color', c.tabsText));
    add('.g-tabs-link:hover', I('color', c.tabsActive));
    add('.g-tabs-link.active,.g-tabs-link.active:hover', I('color', c.tabsActive), I('border-bottom-color', c.tabsActive));

    const acc = c.accent || '';

    /* --- кнопки (лайк, репост, поделиться, подписка…) --- */
    /* Нажатое состояние: лайкнут / репостнут / подписан. В разных местах сайта оно помечено по-разному. */
    /* Кнопки действий трека (лайк, репост, поделиться, ссылка, «ещё») остаются как в ванильном SoundCloud — без своего фона.
       Раньше их перебивал BTN: длинная цепочка :not() даёт ему специфичность выше любого простого правила. */
    /* Кнопки действий на плитках треков (лайк, подписка…) — без фона, как в ванильном SoundCloud; нажатое состояние показывает
       только значок. В правой панели ленты (.streamSidebar) те же кнопки остаются с фоном и красятся темой. */
    const PT = '.playableTile__actionButton:not(.streamSidebar .playableTile__actionButton)';
    const NOT_VAN = ':not(' + PT + ')';
    const ACT = ['.sc-button-active', '.sc-button-selected', '.sc-button-following', '[aria-pressed="true"]',
      '[title^="Unlike" i]', '[title^="Unrepost" i]', '[title^="Unfollow" i]',
      '[aria-label^="Unlike" i]', '[aria-label^="Unrepost" i]'];
    const NOT_ACT = ACT.map(function (x) { return ':not(' + x + ')'; }).join('');
    const IS_ACT = ACT.map(function (x) { return 'html body .sc-button' + x; });
    const IS_ACT_OUTSIDE_PLAYER = ACT.map(function (x) { return 'html body .sc-button' + x + ':not(.playControls .sc-button):not(.moreActions .sc-button)' + NOT_VAN; });
    const BTN = 'html body .sc-button:not(.sc-button-cta):not(.sc-button-nostyle):not(.playControls .sc-button):not(.moreActions .sc-button)' + NOT_VAN + NOT_ACT;

    add(BTN, I('background-color', c.buttonBg), I('color', c.buttonText), I('border-color', c.buttonBorder));
    if (c.buttonBg) add(BTN + ':hover', 'background-color:' + mix(c.buttonBg, '#ffffff', 0.08) + ' !important');

    /* Кнопки под треком (лайк, репост, поделиться, ссылка, «ещё»…): вместо серого — оттенок акцента выбранной темы. */
    if (acc) {
      const SEC = 'html body .sc-button:is(.sc-button-secondary,.sc-button-tertiary,.sc-button-follow,.sc-button-like,.sc-button-repost):not(.playControls .sc-button):not(.moreActions .sc-button):not(.sc-button-cta):not(.sc-button-play):not(.scc-x):not(.scc-y)' + NOT_VAN + NOT_ACT;
      const secBase = c.buttonBg || c.surfaceBg || c.pageBg || '#2a2a2d';
      add(SEC, 'background-color:' + mix(secBase, acc, 0.22) + ' !important', 'border-color:' + mix(secBase, acc, 0.5) + ' !important',
        I('color', c.buttonText || c.text));
      add(SEC + ':hover,' + SEC + ':focus', 'background-color:' + mix(secBase, acc, 0.36) + ' !important', 'border-color:' + acc + ' !important');
    }

    /* Панель действий трека (лайк, репост, поделиться…) и лайк на плитках: фона, рамки и тени у кнопок не должно быть
       ни в покое, ни при наведении, ни при нажатии / фокусе. */
    const FLAT = ['html body div.sc-button-group.sc-button-group-small:not(.streamSidebar *):not(.scc-x):not(.scc-y)', 'html body .sc-button.playableTile__actionButton:not(.streamSidebar *):not(.scc-x):not(.scc-y)'];
    const FLAT_ALL = [];
    FLAT.forEach(function (x) {
      ['', ':hover', ':active', ':focus', ':focus-visible'].forEach(function (st) {
        FLAT_ALL.push(x + st, x + ' .sc-button:not(.sc-button-secondary)' + st);
      });
    });
    add(FLAT_ALL.join(','), 'background:transparent !important', 'background-color:transparent !important', 'background-image:none !important',
      'border-color:transparent !important', 'box-shadow:none !important', 'outline:none !important');
    add(FLAT.map(function (x) { return x + '::after'; }).join(','), 'background:transparent !important', 'box-shadow:none !important', 'border-color:transparent !important');

    const likeC = c.likeActive || c.accent;
    if (likeC) {
      /* нажатая кнопка — иконка и текст акцентного цвета + мягкое свечение */
      add(IS_ACT.join(','), I('color', likeC));
      add(IS_ACT.map(function (x) { return x + '::before'; }).join(','),
        'filter:' + iconFilter(likeC) + ' drop-shadow(0 0 4px ' + rgba(likeC, 0.55) + ') !important');
      add(IS_ACT_OUTSIDE_PLAYER.join(','),
        I('background-color', mix(c.buttonBg || c.surfaceBg || c.pageBg || '#2a2a2d', likeC, 0.18)), I('border-color', likeC), 'opacity:1 !important',
        'box-shadow:0 0 14px ' + rgba(likeC, 0.28) + ' !important');
    }

    if (acc) {
      add('.sc-button-cta,.sc-button-cta:hover,.sc-button-cta:focus',
        I('background-color', acc), I('border-color', acc), I('color', c.accentText));
      add('::selection', 'background-color:' + acc, c.accentText ? 'color:' + c.accentText : '');
      if (f.sceneFollowsAccent !== false) {
        add('canvas.sceneLayer,canvas.g-box-full.sceneLayer,.sceneLayer', 'filter:' + hueFilter(acc) + ' !important');
      }
    }

    /* --- страница трека (React / MUI внутри iframe) --- */
    /* Блоки без фона. Классы вида mui-xxxx генерируются библиотекой, поэтому привязаны к конкретным значениям. */
    const MUI_FLAT = ['mui-1inzlnd', 'mui-qlq01x', 'mui-1b20pbu'].map(function (k) { return 'div.MuiStack-root.' + k; });
    add(MUI_FLAT.join(','), 'background:transparent !important', 'background-image:none !important');
    if (acc) {
      const MUI_ACC = 'div.MuiStack-root.mui-1t553jf';
      add(MUI_ACC + ',' + MUI_ACC + ' *:not(svg *)', I('color', acc));
      /* полоса прокрутки — svg; её помечает content.js (data-scc-sb / data-scc-sfill / data-scc-sstroke) */
      add('svg[data-scc-sb] [data-scc-sfill]', 'fill:' + acc + ' !important', 'color:' + acc + ' !important');
      add('svg[data-scc-sb] [data-scc-sstroke]', 'stroke:' + acc + ' !important');
      add('svg[data-scc-sb]', 'color:' + acc + ' !important');
    }

    /* --- подсветка строки трека при наведении: цвет акцента вместо серого --- */
    if (f.hoverAccent !== false) {
      const hc = acc || '#ff5500';
      const hs = clamp(f.hoverStrength == null ? 0 : f.hoverStrength, 0, 100) / 100;
      const ROWS = ['.trackItem', '.trackList__item', '.compactTrackList__item', '.systemPlaylistTrackList__item',
        '.chartTracks__item', '.queueItemView'];
      /* Подсвечиваем только саму строку: :hover срабатывает и на всех родителях (список, контейнер), из-за чего
         по бокам и снизу появлялись цветные полосы. Поэтому берём только элементы, внутри которых нет других строк,
         и убираем у подсвеченной строки рамки / тени, оставляя одну подсветку. */
      const inner = ':not(:has(' + ROWS.join(',') + '))';
      const hov = [];
      ROWS.forEach(function (r) {
        hov.push('html body ' + r + ':hover' + inner, 'html body ' + r + '.hover' + inner, 'html body ' + r + '.active:hover' + inner);
      });
      add(hov.join(','), 'background-color:' + rgba(hc, hs) + ' !important', 'background-image:none !important',
        'border-color:transparent !important', 'box-shadow:none !important', 'outline:none !important');
    }

    /* --- «залипающие» верхние плашки: ник при прокрутке профиля, шапка вкладки «Лайки» --- */
    if (f.styledTopBars !== false && (c.accent || c.surfaceBg || c.pageBg)) {
      const ac = acc || '#ff5500';
      const base = c.surfaceBg || c.pageBg || '#121212';
      const ba = hasImg ? Math.max(0.55, clamp(s.bg.cardOpacity, 0, 100) / 100) : 1;
      const grad = 'linear-gradient(100deg,' + rgba(mix(base, ac, 0.45), ba) + ' 0%,' +
        rgba(mix(base, ac, 0.18), ba) + ' 50%,' + rgba(base, ba) + ' 100%)';
      add('html body .userDropbar,html body .l-top.g-z-index-fixed,html body div.searchTitle.sc-py-2x',
        'background:' + grad + ' !important', 'background-color:' + rgba(base, ba) + ' !important',
        'border-color:' + rgba(ac, 0.55) + ' !important',
        'box-shadow:0 8px 28px rgba(0,0,0,.35),0 1px 0 ' + rgba(ac, 0.35) + ' !important',
        /* без backdrop-filter: на липкой плашке, которая всегда на экране, размытие пересчитывается при прокрутке и каждом кадре видео-фона */
        c.text ? 'color:' + c.text + ' !important' : '');
      /* блок громкости и диалоги — того же цвета, что верхняя плашка (.userDropbar); почти непрозрачные, раз размытия фона нет */
      const pba = Math.max(ba, 0.96);
      const popGrad = 'linear-gradient(100deg,' + rgba(mix(base, ac, 0.45), pba) + ' 0%,' +
        rgba(mix(base, ac, 0.18), pba) + ' 50%,' + rgba(base, pba) + ' 100%)';
      add('html body .volume__sliderWrapper,html body div.dialog.sc-border-box.sc-p-2x,html body div.headerMenu.profileMenu,html body div.queue,html body div.MuiBox-root.mui-187ln2c,html body div.headerMenu,html body div.dropdownContent__container,html body .dropdownMenu,html body .moreActions__dropdown,html body .sc-popover',
        'background:' + popGrad + ' !important', 'background-color:' + rgba(base, pba) + ' !important',
        'border-color:' + rgba(ac, 0.55) + ' !important',
        /* лёгкая тень и никакого backdrop-filter: при перетаскивании ползунка громкости окно перерисовывается каждый кадр,
           а размытие фона под ним + большая тень на каждый кадр сильно нагружают видеокарту — ползунок рвался */
        'box-shadow:0 4px 12px rgba(0,0,0,.35) !important',
        c.text ? 'color:' + c.text + ' !important' : '');
      /* плашка, появляющаяся при прокрутке вкладки «Лайки»: чуть прозрачнее остальных верхних плашек */
      add('html body div.l-top.sc-border-box.g-z-index-fixed',
        'background:linear-gradient(100deg,' + rgba(mix(base, ac, 0.45), ba * 0.78) + ' 0%,' + rgba(mix(base, ac, 0.18), ba * 0.7) + ' 50%,' + rgba(base, ba * 0.62) + ' 100%) !important',
        'background-color:' + rgba(base, ba * 0.62) + ' !important');
      /* пункты меню профиля и «ещё»: при наведении текст не серый */
      const HM = ['div.headerMenu.profileMenu', 'div.headerMenu.moreMenu', 'div.headerMenu'];
      const hmSel = function (suf) { return HM.map(function (x) { return 'html body ' + x + ' ' + suf; }).join(','); };
      add(hmSel('a.headerMenu__link') + ',' + hmSel('a.headerMenu__link *'), I('color', c.text));
      add(['a.headerMenu__link:hover', 'a.headerMenu__link:hover *', 'a.headerMenu__link:focus', 'a.headerMenu__link:focus *', 'a.headerMenu__link:active', 'a.headerMenu__link:active *']
        .map(hmSel).join(','), I('color', c.headerActive || c.text));
      /* плашка «Search results for…» на странице поиска — заметно прозрачнее остальных верхних плашек */
      add('html body div.searchTitle.sc-py-2x.sc-browsers-enable-gpu',
        'background:linear-gradient(100deg,' + rgba(mix(base, ac, 0.45), 0.28) + ' 0%,' + rgba(mix(base, ac, 0.18), 0.16) + ' 50%,' + rgba(base, 0.08) + ' 100%) !important',
        'background-color:transparent !important', 'border-color:' + rgba(ac, 0.22) + ' !important', 'box-shadow:none !important');
      /* внутри выпадающих меню: свои серые подложки убираем, строки при наведении — оттенком акцента */
      add('html body .headerMenu__list,html body .headerMenu .sc-list-nostyle,html body .headerMenu__item,html body .dropdownContent__container > *:not(a):not(button)',
        'background:transparent !important', 'border-color:transparent !important');
      add('html body .headerMenu a:hover,html body .headerMenu button:hover,html body .headerMenu__item:hover,html body .dropdownContent__container a:hover,html body .dropdownContent__container button:hover,html body .dropdownMenu a:hover',
        'background-color:' + rgba(ac, 0.2) + ' !important');

      /* --- меню «ещё» (div.moreActions): тот же вид, что у div.headerMenu.profileMenu ---
         Градиент и рамка — у самого div.moreActions; обёртки вокруг него (dropdownMenu, sc-popover и т.п.) делаем невидимыми
         и без отступов, иначе градиент рисовался бы дважды, а по краям были бы полосы. Пункты — плоские, без своих фонов и рамок;
         при наведении — как в меню профиля: подложка оттенком акцента и цвет «активного пункта». */
      {
        const MA = 'html body div.moreActions.sc-list-nostyle.sc-border-box';
        const MAW = 'html body :is(.sc-popover,.dropdownMenu,.dropdownContent__container,.dropdownContent,.moreActions__dropdown,.MuiPopover-paper):has(div.moreActions.sc-list-nostyle.sc-border-box)';   // без div:has(> …): такой селектор проверялся бы для каждого div страницы
        const hov = c.headerActive || c.text;
        const ITEMS = [MA + ' a', MA + ' button', MA + ' .sc-button', MA + ' li'];
        const itemSel = function (suf) { return ITEMS.map(function (x) { return x + (suf || ''); }).join(','); };
        const inner = function (suf) { return ITEMS.map(function (x) { return x + (suf || '') + ',' + x + (suf || '') + ' *:not(svg):not(svg *)'; }).join(','); };
        add(MAW, 'background:transparent !important', 'background-image:none !important', 'border:0 none !important',
          'box-shadow:none !important', 'backdrop-filter:none !important', '-webkit-backdrop-filter:none !important',
          'filter:none !important', 'padding:0 !important', 'border-radius:4px !important');
        add(MA, 'background:' + popGrad + ' !important', 'background-color:' + rgba(base, pba) + ' !important',
          'border:1px solid ' + rgba(ac, 0.55) + ' !important', 'border-radius:4px !important', 'box-shadow:0 4px 12px rgba(0,0,0,.35) !important',
          'backdrop-filter:none !important', '-webkit-backdrop-filter:none !important', 'filter:none !important',
          'padding:0 !important', 'margin:0 !important', 'overflow:hidden !important', 'outline:none !important', 'box-sizing:border-box !important',
          c.text ? 'color:' + c.text + ' !important' : '');
        add(MA + '::before,' + MA + '::after', 'content:none !important', 'display:none !important');
        /* внутренние обёртки (список, группы) — прозрачные, без линий и скруглений */
        add(MA + ' *:not(a):not(button):not(.sc-button):not(li):not(svg):not(svg *)',
          'background:transparent !important', 'background-image:none !important', 'border-color:transparent !important',
          'box-shadow:none !important', 'border-radius:0 !important');
        add(MA + ' hr', 'display:none !important');
        /* пункты */
        add(itemSel(), 'background:transparent !important', 'background-image:none !important', 'border:0 none !important',
          'border-radius:0 !important', 'box-shadow:none !important', 'width:100% !important', 'box-sizing:border-box !important', 'margin-left:0 !important', 'margin-right:0 !important', 'margin-top:0 !important', 'margin-bottom:0 !important',
          'outline:none !important');
        if (c.text) {
          add(inner(':not(.sc-button-active)'), 'color:' + c.text + ' !important');
          add(ITEMS.map(function (x) { return x + ':not(.sc-button-active)::before'; }).join(','), 'filter:' + iconFilter(c.text) + ' !important');
        }
        /* наведение / фокус */
        const HOVS = [':hover', ':focus', ':focus-visible', ':active'];
        add(HOVS.map(function (h) { return itemSel(h); }).join(','), 'background:' + rgba(ac, 0.2) + ' !important', 'background-color:' + rgba(ac, 0.2) + ' !important');
        if (hov) {
          add(HOVS.map(function (h) { return inner(h); }).join(','), 'color:' + hov + ' !important');
          add(HOVS.map(function (h) { return ITEMS.map(function (x) { return x + h + '::before'; }).join(','); }).join(','), 'filter:' + iconFilter(hov) + ' !important');
        }
      }
      add('html body .userDropbar.sc-border-light-bottom,html body .l-top.g-z-index-fixed.sc-border-light-bottom',
        'border-bottom:1px solid ' + rgba(ac, 0.55) + ' !important');
      add('html body .l-top.g-z-index-fixed .g-tabs,html body .l-top.g-z-index-fixed .collectionNav,' +
        'html body .l-top.g-z-index-fixed .g-tabs-outer,html body .userDropbar .userDropbar__inner',
        'background:transparent !important', 'border-color:transparent !important');
      if (c.text) add('html body .userDropbar a:not(.sc-button),html body .userDropbar .sc-link-dark,html body .userDropbar .sc-text-h4', I('color', c.text));
    }

    /* --- поля ввода, сообщения и страница загрузки (upload): не оставляем серого --- */
    {
      const sb = c.surfaceBg || c.pageBg;
      if (sb) {
        const fieldBg = mix(sb, acc || '#ffffff', acc ? 0.1 : 0.06), fieldBd = mix(sb, acc || '#ffffff', acc ? 0.35 : 0.16);
        const FIELDS = 'html body textarea.sc-input,html body input.sc-input,html body .textfield__input,html body .sc-input,' +
          'html body .MuiInputBase-root,html body .MuiOutlinedInput-root,html body .MuiFilledInput-root,html body .MuiSelect-select,' +
          'html body .upload input:not([type=checkbox]):not([type=radio]):not([type=range]),html body .upload textarea,html body .upload select,' +
          'html body input#tokenInput__comment,html body input.textfield__input.sc-input.sc-input-medium,html body textarea.textfield__input.sc-input.sc-input-medium';
        add(FIELDS.split(',').map(function (x) { return x + ':not(.scc-x)'; }).join(','), 'background-color:' + fieldBg + ' !important', 'border-color:' + fieldBd + ' !important', I('color', c.text));
        add(FIELDS.split(',').map(function (x) { return x + ':focus'; }).join(','), 'background-color:' + mix(sb, acc || '#ffffff', acc ? 0.16 : 0.1) + ' !important',
          'border-color:' + (acc || fieldBd) + ' !important', 'outline:none !important', 'box-shadow:0 0 0 1px ' + (acc || fieldBd) + ' !important');
        /* поле тегов на странице загрузки: обёртка раньше всегда оставалась серой */
        add('html body .tagInput__inputWrapper,html body .tagInput__inputWrapper:hover,html body .tagInput__inputWrapper.focused,html body .tagInput__inputWrapper:focus-within',
          'background-color:' + fieldBg + ' !important', 'background-image:none !important', 'border-color:' + fieldBd + ' !important', I('color', c.text));
        add('html body .tagInput__inputWrapper:focus-within', 'border-color:' + (acc || fieldBd) + ' !important');
        add('html body .tagInput__inputWrapper input:not(.scc-x):not(.scc-y),html body .tagInput__inputWrapper input.sc-input:not(.scc-x),html body .tagInput__inputWrapper .tagInput__input:not(.scc-x),html body .tagInput__inputWrapper .textfield__input:not(.scc-x)',
          'background:transparent !important', 'background-image:none !important', 'border-color:transparent !important', 'box-shadow:none !important', I('color', c.text));
        add('html body .MuiOutlinedInput-notchedOutline', 'border-color:' + fieldBd + ' !important');
        add('html body .textfield__input::placeholder,html body .MuiInputBase-input::placeholder', I('color', c.text), 'opacity:.5 !important');
        /* «soundcloud.com/» перед адресом профиля (Edit your profile): оформляем как само поле и чуть выделяем */
        add('html body span.permalinkTextfield__prefixText.sc-text-light.sc-text-secondary,html body span.permalinkTextfield__prefixText',
          'background-color:' + fieldBg + ' !important', 'border-color:' + fieldBd + ' !important', I('color', c.text), 'opacity:1 !important', 'font-weight:700 !important');
        /* сообщения */
        add('html body div.conversationBadge:not(.scc-x),html body div.conversation__actions.sc-border-box.g-z-index-content:not(.scc-x),html body .conversationBadge__wrapper:not(.scc-x)',
          'background-color:' + sb + ' !important', 'background-image:none !important', 'border-color:' + fieldBd + ' !important');
        /* страница загрузки: общий фон, панели и диалоги MUI */
        add('html body .upload,html body .uploadMain,html body .uploadPage,html body .l-uploader,html body .g-uploader,html body main.MuiBox-root,html body .MuiContainer-root',
          'background-color:transparent !important');
        /* Плавающие окна (диалоги, меню, всплывашки) — всегда сплошные. Обычные панели страницы (комментарии, «Fans» и т.п.)
           получают прозрачность из «Карточки» (с картинкой фона и без неё). */
        const panelBg = rgba(sb, clamp(s.bg.cardOpacity, 0, 100) / 100);
        add('html body .MuiDialog-paper,html body .MuiPopover-paper,html body .MuiMenu-paper,html body .MuiDrawer-paper',
          'background-color:' + sb + ' !important', 'background-image:none !important', 'border-color:' + fieldBd + ' !important', I('color', c.text));
        /* :where() — нулевая специфичность, чтобы правила ниже (панель «Artist tools» и т.п.) могли это перебить */
        add('html body :where(.MuiPaper-root:not(.MuiDialog-paper):not(.MuiPopover-paper):not(.MuiMenu-paper):not(.MuiDrawer-paper)),html body .MuiCard-root,' +
          'html body .uploadDropzone,html body .dropzone,html body .uploadTrackPanel,html body .uploadEditor',
          'background-color:' + panelBg + ' !important', 'background-image:none !important', 'border-color:' + fieldBd + ' !important', I('color', c.text));
        add('html body .MuiTypography-root,html body .MuiFormLabel-root,html body .MuiFormControlLabel-label,html body .MuiButtonBase-root:not(.MuiButton-contained)', I('color', c.text));
        add('html body .MuiMenuItem-root:hover,html body .MuiListItemButton-root:hover,html body .MuiMenuItem-root.Mui-selected',
          'background-color:' + (acc ? rgba(acc, 0.2) : fieldBg) + ' !important');
        /* крупные обёртки страницы upload / сообщений — прозрачные, чтобы был виден фон темы */
        add('html body div.MuiBox-root.mui-1oo43kp,html body div.MuiModal-root.mui-1xdt1ux,html body footer.MuiBox-root.mui-zp4uuh,html body header.MuiStack-root.mui-1df8536,' +
          'html body div.MuiTabs-root.mui-bqrn0j,html body div.MuiStack-root.mui-1cif1a4,html body div.MuiBox-root.mui-sy2o42',
          'background:transparent !important', 'background-image:none !important');
        add('html body div.MuiPaper-root.MuiAccordion-root,html body div.mui-17ud3mo,html body div.inboxItem,html body div.playbackSoundBadge__queueCircle',
          'background-color:' + fieldBg + ' !important', 'background-image:none !important', 'border-color:' + fieldBd + ' !important');
        add('html body div.inboxItem.active,html body a.sc-tag,html body a.sc-tag:hover', 'background-color:' + (acc ? rgba(acc, 0.24) : fieldBg) + ' !important', I('color', c.text));
        add('html body button.MuiButton-outlined', 'background-color:' + fieldBg + ' !important', 'border-color:' + fieldBd + ' !important', I('color', c.text));
        if (acc) add('html body a.MuiBox-root.mui-4wjcze', 'background-color:' + acc + ' !important', I('color', c.accentText));
        /* заглушка плитки: сам блок прозрачный, а серый квадрат внутри красим цветом темы */
        add('html body div.audibleTilePlaceholder', 'background:transparent !important');
        add('html body div.audibleTilePlaceholder *:not(svg):not(svg *)', 'background-color:' + fieldBg + ' !important', 'background-image:none !important');
        add('html body div.queue .queueItemView,html body div.queue .queue__scrollableWrapper,html body div.queue .queue__itemsHeight,html body div.queue .queue__itemWrapper,html body div.queue__itemWrapper',
          'background-color:transparent !important', 'background-image:none !important', 'border-color:transparent !important');
        add('html body div.queue .queueItemView.m-active,html body div.queue .queueItemView.m-playing,html body div.queue .queueItemView.active,html body div.queue .queueItemView.m-current',
          'background-color:' + (acc ? rgba(acc, 0.22) : fieldBg) + ' !important');
        add('html body div.MuiStack-root.mui-j7qwjs', 'background-color:' + panelBg + ' !important', 'background-image:none !important', 'border-color:' + fieldBd + ' !important');
        /* панель «Artist tools»: вместо розовой акции SoundCloud — оттенок темы, плитки в цвет полей */
        /* панель «Artist tools»: фона нет совсем (ни у неё, ни у обёрток, ни у вложенных блоков, ни градиентной полосы),
           остаются только плитки-кнопки цветом акцента */
        const AT = 'div.mui-1j3t8w7';
        /* обёртки панели помечает content.js (data-scc-at); раньше тут был div[class*="Mui"]:has(...) — он заставлял браузер
           на любое изменение страницы (в том числе при движении ползунка плеера) заново проверять все MUI-блоки и красил весь их контент */
        const AT_WRAPS = ['html body [data-scc-at]'];
        const AT_ALL = ['html body ' + AT].concat(AT_WRAPS);
        const AT_PARTS = AT_ALL.map(function (x) { return x + ' *:not(a):not(button):not([role="button"]):not(svg):not(svg *):not(img):not(a *):not(button *)'; });
        const AT_PSEUDO = AT_ALL.concat(AT_ALL.map(function (x) { return x + ' *'; })).reduce(function (o, x) { return o.concat([x + '::before', x + '::after']); }, []);
        add(AT_ALL.concat(AT_PARTS).join(','), 'background:transparent !important', 'background-image:none !important', 'box-shadow:none !important',
          'border-color:transparent !important', 'backdrop-filter:none !important', '-webkit-backdrop-filter:none !important');
        add(AT_PSEUDO.join(','), 'background:transparent !important', 'background-image:none !important');
        add(AT_ALL.map(function (x) { return x + ' a,' + x + ' button,' + x + ' [role="button"]'; }).join(','),
          'background-color:' + (acc ? mix(sb, acc, 0.3) : fieldBg) + ' !important', 'background-image:none !important',
          'border-color:' + (acc ? mix(sb, acc, 0.55) : fieldBd) + ' !important', I('color', c.text));
        /* окно очереди: подписи и переключатель Autoplay */
        add('html body div.queueFallback__subheading,html body div.queueFallback__heading,html body div.queue .queueFallback *', I('color', c.text));
        add('html body label.toggle.sc-toggle:not(.sc-toggle-active)', 'background-color:' + fieldBd + ' !important', 'border-color:' + fieldBd + ' !important');
        /* включённый переключатель: оранжевый SoundCloud сдвигается по оттенку к акценту темы (белый ползунок не меняется) */
        if (acc) add('html body label.toggle.sc-toggle.sc-toggle-active', 'filter:' + hueFilter(acc) + ' !important',
          'box-shadow:0 0 8px ' + rgba(acc, 0.45) + ' !important');
        add('html body div.queue__itemWrapper', 'background:transparent !important', 'background-image:none !important');
        if (acc) add('html body .MuiButton-contained,html body .MuiButton-containedPrimary', 'background-color:' + acc + ' !important', I('color', c.accentText));
      }
    }

    /* --- плеер --- */
    add('.playControls,.playControls__inner,.playControls__wrapper', I('background-color', c.playerBg));
    add('.playControls a,.playbackSoundBadge__titleLink,.playbackSoundBadge__lightLink,.playbackTimeline__timePassed,.playbackTimeline__duration',
      I('color', c.playerText));
    add('.playControls .sc-button', 'background:transparent !important', 'border-color:transparent !important');
    const prog = c.progress || c.accent;
    add('.playbackTimeline__progressBar,.playbackTimeline__progressHandle,.volume__sliderProgress,.volume__sliderHandle',
      I('background-color', prog));
    /* Серая дорожка позади ползунка громкости: делаем её цветом акцента (приглушённым, чтобы заполненная часть выделялась) */
    const track = c.accent || prog;
    if (track) {
      add('html body .volume__sliderWrapper .volume__sliderBackground,html body .volume__sliderWrapper [class*="sliderBackground"]',
        'background:' + rgba(track, 0.3) + ' !important', 'background-color:' + rgba(track, 0.3) + ' !important',
        'background-image:none !important', 'border-color:transparent !important');
    }
    /* Обводка кружка ползунка (при наведении у сайта оранжевая / белая) — тоже цвета акцента */
    if (prog) {
      const HANDLES = ['.playbackTimeline__progressHandle', '.volume__sliderHandle'];
      const hs = [];
      HANDLES.forEach(function (h) { hs.push('html body ' + h, 'html body ' + h + ':hover', 'html body ' + h + ':active', 'html body ' + h + ':focus'); });
      hs.push('html body .playbackTimeline__progress:hover .playbackTimeline__progressHandle',
        'html body .volume__sliderWrapper:hover .volume__sliderHandle');
      add(hs.join(','), 'border-color:' + prog + ' !important', 'outline-color:' + prog + ' !important',
        'box-shadow:none !important', 'background-color:' + prog + ' !important');
    }
    /* кнопки плеера: с акцентом — переключатели акцентного цвета, иначе при необходимости белые */
    const PCTRL = '.playControls .skipControl,.playControls .repeatControl,.playControls .shuffleControl,.playControls .volume__iconWrapper';
    if (acc) {
      /* иконки-картинки (спрайты) перекрашиваем точным фильтром */
      add(PCTRL, 'filter:' + iconFilter(acc) + ' !important');
      add('.playControls .volume__iconWrapper::before,.playControls .skipControl::before',
        'color:' + acc + ' !important', 'fill:' + acc + ' !important', 'stroke:' + acc + ' !important');

      /* Кнопка play / pause. Родная иконка двухцветная (круг + треугольник): любой фильтр красит её в один цвет,
         и треугольник сливается с кругом. Поэтому рисуем свою: круг акцентного цвета и контрастный значок.
         Состояние play/pause сайт помечает классом .playing. */
      const glyph = glyphOn(acc, c.accentText);
      const svgUrl = function (inner) {
        return 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
          '<circle cx="16" cy="16" r="15" fill="' + acc + '"/>' + inner + '</svg>') + '")';
      };
      const playImg = svgUrl('<path d="M13 10.4 L23 16 L13 21.6 Z" fill="' + glyph + '" stroke="' + glyph + '" stroke-width="1.8" stroke-linejoin="round"/>');
      const pauseImg = svgUrl('<rect x="10.6" y="9.8" width="3.8" height="12.4" rx="1.1" fill="' + glyph + '"/>' +
        '<rect x="17.6" y="9.8" width="3.8" height="12.4" rx="1.1" fill="' + glyph + '"/>');
      const PLAY = 'html body .playControls .playControl';
      add(PLAY, 'background-image:' + playImg + ' !important', 'background-repeat:no-repeat !important',
        'background-position:center !important', 'background-size:contain !important',
        'background-color:transparent !important', 'filter:none !important');
      add(PLAY + '.playing', 'background-image:' + pauseImg + ' !important');
      add(PLAY + '::before,' + PLAY + '::after', 'content:none !important', 'background:none !important', 'filter:none !important');
      /* родной значок может лежать глубже (svg / span внутри кнопки) — прячем всё содержимое, рисуем только свой */
      add(PLAY + ' *', 'display:none !important');
      add(PLAY, 'color:transparent !important', 'font-size:0 !important');
      add(PLAY + ':hover', 'filter:brightness(1.15) !important');

      /* Лайк, подписка и остальные кнопки справа в плеере: в покое — приглушённые нейтральные,
         нажатые (лайкнут / подписан) — цвета «нажатой кнопки». Раньше оба состояния были акцентными, и их было не отличить. */
      const pBase = c.playerBg || c.surfaceBg || c.pageBg || '';
      const pText = c.playerText || (pBase && lumOf(pBase) > 0.5 ? '#333333' : '#f2f2f2');
      const idle = pBase ? mix(pText, pBase, 0.42) : pText;
      const P_IDLE = 'html body .playControls .sc-button' + NOT_ACT;
      add(P_IDLE + '::before', 'filter:' + iconFilter(idle) + ' !important');
      add(P_IDLE, I('color', idle));
      add(P_IDLE + ' svg,' + P_IDLE + ' svg *', 'fill:' + idle + ' !important');
      if (likeC) {
        const P_ACT = IS_ACT.map(function (x) { return x.replace('html body .sc-button', 'html body .playControls .sc-button'); });
        add(P_ACT.map(function (x) { return x + ' svg,' + x + ' svg *'; }).join(','), 'fill:' + likeC + ' !important');
      }
    }

    /* --- шрифт --- */
    const fontFiles = activeFontFiles(s, assets);
    let fam = '';
    if (s.font.mode === 'system' && cleanName(s.font.system)) fam = familyCss(s.font.system);
    else if (fontFiles.length) fam = '"SCC Font"';
    if (fam) {
      add('html,body,body *,input,button,textarea,select', 'font-family:' + fam + ',sans-serif !important');
    }
    if (s.font.letterSpacing !== '' && s.font.letterSpacing != null && isFinite(Number(s.font.letterSpacing))) {
      add('body *', 'letter-spacing:' + clamp(s.font.letterSpacing, -3, 10) + 'px !important');
    }

    if (s.font.size && Number(s.font.size) !== 100) add('html', '--scc-font-scale:' + (Number(s.font.size) / 100));   // сам масштаб применяет content.js

    /* --- свой CSS (последним — перебивает всё остальное) --- */
    if (s.customCss && String(s.customCss).trim()) out.push(String(s.customCss));

    return out.join('\n');
  }


  /* ---------- проверка данных из хранилища и из файла резервной копии ---------- */
  /* Всё, что приходит извне (импорт бэкапа, старые версии, правка storage), приводится к известной форме:
     лишние ключи отбрасываются, числа и цвета проверяются, строки ограничиваются по длине. */
  const str = function (v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; };
  const bool = function (v, d) { return typeof v === 'boolean' ? v : d; };
  const MAX_CSS = 200000;

  function sanitizeSettings(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = merge(DEFAULTS, {});
    out.enabled = bool(r.enabled, true);
    out.colors = {};
    if (r.colors && typeof r.colors === 'object') {
      for (const group of COLOR_FIELDS) for (const it of group.items) {
        const v = r.colors[it[0]];
        if (typeof v === 'string' && HEX.test(v)) out.colors[it[0]] = v.toLowerCase();
      }
    }
    const f = r.flags && typeof r.flags === 'object' ? r.flags : {};
    out.flags = {
      sceneFollowsAccent: bool(f.sceneFollowsAccent, true),
      styledTopBars: bool(f.styledTopBars, true),
      hoverAccent: bool(f.hoverAccent, true),
      hoverStrength: clamp(f.hoverStrength == null ? 0 : f.hoverStrength, 0, 100),
      hideArtistTools: bool(f.hideArtistTools, false),
    };
    out.presetName = str(r.presetName, 60);
    const fo = r.font && typeof r.font === 'object' ? r.font : {};
    out.font = {
      mode: ['default', 'system', 'google', 'file', 'pixel'].indexOf(fo.mode) >= 0 ? fo.mode : 'default',   // неизвестные (устаревшие) значения сбрасываются на 'default'
      system: cleanName(str(fo.system, 80)), google: cleanName(str(fo.google, 80)), fileName: str(fo.fileName, 120).replace(/[<>]/g, ''),
      letterSpacing: fo.letterSpacing === '' || fo.letterSpacing == null || !isFinite(Number(fo.letterSpacing)) ? '' : clamp(fo.letterSpacing, -3, 10),
      size: fo.size == null || !isFinite(Number(fo.size)) ? 100 : clamp(fo.size, 70, 200),
    };
    const b = r.bg && typeof r.bg === 'object' ? r.bg : {};
    out.bg = {
      enabled: bool(b.enabled, false), url: safeUrl(b.url),
      size: ['cover', 'contain', 'repeat'].indexOf(b.size) >= 0 ? b.size : 'cover',
      position: ['center center', 'center top', 'center bottom', 'left center', 'right center'].indexOf(b.position) >= 0 ? b.position : 'center center',
      fixed: bool(b.fixed, true), blur: clamp(b.blur, 0, 60), brightness: clamp(b.brightness == null ? 100 : b.brightness, 10, 200),
      videoUrl: safeVideoUrl(extractVideoInput(b.videoUrl)),
      videoSource: b.videoSource === 'file' ? 'file' : 'url', videoFileName: str(b.videoFileName, 120).replace(/[<>]/g, ''),
      videoFileId: isFinite(Number(b.videoFileId)) && Number(b.videoFileId) > 0 ? Math.floor(Number(b.videoFileId)) : 0,
      videoInBackground: bool(b.videoInBackground, false), videoPauseScroll: bool(b.videoPauseScroll, true),
      videoBlur: clamp(b.videoBlur == null ? 0 : b.videoBlur, 0, 100), videoBright: clamp(b.videoBright == null ? 0 : b.videoBright, -80, 50),
      overlayColor: HEX.test(b.overlayColor || '') ? b.overlayColor : '#000000', overlayOpacity: clamp(b.overlayOpacity == null ? 25 : b.overlayOpacity, 0, 95),
      cardOpacity: clamp(b.cardOpacity == null ? 0 : b.cardOpacity, 0, 100),
    };
    out.customCss = str(r.customCss, MAX_CSS);
    const u = r.ui && typeof r.ui === 'object' ? r.ui : {};
    out.ui = {
      opacity: clamp(u.opacity == null ? 75 : u.opacity, 0, 100), dim: clamp(u.dim == null ? 25 : u.dim, 0, 100),
      blur: clamp(u.blur == null ? 10 : u.blur, 0, 40), width: clamp(u.width == null ? 940 : u.width, 640, 1400),
    };
    return out;
  }

  const B64 = /^[A-Za-z0-9+/=\s]*$/;
  function sanitizeAssets(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    if (typeof r.bgImage === 'string' && r.bgImage.length < 60 * 1024 * 1024 && /^data:image\//i.test(r.bgImage) && safeUrl(r.bgImage)) out.bgImage = safeUrl(r.bgImage);
    if (Array.isArray(r.fontFiles)) {
      out.fontFiles = r.fontFiles.slice(0, 40).filter(function (x) {
        return x && typeof x.data === 'string' && x.data.length < 12 * 1024 * 1024 && B64.test(x.data);
      }).map(function (x) {
        const o = { data: x.data, weight: /^[\d\sa-z]{1,20}$/i.test(String(x.weight || '')) ? String(x.weight) : '400',
          style: /^(normal|italic|oblique)$/.test(String(x.style || '')) ? String(x.style) : 'normal' };
        if (typeof x.unicodeRange === 'string' && /^[U+0-9A-Fa-f,\s?-]{1,300}$/.test(x.unicodeRange)) o.unicodeRange = x.unicodeRange;
        return o;
      });
      out.fontSource = ['google', 'file', 'pixel'].indexOf(r.fontSource) >= 0 ? r.fontSource : '';
    }
    return out;
  }

  /* Свой CSS из чужого файла: есть ли в нём @import или внешние адреса (через них можно отслеживать пользователя) */
  function cssHasExternal(css) {
    return /@import|url\(\s*["']?\s*(https?:)?\/\//i.test(String(css || ''));
  }

  /* Настройки «из коробки»: тема AMOLED. Используются, пока пользователь ничего не сохранял. */
  function defaultSettings() {
    const g = PRESETS.find(function (p) { return p.name === 'AMOLED'; }) || PRESETS[0];
    const out = merge(DEFAULTS, { colors: Object.assign({}, g.colors), flags: Object.assign({}, g.flags || {}), presetName: g.name });
    if (g.cardOpacity != null) out.bg.cardOpacity = g.cardOpacity;
    return out;
  }

  root.SCC = {
    defaultSettings: defaultSettings,
    sanitizeSettings: sanitizeSettings,
    sanitizeAssets: sanitizeAssets,
    cssHasExternal: cssHasExternal,
    HEX: HEX,
    COLOR_FIELDS: COLOR_FIELDS,
    DEFAULTS: DEFAULTS,
    PRESETS: PRESETS,
    merge: merge,
    buildCss: buildCss,
    hasBgImage: hasBgImage,
    safeVideoUrl: safeVideoUrl,
    extractVideoInput: extractVideoInput,
    parseVideo: parseVideo,
    videoSpec: videoSpec,
    embedUrl: embedUrl,
    contrast: contrast,
    relLum: relLum,
    glyphOn: glyphOn,
    mix: mix,
    rgba: rgba,
    familyCss: familyCss,
    activeFontFiles: activeFontFiles,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
