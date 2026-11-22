(() => {
  'use strict';
  const mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sccNative;
  if (!mh) return;
  window.__sccApp = true;
  const listeners = new Set();
  const send = (m) => { try { return mh.postMessage(m); } catch (_) { return null; } };
  const storage = {
    async get(keys) {
      let list = null, defs = {};
      if (typeof keys === 'string') list = [keys];
      else if (Array.isArray(keys)) list = keys.slice();
      else if (keys && typeof keys === 'object') { defs = keys; list = Object.keys(keys); }
      const id = Math.random().toString(36).slice(2);
      const r = await new Promise(resolve => {
        window.__sccNativeResolve = resolve;
        send({op:'get', keys:list, defaults:defs, id});
      });
      return r || defs || {};
    },
    async set(items) { send({op:'set', items:items || {}}); },
    async remove(keys) { send({op:'remove', keys:Array.isArray(keys) ? keys : [keys]}); }
  };
  window.__sccNativeReply = (r) => { const f = window.__sccNativeResolve; window.__sccNativeResolve = null; if (f) f(r || {}); };
  window.__sccStorageChanged = (changes) => { for (const fn of [...listeners]) { try { fn(changes, 'local'); } catch (_) {} } };
  window.browser = {
    __scc: true,
    storage: { local: storage, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } },
    runtime: {
      id: 'scc-customizer@native',
      getURL: p => 'file://' + String(p || '').replace(/^\/+/, ''),
      sendMessage: msg => send({op:'msg', msg}),
      onMessage: { addListener() {}, removeListener() {} }
    }
  };
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    if (e.data.__scc === 'np') send({op:'np', cmd:e.data.op === 'cmd' ? e.data.cmd : 'get', value:e.data.value});
  });
})();
