// Runs in the page's own JavaScript world so it can see errors the page produces.
//
// It only LISTENS. It never replaces any of the page's functions (fetch, XHR,
// console, history), so ClearBug's code is never part of the page's own calls
// and Chrome never attributes the page's errors to ClearBug.
//
// What it picks up while a test session is running:
//   - uncaught JavaScript errors and unhandled promise rejections
//   - images / scripts / stylesheets that fail to load
//   - requests (fetch, XHR, resources) that come back with an HTTP error (4xx/5xx)
//   - page route changes in single-page apps
// Findings are handed to recorder.js via window.postMessage. recorder.js tells
// the hook when the session starts or stops.
(() => {
  if (window.__clearbugHook) {
    if (typeof window.__clearbugHook.install === 'function') window.__clearbugHook.install();
    return;
  }

  let installed = false;

  const post = (kind, message, detail) => {
    if (!installed) return;
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

  // Uncaught errors and failed resources (images, scripts, css)
  window.addEventListener('error', (e) => {
    try {
      const t = e.target;
      if (t && t !== window && t.tagName) {
        post('resource', `Failed to load ${t.tagName.toLowerCase()}: ${short(t.src || t.href || '')}`);
        return;
      }
      post('js', e.message || 'Script error', e.filename ? `${short(e.filename)}:${e.lineno}` : '');
    } catch (_) { /* ignore */ }
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    try { post('js', `Unhandled promise rejection: ${fmt(e.reason)}`); } catch (_) { /* ignore */ }
  });

  // HTTP errors, read from the browser's own resource timing records
  // (Chrome 109+ reports the response status there). Nothing is wrapped.
  try {
    const seen = new WeakSet();
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        const status = entry.responseStatus;
        if (typeof status === 'number' && status >= 400) {
          const type = entry.initiatorType === 'xmlhttprequest' ? 'XHR' : entry.initiatorType === 'fetch' ? 'fetch' : entry.initiatorType;
          post('network', `${short(entry.name)} → ${status} (${type})`);
        }
      }
    });
    po.observe({ type: 'resource', buffered: false });
  } catch (_) { /* older browser: skip network errors */ }

  // Route changes in single-page apps
  const onRoute = () => post('route', location.href);
  try {
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigatesuccess', onRoute);
    }
  } catch (_) { /* ignore */ }
  window.addEventListener('popstate', onRoute);

  function install() { installed = true; }
  function uninstall() { installed = false; }

  Object.defineProperty(window, '__clearbugHook', { value: { install, uninstall } });

  // recorder.js tells the hook when the test session starts or stops
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__clearbugControl !== true) return;
    if (e.data.active) install(); else uninstall();
  });

  install();
})();
