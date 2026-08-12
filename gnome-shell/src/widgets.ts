/**
 * The widgets the preferences window is built out of: entry rows, dropdowns,
 * the number field with its banded stepping, the ⓘ popover. All of it is
 * general — none of it knows what a macro is — which is why it lives here
 * rather than in the middle of the editor that uses it.
 *
 * Used only by the preferences window, but it imports nothing from the
 * Extensions app: no gettext at file scope, and so nothing that would go wrong
 * anywhere else.
 */

import type giCairo from '@girs/gjs/cairo';

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import { parseNumbers } from './model.js';

export function debounce(fn: () => void, ms = 400): () => void {
    let sourceId = 0;
    return () => {
        if (sourceId) {
            GLib.source_remove(sourceId);
        }
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            sourceId = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    };
}

/** Shared tail of entryRow and passwordRow: the initial text and a debounced commit. */
function commitOnChange(row: Adw.EntryRow, value: string, onChange: (text: string) => void): Adw.EntryRow {
    row.set_text(value);
    row.connect('changed', debounce(() => onChange(row.get_text() ?? '')));
    return row;
}

export function entryRow(title: string, value: string, onChange: (text: string) => void): Adw.EntryRow {
    return commitOnChange(new Adw.EntryRow({ title }), value, onChange);
}

/** An entry that masks what is typed with dots, for secrets; the reveal eye is built in. */
export function passwordRow(title: string, value: string, onChange: (text: string) => void): Adw.EntryRow {
    return commitOnChange(new Adw.PasswordEntryRow({ title }), value, onChange);
}

export function spinRow(
    title: string,
    value: number,
    lower: number,
    upper: number,
    step: number,
    onChange: (value: number) => void,
): Adw.SpinRow {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({ lower, upper, stepIncrement: step, value }),
    });
    row.connect('notify::value', () => onChange(row.get_value()));
    return row;
}

/** The labels a set of options shows, in the order they are offered. */
function optionModel(options: readonly string[], labels: Record<string, string>): Gtk.StringList {
    const model = new Gtk.StringList();
    for (const option of options) {
        model.append(labels[option] ?? option);
    }
    return model;
}

/**
 * Report picks from a list widget as the option itself rather than its index.
 * Tracked rather than compared against the initial value, so picking A, B, A
 * still reports the last change. The empty string is a real choice — "this
 * macro", "from the top" — so only out-of-range reads are dropped.
 */
function onPicked<T extends string>(
    widget: Adw.ComboRow | Gtk.DropDown,
    options: readonly T[],
    selected: T,
    onChange: (value: T) => void,
): void {
    let current = selected;
    widget.connect('notify::selected', () => {
        const value = options[widget.get_selected()];
        if (value !== undefined && value !== current) {
            current = value;
            onChange(value);
        }
    });
}

export function comboRow<T extends string>(
    title: string,
    options: readonly T[],
    labels: Record<string, string>,
    selected: T,
    onChange: (value: T) => void,
): Adw.ComboRow {
    const row = new Adw.ComboRow({
        title,
        model: optionModel(options, labels),
        selected: Math.max(0, options.indexOf(selected)),
    });
    onPicked(row, options, selected, onChange);
    return row;
}

/** 10^(digits before the point − 1): the size of one leading-digit step. */
function magnitudeOf(value: number): number {
    return Math.pow(10, Math.floor(Math.log10(value) + 1e-9));
}

/**
 * One leading digit at the current size is what a nudge moves by: 1 ms steps
 * under 10 ms, 10 ms steps to 90 ms, 100 ms steps under a second, whole
 * seconds to 9 s, tens to 90 s, and so on for as long as the range runs —
 * the finer the value, the finer the nudge. Off-band values round onto the
 * band in the direction pressed, and crossing a boundary lands exactly on it:
 * down from 100 is 90, not 0.
 */
function bandedUp(value: number): number {
    if (value < 0) {
        return -bandedDown(-value);
    }
    if (value === 0) {
        return 1;
    }
    const step = magnitudeOf(value);
    return (Math.floor(value / step + 1e-9) + 1) * step;
}

