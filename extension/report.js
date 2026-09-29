import {
  SEVERITIES, LANGUAGES, getSettings, saveSettings, getDefects, saveDefects, nextDefectId,
  describeEnv, esc, fmtDate, stepsFromText, stepsToText, reportToText, download, toast, labelsFor,
} from './lib/common.js';
import { exportDefectsWorkbook } from './lib/excel.js';
import { generateWithAI, generateFromTemplate } from './lib/ai.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const settings = await getSettings();

const state = {
  mode: 'draft', // 'draft' until saved, then 'defect'
  draftId: params.get('draft'),
  defectId: params.get('id'),
  ctx: {},
  recSteps: [],
  recErrors: [],
  img: null,
  boxes: [],
  generatedBy: '',
};

// ---------- setup selects ----------
$('language').innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('language').value = settings.language;
$('language').addEventListener('change', () => saveSettings({ language: $('language').value }));
$('severity').innerHTML = SEVERITIES.map((s) => `<option>${s}</option>`).join('');
$('gen-hint').innerHTML = settings.apiKey
  ? 'Claude reads your note, the steps, errors and screenshot, then writes the report.'
  : 'AI is off, so the report is built from a template. <a href="options.html" target="_blank">Add a Claude API key</a> for AI-written reports.';

// ---------- load ----------
async function load() {
  if (state.draftId) {
    const key = `draft:${state.draftId}`;
    const data = await chrome.storage.local.get([key, `shot:${state.draftId}`]);
    const draft = data[key];
    if (!draft) {
      document.querySelector('main').innerHTML = '<div class="card">This draft no longer exists. It may have been saved already. <a href="defects.html">Open the defect log</a>.</div>';
      return;
    }
    state.ctx = draft;
    state.recSteps = draft.steps || [];
    state.recErrors = draft.errors || [];
    await loadImage(data[`shot:${state.draftId}`]);
    if (draft.initialDescription) $('description').value = draft.initialDescription;
    if (draft.testCase && draft.testCase.expected) $('expected-input').value = draft.testCase.expected;
    if (draft.testCase) $('save-back').classList.remove('hidden');
  } else if (state.defectId) {
    const defects = await getDefects();
    const d = defects.find((x) => x.id === state.defectId);
    if (!d) {
      document.querySelector('main').innerHTML = '<div class="card">Defect not found. <a href="defects.html">Open the defect log</a>.</div>';
      return;
    }
    state.mode = 'defect';
    state.ctx = d;
    state.recSteps = d.recordedSteps || [];
    state.recErrors = d.errors || [];
    const shot = (await chrome.storage.local.get(`shot:${d.id}`))[`shot:${d.id}`];
    await loadImage(shot);
    $('description').value = d.description || '';
    $('expected-input').value = d.expectedInput || '';
    if (d.language) $('language').value = d.language;
    fillReport(d);
    $('ai-note').textContent = '';
    setHeading();
  }
  renderContext();
}

function setHeading() {
  if (state.mode === 'defect') {
    $('heading').textContent = state.ctx.id;
    document.title = `${state.ctx.id} · ClearBug`;
    $('save').textContent = 'Save changes';
  }
}

// ---------- recorded context ----------
function renderContext() {
  const steps = state.recSteps;
  $('rec-steps').innerHTML = steps.length
    ? steps.map((s, i) => `<li><span class="n">${i + 1}.</span><span class="t">${esc(s.text)}</span><button class="icon" data-step="${i}" title="Remove">×</button></li>`).join('')
    : '<li class="empty">No steps recorded. Start a test session from the ClearBug button next time, or describe the steps yourself.</li>';

  const errs = state.recErrors;
  $('rec-errors').innerHTML = errs.length
    ? errs.map((e, i) => `<li class="err"><span class="t">${esc(e.text)}${e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}</span><button class="icon" data-err="${i}" title="Remove">×</button></li>`).join('')
    : '<li class="empty">No errors caught.</li>';

  const c = state.ctx;
  const tc = c.testCase;
  $('tc-link').classList.toggle('hidden', !tc);
  if (tc) {
    $('tc-link').innerHTML = `<b>Test case ${esc(tc.caseId)}, step ${esc(tc.stepNo)} failed.</b> ${esc(tc.title || '')}<br>` +
      `<span class="small">The official test steps and expected result are used in the report.</span>`;
  }
  const rows = [
    ['Page', c.url ? `<a href="${esc(c.url)}" target="_blank">${esc(c.pageTitle || c.url)}</a>` : '-'],
    ['Environment', esc(describeEnv(c.env))],
    ['Captured', esc(fmtDate(c.createdAt))],
  ];
  if (tc) rows.unshift(['Test case', `${esc(tc.caseId)} · step ${esc(tc.stepNo)}`]);
  if (c.module) rows.push(['Module', esc(c.module)]);
  if (c.tester) rows.push(['Tester', esc(c.tester)]);
  $('meta').innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button.icon');
  if (!b) return;
  if (b.dataset.step !== undefined) state.recSteps.splice(Number(b.dataset.step), 1);
  if (b.dataset.err !== undefined) state.recErrors.splice(Number(b.dataset.err), 1);
  renderContext();
});

