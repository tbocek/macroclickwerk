// The macro document model. Pure data + helpers, no GNOME Shell imports, so it
// can be used from both the shell process and the preferences process.

import GLib from 'gi://GLib';

import { reportProblem } from './problems.js';

export const DOCUMENT_VERSION = 1;

// --- conditions ------------------------------------------------------------

export interface Region {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface AlwaysCondition {
    type: 'always';
}

/**
 * The other half of `always`. It is also what an empty document means nowhere:
 * a condition is missing only in the "no test, run it" direction, so this one
 * has to be asked for by name.
 */
export interface NeverCondition {
    type: 'never';
}

export interface LlmCondition {
    type: 'llm';
    prompt: string;
    /** null/undefined means "the whole screen". */
    region?: Region | null;
}

/**
 * A colour check over a screen area: what that area averages to, against the
 * colour it averaged to when it was picked, within `tolerance`. A 1×1 area
 * averages to its own pixel, so the single-pixel check is the same check.
 */
export interface ColorCondition {
    type: 'color';
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    /** How far the average may be from `color`, as an RGB distance. */
    tolerance: number;
}

export interface AndCondition {
    type: 'and';
    of: Condition[];
}

export interface OrCondition {
    type: 'or';
    of: Condition[];
}

export interface NotCondition {
    type: 'not';
    of: Condition;
}

export type Condition =
    | AlwaysCondition
    | NeverCondition
    | LlmCondition
    | ColorCondition
    | AndCondition
    | OrCondition
    | NotCondition;

export type ConditionType = Condition['type'];

// --- steps -----------------------------------------------------------------

export type MouseButton = 'left' | 'right' | 'middle' | 'side' | 'extra';

export interface RawEvent {
    /** Microseconds to wait before this event. */
    dt: number;
    type: number;
    code: number;
    value: number;
    /**
     * Whether the daemon appends SYN_REPORT after this event. Defaults to true;
     * set false to group several events into one input report, e.g. the X and Y
     * halves of a single pointer move.
     */
    syn?: boolean;
}

interface StepCommon {
    id: string;
}

/**
 * How long a step that acts on the game waits after itself, before the next
 * step starts. A game reads input once a frame, on its own schedule; two
 * actions in the same millisecond can both land before it looks, and it sees
 * only the last. Absent or 0 is no wait — a step goes straight on, as it
 * always did.
 */
interface ThenWait {
    afterMs?: number;
}

export type ClickStep = StepCommon & ThenWait & {
    kind: 'click';
    button: MouseButton;
    /** 'abs' moves to x/y first, 'current' clicks wherever the pointer is. */
    mode: 'abs' | 'current';
    x?: number;
    y?: number;
    /**
     * 'tap' is the whole click, down then up after holdMs; the halves exist
     * for flows where what happens between the down and the up is other steps.
     * Absent means take it from the event: a click under an `onevent` goes
     * down when the person pressed and comes up when they let go, and falls
     * back to a whole tap when no event woke the run. That is the editor's
     * Follow toggle, which only appears under an event. See `followsEvent`.
     */
    action?: 'tap' | 'down' | 'up';
    holdMs?: number;
};

export type MoveStep = StepCommon & ThenWait & {
    kind: 'move';
    /** 'abs' moves to x/y, 'rel' by dx/dy from wherever the pointer is. */
    mode: 'abs' | 'rel';
    x?: number;
    y?: number;
    dx?: number;
    dy?: number;
};

export type ScrollStep = StepCommon & ThenWait & {
    kind: 'scroll';
    dx: number;
    dy: number;
};

export type KeyStep = StepCommon & ThenWait & {
    kind: 'key';
    /** evdev key name, e.g. KEY_E. */
    code: string;
    /** As a click's, including absent meaning "take it from the event". */
    action?: 'tap' | 'down' | 'up';
    /** Modifier key names held around the key, e.g. ['KEY_LEFTCTRL']. */
    mods?: string[];
    holdMs?: number;
};

export type TextStep = StepCommon & ThenWait & {
    kind: 'text';
    value: string;
    /** Delay between characters. */
    delayMs?: number;
};

export type WaitStep = StepCommon & {
    kind: 'wait';
    ms: number;
    jitterMs?: number;
};

/**
 * Wait until a button or key changes, then go on. While a run is parked here
 * the daemon consumes that button, so the desktop only ever sees what the
 * steps after it do — press the side button, get the macro instead.
 */
export type OnEventStep = StepCommon & {
    kind: 'onevent';
    /** evdev name of what is waited for: BTN_SIDE, KEY_F13, … */
    source: string;
    /**
     * Which edge wakes the run. 'either' — the default, and what absent means
     * — takes the next one whichever it is, so the first such step in a flow
     * catches the press and the next one the release: a hold is two of them
     * around whatever it should do, and the steps between follow the finger.
     * 'press' and 'release' wait for that one edge and sleep through the
     * other, which is how a flow says "only when they let go", and how the
     * two halves of a hold are written out explicitly rather than by order.
     */
    edge?: EventEdge;
};

/** @see OnEventStep.edge */
export type EventEdge = 'press' | 'release' | 'either';

/** The edges an `onevent` can wait for, in the order they are offered. */
export const EVENT_EDGES: readonly EventEdge[] = ['either', 'press', 'release'];

/**
 * A loop, and nothing else. It has no condition of its own: `loop while C` is
 * exactly `loop forever: [if not C: break, …]`, and expressing it that way keeps
 * conditions in one place — inside `if` — instead of two.
 */
export type LoopStep = StepCommon & {
    kind: 'loop';
    /** Iteration cap, or 'forever' for none. */
    count: number | 'forever';
    body: Step[];
};

export type IfStep = StepCommon & {
    kind: 'if';
    cond: Condition;
    then: Step[];
    else?: Step[];
};

export type FlowStep = StepCommon & {
    kind: 'break' | 'continue';
};

/**
 * Reaching out of this macro into another one, by id. Empty means this macro,
 * so `stop` on its own is the plain "stop here" it has always been and `start`
 * on its own is "begin again from the top".
 *
 * `start` on a macro that is already running restarts it: there is one run per
 * macro, and asking for it while it is going can only mean from the beginning.
 */
export type MacroStep = StepCommon & {
    kind: 'start' | 'stop';
    macro?: string;
    /**
     * For `start`: the step to begin at, empty for the top. Starting always
     * ends the run already going first, so a start pointing into its own macro
     * is a jump — stop whatever this run is on, continue from the named step.
     * A step that has since been deleted falls back to the top, the same
     * bargain as `resolveRunStart`: a stale reference costs a move, not a run.
     */
    at?: string;
};

export type Step =
    | ClickStep
    | MoveStep
    | ScrollStep
    | KeyStep
    | TextStep
    | WaitStep
    | OnEventStep
    | LoopStep
    | IfStep
    | FlowStep
    | MacroStep;

export type StepKind = Step['kind'];

export interface Macro {
    id: string;
    name: string;
    /**
     * Whether Run starts this one. Several can be on at once, and they run
     * alongside each other. Absent counts as on, so a macro written before this
     * flag existed still runs — the store turns the older documents into
     * explicit flags once, on the way in.
     */
    enabled?: boolean;
    /**
     * Whether this one takes turns with the others that do — see `Turn`.
     * Absent counts as yes; one that does not acts whenever it likes, and
     * neither waits for the turn nor holds anyone else up.
     */
    exclusive?: boolean;
    /**
     * The file of the collection this macro belongs to, when it was loaded
     * from one or put into one — see `loadCollection`. Absent: in no
     * collection. Never written into a collection's own file.
     */
    collection?: string;
    body: Step[];
}

/** Absent means yes: see `Macro.exclusive`. */
export function macroExclusive(macro: Macro): boolean {
    return macro.exclusive !== false;
}

/** Absent means on: see `Macro.enabled`. */
export function macroEnabled(macro: Macro): boolean {
    return macro.enabled !== false;
}

/**
 * Ids whose steps are no longer what they were, counting a macro that has gone
 * from the document. Name and on/off are deliberately not in it: renaming a
 * macro, or switching a different one off, says nothing about what this one is
 * doing right now, and a run should survive both.
 */
export function changedDefinitions(before: Macro[], after: Macro[]): Set<string> {
    const now = new Map(after.map(macro => [macro.id, JSON.stringify(macro.body)]));
    const changed = new Set<string>();
    for (const macro of before) {
        // An id that is gone reads as `undefined` here, which no body matches.
        if (now.get(macro.id) !== JSON.stringify(macro.body)) {
            changed.add(macro.id);
        }
    }
    return changed;
}

export interface MacroDocument {
    version: number;
    macros: Macro[];
    /**
     * The collections loaded, in the order they were loaded, with what each
     * held when last loaded or saved.
     */
    collections?: CollectionRef[];
    /**
     * Names for places on the screen: points, and areas. The name belongs to
     * the coordinates, not to any step, so everything aimed there shares it —
     * a click or move at a point, or at the middle of an area, and a check
     * over exactly that area.
     */
    points?: NamedPoint[];
}

/** A named point — or a named area, when it has a size. */
export interface NamedPoint {
    name: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
}

/** A place to name: a point, or an area with its size. */
export type Place = Omit<NamedPoint, 'name'>;

/** A loaded collection: its file, and what it held when last loaded or saved. */
export interface CollectionRef {
    path: string;
    /** Checksum of `collectionText` at the last load or save — see `collectionUnsaved`. */
    saved: string;
    /**
     * Switched off: its macros are out of the editor and do not run, by Run,
     * a shortcut or a Start — kept, not forgotten, until it is switched on.
     */
    off?: boolean;
}

// --- collections ------------------------------------------------------------

/** What a collection is called: its file's name, without the .json. */
export function collectionName(path: string): string {
    const file = path.split('/').pop() ?? path;
    return file.replace(/\.json$/i, '') || file;
}

/**
 * The files of the loaded collections, in the order they were loaded. One
 * left with no macros is not one any more: there is nothing in it to show.
 */
export function collectionPaths(doc: MacroDocument): string[] {
    return (doc.collections ?? []).map(ref => ref.path)
        .filter(path => doc.macros.some(macro => macro.collection === path));
}

/**
 * Forget the collections left with no macros — before one comes in at a path
 * that may have been one, so it starts afresh: on, and saved as it is.
 */
export function forgetEmptyCollections(doc: MacroDocument): void {
    doc.collections = (doc.collections ?? []).filter(ref => doc.macros.some(macro => macro.collection === ref.path));
}

/** Whether a collection is switched on. */
export function collectionOn(doc: MacroDocument, path: string): boolean {
    return (doc.collections ?? []).find(ref => ref.path === path)?.off !== true;
}

export function setCollectionOn(doc: MacroDocument, path: string, on: boolean): void {
    for (const ref of doc.collections ?? []) {
        if (ref.path === path) {
            if (on) {
                delete ref.off;
            } else {
                ref.off = true;
            }
        }
    }
}

/** A macro of a collection switched off is out of the editor and does not run. */
export function macroLive(doc: MacroDocument, macro: Macro): boolean {
    return !macro.collection || collectionOn(doc, macro.collection);
}

function digest(text: string): string {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1) ?? text;
}

