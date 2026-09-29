import { getSettings, saveSettings, getDefects, esc, fmtDate, download, toast } from './lib/common.js';
import { FIELDS, readSpreadsheet, detectTable, buildCases, caseStatus, suiteStats } from './lib/testcases.js';
import { exportResultsWorkbook } from './lib/excel.js';

const app = document.getElementById('app');
const fileInput = document.getElementById('file');

const state = {
  view: 'home',       // home | mapping | suite | run
  suite: null,
  results: {},
  defects: [],
  session: null,
  settings: {},
  mapping: null,      // { table, mapping, fileName } while importing
  runCaseId: null,
  pending: null,      // { index, kind: 'Fail' | 'Blocked', note }
  redo: null,         // step index being re-tested
  busy: false,
};

const clsStatus = (s) => String(s).replace(/\s+/g, '-');
const isRecordable = (tab) => !!tab && /^(https?|file):/.test(tab.url || '');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res || !res.ok) throw new Error((res && res.error) || 'Something went wrong');
  return res.result;
}

async function loadAll() {
  const data = await chrome.storage.local.get(['suite', 'results', 'session']);
  state.suite = data.suite || null;
  state.results = data.results || {};
  state.session = data.session || null;
  state.defects = await getDefects();
  state.settings = await getSettings();
}

const saveResults = () => chrome.storage.local.set({ results: state.results });

// ---------------- rendering ----------------

function render() {
  renderRecbar();
  if (state.view === 'mapping') return renderMapping();
  if (state.view === 'run' && state.suite) return renderRun();
  if (state.suite) { state.view = 'suite'; return renderSuite(); }
  state.view = 'home';
  renderHome();
}

function renderRecbar() {
  const s = state.session;
  const on = !!(s && s.active);
  document.getElementById('recbar').classList.toggle('hidden', !on);
  if (on) {
    const errs = (s.errors || []).filter((e) => e.seq > (s.mark || 0)).length;
    document.getElementById('rec-text').innerHTML = `Recording steps and page errors${errs ? ` · <span style="color:var(--danger)">${errs} error${errs > 1 ? 's' : ''} caught</span>` : ''}`;
  }
}

function exploratoryCard() {
  const on = !!(state.session && state.session.active);
  const nSteps = on ? (state.session.steps || []).length : 0;
  return `
    <section class="card">
      <h2>Test freely (no test script)</h2>
      <p>${on
        ? `Recording is on: ${nSteps} step${nSteps === 1 ? '' : 's'} so far. Report a bug when something breaks, or save your steps as a test case to reuse.`
        : 'Record your clicks and page errors while you go through a process. Report bugs with one click, or save the steps as a new test case. No test cases needed.'}</p>
      <div class="stack">
        ${on ? '' : '<button data-action="start-recording">● Start recording</button>'}
        <button data-action="report-free">🐞 Report a bug <span class="muted small">(Alt+Shift+B)</span></button>
        ${on ? `<button data-action="make-testcase" ${nSteps ? '' : 'disabled'}>📝 Save my steps as a test case</button>
        <button class="link" data-action="clear-steps" style="align-self:flex-start">Clear steps and start over</button>` : ''}
      </div>
    </section>`;
}

function renderHome() {
  app.innerHTML = `
    <section class="card">
      <h2>Run your UAT test cases</h2>
      <p>Import the test case spreadsheet from your project team. Go through it step by step, mark each step Pass or Fail, and ClearBug keeps the evidence and writes the bug reports.</p>
      <div class="stack">
        <button class="primary big" data-action="import">Import test cases (.xlsx / .csv)</button>
        <button class="link" data-action="sample" style="align-self:flex-start">Download a sample test case file</button>
      </div>
    </section>
    ${exploratoryCard()}`;
}

