// Runs in the page's own JavaScript world so it can see errors the page produces.
// It only observes: every original function is still called unchanged.
// Findings are handed to recorder.js via window.postMessage.
//
// The hook is only installed while a ClearBug test session is running.
// When the session stops, recorder.js tells the hook to remove itself and the
// page's original fetch / XHR / console / history functions are restored, so
// ClearBug is not in the call stack of pages you are not testing.
(() => {
  if (window.__clearbugHook) {
    // Already present (e.g. injected again when a new session starts)
    if (typeof window.__clearbugHook.install === 'function') window.__clearbugHook.install();
    return;
  }

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

  const orig = {
    error: console.error,
    fetch: window.fetch,
    open: XMLHttpRequest.prototype.open,
    send: XMLHttpRequest.prototype.send,
    pushState: history.pushState,
    replaceState: history.replaceState,
  };

  // ---- wrappers ----
  const wrapped = {};

  wrapped.error = function (...args) {
    post('console', args.map(fmt).join(' '));
    return orig.error.apply(this, args);
  };

  if (typeof orig.fetch === 'function') {
    wrapped.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return orig.fetch.apply(this, arguments).then(
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

  wrapped.open = function (method, url) {
    this.__cb = { method: String(method).toUpperCase(), url, aborted: false };
    return orig.open.apply(this, arguments);
  };
  wrapped.send = function () {
    const info = this.__cb;
    if (info && installed) {
      this.addEventListener('abort', () => { info.aborted = true; });
      this.addEventListener('loadend', () => {
        if (info.aborted || !installed) return;
        if (this.status === 0 || this.status >= 400) {
          const status = this.status ? `${this.status} ${this.statusText || ''}`.trim() : 'request failed';
          post('network', `${info.method} ${short(info.url)} → ${status}`);
        }
      });
    }
    return orig.send.apply(this, arguments);
  };

  for (const fn of ['pushState', 'replaceState']) {
    wrapped[fn] = function () {
      const r = orig[fn].apply(this, arguments);
      post('route', location.href);
      return r;
    };
  }

  // ---- listeners ----
  const onError = (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName) {
      post('resource', `Failed to load ${t.tagName.toLowerCase()}: ${short(t.src || t.href || '')}`);
      return;
    }
    post('js', e.message || 'Script error', e.filename ? `${short(e.filename)}:${e.lineno}` : '');
  };
  const onRejection = (e) => post('js', `Unhandled promise rejection: ${fmt(e.reason)}`);
  const onPop = () => post('route', location.href);

  let installed = false;

  function install() {
    if (installed) return;
    installed = true;
    console.error = wrapped.error;
    if (wrapped.fetch) window.fetch = wrapped.fetch;
    XMLHttpRequest.prototype.open = wrapped.open;
    XMLHttpRequest.prototype.send = wrapped.send;
    history.pushState = wrapped.pushState;
    history.replaceState = wrapped.replaceState;
    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('popstate', onPop);
  }

  // Restore a function only if the page hasn't replaced our wrapper since.
  const restore = (obj, key, wrapper, original) => { if (obj[key] === wrapper) obj[key] = original; };

  function uninstall() {
    if (!installed) return;
    installed = false;
    restore(console, 'error', wrapped.error, orig.error);
    if (wrapped.fetch) restore(window, 'fetch', wrapped.fetch, orig.fetch);
    restore(XMLHttpRequest.prototype, 'open', wrapped.open, orig.open);
    restore(XMLHttpRequest.prototype, 'send', wrapped.send, orig.send);
    restore(history, 'pushState', wrapped.pushState, orig.pushState);
    restore(history, 'replaceState', wrapped.replaceState, orig.replaceState);
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('popstate', onPop);
  }

  Object.defineProperty(window, '__clearbugHook', { value: { install, uninstall } });

  // recorder.js tells the hook when the test session starts or stops
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__clearbugControl !== true) return;
    if (e.data.active) install(); else uninstall();
  });

  install();
})();