/** Whether a collection's macros have changed since it was last loaded or saved. */
export function collectionUnsaved(doc: MacroDocument, path: string): boolean {
    const ref = (doc.collections ?? []).find(other => other.path === path);
    return !ref || ref.saved !== digest(collectionText(doc, path));
}

/** Note that a collection has just been written to its file as it is now. */
export function markCollectionSaved(doc: MacroDocument, path: string): void {
    const ref = (doc.collections ?? []).find(other => other.path === path);
    if (ref) {
        ref.saved = digest(collectionText(doc, path));
    } else {
        doc.collections = [...(doc.collections ?? []), { path, saved: digest(collectionText(doc, path)) }];
    }
}

/** The macros of one collection, in the order the editor shows them. */
export function macrosOf(doc: MacroDocument, path: string): Macro[] {
    return doc.macros.filter(macro => macro.collection === path);
}

/**
 * A collection as its file holds it: the same form as an export of macros, so
 * either can be loaded as the other. Without the membership, which is the
 * editor's business and would only be wrong on another machine.
 */
export function collectionText(doc: MacroDocument, path: string): string {
    const macros = macrosOf(doc, path).map(({ collection: _collection, ...macro }) => macro);
    const points = pointsUsedBy(doc, macros);
    return JSON.stringify({ version: DOCUMENT_VERSION, macros, ...(points.length > 0 ? { points } : {}) }, null, 2);
}

/**
 * Give a set of macros fresh ids — the macros and every step in them — and
 * carry the references among them along: a Start or Stop naming one of them,
 * and a Start's step to begin at. References that point outside the set are
 * left as they are.
 *
 * With `taken`, only the ids that are taken — or used twice in the set — are
 * renewed, so whatever else points at the rest still finds it.
 */
export function freshIds(macros: Macro[], taken?: Set<string>): void {
    const ids = new Map<string, string>();
    const used = new Set(taken);
    const met = new Set<string>();
    const give = (id: string): string => {
        const keep = taken !== undefined && !used.has(id);
        const next = keep ? id : newId();
        used.add(next);
        // A reference means the first of the ids it names.
        if (!met.has(id)) {
            met.add(id);
            if (!keep) {
                ids.set(id, next);
            }
        }
        return next;
    };
    for (const macro of macros) {
        macro.id = give(macro.id);
        walk(macro.body, ({ step }) => { step.id = give(step.id); });
    }
    for (const macro of macros) {
        walk(macro.body, ({ step }) => {
            if (step.kind === 'start' || step.kind === 'stop') {
                if (step.macro && ids.has(step.macro)) {
                    step.macro = ids.get(step.macro);
                }
                if (step.kind === 'start' && step.at && ids.has(step.at)) {
                    step.at = ids.get(step.at);
                }
            }
        });
    }
}

