import assert from 'node:assert/strict';
import test from 'node:test';

import { irisToMilkdown, milkdownToIris } from '../src/pages/milkdown_shared.js';

test('round-trips IRIS image dimensions through Milkdown', () => {
    const iris = 'Before\n\n![Screenshot](/datastore/file.png =45%x*)\n\nAfter';
    const milkdown = irisToMilkdown(iris);

    assert.equal(milkdown, 'Before\n\n![0.45](/datastore/file.png "Screenshot")\n\nAfter');
    assert.equal(milkdownToIris(milkdown), iris);
});

test('does not add a size suffix to full-width images', () => {
    const iris = '![Evidence](/datastore/evidence.png)';

    assert.equal(milkdownToIris(irisToMilkdown(iris)), iris);
});

test('leaves image-like syntax inside fenced code unchanged', () => {
    const markdown = [
        '```markdown',
        '![Example](/file.png =25%x*)',
        '```',
        '',
        '![Real](/real.png =50%x*)',
    ].join('\n');
    const converted = irisToMilkdown(markdown);

    assert.match(converted, /!\[Example\]\(\/file\.png =25%x\*\)/);
    assert.match(converted, /!\[0\.50\]\(\/real\.png "Real"\)/);
    assert.equal(milkdownToIris(converted), markdown);
});

test('leaves ordinary user-authored images unchanged on serialization', () => {
    const markdown = '![an ordinary alt](/image.png "title")';

    assert.equal(milkdownToIris(markdown), markdown);
});
