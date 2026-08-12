// Colour tests, on pictures built here rather than taken off a screen: what is
// under test is the question a colour check asks — what does this area average
// to, and is that near enough to what it averaged to when it was picked.
//
// Plain gjs, no compositor: the colour maths is a module of its own precisely so
// that this can run beside the other tests rather than skipping itself.

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import { averageColor, colorDistance, formatColor, parseColor } from '../dist/src/colours.js';

let failures = 0;
const check = (name, cond, extra = '') => {
    if (!cond) { failures++; print(`FAIL ${name} ${extra}`); }
    else print(`ok   ${name}`);
};

/**
 * A dialog button, near enough: a coloured field with a dark glyph on it and a
 * white badge under it, on a background of something else. `field` is the part
 * that changes when the thing you are watching changes — the green Yes button
 * turning into no dialog at all.
 */
function button(field) {
    const W = 60, H = 40;
    const data = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let c = field;
            if (x > 18 && x < 42 && y > 8 && y < 24) c = [30, 100, 10];    // the glyph
            if (x > 24 && x < 36 && y > 26 && y < 36) c = [255, 255, 255]; // the badge
            if (x < 4 || x > W - 5 || y < 3 || y > H - 4) c = [40, 20, 60];// around it
            const o = (y * W + x) * 3;
            // A couple of units of noise: a real screen never gives the same
            // pixel twice, and a check that cannot survive that is no use.
            const wobble = ((x * 7 + y * 13) % 5) - 2;
            for (let i = 0; i < 3; i++) {
                data[o + i] = Math.max(0, Math.min(255, c[i] + wobble));
            }
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(
        new GLib.Bytes(data), GdkPixbuf.Colorspace.RGB, false, 8, W, H, W * 3);
}

const TOLERANCE = 30;
const fires = (pixbuf, picked) =>
    colorDistance(averageColor(pixbuf), parseColor(picked)) <= TOLERANCE;

// What Pick stores is what the check reads: the same function over the same
// area, so the check is true of the very screen it was taken from.
const green = button([46, 204, 0]);
const picked = formatColor(averageColor(green));
check('a check is true of the screen it was picked from', fires(green, picked), picked);

// Noise, and a glyph that moved a pixel or two, must not put it out.
check('and of the same thing a moment later', fires(button([48, 201, 3]), picked));

// The whole point: when the thing goes away, the average goes with it.
const gone = button([64, 32, 96]);
check('and false once that is gone', !fires(gone, picked),
      `${formatColor(averageColor(gone))} vs ${picked}`);
const red = button([204, 46, 0]);
check('and false when it turns another colour', !fires(red, picked),
      `${formatColor(averageColor(red))} vs ${picked}`);

// A single pixel is the same check on an area of one, which is why there is
// only one path through the evaluator.
const one = GdkPixbuf.Pixbuf.new_from_bytes(
    new GLib.Bytes(new Uint8Array([46, 204, 0])), GdkPixbuf.Colorspace.RGB, false, 8, 1, 1, 3);
check('one pixel averages to itself', formatColor(averageColor(one)) === '#2ecc00',
      formatColor(averageColor(one)));

// Tolerance is a distance, not a per-channel slack: worth pinning, because it
// is the only number left on the row and everything now rides on it.
check('tolerance is an RGB distance',
      Math.round(colorDistance(parseColor('#000000'), parseColor('#0a0a0a'))) === 17,
      String(colorDistance(parseColor('#000000'), parseColor('#0a0a0a'))));

print(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
imports.system.exit(failures === 0 ? 0 : 1);
