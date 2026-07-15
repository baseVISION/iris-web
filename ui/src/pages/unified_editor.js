import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { Slice } from '@milkdown/kit/prose/model';
import { autocompletion } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { irisToMilkdown, milkdownToIris, uploadThroughIris } from './milkdown_shared.js';

const instances = new WeakMap();

function resolveElement(anchor) {
    const element = typeof anchor === 'string' ? document.getElementById(anchor) : anchor;
    if (!element) {
        throw new Error(`Editor anchor not found: ${anchor}`);
    }
    return element;
}

function destroyPrevious(element) {
    const previous = instances.get(element);
    if (previous) {
        previous.destroy();
        instances.delete(element);
    }
}

function editorTheme(element) {
    const dark = element.dataset.theme === 'dark'
        || document.documentElement.dataset.theme === 'dark'
        || document.body.classList.contains('dark-mode');
    return EditorView.theme({
        '&': {
            backgroundColor: dark ? '#1f2937' : '#fff',
            color: dark ? '#e5e7eb' : '#1f2937',
            border: `1px solid ${dark ? '#4b5563' : '#ced4da'}`,
            borderRadius: '4px',
            fontSize: '0.875rem',
        },
        '&.cm-focused': {
            outline: 'none',
            borderColor: dark ? '#60a5fa' : '#80bdff',
            boxShadow: dark
                ? '0 0 0 0.2rem rgb(96 165 250 / 20%)'
                : '0 0 0 0.2rem rgb(0 123 255 / 20%)',
        },
        '.cm-content': {
            caretColor: dark ? '#f9fafb' : '#111827',
            minHeight: '3rem',
            padding: '0.5rem',
        },
        '.cm-gutters': {
            backgroundColor: dark ? '#111827' : '#f8f9fa',
            color: dark ? '#9ca3af' : '#6c757d',
            borderRight: `1px solid ${dark ? '#374151' : '#dee2e6'}`,
        },
        '.cm-activeLine, .cm-activeLineGutter': {
            backgroundColor: dark ? '#263244' : '#f3f7fb',
        },
        '.cm-selectionBackground, ::selection': {
            backgroundColor: dark ? '#374f78 !important' : '#cfe8ff !important',
        },
    });
}

function normalizeKey(key) {
    return String(key || '')
        .replace(/Command/gi, 'Meta')
        .replace(/Cmd/gi, 'Meta')
        .replace(/Control/gi, 'Ctrl')
        .replace(/Ctrl-([A-Z])/g, (_match, letter) => `Ctrl-${letter.toLowerCase()}`)
        .replace(/Meta-([A-Z])/g, (_match, letter) => `Meta-${letter.toLowerCase()}`);
}

function findLanguage(mode) {
    const name = String(mode || '').split('/').pop().toLowerCase();
    return languages.find((description) => {
        if (description.name.toLowerCase() === name) {
            return true;
        }
        return Array.isArray(description.alias)
            && description.alias.some((alias) => alias.toLowerCase() === name);
    }) || null;
}

function completionSourceFromLegacy(completer, editor) {
    return async (context) => {
        const token = context.matchBefore(/[^\s,{}[\]()]+/);
        if (!token && !context.explicit) {
            return null;
        }
        const prefix = token ? token.text : '';
        const values = await new Promise((resolve) => {
            completer.getCompletions(editor, editor, null, prefix, (error, items) => {
                resolve(error || !Array.isArray(items) ? [] : items);
            });
        });
        return {
            from: token ? token.from : context.pos,
            options: values.map((item) => ({
                label: item.caption || item.value || '',
                apply: item.value || item.caption || '',
                detail: item.meta || '',
                boost: Number(item.score) || 0,
            })),
        };
    };
}

