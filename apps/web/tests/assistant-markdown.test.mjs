import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAssistantMarkdown } from '../src/lib/assistantMarkdown.ts';

test('repairs dense model Markdown without changing its words', () => {
  const dense =
    'Intro. --- ### Alerts 1. **LinkedIn - New device** - Received: Today - Summary: Verify it. 2. **Calendar invite** - Note: Starts soon. --- ### Actions - **Verify your device**. - **Review the invite**. Let me know if you need help.';

  const normalized = normalizeAssistantMarkdown(dense);

  assert.match(normalized, /Intro\.\n\n---\n\n### Alerts/);
  assert.match(normalized, /### Alerts\n\n1\. \*\*LinkedIn - New device\*\*/);
  assert.match(normalized, /\n   - Received: Today/);
  assert.match(normalized, /\n   - Summary: Verify it\./);
  assert.match(normalized, /\n\n2\. \*\*Calendar invite\*\*/);
  assert.match(normalized, /### Actions\n- \*\*Verify your device\*\*/);
  assert.match(normalized, /\n\nLet me know if you need help\.$/);
});

test('preserves already formatted prose and Markdown', () => {
  const formatted = '## Summary\n\nA normal paragraph.\n\n- First item\n- Second item';
  assert.equal(normalizeAssistantMarkdown(formatted), formatted);
});
