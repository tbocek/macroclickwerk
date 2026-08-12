// Screen capture and pixel inspection. Runs inside the shell process, where
// Shell.Screenshot can grab the stage without a portal round trip.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';

let promisified = false;

function ensurePromisified(): void {
    if (promisified) {
        return;
    }
    promisified = true;
    const gio = Gio as unknown as {
        _promisify: (proto: object, method: string, finish?: string) => void;
    };
    for (const [method, finish] of [
        ['screenshot', 'screenshot_finish'],
        ['screenshot_area', 'screenshot_area_finish'],
    ]) {
        try {
            gio._promisify(Shell.Screenshot.prototype, method, finish);
        } catch {
            // Already promisified.
        }
    }
}

interface AsyncScreenshot {
    screenshot(includeCursor: boolean, stream: Gio.OutputStream): Promise<unknown>;
    screenshot_area(x: number, y: number, width: number, height: number, stream: Gio.OutputStream): Promise<unknown>;
}

function pixbufFromBytes(bytes: GLib.Bytes): GdkPixbuf.Pixbuf {
    const input = Gio.MemoryInputStream.new_from_bytes(bytes);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(input, null);
    input.close(null);
    if (!pixbuf) {
        throw new Error('could not decode the screenshot');
    }
    return pixbuf;
}

/** Full stage capture, across all monitors. */
export async function captureScreen(): Promise<GdkPixbuf.Pixbuf> {
    ensurePromisified();
    const shooter = new Shell.Screenshot() as Shell.Screenshot & AsyncScreenshot;
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot(false, stream);
    stream.close(null);
    return pixbufFromBytes(stream.steal_as_bytes());
}

function stageSize(): [number, number] {
    return [global.stage.width, global.stage.height];
}

/** Capture a rectangle, clamped to the stage so a stale coordinate cannot throw. */
export async function captureRegion(
    x: number, y: number, width: number, height: number,
): Promise<GdkPixbuf.Pixbuf> {
    ensurePromisified();
    const [stageWidth, stageHeight] = stageSize();

    const cx = Math.max(0, Math.min(Math.round(x), stageWidth - 1));
    const cy = Math.max(0, Math.min(Math.round(y), stageHeight - 1));
    const cw = Math.max(1, Math.min(Math.round(width), stageWidth - cx));
    const ch = Math.max(1, Math.min(Math.round(height), stageHeight - cy));

    const shooter = new Shell.Screenshot() as Shell.Screenshot & AsyncScreenshot;
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot_area(cx, cy, cw, ch, stream);
    stream.close(null);
    return pixbufFromBytes(stream.steal_as_bytes());
}

// --- encoding for the LLM --------------------------------------------------

function scaleToWidth(pixbuf: GdkPixbuf.Pixbuf, maxWidth: number): GdkPixbuf.Pixbuf {
    const width = pixbuf.get_width();
    if (width <= maxWidth || maxWidth <= 0) {
        return pixbuf;
    }
    const height = Math.max(1, Math.round(pixbuf.get_height() * (maxWidth / width)));
    return pixbuf.scale_simple(maxWidth, height, GdkPixbuf.InterpType.BILINEAR) ?? pixbuf;
}

export interface EncodedImage {
    dataUri: string;
    mimeType: string;
    byteLength: number;
    width: number;
    height: number;
}

/**
 * Encode as PNG for the model. Lossless matters more here than it looks: a
 * screenshot is text and thin lines, exactly what JPEG smears, and at this size
 * PNG is both smaller and quicker to write than JPEG anyway. The compression
 * level is left at the default — level 9 buys under a percent for twice the
 * time, and this runs on the compositor thread.
 */
export function encodeForLlm(pixbuf: GdkPixbuf.Pixbuf, maxWidth: number): EncodedImage {
    const scaled = scaleToWidth(pixbuf, maxWidth);

    const [ok, buffer] = scaled.save_to_bufferv('png', [], []);
    if (!ok || !buffer) {
        throw new Error('could not encode the screenshot');
    }

    return {
        dataUri: `data:image/png;base64,${GLib.base64_encode(buffer)}`,
        mimeType: 'image/png',
        byteLength: buffer.length,
        width: scaled.get_width(),
        height: scaled.get_height(),
    };
}
