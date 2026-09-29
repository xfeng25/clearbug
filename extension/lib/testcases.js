// Reading UAT test case spreadsheets (xlsx / csv) in whatever layout the
// project team uses, and turning them into test cases with ordered steps.

export const FIELDS = [
  { key: 'id', label: 'Test case ID', required: false },
  { key: 'module', label: 'Module / area' },
  { key: 'title', label: 'Scenario / title' },
  { key: 'precondition', label: 'Precondition' },
  { key: 'stepNo', label: 'Step no.' },
  { key: 'action', label: 'Test step (action)', required: true },
  { key: 'data', label: 'Test data' },
  { key: 'expected', label: 'Expected result', required: true },
  { key: 'actual', label: 'Actual result (to fill)' },
  { key: 'status', label: 'Status / Pass-Fail (to fill)' },
  { key: 'tester', label: 'Tester (to fill)' },
  { key: 'date', label: 'Execution date (to fill)' },
];

// Header names seen in real UAT templates (normalized: lower case, no spaces or punctuation)
const SYNONYMS = {
  id: ['testcaseid', 'tcid', 'caseid', 'testid', 'testcaseno', 'testcasenumber', 'tcno', 'tc', 'id', 'testcase#', 'tc#', 'scriptid', 'testscriptid',
    '用例编号', '用例id', '测试用例编号', '测试用例id', '编号', '案例编号', '用例編號', '測試案例編號', '案例編號'],
  module: ['module', 'area', 'functionalarea', 'feature', 'process', 'businessprocess', 'component', 'workstream', 'application',
    '模块', '功能模块', '业务模块', '功能', '模組', '功能模組'],
  title: ['testscenario', 'scenario', 'testcasename', 'testcasetitle', 'title', 'testcase', 'testcasedescription', 'summary', 'scenariodescription', 'testscriptname',
    '场景', '测试场景', '用例名称', '用例标题', '测试用例', '标题', '場景', '測試場景', '案例名稱', '用例名稱'],
  precondition: ['precondition', 'preconditions', 'prerequisite', 'prerequisites', 'precondition(s)', '前置条件', '前提条件', '前置條件'],
  stepNo: ['stepno', 'stepnumber', 'step#', 'stepid', 'step', 'stepseq', '序号', '步骤号', '步骤编号', '步驟號', '序號'],
  action: ['teststep', 'teststeps', 'stepdescription', 'action', 'actions', 'steps', 'procedure', 'testprocedure', 'description', 'stepdetails', 'testaction',
    '操作步骤', '测试步骤', '步骤描述', '步骤', '操作', '操作步驟', '測試步驟', '步驟'],
  data: ['testdata', 'data', 'inputdata', 'input', 'testinput', '测试数据', '输入数据', '測試資料', '測試數據'],
  expected: ['expectedresult', 'expectedresults', 'expected', 'expectedoutcome', 'expectedbehavior', 'expectedbehaviour', 'expectedoutput',
    '预期结果', '期望结果', '预期', '預期結果', '期望結果'],
  actual: ['actualresult', 'actualresults', 'actual', 'actualoutcome', 'actualbehavior', '实际结果', '实际', '實際結果'],
  status: ['status', 'result', 'passfail', 'pass/fail', 'teststatus', 'executionstatus', 'testresult', 'outcome',
    '状态', '测试结果', '结果', '执行结果', '狀態', '測試結果', '結果'],
  tester: ['tester', 'testedby', 'executedby', 'testername', 'owner', '测试人', '测试人员', '执行人', '測試人員', '執行人'],
  date: ['executiondate', 'testdate', 'date', 'executedon', 'testedon', 'dateexecuted', '测试日期', '执行日期', '日期', '測試日期', '執行日期'],
};
// Order used for "header contains synonym" matching (more specific first)
const CONTAINS_ORDER = ['expected', 'actual', 'precondition', 'data', 'id', 'stepNo', 'action', 'title', 'module', 'status', 'tester', 'date'];

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-.:()（）/\\]+/g, '');

// ---------- reading files ----------

function cellText(cell) {
  if (!cell) return '';
  let t = '';
  try { t = cell.text; } catch (_) { t = ''; }
  if (t == null) t = '';
  if (cell.value instanceof Date) t = cell.value.toISOString().slice(0, 10);
  return String(t).replace(/\r\n?/g, '\n').trim();
}

async function readXlsx(buffer) {
  const wb = new globalThis.ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    const colCount = Math.min(ws.columnCount || 0, 60);
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const vals = [];
      for (let c = 1; c <= colCount; c++) vals.push(cellText(row.getCell(c)));
      rows.push(vals);
    }
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

