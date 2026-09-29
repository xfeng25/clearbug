// Report writing: Claude API when a key is set, a rule-based template otherwise.
import { LANGUAGES, SEVERITIES, describeEnv } from './common.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are a senior QA lead. A business user (not a developer) found a problem while doing user acceptance testing (UAT). Turn their rough note plus the automatically recorded context into a defect report a developer can act on without asking follow-up questions.

Rules:
- Use only facts from the input and the screenshot. Never invent test data, IDs, or error messages.
- Steps to reproduce: rewrite the recorded actions as short, numbered, imperative steps. Drop noise (accidental clicks, repeated actions, steps unrelated to the problem). Keep the test data values the tester entered. The first step says which page to start on. The last step is the action that triggers the problem.
- Keep on-screen names (buttons, field labels, menu items, values) exactly as they appear, in their original language, in quotes. Do not translate them.
- Actual result: what happened, including any error message visible in the screenshot or captured from the page (console / network errors). Be specific.
- Expected result: use the tester's expectation. If none was given, infer the most reasonable expectation and end it with " (inferred)".
- Severity, choose one:
  Critical = blocks a core business process, data loss or corruption, or security issue, with no workaround.
  High = a major function is broken or gives wrong results; workaround is hard or not acceptable.
  Medium = a function behaves incorrectly but a reasonable workaround exists.
  Low = cosmetic, text, or layout issue with no functional impact.
- Title: "[Area] Symptom when action", max 90 characters, specific (not "Error on page").
- missing_info: up to 3 short questions for the tester only if a developer would genuinely need the answer (e.g. whether it happens every time, which user role). Empty array if nothing important is missing.

Respond with only a JSON object, no markdown fences:
{"title": string, "severity": "Critical"|"High"|"Medium"|"Low", "severity_reason": string (one sentence), "steps": string[], "expected": string, "actual": string, "missing_info": string[]}`;

function buildUserPrompt(input) {
  const lang = (LANGUAGES[input.language] || LANGUAGES.en).prompt;
  const steps = (input.steps || [])
    .map((s, i) => `${i + 1}. ${s.text}${s.kind === 'navigate' && s.url ? `  [${s.url}]` : ''}`)
    .join('\n');
  const errors = (input.errors || []).map((e) => `- [${e.errorType}] ${e.text}${e.detail ? ` (${e.detail})` : ''}`).join('\n');
  const tc = input.testCase;
  const tcBlock = tc
    ? `This bug was found while executing UAT test case ${tc.caseId} "${tc.title || ''}"${tc.module ? ` (module: ${tc.module})` : ''}.
${tc.precondition ? `Precondition: ${tc.precondition}\n` : ''}Official test steps the tester followed; step ${tc.stepNo} FAILED:
${(tc.steps || []).map((s) => `${s.no}. ${s.action}${s.data ? ` [Test data: ${s.data}]` : ''}${s.expected ? ` — Expected: ${s.expected}` : ''}`).join('\n')}

Use these official steps as the backbone of "steps", filling in the concrete values the tester actually entered (from the recorded actions) where the script is vague. The expected result must come from step ${tc.stepNo}'s expected result. Start the title with "[${tc.caseId}]".

`
    : '';
  return `${tcBlock}Tester's description of the problem (may be in any language):
"""${input.description}"""

Tester's expected result: ${input.expected ? `"""${input.expected}"""` : '(not provided)'}
System / module under test: ${input.module || '(not provided)'}
Page where the problem was reported: ${input.pageTitle || ''} ${input.url || ''}
Environment: ${describeEnv(input.env)}

Recorded actions, oldest first (captured automatically, may contain noise):
${steps || '(no actions recorded)'}

Errors captured on the page:
${errors || '(none)'}

${input.screenshotBase64 ? 'Attached: screenshot at the moment the tester reported the bug. Red boxes, if any, were drawn by the tester to mark the problem.' : 'No screenshot available.'}

Write every field of the report in ${lang} (keep on-screen names in their original language).`;
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI response was not in the expected format. Try again.');
  return JSON.parse(text.slice(start, end + 1));
}

function normalize(r) {
  const sev = SEVERITIES.find((s) => s.toLowerCase() === String(r.severity || '').toLowerCase()) || 'Medium';
  return {
    title: String(r.title || '').trim(),
    severity: sev,
    severityReason: String(r.severity_reason || '').trim(),
    steps: Array.isArray(r.steps) ? r.steps.map((s) => String(s).replace(/^\s*\d+\s*[.)]\s*/, '').replace(/\s*\n\s*/g, '; ').trim()).filter(Boolean) : [],
    expected: String(r.expected || '').trim(),
    actual: String(r.actual || '').trim(),
    missingInfo: Array.isArray(r.missing_info) ? r.missing_info.map(String).filter(Boolean).slice(0, 3) : [],
  };
}

async function callClaude({ apiKey, model, system, content, maxTokens }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) msg = j.error.message;
    } catch (_) { /* ignore */ }
    if (res.status === 401) msg = 'Your API key was rejected. Check it in Settings.';
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export async function generateWithAI(input, settings) {
  const content = [];
  if (input.screenshotBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.screenshotBase64 } });
  }
  content.push({ type: 'text', text: buildUserPrompt(input) });
  const text = await callClaude({
    apiKey: settings.apiKey,
    model: settings.model,
    system: SYSTEM_PROMPT,
    content,
    maxTokens: 2000,
  });
  return normalize(parseJson(text));
}

const TESTCASE_PROMPT = `You are a business analyst writing UAT test cases for business users. You receive the actions a tester recorded while walking through a business process in a web system, a rule-based draft of the test steps, and any errors the page produced.

