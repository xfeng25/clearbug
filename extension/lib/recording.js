// Turns recorded actions into draft test case steps with simple rules.
// Consecutive field entries become one step with the values as test data.

const RX = {
  entered: /^Entered (.+) in "(.+)"$/,
  selected: /^Selected "(.*)" in "(.+)"$/,
  checked: /^(Checked|Unchecked) "(.+)"$/,
  chose: /^Chose "(.+?)"(?: for "(.+)")?$/,
  attached: /^Attached file "(.*)" to "(.+)"$/,
  cleared: /^Cleared "(.+)"$/,
  clicked: /^Clicked (?:(button|link|tab|menu item|option|toggle|section|element) )?"?(.*?)"?$/,
  page: /^(?:Started on page|Opened page|Navigated to|Started test case \S+ on) "(.+)"$/,
};

const unquote = (v) => String(v).replace(/^"(.*)"$/, '$1');

function fieldEntry(text) {
  let m;
  if ((m = text.match(RX.entered))) return { label: m[2], value: m[1] === '••••••' || m[1] === '[value hidden]' ? '(hidden)' : unquote(m[1]) };
  if ((m = text.match(RX.selected))) return { label: m[2], value: m[1] };
  if ((m = text.match(RX.checked))) return { label: m[2], value: m[1] === 'Checked' ? 'checked' : 'unchecked', checkbox: true };
  if ((m = text.match(RX.chose))) return { label: m[2] || m[1], value: m[1] };
  if ((m = text.match(RX.attached))) return { label: m[2], value: m[1] };
  if ((m = text.match(RX.cleared))) return { label: m[1], value: '(empty)' };
  return null;
}

const listLabels = (labels) => {
  const q = labels.map((l) => `"${l}"`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
};

export function stepsFromRecording(events) {
  const steps = [];
  let fields = null;

  const flush = () => {
    if (!fields) return;
    const boxes = fields.filter((f) => f.checkbox);
    const inputs = fields.filter((f) => !f.checkbox);
    if (inputs.length) {
      steps.push({
        action: inputs.length === 1 ? `Enter the "${inputs[0].label}"` : `Fill in ${listLabels(inputs.map((f) => f.label))}`,
        data: inputs.map((f) => `${f.label}: ${f.value}`).join('\n'),
        expected: inputs.length === 1 ? 'The field accepts the value' : 'All fields accept the values',
      });
    }
    boxes.forEach((b) => steps.push({
      action: `${b.value === 'checked' ? 'Tick' : 'Untick'} "${b.label}"`,
      data: '',
      expected: `"${b.label}" is ${b.value === 'checked' ? 'ticked' : 'unticked'}`,
    }));
    fields = null;
  };

  for (const ev of events) {
    if (ev.kind === 'error') continue;
    const text = ev.text || '';
    const f = ev.kind === 'input' ? fieldEntry(text) : null;
    if (f) {
      (fields || (fields = [])).push(f);
      continue;
    }
    flush();
    let m;
    if (ev.kind === 'navigate' && (m = text.match(RX.page))) {
      const last = steps[steps.length - 1];
      // a click that opened a page: use the new page as that click's expected result
      if (last && last.fromClick && !last.expectedSet) {
        last.expected = `"${m[1]}" page is displayed`;
        last.expectedSet = true;
        continue;
      }
      steps.push({ action: `Open the "${m[1]}" page`, data: steps.length === 0 && ev.url ? `URL: ${ev.url}` : '', expected: `"${m[1]}" page is displayed` });
      continue;
    }
    if (ev.kind === 'click' && (m = text.match(RX.clicked))) {
      const label = m[2];
      const kind = m[1] && m[1] !== 'element' ? ` ${m[1]}` : '';
      steps.push({ action: label ? `Click the "${label}"${kind}` : `Click the${kind || ' element'}`, data: '', expected: '', fromClick: true });
      continue;
    }
    steps.push({ action: text, data: '', expected: '' });
  }
  flush();

  // drop exact repeats (double clicks etc.)
  return steps.filter((s, i) => !(i > 0 && s.action === steps[i - 1].action && s.data === steps[i - 1].data))
    .map(({ action, data, expected }) => ({ action, data, expected }));
}

export function guessTitle(events) {
  const clicks = events.filter((e) => e.kind === 'click');
  const last = clicks[clicks.length - 1];
  const m = last && (last.text || '').match(RX.clicked);
  const page = events.find((e) => e.kind === 'navigate');
  const pm = page && (page.text || '').match(RX.page);
  if (m && m[2]) return m[2].slice(0, 90);
  return pm ? `Use the "${pm[1]}" page` : 'New test case';
}
