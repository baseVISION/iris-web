import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const SOURCE_SYNC_MS = 250;
const MIN_PANE_WIDTH = 180;
const NARROW_BREAKPOINT = 900;

function resolveRoot(root) {
    if (typeof root === 'string') {
        return document.querySelector(root);
    }
    return root;
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
        this.sourceView = null;
        this.sourceTimer = null;
        this.pendingSourceMd = null;
        this.origin = null;
        this.onChange = null;
        this.destroyed = false;
        this.cleanupFns = [];
    }

    async create({ milkdownRoot, sourceRoot, initialMarkdown = '', onChange }) {
        this.container = document.getElementById('note_split');
        this.sourcePane = resolveRoot(sourceRoot);
        this.previewPane = resolveRoot(milkdownRoot);
        this.divider = document.getElementById('note_divider');
        this.onChange = typeof onChange === 'function' ? onChange : null;

        if (!this.container || !this.sourcePane || !this.previewPane) {
            throw new Error('Missing split editor root elements');
        }

        const sourceMount = ensurePaneMount(this.sourcePane, 'iris-split-source');
        const previewMount = ensurePaneMount(this.previewPane, 'iris-split-preview');
        sourceMount.innerHTML = '';
        previewMount.innerHTML = '';

        this.wireSplitUi();
        await waitForMilkdown();
        if (this.destroyed) {
            return this;
        }

        await window.IrisMilkdown.create(previewMount, initialMarkdown || '', (md) => {
            this.handleMilkdownChange(md);
        });

        if (this.destroyed) {
            await destroyMilkdownIfActive();
            return this;
        }

        this.sourceView = new EditorView({
            parent: sourceMount,
            state: EditorState.create({
                doc: initialMarkdown || '',
                extensions: [
                    basicSetup,
                    markdown(),
                    EditorView.lineWrapping,
                    EditorView.updateListener.of((update) => this.handleSourceUpdate(update)),
                    EditorView.theme({
                        '&': { height: '100%' },
                        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
                    }),
                ],
            }),
        });

        return this;
    }

    handleSourceUpdate(update) {
        if (!update.docChanged || this.origin === 'milkdown') {
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
        if (this.origin === 'source' || !this.sourceView) {
            return;
        }
        this.origin = 'milkdown';
        this.replaceSourceDoc(md || '');
        this.origin = null;
        this.emitChange(md || '');
    }

    applyPendingSource() {
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
        this.sourceView.dispatch({
            changes: {
                from: 0,
                to: this.sourceView.state.doc.length,
                insert: md || '',
            },
            annotations: Transaction.addToHistory.of(false),
        });
    }

    emitChange(md) {
        if (this.onChange) {
            this.onChange(md);
        }
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

    setMarkdown(md) {
        if (this.sourceTimer) {
            clearTimeout(this.sourceTimer);
            this.sourceTimer = null;
        }
        this.pendingSourceMd = null;

        this.origin = 'source';
        window.IrisMilkdown.setMarkdown(md || '');
        this.origin = 'milkdown';
        this.replaceSourceDoc(md || '');
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
        const buttons = [
            { id: 'view_split', className: 'view-split' },
            { id: 'view_source', className: 'view-source' },
            { id: 'view_preview', className: 'view-preview' },
        ];

        const activate = (active) => {
            if (!this.container) {
                return;
            }
            this.container.classList.remove('view-split', 'view-source', 'view-preview');
            this.container.classList.add(active.className);
            buttons.forEach((button) => {
                const el = document.getElementById(button.id);
                if (!el) {
                    return;
                }
                const isActive = button.id === active.id;
                el.classList.toggle('is-active', isActive);
                el.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });
        };

        buttons.forEach((button) => {
            const el = document.getElementById(button.id);
            if (!el) {
                return;
            }
            const onClick = () => activate(button);
            el.addEventListener('click', onClick);
            this.cleanupFns.push(() => el.removeEventListener('click', onClick));
        });
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