/**
 * Add a collection's macros to the document, marked as coming from `path`.
 * Ids already taken — the same file loaded under two names, say — are renewed,
 * so nothing in the document is ever named twice. Throws when `path` is
 * already loaded or holds no macros; returns how many macros came in.
 */
export function loadCollection(doc: MacroDocument, path: string, text: string): number {
    if (collectionPaths(doc).includes(path)) {
        throw new Error(`“${collectionName(path)}” is already loaded`);
    }
    forgetEmptyCollections(doc);
    // Checked here rather than left to parseDocument, which makes an empty
    // document of anything else — and Save would then write that over the file.
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        raw = null;
    }
    if (!Array.isArray((raw as Partial<MacroDocument> | null)?.macros)) {
        throw new Error('this is not a file of macros');
    }
    const file = parseDocument(text);
    const loaded = file.macros;
    if (loaded.length === 0) {
        throw new Error('there are no macros in it');
    }
    // Its named points come along, unless the name or the spot already has
    // one here: what is already named stays as it is. Then the file no longer
    // says what the editor shows, and the collection starts out unsaved.
    let asInFile = true;
    for (const point of file.points ?? []) {
        const points = doc.points ?? [];
        const clash = points.find(p => p.name === point.name || samePlace(p, point));
        if (!clash) {
            doc.points = [...points, point];
        } else if (clash.name !== point.name || !samePlace(clash, point)) {
            asInFile = false;
        }
    }
    const taken = new Set<string>();
    for (const macro of doc.macros) {
        taken.add(macro.id);
        walk(macro.body, ({ step }) => { taken.add(step.id); });
    }
    freshIds(loaded, taken);
    for (const macro of loaded) {
        macro.collection = path;
    }
    doc.macros.push(...loaded);
    if (asInFile) {
        markCollectionSaved(doc, path);
    } else {
        doc.collections = [...(doc.collections ?? []), { path, saved: '' }];
    }
    return loaded.length;
}

/**
 * The collection now lives at another file — a Save as — and its macros go
 * with it. Its place in the list stays.
 */
export function renameCollection(doc: MacroDocument, from: string, to: string): void {
    for (const macro of macrosOf(doc, from)) {
        macro.collection = to;
    }
    for (const ref of doc.collections ?? []) {
        if (ref.path === from) {
            ref.path = to;
        }
    }
}

/**
 * Move a macro one place up (-1) or down (1) among the macros the editor
 * shows, past any of a collection switched off; false at either end.
 */
export function moveMacro(doc: MacroDocument, id: string, delta: 1 | -1): boolean {
    const index = doc.macros.findIndex(macro => macro.id === id);
    let target = index + delta;
    while (target >= 0 && target < doc.macros.length && !macroLive(doc, doc.macros[target])) {
        target += delta;
    }
    if (index < 0 || target < 0 || target >= doc.macros.length) {
        return false;
    }
    const [macro] = doc.macros.splice(index, 1);
    doc.macros.splice(target, 0, macro);
    return true;
}

/**
 * A copy of a macro under fresh ids, placed right after it. A Start or Stop
 * in it that named the original names the copy, so a macro that restarts
 * itself still does.
 */
export function copyMacro(doc: MacroDocument, id: string, collection?: string): Macro | null {
    const index = doc.macros.findIndex(macro => macro.id === id);
    if (index < 0) {
        return null;
    }
    const copy: Macro = JSON.parse(JSON.stringify(doc.macros[index]));
    freshIds([copy]);
    copy.name = `${copy.name} (copy)`;
    copy.collection = collection;
    doc.macros.splice(index + 1, 0, copy);
    return copy;
}

// --- named points -------------------------------------------------------------

