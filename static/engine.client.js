(function () {
  const base = window.__oblivion_base || location.href;

  function proxyUrl(url) {
    try {
      if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
      if (url.startsWith('/proxy?url=')) return url; // already proxied, leave it
      if (url.startsWith('//')) url = 'https:' + url;
      const abs = new URL(url, base).href;
      if (!abs.startsWith('http://') && !abs.startsWith('https://')) return url;
      return '/proxy?url=' + encodeURIComponent(abs);
    } catch { return url; }
  }

  // Extract real URL from a possibly-already-proxied href
  function extractReal(href) {
    if (!href) return null;
    if (href.startsWith('/proxy?url=')) {
      return decodeURIComponent(href.slice('/proxy?url='.length));
    }
    try {
      const abs = new URL(href, base).href;
      if (abs.startsWith('http://') || abs.startsWith('https://')) return abs;
    } catch {}
    return null;
  }

  window.__oblivion_proxy_url = proxyUrl;

  // ── Intercept fetch ───────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (url, opts) {
    if (typeof url === 'string') {
      if (url.startsWith('http://') || url.startsWith('https://')) url = proxyUrl(url);
      else if (url.startsWith('/') && !url.startsWith('/proxy')) url = proxyUrl(url);
    }
    return _fetch.call(this, url, opts);
  };

  // ── Intercept XHR ────────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    if (typeof url === 'string') {
      if (url.startsWith('http://') || url.startsWith('https://')) url = proxyUrl(url);
      else if (url.startsWith('/') && !url.startsWith('/proxy')) url = proxyUrl(url);
    }
    return _open.call(this, method, url, ...args);
  };

  // ── Intercept link clicks ─────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    const real = extractReal(href);
    if (!real) return;
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ type: 'oblivion-navigate', url: real }, '*');
  }, true);

  // ── Intercept form submissions ────────────────────────────────────────────
  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (!form || form.method.toLowerCase() === 'post') return;
    const action = form.getAttribute('action');
    const real = extractReal(action || location.href);
    if (!real) return;
    e.preventDefault();
    const params = new URLSearchParams(new FormData(form)).toString();
    window.parent.postMessage({ type: 'oblivion-navigate', url: real + (params ? '?' + params : '') }, '*');
  }, true);

  // ── Intercept SPA navigation (pushState / replaceState) ───────────────────
  function interceptHistory(method) {
    const orig = history[method];
    history[method] = function (state, title, url) {
      if (url) {
        try {
          const abs = new URL(url, base).href;
          window.parent.postMessage({ type: 'oblivion-url', url: abs }, '*');
        } catch {}
      }
      return orig.apply(this, arguments);
    };
  }
  interceptHistory('pushState');
  interceptHistory('replaceState');

  window.addEventListener('popstate', function () {
    window.parent.postMessage({ type: 'oblivion-url', url: base }, '*');
  });

  // ── Intercept window.location assignments ─────────────────────────────────
  try {
    const locProto = Object.getPrototypeOf(window.location);
    const origAssign = window.location.assign.bind(window.location);
    const origReplace = window.location.replace.bind(window.location);

    window.location.assign = function (url) {
      const real = extractReal(url);
      if (real) { window.parent.postMessage({ type: 'oblivion-navigate', url: real }, '*'); }
      else origAssign(url);
    };
    window.location.replace = function (url) {
      const real = extractReal(url);
      if (real) { window.parent.postMessage({ type: 'oblivion-navigate', url: real }, '*'); }
      else origReplace(url);
    };
  } catch {}

  // ── Notify parent of current URL ─────────────────────────────────────────
  window.parent.postMessage({ type: 'oblivion-url', url: base }, '*');
})();
