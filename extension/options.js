import { LANGUAGES, DEFAULT_MODEL, getSettings, saveSettings, toast } from './lib/common.js';
import { testConnection } from './lib/ai.js';

const $ = (id) => document.getElementById(id);
const s = await getSettings();

$('language').innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('apiKey').value = s.apiKey;
$('model').value = s.model || DEFAULT_MODEL;
$('language').value = s.language;
$('maskInputs').checked = s.maskInputs;

const read = () => ({
  apiKey: $('apiKey').value.trim(),
  model: $('model').value.trim() || DEFAULT_MODEL,
  language: $('language').value,
  maskInputs: $('maskInputs').checked,
});

$('save').addEventListener('click', async () => { await saveSettings(read()); toast('Settings saved'); });
$('maskInputs').addEventListener('change', () => saveSettings({ maskInputs: $('maskInputs').checked }));

$('test').addEventListener('click', async () => {
  const cfg = read();
  const out = $('test-result');
  if (!cfg.apiKey) { out.textContent = 'Enter a key first.'; return; }
  out.innerHTML = '<span class="spinner"></span>Testing…';
  try {
    await testConnection(cfg);
    await saveSettings(cfg);
    out.innerHTML = '<span style="color:var(--ok)">✓ Connected. Settings saved.</span>';
  } catch (e) {
    out.innerHTML = `<span style="color:var(--danger)">✗ ${e.message.replace(/</g, '&lt;')}</span>`;
  }
});
