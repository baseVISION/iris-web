import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getLargeDocumentReason } from '../lib/large_document.js';

const SOURCE_SYNC_MS = 250;
const MIN_PANE_WIDTH = 180;
const NARROW_BREAKPOINT = 900;
const COLLAB_STATE_MIN_MS = 3000;
const COLLAB_STATE_CLASSES = [
    'collab-syncing',
    'collab-live',
    'collab-reconnecting',
    'collab-offline',
];

function resolveRef(ref) {
    if (typeof ref === 'string') {
        return document.querySelector(ref);
    }
    return ref || null;
}

function waitForMilkdown() {
    if (window.IrisMilkdown) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        window.addEventListener('iris-milkdown-ready', resolve, { once: true });
    });
}

function ensurePaneMount(pane, className) {
    let mount = pane.querySelector(`.${className}`);
    if (!mount) {
        mount = document.createElement('div');
        mount.className = className;
        pane.appendChild(mount);
    }
    return mount;
}

function getInitials(name) {
    const parts = String(name || 'IRIS user')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const initials = parts.slice(0, 2).map((part) => part[0] ? part[0].toUpperCase() : '').join('');
    return initials || 'IU';
}

function normalizeCollabStatus(status) {
    if (status === 'live' || status === 'reconnecting' || status === 'offline' || status === 'syncing') {
        return status;
    }
    if (status === 'closed') {
        return 'offline';
    }
    if (status === 'connected') {
        return 'live';
    }
    if (status === 'disconnected') {
        return 'reconnecting';
    }
    return 'syncing';
}

async function destroyMilkdownIfActive() {
    const milkdown = window.IrisMilkdown;
    if (!milkdown || typeof milkdown.destroy !== 'function') {
        return;
    }

    try {
        if (typeof milkdown.isActive === 'function' && !milkdown.isActive()) {
            return;
        }
        await milkdown.destroy();
    } catch (error) {
        console.error('Failed to destroy IrisMilkdown', error);
    }
}

class SplitEditor {
    constructor() {
        this.container = null;
        this.sourcePane = null;
        this.wysiwygPane = null;
        this.divider = null;
        this.viewToggle = null;
        this.sourceView = null;
        this.sourceTimer = null;
        this.pendingSourceMd = null;
        this.origin = null;
        this.onChange = null;
        this.destroyed = false;
        this.cleanupFns = [];
        this.silentMarkdown = null;
        this.collabActive = false;
        this.shell = null;
        this.collabBar = null;
        this.collabAvatars = null;
        this.collabStatusDot = null;
        this.collabStatusText = null;
        this.collabPresenceTarget = null;
        this.collabSourceBadge = null;
        this.collabUsers = [];
        this.collabState = null;
        this.collabStateSince = 0;
        this.pendingCollabState = null;
        this.collabStateTimer = null;
        this.sourceEditabilityCompartment = new Compartment();
        this.sourceReadOnly = false;
        this.sourceScrollFrame = null;
        this.sourceOnlyReason = null;
        this.sourceOnlyUiInstalled = false;
    }

    withOrigin(origin, fn) {
        const previous = this.origin;
        this.origin = origin;
        try {
            return fn();
        } finally {
            this.origin = previous;
        }
    }