function bandedDown(value: number): number {
    if (value < 0) {
        return -bandedUp(-value);
    }
    if (value <= 1) {
        return 0;
    }
    const step = magnitudeOf(Math.max(value - 1, 1));
    return (Math.ceil(value / step - 1e-9) - 1) * step;
}

/** 200 → "0.2s", 20 → "20ms", 2500 → "2.5s": how a time field shows itself. */
function formatMsUnits(ms: number): string {
    if (Math.abs(ms) < 100) {
        return `${ms}ms`;
    }
    return `${Number.parseFloat((ms / 1000).toFixed(3))}s`;
}

/** "0.2s" → 200, "20ms" → 20, and a bare "200" is milliseconds. */
function parseMsUnits(text: string): number | null {
    const match = text.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*(ms|s)?$/i);
    if (!match) {
        return null;
    }
    const number = Number.parseFloat(match[1].replace(',', '.'));
    if (!Number.isFinite(number)) {
        return null;
    }
    return Math.round(match[2]?.toLowerCase() === 's' ? number * 1000 : number);
}

/**
 * The number half of spinRow, without the row, for when it belongs beside
 * another setting instead of on a line of its own. Whole numbers only — every
 * one of these counts something: milliseconds, pixels, how far off a colour is.
 *
 * Not a GtkSpinButton: the whole point is the banded stepping above, and a spin
 * button's increment is fixed per widget, not per press. With `timeUnits` the
 * field speaks human time — shows 0.2s rather than 200, reads "300ms", "0.5s"
 * and bare milliseconds.
 */
export function spinSuffix(
    value: number,
    lower: number,
    upper: number,
    tooltip: string,
    onChange: (value: number) => void,
    timeUnits = false,
): Gtk.Widget {
    const clamp = (v: number) => Math.max(lower, Math.min(upper, Math.round(v)));
    let current = clamp(value);
    const show = (v: number) => timeUnits ? formatMsUnits(v) : `${v}`;
    const parse = (text: string) => {
        if (timeUnits) {
            return parseMsUnits(text);
        }
        const parsed = Number.parseInt(text.trim(), 10);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const entry = new Gtk.Entry({
        text: show(current),
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        xalign: 1,
        input_purpose: Gtk.InputPurpose.DIGITS,
        // Sized to the largest number it can hold, plus a minus sign where
        // there can be one, but capped: a wait may run to an hour, and a field
        // sized for 3600000 is a wide field on every row that a wait is not.
        // Past the cap it scrolls — the value stays whole, only its widest end
        // is out of view, and that end is the rare one. Time fields get one
        // more, for the unit: "0.25s" is five.
        width_chars: Math.min(timeUnits ? 5 : 4, Math.max(3, `${upper}`.length + (lower < 0 ? 1 : 0))),
        max_width_chars: Math.min(timeUnits ? 5 : 4, Math.max(3, `${upper}`.length + (lower < 0 ? 1 : 0))),
    });

    /** What the field says right now, for the nudge to step from — the typed
     * text when it parses, the last good value when it does not. */
    const read = () => {
        const parsed = parse(entry.get_text() ?? '');
        return parsed !== null ? clamp(parsed) : current;
    };
    const commit = (next: number) => {
        current = clamp(next);
        entry.set_text(show(current));
        onChange(current);
    };
    // Typing commits after a pause, so half-typed numbers do not fire.
    const typed = debounce(() => {
        const parsed = parse(entry.get_text() ?? '');
        if (parsed !== null && clamp(parsed) === parsed && parsed !== current) {
            current = parsed;
            onChange(current);
        }
    });
    entry.connect('changed', typed);
    entry.connect('activate', () => commit(read()));

    const minus = new Gtk.Button({ label: '−', tooltip_text: tooltip });
    const plus = new Gtk.Button({ label: '+', tooltip_text: tooltip });
    minus.connect('clicked', () => commit(bandedDown(read())));
    plus.connect('clicked', () => commit(bandedUp(read())));

    const box = new Gtk.Box({
        valign: Gtk.Align.CENTER,
        css_classes: ['linked', 'macroclickwerk-spin'],
    });
    box.append(entry);
    box.append(minus);
    box.append(plus);
    return box;
}

/**
 * A label factory for GtkDropDown. The button and the popup want different
 * things from the same strings — the button must not grow the window, the list
 * must stay readable — so each gets its own.
 */
function labelFactory(forButton: boolean, maxChars: number): Gtk.SignalListItemFactory {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, item: Gtk.ListItem) => {
        item.set_child(new Gtk.Label({
            xalign: forButton ? 1 : 0,
            ellipsize: forButton ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE,
            max_width_chars: forButton ? maxChars : -1,
        }));
    });
    factory.connect('bind', (_f, item: Gtk.ListItem) => {
        const label = item.get_child() as Gtk.Label;
        label.set_label((item.get_item() as Gtk.StringObject).get_string() ?? '');
    });
    return factory;
}

