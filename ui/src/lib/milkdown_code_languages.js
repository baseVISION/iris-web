import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

const kqlControlKeywords = new Set([
    'as',
    'asc',
    'by',
    'consume',
    'datatable',
    'desc',
    'distinct',
    'evaluate',
    'extend',
    'facet',
    'find',
    'fork',
    'from',
    'getschema',
    'in',
    'into',
    'invoke',
    'join',
    'let',
    'limit',
    'lookup',
    'make-series',
    'materialize',
    'mv-apply',
    'mv-expand',
    'on',
    'order',
    'parse',
    'parse-where',
    'partition',
    'print',
    'project',
    'project-away',
    'project-keep',
    'project-rename',
    'project-reorder',
    'range',
    'render',
    'sample',
    'sample-distinct',
    'search',
    'serialize',
    'sort',
    'step',
    'summarize',
    'take',
    'to',
    'top',
    'top-nested',
    'union',
    'where',
    'with',
]);

const kqlOperatorKeywords = new Set([
    'and',
    'between',
    'contains',
    'contains_cs',
    'endswith',
    'has',
    'has_cs',
    'hasprefix',
    'hassuffix',
    'in',
    'in~',
    'like',
    'matches',
    'not',
    'or',
    'regex',
    'startswith',
]);

const kqlBuiltInFunctions = new Set([
    'ago',
    'arg_max',
    'arg_min',
    'avg',
    'bin',
    'case',
    'coalesce',
    'count',
    'countif',
    'datetime',
    'dcount',
    'dcountif',
    'extract',
    'extract_all',
    'floor',
    'iff',
    'iif',
    'isempty',
    'isnotempty',
    'isnotnull',
    'isnull',
    'make_list',
    'make_set',
    'max',
    'min',
    'next',
    'now',
    'percentile',
    'percentiles',
    'prev',
    'replace',
    'replace_string',
    'row_number',
    'series_stats',
    'split',
    'strcat',
    'strlen',
    'substring',
    'sum',
    'sumif',
    'todatetime',
    'todouble',
    'toint',
    'tolong',
    'tolower',
    'toreal',
    'tostring',
    'totimespan',
    'toupper',
    'trim',
]);

function consumeKqlString(stream, state) {
    if (!state.stringQuote) {
        state.stringQuote = stream.next();
    }

    let escaped = false;
    while (!stream.eol()) {
        const ch = stream.next();
        if (escaped) {
            escaped = false;
        } else if (ch === '\\') {
            escaped = true;
        } else if (ch === state.stringQuote) {
            state.stringQuote = null;
            break;
        }
    }

    return 'string';
}

const kqlParser = {
    name: 'kusto',
    startState: () => ({ stringQuote: null }),
    token(stream, state) {
        if (state.stringQuote) {
            return consumeKqlString(stream, state);
        }

        if (stream.eatSpace()) {
            return null;
        }

        if (stream.match('//')) {
            stream.skipToEnd();
            return 'comment';
        }

        const ch = stream.peek();
        if (ch === '"' || ch === "'") {
            return consumeKqlString(stream, state);
        }

        if (stream.match(/^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|[dhms])?\b/i)) {
            return 'number';
        }

        if (stream.match(/^(?:==|!=|<=|>=|=~|!~|[|=+\-*/%<>])/)) {
            return 'operator';
        }

        const word = stream.match(/^[A-Za-z_][A-Za-z0-9_-]*(?:~)?/);
        if (word) {
            const value = word[0].toLowerCase();
            if (value === 'true' || value === 'false') {
                return 'bool';
            }
            if (value === 'null') {
                return 'null';
            }
            if (kqlOperatorKeywords.has(value)) {
                return 'operatorKeyword';
            }
            if (kqlControlKeywords.has(value)) {
                return 'keyword';
            }
            if (kqlBuiltInFunctions.has(value)) {
                return 'standardFunction';
            }
            return null;
        }

        stream.next();
        return null;
    },
    blankLine(state) {
        state.stringQuote = null;
    },
    tokenTable: {
        standardFunction: tags.standard(tags.function(tags.variableName)),
    },
    languageData: {
        commentTokens: { line: '//' },
    },
};

export const kustoLanguage = LanguageDescription.of({
    name: 'Kusto',
    alias: ['kql'],
    extensions: ['kql', 'kusto'],
    support: new LanguageSupport(StreamLanguage.define(kqlParser)),
});

export const milkdownCodeLanguages = [...languages, kustoLanguage];
