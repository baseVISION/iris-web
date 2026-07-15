import assert from 'node:assert/strict';
import test from 'node:test';

import {
    kustoLanguage,
    milkdownCodeLanguages,
} from '../src/lib/milkdown_code_languages.js';

test('registers Kusto in the Milkdown code-block language list', () => {
    assert.equal(kustoLanguage.name, 'Kusto');
    assert.deepEqual(kustoLanguage.alias, ['kql', 'kusto']);
    assert.deepEqual(kustoLanguage.extensions, ['kql', 'kusto']);
    assert.ok(kustoLanguage.support);
    assert.equal(
        milkdownCodeLanguages.filter((language) => language.name === 'Kusto').length,
        1
    );
});

test('preserves the standard CodeMirror language list', () => {
    assert.ok(milkdownCodeLanguages.some((language) => language.name === 'JavaScript'));
    assert.ok(milkdownCodeLanguages.some((language) => language.name === 'Python'));
});
