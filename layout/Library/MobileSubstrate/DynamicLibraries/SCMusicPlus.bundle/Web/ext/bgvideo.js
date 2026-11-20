/* Запасной проигрыватель видео-фона. Работает в странице расширения внутри iframe, поэтому не зависит от CSP сайта.
   Играет: прямую ссылку на файл (?u=), YouTube / VK (?u=, плеер сайта во вложенном iframe) и свой файл из настроек (?l=<метка>).
   Свой файл лежит в storage.local кусками (vid_<метка>_<n>, base64) — страница расширения собирает из них Blob. */
(() => {
  'use strict';
  const num = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));

  /* свой файл: собираем Blob из кусков, не держа в памяти все строки сразу */
  async function loadLocal(id) {
    const st = browser.storage.local;
    const meta = (await st.get('vidmeta')).vidmeta;
    if (!meta || meta.id !== id || !(meta.chunks > 0) || meta.chunks > 4000) return null;
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      const key = 'vid_' + id + '_' + i;
      const b64 = (await st.get(key))[key];
      if (typeof b64 !== 'string') return null;
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
      parts.push(u8);
    }
    return new Blob(parts, { type: /^video\/[\w.+-]+$/.test(meta.type || '') ? meta.type : 'video/mp4' });
  }

  addEventListener('DOMContentLoaded', async () => {
    const q = new URLSearchParams(location.search);
    /* Размер, положение и «играть в свёрнутом» могут меняться «на лету»: верхняя страница присылает их сообщением.
       Размытие и яркость задаются на самом iframe снаружи, здесь их нет. */
    const st = {
      keep: q.get('k') === '1', scroll: false,
      fit: q.get('f') === 'contain' ? 'contain' : 'cover',
      pos: /^(center|left|right)( (center|top|bottom))?$/.test(q.get('p') || '') ? q.get('p') : 'center center',
    };
    const localId = Math.floor(Number(q.get('l')));
    let spec = null;
    if (localId > 0) spec = { kind: 'local', id: localId };
    else {
      const url = q.get('u') || '';
      if (url.length > 2000) return;
      spec = SCC.parseVideo(url);
    }
    if (!spec) return;

    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const hardStop = () => (document.hidden && !st.keep) || still.matches;
    let layout = () => {}, sync = () => {};

    addEventListener('message', (e) => {
      if (e.source !== parent || !e.data || e.data.__scc !== 'vid') return;
      const d = e.data;
      if (d.fit === 'cover' || d.fit === 'contain') st.fit = d.fit;
      if (/^(center|left|right)( (center|top|bottom))?$/.test(d.pos || '')) st.pos = d.pos;
      st.keep = !!d.keep; st.scroll = !!d.scroll;
      layout(); sync();
    });

    /* YouTube / VK */
    if (spec.kind === 'youtube' || spec.kind === 'vk') {
      const src = SCC.embedUrl(spec, '');
      const f = document.createElement('iframe');
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      f.setAttribute('allow', 'encrypted-media; picture-in-picture');
      f.setAttribute('scrolling', 'no');
      layout = () => {
        const p = st.pos.split(' '), hx = p[0], vy = p[1] || 'center';
        const fn = st.fit === 'contain' ? 'min' : 'max';
        f.style.cssText = 'position:fixed;pointer-events:none;background:transparent;' +
          'left:' + (hx === 'left' ? '0' : hx === 'right' ? '100%' : '50%') + ';top:' + (vy === 'top' ? '0' : vy === 'bottom' ? '100%' : '50%') + ';' +
          'width:' + fn + '(100vw,177.78vh);height:' + fn + '(100vh,56.25vw);' +
          'transform:translate(' + (hx === 'left' ? '0%' : hx === 'right' ? '-100%' : '-50%') + ',' + (vy === 'top' ? '0%' : vy === 'bottom' ? '-100%' : '-50%') + ');';
      };
      layout();
      f.src = src;
      document.body.append(f);
      sync = () => {
        const hard = hardStop();
        if (spec.kind === 'youtube') {
          try { f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: (hard || st.scroll) ? 'pauseVideo' : 'playVideo', args: [] }), 'https://www.youtube.com'); } catch (e) { /* ignore */ }
        } else {
          const want = hard ? 'about:blank' : src;
          if (f.getAttribute('src') !== want) f.setAttribute('src', want);
        }
      };
      f.addEventListener('load', sync);
      document.addEventListener('visibilitychange', sync);
      still.addEventListener('change', sync);
      return;
    }

    /* прямая ссылка или свой файл */
    const v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.preload = 'auto'; v.disablePictureInPicture = true; v.disableRemotePlayback = true; v.controls = false;
    layout = () => { v.style.objectFit = st.fit; v.style.objectPosition = st.pos; };
    layout();
    let objUrl = '';
    if (spec.kind === 'local') {
      let blob = null;
      try { blob = await loadLocal(spec.id); } catch (e) { /* ignore */ }
      if (!blob) return;
      objUrl = URL.createObjectURL(blob);
      v.src = objUrl;
      addEventListener('pagehide', () => { try { URL.revokeObjectURL(objUrl); } catch (e) { /* ignore */ } });
    } else {
      v.src = spec.url;
    }
    document.body.append(v);
    sync = () => {
      if (hardStop() || st.scroll) v.pause(); else v.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', sync);
    still.addEventListener('change', sync);
    v.addEventListener('canplay', sync);
    sync();
  });
})();