/**
 * The chooser half of comboRow, without the row, for when it belongs beside
 * another setting instead of on a line of its own. Same change tracking.
 *
 * A dropdown is as wide as its widest entry, and these sit on rows that are
 * already full, so the button is capped and ellipsized — a macro called
 * something long, or a step described at length, would otherwise set the width
 * of the whole window. The popup still shows every label whole.
 */
export function chooser<T extends string>(
    options: readonly T[],
    labels: Record<string, string>,
    selected: T,
    tooltip: string,
    onChange: (value: T) => void,
    maxChars = 22,
): Gtk.DropDown {
    const dropdown = new Gtk.DropDown({
        model: optionModel(options, labels),
        selected: Math.max(0, options.indexOf(selected)),
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        factory: labelFactory(true, maxChars),
        list_factory: labelFactory(false, maxChars),
    });
    onPicked(dropdown, options, selected, onChange);
    return dropdown;
}

/** A bare entry for a row suffix, where an EntryRow would be a whole row. */
export function suffixEntry(
    text: string, placeholder: string, tooltip: string,
    onChange: (text: string) => void,
): Gtk.Entry {
    const entry = new Gtk.Entry({
        text,
        placeholder_text: placeholder,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        width_chars: 9,
    });
    entry.connect('changed', () => onChange(entry.get_text() ?? ''));
    return entry;
}

/** The block of colour beside a hex field, in pixels. */
const SWATCH_W = 28;
const SWATCH_H = 20;

/**
 * What the colour in a field actually looks like, beside the field: `#22aa33`
 * is a number, and a number is not a colour you can recognise. Painted rather
 * than styled, so it can follow the text as it is typed without a stylesheet
 * per row, and read through a callback rather than given a value, so it shows
 * what is in the field now and not what was in it when the row was built.
 *
 * Text that is not a colour — half-typed, or a word — draws as an empty
 * outline. It says "nothing yet" without claiming a colour that is not there.
 */
export function colorSwatch(read: () => string, tooltip: string): Gtk.DrawingArea {
    const area = new Gtk.DrawingArea({
        // Both: the content size is what it asks for, the request is what it
        // will not be squeezed below. A block of colour that a full row has
        // shrunk to nothing is not saying anything.
        content_width: SWATCH_W,
        content_height: SWATCH_H,
        width_request: SWATCH_W,
        height_request: SWATCH_H,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
    });
    // GTK hands over the plain introspected context; the methods a drawing
    // callback is written in are the ones GJS puts on it, which the generated
    // type does not know about.
    area.set_draw_func((_area, context, width, height) => {
        // `$dispose` is GJS's own, and not in the generated type either: the
        // context holds a drawing surface, and letting the collector decide
        // when to let go of it is how a redraw on every keystroke adds up.
        const cr = context as giCairo.Context & { $dispose(): void };
        const rgba = new Gdk.RGBA();
        if (rgba.parse(read().trim())) {
            cr.setSourceRGB(rgba.red, rgba.green, rgba.blue);
            cr.rectangle(0, 0, width, height);
            cr.fill();
        }
        // Always outlined: a colour close to the row's own — white, or the
        // grey of a dark theme — is a block with no edges without it.
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.7);
        cr.setLineWidth(1);
        cr.rectangle(0.5, 0.5, width - 1, height - 1);
        cr.stroke();
        cr.$dispose();
    });
    return area;
}

