// Excel exports: the tester's own test case file with results filled in,
// plus Summary, Defects and Evidence sheets.
import { caseStatus, suiteStats } from './testcases.js';
import { describeEnv, fmtDate, stepsToText } from './common.js';

const COLORS = {
  Passed: 'FFD9F2E0', Pass: 'FFD9F2E0',
  Failed: 'FFFBD9D7', Fail: 'FFFBD9D7',
  Blocked: 'FFFFEFC7',
  'In progress': 'FFE3E8FF',
  'Not run': 'FFEFEFEF',
};
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const BORDER = { style: 'thin', color: { argb: 'FFD0D4DC' } };
const STEP_STATUS_LABEL = { Pass: 'Passed', Fail: 'Failed', Blocked: 'Blocked' };

function fill(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb } }; }

function styleHeader(row) {
  row.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = HEADER_FONT;
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
  });
  row.height = 22;
}

function styleBody(ws, fromRow) {
  for (let r = fromRow; r <= ws.rowCount; r++) {
    ws.getRow(r).eachCell({ includeEmpty: true }, (c) => {
      c.alignment = { vertical: 'top', wrapText: true };
      c.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
    });
  }
}

function widthFor(header, values) {
  const longest = Math.max(String(header).length, ...values.map((v) => Math.min(String(v || '').split('\n').reduce((m, l) => Math.max(m, l.length), 0), 60)));
  return Math.max(10, Math.min(55, longest + 2));
}

