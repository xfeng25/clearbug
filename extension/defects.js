import { SEVERITIES, STATUSES, getDefects, saveDefects, download, esc, fmtDate, toast } from './lib/common.js';
import { exportDefectsWorkbook } from './lib/excel.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const defects = (await getDefects()).slice().reverse(); // newest first
  $('empty').classList.toggle('hidden', defects.length > 0);
  $('export').disabled = !defects.length;
  $('all').checked = false;

  const open = defects.filter((d) => !['Closed', "Won't fix"].includes(d.status));
  const bySev = SEVERITIES.map((s) => [s, open.filter((d) => d.severity === s).length]).filter(([, n]) => n);
  $('stats').innerHTML =
    `<span class="stat"><b>${defects.length}</b>total</span><span class="stat"><b>${open.length}</b>open</span>` +
    bySev.map(([s, n]) => `<span class="stat"><b>${n}</b><span class="sev ${s}">${s}</span></span>`).join('');

  $('rows').innerHTML = defects.map((d) => `
    <tr>
      <td><input type="checkbox" class="sel" value="${esc(d.id)}"></td>
      <td class="id"><a href="report.html?id=${encodeURIComponent(d.id)}">${esc(d.id)}</a></td>
      <td class="title">${esc(d.title)}</td>
      <td><span class="sev ${esc(d.severity)}">${esc(d.severity)}</span></td>
      <td><select data-id="${esc(d.id)}">${STATUSES.map((s) => `<option${s === d.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></td>
      <td style="white-space:nowrap">${d.testCase ? `${esc(d.testCase.caseId)} · step ${esc(d.testCase.stepNo)}` : '<span class="muted">—</span>'}</td>
      <td>${esc(d.module || '')}</td>
      <td>${esc(d.tester || '')}</td>
      <td style="white-space:nowrap">${esc(fmtDate(d.createdAt))}</td>
      <td><button class="icon" data-del="${esc(d.id)}" title="Delete">Delete</button></td>
    </tr>`).join('');
  updateSelection();
}

$('rows').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-id]');
  if (!sel) return;
  const defects = await getDefects();
  const d = defects.find((x) => x.id === sel.dataset.id);
  if (!d) return;
  d.status = sel.value;
  d.updatedAt = new Date().toISOString();
  await saveDefects(defects);
  toast(`${d.id} → ${d.status}`);
  render();
});

$('rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-del]');
  if (!b) return;
  const id = b.dataset.del;
  if (!confirm(`Delete ${id}? This can't be undone.`)) return;
  const defects = (await getDefects()).filter((x) => x.id !== id);
  await saveDefects(defects);
  await chrome.storage.local.remove(`shot:${id}`);
  render();
});

const loadShot = async (d) => (await chrome.storage.local.get(`shot:${d.id}`))[`shot:${d.id}`] || null;
const selected = () => Array.from(document.querySelectorAll('.sel:checked')).map((c) => c.value);

function updateSelection() {
  const n = selected().length;
  $('export-sel').disabled = !n;
  $('export-sel').textContent = n ? `⬇ Export ${n} selected` : '⬇ Export selected';
}
$('rows').addEventListener('change', (e) => { if (e.target.classList.contains('sel')) updateSelection(); });
$('all').addEventListener('change', () => {
  document.querySelectorAll('.sel').forEach((c) => { c.checked = $('all').checked; });
  updateSelection();
});

async function exportList(defects, name) {
  download(name, await exportDefectsWorkbook(defects, loadShot));
}

$('export').addEventListener('click', async () => {
  const date = new Date().toISOString().slice(0, 10);
  await exportList(await getDefects(), `ClearBug-defect-log-${date}.xlsx`);
});

$('export-sel').addEventListener('click', async () => {
  const ids = selected();
  const defects = (await getDefects()).filter((d) => ids.includes(d.id));
  const name = defects.length === 1 ? `${defects[0].id}.xlsx` : `ClearBug-defects-${ids.length}.xlsx`;
  await exportList(defects, name);
});

chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.defects) render(); });
render();
