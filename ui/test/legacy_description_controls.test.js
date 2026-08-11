import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const overridesUrl = new URL('ui/src/lib/milkdown_overrides.css', root);
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

        assert.doesNotMatch(template, new RegExp(`${prefix}_preview_button|icon-note|md_description_field`));
        assert.doesNotMatch(script, new RegExp(`edit_in_${prefix}_desc|preview_${prefix}_description`));
        assert.doesNotMatch(script, new RegExp(`g_${prefix}_desc_editor\\.setOption\\("minLines", "10"\\)`));
    }
});

test('shared Milkdown fields use the same content padding as notes', async () => {
    const overrides = await readFile(overridesUrl, 'utf8');

    assert.match(
        overrides,
        /\.iris-markdown-editor \.milkdown \.ProseMirror,\s*\.iris-split \.milkdown \.ProseMirror\s*{\s*padding: 24px 28px 24px 84px;/,
    );
});