    async create({ container, sourcePane, wysiwygPane, divider, viewToggle, initialMarkdown = '', onChange, collab = null }) {
        this.container = resolveRef(container);
        this.sourcePane = resolveRef(sourcePane);
        this.wysiwygPane = resolveRef(wysiwygPane);
        this.divider = resolveRef(divider);
        this.viewToggle = resolveRef(viewToggle);
        this.onChange = typeof onChange === 'function' ? onChange : null;
        this.sourceOnlyReason = getLargeDocumentReason(initialMarkdown);
        this.collabActive = !!collab && !this.sourceOnlyReason;

        if (!this.container || !this.sourcePane || !this.wysiwygPane) {
            throw new Error('Missing split editor root elements');
        }
        this.shell = this.container.closest('.iris-split-shell') || this.container;

        const sourceMount = ensurePaneMount(this.sourcePane, 'iris-split-source-mount');
        const wysiwygMount = ensurePaneMount(this.wysiwygPane, 'iris-split-preview-mount');
        sourceMount.innerHTML = '';
        wysiwygMount.innerHTML = '';

        this.wireSplitUi();
        let collabOptions = null;
        if (!this.sourceOnlyReason) {
            await waitForMilkdown();
            if (this.destroyed) {
                return this;
            }

            collabOptions = this.getCollabOptions(collab);
            try {
                await window.IrisMilkdown.create(wysiwygMount, initialMarkdown || '', (md) => {
                    this.handleMilkdownChange(md);
                }, { collab: collabOptions });
            } catch (error) {
                console.error('Failed to initialize Milkdown; using source mode', error);
                await destroyMilkdownIfActive();
                this.sourceOnlyReason = 'initialization-error';
                this.collabActive = false;
                collabOptions = null;
            }

            if (this.destroyed) {
                await destroyMilkdownIfActive();
                return this;
            }
        }

        if (this.sourceOnlyReason) {
            this.installSourceOnlyUi();
        }

        this.sourceReadOnly = this.computeSourceReadOnly();
        const sourceExtensions = [
            basicSetup,
            this.sourceEditabilityCompartment.of(this.getSourceEditabilityExtensions(this.sourceReadOnly)),
            EditorView.updateListener.of((update) => this.handleSourceUpdate(update)),
            EditorView.theme({
                '&': { height: '100%' },
                '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
            }),
        ];
        if (!this.sourceOnlyReason) {
            sourceExtensions.splice(1, 0, markdown(), EditorView.lineWrapping);
        }
        this.sourceView = new EditorView({
            parent: sourceMount,
            state: EditorState.create({
                doc: initialMarkdown || '',
                extensions: sourceExtensions,
            }),
        });

        if (this.collabActive) {
            this.installCollabUi(collabOptions || {});
            this.handleCollabStatus(window.IrisMilkdown.getCollabStatus());
            if (typeof window.IrisMilkdown.getCollabAwarenessUsers === 'function') {
                this.handleCollabAwareness(window.IrisMilkdown.getCollabAwarenessUsers());
            }
            this.updateSourceReadOnly();
        }

        return this;
    }

    getCollabOptions(collab) {
        if (!collab) {
            return null;
        }

        const originalStatus = collab.onStatus;
        const originalAwareness = collab.onAwareness;
        return {
            ...collab,
            onStatus: (status) => {
                if (typeof originalStatus === 'function') {
                    originalStatus(status);
                }
                this.handleCollabStatus(status);
            },
            onAwareness: (users) => {
                if (typeof originalAwareness === 'function') {
                    originalAwareness(users);
                }
                this.handleCollabAwareness(users);
            },
        };
    }

    handleSourceUpdate(update) {
        if (!update.docChanged || this.origin === 'milkdown' || this.isSourceReadOnly()) {
            return;
        }
        this.pendingSourceMd = update.state.doc.toString();
        if (this.sourceTimer) {
            clearTimeout(this.sourceTimer);
        }
        this.sourceTimer = setTimeout(() => {
            this.sourceTimer = null;
            this.applyPendingSource();
        }, SOURCE_SYNC_MS);
    }

    handleMilkdownChange(md) {
        const markdown = md || '';
        if (!this.sourceView) {
            return;
        }

        if (this.silentMarkdown !== null && markdown === this.silentMarkdown) {
            if (this.sourceView.state.doc.toString() !== markdown) {
                this.withOrigin('milkdown', () => this.replaceSourceDoc(markdown));
            }
            this.silentMarkdown = null;
            return;
        }

        if (
            this.origin === 'source' ||
            (!this.isSourceReadOnly() && this.isSourceFocused()) ||
            this.sourceView.state.doc.toString() === markdown
        ) {
            this.emitChange(markdown);
            return;
        }

        this.withOrigin('milkdown', () => this.replaceSourceDoc(markdown));
        this.emitChange(markdown);
    }

    applyPendingSource() {
        if (this.isSourceReadOnly()) {
            this.pendingSourceMd = null;
            return;
        }
        if (this.pendingSourceMd === null || this.pendingSourceMd === undefined) {
            return;
        }
        const md = this.pendingSourceMd;
        this.pendingSourceMd = null;
        if (!this.sourceOnlyReason) {
            this.withOrigin('source', () => window.IrisMilkdown.setMarkdown(md));
        }
        this.emitChange(md);
    }

