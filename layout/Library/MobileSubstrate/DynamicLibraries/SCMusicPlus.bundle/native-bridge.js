(() => {
  'use strict';
  const mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sccNative;
  if (!mh) return;
  if (window.browser && window.browser.__scc) return;
  window.__sccApp = true;
  const listeners = new Set();
  const pending = new Map();
  let seq = 0;
  const send = (m) => { try { return mh.postMessage(m); } catch (_) { return null; } };

  const storage = {
    async get(keys) {
      let list = null, defs = {};
      if (typeof keys === 'string') list = [keys];
      else if (Array.isArray(keys)) list = keys.slice();
      else if (keys && typeof keys === 'object') { defs = keys; list = Object.keys(keys); }
      const id = 'r' + (++seq);
      // Ответ нативной стороны адресуется по id: параллельные get() не мешают друг другу.
      const r = await new Promise((resolve) => {
        pending.set(id, resolve);
        send({ op: 'get', keys: list, defaults: defs, id });
        setTimeout(() => { if (pending.delete(id)) resolve(null); }, 5000);
      });
      return r || defs || {};
    },
    async set(items) { send({ op: 'set', items: items || {} }); },
    async remove(keys) { send({ op: 'remove', keys: Array.isArray(keys) ? keys : [keys] }); }
  };
  window.__sccNativeReply = (id, r) => { const f = pending.get(id); if (f) { pending.delete(id); f(r || {}); } };
  window.__sccStorageChanged = (changes) => { for (const fn of [...listeners]) { try { fn(changes, 'local'); } catch (_) {} } };

  // Файлы расширения лежат в Web/ext/. Страница настроек уже там (относительный путь работает),
  // а app.html лежит в корне бандла — для неё добавляем префикс.
  const getURL = (p) => {
    const rel = String(p || '').replace(/^\/+/, '');
    try {
      const base = document.baseURI || location.href;
      return new URL(base.indexOf('/Web/ext/') >= 0 ? rel : 'Web/ext/' + rel, base).href;
    } catch (_) { return rel; }
  };

  window.browser = {
    __scc: true,
    storage: { local: storage, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } },
    runtime: {
      id: 'scc-customizer@native',
      getURL,
      sendMessage: msg => send({ op: 'msg', msg }),
      onMessage: { addListener() {}, removeListener() {} }
    }
  };
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    if (e.data.__scc === 'np') send({ op: 'np', cmd: e.data.op === 'cmd' ? e.data.cmd : 'get', value: e.data.value });
  });
})();
