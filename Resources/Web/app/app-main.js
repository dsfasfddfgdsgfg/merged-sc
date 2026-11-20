/* Мир страницы: что сейчас играет и управление плеером SoundCloud (Media Session + аудио-элемент + запасные кнопки на странице). */
(() => {
  'use strict';
  if (window !== window.top || window.__sccNp) return;
  window.__sccNp = true;
  const ORIGIN = location.origin && location.origin !== 'null' ? location.origin : '*';
  const handlers = Object.create(null);
  let pos = null, lastEl = null;

  const MS = window.MediaSession && window.MediaSession.prototype;
  if (MS && MS.setActionHandler) {
    const o = MS.setActionHandler;
    MS.setActionHandler = function (a, fn) { try { handlers[a] = fn || null; } catch (e) { /* ignore */ } return o.apply(this, arguments); };
  }
  if (MS && MS.setPositionState) {
    const o = MS.setPositionState;
    MS.setPositionState = function (st) {
      try { pos = st ? { duration: +st.duration, position: +st.position, t: Date.now() } : null; } catch (e) { /* ignore */ }
      return o.apply(this, arguments);
    };
  }
  const note = (el) => { if (el instanceof HTMLMediaElement && !el.muted && el.volume > 0) lastEl = el; };
  const op = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { try { note(this); } catch (e) { /* ignore */ } return op.apply(this, arguments); };
  document.addEventListener('playing', (e) => note(e.target), true);

  const $ = (sels) => { for (const s of sels) { try { const el = document.querySelector(s); if (el) return el; } catch (e) { /* ignore */ } } return null; };
  const LIKE = ['.playbackSoundBadge__like', '.playControls .sc-button-like', '.playControls [class*="like" i]'];
  const PLAY = ['.playControls__play', '.playControl', 'button[aria-label*="Pause" i]', 'button[aria-label*="Play" i]', 'button[title*="Pause" i]', 'button[title*="Play" i]'];
  const NEXT = ['.skipControl__next', '.playControls__next', 'button[aria-label*="Next" i]', 'button[title*="Next" i]'];
  const PREV = ['.skipControl__previous', '.playControls__prev', 'button[aria-label*="Previous" i]', 'button[title*="Previous" i]'];

  function snapshot() {
    const ms = navigator.mediaSession, md = ms && ms.metadata, el = lastEl;
    const art = [];
    if (md && md.artwork) for (const a of Array.from(md.artwork)) art.push({ src: String(a.src || ''), sizes: String(a.sizes || '') });
    const like = $(LIKE);
    return {
      title: md ? String(md.title || '') : '', artist: md ? String(md.artist || '') : '', album: md ? String(md.album || '') : '', art,
      playing: el ? !el.paused && !el.ended : !!(ms && ms.playbackState === 'playing'),
      position: el ? el.currentTime : pos ? pos.position : 0,
      duration: el && isFinite(el.duration) ? el.duration : pos ? pos.duration : 0,
      like: like ? { has: true, on: /selected|active|sc-button-selected/.test(like.className + ' ' + (like.getAttribute('aria-pressed') || '')) || like.getAttribute('aria-pressed') === 'true' } : { has: false, on: false },
    };
  }
  function cmd(c, v) {
    const el = lastEl;
    try {
      if (c === 'toggle') {
        const playing = el ? !el.paused : false, h = playing ? handlers.pause : handlers.play;
        if (h) { h({ action: playing ? 'pause' : 'play' }); return; }
        const b = $(PLAY); if (b) { b.click(); return; }
        if (el) { if (playing) el.pause(); else el.play(); }
      } else if (c === 'next') {
        if (handlers.nexttrack) { handlers.nexttrack({ action: 'nexttrack' }); return; }
        const b = $(NEXT); if (b) b.click();
      } else if (c === 'prev') {
        if (handlers.previoustrack) { handlers.previoustrack({ action: 'previoustrack' }); return; }
        const b = $(PREV); if (b) b.click();
      } else if (c === 'seek') {
        const t = Number(v);
        if (el && isFinite(el.duration) && isFinite(t)) el.currentTime = Math.max(0, Math.min(el.duration, t));
        else if (handlers.seekto) handlers.seekto({ action: 'seekto', seekTime: t });
      } else if (c === 'like') {
        const b = $(LIKE); if (b) b.click();
      }
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__scc !== 'np') return;
    if (e.data.op === 'get') window.postMessage({ __scc: 'np-state', s: snapshot() }, ORIGIN);
    else if (e.data.op === 'cmd') cmd(String(e.data.cmd), e.data.value);
  });
})();