/** Whether two places are the same: the same point, or the same area. */
function samePlace(a: Place, b: Place): boolean {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Where a click aimed at a place lands: the point, or the middle of the area. */
export function placeCentre(place: Place): { x: number; y: number } {
    return place.w === undefined || place.h === undefined
        ? { x: place.x, y: place.y }
        : { x: place.x + Math.floor(place.w / 2), y: place.y + Math.floor(place.h / 2) };
}

/** The stored points and areas, tolerantly; first of a name or a place wins. */
function cleanPoints(raw: unknown): NamedPoint[] {
    const points: NamedPoint[] = [];
    for (const point of Array.isArray(raw) ? raw : []) {
        const { name, x, y, w, h } = (point ?? {}) as Partial<NamedPoint>;
        const area = Number.isFinite(w) && Number.isFinite(h) && w! > 0 && h! > 0;
        const place: NamedPoint = { name: (name ?? '').trim(), x: x!, y: y!, ...(area ? { w, h } : {}) };
        if (typeof name === 'string' && place.name !== '' && Number.isFinite(x) && Number.isFinite(y) &&
            !points.some(p => p.name === place.name || samePlace(p, place))) {
            points.push(place);
        }
    }
    return points;
}

/** The named place a click or move at x, y is aimed at: a point there, or an area with its middle there. */
export function pointAt(doc: MacroDocument, x: number | undefined, y: number | undefined): NamedPoint | undefined {
    const points = doc.points ?? [];
    return points.find(point => point.w === undefined && point.x === x && point.y === y)
        ?? points.find(point => {
            if (point.w === undefined) {
                return false;
            }
            const centre = placeCentre(point);
            return centre.x === x && centre.y === y;
        });
}

/** The named area that is exactly this one, if there is one. */
export function areaAt(doc: MacroDocument, area: Region | null | undefined): NamedPoint | undefined {
    return area ? (doc.points ?? []).find(point => point.w !== undefined && samePlace(point, area)) : undefined;
}

/**
 * Name a place. One that has a name already is renamed; an empty name takes
 * the name away. Returns why not, when the name is already another place's —
 * a name means one place.
 */
export function namePlace(doc: MacroDocument, place: Place, name: string): string | null {
    const wanted = name.trim();
    const points = doc.points ?? [];
    const here = points.find(point => samePlace(point, place));
    if (wanted === '') {
        doc.points = points.filter(point => point !== here);
        return null;
    }
    const taken = points.find(point => point.name === wanted && point !== here);
    if (taken) {
        return livePoints(doc).includes(taken)
            ? `“${wanted}” is already another place`
            : `“${wanted}” is already a place in a collection that is switched off`;
    }
    if (here) {
        here.name = wanted;
    } else {
        const { x, y, w, h } = place;
        doc.points = [...points, { name: wanted, x, y, ...(w !== undefined && h !== undefined ? { w, h } : {}) }];
    }
    return null;
}

/** The areas the checks of a condition look at, as the objects that hold them. */
function conditionAreas(cond: Condition | null | undefined): Region[] {
    if (!cond) {
        return [];
    }
    switch (cond.type) {
        case 'llm':
            return cond.region ? [cond.region] : [];
        case 'color':
            return [cond];
        case 'and':
        case 'or':
            return cond.of.flatMap(conditionAreas);
        case 'not':
            return conditionAreas(cond.of);
        default:
            return [];
    }
}

/** Every click and move aimed at x, y, and every area a check looks at, in these macros. */
function eachAim(macros: Macro[], onSpot: (step: { x?: number; y?: number }) => void, onArea: (area: Region) => void): void {
    for (const macro of macros) {
        walk(macro.body, ({ step }) => {
            if ((step.kind === 'click' || step.kind === 'move') && step.mode === 'abs') {
                onSpot(step);
            } else if (step.kind === 'if') {
                conditionAreas(step.cond).forEach(onArea);
            }
        });
    }
}

/**
 * Move a named place, and everything aimed at it along with it — a click or
 * move at the point or the middle of the area, a check over the area — in
 * every macro, switched off or not, since the name is the place and nothing
 * should be left at the old one. Returns why not, when another name already
 * has that place.
 */
export function movePoint(doc: MacroDocument, name: string, to: Place): string | null {
    const point = (doc.points ?? []).find(each => each.name === name);
    if (!point) {
        return `there is no place “${name}”`;
    }
    const there = (doc.points ?? []).find(each => samePlace(each, to));
    if (there && there !== point) {
        return `that place is already “${there.name}”`;
    }
    const from = placeCentre(point);
    const centre = placeCentre(to);
    eachAim(doc.macros, step => {
        // Only what shows this name: a point and an area can share a middle.
        if (step.x === from.x && step.y === from.y && pointAt(doc, step.x, step.y) === point) {
            step.x = centre.x;
            step.y = centre.y;
        }
    }, area => {
        if (point.w !== undefined && to.w !== undefined && to.h !== undefined && samePlace(area, point)) {
            Object.assign(area, { x: to.x, y: to.y, w: to.w, h: to.h });
        }
    });
    Object.assign(point, { x: to.x, y: to.y });
    if (point.w !== undefined) {
        Object.assign(point, { w: to.w, h: to.h });
    }
    return null;
}

/**
 * The named places to offer: all but those only macros of a collection
 * switched off are aimed at — they are its names, and go with it.
 */
export function livePoints(doc: MacroDocument): NamedPoint[] {
    const off = pointsUsedBy(doc, doc.macros.filter(macro => !macroLive(doc, macro)));
    const on = pointsUsedBy(doc, doc.macros.filter(macro => macroLive(doc, macro)));
    return (doc.points ?? []).filter(point => !off.includes(point) || on.includes(point));
}

/** The named places that clicks, moves and checks in these macros are aimed at. */
function pointsUsedBy(doc: MacroDocument, macros: Macro[]): NamedPoint[] {
    const used = new Set<NamedPoint | undefined>();
    eachAim(macros, step => used.add(pointAt(doc, step.x, step.y)), area => used.add(areaAt(doc, area)));
    return (doc.points ?? []).filter(point => used.has(point));
}

// --- construction ----------------------------------------------------------

export function newId(): string {
    return GLib.uuid_string_random();
}

export function emptyDocument(): MacroDocument {
    return { version: DOCUMENT_VERSION, macros: [] };
}

export function newMacro(name = 'New macro'): Macro {
    return { id: newId(), name, enabled: true, body: [] };
}

export function newCondition(type: ConditionType): Condition {
    switch (type) {
        case 'llm':
            return {
                type: 'llm',
                // A statement, not a question: it is what the model is asked to
                // call true or false, and it is the example every new condition
                // starts from.
                prompt: 'the button on the left is green',
                region: null,
            };
        case 'color':
            return {
                type: 'color',
                x: 0, y: 0, w: 1, h: 1,
                color: '#22aa33', tolerance: 24,
            };
        case 'and':
            return { type: 'and', of: [] };
        case 'or':
            return { type: 'or', of: [] };
        case 'not':
            return { type: 'not', of: { type: 'always' } };
        case 'never':
            return { type: 'never' };
        case 'always':
        default:
            return { type: 'always' };
    }
}

export function newStep(kind: StepKind): Step {
    const id = newId();
    switch (kind) {
        case 'click':
            return { id, kind: 'click', button: 'left', mode: 'abs', x: 0, y: 0, holdMs: 20 };
        case 'move':
            return { id, kind: 'move', mode: 'abs', x: 0, y: 0 };
        case 'scroll':
            return { id, kind: 'scroll', dx: 0, dy: -1 };
        case 'key':
            return { id, kind: 'key', code: 'KEY_E', action: 'tap', mods: [], holdMs: 20 };
        case 'text':
            return { id, kind: 'text', value: '', delayMs: 12 };
        case 'wait':
            return { id, kind: 'wait', ms: 1000, jitterMs: 0 };
        case 'onevent':
            return { id, kind: 'onevent', source: 'BTN_SIDE' };
        case 'loop':
            return { id, kind: 'loop', count: 'forever', body: [] };
        case 'if':
            return { id, kind: 'if', cond: newCondition('color'), then: [], else: [] };
        case 'break':
        case 'continue':
            return { id, kind };
        case 'start':
        case 'stop':
            // Empty is this macro: a stop that stops the run it is in, and a
            // start that begins it again. Pick another one and it reaches over.
            return { id, kind, macro: '' };
    }
}

/** The kinds that hold nested step lists, in the order the UI should show them. */
export function childLists(step: Step): { key: string; steps: Step[] }[] {
    switch (step.kind) {
        case 'loop':
            return [{ key: 'body', steps: step.body }];
        case 'if':
            // Materialise the else branch: callers push into these arrays, and a
            // `?? []` fallback would silently swallow whatever they add.
            step.else ??= [];
            // No before Yes, which is the order the editor draws them in and so
            // the order everything that talks about "the first branch" means:
            // which branch an empty `if` takes a new step into.
            return [
                { key: 'else', steps: step.else },
                { key: 'then', steps: step.then },
            ];
        default:
            return [];
    }
}

// --- tree operations -------------------------------------------------------

export interface StepLocation {
    /** The list the step lives in (mutable reference into the document). */
    list: Step[];
    index: number;
    step: Step;
    depth: number;
}

/** Depth-first walk over every step in a list, including nested bodies. */
export function walk(
    list: Step[],
    visit: (loc: StepLocation) => void,
    depth = 0,
): void {
    list.forEach((step, index) => {
        visit({ list, index, step, depth });
        for (const child of childLists(step)) {
            walk(child.steps, visit, depth + 1);
        }
    });
}

/**
 * The chain of ids from the top of `list` down to `id`, outermost first, or an
 * empty array if the step is not in there. This is what lets a run start in the
 * middle of a nested body: the runner needs to know which loop and which branch
 * to descend into, not just which step to stop skipping at.
 */
export function pathToStep(list: Step[], id: string): string[] {
    for (const step of list) {
        if (step.id === id) {
            return [step.id];
        }
        for (const child of childLists(step)) {
            const inner = pathToStep(child.steps, id);
            if (inner.length > 0) {
                return [step.id, ...inner];
            }
        }
    }
    return [];
}

/**
 * Which "When …" step, if any, a step runs under — and so where its edge comes
 * from. A click or key press below an event need not decide for itself: left
 * without an action of its own it takes the edge the event brought, going down
 * when the person pressed and up when they let go. That is what makes "hold
 * the side button, hold E" a pair of steps rather than a guess at a duration.
 * The editor uses the answer to offer those steps the choice of following.
 *
 * Order is the order steps are written, which is the order they run: an event
 * covers everything after it, including the insides of a repeat or an if that
 * comes after it. A repeat also comes back round, so an event anywhere in its
 * body covers that whole body — on the second pass, every step in there is
 * below it.
 *
 * Answered for the whole macro in one pass, keyed by step id, because the
 * editor needs it for every row it draws: asking per row meant rescanning the
 * macro — and rescanning each repeat's body inside that — once per step.
 * Steps under no event are simply absent from the map.
 */
export function eventFollows(root: Step[]): Map<string, OnEventStep> {
    /** The last event in a list, at any depth: what a repeat's body comes back to. */
    const lastIn = (list: Step[]): OnEventStep | null => {
        let last: OnEventStep | null = null;
        for (const step of list) {
            for (const child of childLists(step)) {
                last = lastIn(child.steps) ?? last;
            }
            if (step.kind === 'onevent') {
                last = step;
            }
        }
        return last;
    };

    const under = new Map<string, OnEventStep>();
    const scan = (list: Step[], carried: OnEventStep | null): void => {
        let armed = carried;
        for (const step of list) {
            if (armed) {
                under.set(step.id, armed);
            }
            const wraps = step.kind === 'loop';
            for (const child of childLists(step)) {
                scan(child.steps, wraps ? lastIn(child.steps) ?? armed : armed);
            }
            if (step.kind === 'onevent') {
                armed = step;
            }
        }
    };
    scan(root, null);
    return under;
}

/** @see eventFollows — this is that answer for one step. */
export function followsEvent(root: Step[], stepId: string): OnEventStep | null {
    return eventFollows(root).get(stepId) ?? null;
}

/**
 * Where a step sits: its list, its index in it, and how deep that list is. Walks
 * only as far as the step — the editor asks this once per row, so scanning the
 * rest of the macro afterwards is work done for nobody.
 */
export function findStep(list: Step[], id: string, depth = 0): StepLocation | null {
    for (const [index, step] of list.entries()) {
        if (step.id === id) {
            return { list, index, step, depth };
        }
        for (const child of childLists(step)) {
            const inner = findStep(child.steps, id, depth + 1);
            if (inner) {
                return inner;
            }
        }
    }
    return null;
}

/** Where a recording lands: a list, and the index to put the first step at. */
export interface RecordTarget {
    list: Step[];
    at: number;
    /** How to name the spot in a notification; empty for the end of the macro. */
    where: string;
}

/**
 * Read the row preferences has selected. `after:<id>` is a step, and puts the
 * recording right behind it; `in:<id>:<branch>` is a body, and puts it at the
 * end of that body; anything else — empty, unrecognised, or naming a step that
 * has since been deleted or belongs to another macro — is the end of the macro.
 * Falling back rather than failing is deliberate: a stale selection should cost
 * you a move, not a recording.
 */
export function resolveRecordTarget(body: Step[], raw: string): RecordTarget {
    const end: RecordTarget = { list: body, at: body.length, where: '' };
    const [what, stepId, listKey] = raw.split(':');
    if (!stepId || (what !== 'after' && what !== 'in')) {
        return end;
    }
    const loc = findStep(body, stepId);
    if (!loc) {
        return end;
    }
    if (what === 'after') {
        return { list: loc.list, at: loc.index + 1, where: `after ${describeStep(loc.step)}` };
    }
    const lists = childLists(loc.step);
    const match = lists.find(list => list.key === listKey) ?? lists[0];
    return match
        ? {
            list: match.steps,
            at: match.steps.length,
            where: `the ${match.key} of ${describeStep(loc.step)}`,
        }
        : end;
}

/**
 * Where a run starts, read from the same selected row. A step selected is a
 * step to begin at — the editor has no separate "continue from here" mark, and
 * two marks meaning almost the same thing was one too many. A body, or nothing,
 * or a step that has since gone: from the top.
 */
export function resolveRunStart(body: Step[], raw: string): string {
    const [what, stepId] = raw.split(':');
    if (what !== 'after' || !stepId) {
        return '';
    }
    return findStep(body, stepId) ? stepId : '';
}

export function removeStep(list: Step[], id: string): Step | null {
    const loc = findStep(list, id);
    if (!loc) {
        return null;
    }
    return loc.list.splice(loc.index, 1)[0] ?? null;
}

/**
 * Move a step — subtree and all — to an exact place: `into` is the destination
 * list, `at` the index in it. Refused when the destination sits inside the
 * step being moved: a loop dropped into its own body would detach from the
 * document and vanish, taking everything inside it along.
 */
export function moveStepTo(root: Step[], id: string, into: Step[], at: number): boolean {
    const loc = findStep(root, id);
    if (!loc) {
        return false;
    }
    const holds = (step: Step): boolean =>
        childLists(step).some(child => child.steps === into || child.steps.some(holds));
    if (holds(loc.step)) {
        return false;
    }
    // Same-list moves: taking the step out shifts everything after it left, so
    // a target index past the old spot is off by the one just removed.
    if (loc.list === into && loc.index < at) {
        at--;
    }
    loc.list.splice(loc.index, 1);
    into.splice(Math.max(0, Math.min(at, into.length)), 0, loc.step);
    return true;
}

/**
 * Where the pointer is left after this macro, as far as can be told statically:
 * the last step that names an absolute position. Used when recording, so a fresh
 * session knows where the macro already left off.
 */
export function lastPointerEndpoint(steps: Step[]): { x: number; y: number } | null {
    let endpoint: { x: number; y: number } | null = null;
    walk(steps, ({ step }) => {
        if (step.kind !== 'click' && step.kind !== 'move') {
            return;
        }
        if (step.mode === 'abs' && typeof step.x === 'number' && typeof step.y === 'number') {
            endpoint = { x: step.x, y: step.y };
        }
    });
    return endpoint;
}

/**
 * Step kinds that no longer exist. Verbatim recording produced opaque `raw`
 * steps, `pad` pressed a gamepad button, and `remember` marked a spot for a
 * Back that is gone; nothing creates any of them any more and nothing can edit
 * them, so any left in a saved document are dropped rather than shown as rows
 * that cannot work.
 */
const RETIRED_KINDS: Record<string, string> = {
    raw: 'a verbatim step; that recording mode is gone',
    pad: 'a gamepad button step; gamepads are no longer supported',
    remember: 'a step remembering the pointer position; Back and Remember are gone',
};

/**
 * Why a step is no longer kept, or null when it is. Besides the retired kinds,
 * a move that went back to a remembered spot, or marked one ('prev', and the
 * older 'store'): with nothing left to remember, it has nowhere to go.
 */
function retiredReason(step: Step): string | null {
    const kind = (step as unknown as { kind: string }).kind;
    if (RETIRED_KINDS[kind]) {
        return RETIRED_KINDS[kind];
    }
    const mode = (step as { mode?: string }).mode;
    if (kind === 'move' && (mode === 'prev' || mode === 'store')) {
        return 'a move back to a remembered pointer position; Back and Remember are gone';
    }
    return null;
}

function dropRetiredSteps(steps: Step[]): Step[] {
    const kept: Step[] = [];
    for (const step of steps) {
        const retired = retiredReason(step);
        if (retired) {
            log(`macroclickwerk: dropping ${retired}`);
            continue;
        }
        for (const list of childLists(step)) {
            const migrated = dropRetiredSteps(list.steps);
            list.steps.length = 0;
            list.steps.push(...migrated);
        }
        kept.push(step);
    }
    return kept;
}

/**
 * Whether a `break` or `stop` in this list could end the loop that contains it.
 * Nested loops are not searched: a `break` inside one binds to that loop.
 */
function containsLoopExit(steps: Step[]): boolean {
    for (const step of steps) {
        if (step.kind === 'break' || step.kind === 'stop') {
            return true;
        }
        if (step.kind === 'if') {
            if (containsLoopExit(step.then) || containsLoopExit(step.else ?? [])) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Whether execution can ever reach the end of this list. False when it runs into
 * an endless loop with no way out — which matters because anything appended
 * after that point, a recording for instance, would never run.
 */
export function reachesEnd(steps: Step[]): boolean {
    for (const step of steps) {
        if (step.kind === 'stop') {
            return false;
        }
        if (step.kind === 'loop' && step.count === 'forever' && !containsLoopExit(step.body)) {
            return false;
        }
    }
    return true;
}

// --- serialisation ---------------------------------------------------------

/** `not` that avoids stacking double negations when migrating. */
function negate(cond: Condition): Condition {
    return cond.type === 'not' ? cond.of : { type: 'not', of: cond };
}

/**
 * Loops have arrived at their shape in stages: first `repeat` and `while` as
 * separate kinds, then one `loop` carrying a condition. Both fold onto a loop
 * that only counts — the condition becomes the `if … break` it was shorthand
 * for, which is where every other condition in a macro already lives.
 */
function migrateLoops(steps: Step[]): Step[] {
    for (const step of steps) {
        const legacy = step as unknown as {
            kind: string;
            cond?: Condition;
            count?: number | 'forever';
            maxIterations?: number;
            body?: Step[];
            then?: Step[];
            else?: Step[];
        };

        legacy.body = legacy.body ? migrateLoops(legacy.body) : legacy.body;
        legacy.then = legacy.then ? migrateLoops(legacy.then) : legacy.then;
        legacy.else = legacy.else ? migrateLoops(legacy.else) : legacy.else;

        const wasRepeat = legacy.kind === 'repeat';
        const wasWhile = legacy.kind === 'while';
        if (!wasRepeat && !wasWhile && legacy.kind !== 'loop') {
            continue;
        }

        legacy.kind = 'loop';
        if (wasWhile) {
            legacy.count = legacy.maxIterations && legacy.maxIterations > 0
                ? legacy.maxIterations
                : 'forever';
            delete legacy.maxIterations;
        }
        legacy.count = legacy.count ?? 'forever';

        const condition = wasRepeat ? undefined : legacy.cond;
        delete legacy.cond;
        if (condition && condition.type !== 'always') {
            // Leaving when the condition fails is the same as breaking as soon
            // as it fails, checked in the same place: the top of the body.
            legacy.body = [
                {
                    id: newId(),
                    kind: 'if',
                    cond: negate(condition),
                    then: [{ id: newId(), kind: 'break' }],
                    else: [],
                },
                ...(legacy.body ?? []),
            ];
        }
    }
    return steps;
}

/**
 * Colour checks used to be two conditions, `pixel` and `regionColor`, where the
 * first was just a 1×1 region. Fold both onto the surviving `color` type.
 */
function migrateCondition(cond: Condition | null | undefined): Condition | null {
    if (!cond) {
        return null;
    }

    // `expect: false` meant "proceed when the answer is NO", which is what `not`
    // says. Dropping the field without this would silently invert the check.
    const asked = cond as Condition & { expect?: boolean; onError?: string };
    if (cond.type === 'llm') {
        const inverted = asked.expect === false;
        delete asked.expect;
        delete asked.onError;
        if (inverted) {
            return { type: 'not', of: cond };
        }
    }
    // Deliberately erased to a plain record: the live union no longer has these
    // members, and narrowing against it would elide the checks below.
    const legacy = cond as unknown as {
        type: string; x?: number; y?: number; w?: number; h?: number;
        color?: string; tolerance?: number; coverage?: number;
    };

    if (legacy.type === 'pixel') {
        return {
            type: 'color',
            x: legacy.x ?? 0,
            y: legacy.y ?? 0,
            w: 1,
            h: 1,
            color: legacy.color ?? '#000000',
            tolerance: legacy.tolerance ?? 24,
        };
    }
    if (legacy.type === 'regionColor') {
        return {
            type: 'color',
            x: legacy.x ?? 0,
            y: legacy.y ?? 0,
            w: Math.max(1, legacy.w ?? 1),
            h: Math.max(1, legacy.h ?? 1),
            color: legacy.color ?? '#000000',
            tolerance: legacy.tolerance ?? 24,
        };
    }

    if (cond.type === 'color') {
        // A colour check counted pixels near the target and demanded a share of
        // them. It now compares the area's average against the target, which
        // needs no share — and asked individual pixels to match a mean, which
        // is a colour they need not have, so the share was unreachable more
        // often than not. Dropped rather than ignored: a number nothing reads
        // is a number the next reader has to work out is dead.
        delete (cond as { coverage?: number }).coverage;
    } else if (cond.type === 'and' || cond.type === 'or') {
        cond.of = cond.of.map(child => migrateCondition(child)!).filter(Boolean);
    } else if (cond.type === 'not') {
        cond.of = migrateCondition(cond.of) ?? { type: 'always' };
    }
    return cond;
}

interface LegacyGate {
    kind: 'gate';
    id: string;
    cond: Condition;
    onFalse?: 'skip-rest' | 'break' | 'continue' | 'abort' | 'retry';
    retryMs?: number;
}

/**
 * `gate` was a second way to spell `if`, and its "skip the rest" action in fact
 * broke out of the loop. Rewrite each one as the plain control flow it meant,
 * following the labels the editor showed rather than what the runner did.
 */
function migrateGates(steps: Step[]): Step[] {
    const migrated: Step[] = [];

    for (let index = 0; index < steps.length; index++) {
        const step = steps[index];

        // Gates nest, so recurse before deciding what this step becomes.
        if (step.kind === 'loop') {
            step.body = migrateGates(step.body);
        } else if (step.kind === 'if') {
            step.then = migrateGates(step.then);
            step.else = migrateGates(step.else ?? []);
        }

        if ((step as unknown as LegacyGate).kind !== 'gate') {
            migrated.push(step);
            continue;
        }

        const gate = step as unknown as LegacyGate;
        const cond = migrateCondition(gate.cond) ?? { type: 'always' };
        const flow = (kind: 'break' | 'continue' | 'stop'): Step => ({ id: newId(), kind });
        const ifNot = (body: Step[]): Step =>
            ({ id: newId(), kind: 'if', cond: negate(cond), then: body, else: [] });

        switch (gate.onFalse) {
            case 'break':
                migrated.push(ifNot([flow('break')]));
                break;
            case 'continue':
                migrated.push(ifNot([flow('continue')]));
                break;
            case 'abort':
                migrated.push(ifNot([flow('stop')]));
                break;
            case 'retry':
                migrated.push({
                    id: newId(),
                    kind: 'loop',
                    count: 'forever',
                    body: [
                        { id: newId(), kind: 'if', cond, then: [{ id: newId(), kind: 'break' }], else: [] },
                        { id: newId(), kind: 'wait', ms: gate.retryMs ?? 1000, jitterMs: 0 },
                    ],
                });
                break;
            case 'skip-rest':
            default:
                // Everything after the gate was conditional on it, so that is
                // exactly the body of the `if` it becomes.
                migrated.push({
                    id: newId(),
                    kind: 'if',
                    cond,
                    then: migrateGates(steps.slice(index + 1)),
                    else: [],
                });
                return migrated;
        }
    }

    return migrated;
}

/**
 * Steps used to carry an inline `when` guard, which did the same job as an `if`
 * with a one-step body. Rather than dropping the field — which would silently
 * make a guarded step run unconditionally — wrap each one in the `if` it always
 * was.
 */
function migrateGuards(steps: Step[]): Step[] {
    const migrated: Step[] = [];

    for (const step of steps) {
        if (step.kind === 'loop') {
            step.body = migrateGuards(step.body);
        } else if (step.kind === 'if') {
            step.then = migrateGuards(step.then);
            step.else = migrateGuards(step.else ?? []);
        }

        if (step.kind === 'if') {
            step.cond = migrateCondition(step.cond) ?? { type: 'always' };
        }

        const legacy = step as Step & { when?: Condition | null };
        const guard = migrateCondition(legacy.when);
        delete legacy.when;

        if (guard && guard.type !== 'always') {
            migrated.push({ id: newId(), kind: 'if', cond: guard, then: [step], else: [] });
        } else {
            migrated.push(step);
        }
    }

    return migrated;
}

/** Take the old per-check flash switch off a condition and everything in it. */
function dropFlash(cond: Condition | null | undefined): void {
    if (!cond) {
        return;
    }
    delete (cond as { flash?: boolean }).flash;
    if (cond.type === 'and' || cond.type === 'or') {
        cond.of.forEach(dropFlash);
    } else if (cond.type === 'not') {
        dropFlash(cond.of);
    }
}

export function parseDocument(json: string): MacroDocument {
    if (!json || json.trim() === '') {
        return emptyDocument();
    }
    try {
        const raw = JSON.parse(json) as Partial<MacroDocument>;
        if (!raw || !Array.isArray(raw.macros)) {
            return emptyDocument();
        }
        // Every pass below runs on every document, current ones included, and
        // deliberately so. Gating them on `version` would save a few
        // microseconds of a parse that measures under twenty on a real
        // document, and would buy them by trusting a version number: a
        // hand-edited export, or anything else that arrives claiming to be
        // current while missing an id, would reach the editor unrepaired.

        // Repair anything that lost an id, so the UI never deals with undefined.
        const macros = raw.macros.map(macro => {
            const fixed: Macro = {
                id: macro.id || newId(),
                name: macro.name || 'Unnamed macro',
                // Left absent when it is absent, rather than defaulted here:
                // the store tells a document from before the flag existed by
                // the fact that nothing in it carries one.
                enabled: typeof macro.enabled === 'boolean' ? macro.enabled : undefined,
                exclusive: macro.exclusive === false ? false : undefined,
                collection: typeof macro.collection === 'string' && macro.collection !== ''
                    ? macro.collection : undefined,
                body: Array.isArray(macro.body) ? macro.body : [],
            };
            walk(fixed.body, loc => {
                if (!loc.step.id) {
                    loc.step.id = newId();
                }
                // Steps used to carry a switch of their own. A macro is the
                // thing you switch on and off now, so the flag is dropped here
                // rather than left behind to mean nothing: a step that is in a
                // macro runs when that macro does.
                delete (loc.step as { enabled?: boolean }).enabled;
                // An `onevent` used to offer a whole-click mode: the press woke
                // it and the release was swallowed along with it. That is gone,
                // and 'split' is now spelled 'either', so both drop to the
                // default. 'press' and 'release' still mean what they always
                // did and are left alone. Dropping 'click' does change what
                // such a step does — the click below it now follows the finger
                // instead of running a fixed hold of its own.
                const edge = (loc.step as { edge?: string }).edge;
                if (loc.step.kind === 'onevent' && (edge === 'click' || edge === 'split')) {
                    delete (loc.step as { edge?: string }).edge;
                }
                // A click could go back to where the pointer was before the
                // last positioned step — "Back", now gone. Clicking where the
                // pointer is, is the nearest thing left.
                if (loc.step.kind === 'click' && (loc.step.mode as string) === 'prev') {
                    loc.step.mode = 'current';
                }
            });
            fixed.body = dropRetiredSteps(migrateGuards(migrateGates(migrateLoops(fixed.body))));
            // Every check flashes the area it reads now, so the per-check
            // switch for it is gone from what is kept — after the migrations,
            // which carry the conditions of older steps into ifs.
            walk(fixed.body, ({ step }) => {
                if (step.kind === 'if') {
                    dropFlash(step.cond);
                }
            });
            return fixed;
        });
        let collections: CollectionRef[] = [];
        for (const ref of Array.isArray(raw.collections) ? raw.collections : []) {
            if (typeof ref?.path === 'string' && ref.path !== '' && typeof ref.saved === 'string' &&
                !collections.some(other => other.path === ref.path)) {
                collections.push({ path: ref.path, saved: ref.saved, ...(ref.off === true ? { off: true } : {}) });
            }
        }
        // A macro of a collection that is not loaded could never be saved or
        // switched off: it is simply one of yours.
        for (const macro of macros) {
            if (macro.collection && !collections.some(ref => ref.path === macro.collection)) {
                macro.collection = undefined;
            }
        }
        // And a collection with no macros left is gone.
        collections = collections.filter(ref => macros.some(macro => macro.collection === ref.path));
        const points = cleanPoints(raw.points);
        return {
            version: raw.version ?? DOCUMENT_VERSION,
            macros,
            ...(collections.length > 0 ? { collections } : {}),
            ...(points.length > 0 ? { points } : {}),
        };
    } catch (error) {
        // Returning an empty document rather than throwing keeps the extension
        // alive, but it also means every macro has just vanished from the UI —
        // which needs saying out loud, not only in the journal.
        reportProblem('Macros', `could not read the saved macros: ${(error as Error).message}`, {
            hint: 'The list will look empty until this is fixed. The stored text is still there: ' +
                'gsettings get org.gnome.shell.extensions.macroclickwerk macros',
            error: error as Error,
        });
        return emptyDocument();
    }
}

export function stringifyDocument(doc: MacroDocument): string {
    return JSON.stringify(doc);
}

/**
 * Parse a group of related numbers typed as one field: "100, 200",
 * "100 200", "100x200". Returns null unless exactly `count` numbers are found,
 * so a half-typed value never overwrites a good one.
 */
export function parseNumbers(text: string, count: number): number[] | null {
    const parts = (text ?? '').split(/[\s,;x×]+/).filter(Boolean);
    if (parts.length !== count) {
        return null;
    }
    const numbers = parts.map(Number);
    return numbers.every(Number.isFinite) ? numbers.map(Math.round) : null;
}

// --- human readable summaries ---------------------------------------------

function truncate(text: string, max = 42): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** With `doc`, an area that has a name is called by it. */
export function describeCondition(cond: Condition | null | undefined, doc?: MacroDocument): string {
    if (!cond) {
        return 'always';
    }
    switch (cond.type) {
        case 'always':
            return 'always';
        case 'never':
            return 'never';
        case 'llm':
            return `LLM: "${truncate(cond.prompt)}"`;
        case 'color': {
            const name = doc && areaAt(doc, cond)?.name;
            const where = cond.w * cond.h === 1
                ? `pixel ${name ?? `${cond.x},${cond.y}`}`
                : `avg of ${name ?? `${cond.w}×${cond.h} @ ${cond.x},${cond.y}`}`;
            return `${where} ≈ ${cond.color} ±${cond.tolerance}`;
        }
        case 'and':
            return cond.of.length ? cond.of.map(each => describeCondition(each, doc)).join(' and ') : 'always';
        case 'or':
            return cond.of.length ? cond.of.map(each => describeCondition(each, doc)).join(' or ') : 'never';
        case 'not':
            return `not (${describeCondition(cond.of, doc)})`;
    }
}

/** BTN_SIDE → "the side button is pressed or released", KEY_F13 → "F13 is released". */
export function prettySource(source: string, edge: EventEdge = 'either'): string {
    const verb = edge === 'press' ? 'is pressed'
        : edge === 'release' ? 'is released'
            : 'is pressed or released';
    const button = source.match(/^BTN_(\w+)$/);
    if (button) {
        return `the ${button[1].toLowerCase()} button ${verb}`;
    }
    return `${source.replace(/^KEY_/, '') || '…'} ${verb}`;
}

/**
 * A key step's verb. The whole gesture is a Type, which leaves "press" free for
 * the half that goes down and stays there — so a keyboard names its halves
 * exactly as a mouse does, and neither of them holds anything: a hold wants an
 * unhold to go with it, and what ends this one is the Release sitting beside it
 * in the same list.
 */
function pressVerb(action?: 'tap' | 'down' | 'up'): string {
    return action === 'down' ? 'Press' : action === 'up' ? 'Release' : 'Type';
}

function formatMs(ms: number): string {
    if (ms >= 1000 && ms % 1000 === 0) {
        return `${ms / 1000}s`;
    }
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${ms}ms`;
}

/**
 * `macroName` resolves the macro a `start` or `stop` step points at. Without it
 * those read as "another macro": the runner has no document to look in, and its
 * breadcrumb is about where the run is, not which macro it just poked.
 *
 * `stepLabel` does the same for the step a `start` points at — ids are unique
 * across the whole document, so it takes only the id. Without it the title
 * says "a chosen step" rather than which one.
 */
export function describeStep(
    step: Step,
    macroName?: (id: string) => string | undefined,
    stepLabel?: (stepId: string) => string | undefined,
    doc?: MacroDocument,
): string {
    const after = (step as ThenWait).afterMs;
    const action = describeAction(step, macroName, stepLabel, doc);
    return after && after > 0 ? `${action}, then wait ${formatMs(after)}` : action;
}

/** With `doc`, a place that has a name is called by it. */
function describeAction(
    step: Step,
    macroName?: (id: string) => string | undefined,
    stepLabel?: (stepId: string) => string | undefined,
    doc?: MacroDocument,
): string {
    const spot = (x = 0, y = 0) => (doc && pointAt(doc, x, y)?.name) ?? `${x},${y}`;
    switch (step.kind) {
        case 'click': {
            // Absent is the follow, and a follow reads as the plain word: what
            // it does is whatever the event did, which the event's own line
            // above it already says.
            //
            // Only the whole gesture differs between a mouse and a keyboard —
            // one clicks, the other types. The halves are a press and a
            // release on both, which is a pair with two visible ends; see
            // `pressVerb`.
            const verb = step.action === 'down' ? 'Press'
                : step.action === 'up' ? 'Release' : 'Click';
            return step.mode === 'abs' ? `${verb} ${step.button} @ ${spot(step.x, step.y)}`
                : `${verb} ${step.button} at pointer`;
        }
        case 'move':
            return step.mode === 'abs' ? `Move to ${spot(step.x, step.y)}`
                : `Move by ${step.dx ?? 0},${step.dy ?? 0}`;
        case 'scroll':
            return `Scroll ${step.dx ? `${step.dx} horizontally` : ''}${step.dx && step.dy ? ', ' : ''}${step.dy ? `${step.dy} vertically` : ''}`.trim() || 'Scroll';
        case 'key': {
            const mods = (step.mods ?? []).map(m => m.replace(/^KEY_/, '').toLowerCase());
            const name = step.code.replace(/^KEY_/, '');
            const combo = [...mods, name].join('+');
            return `${pressVerb(step.action)} ${combo}`;
        }
        case 'text':
            return `Type "${truncate(step.value)}"`;
        case 'wait':
            return step.jitterMs
                ? `Wait ${formatMs(step.ms)} ±${formatMs(step.jitterMs)}`
                : `Wait ${formatMs(step.ms)}`;
        case 'onevent':
            return `When ${prettySource(step.source, step.edge)}`;
        case 'loop':
            return step.count === 'forever' ? 'Repeat forever' : `Repeat ${step.count}×`;
        case 'if':
            return `If ${describeCondition(step.cond, doc)}`;
        case 'break':
            return 'Break out of the loop';
        case 'continue':
            return 'Skip to the next iteration';
        case 'start':
        case 'stop': {
            const verb = step.kind === 'start' ? 'Start' : 'Stop';
            const at = step.kind === 'start' && step.at
                ? ` at ${stepLabel?.(step.at) ?? 'a chosen step'}`
                : '';
            if (!step.macro) {
                return step.kind === 'start'
                    ? (at ? `Start again${at}` : 'Start this macro again')
                    : 'Stop the macro';
            }
            const name = macroName?.(step.macro);
            return (name ? `${verb} “${name}”` : `${verb} another macro`) + at;
        }
    }
}

/**
 * The kinds worth offering in an "add a step" menu — which, now that verbatim
 * recording is gone, is all of them.
 */
export const AUTHORABLE_STEP_KINDS: StepKind[] = [
    'click', 'move', 'scroll', 'key', 'text', 'wait', 'onevent',
    'loop', 'if', 'break', 'continue', 'start', 'stop',
];

