// IRIS Milkdown (Crepe) WYSIWYG note editor — separate ESM entry.
// Loaded as <script type="module"> from case_notes_v2.html; exposes window.IrisMilkdown
// for the classic case.notes.js to drive. base:'/static/' in vite.config makes chunk
// URLs resolve correctly. Theme CSS is emitted to /static/assets/css/milkdown_editor.css
// and must be linked manually in the template.
import { Crepe } from '@milkdown/crepe';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { editorViewCtx, parserCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { Slice } from '@milkdown/kit/prose/model';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import '../lib/milkdown_overrides.css';

/* ---------------------------------------------------------------------------
 * Image-syntax adapter (IRIS <-> Milkdown), pragmatic v1.
 *
 * IRIS stores standalone images as:   ![name](url =W%x*)        (showdown parseImgDimensions)
 * Milkdown block image serializes as: ![<ratio>](url "caption") (alt = height ratio)
 *
 * Because pasted screenshots are inserted on their own line they become Milkdown
 * BLOCK images (they carry a resize ratio). For full-width images ratio≈width fraction,
 * so W% == round(ratio*100). We carry the IRIS "name" through Milkdown's caption slot so
 * it round-trips. Inline images (image among text) have no ratio and are left as plain
 * ![alt](url) without an invented size.
 *
 * Codex review #2: do NOT run a naive whole-document regex — protect fenced code blocks.
 * ------------------------------------------------------------------------- */

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

const kusto = LanguageDescription.of({
    name: 'Kusto',
    alias: ['kql', 'kusto'],
    extensions: ['kql', 'kusto'],
    support: new LanguageSupport(StreamLanguage.define(kqlParser)),
});

const COLLAB_COLORS = [
    '#0f766e',
    '#2563eb',
    '#7c3aed',
    '#c2410c',
    '#be123c',
    '#047857',
    '#4338ca',
    '#b45309',
    '#0369a1',
    '#a21caf',
];

function hashString(value) {
    let hash = 0;
    const str = value || 'IRIS';
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function normalizeCollabUser(user) {
    const rawName = user && user.name ? String(user.name).trim() : '';
    const name = rawName || 'IRIS user';
    const rawColor = user && user.color ? String(user.color).trim() : '';
    const color = /^#[0-9a-fA-F]{6}$/.test(rawColor)
        ? rawColor
        : COLLAB_COLORS[hashString(name) % COLLAB_COLORS.length];
    return { name, color };
}

function getCollabServerUrl(config) {
    if (config && config.serverUrl) {
        return config.serverUrl;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/collab`;
}

// Run `fn` only on the parts of the markdown that are OUTSIDE fenced code blocks
// (``` ... ``` or ~~~ ... ~~~). Inline code spans rarely contain image syntax and are
// left alone for v1 simplicity.
function transformOutsideCode(md, fn) {
    const fence = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = fence.exec(md)) !== null) {
        out += fn(md.slice(last, m.index));
        out += m[0]; // code block, untouched
        last = m.index + m[0].length;
    }
    out += fn(md.slice(last));
    return out;
}

// Parse the IRIS size token's WIDTH into a percent (integer) or null if not a percentage.
// Accepts widths like "100%", "50%", bare "*", "300" (px -> null, can't convert without natural size).
function widthTokenToPercent(w) {
    if (!w) return null;
    if (w === '*') return null;
    if (w.endsWith('%')) {
        const n = parseInt(w.slice(0, -1), 10);
        return Number.isFinite(n) ? n : null;
    }
    return null; // px / bare number: no reliable %-of-page mapping in v1
}

// IRIS markdown -> markdown Crepe can parse (size encoded as block-image ratio in alt).
// Every image is normalised so its name survives in the caption slot; the width % (if any)
// becomes the block ratio (1.00 when no size, i.e. full width). Supports "double" and 'single'
// quoted titles. NOTE: URLs containing literal spaces or unbalanced parentheses are not
// handled (datastore URLs never contain those); such exotic links are left to Milkdown as-is.
export function irisToMilkdown(md) {
    if (!md) return md;
    const IMG = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)\s*(?:=([0-9]+%?|\*)(?:x([0-9]+%?|\*))?)?\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;
    return transformOutsideCode(md, (seg) => seg.replace(IMG,
        (full, alt, url, w /*width*/, _h /*height*/, dqTitle, sqTitle) => {
            const title = dqTitle != null ? dqTitle : sqTitle;
            const pct = widthTokenToPercent(w);
            const ratio = pct === null ? 1 : Math.max(0.01, pct / 100);
            const cap = (title || alt || '').replace(/"/g, '');
            return `![${ratio.toFixed(2)}](${url}${cap ? ` "${cap}"` : ''})`;
        }));
}

// markdown from Crepe.getMarkdown() -> IRIS canonical markdown.
// Block images come back as ![<ratio>](url "caption"); restore the name and encode a width
// suffix ONLY when the image is not full width (ratio != 100%), so we never add a spurious
// size to images that were never resized. Inline / user-authored images are left untouched.
export function milkdownToIris(md) {
    if (!md) return md;
    const IMG = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)\s*(?:"([^"]*)")?\s*\)/g;
    return transformOutsideCode(md, (seg) => seg.replace(IMG,
        (full, alt, url, title) => {
            // Only block images carry a purely-numeric ratio in alt.
            if (!/^[0-9]*\.?[0-9]+$/.test(alt.trim())) {
                return full; // inline / user-authored image: leave as-is
            }
            const ratio = parseFloat(alt);
            if (!Number.isFinite(ratio)) return full;
            const name = (title || '').replace(/[[\]]/g, '');
            const pct = Math.max(1, Math.round(ratio * 100));
            if (pct === 100) {
                // Full width == IRIS default: store WITHOUT a size suffix.
                return `![${name}](${url})`;
            }
            return `![${name}](${url} =${pct}%x*)`;
        }));
}

/* ---------------------------------------------------------------------------
 * Image upload: route through IRIS's existing extension-preserving path
 * (window globals defined by datastore.js / common.js on the notes page).
 * ------------------------------------------------------------------------- */
function uploadThroughIris(file) {
    return new Promise((resolve, reject) => {
        // upload_interactive_data() only invokes its callback on success (no .fail path),
        // so guard against a hung promise with a timeout and single-settle latch.
        let settled = false;
        const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(t); fn(arg); } };
        const t = setTimeout(() => finish(reject, new Error('image upload timed out')), 120000);
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const ext = window.get_extension_from_mime(file.type);
                const filename = window.random_filename(25) + '.' + ext;
                window.upload_interactive_data(e.target.result, filename, (data) => {
                    if (data && data.data && data.data.file_url) {
                        finish(resolve, data.data.file_url + window.case_param());
                    } else {
                        finish(reject, new Error('upload did not return a file_url'));
                    }
                });
            } catch (err) {
                finish(reject, err);
            }
        };
        reader.onerror = () => finish(reject, new Error('failed to read pasted file'));
        reader.readAsDataURL(file);
    });
}

/* --------------------------------------------------------------------------- */
let _crepe = null;
let _onChange = null;
let _collabState = null;
let _collabStatus = null;

const COLLAB_TEMPLATE_CLAIM_DELAY_MS = 500;
const COLLAB_TEMPLATE_STALE_CLAIM_MS = 5000;
const COLLAB_TEMPLATE_META_MAP = 'irisTemplateSeed';
const COLLAB_TEMPLATE_CLAIM_KEY = 'prosemirrorTemplateClaim';
const COLLAB_TEMPLATE_SEEDED_KEY = 'prosemirrorTemplateSeeded';
const COLLAB_AWARENESS_BOOTSTRAP_RECHECK_MS = [250, 1000, 2000, 3500];

function updateCollabStatus(status) {
    _collabStatus = status || null;
    if (_collabState && typeof _collabState.onStatus === 'function') {
        try { _collabState.onStatus(_collabStatus); } catch (e) { /* noop */ }
    }
}

function getCollabConnectionStatus(state) {
    if (!state || !state.provider) {
        return null;
    }

    const { provider } = state;
    if (
        state.offline
        || provider.shouldConnect === false
        || state.rawStatus === 'closed'
        || state.rawStatus === 'offline'
    ) {
        return 'offline';
    }
    if (provider.wsconnected && provider.synced) {
        return 'live';
    }
    if (state.rawStatus === 'connecting' || provider.wsconnecting) {
        return 'syncing';
    }
    if (state.rawStatus === 'disconnected') {
        return state.hasConnected ? 'reconnecting' : 'syncing';
    }
    if (provider.wsconnected) {
        return 'syncing';
    }
    return state.hasConnected ? 'reconnecting' : 'syncing';
}

function updateCollabConnectionStatus(state) {
    updateCollabStatus(getCollabConnectionStatus(state));
}

function getCollabAwarenessUsers() {
    if (!_collabState || !_collabState.provider || !_collabState.provider.awareness) {
        return [];
    }

    const users = [];
    const localClientID = getCollabLocalClientID(_collabState);
    try {
        _collabState.provider.awareness.getStates().forEach((state, clientID) => {
            if (!state || !state.user) {
                return;
            }
            const user = normalizeCollabUser(state && state.user);
            users.push({
                clientID,
                name: user.name,
                color: user.color,
                isSelf: clientID === localClientID,
            });
        });
    } catch (e) {
        return [];
    }
    return users;
}

function getCollabLocalClientID(state) {
    if (!state) {
        return null;
    }
    if (state.provider && state.provider.awareness && state.provider.awareness.clientID !== undefined) {
        return state.provider.awareness.clientID;
    }
    return state.ydoc ? state.ydoc.clientID : null;
}

function updateCollabAwareness() {
    if (_collabState && typeof _collabState.onAwareness === 'function') {
        try { _collabState.onAwareness(getCollabAwarenessUsers()); } catch (e) { /* noop */ }
    }
}

function setLocalCollabAwarenessUser(state) {
    if (!state || !state.provider || !state.provider.awareness || !state.user) {
        return;
    }

    try {
        const awareness = state.provider.awareness;
        const localState = awareness.getLocalState ? awareness.getLocalState() : null;
        awareness.setLocalState({
            ...(localState || {}),
            user: state.user,
        });
    } catch (e) {
        /* noop */
    }
}

function scheduleCollabAwarenessRefresh(state, delay = 0) {
    if (!state || !Array.isArray(state.awarenessTimers)) {
        return;
    }

    const timer = setTimeout(() => {
        state.awarenessTimers = state.awarenessTimers.filter((item) => item !== timer);
        if (_collabState !== state || state.offline) {
            return;
        }
        setLocalCollabAwarenessUser(state);
        updateCollabAwareness();
    }, delay);
    state.awarenessTimers.push(timer);
}

function installCollabAwarenessBootstrap(state) {
    if (!state) {
        return () => {};
    }

    scheduleCollabAwarenessRefresh(state, 0);
    COLLAB_AWARENESS_BOOTSTRAP_RECHECK_MS.forEach((delay) => {
        scheduleCollabAwarenessRefresh(state, delay);
    });

    return () => {
        if (!Array.isArray(state.awarenessTimers)) {
            return;
        }
        state.awarenessTimers.forEach((timer) => clearTimeout(timer));
        state.awarenessTimers = [];
    };
}

function installCollabUnloadAwarenessCleanup(state) {
    if (!state || typeof window === 'undefined') {
        return () => {};
    }

    const clearLocalAwareness = () => {
        if (_collabState !== state || !state.provider || !state.provider.awareness) {
            return;
        }
        try { state.provider.awareness.setLocalState(null); } catch (e) { /* noop */ }
    };

    window.addEventListener('pagehide', clearLocalAwareness);
    window.addEventListener('beforeunload', clearLocalAwareness);
    return () => {
        window.removeEventListener('pagehide', clearLocalAwareness);
        window.removeEventListener('beforeunload', clearLocalAwareness);
    };
}

function getCollabOtherAwarenessUserCount() {
    if (!_collabState || !_collabState.provider || !_collabState.provider.awareness) {
        return 0;
    }

    const localClientID = getCollabLocalClientID(_collabState);
    let count = 0;
    try {
        _collabState.provider.awareness.getStates().forEach((state, clientID) => {
            if (clientID !== localClientID && state && state.user) {
                count += 1;
            }
        });
    } catch (e) {
        return 0;
    }
    return count;
}

function destroyCollabState() {
    if (!_collabState) {
        _collabStatus = null;
        return;
    }

    const { service, provider, ydoc, cleanupFns } = _collabState;
    _collabState.offline = true;
    updateCollabConnectionStatus(_collabState);
    if (Array.isArray(cleanupFns)) {
        cleanupFns.forEach((fn) => {
            try { fn(); } catch (e) { /* noop */ }
        });
    }
    try { if (provider && provider.awareness) provider.awareness.setLocalState(null); } catch (e) { /* noop */ }
    try { if (service) service.disconnect(); } catch (e) { /* noop */ }
    try { if (provider) provider.destroy(); } catch (e) { /* noop */ }
    try { if (ydoc) ydoc.destroy(); } catch (e) { /* noop */ }
    _collabState = null;
    updateCollabStatus(null);
}

function getCollabXmlFragment(ydoc) {
    return ydoc ? ydoc.getXmlFragment('prosemirror') : null;
}

function isCollabXmlFragmentEmpty(fragment) {
    return !!fragment && fragment.length === 0;
}

function getCollabAwarenessClientIds(provider, ydoc) {
    const ids = new Set();
    if (ydoc) {
        ids.add(ydoc.clientID);
    }
    try {
        if (provider && provider.awareness) {
            provider.awareness.getStates().forEach((_state, id) => ids.add(id));
        }
    } catch (e) {
        /* noop */
    }
    return ids;
}

function installSyncedTemplateSeed(state, initialMarkdown) {
    const { provider, ydoc, service } = state;
    const fragment = getCollabXmlFragment(ydoc);
    const meta = ydoc.getMap(COLLAB_TEMPLATE_META_MAP);
    const template = irisToMilkdown(initialMarkdown || '');
    let seedDone = false;
    let claimTimer = null;

    const clearClaimTimer = () => {
        if (claimTimer) {
            clearTimeout(claimTimer);
            claimTimer = null;
        }
    };

    const stillCurrent = () => _collabState === state && !seedDone;

    const finishWithoutSeed = () => {
        seedDone = true;
        clearClaimTimer();
    };

    const claimIsStale = (claim) => {
        if (!claim || typeof claim !== 'object') {
            return false;
        }
        const claimedAt = Number(claim.claimedAt) || 0;
        if (Date.now() - claimedAt <= COLLAB_TEMPLATE_STALE_CLAIM_MS) {
            return false;
        }
        return !getCollabAwarenessClientIds(provider, ydoc).has(claim.clientID);
    };

    const finalizeSeedClaim = () => {
        claimTimer = null;
        if (!stillCurrent() || provider.synced !== true) {
            return;
        }
        if (!isCollabXmlFragmentEmpty(fragment)) {
            finishWithoutSeed();
            return;
        }

        const claim = meta.get(COLLAB_TEMPLATE_CLAIM_KEY);
        if (!claim || claim.clientID !== ydoc.clientID) {
            return;
        }

        service.applyTemplate(template, () => isCollabXmlFragmentEmpty(fragment));
        meta.set(COLLAB_TEMPLATE_SEEDED_KEY, {
            clientID: ydoc.clientID,
            seededAt: Date.now(),
        });
        seedDone = true;
    };

    const trySeedAfterSync = (synced) => {
        if (synced !== true || !stillCurrent()) {
            return;
        }
        if (!isCollabXmlFragmentEmpty(fragment)) {
            finishWithoutSeed();
            return;
        }
        if (meta.get(COLLAB_TEMPLATE_SEEDED_KEY)) {
            finishWithoutSeed();
            return;
        }

        const claim = meta.get(COLLAB_TEMPLATE_CLAIM_KEY);
        if (!claim || claimIsStale(claim)) {
            meta.set(COLLAB_TEMPLATE_CLAIM_KEY, {
                clientID: ydoc.clientID,
                claimedAt: Date.now(),
            });
        }

        clearClaimTimer();
        claimTimer = setTimeout(finalizeSeedClaim, COLLAB_TEMPLATE_CLAIM_DELAY_MS);
    };

    provider.on('sync', trySeedAfterSync);
    if (provider.synced === true) {
        setTimeout(() => trySeedAfterSync(true), 0);
    }

    return () => {
        clearClaimTimer();
        try { provider.off('sync', trySeedAfterSync); } catch (e) { /* noop */ }
    };
}

function readMilkdownMarkdown() {
    if (!_crepe) {
        return null;
    }

    let markdown = null;
    _crepe.editor.action((ctx) => {
        const serializer = ctx.get(serializerCtx);
        if (_collabState && _collabState.ydoc) {
            const schema = ctx.get(schemaCtx);
            const fragment = _collabState.ydoc.getXmlFragment('prosemirror');
            markdown = serializer(yXmlFragmentToProseMirrorRootNode(fragment, schema));
            return;
        }

        const view = ctx.get(editorViewCtx);
        markdown = serializer(view.state.doc);
    });
    return markdown;
}

window.IrisMilkdown = {
    irisToMilkdown,
    milkdownToIris,

    // Mount Crepe into rootSelector with IRIS markdown. onChange(markdownInIrisForm) fires
    // (debounced by caller if desired) on edits.
    async create(rootSelector, irisMarkdown, onChange, options = {}) {
        await this.destroy();
        _onChange = typeof onChange === 'function' ? onChange : null;
        const collabConfig = options && options.collab ? options.collab : null;
        // Build + create the editor locally and only publish it to `_crepe` once it is
        // fully created, so isActive()/getMarkdown() never see a half-initialised editor.
        const crepe = new Crepe({
            root: rootSelector,
            defaultValue: irisToMilkdown(irisMarkdown || ''),
            featureConfigs: {
                [Crepe.Feature.CodeMirror]: {
                    languages: [...languages, kusto],
                },
                [Crepe.Feature.ImageBlock]: {
                    onUpload: uploadThroughIris,
                },
            },
        });

        if (collabConfig) {
            crepe.editor.use(collab);
        }

        await crepe.create();
        _crepe = crepe;

        if (collabConfig) {
            const room = String(collabConfig.room || '').trim();
            if (!room) {
                throw new Error('Missing Milkdown collab room');
            }

            const ydoc = new Y.Doc();
            const provider = new WebsocketProvider(getCollabServerUrl(collabConfig), room, ydoc);
            const user = normalizeCollabUser(collabConfig.user);
            provider.awareness.setLocalStateField('user', user);

            let service = null;
            _crepe.editor.action((ctx) => {
                service = ctx.get(collabServiceCtx);
            });

            service
                .bindDoc(ydoc)
                .setAwareness(provider.awareness)
                .connect();

            _collabState = {
                room,
                ydoc,
                provider,
                service,
                user,
                cleanupFns: [],
                awarenessTimers: [],
                rawStatus: provider.wsconnected ? 'connected' : 'connecting',
                hasConnected: provider.wsconnected === true,
                offline: false,
                onStatus: typeof collabConfig.onStatus === 'function' ? collabConfig.onStatus : null,
                onAwareness: typeof collabConfig.onAwareness === 'function' ? collabConfig.onAwareness : null,
            };
            _collabState.cleanupFns.push(installSyncedTemplateSeed(_collabState, irisMarkdown || ''));

            const handleStatus = ({ status }) => {
                if (!_collabState || _collabState.provider !== provider) {
                    return;
                }
                _collabState.rawStatus = status;
                if (status === 'connected') {
                    _collabState.hasConnected = true;
                    setLocalCollabAwarenessUser(_collabState);
                    updateCollabAwareness();
                }
                updateCollabConnectionStatus(_collabState);
            };
            const handleSync = (synced) => {
                if (!_collabState || _collabState.provider !== provider) {
                    return;
                }
                if (synced === true) {
                    setLocalCollabAwarenessUser(_collabState);
                }
                updateCollabConnectionStatus(_collabState);
                updateCollabAwareness();
            };
            const handleAwarenessChange = () => updateCollabAwareness();
            const handleAwarenessUpdate = (changes) => {
                if (!_collabState || _collabState.provider !== provider) {
                    return;
                }
                updateCollabAwareness();

                const localClientID = getCollabLocalClientID(_collabState);
                const added = changes && Array.isArray(changes.added) ? changes.added : [];
                if (added.some((clientID) => clientID !== localClientID)) {
                    scheduleCollabAwarenessRefresh(_collabState, 0);
                }
            };

            provider.on('status', handleStatus);
            provider.on('sync', handleSync);
            provider.awareness.on('change', handleAwarenessChange);
            provider.awareness.on('update', handleAwarenessUpdate);
            _collabState.cleanupFns.push(() => {
                try { provider.off('status', handleStatus); } catch (e) { /* noop */ }
                try { provider.off('sync', handleSync); } catch (e) { /* noop */ }
                try { provider.awareness.off('change', handleAwarenessChange); } catch (e) { /* noop */ }
                try { provider.awareness.off('update', handleAwarenessUpdate); } catch (e) { /* noop */ }
            });
            _collabState.cleanupFns.push(installCollabAwarenessBootstrap(_collabState));
            _collabState.cleanupFns.push(installCollabUnloadAwarenessCleanup(_collabState));
            updateCollabConnectionStatus(_collabState);
            updateCollabAwareness();
        }

        if (_onChange) {
            _crepe.on((listener) => {
                listener.markdownUpdated((_ctx, markdown) => {
                    try { _onChange(milkdownToIris(markdown)); } catch (e) { /* noop */ }
                });
            });
        }
        return true;
    },

    // Current content as IRIS-canonical markdown (this is what save_note must persist).
    getMarkdown() {
        const markdown = readMilkdownMarkdown();
        return markdown !== null ? milkdownToIris(markdown) : null;
    },

    setMarkdown(irisMarkdown) {
        if (!_crepe) {
            return false;
        }

        _crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const parser = ctx.get(parserCtx);
            const doc = parser(irisToMilkdown(irisMarkdown || ''));
            if (!doc) {
                return;
            }

            const tr = view.state.tr.replace(
                0,
                view.state.doc.content.size,
                new Slice(doc.content, 0, 0)
            );
            tr.setMeta('addToHistory', false);
            view.dispatch(tr);
        });
        return true;
    },

    isActive() {
        return _crepe !== null;
    },

    isCollabActive() {
        return _collabState !== null;
    },

    getCollabStatus() {
        return _collabStatus;
    },

    getCollabAwarenessUsers() {
        return getCollabAwarenessUsers();
    },

    getCollabAwarenessStateCount() {
        if (!_collabState || !_collabState.provider || !_collabState.provider.awareness) {
            return 0;
        }
        try {
            let count = 0;
            _collabState.provider.awareness.getStates().forEach((state) => {
                if (state && state.user) {
                    count += 1;
                }
            });
            return count;
        } catch (e) {
            return 0;
        }
    },

    isLastCollabClient() {
        return getCollabOtherAwarenessUserCount() <= 0;
    },

    async destroy() {
        destroyCollabState();
        if (_crepe) {
            try { await _crepe.destroy(); } catch (e) { /* noop */ }
            _crepe = null;
            _onChange = null;
        }
    },
};

window.dispatchEvent(new CustomEvent('iris-milkdown-ready'));
