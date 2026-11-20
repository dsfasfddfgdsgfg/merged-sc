/* Ширина «компьютерной» страницы на телефоне. __VP__ подставляет приложение. */
(() => {
  const W = __VP__;
  if (!W) return;
  const set = () => {
    const root = document.documentElement; if (!root) return;
    let m = document.querySelector('meta[name=viewport]');
    if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || root).appendChild(m); }
    const c = 'width=' + W + ', viewport-fit=cover, user-scalable=yes';
    if (m.content !== c) m.content = c;
  };
  set();
  new MutationObserver(set).observe(document.documentElement, { childList: true });
  document.addEventListener('DOMContentLoaded', () => { set(); if (document.head) new MutationObserver(set).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] }); });
})();
