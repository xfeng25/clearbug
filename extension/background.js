// ClearBug service worker: owns the test session (steps + errors) and
// creates bug-report drafts (screenshot + context) when the tester reports a bug.

const MAX_STEPS = 80;
const MAX_ERRORS = 40;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Serialize every read-modify-write of the session so events from several
// tabs never overwrite each other.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch((e) => console.error('[ClearBug]', e));
  return p;
}

async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  return session || null;
}

async function setBadge(active) {
  await chrome.action.setBadgeText({ text: active ? 'REC' : '' });
  if (active) await chrome.action.setBadgeBackgroundColor({ color: '#D93025' });
}

function pushEvent(session, event) {
  session.seq = (session.seq || 0) + 1;
  const ev = { ...event, seq: session.seq, t: Date.now() };

  if (ev.kind === 'error') {
    const last = session.errors[session.errors.length - 1];
    if (last && last.text === ev.text && ev.t - last.t < 2000) return; // duplicate burst
    session.errors.push(ev);
    if (session.errors.length > MAX_ERRORS) session.errors.shift();
    return;
  }

  const last = session.steps[session.steps.length - 1];
  // Typing in the same field twice in a row -> keep only the final value
  if (last && ev.kind === 'input' && last.kind === 'input' && last.field === ev.field) {
    session.steps[session.steps.length - 1] = ev;
    return;
  }
  // Same page logged twice (page load + route event)
  if (last && ev.kind === 'navigate' && last.kind === 'navigate' && last.url === ev.url) return;

  session.steps.push(ev);
  if (session.steps.length > MAX_STEPS) session.steps.shift();
}

async function addEvent(event, sender) {
  const session = await getSession();
  if (!session || !session.active) return;
  if (sender && sender.tab && !event.url && event.kind !== 'error') event.url = sender.tab.url;
  pushEvent(session, event);
  await chrome.storage.local.set({ session });
}

async function startSession({ tester, module, tab }) {
  const session = {
    active: true,
    id: 's' + Date.now().toString(36),
    startedAt: new Date().toISOString(),
    tester: tester || '',
    module: module || '',
    seq: 0,
    mark: 0,
    steps: [],
    errors: [],
  };
  if (tab) pushEvent(session, { kind: 'navigate', text: `Started on page "${(tab.title || tab.url || '').slice(0, 70)}"`, url: tab.url });

  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ session, settings: { ...settings, lastTester: tester || '', lastModule: module || '' } });
  await setBadge(true);  await hookOn().catch(() => {});
}

async function stopSession() {
  const session = await getSession();
  if (session) {
    session.active = false;
    session.stoppedAt = new Date().toISOString();
    await chrome.storage.local.set({ session });
  }
  await setBadge(false);  // Unregister the page hook; recorder.js removes it from open pages.
  await syncContentScripts().catch(() => {});
}

async function clearSteps() {
  const session = await getSession();
  if (!session) return;
  session.steps = [];
  session.errors = [];
  session.mark = session.seq || 0;
  await chrome.storage.local.set({ session });
}

// Called when the tester opens a test case: make sure recording is on and
// start the "since" window for this test case.
async function startCase({ caseId, module, tester, tab }) {
  let session = await getSession();
  if (!session || !session.active) {
    await startSession({ tester, module, tab });
    session = await getSession();
  } else {
    session.mark = session.seq || 0;
    if (tab) pushEvent(session, { kind: 'navigate', text: `Started test case ${caseId} on "${(tab.title || '').slice(0, 60)}"`, url: tab.url });
  }
  session.caseId = caseId;
  if (tester) session.tester = tester;
  await chrome.storage.local.set({ session });
}

async function captureEvidence(tabId) {
  const tab = await chrome.tabs.get(tabId);
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  } catch (e) {
    return null;
  }
}

