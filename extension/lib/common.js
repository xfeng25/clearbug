// Shared helpers for the extension pages (popup, report, defect log, settings).

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const STATUSES = ['New', 'In progress', 'Fixed', 'Retest', 'Closed', "Won't fix"];

export const LANGUAGES = {
  en: { label: 'English', prompt: 'English' },
  'zh-Hans': { label: '简体中文', prompt: 'Simplified Chinese' },
  'zh-Hant': { label: '繁體中文', prompt: 'Traditional Chinese' },
};

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const LABELS = {
  en: {
    severity: 'Severity', module: 'System / module', env: 'Environment', url: 'Page', steps: 'Steps to reproduce',
    expected: 'Expected result', actual: 'Actual result', errors: 'Technical details for developers (captured automatically)', errorsNote: 'Recorded by the browser during the test. May include background errors unrelated to this issue.',
    reporter: 'Reported by', date: 'Date', shot: 'Screenshot attached.', testCase: 'Test case', step: 'failed at step',
  },
  'zh-Hans': {
    severity: '严重程度', module: '系统/模块', env: '测试环境', url: '页面', steps: '复现步骤',
    expected: '预期结果', actual: '实际结果', errors: '给开发的技术信息（自动记录）', errorsNote: '测试时浏览器自动记录，可能包含与本问题无关的后台错误。',
    reporter: '报告人', date: '日期', shot: '截图见附件。', testCase: '测试用例', step: '失败步骤',
  },
  'zh-Hant': {
    severity: '嚴重程度', module: '系統/模組', env: '測試環境', url: '頁面', steps: '重現步驟',
    expected: '預期結果', actual: '實際結果', errors: '給開發的技術資訊（自動記錄）', errorsNote: '測試時瀏覽器自動記錄，可能包含與本問題無關的背景錯誤。',
    reporter: '回報人', date: '日期', shot: '截圖見附件。', testCase: '測試案例', step: '失敗步驟',
  },
};

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { apiKey: '', model: DEFAULT_MODEL, language: 'en', maskInputs: false, lastTester: '', lastModule: '', ...settings };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...patch } });
}

export async function getDefects() {
  const { defects = [] } = await chrome.storage.local.get('defects');
  return defects;
}

export async function saveDefects(defects) {
  await chrome.storage.local.set({ defects });
}

export async function nextDefectId() {
  const { counter = 0 } = await chrome.storage.local.get('counter');
  const n = counter + 1;
  await chrome.storage.local.set({ counter: n });
  return 'DEF-' + String(n).padStart(3, '0');
}

export function describeEnv(env = {}) {
  const ua = env.ua || '';
  const chrome = (ua.match(/Chrome\/(\d+)/) || [])[1];
  const edge = (ua.match(/Edg\/(\d+)/) || [])[1];
  let os = 'Unknown OS';
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  const browser = edge ? `Edge ${edge}` : chrome ? `Chrome ${chrome}` : 'Browser';
  return [browser, os, env.viewport ? `window ${env.viewport}` : ''].filter(Boolean).join(' · ');
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function stepsFromText(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\s*[.)、]\s*/, '').trim())
    .filter(Boolean);
}

export function stepsToText(steps = []) {
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

// Plain-text report: pastes cleanly into Jira, Azure DevOps, email or Teams.
export function reportToText(d) {
  const L = LABELS[d.language] || LABELS.en;
  const lines = [];
  lines.push(`${d.id ? `[${d.id}] ` : ''}${d.title || ''}`);
  lines.push('');
  lines.push(`${L.severity}: ${d.severity}${d.severityReason ? ` — ${d.severityReason}` : ''}`);
  if (d.testCase) lines.push(`${L.testCase}: ${d.testCase.caseId} · ${L.step} ${d.testCase.stepNo}`);
  if (d.module) lines.push(`${L.module}: ${d.module}`);
  if (d.url) lines.push(`${L.url}: ${d.url}`);
  lines.push(`${L.env}: ${describeEnv(d.env)}`);
  if (d.tester) lines.push(`${L.reporter}: ${d.tester}`);
  lines.push(`${L.date}: ${fmtDate(d.createdAt)}`);
  lines.push('');
  lines.push(`${L.steps}:`);
  lines.push(stepsToText(d.steps));
  lines.push('');
  lines.push(`${L.expected}:`);
  lines.push(d.expected || '-');
  lines.push('');
  lines.push(`${L.actual}:`);
  lines.push(d.actual || '-');
  if (d.errors && d.errors.length) {
    lines.push('');
    lines.push(`${L.errors}:`);
    lines.push(`(${L.errorsNote})`);
    d.errors.forEach((e) => lines.push(`- [${e.errorType}] ${e.text}`));
  }
  if (d.hasScreenshot) {
    lines.push('');
    lines.push(L.shot);
  }
  return lines.join('\n');
}

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toast(msg, ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function labelsFor(lang) {
  return LABELS[lang] || LABELS.en;
}