// ---------- Sheet 1: the imported test cases with results ----------
function addResultsSheet(wb, suite, results, tester) {
  const ws = wb.addWorksheet('Test Results', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = suite.headers.slice();
  const m = { ...suite.mapping };
  const ensure = (key, label) => {
    if (m[key] >= 0) return;
    m[key] = headers.length;
    headers.push(label);
  };
  ensure('actual', 'Actual Result');
  ensure('status', 'Status');
  ensure('tester', 'Tester');
  ensure('date', 'Execution Date');
  const defectCol = headers.length; headers.push('Defect ID');

  // step results per original row
  const perRow = new Map();
  for (const tc of suite.cases) {
    const res = results[tc.id];
    tc.steps.forEach((step, i) => {
      const r = res && res.steps && res.steps[i];
      if (!perRow.has(step.rowIndex)) perRow.set(step.rowIndex, []);
      perRow.get(step.rowIndex).push({ step, r, tester: (res && res.tester) || tester });
    });
  }

  const data = suite.rows.map((orig, rowIndex) => {
    const row = orig.slice();
    while (row.length < headers.length) row.push('');
    const items = perRow.get(rowIndex);
    if (!items) return row;
    const done = items.filter((x) => x.r && x.r.status);
    if (!done.length) {
      if (!row[m.status]) row[m.status] = 'Not Run';
      return row;
    }
    const statuses = done.map((x) => x.r.status);
    const status = statuses.includes('Fail') ? 'Fail' : statuses.includes('Blocked') ? 'Blocked' : done.length === items.length ? 'Pass' : 'In progress';
    row[m.status] = status === 'In progress' ? 'In Progress' : status;
    const notes = done.map((x) => {
      const note = x.r.note || (x.r.status === 'Pass' ? 'As expected' : '');
      return items.length > 1 ? `Step ${x.step.no}: ${note}` : note;
    });
    row[m.actual] = notes.filter(Boolean).join('\n');
    row[m.tester] = done[0].tester || '';
    const last = done.map((x) => x.r.at).sort().pop();
    row[m.date] = last ? new Date(last).toLocaleDateString() : '';
    row[defectCol] = done.map((x) => x.r.defectId).filter(Boolean).join(', ');
    return row;
  });

  ws.addRow(headers);
  data.forEach((r) => ws.addRow(r));
  styleHeader(ws.getRow(1));
  styleBody(ws, 2);
  headers.forEach((h, i) => { ws.getColumn(i + 1).width = widthFor(h, data.map((r) => r[i])); });
  // highlight the columns ClearBug filled in, color the status
  [m.actual, m.status, m.tester, m.date, defectCol].forEach((ci) => {
    ws.getRow(1).getCell(ci + 1).fill = fill('FF4338CA');
  });
  for (let r = 2; r <= ws.rowCount; r++) {
    const cell = ws.getRow(r).getCell(m.status + 1);
    const v = String(cell.value || '');
    const argb = COLORS[v] || COLORS[{ 'In Progress': 'In progress', 'Not Run': 'Not run' }[v]];
    if (argb) cell.fill = fill(argb);
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

// ---------- Sheet 2: summary ----------
function addSummarySheet(wb, suite, results, defects, tester) {
  const ws = wb.addWorksheet('Summary');
  ws.getColumn(1).width = 16; ws.getColumn(2).width = 22; ws.getColumn(3).width = 44;
  [4, 5, 6, 7, 8].forEach((c) => { ws.getColumn(c).width = 14; });

  ws.addRow(['UAT Execution Summary']).font = { bold: true, size: 16 };
  ws.addRow(['Test file', suite.name]);
  ws.addRow(['Exported', fmtDate(new Date().toISOString())]);
  if (tester) ws.addRow(['Tester', tester]);
  ws.addRow([]);

  const st = suiteStats(suite, results);
  const executed = st.total - st['Not run'];
  const kpiStart = ws.rowCount + 1;
  ws.addRow(['Test cases', st.total]);
  ws.addRow(['Passed', st.Passed]);
  ws.addRow(['Failed', st.Failed]);
  ws.addRow(['Blocked', st.Blocked]);
  ws.addRow(['In progress', st['In progress']]);
  ws.addRow(['Not run', st['Not run']]);
  const passRow = ws.addRow(['Pass rate (of executed)', executed ? { formula: `B${kpiStart + 1}/(B${kpiStart}-B${kpiStart + 5})`, result: st.Passed / executed } : 'n/a']);
  if (executed) passRow.getCell(2).numFmt = '0%';
  ws.addRow(['Open defects', defects.filter((d) => !['Closed', "Won't fix"].includes(d.status)).length]);
  for (let r = kpiStart; r <= ws.rowCount; r++) ws.getRow(r).getCell(1).font = { bold: true };
  ['Passed', 'Failed', 'Blocked', 'In progress', 'Not run'].forEach((k, i) => { ws.getRow(kpiStart + 1 + i).getCell(2).fill = fill(COLORS[k]); });
  ws.addRow([]);

  // by module
  const modules = new Map();
  for (const tc of suite.cases) {
    const key = tc.module || '(no module)';
    if (!modules.has(key)) modules.set(key, { total: 0, Passed: 0, Failed: 0, Blocked: 0, other: 0 });
    const s = caseStatus(tc, results[tc.id]);
    const mm = modules.get(key);
    mm.total++;
    if (s in mm) mm[s]++; else mm.other++;
  }
  if (modules.size > 1 || !modules.has('(no module)')) {
    styleHeader(ws.addRow(['Module', 'Test cases', 'Passed', 'Failed', 'Blocked', 'Not run / in progress']));
    const from = ws.rowCount + 1;
    modules.forEach((v, k) => ws.addRow([k, v.total, v.Passed, v.Failed, v.Blocked, v.other]));
    styleBody(ws, from);
    ws.addRow([]);
  }

  // by test case
  styleHeader(ws.addRow(['Test case', 'Module', 'Scenario', 'Status', 'Steps passed', 'Steps total', 'Defects', 'Last run']));
  const from = ws.rowCount + 1;
  for (const tc of suite.cases) {
    const res = results[tc.id] || { steps: [] };
    const status = caseStatus(tc, res);
    const passed = tc.steps.filter((_, i) => res.steps[i] && res.steps[i].status === 'Pass').length;
    const defs = (res.steps || []).map((s) => s && s.defectId).filter(Boolean).join(', ');
    const last = (res.steps || []).map((s) => s && s.at).filter(Boolean).sort().pop();
    const row = ws.addRow([tc.id, tc.module, tc.title, status, passed, tc.steps.length, defs, last ? fmtDate(last) : '']);
    row.getCell(4).fill = fill(COLORS[status]);
  }
  styleBody(ws, from);
}

// ---------- Sheet 3: defects ----------
export function addDefectsSheet(wb, defects) {
  const ws = wb.addWorksheet('Defects', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [
    ['Defect ID', 11, (d) => d.id],
    ['Title', 45, (d) => d.title],
    ['Severity', 10, (d) => d.severity],
    ['Status', 12, (d) => d.status],
    ['Test Case', 12, (d) => d.testCase ? d.testCase.caseId : ''],
    ['Failed Step', 10, (d) => d.testCase ? d.testCase.stepNo : ''],
    ['System / Module', 20, (d) => d.module],
    ['Reported By', 14, (d) => d.tester],
    ['Created', 18, (d) => fmtDate(d.createdAt)],
    ['Steps to Reproduce', 55, (d) => stepsToText(d.steps)],
    ['Expected Result', 40, (d) => d.expected],
    ['Actual Result', 40, (d) => d.actual],
    ['Severity Reason', 35, (d) => d.severityReason],
    ['Captured Errors', 45, (d) => (d.errors || []).map((e) => `[${e.errorType}] ${e.text}`).join('\n')],
    ['Page URL', 35, (d) => d.url],
    ['Environment', 28, (d) => describeEnv(d.env)],
  ];
  ws.addRow(cols.map((c) => c[0]));
  defects.forEach((d) => ws.addRow(cols.map((c) => c[2](d) ?? '')));
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
  styleHeader(ws.getRow(1));
  styleBody(ws, 2);
  const sevColor = { Critical: 'FFF4C7C3', High: 'FFFCE1C8', Medium: 'FFFFF2C2', Low: 'FFEDEDED' };
  for (let r = 2; r <= ws.rowCount; r++) {
    const c = ws.getRow(r).getCell(3);
    if (sevColor[c.value]) c.fill = fill(sevColor[c.value]);
  }
  if (defects.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

// ---------- Sheet 4: evidence screenshots ----------
async function addEvidenceSheet(wb, suite, results, loadEvidence) {
  const items = [];
  for (const tc of suite.cases) {
    const res = results[tc.id];
    if (!res) continue;
    tc.steps.forEach((step, i) => {
      const r = res.steps[i];
      if (r && r.evidence) items.push({ tc, step, r });
    });
  }
  if (!items.length) return;
  const ws = wb.addWorksheet('Evidence');
  ws.getColumn(1).width = 12; ws.getColumn(2).width = 8; ws.getColumn(3).width = 10; ws.getColumn(4).width = 40; ws.getColumn(5).width = 90;
  styleHeader(ws.addRow(['Test case', 'Step', 'Result', 'Step / note', 'Screenshot']));
  for (const it of items) {
    const dataUrl = await loadEvidence(it.r.evidence);
    const row = ws.addRow([it.tc.id, it.step.no, STEP_STATUS_LABEL[it.r.status] || it.r.status, `${it.step.action}${it.r.note ? `\n\nNote: ${it.r.note}` : ''}`, '']);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(3).fill = fill(COLORS[it.r.status] || 'FFFFFFFF');
    if (!dataUrl) continue;
    const dims = await imageSize(dataUrl);
    const w = 600;
    const h = Math.round((dims.h / dims.w) * w);
    const id = wb.addImage({ base64: dataUrl, extension: 'jpeg' });
    ws.addImage(id, { tl: { col: 4.05, row: row.number - 1 + 0.1 }, ext: { width: w, height: h } });
    row.height = Math.round(h * 0.75) + 10;
  }
}

function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => resolve({ w: 16, h: 9 });
    img.src = src;
  });
}

async function toBlob(wb) {
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function newWorkbook() {
  const wb = new globalThis.ExcelJS.Workbook();
  wb.creator = 'ClearBug';
  wb.created = new Date();
  return wb;
}

export async function exportResultsWorkbook({ suite, results, defects, tester, loadEvidence }) {
  const wb = newWorkbook();
  addResultsSheet(wb, suite, results, tester);
  addSummarySheet(wb, suite, results, defects, tester);
  addDefectsSheet(wb, defects);
  await addEvidenceSheet(wb, suite, results, loadEvidence);
  return toBlob(wb);
}

// A test case file in the standard layout, ready to import and run.
export async function exportTestCasesWorkbook(cases, headers) {
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Test Cases', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(headers);
  for (const tc of cases) {
    const start = ws.rowCount + 1;
    tc.steps.forEach((s, i) => ws.addRow([tc.id, tc.module || '', tc.title || '', tc.precondition || '', i + 1, s.action, s.data || '', s.expected || '', '', '', '', '']));
    const end = ws.rowCount;
    if (end > start) ['A', 'B', 'C', 'D'].forEach((c) => ws.mergeCells(`${c}${start}:${c}${end}`));
  }
  styleHeader(ws.getRow(1));
  styleBody(ws, 2);
  [12, 18, 30, 24, 8, 42, 30, 42, 30, 12, 14, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return toBlob(wb);
}

// Screenshots next to each bug. loadShot(defect) returns a data URL or null.
async function addScreenshotsSheet(wb, defects, loadShot) {
  const items = [];
  for (const d of defects) {
    const src = await loadShot(d);
    if (src) items.push({ d, src });
  }
  if (!items.length) return;
  const ws = wb.addWorksheet('Screenshots');
  ws.getColumn(1).width = 12; ws.getColumn(2).width = 40; ws.getColumn(3).width = 110;
  styleHeader(ws.addRow(['Defect ID', 'Title', 'Screenshot']));
  for (const { d, src } of items) {
    const row = ws.addRow([d.id || '', d.title || '', '']);
    row.alignment = { vertical: 'top', wrapText: true };
    const dims = await imageSize(src);
    const w = 760;
    const h = Math.round((dims.h / dims.w) * w);
    const ext = /^data:image\/png/.test(src) ? 'png' : 'jpeg';
    const id = wb.addImage({ base64: src, extension: ext });
    ws.addImage(id, { tl: { col: 2.05, row: row.number - 1 + 0.1 }, ext: { width: w, height: h } });
    row.height = Math.round(h * 0.75) + 10;
  }
}

export async function exportDefectsWorkbook(defects, loadShot) {
  const wb = newWorkbook();
  addDefectsSheet(wb, defects);
  if (loadShot) await addScreenshotsSheet(wb, defects, loadShot);
  return toBlob(wb);
}
