// Turns what the tester does on the page into readable steps like
//   Clicked button "Submit"   /   Entered "ACME Ltd" in "Vendor name"
// Only records while a test session is active.
(() => {
  if (window.__clearbugRecorder) return;
  window.__clearbugRecorder = true;

  let active = false;
  let maskAll = false;
  let lastRouteUrl = location.href;

  const SENSITIVE = /pass(word)?|pwd|ssn|social.?sec|card.?num|cc-|cvv|cvc|iban|secret|token|\bpin\b/i;

  // Tell page-hook.js (page world) to install or remove itself
  const tellHook = () => {
    try { window.postMessage({ __clearbugControl: true, active }, '*'); } catch (_) { /* ignore */ }
  };

  chrome.storage.local.get(['session', 'settings']).then(({ session, settings }) => {
    active = !!(session && session.active);
    tellHook();
    maskAll = !!(settings && settings.maskInputs);
    if (active) whenReady(() => logPage('Opened page'));
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.session) {
      const next = !!(changes.session.newValue && changes.session.newValue.active);
      if (next !== active) { active = next; tellHook(); }
    }
    if (changes.settings) maskAll = !!(changes.settings.newValue && changes.settings.newValue.maskInputs);
  });

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function send(event) {
    if (!active) return;
    try {
      const p = chrome.runtime.sendMessage({ type: 'cb:event', event });
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* extension was reloaded; ignore */ }
  }

  const clean = (s, n = 60) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const humanize = (s) => clean(String(s).replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());

  function logPage(verb) {
    lastRouteUrl = location.href;
    send({ kind: 'navigate', text: `${verb} "${clean(document.title || location.pathname, 70)}"`, url: location.href });
  }

  function textFromIds(ids) {
    return ids.split(/\s+/).map((id) => {
      const el = document.getElementById(id);
      return el ? el.innerText || el.textContent || '' : '';
    }).join(' ');
  }

  // Best human-readable name for a form field
  function fieldLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && clean(aria)) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by && clean(textFromIds(by))) return clean(textFromIds(by));
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && clean(l.innerText)) return clean(l.innerText);
      } catch (_) { /* ignore */ }
    }
    const wrap = el.closest('label');
    if (wrap) {
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll('select, textarea, option').forEach((n) => n.remove());
      if (clean(copy.textContent)) return clean(copy.textContent);
    }
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);
    if (el.name) return humanize(el.name);
    if (el.id) return humanize(el.id);
    return el.tagName.toLowerCase();
  }

  // Best human-readable name for something clickable
  function clickLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && clean(aria)) return clean(aria, 50);
    const by = el.getAttribute('aria-labelledby');
    if (by && clean(textFromIds(by))) return clean(textFromIds(by), 50);
    const text = clean(el.innerText || el.textContent, 50);
    if (text) return text;
    if (el.value && typeof el.value === 'string') return clean(el.value, 50);
    if (el.title) return clean(el.title, 50);
    const img = el.querySelector && el.querySelector('img[alt], svg[aria-label]');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label'), 50);
    if (el.name) return humanize(el.name);
    if (el.id) return humanize(el.id);
    return '';
  }

  function kindOf(el) {
    const role = el.getAttribute('role');
    if (role === 'tab') return 'tab';
    if (role === 'menuitem') return 'menu item';
    if (role === 'option') return 'option';
    if (role === 'checkbox' || role === 'switch') return 'toggle';
    if (role === 'link' || el.tagName === 'A') return 'link';
    if (el.tagName === 'SUMMARY') return 'section';
    if (role === 'button' || el.tagName === 'BUTTON' || el.tagName === 'INPUT') return 'button';
    return '';
  }

  const FIELD_SELECTOR =
    'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), select, textarea, option, [contenteditable=""], [contenteditable="true"]';
  const CLICKABLE_SELECTOR =
    'button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], input[type=button], input[type=submit], input[type=reset], input[type=image], summary';

  document.addEventListener('click', (e) => {
    if (!active || !e.isTrusted) return;
    const t = e.target instanceof Element ? e.target : e.target && e.target.parentElement;
    if (!t) return;
    if (t.closest(FIELD_SELECTOR)) return; // recorded by the change handler instead

    const el = t.closest(CLICKABLE_SELECTOR);
    if (el) {
      const label = clickLabel(el);
      const kind = kindOf(el);
      send({ kind: 'click', text: label ? `Clicked ${kind ? kind + ' ' : ''}"${label}"` : `Clicked ${kind || 'element'}` });
      return;
    }
    if (t.closest('label')) return; // label click toggles a field -> change handler records it
    // Generic element with short visible text (e.g. a table cell or list row)
    const raw = (t.innerText || '').trim();
    if (raw && raw.length <= 60 && t.children.length <= 3) send({ kind: 'click', text: `Clicked "${clean(raw, 50)}"` });
  }, true);

  function valueText(el, label) {
    const hint = `${el.name || ''} ${el.id || ''} ${el.autocomplete || ''} ${label}`;
    if (el.type === 'password' || SENSITIVE.test(hint)) return '••••••';
    if (maskAll) return '[value hidden]';
    return `"${clean(el.value, 50)}"`;
  }

  document.addEventListener('change', (e) => {
    if (!active || !e.isTrusted) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    const label = fieldLabel(el);

    if (el instanceof HTMLSelectElement) {
      const v = Array.from(el.selectedOptions).map((o) => clean(o.text, 40)).join(', ');
      send({ kind: 'input', field: label, text: `Selected "${v}" in "${label}"` });
    } else if (el instanceof HTMLInputElement) {
      const type = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(type)) return;
      if (type === 'checkbox') {
        send({ kind: 'input', field: label, text: `${el.checked ? 'Checked' : 'Unchecked'} "${label}"` });
      } else if (type === 'radio') {
        const group = el.name ? humanize(el.name) : '';
        send({ kind: 'input', field: group || label, text: group ? `Chose "${label}" for "${group}"` : `Chose "${label}"` });
      } else if (type === 'file') {
        const names = Array.from(el.files || []).map((f) => f.name).join(', ');
        send({ kind: 'input', field: label, text: `Attached file "${clean(names, 60)}" to "${label}"` });
      } else if (!el.value) {
        send({ kind: 'input', field: label, text: `Cleared "${label}"` });
      } else {
        send({ kind: 'input', field: label, text: `Entered ${valueText(el, label)} in "${label}"` });
      }
    } else if (el instanceof HTMLTextAreaElement) {
      if (!el.value) send({ kind: 'input', field: label, text: `Cleared "${label}"` });
      else send({ kind: 'input', field: label, text: `Entered ${valueText(el, label)} in "${label}"` });
    }
  }, true);

  // Messages from page-hook.js (errors, route changes)
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__clearbug !== true || !active) return;
    const d = e.data;
    if (d.kind === 'route') {
      if (d.message === lastRouteUrl) return;
      setTimeout(() => { if (location.href !== lastRouteUrl) logPage('Navigated to'); }, 150);
      return;
    }
    send({ kind: 'error', errorType: d.kind, text: d.message, detail: d.detail, url: location.href });
  });
})();