class CodeEditor {
    constructor(anchor, options = {}) {
        this.element = resolveElement(anchor);
        destroyPrevious(this.element);
        this.element.classList.add('iris-code-editor');
        this.changeHandlers = [];
        this.commandBindings = [];
        this.languageCompartment = new Compartment();
        this.editableCompartment = new Compartment();
        this.placeholderCompartment = new Compartment();
        this.completionCompartment = new Compartment();
        this.commandCompartment = new Compartment();
        this.session = this;
        this.renderer = {
            setShowGutter: (show) => this.setOption('showLineNumbers', show),
            setScrollMargin: () => {},
        };

        const initialValue = this.element.textContent || '';
        this.element.textContent = '';
        this.view = new EditorView({
            parent: this.element,
            state: EditorState.create({
                doc: initialValue,
                extensions: [
                    basicSetup,
                    editorTheme(this.element),
                    EditorView.lineWrapping,
                    this.languageCompartment.of([]),
                    this.editableCompartment.of(EditorView.editable.of(true)),
                    this.placeholderCompartment.of([]),
                    this.completionCompartment.of([]),
                    this.commandCompartment.of([]),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            this.changeHandlers.forEach((handler) => handler());
                        }
                    }),
                ],
            }),
        });
        instances.set(this.element, this);
        Object.entries(options || {}).forEach(([name, value]) => this.setOption(name, value));
    }

    getValue() {
        return this.view.state.doc.toString();
    }

    setValue(value) {
        const next = value == null ? '' : String(value);
        this.view.dispatch({
            changes: { from: 0, to: this.view.state.doc.length, insert: next },
            selection: { anchor: 0 },
        });
        return this;
    }

    getSession() {
        return this;
    }

    on(event, handler) {
        if (event === 'change' && typeof handler === 'function') {
            this.changeHandlers.push(handler);
        }
        return this;
    }

    off(event) {
        if (event === 'change') {
            this.changeHandlers = [];
        }
        return this;
    }

    async setMode(mode) {
        const description = findLanguage(mode);
        const support = description ? await description.load() : [];
        if (this.view) {
            this.view.dispatch({ effects: this.languageCompartment.reconfigure(support) });
        }
        return this;
    }

    setReadOnly(readOnly) {
        this.view.dispatch({
            effects: this.editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
        });
        return this;
    }

    setUseWrapMode() {
        return this;
    }

    setTheme() {
        return this;
    }

    setShowPrintMargin() {
        return this;
    }

    setCompletions(completers) {
        const list = Array.isArray(completers) ? completers : [];
        const override = list
            .filter((item) => item && typeof item.getCompletions === 'function')
            .map((item) => completionSourceFromLegacy(item, this));
        this.view.dispatch({
            effects: this.completionCompartment.reconfigure(
                override.length ? autocompletion({ override }) : []
            ),
        });
        return this;
    }

    setOption(name, value) {
        switch (name) {
            case 'minLines':
                this.element.style.minHeight = `${Math.max(2, Number(value) || 2) * 1.45 + 1}rem`;
                this.view.dom.style.minHeight = this.element.style.minHeight;
                break;
            case 'maxLines':
                if (Number.isFinite(Number(value))) {
                    this.element.style.maxHeight = `${Number(value) * 1.45 + 1}rem`;
                    this.element.style.overflow = 'auto';
                    this.view.dom.style.maxHeight = this.element.style.maxHeight;
                }
                break;
            case 'placeholder':
                this.view.dispatch({
                    effects: this.placeholderCompartment.reconfigure(
                        value ? placeholderExtension(String(value)) : []
                    ),
                });
                break;
            case 'readOnly':
                this.setReadOnly(Boolean(value));
                break;
            case 'showLineNumbers':
                this.view.dom.querySelectorAll('.cm-gutters').forEach((gutter) => {
                    gutter.style.display = value ? '' : 'none';
                });
                break;
            case 'enableBasicAutocompletion':
                if (Array.isArray(value)) {
                    this.setCompletions(value);
                }
                break;
            default:
                break;
        }
        return this;
    }

    setOptions(options) {
        Object.entries(options || {}).forEach(([name, value]) => this.setOption(name, value));
        return this;
    }

    addCommand(command) {
        if (!command || typeof command.exec !== 'function') {
            return this;
        }
        const binding = command.bindKey || {};
        const platformKey = /Mac|iPhone|iPad/.test(navigator.platform)
            ? binding.mac || binding.win
            : binding.win || binding.mac;
        if (!platformKey) {
            return this;
        }
        this.commandBindings.push({
            key: normalizeKey(platformKey),
            run: () => {
                command.exec(this);
                return true;
            },
        });
        this.view.dispatch({
            effects: this.commandCompartment.reconfigure(keymap.of(this.commandBindings)),
        });
        return this;
    }

    get commands() {
        return { addCommand: (command) => this.addCommand(command) };
    }

    insertSnippet(snippet) {
        const selection = this.view.state.selection.main;
        const selected = this.view.state.sliceDoc(selection.from, selection.to);
        const insert = String(snippet || '')
            .replace(/\$\{1:\$SELECTION\}/g, selected)
            .replace(/\$SELECTION/g, selected);
        this.view.dispatch({
            changes: { from: selection.from, to: selection.to, insert },
            selection: { anchor: selection.from + insert.length },
        });
        return this;
    }

    focus() {
        this.view.focus();
        return this;
    }

    resize() {
        this.view.requestMeasure();
        return this;
    }

    destroy() {
        if (this.view) {
            this.view.destroy();
            this.view = null;
        }
    }
}

class MilkdownEditor {
    constructor(anchor, options = {}) {
        this.element = resolveElement(anchor);
        destroyPrevious(this.element);
        this.element.classList.add('iris-markdown-editor');
        this.element.removeAttribute('contenteditable');
        this.element.removeAttribute('spellcheck');
        this.value = this.element.textContent || '';
        this.changeHandlers = [];
        this.readOnly = Boolean(options.readOnly);
        this.crepe = null;
        this.element.textContent = '';
        instances.set(this.element, this);
        this.ready = this.initialize();
        Object.entries(options || {}).forEach(([name, value]) => this.setOption(name, value));
    }

