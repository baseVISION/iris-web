// IRIS Milkdown (Crepe) WYSIWYG note editor — separate ESM entry.
// Loaded as <script type="module"> from case_notes_v2.html; exposes window.IrisMilkdown
// for the classic case.notes.js to drive. base:'/static/' in vite.config makes chunk
// URLs resolve correctly. Theme CSS is emitted to /static/assets/css/milkdown_editor.css
// and must be linked manually in the template.
import { Crepe } from '@milkdown/crepe';
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

window.IrisMilkdown = {
    irisToMilkdown,
    milkdownToIris,

    // Mount Crepe into rootSelector with IRIS markdown. onChange(markdownInIrisForm) fires
    // (debounced by caller if desired) on edits.
    async create(rootSelector, irisMarkdown, onChange) {
        await this.destroy();
        _onChange = typeof onChange === 'function' ? onChange : null;
        // Build + create the editor locally and only publish it to `_crepe` once it is
        // fully created, so isActive()/getMarkdown() never see a half-initialised editor.
        const crepe = new Crepe({
            root: rootSelector,
            defaultValue: irisToMilkdown(irisMarkdown || ''),
            featureConfigs: {
                [Crepe.Feature.ImageBlock]: {
                    onUpload: uploadThroughIris,
                },
            },
        });
        await crepe.create();
        _crepe = crepe;
        if (_onChange) {
            _crepe.on((listener) => {
                listener.markdownUpdated(() => {
                    try { _onChange(milkdownToIris(_crepe.getMarkdown())); } catch (e) { /* noop */ }
                });
            });
        }
        return true;
    },

    // Current content as IRIS-canonical markdown (this is what save_note must persist).
    getMarkdown() {
        return _crepe ? milkdownToIris(_crepe.getMarkdown()) : null;
    },

    isActive() {
        return _crepe !== null;
    },

    async destroy() {
        if (_crepe) {
            try { await _crepe.destroy(); } catch (e) { /* noop */ }
            _crepe = null;
            _onChange = null;
        }
    },
};

window.dispatchEvent(new CustomEvent('iris-milkdown-ready'));