function renderMapping() {
  const { table, mapping, fileName } = state.mapping;
  const options = (sel) => ['<option value="-1">— not in file —</option>']
    .concat(table.headers.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(h)}</option>`)).join('');
  let cases = [];
  let error = '';
  try { cases = buildCases(table, mapping); } catch (e) { error = e.message; }
  const stepCount = cases.reduce((n, c) => n + c.steps.length, 0);
  const missing = FIELDS.filter((f) => f.required && mapping[f.key] < 0);

  app.innerHTML = `
    <button class="link back" data-action="cancel-import">← Cancel</button>
    <section class="card">
      <h2>Check the columns</h2>
      <p>${esc(fileName)}${table.sheetName && table.sheetName !== fileName ? ` · sheet “${esc(table.sheetName)}”` : ''}. ClearBug matched these columns. Fix any that are wrong.</p>
      <div class="map-grid">
        ${FIELDS.map((f) => `<label class="${f.required ? 'req' : ''}" for="map-${f.key}">${f.label}</label><select id="map-${f.key}" data-map="${f.key}">${options(mapping[f.key])}</select>`).join('')}
      </div>
    </section>
    <section class="card">
      <h2>Preview</h2>
      ${error ? `<div class="callout error">${esc(error)}</div>` : missing.length
        ? `<div class="callout warn">Choose the ${missing.map((f) => f.label).join(' and ')} column${missing.length > 1 ? 's' : ''}.</div>`
        : `<p><b style="color:var(--text)">${cases.length} test case${cases.length === 1 ? '' : 's'}, ${stepCount} steps</b></p>
           <div class="preview">${cases.slice(0, 3).map((c) => `<div><b>${esc(c.id)}</b> ${esc(c.title)} <span class="muted">· ${c.steps.length} steps</span><br><span class="muted">1. ${esc((c.steps[0] || {}).action || '')}</span></div>`).join('')}${cases.length > 3 ? `<div class="muted">…and ${cases.length - 3} more</div>` : ''}</div>`}
      <div class="stack" style="margin-top:12px">
        <button class="primary big" data-action="confirm-import" ${missing.length || error || !cases.length ? 'disabled' : ''}>Import ${cases.length || ''} test cases</button>
      </div>
    </section>`;
}

function renderSuite() {
  const { suite, results } = state;
  const st = suiteStats(suite, results);
  const pct = (n) => (st.total ? (n / st.total) * 100 : 0);
  const tester = state.settings.lastTester || '';

  app.innerHTML = `
    <section class="card">
      <div class="muted small">Test cases from</div>
      <h2 style="margin:2px 0 0;overflow-wrap:anywhere">${esc(suite.name)}</h2>
      <div class="progress">
        <span class="p" style="width:${pct(st.Passed)}%"></span><span class="f" style="width:${pct(st.Failed)}%"></span><span class="b" style="width:${pct(st.Blocked)}%"></span><span class="i" style="width:${pct(st['In progress'])}%"></span>
      </div>
      <div class="legend">
        <span><b>${st.Passed}</b> passed</span><span><b>${st.Failed}</b> failed</span><span><b>${st.Blocked}</b> blocked</span>
        ${st['In progress'] ? `<span><b>${st['In progress']}</b> in progress</span>` : ''}<span><b>${st['Not run']}</b> not run</span>
      </div>
      <label class="field" style="margin:12px 0 10px"><span>Tester name</span><input type="text" id="tester" value="${esc(tester)}" placeholder="Shown in results and bug reports"></label>
      <div class="stack">
        <button class="primary" data-action="export">⬇ Export results to Excel</button>
        <div class="row">
          <button data-action="import">Import new file</button>
          <button data-action="clear-results">Reset results</button>
        </div>
      </div>
    </section>

    <ul class="cases">
      ${suite.cases.map((tc) => {
        const status = caseStatus(tc, results[tc.id]);
        const res = results[tc.id];
        const done = res ? tc.steps.filter((_, i) => res.steps[i] && res.steps[i].status).length : 0;
        const defects = res ? res.steps.filter((s) => s && s.defectId).map((s) => s.defectId) : [];
        return `<li><button data-action="open-case" data-id="${esc(tc.id)}">
          <span class="cid">${esc(tc.id)}</span><span class="st ${clsStatus(status)}">${status}</span>
          <span class="ctitle">${esc(tc.title)}</span>
          <span class="cmeta">${tc.module ? esc(tc.module) + ' · ' : ''}${done}/${tc.steps.length} steps${defects.length ? ' · ' + defects.map(esc).join(', ') : ''}</span>
        </button></li>`;
      }).join('')}
    </ul>
    ${exploratoryCard()}`;
}

function currentIndex(tc, res) {
  if (state.redo != null) return state.redo;
  const i = tc.steps.findIndex((_, k) => !(res && res.steps[k] && res.steps[k].status));
  return i;
}

function renderRun() {
  const tc = state.suite.cases.find((c) => c.id === state.runCaseId);
  if (!tc) { state.view = 'suite'; return renderSuite(); }
  const res = state.results[tc.id] || { steps: [] };
  const status = caseStatus(tc, res);
  const cur = currentIndex(tc, res);
  const nextCase = findNextCase(tc.id);

  const stepHtml = tc.steps.map((s, i) => {
    const r = res.steps[i];
    const isCur = i === cur;
    const p = state.pending && state.pending.index === i ? state.pending : null;
    let bottom = '';
    if (isCur && p) {
      const fail = p.kind === 'Fail';
      bottom = `
        <textarea id="pending-note" rows="3" placeholder="${fail ? 'What actually happened? e.g. Red error “NW-5021”, request not created' : 'Why is it blocked? e.g. Test user has no approver role'}">${esc(p.note)}</textarea>
        <div class="btns">
          ${fail ? '<button class="fail" data-action="fail-report">🐞 Save & write bug report</button>' : '<button class="primary" data-action="save-blocked">Save as blocked</button>'}
        </div>
        <div class="btns" style="margin-top:6px">
          ${fail ? '<button data-action="fail-only">Save as failed only</button>' : ''}
          <button data-action="cancel-pending">Cancel</button>
        </div>`;
    } else if (isCur) {
      bottom = `
        <div class="btns">
          <button class="pass" data-action="pass" data-i="${i}">✓ Pass</button>
          <button class="fail" data-action="fail" data-i="${i}">✗ Fail</button>
          <button data-action="blocked" data-i="${i}">Blocked</button>
        </div>
        ${state.redo === i ? '<div class="btns" style="margin-top:6px"><button class="link" data-action="cancel-redo">Cancel re-test</button></div>' : ''}`;
    } else if (r && r.status) {
      const defect = r.defectId ? `<a href="report.html?id=${encodeURIComponent(r.defectId)}" target="_blank">${esc(r.defectId)}</a>` : '';
      bottom = `
        <div class="result">
          <span class="st ${r.status}">${{ Pass: 'Passed', Fail: 'Failed', Blocked: 'Blocked' }[r.status]}</span>
          ${defect}
          <span class="muted">${esc(fmtDate(r.at))}</span>
          <button class="link" data-action="redo" data-i="${i}">Re-test</button>
          ${r.evidence ? `<button class="link" data-action="evidence" data-key="${esc(r.evidence)}">Screenshot</button>` : ''}
          ${r.note ? `<span class="note">${esc(r.note)}</span>` : ''}
        </div>`;
    }
    return `
      <li class="step ${isCur ? 'current' : ''} ${r && r.status && !isCur ? 'done' : ''}">
        <div class="top">
          <span class="no ${r && r.status && !isCur ? r.status : ''}">${esc(s.no)}</span>
          <div class="body">
            <div class="action">${esc(s.action || '(no action text)')}</div>
            ${s.data ? `<div class="kv"><b>Test data:</b> ${esc(s.data)}</div>` : ''}
            ${s.expected ? `<div class="kv"><b>Expected:</b> ${esc(s.expected)}</div>` : ''}
            ${bottom}
          </div>
        </div>
      </li>`;
  }).join('');

  const finished = cur === -1;
  app.innerHTML = `
    <button class="link back" data-action="back">← All test cases</button>
    <section class="case-head">
      <div class="cid">${esc(tc.id)} <span class="st ${clsStatus(status)}">${status}</span></div>
      <h2>${esc(tc.title)}</h2>
      ${tc.module ? `<div class="muted small">${esc(tc.module)}</div>` : ''}
      ${tc.precondition ? `<div class="callout info pre"><b>Precondition:</b> ${esc(tc.precondition)}</div>` : ''}
    </section>
    <ol class="steps">${stepHtml}</ol>
    ${finished ? `
      <section class="card">
        <h2>Test case ${status.toLowerCase()}</h2>
        <p>${status === 'Passed' ? 'All steps passed. Evidence screenshots are saved with each step.' : 'Results are saved. You can re-test any step after a fix.'}</p>
        ${nextCase ? `<button class="primary big" data-action="open-case" data-id="${esc(nextCase.id)}">Next: ${esc(nextCase.id)} →</button>` : '<button class="primary big" data-action="back">Back to all test cases</button>'}
      </section>` : ''}`;

  if (state.pending) {
    const ta = document.getElementById('pending-note');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  } else {
    const el = app.querySelector('.step.current');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

function findNextCase(afterId) {
  const cases = state.suite.cases;
  const start = cases.findIndex((c) => c.id === afterId);
  for (let k = 1; k <= cases.length; k++) {
    const c = cases[(start + k) % cases.length];
    const s = caseStatus(c, state.results[c.id]);
    if (s === 'Not run' || s === 'In progress') return c;
  }
  return null;
}

// ---------------- actions ----------------

async function recordStep(tc, index, status, note, { evidence = true } = {}) {
  const tab = await activeTab();
  let evKey = null;
  if (evidence) {
    if (isRecordable(tab)) {
      const shot = await send({ type: 'cb:capture', tabId: tab.id }).catch(() => null);
      if (shot) {
        evKey = `ev:${state.suite.id}:${tc.id}:${index}`;
        await chrome.storage.local.set({ [evKey]: shot });
      }
    } else {
      toast('No screenshot: switch to the system you are testing first.');
    }
  }
  const res = state.results[tc.id] || (state.results[tc.id] = { steps: [] });
  res.tester = state.settings.lastTester || res.tester || '';
  const prev = res.steps[index];
  res.steps[index] = { status, note: note || '', at: new Date().toISOString(), evidence: evKey || null, defectId: status === 'Fail' && prev && prev.status === 'Fail' ? prev.defectId || null : null };
  await saveResults();
  return { tab };
}

async function openCase(id) {
  state.view = 'run';
  state.runCaseId = id;
  state.pending = null;
  state.redo = null;
  render();
  const tc = state.suite.cases.find((c) => c.id === id);
  const tab = await activeTab();
  if (tc && caseStatus(tc, state.results[id]) !== 'Passed') {
    await send({
      type: 'cb:start-case',
      caseId: id,
      module: tc.module,
      tester: state.settings.lastTester || '',
      tab: isRecordable(tab) ? { id: tab.id, title: tab.title, url: tab.url } : null,
    }).catch(() => {});
  }
}

const actions = {
  async import() { fileInput.value = ''; fileInput.click(); },

  async sample() {
    const res = await fetch(chrome.runtime.getURL('templates/sample-test-cases.xlsx'));
    download('ClearBug-sample-test-cases.xlsx', await res.blob());
  },

  'cancel-import'() { state.mapping = null; state.view = state.suite ? 'suite' : 'home'; render(); },

  async 'confirm-import'() {
    const { table, mapping, fileName } = state.mapping;
    const cases = buildCases(table, mapping);
    const hasResults = Object.keys(state.results).length > 0;
    if (state.suite && hasResults && !confirm('Importing a new file replaces the current test cases and their results. Export your results first if you need them. Continue?')) return;
    await removeEvidence();
    state.suite = {
      id: 's' + Date.now().toString(36),
      name: fileName,
      importedAt: new Date().toISOString(),
      sheetName: table.sheetName,
      headers: table.headers,
      rows: table.rows,
      mapping: { ...mapping },
      cases,
    };
    state.results = {};
    state.mapping = null;
    await chrome.storage.local.set({ suite: state.suite, results: {} });
    state.view = 'suite';
    render();
    toast(`${cases.length} test cases imported`);
  },

  'open-case'(el) { openCase(el.dataset.id); },

  back() { state.view = 'suite'; state.pending = null; state.redo = null; render(); },

  async pass(el) {
    const tc = currentCase();
    await recordStep(tc, Number(el.dataset.i), 'Pass', '');
    state.redo = null;
    render();
  },

  fail(el) { state.pending = { index: Number(el.dataset.i), kind: 'Fail', note: '' }; render(); },
  blocked(el) { state.pending = { index: Number(el.dataset.i), kind: 'Blocked', note: '' }; render(); },
  'cancel-pending'() { state.pending = null; render(); },

  async 'save-blocked'() {
    const tc = currentCase();
    const p = state.pending;
    if (!p.note.trim()) { toast('Add a short reason first'); return; }
    await recordStep(tc, p.index, 'Blocked', p.note.trim(), { evidence: true });
    state.pending = null; state.redo = null;
    render();
  },

  async 'fail-only'() {
    const tc = currentCase();
    const p = state.pending;
    await recordStep(tc, p.index, 'Fail', p.note.trim());
    state.pending = null; state.redo = null;
    render();
  },

  async 'fail-report'() {
    const tc = currentCase();
    const p = state.pending;
    const note = p.note.trim();
    const { tab } = await recordStep(tc, p.index, 'Fail', note);
    state.pending = null; state.redo = null;
    render();
    if (!tab) return;
    const step = tc.steps[p.index];
    try {
      await send({
        type: 'cb:report',
        tabId: tab.id,
        note,
        tester: state.settings.lastTester || '',
        testCase: {
          suiteId: state.suite.id,
          caseId: tc.id,
          title: tc.title,
          module: tc.module,
          precondition: tc.precondition,
          stepIndex: p.index,
          stepNo: step.no,
          expected: step.expected,
          steps: tc.steps.slice(0, p.index + 1).map((s) => ({ no: s.no, action: s.action, data: s.data, expected: s.expected })),
        },
      });
    } catch (e) {
      toast('Could not open the bug report: ' + e.message);
    }
  },

  redo(el) { state.redo = Number(el.dataset.i); state.pending = null; render(); },
  'cancel-redo'() { state.redo = null; render(); },

  async evidence(el) {
    const key = el.dataset.key;
    const src = (await chrome.storage.local.get(key))[key];
    if (!src) return;
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${src}" alt="Evidence screenshot">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  },

  async export() {
    const btn = app.querySelector('[data-action="export"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Building Excel file…';
    try {
      const blob = await exportResultsWorkbook({
        suite: state.suite,
        results: state.results,
        defects: await getDefects(),
        tester: state.settings.lastTester,
        loadEvidence: async (key) => (await chrome.storage.local.get(key))[key],
      });
      const base = state.suite.name.replace(/\.(xlsx|csv|tsv|txt)$/i, '');
      download(`${base} - UAT results ${new Date().toISOString().slice(0, 10)}.xlsx`, blob);
    } catch (e) {
      toast('Export failed: ' + e.message, 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ Export results to Excel';
    }
  },

  async 'clear-results'() {
    if (!confirm('Reset all Pass/Fail results for these test cases? Saved defects are kept.')) return;
    await removeEvidence();
    state.results = {};
    await saveResults();
    render();
  },

  async 'start-recording'() {
    const tab = await activeTab();
    await send({
      type: 'cb:start',
      tester: state.settings.lastTester || '',
      module: state.settings.lastModule || '',
      tab: isRecordable(tab) ? { id: tab.id, title: tab.title, url: tab.url } : null,
    });
  },

  async 'stop-recording'() { await send({ type: 'cb:stop' }); },

  async 'make-testcase'() { await chrome.tabs.create({ url: chrome.runtime.getURL('testcase.html') }); },

  async 'clear-steps'() {
    if (!confirm('Clear the recorded steps and start over?')) return;
    const tab = await activeTab();
    await send({ type: 'cb:clear' });
    if (isRecordable(tab)) {
      await send({ type: 'cb:start', tester: state.settings.lastTester || '', module: (state.session && state.session.module) || '', tab: { id: tab.id, title: tab.title, url: tab.url } });
    }
  },

  async 'report-free'() {
    const tab = await activeTab();
    if (!isRecordable(tab)) { toast('Switch to the page with the bug first.'); return; }
    await send({ type: 'cb:report', tabId: tab.id, tester: state.settings.lastTester || '' });
  },
};

function currentCase() {
  return state.suite.cases.find((c) => c.id === state.runCaseId);
}

async function removeEvidence() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('ev:'));
  if (keys.length) await chrome.storage.local.remove(keys);
}

// ---------------- events ----------------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || state.busy) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  state.busy = true;
  try { await fn(el); } catch (err) { toast(err.message, 4000); console.error(err); } finally { state.busy = false; }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'pending-note' && state.pending) state.pending.note = e.target.value;
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'tester') {
    state.settings.lastTester = e.target.value.trim();
    await saveSettings({ lastTester: state.settings.lastTester });
  }
  if (e.target.dataset.map) {
    state.mapping.mapping[e.target.dataset.map] = Number(e.target.value);
    renderMapping();
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const sheets = await readSpreadsheet(file);
    const table = detectTable(sheets);
    state.mapping = { table, mapping: table.mapping, fileName: file.name };
    state.view = 'mapping';
    render();
  } catch (err) {
    toast(err.message, 6000);
  }
});

document.getElementById('nav-settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.session) {
    state.session = changes.session.newValue || null;
    renderRecbar();
    if ((state.view === 'home' || state.view === 'suite') && !state.pending) render();
  }
  if (changes.settings) state.settings = await getSettings();
  let rerender = false;
  if (changes.results) { state.results = changes.results.newValue || {}; rerender = true; }
  if (changes.defects) { state.defects = changes.defects.newValue || []; rerender = true; }
  if (changes.suite) { state.suite = changes.suite.newValue || null; rerender = true; }
  // don't wipe a note the tester is typing
  if (rerender && !state.pending && state.view !== 'mapping') render();
});

await loadAll();
render();