    replaceSourceDoc(md) {
        if (!this.sourceView) {
            return;
        }

        const preserveSourceScroll = this.origin === 'milkdown' || !this.isSourceFocused();
        const scrollTop = this.sourceView.scrollDOM.scrollTop;
        const scrollLeft = this.sourceView.scrollDOM.scrollLeft;
        const scrollSnapshot = preserveSourceScroll && typeof this.sourceView.scrollSnapshot === 'function'
            ? this.sourceView.scrollSnapshot()
            : null;
        const selection = this.sourceView.state.selection;
        const docLength = (md || '').length;
        const clampPosition = (pos) => Math.min(Math.max(pos, 0), docLength);
        const ranges = selection.ranges.map((range) => EditorSelection.range(
            clampPosition(range.anchor),
            clampPosition(range.head)
        ));

        if (this.sourceScrollFrame) {
            window.cancelAnimationFrame(this.sourceScrollFrame);
            this.sourceScrollFrame = null;
        }

        const transaction = {
            changes: {
                from: 0,
                to: this.sourceView.state.doc.length,
                insert: md || '',
            },
            selection: EditorSelection.create(ranges, selection.mainIndex),
            annotations: Transaction.addToHistory.of(false),
        };
        if (scrollSnapshot) {
            transaction.effects = scrollSnapshot;
        }

        this.sourceView.dispatch(transaction);

        if (preserveSourceScroll) {
            this.sourceView.scrollDOM.scrollTop = scrollTop;
            this.sourceView.scrollDOM.scrollLeft = scrollLeft;
            this.sourceScrollFrame = window.requestAnimationFrame(() => {
                this.sourceScrollFrame = null;
                if (!this.destroyed && this.sourceView) {
                    this.sourceView.scrollDOM.scrollTop = scrollTop;
                    this.sourceView.scrollDOM.scrollLeft = scrollLeft;
                }
            });
        }
    }

    isSourceFocused() {
        if (!this.sourceView) {
            return false;
        }
        if (this.sourceView.hasFocus) {
            return true;
        }
        return !!(this.sourcePane && this.sourcePane.contains(document.activeElement));
    }

    emitChange(md) {
        if (this.onChange) {
            this.onChange(md);
        }
    }

    installCollabUi(collab) {
        this.installPresenceBar(collab.presenceTarget);
        this.installSourceLiveViewBadge();
        this.applyCollabState('syncing', true);
        this.updateSourceReadOnly();
    }

    installPresenceBar(targetRef) {
        this.collabPresenceTarget = resolveRef(targetRef);
        const parent = this.collabPresenceTarget
            ? this.collabPresenceTarget.parentNode
            : (this.shell ? this.shell.parentNode : null);
        if (!parent) {
            return;
        }

        // Defensive: an orphaned instance (e.g. a superseded note_detail()
        // call that never got destroy()-ed) may have left its own bar behind
        // in this same parent. Remove stragglers so they can't stack.
        parent.querySelectorAll('.iris-collab-bar').forEach((stale) => stale.remove());

        this.collabBar = document.createElement('div');
        this.collabBar.className = 'iris-collab-bar';

        this.collabAvatars = document.createElement('div');
        this.collabAvatars.className = 'iris-collab-avatars';

        this.collabStatusDot = document.createElement('span');
        this.collabStatusDot.className = 'iris-collab-status is-syncing';

        this.collabStatusText = document.createElement('span');
        this.collabStatusText.className = 'iris-collab-status-text';

        this.collabBar.appendChild(this.collabAvatars);
        this.collabBar.appendChild(this.collabStatusDot);
        this.collabBar.appendChild(this.collabStatusText);

        if (this.collabPresenceTarget) {
            parent.insertBefore(this.collabBar, this.collabPresenceTarget);
            this.collabPresenceTarget.style.display = 'none';
            this.cleanupFns.push(() => {
                this.collabPresenceTarget.style.display = '';
            });
        } else {
            parent.appendChild(this.collabBar);
        }
        this.cleanupFns.push(() => {
            if (this.collabBar && this.collabBar.parentNode) {
                this.collabBar.parentNode.removeChild(this.collabBar);
            }
            this.collabBar = null;
            this.collabAvatars = null;
            this.collabStatusDot = null;
            this.collabStatusText = null;
        });
    }