// ---------- screenshot + annotation ----------
const canvas = $('shot');
const g = canvas.getContext('2d');
let dragging = null;

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) { showImage(null); return resolve(); }
    const img = new Image();
    img.onload = () => { showImage(img); resolve(); };
    img.onerror = () => { showImage(null); resolve(); };
    img.src = src;
  });
}

function showImage(img) {
  state.img = img;
  state.boxes = [];
  canvas.classList.toggle('hidden', !img);
  $('shot-empty').classList.toggle('hidden', !!img);
  ['undo', 'clear-boxes', 'dl-shot'].forEach((id) => { $(id).disabled = !img; });
  if (img) {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    redraw();
  }
}

function redraw(extra) {
  if (!state.img) return;
  g.drawImage(state.img, 0, 0);
  const lw = Math.max(3, Math.round(canvas.width / 320));
  g.lineWidth = lw;
  g.strokeStyle = '#e5222b';
  g.lineJoin = 'round';
  for (const b of extra ? [...state.boxes, extra] : state.boxes) {
    g.strokeRect(b.x, b.y, b.w, b.h);
  }
}

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
}
const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

canvas.addEventListener('pointerdown', (e) => { dragging = toCanvas(e); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (dragging) redraw(norm(dragging, toCanvas(e))); });
canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  const box = norm(dragging, toCanvas(e));
  dragging = null;
  if (box.w > 6 && box.h > 6) state.boxes.push(box);
  redraw();
});
$('undo').addEventListener('click', () => { state.boxes.pop(); redraw(); });
$('clear-boxes').addEventListener('click', () => { state.boxes = []; redraw(); });
$('dl-shot').addEventListener('click', () => {
  const name = `${state.mode === 'defect' ? state.ctx.id : 'bug'}-screenshot.png`;
  canvas.toBlob((blob) => download(name, blob));
});

document.addEventListener('paste', (e) => {
  const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const reader = new FileReader();
  reader.onload = () => loadImage(reader.result).then(() => toast('Screenshot replaced'));
  reader.readAsDataURL(item.getAsFile());
});

function screenshotForAI() {
  if (!state.img) return null;
  const max = 1568; // Claude's recommended max edge
  const scale = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
}

// ---------- generate ----------
function fillReport(r) {
  $('title').value = r.title || '';
  $('severity').value = r.severity || 'Medium';
  $('severity-reason').value = r.severityReason || '';
  $('steps').value = stepsToText(r.steps || []);
  $('expected').value = r.expected || '';
  $('actual').value = r.actual || '';
  const missing = r.missingInfo || [];
  $('missing').classList.toggle('hidden', !missing.length);
  $('missing').innerHTML = missing.length
    ? `<b>A developer will probably ask:</b><ul>${missing.map((q) => `<li>${esc(q)}</li>`).join('')}</ul><span class="small">Add the answers to the description and write it again, or edit the fields below.</span>`
    : '';
  $('report-card').classList.remove('hidden');
}