    async initialize() {
        const initialValue = this.value;
        const crepe = new Crepe({
            root: this.element,
            defaultValue: irisToMilkdown(this.value),
            featureConfigs: {
                [Crepe.Feature.ImageBlock]: {
                    onUpload: uploadThroughIris,
                },
            },
        });
        await crepe.create();
        this.crepe = crepe;
        this.applyReadOnly();
        this.applyMinimumHeight();
        if (this.value !== initialValue) {
            this.setValue(this.value);
        }
        crepe.on((listener) => {
            listener.markdownUpdated((_ctx, markdown) => {
                this.value = milkdownToIris(markdown || '');
                this.changeHandlers.forEach((handler) => handler());
            });
        });
        return this;
    }

    readMarkdown() {
        if (!this.crepe) {
            return this.value;
        }
        let markdown = this.value;
        this.crepe.editor.action((ctx) => {
            const serializer = ctx.get(serializerCtx);
            const view = ctx.get(editorViewCtx);
            markdown = milkdownToIris(serializer(view.state.doc));
        });
        this.value = markdown;
        return markdown;
    }

    getValue() {
        return this.readMarkdown();
    }

    setValue(value) {
        this.value = value == null ? '' : String(value);
        if (!this.crepe) {
            return this;
        }
        this.crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const parser = ctx.get(parserCtx);
            const doc = parser(irisToMilkdown(this.value));
            if (!doc) {
                return;
            }
            const transaction = view.state.tr.replace(
                0,
                view.state.doc.content.size,
                new Slice(doc.content, 0, 0)
            );
            transaction.setMeta('addToHistory', false);
            view.dispatch(transaction);
        });
        return this;
    }

    setOption(name, value) {
        if (name === 'minLines') {
            this.minimumHeight = `${Math.max(2, Number(value) || 2) * 1.45 + 1}rem`;
            this.applyMinimumHeight();
        } else if (name === 'readOnly') {
            this.setReadOnly(Boolean(value));
        }
        return this;
    }

    applyMinimumHeight() {
        if (!this.minimumHeight) {
            return;
        }
        this.element.style.minHeight = this.minimumHeight;
        const editable = this.element.querySelector('.ProseMirror');
        if (editable) {
            editable.style.minHeight = this.minimumHeight;
        }
    }

    setOptions(options) {
        Object.entries(options || {}).forEach(([name, value]) => this.setOption(name, value));
        return this;
    }

    setReadOnly(readOnly) {
        this.readOnly = Boolean(readOnly);
        this.applyReadOnly();
        return this;
    }

    applyReadOnly() {
        if (!this.crepe) {
            return;
        }
        this.crepe.editor.action((ctx) => {
            ctx.get(editorViewCtx).setProps({ editable: () => !this.readOnly });
        });
    }

    on(event, handler) {
        if (event === 'change' && typeof handler === 'function') {
            this.changeHandlers.push(handler);
        }
        return this;
    }

    off(event) {
        if (event === 'change') {
            this.changeHandlers = [];
        }
        return this;
    }

    insertSnippet(snippet) {
        if (!this.crepe) {
            this.value += String(snippet || '').replace(/\$\{1:\$SELECTION\}/g, '');
            return this;
        }
        this.crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to } = view.state.selection;
            const selected = view.state.doc.textBetween(from, to, '\n');
            const insert = String(snippet || '')
                .replace(/\$\{1:\$SELECTION\}/g, selected)
                .replace(/\$SELECTION/g, selected);
            view.dispatch(view.state.tr.insertText(insert, from, to));
        });
        return this;
    }

    focus() {
        if (this.crepe) {
            this.crepe.editor.action((ctx) => ctx.get(editorViewCtx).focus());
        } else {
            this.ready.then(() => this.focus());
        }
        return this;
    }

    resize() {
        return this;
    }

    async destroy() {
        if (this.crepe) {
            try {
                await this.crepe.destroy();
            } catch {
                // The containing modal may already have been removed.
            }
            this.crepe = null;
        }
    }
}

function createCodeEditor(anchor, options = {}) {
    return new CodeEditor(anchor, options);
}

function createMarkdownEditor(anchor, options = {}) {
    return new MilkdownEditor(anchor, options);
}

function getEditor(anchor) {
    return instances.get(resolveElement(anchor)) || null;
}

window.IrisUnifiedEditor = {
    createCodeEditor,
    createMarkdownEditor,
    getEditor,
};
window.create_iris_code_editor = createCodeEditor;
window.create_iris_markdown_editor = createMarkdownEditor;
window.get_iris_editor = getEditor;
window.dispatchEvent(new CustomEvent('iris-unified-editor-ready'));
