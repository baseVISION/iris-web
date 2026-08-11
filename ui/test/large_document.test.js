import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getLargeDocumentReason,
    LARGE_DOCUMENT_MAX_CHARS,
    LARGE_DOCUMENT_MAX_LINE_CHARS,
} from '../src/lib/large_document.js';

test('keeps ordinary notes in the rich editor', () => {
    assert.equal(getLargeDocumentReason('# Findings\n\nNothing unusual.'), null);
});

test('uses source mode when the document exceeds the size budget', () => {
    assert.equal(
        getLargeDocumentReason('A'.repeat(LARGE_DOCUMENT_MAX_CHARS + 1)),
        'document-size'
    );
});

test('uses source mode for a pathological line in an otherwise small note', () => {
    const markdown = `Before\n${'A'.repeat(LARGE_DOCUMENT_MAX_LINE_CHARS + 1)}\nAfter`;

    assert.equal(getLargeDocumentReason(markdown), 'line-length');
});

test('accepts documents exactly at both budgets', () => {
    assert.equal(getLargeDocumentReason('A'.repeat(LARGE_DOCUMENT_MAX_LINE_CHARS)), null);
    assert.equal(
        getLargeDocumentReason(`${'A'.repeat(LARGE_DOCUMENT_MAX_LINE_CHARS - 1)}\n`.repeat(10)),
        null
    );
});