    installSourceLiveViewBadge() {
        if (!this.sourcePane) {
            return;
        }

        // Defensive: same reasoning as installPresenceBar() above -- an
        // orphaned instance's badge lives directly on sourcePane, which is
        // never cleared by create() (only the child source/wysiwyg mounts
        // are), so it survives re-creation unless removed here.
        this.sourcePane.querySelectorAll('.iris-collab-liveview-badge').forEach((stale) => stale.remove());

        this.collabSourceBadge = document.createElement('div');
        this.collabSourceBadge.className = 'iris-collab-liveview-badge';
        this.collabSourceBadge.textContent = 'Live view · edit in WYSIWYG';
        this.collabSourceBadge.hidden = true;
        this.sourcePane.appendChild(this.collabSourceBadge);
        this.syncSourceReadOnlyUi();
        this.cleanupFns.push(() => {
            if (this.sourcePane) {
                this.sourcePane.classList.remove('is-collab-readonly');
            }
            if (this.collabSourceBadge && this.collabSourceBadge.parentNode) {
                this.collabSourceBadge.parentNode.removeChild(this.collabSourceBadge);
            }
            this.collabSourceBadge = null;
        });
    }

    handleCollabStatus(status) {
        const next = normalizeCollabStatus(status);
        if (!this.collabActive) {
            return;
        }
        this.setCollabState(next);
        this.updateSourceReadOnly();
    }

    setCollabState(next) {
        if (!next) {
            return;
        }
        if (!this.collabState) {
            this.applyCollabState(next, true);
            return;
        }
        if (this.collabState === next) {
            this.pendingCollabState = null;
            return;
        }

        const elapsed = Date.now() - this.collabStateSince;
        if (elapsed >= COLLAB_STATE_MIN_MS) {
            this.applyCollabState(next, true);
            return;
        }

        if (this.collabStateTimer && this.pendingCollabState === next) {
            return;
        }
        if (this.collabStateTimer) {
            clearTimeout(this.collabStateTimer);
            this.collabStateTimer = null;
        }
        this.pendingCollabState = next;
        this.collabStateTimer = setTimeout(() => {
            this.collabStateTimer = null;
            const pending = this.pendingCollabState;
            this.pendingCollabState = null;
            if (pending) {
                this.applyCollabState(pending, true);
            }
        }, COLLAB_STATE_MIN_MS - elapsed);
    }

    applyCollabState(state, updateText) {
        const normalized = normalizeCollabStatus(state);
        this.collabState = normalized;
        this.collabStateSince = Date.now();
        this.pendingCollabState = null;
        if (this.collabStateTimer) {
            clearTimeout(this.collabStateTimer);
            this.collabStateTimer = null;
        }

        if (this.shell) {
            this.shell.classList.remove(...COLLAB_STATE_CLASSES);
            this.shell.classList.add(`collab-${normalized}`);
        }
        if (this.container) {
            this.container.setAttribute('data-collab-status', normalized);
        }
        if (this.collabStatusDot) {
            this.collabStatusDot.className = `iris-collab-status is-${normalized}`;
        }
        if (updateText) {
            this.renderCollabPresence();
        }
    }

    handleCollabAwareness(users) {
        if (!this.collabActive) {
            return;
        }
        this.collabUsers = Array.isArray(users) ? users : [];
        this.updateSourceReadOnly();
        if (!this.collabStateTimer) {
            this.renderCollabPresence();
        }
    }

    getOtherCollabUsers() {
        return this.collabUsers.filter((user) => user && !user.isSelf);
    }

    getSourceEditabilityExtensions(readOnly) {
        return [
            EditorState.readOnly.of(!!readOnly),
            EditorView.editable.of(!readOnly),
        ];
    }

    computeSourceReadOnly() {
        return !!(this.collabActive && !this.isLastCollabClient());
    }

    isSourceReadOnly() {
        return !!this.sourceReadOnly;
    }

    updateSourceReadOnly() {
        const nextReadOnly = this.computeSourceReadOnly();
        if (nextReadOnly === this.sourceReadOnly) {
            this.syncSourceReadOnlyUi();
            return;
        }

        if (nextReadOnly) {
            if (this.sourceTimer) {
                clearTimeout(this.sourceTimer);
                this.sourceTimer = null;
            }
            // Flush any pending source edit while still editable, before locking.
            this.applyPendingSource();
        }

        this.sourceReadOnly = nextReadOnly;
        if (this.sourceView) {
            this.sourceView.dispatch({
                effects: this.sourceEditabilityCompartment.reconfigure(
                    this.getSourceEditabilityExtensions(this.sourceReadOnly)
                ),
            });
        }

        if (this.sourceReadOnly) {
            if (window.IrisMilkdown && typeof window.IrisMilkdown.getMarkdown === 'function') {
                const markdown = window.IrisMilkdown.getMarkdown() || '';
                if (this.sourceView && this.sourceView.state.doc.toString() !== markdown) {
                    this.withOrigin('milkdown', () => this.replaceSourceDoc(markdown));
                }
            }
        }

        this.syncSourceReadOnlyUi();
    }