export async function readSpreadsheet(file) {
  const name = file.name || 'test-cases';
  if (/\.xls$/i.test(name)) throw new Error('Old .xls files are not supported. In Excel, use File → Save As → .xlsx, then import again.');
  if (/\.(csv|tsv|txt)$/i.test(name)) return [{ name, rows: parseCsv(await file.text()) }];
  return readXlsx(await file.arrayBuffer());
}

// ---------- header detection & column mapping ----------

function matchField(header, taken) {
  const n = norm(header);
  if (!n) return null;
  for (const [key, list] of Object.entries(SYNONYMS)) {
    if (!taken.has(key) && list.some((s) => norm(s) === n)) return key;
  }
  for (const key of CONTAINS_ORDER) {
    if (taken.has(key)) continue;
    if (SYNONYMS[key].some((s) => norm(s).length >= 4 && n.includes(norm(s)))) return key;
  }
  return null;
}

export function guessMapping(headers) {
  const mapping = Object.fromEntries(FIELDS.map((f) => [f.key, -1]));
  const taken = new Set();
  headers.forEach((h, i) => {
    const key = matchField(h, taken);
    if (key) { mapping[key] = i; taken.add(key); }
  });
  return mapping;
}

function headerScore(row) {
  const m = guessMapping(row);
  let score = 0;
  if (m.action >= 0) score += 2;
  if (m.expected >= 0) score += 2;
  ['id', 'title', 'stepNo', 'data', 'module', 'status', 'actual'].forEach((k) => { if (m[k] >= 0) score += 1; });
  return score;
}

// Pick the sheet and header row that look most like a test case table.
export function detectTable(sheets) {
  let best = null;
  for (const sheet of sheets) {
    const limit = Math.min(sheet.rows.length, 20);
    for (let r = 0; r < limit; r++) {
      const score = headerScore(sheet.rows[r]);
      if (!best || score > best.score) best = { sheet, headerRow: r, score };
    }
  }
  if (!best || best.score < 3) {
    throw new Error("Couldn't find a header row with test steps and expected results. Check that the file has column headers like \"Test Step\" and \"Expected Result\".");
  }
  const { sheet, headerRow } = best;
  let headers = sheet.rows[headerRow].slice();
  // Trim trailing empty columns
  let last = headers.length - 1;
  while (last >= 0 && !headers[last] && !sheet.rows.slice(headerRow + 1).some((r) => r[last])) last--;
  headers = headers.slice(0, last + 1).map((h, i) => h || `Column ${i + 1}`);
  const rows = sheet.rows.slice(headerRow + 1).map((r) => {
    const out = r.slice(0, headers.length);
    while (out.length < headers.length) out.push('');
    return out;
  });
  const mapping = guessMapping(headers);
  // A "Step" column holding long sentences is really the action column
  if (mapping.stepNo >= 0 && mapping.action < 0) {
    const vals = rows.map((r) => r[mapping.stepNo]).filter(Boolean);
    const numeric = vals.filter((v) => /^\s*\d+(\.\d+)?\s*$/.test(v)).length;
    if (vals.length && numeric / vals.length < 0.5) { mapping.action = mapping.stepNo; mapping.stepNo = -1; }
  }
  return { sheetName: sheet.name, headerRow, headers, rows, mapping };
}

// ---------- building test cases ----------

const NUMBERED = /^\s*(?:step\s*)?(\d+)\s*[.)、:：]\s*/i;

function splitNumbered(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || lines.filter((l) => NUMBERED.test(l)).length < 2) return null;
  const items = [];
  for (const l of lines) {
    if (NUMBERED.test(l) || !items.length) items.push(l.replace(NUMBERED, ''));
    else items[items.length - 1] += '\n' + l;
  }
  return items;
}

