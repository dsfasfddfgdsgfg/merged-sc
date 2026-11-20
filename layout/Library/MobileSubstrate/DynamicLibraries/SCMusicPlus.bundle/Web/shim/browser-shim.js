/* Прослойка browser.* поверх нативного моста WKWebView. Подставляются: __HANDLER__, __ONLY__, __APPFLAG__ */
(() => {
  'use strict';
  const H = '__HANDLER__', ONLY = '__ONLY__', APPFLAG = __APPFLAG__;
  if (ONLY && location.protocol !== ONLY) return;
  const mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers[H];
  if (!mh || window.browser && window.browser.__scc) return;
  if (APPFLAG) window.__sccApp = true;
  const ID = 'scc-customizer@app';
  const call = (m) => mh.postMessage(m);
  const stL = new Set(), msgL = new Set();

  const local = {
    async get(keys) {
      let list = null, defs = null;
      if (typeof keys === 'string') list = [keys];
      else if (Array.isArray(keys)) list = keys.slice();
      else if (keys && typeof keys === 'object') { defs = keys; list = Object.keys(keys); }
      const r = (await call({ op: 'get', keys: list })) || {};
      if (defs) for (const k of Object.keys(defs)) if (!(k in r)) r[k] = defs[k];
      return r;
    },
    async set(items) { await call({ op: 'set', items: items || {} }); },
    async remove(keys) { await call({ op: 'remove', keys: Array.isArray(keys) ? keys : [keys] }); },
  };
  const onChanged = {
    addListener: (fn) => { if (typeof fn === 'function') stL.add(fn); },
    removeListener: (fn) => { stL.delete(fn); },
    hasListener: (fn) => stL.has(fn),
  };
  window.__sccStorageChanged = (changes) => { for (const fn of Array.from(stL)) { try { fn(changes, 'local'); } catch (e) { /* ignore */ } } };
  window.__sccDeliver = (msg) => {
    for (const fn of Array.from(msgL)) { try { fn(msg, { id: ID }, () => {}); } catch (e) { /* ignore */ } }
  };
  window.browser = {
    __scc: true,
    storage: { local, onChanged },
    runtime: {
      id: ID,
      getURL: (p) => 'scc-ext://ext/' + String(p || '').replace(/^\/+/, ''),
      sendMessage: (msg) => call({ op: 'msg', msg }),
      onMessage: { addListener: (fn) => { if (typeof fn === 'function') msgL.add(fn); }, removeListener: (fn) => { msgL.delete(fn); } },
    },
  };
  if (window !== window.top) { try { call({ op: 'hello' }); } catch (e) { /* ignore */ } }
})();
