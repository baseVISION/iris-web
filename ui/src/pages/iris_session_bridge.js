// Exposes $lib/collab_editor_session helpers as window.IrisCollabSession for
// non-module page scripts (case.notes.js, case.summary.js, case.asset.js) that
// are loaded via plain <script src> and cannot use ES `import`.
// As the sole importer of collab_editor_session, Vite inlines it here with no
// import/export statements, so this bundle is itself safe to load as a plain
// <script src> (no type="module") and must be placed before those page scripts.
import * as collabSession from '$lib/collab_editor_session';

window.IrisCollabSession = collabSession;