    syncSourceReadOnlyUi() {
        const readOnly = this.isSourceReadOnly();
        if (this.sourcePane) {
            this.sourcePane.classList.toggle('is-collab-readonly', readOnly);
        }
        if (this.collabSourceBadge) {
            this.collabSourceBadge.hidden = !readOnly;
        }
    }

    renderCollabPresence() {
        if (!this.collabAvatars || !this.collabStatusText) {
            return;
        }

        const peers = this.getOtherCollabUsers();
        const visiblePeers = peers.slice(0, 4);
        this.collabAvatars.innerHTML = '';
        this.collabAvatars.hidden = !visiblePeers.length;
        visiblePeers.forEach((user) => {
            const avatar = document.createElement('span');
            avatar.className = 'iris-collab-avatar';
            avatar.title = user.name || 'IRIS user';
            avatar.textContent = getInitials(user.name);
            if (user.color) {
                avatar.style.backgroundColor = user.color;
                avatar.style.setProperty('--iris-collab-color', user.color);
            }
            this.collabAvatars.appendChild(avatar);
        });

        if (peers.length > visiblePeers.length) {
            const more = document.createElement('span');
            more.className = 'iris-collab-avatar iris-collab-more';
            more.textContent = `+${peers.length - visiblePeers.length}`;
            this.collabAvatars.appendChild(more);
        }

        const names = peers.map((user) => user.name).filter(Boolean);
        const labels = {
            syncing: 'Syncing\u2026',
            live: 'Live',
            reconnecting: 'Reconnecting',
            offline: 'Offline',
        };
        const stateText = labels[this.collabState] || labels.syncing;
        if (this.collabStatusDot) {
            const dotState = this.collabState === 'live' && !peers.length ? 'solo' : (this.collabState || 'syncing');
            this.collabStatusDot.className = `iris-collab-status is-${dotState}`;
        }
        if (this.collabState === 'live' && !peers.length) {
            this.collabStatusText.textContent = 'Connected';
            return;
        }
        if (!names.length) {
            this.collabStatusText.textContent = stateText;
            return;
        }
        const peerText = names.length === 1
            ? `${names[0]} editing`
            : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''} editing`;
        this.collabStatusText.textContent = `${stateText} · ${peerText}`;
    }

    flush() {
        if (this.sourceTimer) {
            clearTimeout(this.sourceTimer);
            this.sourceTimer = null;
        }
        this.applyPendingSource();
    }

    getMarkdown() {
        this.flush();
        if (this.sourceOnlyReason) {
            return this.sourceView ? this.sourceView.state.doc.toString() : '';
        }
        return window.IrisMilkdown.getMarkdown() || '';
    }

    isSourceOnly() {
        return !!this.sourceOnlyReason;
    }

    isCollabActive() {
        return this.collabActive;
    }

    getCollabStatus() {
        if (!this.collabActive || !window.IrisMilkdown || typeof window.IrisMilkdown.getCollabStatus !== 'function') {
            return null;
        }
        return window.IrisMilkdown.getCollabStatus();
    }

    getCollabAwarenessStateCount() {
        if (!this.collabActive || !window.IrisMilkdown || typeof window.IrisMilkdown.getCollabAwarenessStateCount !== 'function') {
            return 0;
        }
        return window.IrisMilkdown.getCollabAwarenessStateCount();
    }

    isLastCollabClient() {
        if (!this.collabActive || !window.IrisMilkdown || typeof window.IrisMilkdown.isLastCollabClient !== 'function') {
            return true;
        }
        return window.IrisMilkdown.isLastCollabClient();
    }

    setMarkdown(md) {
        if (this.sourceTimer) {
            clearTimeout(this.sourceTimer);
            this.sourceTimer = null;
        }
        this.pendingSourceMd = null;
        const markdown = md || '';
        this.silentMarkdown = markdown;

        if (!this.sourceOnlyReason) {
            this.withOrigin('source', () => window.IrisMilkdown.setMarkdown(markdown));
        }
        this.withOrigin('milkdown', () => this.replaceSourceDoc(markdown));
    }

    focus() {
        if (this.sourceView) {
            this.sourceView.focus();
        }
    }

    async destroy() {
        this.destroyed = true;
        this.flush();
        if (this.sourceScrollFrame) {
            window.cancelAnimationFrame(this.sourceScrollFrame);
            this.sourceScrollFrame = null;
        }
        if (this.collabStateTimer) {
            clearTimeout(this.collabStateTimer);
            this.collabStateTimer = null;
        }
        if (this.shell) {
            this.shell.classList.remove(...COLLAB_STATE_CLASSES);
        }
        this.cleanupFns.forEach((fn) => fn());
        this.cleanupFns = [];
        if (this.sourceView) {
            this.sourceView.destroy();
            this.sourceView = null;
        }
        if (!this.sourceOnlyReason) {
            await destroyMilkdownIfActive();
        }
    }

    wireSplitUi() {
        this.wireDividerDrag();
        this.wireViewToggle();
        this.wireFocusClasses();
        this.wireBreakpointReset();
    }

    installSourceOnlyUi() {
        if (this.sourceOnlyUiInstalled || !this.container) {
            return;
        }
        this.sourceOnlyUiInstalled = true;
        const viewClasses = ['view-split', 'view-source', 'view-preview'];
        const previousView = viewClasses.find((className) => this.container.classList.contains(className));
        this.container.classList.remove('view-split', 'view-preview');
        this.container.classList.add('view-source', 'is-source-only');
        this.container.dataset.editorMode = 'source-only';
        this.container.dataset.editorReason = this.sourceOnlyReason;
        if (this.shell) {
            this.shell.classList.add('is-source-only');
        }

        const buttons = this.viewToggle
            ? Array.from(this.viewToggle.querySelectorAll('[data-view]'))
            : [];
        const buttonState = buttons.map((button) => ({
            button,
            disabled: button.disabled,
            title: button.getAttribute('title'),
            active: button.classList.contains('is-active'),
            pressed: button.getAttribute('aria-pressed'),
        }));
        buttons.forEach((button) => {
            const isSource = button.dataset.view === 'source';
            button.disabled = !isSource;
            button.classList.toggle('is-active', isSource);
            button.setAttribute('aria-pressed', isSource ? 'true' : 'false');
            if (!isSource) {
                button.title = 'Preview unavailable for this document';
            }
        });

        const status = document.createElement('span');
        status.className = 'iris-source-only-status';
        status.textContent = this.sourceOnlyReason === 'initialization-error'
            ? 'Source mode'
            : 'Large document: source mode';
        status.title = this.sourceOnlyReason === 'initialization-error'
            ? 'The rich editor could not be initialized'
            : 'Rich preview is disabled automatically for this document';
        if (this.viewToggle && this.viewToggle.parentNode) {
            this.viewToggle.parentNode.insertBefore(status, this.viewToggle.nextSibling);
        }

        this.cleanupFns.push(() => {
            this.container.classList.remove('is-source-only');
            this.container.classList.remove(...viewClasses);
            if (previousView) {
                this.container.classList.add(previousView);
            }
            delete this.container.dataset.editorMode;
            delete this.container.dataset.editorReason;
            if (this.shell) {
                this.shell.classList.remove('is-source-only');
            }
            buttonState.forEach(({ button, disabled, title, active, pressed }) => {
                button.disabled = disabled;
                button.classList.toggle('is-active', active);
                if (pressed === null) {
                    button.removeAttribute('aria-pressed');
                } else {
                    button.setAttribute('aria-pressed', pressed);
                }
                if (title === null) {
                    button.removeAttribute('title');
                } else {
                    button.setAttribute('title', title);
                }
            });
            status.remove();
        });
    }

    wireDividerDrag() {
        if (!this.divider) {
            return;
        }

        let dragging = false;

        const getClientX = (event) => {
            if (event.touches && event.touches.length) {
                return event.touches[0].clientX;
            }
            return event.clientX;
        };

        const setPaneWidths = (clientX) => {
            if (!this.container || !this.sourcePane || !this.wysiwygPane) {
                return;
            }
            if (window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`).matches) {
                this.clearPaneWidths();
                return;
            }

            const rect = this.container.getBoundingClientRect();
            const dividerWidth = this.divider ? this.divider.offsetWidth : 0;
            const available = rect.width - dividerWidth;
            if (available <= MIN_PANE_WIDTH * 2) {
                return;
            }
            const left = Math.min(
                Math.max(clientX - rect.left, MIN_PANE_WIDTH),
                available - MIN_PANE_WIDTH
            );
            const right = available - left;
            this.sourcePane.style.flex = `0 0 ${left}px`;
            this.wysiwygPane.style.flex = `0 0 ${right}px`;
        };

        const startDrag = (event) => {
            dragging = true;
            this.divider.classList.add('is-dragging');
            this.container.classList.add('is-resizing');
            event.preventDefault();
        };

        const moveDrag = (event) => {
            if (!dragging) {
                return;
            }
            setPaneWidths(getClientX(event));
            event.preventDefault();
        };

        const stopDrag = () => {
            if (!dragging) {
                return;
            }
            dragging = false;
            this.divider.classList.remove('is-dragging');
            this.container.classList.remove('is-resizing');
        };

        this.divider.addEventListener('mousedown', startDrag);
        this.divider.addEventListener('touchstart', startDrag, { passive: false });
        window.addEventListener('mousemove', moveDrag);
        window.addEventListener('touchmove', moveDrag, { passive: false });
        window.addEventListener('mouseup', stopDrag);
        window.addEventListener('touchend', stopDrag);

        this.cleanupFns.push(() => {
            this.divider.removeEventListener('mousedown', startDrag);
            this.divider.removeEventListener('touchstart', startDrag);
            window.removeEventListener('mousemove', moveDrag);
            window.removeEventListener('touchmove', moveDrag);
            window.removeEventListener('mouseup', stopDrag);
            window.removeEventListener('touchend', stopDrag);
        });
    }

    wireViewToggle() {
        if (!this.viewToggle) {
            return;
        }

        const views = {
            split: 'view-split',
            source: 'view-source',
            preview: 'view-preview',
        };
        const buttons = Array.from(this.viewToggle.querySelectorAll('[data-view]'))
            .map((el) => ({
                el,
                view: el.dataset.view,
                className: views[el.dataset.view],
            }))
            .filter((button) => button.className);

        const activate = (active) => {
            if (!this.container) {
                return;
            }
            this.container.classList.remove('view-split', 'view-source', 'view-preview');
            this.container.classList.add(active.className);
            buttons.forEach((button) => {
                const isActive = button.view === active.view;
                button.el.classList.toggle('is-active', isActive);
                button.el.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });
        };

        buttons.forEach((button) => {
            const onClick = () => activate(button);
            button.el.addEventListener('click', onClick);
            this.cleanupFns.push(() => button.el.removeEventListener('click', onClick));
        });

        const activeView = buttons.find((button) => this.container.classList.contains(button.className)) || buttons[0];
        if (activeView) {
            activate(activeView);
        }
    }

    wireFocusClasses() {
        if (!this.sourcePane || !this.wysiwygPane) {
            return;
        }
        const sourceFocus = () => {
            this.sourcePane.classList.add('is-active');
            this.wysiwygPane.classList.remove('is-active');
        };
        const wysiwygFocus = () => {
            this.wysiwygPane.classList.add('is-active');
            this.sourcePane.classList.remove('is-active');
        };

        this.sourcePane.addEventListener('focusin', sourceFocus);
        this.wysiwygPane.addEventListener('focusin', wysiwygFocus);
        this.cleanupFns.push(() => {
            this.sourcePane.removeEventListener('focusin', sourceFocus);
            this.wysiwygPane.removeEventListener('focusin', wysiwygFocus);
        });
    }

    wireBreakpointReset() {
        const clearOnNarrow = () => {
            if (window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`).matches) {
                this.clearPaneWidths();
            }
        };
        window.addEventListener('resize', clearOnNarrow);
        clearOnNarrow();
        this.cleanupFns.push(() => window.removeEventListener('resize', clearOnNarrow));
    }

    clearPaneWidths() {
        if (this.sourcePane) {
            this.sourcePane.style.flex = '';
        }
        if (this.wysiwygPane) {
            this.wysiwygPane.style.flex = '';
        }
    }
}

window.IrisSplitEditor = {
    async create(options) {
        const editor = new SplitEditor();
        await editor.create(options);
        return editor;
    },
};

window.dispatchEvent(new CustomEvent('iris-split-editor-ready'));
