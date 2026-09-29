import { LANGUAGES, getSettings, saveSettings, esc, download, toast } from './lib/common.js';
import { stepsFromRecording, guessTitle } from './lib/recording.js';
import { newSuite, nextCaseId, appendCase, STANDARD_HEADERS } from './lib/testcases.js';
import { exportTestCasesWorkbook } from './lib/excel.js';
import { generateTestCaseWithAI } from './lib/ai.js';

const $ = (id) => document.getElementById(id);
const settings = await getSettings();
const { session, suite } = await chrome.storage.local.get(['session', 'suite']);

const events = session ? [...(session.steps || []), ...(session.errors || [])].sort((a, b) => a.seq - b.seq) : [];
const actionsOnly = events.filter((e) => e.kind !== 'error');
let steps = stepsFromRecording(events);
let added = false;

if (!actionsOnly.length) {
  $('empty').classList.remove('hidden');
} else {
  $('builder').classList.remove('hidden');
  init();
}

function init() {
  $('tc-id').value = nextCaseId(suite);
  $('tc-module').value = (session && session.module) || '';
  $('tc-title').value = guessTitle(actionsOnly);
  $('language').innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('language').value = settings.language;
  $('language').addEventListener('change', () => saveSettings({ language: $('language').value }));
  $('ai').title = settings.apiKey ? 'Claude cleans up the steps and writes the expected results' : 'Add a Claude API key in Settings first';
  $('suite-hint').textContent = suite
    ? `It will be added to “${suite.name}” (${suite.cases.length} test cases) so you can run it from the side panel.`
    : 'It will be added to a new list called “My test cases” so you can run it from the side panel.';

  $('rec-count').textContent = `${actionsOnly.length} actions${events.length > actionsOnly.length ? `, ${events.length - actionsOnly.length} page errors` : ''}`;
  $('rec-list').innerHTML = events.map((e) => `<li class="${e.kind === 'error' ? 'err' : ''}">${esc(e.text)}</li>`).join('');
  renderRows();
}

function renderRows() {
  $('rows').innerHTML = steps.map((s, i) => `
    <tr class="${s.expected ? '' : 'empty-exp'}">
      <td class="n">${i + 1}</td>
      <td><textarea data-i="${i}" data-k="action" rows="2">${esc(s.action)}</textarea></td>
      <td><textarea data-i="${i}" data-k="data" rows="2">${esc(s.data)}</textarea></td>
      <td><textarea data-i="${i}" data-k="expected" rows="2" placeholder="What should the tester see?">${esc(s.expected)}</textarea></td>
      <td class="x">
        <button class="icon" data-move="${i}" data-dir="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon" data-del="${i}" title="Delete step">×</button>
      </td>
    </tr>`).join('');
  const missing = steps.filter((s) => !s.expected).length;
  $('exp-hint').textContent = missing
    ? `${missing} step${missing > 1 ? 's have' : ' has'} no expected result yet (highlighted).${settings.apiKey ? ' “Improve with AI” can fill them in.' : ''}`
    : '';
}

$('rows').addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset.k) return;
  steps[Number(t.dataset.i)][t.dataset.k] = t.value;
  if (t.dataset.k === 'expected') t.closest('tr').classList.toggle('empty-exp', !t.value.trim());
});

$('rows').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  const mv = e.target.closest('[data-move]');
  if (del) { steps.splice(Number(del.dataset.del), 1); renderRows(); }
  if (mv) {
    const i = Number(mv.dataset.move);
    [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
    renderRows();
  }
});

$('add-step').addEventListener('click', () => {
  steps.push({ action: '', data: '', expected: '' });
  renderRows();
  const last = $('rows').querySelector('tr:last-child textarea');
  if (last) last.focus();
});

$('ai').addEventListener('click', async () => {
  $('ai-error').classList.add('hidden');
  if (!settings.apiKey) {
    $('ai-error').innerHTML = 'AI needs a Claude API key. <a href="options.html" target="_blank">Add one in Settings</a>, then reload this page.';
    $('ai-error').classList.remove('hidden');
    return;
  }
  const btn = $('ai');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Writing…';
  try {
    const r = await generateTestCaseWithAI({ events, draft: steps, module: $('tc-module').value.trim(), language: $('language').value }, settings);
    if (r.steps.length) steps = r.steps;
    if (r.title) $('tc-title').value = r.title;
    if (r.precondition && !$('tc-pre').value.trim()) $('tc-pre').value = r.precondition;
    $('notes').classList.toggle('hidden', !r.notes.length);
    $('notes').innerHTML = r.notes.length ? `<b>Check these:</b><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    renderRows();
    toast('Steps and expected results updated. Review before saving.');
  } catch (e) {
    $('ai-error').textContent = `AI couldn't write the test case: ${e.message}`;
    $('ai-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Improve with AI';
  }
});

function collect() {
  return {
    id: $('tc-id').value.trim(),
    module: $('tc-module').value.trim(),
    title: $('tc-title').value.trim(),
    precondition: $('tc-pre').value.trim(),
    steps: steps.map((s) => ({ action: s.action.trim(), data: s.data.trim(), expected: s.expected.trim() })).filter((s) => s.action),
  };
}

function validate(tc) {
  if (!tc.id) { $('tc-id').focus(); toast('Add a test case ID'); return false; }
  if (!tc.title) { $('tc-title').focus(); toast('Add a scenario name'); return false; }
  if (!tc.steps.length) { toast('Add at least one step'); return false; }
  return true;
}

$('add-suite').addEventListener('click', async () => {
  const tc = collect();
  if (!validate(tc)) return;
  const data = await chrome.storage.local.get('suite');
  const current = data.suite || newSuite('My test cases');
  if (current.cases.some((c) => c.id === tc.id)) {
    if (added) { toast(`${tc.id} is already in your test cases`); return; }
    $('tc-id').focus();
    toast(`${tc.id} already exists. Use a different ID.`);
    return;
  }
  appendCase(current, tc);
  await chrome.storage.local.set({ suite: current });
  added = true;
  $('add-suite').textContent = `✓ Added as ${tc.id}`;
  $('suite-hint').textContent = `Added to “${current.name}”. Open the ClearBug side panel to run it.`;
  toast(`${tc.id} added to your test cases`);
});

$('download').addEventListener('click', async () => {
  const tc = collect();
  if (!validate(tc)) return;
  const blob = await exportTestCasesWorkbook([tc], STANDARD_HEADERS);
  const safe = tc.title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 50).trim();
  download(`${tc.id} ${safe}.xlsx`, blob);
});
