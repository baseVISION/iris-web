export const LARGE_DOCUMENT_MAX_CHARS = 1_000_000;
export const LARGE_DOCUMENT_MAX_LINE_CHARS = 100_000;

export function getLargeDocumentReason(markdown) {
    const content = typeof markdown === 'string' ? markdown : '';
    if (content.length > LARGE_DOCUMENT_MAX_CHARS) {
        return 'document-size';
    }

    let lineLength = 0;
    for (let index = 0; index < content.length; index += 1) {
        if (content.charCodeAt(index) === 10) {
            lineLength = 0;
            continue;
        }
        lineLength += 1;
        if (lineLength > LARGE_DOCUMENT_MAX_LINE_CHARS) {
            return 'line-length';
        }
    }
    return null;
}
