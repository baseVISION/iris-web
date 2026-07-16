import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const templateUrl = new URL('../../source/app/blueprints/pages/case/templates/case_notes_v2.html', import.meta.url);

test('note overflow menu always exposes revision history', async () => {
    const template = await readFile(templateUrl, 'utf8');

    assert.match(template, /id="noteQuickActionsToggle"[^>]*data-toggle="dropdown"/);
    assert.match(template, /id="note_quick_actions"[^>]*aria-labelledby="noteQuickActionsToggle"/);
    assert.match(template, /onclick="load_note_revisions\(\);return false;"[^>]*>.*Revision history/s);
});