$('generate').addEventListener('click', async () => {
  const description = $('description').value.trim();
  $('gen-error').classList.add('hidden');
  if (!description) {
    $('description').focus();
    $('gen-error').textContent = 'Describe what went wrong first. One or two sentences is enough.';
    $('gen-error').classList.remove('hidden');
    return;
  }
  const input = {
    description,
    expected: $('expected-input').value.trim(),
    language: $('language').value,
    module: state.ctx.module,
    url: state.ctx.url,
    pageTitle: state.ctx.pageTitle,
    env: state.ctx.env,
    steps: state.recSteps,
    errors: state.recErrors,
    testCase: state.ctx.testCase || null,
  };

  const btn = $('generate');
  const label = btn.innerHTML;
  btn.disabled = true;
  try {
    let report;
    if (settings.apiKey) {
      btn.innerHTML = '<span class="spinner"></span>Writing report…';
      report = await generateWithAI({ ...input, screenshotBase64: screenshotForAI() }, settings);
      state.generatedBy = 'ai';
      $('ai-note').textContent = 'Written by Claude from your note, the recorded steps, errors and screenshot. Check it before saving.';
    } else {
      report = generateFromTemplate(input);
      state.generatedBy = 'template';
      $('ai-note').textContent = 'Built from a template. Edit the title and steps, or add a Claude API key in Settings for AI-written reports.';
    }
    fillReport(report);
    $('report-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('gen-error').textContent = `Couldn't write the report: ${e.message}`;
    $('gen-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
});

// ---------- save / copy ----------
function collect() {
  return {
    title: $('title').value.trim(),
    severity: $('severity').value,
    severityReason: $('severity-reason').value.trim(),
    steps: stepsFromText($('steps').value),
    expected: $('expected').value.trim(),
    actual: $('actual').value.trim(),
    description: $('description').value.trim(),
    expectedInput: $('expected-input').value.trim(),
    language: $('language').value,
    errors: state.recErrors,
    recordedSteps: state.recSteps,
    hasScreenshot: !!state.img,
  };
}

// Write the defect ID back onto the test step that failed
async function linkToTestStep(defectId) {
  const tc = state.ctx.testCase;
  if (!tc) return;
  const { suite, results = {} } = await chrome.storage.local.get(['suite', 'results']);
  if (!suite || suite.id !== tc.suiteId) return;
  const res = results[tc.caseId] || (results[tc.caseId] = { steps: [] });
  const step = res.steps[tc.stepIndex] || (res.steps[tc.stepIndex] = { status: 'Fail', at: new Date().toISOString() });
  step.defectId = defectId;
  await chrome.storage.local.set({ results });
}

async function save() {
  const data = collect();
  if (!data.title) { $('title').focus(); toast('Add a title first'); return false; }
  const shot = state.img ? canvas.toDataURL('image/png') : null;
  const defects = await getDefects();

  if (state.mode === 'draft') {
    const id = await nextDefectId();
    const c = state.ctx;
    const defect = {
      id,
      status: 'New',
      createdAt: c.createdAt,
      url: c.url,
      pageTitle: c.pageTitle,
      tester: c.tester,
      module: c.module,
      env: c.env,
      generatedBy: state.generatedBy,
      testCase: c.testCase || null,
      ...data,
    };
    defects.push(defect);
    await saveDefects(defects);
    await chrome.storage.local.set({ [`shot:${id}`]: shot });
    await chrome.storage.local.remove([`draft:${state.draftId}`, `shot:${state.draftId}`]);
    await linkToTestStep(id);
    state.mode = 'defect';
    state.ctx = defect;
    history.replaceState(null, '', `report.html?id=${id}`);
    setHeading();
    toast(`Saved as ${id}`);
  } else {
    const i = defects.findIndex((x) => x.id === state.ctx.id);
    if (i < 0) { toast('This defect was deleted'); return false; }
    defects[i] = { ...defects[i], ...data, updatedAt: new Date().toISOString() };
    state.ctx = defects[i];
    await saveDefects(defects);
    await chrome.storage.local.set({ [`shot:${state.ctx.id}`]: shot });
    toast('Changes saved');
  }
  return true;
}

$('save').addEventListener('click', save);
$('save-back').addEventListener('click', async () => {
  if (!(await save())) return;
  const tab = await chrome.tabs.getCurrent();
  setTimeout(() => chrome.tabs.remove(tab.id), 500);
});

$('copy').addEventListener('click', async () => {
  const d = { ...state.ctx, ...collect(), id: state.mode === 'defect' ? state.ctx.id : '' };
  await navigator.clipboard.writeText(reportToText(d));
  toast('Report copied. Paste it into Jira, Teams or email.');
});

load();

// ---------- export one bug ----------
function currentDefect() {
  return { ...state.ctx, ...collect(), id: state.mode === 'defect' ? state.ctx.id : '' };
}
const fileBase = (d) => `${d.id || 'Bug'} ${String(d.title || '').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 50)}`.trim();

$('export-xlsx').addEventListener('click', async () => {
  const d = currentDefect();
  if (!d.title) { $('title').focus(); toast('Write or generate the report first'); return; }
  const shot = state.img ? canvas.toDataURL('image/png') : null;
  const blob = await exportDefectsWorkbook([d], async () => shot);
  download(`${fileBase(d)}.xlsx`, blob);
});

$('export-pdf').addEventListener('click', async () => {
  const d = currentDefect();
  if (!d.title) { $('title').focus(); toast('Write or generate the report first'); return; }
  const L = labelsFor(d.language);
  const rows = [
    [L.severity, `${d.severity}${d.severityReason ? ` — ${d.severityReason}` : ''}`],
    d.status ? ['Status', d.status] : null,
    d.testCase ? [L.testCase, `${d.testCase.caseId} · ${L.step} ${d.testCase.stepNo}`] : null,
    d.module ? [L.module, d.module] : null,
    d.url ? [L.url, d.url] : null,
    [L.env, describeEnv(d.env)],
    d.tester ? [L.reporter, d.tester] : null,
    [L.date, fmtDate(d.createdAt)],
  ].filter(Boolean);
  const shot = state.img ? canvas.toDataURL('image/png') : '';
  $('print-view').innerHTML = `
    ${d.id ? `<div class="pid">${esc(d.id)}</div>` : ''}
    <h1>${esc(d.title)}</h1>
    <table class="m">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <h2>${esc(L.steps)}</h2><ol>${d.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <h2>${esc(L.expected)}</h2><p>${esc(d.expected || '-')}</p>
    <h2>${esc(L.actual)}</h2><p>${esc(d.actual || '-')}</p>
    ${d.errors && d.errors.length ? `<h2>${esc(L.errors)}</h2>${d.errors.map((e) => `<p class="err">[${esc(e.errorType)}] ${esc(e.text)}</p>`).join('')}` : ''}
    ${shot ? `<h2>Screenshot</h2><img id="print-shot" src="${shot}" alt="">` : ''}
    <div class="foot">Created with ClearBug · ${esc(fmtDate(new Date().toISOString()))}</div>`;
  const img = document.getElementById('print-shot');
  if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
  const oldTitle = document.title;
  document.title = fileBase(d); // becomes the suggested PDF file name
  window.print();
  document.title = oldTitle;
});
