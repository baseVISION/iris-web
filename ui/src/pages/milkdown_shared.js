function transformOutsideCode(md, transform) {
    const fence = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
    let output = '';
    let last = 0;
    let match;
    while ((match = fence.exec(md)) !== null) {
        output += transform(md.slice(last, match.index));
        output += match[0];
        last = match.index + match[0].length;
    }
    output += transform(md.slice(last));
    return output;
}

function widthTokenToPercent(width) {
    if (!width || width === '*' || !width.endsWith('%')) {
        return null;
    }
    const value = parseInt(width.slice(0, -1), 10);
    return Number.isFinite(value) ? value : null;
}

export function irisToMilkdown(markdown) {
    if (!markdown) {
        return markdown;
    }
    const image = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)\s*(?:=([0-9]+%?|\*)(?:x([0-9]+%?|\*))?)?\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;
    return transformOutsideCode(markdown, (segment) => segment.replace(
        image,
        (_full, alt, url, width, _height, doubleTitle, singleTitle) => {
            const title = doubleTitle != null ? doubleTitle : singleTitle;
            const percent = widthTokenToPercent(width);
            const ratio = percent === null ? 1 : Math.max(0.01, percent / 100);
            const caption = (title || alt || '').replace(/"/g, '');
            return `![${ratio.toFixed(2)}](${url}${caption ? ` "${caption}"` : ''})`;
        }
    ));
}

export function milkdownToIris(markdown) {
    if (!markdown) {
        return markdown;
    }
    const image = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)\s*(?:"([^"]*)")?\s*\)/g;
    return transformOutsideCode(markdown, (segment) => segment.replace(
        image,
        (full, alt, url, title) => {
            if (!/^[0-9]*\.?[0-9]+$/.test(alt.trim())) {
                return full;
            }
            const ratio = parseFloat(alt);
            if (!Number.isFinite(ratio)) {
                return full;
            }
            const name = (title || '').replace(/[[\]]/g, '');
            const percent = Math.max(1, Math.round(ratio * 100));
            return percent === 100
                ? `![${name}](${url})`
                : `![${name}](${url} =${percent}%x*)`;
        }
    ));
}

export function uploadThroughIris(file) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                callback(value);
            }
        };
        const timeout = setTimeout(
            () => finish(reject, new Error('image upload timed out')),
            120000
        );
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const extension = window.get_extension_from_mime(file.type);
                const filename = `${window.random_filename(25)}.${extension}`;
                window.upload_interactive_data(event.target.result, filename, (data) => {
                    if (data && data.data && data.data.file_url) {
                        finish(resolve, data.data.file_url + window.case_param());
                    } else {
                        finish(reject, new Error('upload did not return a file_url'));
                    }
                });
            } catch (error) {
                finish(reject, error);
            }
        };
        reader.onerror = () => finish(reject, new Error('failed to read pasted file'));
        reader.readAsDataURL(file);
    });
}