Write one clean, reusable test case:
- Merge related actions into meaningful steps (e.g. filling several fields of one form = one step, with the values as test data). Drop noise: repeated or accidental clicks, clicks on empty areas, steps unrelated to the process.
- Each step: "action" in imperative form; "data" = the test data values used in that step, one "Label: value" per line (empty string if none); "expected" = an observable result a business user can check on screen.
- Base expected results on what the recording shows happened next (e.g. which page opened). Where the recording does not show it, write the normal business expectation.
- If the page produced an error during the recording, do NOT describe the error as expected behaviour. Write what should happen and mention the error in "notes".
- Keep on-screen names (buttons, fields, pages, values) exactly as recorded, in quotes, in their original language.
- Never invent values that were not recorded. Values shown as "(hidden)" stay "(hidden)".
- "title": short scenario name, verb first, e.g. "Submit a new vendor request".
- "precondition": what must be true before step 1 (e.g. user role, existing data). Empty string if nothing can be inferred.
- "notes": up to 3 short remarks for the author (errors seen, steps that look unrelated, expectations you guessed). Empty array if none.

Respond with only a JSON object, no markdown fences:
{"title": string, "precondition": string, "steps": [{"action": string, "data": string, "expected": string}], "notes": string[]}`;

export async function generateTestCaseWithAI({ events, draft, module, language }, settings) {
  const lang = (LANGUAGES[language] || LANGUAGES.en).prompt;
  const recorded = events.map((e, i) => `${i + 1}. ${e.kind === 'error' ? `[page error] ${e.text}` : e.text}${e.kind === 'navigate' && e.url ? `  [${e.url}]` : ''}`).join('\n');
  const draftText = draft.map((s, i) => `${i + 1}. ${s.action}${s.data ? ` | data: ${s.data.replace(/\n/g, '; ')}` : ''}${s.expected ? ` | expected: ${s.expected}` : ''}`).join('\n');
  const text = await callClaude({
    apiKey: settings.apiKey,
    model: settings.model,
    system: TESTCASE_PROMPT,
    content: [{ type: 'text', text: `Module / system: ${module || '(not given)'}

Recorded actions and page errors, in order:
${recorded || '(none)'}

Rule-based draft steps:
${draftText || '(none)'}

Write the title, precondition, actions, expected results and notes in ${lang} (keep on-screen names in their original language).` }],
    maxTokens: 3000,
  });
  const r = parseJson(text);
  return {
    title: String(r.title || '').trim(),
    precondition: String(r.precondition || '').trim(),
    steps: (Array.isArray(r.steps) ? r.steps : []).map((s) => ({
      action: String(s.action || '').trim(),
      data: String(s.data || '').trim(),
      expected: String(s.expected || '').trim(),
    })).filter((s) => s.action),
    notes: Array.isArray(r.notes) ? r.notes.map(String).filter(Boolean).slice(0, 3) : [],
  };
}

export async function testConnection(settings) {
  const text = await callClaude({
    apiKey: settings.apiKey,
    model: settings.model,
    system: 'Reply with the single word OK.',
    content: [{ type: 'text', text: 'ping' }],
    maxTokens: 5,
  });
  return text.trim();
}

// No API key: build a solid report from the recorded data with simple rules.
export function generateFromTemplate(input) {
  const desc = String(input.description || '').trim();
  const tc = input.testCase;
  const firstSentence = desc.split(/(?<=[.!?。！？])\s*|\n/)[0] || desc;
  const prefix = tc ? `[${tc.caseId}] ` : input.module ? `[${input.module}] ` : '';
  const title = `${prefix}${firstSentence}`.slice(0, 90);

  const errors = input.errors || [];
  const serverError = errors.some((e) => e.errorType === 'network' && /→\s*5\d\d/.test(e.text));
  const jsError = errors.some((e) => e.errorType === 'js');
  const severity = serverError || jsError ? 'High' : 'Medium';
  const severityReason = serverError
    ? 'Suggested because the server returned an error (5xx). Please review.'
    : jsError
      ? 'Suggested because the page threw a script error. Please review.'
      : 'Default suggestion. Please review.';

  const steps = tc
    ? [
      ...(tc.precondition ? [`Precondition: ${tc.precondition}`] : []),
      ...(tc.steps || []).map((s) => `${s.action}${s.data ? ` (test data: ${s.data})` : ''}`.replace(/\s*\n\s*/g, '; ')),
    ]
    : (input.steps || []).map((s) => s.text);
  const expected = input.expected || (tc && tc.expected) || '';
  let actual = desc;
  if (errors.length) actual += `\n\nErrors on the page:\n${errors.map((e) => `- ${e.text}`).join('\n')}`;

  const missingInfo = [];
  if (!expected) missingInfo.push('What did you expect to happen?');
  if (!steps.length) missingInfo.push('What steps led to this? No actions were recorded.');

  return { title, severity, severityReason, steps, expected, actual, missingInfo };
}
