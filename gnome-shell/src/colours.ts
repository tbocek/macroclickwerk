// Colour maths over a captured image. No Shell import, and so no compositor:
// the same helpers answer for a screenshot taken in the shell process and for a
// picture built in a test, which is the only way the question "which colour is
// this area" gets an answer that can be checked.

import type GdkPixbuf from 'gi://GdkPixbuf';

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

export function parseColor(value: string): Rgb {
    const text = (value || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(text)) {
        return {
            r: parseInt(text[0] + text[0], 16),
            g: parseInt(text[1] + text[1], 16),
            b: parseInt(text[2] + text[2], 16),
        };
    }
    if (/^[0-9a-f]{6}$/i.test(text)) {
        return {
            r: parseInt(text.slice(0, 2), 16),
            g: parseInt(text.slice(2, 4), 16),
            b: parseInt(text.slice(4, 6), 16),
        };
    }
    return { r: 0, g: 0, b: 0 };
}

export function formatColor(color: Rgb): string {
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

/** Euclidean RGB distance; good enough for "is this button green". */
export function colorDistance(a: Rgb, b: Rgb): number {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
}


/**
 * The mean colour of an area — for a 1×1 one, that pixel. Averaged on the
 * stored sRGB values rather than on light: the check this feeds compares sRGB
 * distances, so a gamma-correct mean would be a target the comparison it is
 * measured against does not use.
 */
export function averageColor(pixbuf: GdkPixbuf.Pixbuf): Rgb {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();

    let r = 0;
    let g = 0;
    let b = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = y * rowstride + x * channels;
            r += pixels[offset];
            g += pixels[offset + 1];
            b += pixels[offset + 2];
        }
    }

    const count = Math.max(1, width * height);
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}


