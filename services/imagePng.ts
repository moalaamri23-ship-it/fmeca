/**
 * PNG re-encoding for the Copilot file channel.
 *
 * The Copilot Studio agent only analyses PNG: a JPEG or WebP upload — including
 * JPEG-rendered PDF pages — is accepted by the flow and then silently ignored, so
 * the answer comes back as if no file had been sent at all. Everything bound for
 * that channel therefore leaves as PNG.
 *
 * Ported from FileLM (src/lib/images.ts), whose limits are measured: phone photos
 * (4032×3024, ~4 MB) are the case that fails, while screenshots well under 1 MB
 * always worked. 1280 px is more detail than a vision model resolves anyway.
 */

export const MAX_PNG_EDGE = 1280;
export const MAX_PNG_BYTES = 1_500_000;

export interface PngPayload {
    contentType: 'image/png';
    /** Raw base64, no data URL prefix. */
    contentBytes: string;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not decode image data.'));
        img.src = dataUrl;
    });
}

function encodePng(img: HTMLImageElement, width: number, height: number): string {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    // Flatten transparency onto white: an alpha PNG can otherwise read as blank.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
}

function base64Of(dataUrl: string): string {
    const comma = dataUrl.indexOf(',');
    return comma < 0 ? '' : dataUrl.slice(comma + 1).replace(/\s/g, '');
}

/** Decoded size of a base64 payload, without decoding it. */
export function decodedBase64Size(contentBytes: string): number {
    const padding = contentBytes.endsWith('==') ? 2 : contentBytes.endsWith('=') ? 1 : 0;
    return Math.floor((contentBytes.length * 3) / 4) - padding;
}

/**
 * Re-encode any image data URL as PNG, downscaling until it fits the byte
 * budget. PNG input already inside the budget is passed through untouched.
 */
export async function toPngPayload(
    dataUrl: string,
    { maxBytes = MAX_PNG_BYTES, maxEdge = MAX_PNG_EDGE }: { maxBytes?: number; maxEdge?: number } = {}
): Promise<PngPayload> {
    const existing = base64Of(dataUrl);
    if (!existing) throw new Error('Empty image data.');
    if (dataUrl.startsWith('data:image/png') && decodedBase64Size(existing) <= maxBytes) {
        return { contentType: 'image/png', contentBytes: existing };
    }

    const img = await loadImage(dataUrl);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('Image has no dimensions.');

    let scale = Math.min(1, maxEdge / Math.max(width, height));
    let encoded = '';
    // PNG of a photo is several times its JPEG size, so shrink until it fits.
    for (let attempt = 0; attempt < 4; attempt++) {
        encoded = base64Of(encodePng(img, Math.round(width * scale), Math.round(height * scale)));
        if (decodedBase64Size(encoded) <= maxBytes) break;
        scale *= 0.75;
    }
    if (!encoded) throw new Error('PNG encoding failed.');
    return { contentType: 'image/png', contentBytes: encoded };
}

/**
 * A file name the flow's file inputs accept, always ending in .png — flows that
 * infer the type from the name stay correct.
 */
export function pngAttachmentName(name: string | undefined, index: number): string {
    const supplied = name?.trim();
    if (!supplied) return `image-${index + 1}.png`;
    const stem = supplied
        .replace(/\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return `${stem || `image-${index + 1}`}.png`;
}
