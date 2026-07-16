import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const descriptions = [
    ['modal_add_case_ioc.html', 'case.ioc.js', 'ioc'],
    ['modal_add_case_event.html', 'case.timeline.js', 'event'],
    ['modal_add_case_task.html', 'case.tasks.js', 'task'],
    ['modal_add_case_rfile.html', 'case.rfiles.js', 'evidence'],
];

test('case description forms use Milkdown without legacy preview controls', async () => {
    for (const [templateName, scriptName, prefix] of descriptions) {
        const template = await readFile(
            new URL(`source/app/blueprints/pages/case/templates/${templateName}`, root),
            'utf8',
        );
        const script = await readFile(new URL(`ui/src/pages/${scriptName}`, root), 'utf8');

        assert.doesNotMatch(template, new RegExp(`${prefix}_preview_button|icon-note`));
        assert.doesNotMatch(script, new RegExp(`edit_in_${prefix}_desc|preview_${prefix}_description`));
    }
});
