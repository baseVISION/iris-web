import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const templateUrl = new URL('../../source/app/blueprints/pages/case/templates/case_notes_v2.html', import.meta.url);

test('note toolbar keeps its revision history control without a redundant overflow menu', async () => {
    const template = await readFile(templateUrl, 'utf8');

    assert.match(template, /onclick="load_note_revisions\(\)"/);
    assert.doesNotMatch(template, /noteQuickActionsToggle|note_quick_actions|fa-ellipsis-v/);
});
