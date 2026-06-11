import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

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
        this.previewPane = null;
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
    }

    async create({ container, sourcePane, previewPane, divider, viewToggle, initialMarkdown = '', onChange, collab = null }) {
        this.container = resolveRef(container);
        this.sourcePane = resolveRef(sourcePane);
        this.previewPane = resolveRef(previewPane);
        this.divider = resolveRef(divider);
        this.viewToggle = resolveRef(viewToggle);
        this.onChange = typeof onChange === 'function' ? onChange : null;
        this.collabActive = !!collab;

        if (!this.container || !this.sourcePane || !this.previewPane) {
            throw new Error('Missing split editor root elements');
        }
        this.shell = this.container.closest('.iris-split-shell') || this.container;

        const sourceMount = ensurePaneMount(this.sourcePane, 'iris-split-source-mount');
        const previewMount = ensurePaneMount(this.previewPane, 'iris-split-preview-mount');
        sourceMount.innerHTML = '';
        previewMount.innerHTML = '';

        this.wireSplitUi();
        await waitForMilkdown();
        if (this.destroyed) {
            return this;
        }

        const collabOptions = this.getCollabOptions(collab);
        await window.IrisMilkdown.create(previewMount, initialMarkdown || '', (md) => {
            this.handleMilkdownChange(md);
        }, { collab: collabOptions });

        if (this.destroyed) {
            await destroyMilkdownIfActive();
            return this;
        }

        this.sourceReadOnly = this.computeSourceReadOnly();
        this.sourceView = new EditorView({
            parent: sourceMount,
            state: EditorState.create({
                doc: initialMarkdown || '',
                extensions: [
                    basicSetup,
                    markdown(),
                    this.sourceEditabilityCompartment.of(this.getSourceEditabilityExtensions(this.sourceReadOnly)),
                    EditorView.lineWrapping,
                    EditorView.updateListener.of((update) => this.handleSourceUpdate(update)),
                    EditorView.theme({
                        '&': { height: '100%' },
                        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
                    }),
                ],
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
                this.origin = 'milkdown';
                this.replaceSourceDoc(markdown);
                this.origin = null;
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

        this.origin = 'milkdown';
        this.replaceSourceDoc(markdown);
        this.origin = null;
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
        this.origin = 'source';
        window.IrisMilkdown.setMarkdown(md);
        this.origin = null;
        this.emitChange(md);
    }

    replaceSourceDoc(md) {
        if (!this.sourceView) {
            return;
        }

        const scrollTop = this.sourceView.scrollDOM.scrollTop;
        const selection = this.sourceView.state.selection;
        const docLength = (md || '').length;
        const clampPosition = (pos) => Math.min(Math.max(pos, 0), docLength);
        const ranges = selection.ranges.map((range) => EditorSelection.range(
            clampPosition(range.anchor),
            clampPosition(range.head)
        ));

        this.sourceView.dispatch({
            changes: {
                from: 0,
                to: this.sourceView.state.doc.length,
                insert: md || '',
            },
            selection: EditorSelection.create(ranges, selection.mainIndex),
            annotations: Transaction.addToHistory.of(false),
        });
        this.sourceView.scrollDOM.scrollTop = scrollTop;
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

        this.pendingCollabState = next;
        if (this.collabStateTimer) {
            return;
        }
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
        this.renderCollabPresence();
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

        this.sourceReadOnly = nextReadOnly;
        if (this.sourceView) {
            this.sourceView.dispatch({
                effects: this.sourceEditabilityCompartment.reconfigure(
                    this.getSourceEditabilityExtensions(this.sourceReadOnly)
                ),
            });
        }

        if (this.sourceReadOnly) {
            if (this.sourceTimer) {
                clearTimeout(this.sourceTimer);
                this.sourceTimer = null;
            }
            this.pendingSourceMd = null;
            if (window.IrisMilkdown && typeof window.IrisMilkdown.getMarkdown === 'function') {
                const markdown = window.IrisMilkdown.getMarkdown() || '';
                if (this.sourceView && this.sourceView.state.doc.toString() !== markdown) {
                    this.origin = 'milkdown';
                    this.replaceSourceDoc(markdown);
                    this.origin = null;
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
            syncing: 'Syncing',
            live: 'Live',
            reconnecting: 'Reconnecting',
            offline: 'Offline',
        };
        const stateText = labels[this.collabState] || labels.syncing;
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
        return window.IrisMilkdown.getMarkdown() || '';
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

        this.origin = 'source';
        window.IrisMilkdown.setMarkdown(markdown);
        this.origin = 'milkdown';
        this.replaceSourceDoc(markdown);
        this.origin = null;
    }

    focus() {
        if (this.sourceView) {
            this.sourceView.focus();
        }
    }

    async destroy() {
        this.destroyed = true;
        this.flush();
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
        await destroyMilkdownIfActive();
    }

    wireSplitUi() {
        this.wireDividerDrag();
        this.wireViewToggle();
        this.wireFocusClasses();
        this.wireBreakpointReset();
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
            if (!this.container || !this.sourcePane || !this.previewPane) {
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
            this.previewPane.style.flex = `0 0 ${right}px`;
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
        if (!this.sourcePane || !this.previewPane) {
            return;
        }
        const sourceFocus = () => {
            this.sourcePane.classList.add('is-active');
            this.previewPane.classList.remove('is-active');
        };
        const previewFocus = () => {
            this.previewPane.classList.add('is-active');
            this.sourcePane.classList.remove('is-active');
        };

        this.sourcePane.addEventListener('focusin', sourceFocus);
        this.previewPane.addEventListener('focusin', previewFocus);
        this.cleanupFns.push(() => {
            this.sourcePane.removeEventListener('focusin', sourceFocus);
            this.previewPane.removeEventListener('focusin', previewFocus);
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
        if (this.previewPane) {
            this.previewPane.style.flex = '';
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