export function buildCases(table, mapping) {
  const get = (row, key) => (mapping[key] >= 0 ? row[mapping[key]] || '' : '');
  const cases = [];
  const byId = new Map();
  let ctx = { id: '', module: '', title: '', precondition: '' };
  let autoId = 0;

  table.rows.forEach((row, rowIndex) => {
    if (!row.some((c) => c)) return;
    const action = get(row, 'action');
    const expected = get(row, 'expected');
    const id = get(row, 'id');
    const title = get(row, 'title');

    // New test case starts when the ID changes (or, with no ID column, when the title changes)
    const startsNew = id ? id !== ctx.id : mapping.id < 0 && title && title !== ctx.title;
    if (startsNew) {
      ctx = {
        id: id || `TC-${String(++autoId).padStart(3, '0')}`,
        module: get(row, 'module'),
        title,
        precondition: get(row, 'precondition'),
      };
    } else {
      // merged / blank cells inherit from the row above
      if (get(row, 'module')) ctx.module = get(row, 'module');
      if (title) ctx.title = title;
      if (get(row, 'precondition')) ctx.precondition = get(row, 'precondition');
    }
    if (!action && !expected) return; // header-only row for the case
    if (!ctx.id) ctx.id = `TC-${String(++autoId).padStart(3, '0')}`;

    let tc = byId.get(ctx.id);
    if (!tc) {
      tc = { id: ctx.id, module: ctx.module, title: ctx.title, precondition: ctx.precondition, steps: [] };
      byId.set(ctx.id, tc);
      cases.push(tc);
    }
    if (!tc.title && ctx.title) tc.title = ctx.title;
    if (!tc.module && ctx.module) tc.module = ctx.module;

    const data = get(row, 'data');
    const actions = splitNumbered(action);
    if (actions) {
      const exps = splitNumbered(expected);
      actions.forEach((a, i) => {
        let exp = '';
        if (exps && exps.length === actions.length) exp = exps[i];
        else if (i === actions.length - 1) exp = expected;
        tc.steps.push({ no: String(tc.steps.length + 1), action: a, data: i === 0 ? data : '', expected: exp, rowIndex });
      });
    } else {
      tc.steps.push({ no: get(row, 'stepNo') || String(tc.steps.length + 1), action, data, expected, rowIndex });
    }
  });

  cases.forEach((tc) => { if (!tc.title) tc.title = tc.steps[0] ? tc.steps[0].action.slice(0, 80) : tc.id; });
  return cases;
}

// ---------- test cases written in ClearBug ----------

export const STANDARD_HEADERS = ['Test Case ID', 'Module', 'Test Scenario', 'Pre-condition', 'Step No.', 'Test Step', 'Test Data',
  'Expected Result', 'Actual Result', 'Status', 'Tested By', 'Test Date'];
const STANDARD_MAPPING = { id: 0, module: 1, title: 2, precondition: 3, stepNo: 4, action: 5, data: 6, expected: 7, actual: 8, status: 9, tester: 10, date: 11 };

export function newSuite(name) {
  return {
    id: 's' + Date.now().toString(36),
    name,
    importedAt: new Date().toISOString(),
    sheetName: 'Test Cases',
    headers: STANDARD_HEADERS.slice(),
    rows: [],
    mapping: { ...STANDARD_MAPPING },
    cases: [],
  };
}

export function nextCaseId(suite) {
  const nums = (suite ? suite.cases : []).map((c) => Number((String(c.id).match(/(\d+)\s*$/) || [])[1])).filter((n) => !Number.isNaN(n));
  const prefix = suite && suite.cases.length ? (String(suite.cases[suite.cases.length - 1].id).match(/^(.*?)\d+\s*$/) || [])[1] || 'TC-' : 'TC-';
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return prefix + String(n).padStart(3, '0');
}

// Adds a test case to a suite, writing rows in the suite's own column layout
// so "Export results" keeps the same format.
export function appendCase(suite, tc) {
  const m = suite.mapping;
  const steps = tc.steps.map((s, i) => {
    const row = new Array(suite.headers.length).fill('');
    const put = (key, val) => { if (m[key] >= 0) row[m[key]] = val; };
    put('id', tc.id);
    if (i === 0 || m.id < 0) { put('module', tc.module || ''); put('title', tc.title || ''); put('precondition', tc.precondition || ''); }
    put('stepNo', String(i + 1));
    put('action', s.action);
    put('data', s.data || '');
    put('expected', s.expected || '');
    suite.rows.push(row);
    return { no: String(i + 1), action: s.action, data: s.data || '', expected: s.expected || '', rowIndex: suite.rows.length - 1 };
  });
  suite.cases.push({ id: tc.id, module: tc.module || '', title: tc.title || tc.id, precondition: tc.precondition || '', steps });
  return suite;
}

// ---------- results ----------

export const STEP_STATUS = { Pass: 'Passed', Fail: 'Failed', Blocked: 'Blocked' };

export function caseStatus(tc, result) {
  const steps = (result && result.steps) || [];
  const done = tc.steps.map((_, i) => steps[i] && steps[i].status).filter(Boolean);
  if (done.includes('Fail')) return 'Failed';
  if (done.includes('Blocked')) return 'Blocked';
  if (done.length === 0) return 'Not run';
  if (done.length === tc.steps.length) return 'Passed';
  return 'In progress';
}

export function suiteStats(suite, results) {
  const s = { total: 0, Passed: 0, Failed: 0, Blocked: 0, 'In progress': 0, 'Not run': 0 };
  for (const tc of suite.cases) {
    s.total++;
    s[caseStatus(tc, results[tc.id])]++;
  }
  return s;
}