async function createDraft(tabId, extra = {}) {
  const tab = await chrome.tabs.get(tabId);

  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    // Chrome blocks captures of chrome:// pages, the Web Store, etc.
    console.warn('[ClearBug] screenshot failed:', e && e.message);
  }

  const session = await getSession();
  let steps = [];
  let errors = [];
  if (session) {
    const since = session.mark || 0;
    steps = session.steps.filter((s) => s.seq > since);
    if (steps.length === 0) steps = session.steps.slice(-10);
    steps = steps.slice(-30);
    errors = session.errors.filter((e) => e.seq > since).slice(-15);
    // The next bug report starts from here
    session.mark = session.seq || 0;
    await chrome.storage.local.set({ session });
  }

  const draftId = 'd' + Date.now().toString(36);
  const draft = {
    draftId,
    createdAt: new Date().toISOString(),
    url: tab.url || '',
    pageTitle: tab.title || '',
    tester: (session && session.tester) || '',
    module: (session && session.module) || '',
    steps,
    errors,
    env: { ua: navigator.userAgent, viewport: tab.width && tab.height ? `${tab.width}×${tab.height}` : '' },
    testCase: extra.testCase || null,
    initialDescription: extra.note || '',
  };
  if (extra.testCase && extra.testCase.module) draft.module = extra.testCase.module;
  if (extra.tester) draft.tester = extra.tester;

  await chrome.storage.local.set({ [`draft:${draftId}`]: draft, [`shot:${draftId}`]: screenshot });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`report.html?draft=${draftId}`),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
  return draftId;
}

async function cleanupOldDrafts() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const remove = [];
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith('draft:') && val && now - Date.parse(val.createdAt) > DRAFT_TTL_MS) {
      remove.push(key, 'shot:' + key.slice(6));
    }
  }
  if (remove.length) await chrome.storage.local.remove(remove);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => {
    p.then((r) => sendResponse({ ok: true, result: r }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  };
  switch (msg && msg.type) {
    case 'cb:event':
      serial(() => addEvent(msg.event, sender));
      return false;
    case 'cb:start':
      return reply(serial(() => startSession(msg)));
    case 'cb:stop':
      return reply(serial(() => stopSession()));
    case 'cb:clear':
      return reply(serial(() => clearSteps()));
    case 'cb:report':
      return reply(serial(() => createDraft(msg.tabId, msg)));
    case 'cb:start-case':
      return reply(serial(() => startCase(msg)));
    case 'cb:capture':
      return reply(captureEvidence(msg.tabId));
    default:
      return false;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'report-bug') return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) serial(() => createDraft(target.id));
});

async function restoreBadge() {
  const session = await getSession();
  await setBadge(!!(session && session.active));
}

// Clicking the toolbar button opens the ClearBug side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- website access ----------
// ClearBug asks for website access at first use (optional permission).
// Once granted, the recorder scripts are registered for every page load
// and injected into tabs that are already open.
const SCRIPT_IDS = ['cb-hook', 'cb-recorder'];
const ALL_SITES = { origins: ['<all_urls>'] };

async function syncContentScripts() {
  const granted = await chrome.permissions.contains(ALL_SITES);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!granted) return false;
  // The recorder is quiet unless a session is active. The page hook (which wraps
  // fetch / XHR / console.error in the page) is only registered during a session,
  // so ClearBug stays out of the way on sites you are not testing.
  const session = await getSession();
  const scripts = [{ id: 'cb-recorder', matches: ['<all_urls>'], js: ['content/recorder.js'], runAt: 'document_start' }];
  if (session && session.active) {
    scripts.unshift({ id: 'cb-hook', matches: ['<all_urls>'], js: ['content/page-hook.js'], runAt: 'document_start', world: 'MAIN' });
  }
  await chrome.scripting.registerContentScripts(scripts);
  return true;
}

const WEB_TABS = { url: ['http://*/*', 'https://*/*', 'file:///*'] };

async function injectRecorder(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/recorder.js'] }); }
  catch (_) { /* chrome:// pages, web store, etc. */ }
}

async function injectHook(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['content/page-hook.js'] }); }
  catch (_) { /* chrome:// pages, web store, no access, etc. */ }
}

async function onAccessGranted() {
  if (!(await syncContentScripts())) return;
  const session = await getSession();
  const tabs = await chrome.tabs.query(WEB_TABS);
  await Promise.all(tabs.map(async (t) => {
    if (session && session.active) await injectHook(t.id);
    await injectRecorder(t.id);
  }));
}

// Session started: register the page hook and add it to open tabs right away.
async function hookOn() {
  if (!(await syncContentScripts())) return;
  const tabs = await chrome.tabs.query(WEB_TABS);
  await Promise.all(tabs.map((t) => injectHook(t.id)));
}

chrome.permissions.onAdded.addListener(() => { onAccessGranted(); });
chrome.permissions.onRemoved.addListener(() => { syncContentScripts(); });

chrome.runtime.onStartup.addListener(() => { restoreBadge(); cleanupOldDrafts(); syncContentScripts(); });
chrome.runtime.onInstalled.addListener(() => { restoreBadge(); cleanupOldDrafts(); onAccessGranted(); });
