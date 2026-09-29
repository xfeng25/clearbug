// Runs in the page's own JavaScript world so it can see errors the page produces.
// It only observes: every original function is still called unchanged.
// Findings are handed to recorder.js via window.postMessage.
(() => {
  if (window.__clearbugHook) return;
  Object.defineProperty(window, '__clearbugHook', { value: true });

  const post = (kind, message, detail) => {
    try {
      window.postMessage({
        __clearbug: true,
        kind,
        message: String(message).slice(0, 400),
        detail: detail ? String(detail).slice(0, 300) : undefined,
      }, '*');
    } catch (_) { /* ignore */ }
  };

  const fmt = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  };

  const short = (u) => {
    try {
      const x = new URL(u, location.href);
      return x.origin === location.origin ? x.pathname + x.search : x.href;
    } catch (_) { return String(u); }
  };

  // console.error
  const origError = console.error;
  console.error = function (...args) {
    post('console', args.map(fmt).join(' '));
    return origError.apply(this, args);
  };

  // Uncaught errors and failed resources (images, scripts, css)
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName) {
      post('resource', `Failed to load ${t.tagName.toLowerCase()}: ${short(t.src || t.href || '')}`);
      return;
    }
    post('js', e.message || 'Script error', e.filename ? `${short(e.filename)}:${e.lineno}` : '');
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    post('js', `Unhandled promise rejection: ${fmt(e.reason)}`);
  });

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return origFetch.apply(this, arguments).then(
        (res) => {
          if (!res.ok) post('network', `${method} ${short(url)} → ${res.status} ${res.statusText || ''}`.trim());
          return res;
        },
        (err) => {
          if (!(err && err.name === 'AbortError')) {
            post('network', `${method} ${short(url)} → request failed (${err && err.message})`);
          }
          throw err;
        }
      );
    };
  }

  // XMLHttpRequest
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cb = { method: String(method).toUpperCase(), url, aborted: false };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const info = this.__cb;
    if (info) {
      this.addEventListener('abort', () => { info.aborted = true; });
      this.addEventListener('loadend', () => {
        if (info.aborted) return;
        if (this.status === 0 || this.status >= 400) {
          const status = this.status ? `${this.status} ${this.statusText || ''}`.trim() : 'request failed';
          post('network', `${info.method} ${short(info.url)} → ${status}`);
        }
      });
    }
    return XS.apply(this, arguments);
  };

  // Single-page-app route changes
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      post('route', location.href);
      return r;
    };
  }
  window.addEventListener('popstate', () => post('route', location.href));
})();