/**
 * The same thing for a line of text: every colour named in it gets a block of
 * that colour after it, so a summary reading `pixel 840,512 ≈ #22aa33` says
 * which green it means. Returns Pango markup, which is what row titles and
 * subtitles are read as — so the text around it is escaped here, it being a
 * macro's name and a model prompt, which is to say anything at all.
 */
export function withColorSwatches(text: string): string {
    return GLib.markup_escape_text(text, -1).replace(
        /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi,
        hex => `${hex} <span bgcolor="${hex}" fgcolor="${hex}">██</span>`);
}

export function iconButton(iconName: string, tooltip: string, onClick: () => void): Gtk.Button {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', onClick);
    return button;
}

/** The toggle sibling of `iconButton`: same flat row-suffix styling. */
export function toggleButton(iconName: string, tooltip: string, active: boolean): Gtk.ToggleButton {
    return new Gtk.ToggleButton({
        icon_name: iconName,
        tooltip_text: tooltip,
        active,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
}

/** A class held while something is true — the shape every state repaint has. */
export function setClass(widget: Gtk.Widget, cls: string, on: boolean): void {
    if (on) {
        widget.add_css_class(cls);
    } else {
        widget.remove_css_class(cls);
    }
}

/** Take a whole set of state classes off, whichever of them is on. */
export function clearClasses(widget: Gtk.Widget | null | undefined, classes: readonly string[]): void {
    for (const cls of classes) {
        widget?.remove_css_class(cls);
    }
}

/**
 * Every widget under this one, depth first. Some of what libadwaita builds —
 * the clamp inside a page, the scrolled window inside that — is internal and
 * has no property pointing at it, so it is found by looking.
 */
export function* descendants(widget: Gtk.Widget | null): Generator<Gtk.Widget> {
    for (let child = widget?.get_first_child() ?? null; child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

/**
 * Parse a field of numbers as it is typed, marking it when it does not read —
 * shared by the numbers row and the numbers entry, which differ only in being
 * a row and not being one. Returns the last set that parsed, for the buttons
 * beside the field that act on what is in it.
 */
export function commitNumbers(
    field: Gtk.Widget & Gtk.Editable,
    count: number,
    values: number[],
    onChange: (values: number[]) => void,
): () => number[] {
    let current = [...values];
    const commit = debounce(() => {
        const parsed = parseNumbers(field.get_text() ?? '', count);
        setClass(field, 'error', !parsed);
        if (parsed) {
            current = parsed;
            onChange(parsed);
        }
    });
    field.connect('changed', commit);
    return () => current;
}

/** As tall as a popover is allowed to get before its text starts scrolling. */
const POPOVER_MAX_H = 420;

/**
 * A ⓘ that opens a popover. For guidance too long for a subtitle and too small
 * for documentation nobody opens, kept next to the field it is about.
 *
 * The text scrolls. A label alone cannot be made shorter than its own wrapped
 * height, so a long one gives the popover a minimum size it cannot meet next to
 * a row near the edge of the screen — and a popover with nowhere to go simply
 * does not appear, which reads as a dead button.
 */
export function infoButton(tooltip: string, markup: string, width = 46): Gtk.MenuButton {
    const label = new Gtk.Label({
        label: markup,
        use_markup: true,
        wrap: true,
        xalign: 0,
        max_width_chars: width,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    const scroller = new Gtk.ScrolledWindow({
        child: label,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_width: true,
        propagate_natural_height: true,
        max_content_height: POPOVER_MAX_H,
    });
    return new Gtk.MenuButton({
        icon_name: 'help-about-symbolic',
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        popover: new Gtk.Popover({ child: scroller }),
    });
}
