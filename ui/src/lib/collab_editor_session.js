export const COLLAB_COLORS = [
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

export function hashCollabString(value) {
    let hash = 0;
    const str = value || 'IRIS';
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

export function hashContent(value) {
    const text = value || '';
    return `${text.length}:${hashCollabString(text)}`;
}

export function getCollabUser() {
    let whoami = null;
    if (typeof userWhoami !== 'undefined' && userWhoami) {
        whoami = userWhoami;
    } else {
        try {
            whoami = JSON.parse(sessionStorage.getItem('userWhoami'));
        } catch (e) {
            whoami = null;
        }
    }

    const name = (whoami && (whoami.user_name || whoami.user_login))
        || $('#current_username').text()
        || 'IRIS user';
    return {
        name,
        color: COLLAB_COLORS[hashCollabString(name) % COLLAB_COLORS.length],
    };
}

export function syncPostJson(url, payload, caseId) {
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${url}?cid=${encodeURIComponent(caseId)}`, false);
        xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
        xhr.send(JSON.stringify(payload));
        return xhr.status >= 200 && xhr.status < 300;
    } catch (e) {
        return false;
    }
}

export async function mountMarkdownSplitEditor(prefix, initialMarkdown, { onChange, timeoutMs = 10000, onTimeout } = {}) {
    await waitForSplitEditor({ timeoutMs, onTimeout });
    return window.IrisSplitEditor.create({
        container: `#${prefix}_split`,
        sourcePane: `#${prefix}_source`,
        wysiwygPane: `#${prefix}_preview`,
        divider: `#${prefix}_divider`,
        viewToggle: document.querySelector(`#${prefix}_view_toggle`),
        initialMarkdown: initialMarkdown || '',
        onChange,
        collab: null,
    });
}

export function waitForSplitEditor({ timeoutMs, onTimeout } = {}) {
    if (window.IrisSplitEditor) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        let timer = null;
        const on_ready = function() {
            if (timer) {
                clearTimeout(timer);
            }
            resolve();
        };
        if (timeoutMs) {
            timer = window.setTimeout(function() {
                window.removeEventListener('iris-split-editor-ready', on_ready);
                if (typeof onTimeout === 'function') {
                    onTimeout();
                }
                reject(new Error('GUI editor failed to load'));
            }, timeoutMs);
        }
        window.addEventListener('iris-split-editor-ready', on_ready, { once: true });
    });
}
