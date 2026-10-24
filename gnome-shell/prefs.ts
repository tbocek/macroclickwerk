// The full macro editor. Runs in its own process, so it can use GTK4/Adwaita
// widgets and cannot block the compositor.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    AUTHORABLE_STEP_KINDS as STEP_KINDS,
    type ClickStep,
    type ColorCondition,
    type Condition,
    type ConditionType,
    type KeyStep,
    type LlmCondition,
    type LoopStep,
    type WaitStep,
    type Macro,
    type MouseButton,
    type OnEventStep,
    type Region,
    type Step,
    type StepKind,
    EVENT_EDGES,
    childLists,
    describeStep,
    collectionName,
    collectionPaths,
    collectionText,
    collectionUnsaved,
    copyMacro,
    emptyDocument,
    forgetEmptyCollections,
    livePoints,
    loadCollection,
    macroLive,
    setCollectionOn,
    collectionOn,
    markCollectionSaved,
    moveMacro,
    areaAt,
    movePoint,
    namePlace,
    placeCentre,
    pointAt,
    type NamedPoint,
    type Place,
    renameCollection,
    findStep,
    eventFollows,
    macroEnabled,
    macroExclusive,
    moveStepTo,
    newCondition,
    newId,
    newMacro,
    newStep,
    parseDocument,
    parseNumbers,
    removeStep,
    stringifyDocument,
    walk,
} from './src/model.js';
import { MacroStore } from './src/store.js';
import { buildInstruction, promptAdvice, testConnection } from './src/llm.js';
import { isArmed, parseTriggers, type Trigger } from './src/triggers.js';
import {
    chooser, clearClasses, colorSwatch, comboRow, commitNumbers, debounce, descendants,
    firstDescendant,
    entryRow, fitToText, iconButton, infoButton, numberEntry, passwordRow, setClass,
    spinRow, suffixEntry, toggleButton, withColorSwatches,
} from './src/widgets.js';

const CONDITION_TYPES: ConditionType[] = ['always', 'never', 'llm', 'color', 'and', 'or', 'not'];

/**
 * What a condition checks, in a word: the chooser sits on a line beside the
 * prompt or the colour it is about, which says the rest. Built on demand, for
 * the gettext reason `scaleLabels` gives.
 */
const conditionTypeLabels = (): Record<ConditionType, string> => ({
    always: _('Always'),
    never: _('Never'),
    llm: _('LLM'),
    color: _('Colour'),
    and: _('All of'),
    or: _('Any of'),
    not: _('Not'),
});

/**
 * The two constants say all there is to say on their own, so inside an "all of"
 * or an "any of" they only ever weaken the group: an `always` in an "all of" is
 * a line that does nothing, and one in an "any of" makes the rest of it dead.
 */
const GROUPABLE_TYPES = CONDITION_TYPES.filter(type => type !== 'always' && type !== 'never');

const MACROS_FILE = 'macroclickwerk-macros.json';
const SETTINGS_FILE = 'macroclickwerk-settings.json';

/**
 * Keys the settings file leaves alone. The macros live in their own export, and
 * the rest is live state — what is running, and the request/answer keys
 * preferences uses to talk to the shell. Importing any of those would either
 * clobber the other export or replay a stale request.
 */
const NOT_SETTINGS = [
    'macros', 'active-macro-id', 'running-steps', 'record-into', 'recording',
];

function isTransferableKey(key: string): boolean {
    return !NOT_SETTINGS.includes(key) && !key.endsWith('-request') && !key.endsWith('-result');
}


/**
 * Screenshots are scaled by width, so on the 16:9 screen these names come from
 * the width is the resolution: 1280 across is what "720p" means. Stored as the
 * width itself, which is what the setting has always held.
 */
const SCALE_WIDTHS = ['854', '1280', '1920', '2560', '3840'] as const;

/**
 * Built when asked for, not held in a constant: gettext refuses to run while
 * this module is still being imported — it identifies the extension from the
 * call stack, and the object it would translate for does not exist yet — so a
 * top-level table of translated strings takes the whole window down with it.
 */
function scaleLabels(): Record<string, string> {
    return {
        '854': _('480p — 854 px wide'),
        '1280': _('720p — 1280 px wide'),
        '1920': _('1080p — 1920 px wide'),
        '2560': _('1440p — 2560 px wide'),
        '3840': _('4K — 3840 px wide'),
    };
}

/**
 * The nearest listed width that is not *smaller* than the stored one. Settings
 * written before this was a list hold arbitrary numbers, and rounding up keeps
 * answers at least as accurate as they were.
 */
function scaleWidthFor(width: number): typeof SCALE_WIDTHS[number] {
    return SCALE_WIDTHS.find(option => Number(option) >= width) ?? SCALE_WIDTHS[SCALE_WIDTHS.length - 1];
}

/**
 * A step reads as a line of a program, so it gets the same icon everywhere and
 * the icon carries the kind — leaving the title free for the actual parameters.
 */
const STEP_ICONS: Record<StepKind, string> = {
    click: 'input-mouse-symbolic',
    move: 'find-location-symbolic',
    scroll: 'view-sort-descending-symbolic',
    key: 'input-keyboard-symbolic',
    text: 'insert-text-symbolic',
    wait: 'alarm-symbolic',
    onevent: 'input-touchpad-symbolic',   // a press coming *in*: the step that waits for one
    loop: 'media-playlist-repeat-symbolic',
    if: 'media-playlist-shuffle-symbolic',
    break: 'application-exit-symbolic',   // an arrow leaving: out of the loop, not the macro
    continue: 'media-skip-forward-symbolic',
    start: 'view-refresh-symbolic',       // start, and start again: the same request
    stop: 'process-stop-symbolic',
};

/** The buttons a click can use, in the order they are offered. */
const MOUSE_BUTTONS: MouseButton[] = ['left', 'right', 'middle', 'side', 'extra'];

/**
 * Built on demand, not at file scope: gettext is not ready when this module is
 * imported, and translating there fails the import outright.
 */
const mouseButtonLabels = (): Record<MouseButton, string> => ({
    left: _('Left'),
    right: _('Right'),
    middle: _('Middle'),
    side: _('Side'),
    extra: _('Extra'),
});

/** What a click or a key step can do, in the order it is offered. */
const PRESS_ACTIONS = ['tap', 'down', 'up'] as const;

/**
 * Built on demand, for the same reason mouseButtonLabels is. One word each,
 * where the old rows had a sentence: a dropdown is as wide as its longest
 * entry, and "Press and keep held" made every row in the window wider than it
 * had room for. The line these sit on already reads "Hold down ctrl+c", so the
 * sentence was being said twice; the tooltip keeps the long form.
 *
 * A mouse and a keyboard differ in one word of the three: the whole gesture is
 * a *click* on a mouse and a *type* on a keyboard. Naming it separately is what
 * leaves "press" free for the half that goes down and stays there, so both
 * kinds can name their halves press and release — a pair with two ends you can
 * see. Nothing is a "hold": a hold implies an unhold, and the button that ends
 * it is the Release two entries down the same list.
 */
const clickActionLabels = (): Record<string, string> => ({
    tap: _('Click'),
    down: _('Press'),
    up: _('Release'),
});

const keyActionLabels = (): Record<string, string> => ({
    tap: _('Type'),
    down: _('Press'),
    up: _('Release'),
});

/** Which edge a "When …" waits for. Built on demand, as the others are. */
const eventEdgeLabels = (): Record<string, string> => ({
    either: _('Either'),
    press: _('Press'),
    release: _('Release'),
});

/**
 * What an On Event waits on, as its own line says it: the line already reads
 * "On Event", so "click" and "button" are both said once too often. The triggers
 * page has rows to spare and keeps the long form.
 */
const eventSourceLabels = (): Record<string, string> => ({
    BTN_LEFT: _('Left'),
    BTN_RIGHT: _('Right'),
    BTN_MIDDLE: _('Middle'),
    BTN_SIDE: _('Side'),
    BTN_EXTRA: _('Extra'),
    custom: _('Key…'),
});

/**
 * A step's title is the word the line starts with, and the controls after it
 * finish the sentence — "Mouse [Left] [Click] [20ms] [840, 512]". The full
 * sentence the title used to be is the same controls read aloud, so saying it
 * twice cost the room the controls need to fit on one line. An `if` keeps its
 * sentence: its condition is the one thing not on its line.
 */
const stepTitles = (): Record<StepKind, string> => ({
    click: _('Mouse'),
    move: _('Move'),
    scroll: _('Scroll'),
    key: _('Key'),
    text: _('Text'),
    wait: _('Wait'),
    onevent: _('On Event'),
    loop: _('Repeat'),
    if: _('If'),
    break: _('Break'),
    continue: _('Continue'),
    start: _('Start'),
    stop: _('Stop'),
});

/**
 * The kinds worth running on their own, from a step's right-click menu: one
 * action each, over as soon as it is done.
 * A loop or an `if` would drag its whole body along, and an endless loop would
 * drag the session with it — from a window that has no Stop. `break` and the
 * rest only mean something inside a run, so on their own they do nothing.
 */
const RUNNABLE_ALONE: StepKind[] = ['click', 'move', 'scroll', 'key', 'text', 'wait'];

/**
 * What a typed key name means: the kernel's spelling, with the prefix filled in
 * for anyone who wrote just the letter. "f" and "KEY_F" are the same key, and
 * nobody should have to know which of the two this field wanted.
 */
function evdevKeyName(name: string): string {
    const upper = name.trim().toUpperCase();
    return upper.startsWith('KEY_') ? upper : `KEY_${upper}`;
}

/**
 * The header an `if` gives each of its branches. A loop has one body and shows
 * it on its own row, so only these two have one. Built on demand, for the
 * gettext reason `scaleLabels` gives — and with the strings written out, so
 * they can be found for translating.
 */
const branchStyles = (): Record<'then' | 'else', { icon: string; title: string; hint: string }> => ({
    then: { icon: 'object-select-symbolic', title: _('Yes'), hint: _('Runs when the check holds') },
    else: { icon: 'window-close-symbolic', title: _('No'), hint: _('Runs when it does not') },
});

/**
 * How wide the macro editor may get. `AdwPreferencesPage` wraps its groups in a
 * clamp of 600, which is the right measure for a settings row — a label on the
 * left, a value on the right, and nothing that suffers from a short line. A
 * step row is not that: it carries a title, dropdowns, fields and buttons on
 * one line, and at 600 a deeply nested one has no room left for its title.
 * The clamp is not a property of the page, so the only way to say otherwise
 * is to reach in for it — see `_widen`.
 */
const EDITOR_MAX_WIDTH = 900;

/**
 * How wide the window opens. A Mouse step carries the most on its line —
 * button, action, hold, where, the spot with Pick and Show, and the wait after
 * it — and nested a few levels deep it needs about 760 px. Opening at the
 * editor's own maximum leaves that room, and the title beside it. It can
 * still be made narrower; past that the page simply stops shrinking.
 */
const EDITOR_WINDOW_WIDTH = 900;

/** How wide the Shortcuts page may get — see `_buildShortcutsPage`. */
const SHORTCUTS_MAX_WIDTH = 860;

/**
 * Nesting is the thing you have to be able to read at a glance, and stacked
 * expander rows on their own do not show it. Every body gets a coloured rail
 * down its left edge — one colour per branch — that spans everything inside it,
 * and the steps within are indented under that one rail. Exactly one rail per
 * level of nesting: giving the steps their own rail as well only drew the same
 * boundary twice, a hand's width apart. The running step and the loops it sits
 * in are lit up on top of that.
 *
 * Every rail is an inset box-shadow rather than a border. A border is part of
 * the box, so a row that gains one when you select it shoves its own text 4px
 * sideways — the whole page twitches as the selection moves. A shadow is
 * painted inside the box it already had, so nothing moves. It also means the
 * state rails simply overwrite the branch rail instead of stacking beside it.
 */
const EDITOR_CSS = `
.macroclickwerk-branch {
    box-shadow: inset 4px 0 0 alpha(@accent_bg_color, 0.85);
    background-color: alpha(@accent_bg_color, 0.06);
}
.macroclickwerk-branch-then {
    box-shadow: inset 4px 0 0 alpha(@success_color, 0.9);
    background-color: alpha(@success_color, 0.06);
}
.macroclickwerk-branch-else {
    box-shadow: inset 4px 0 0 alpha(@warning_color, 0.9);
    background-color: alpha(@warning_color, 0.06);
}

/* A "When …" and the steps after it are one gesture, drawn as a block the way
   a body is: the steps indented, one rail down the whole of it. Neutral on
   purpose — the branch colours mean containment, and this is sequence. The
   state rails below overwrite the rail, never the indent, so a selected or
   running step still sits where it belongs. */
.macroclickwerk-event {
    box-shadow: inset 4px 0 0 alpha(@window_fg_color, 0.35);
    background-color: alpha(@window_fg_color, 0.03);
}

.macroclickwerk-running {
    background-color: alpha(@accent_bg_color, 0.28);
    box-shadow: inset 4px 0 0 @accent_bg_color;
}
.macroclickwerk-running-block { box-shadow: inset 4px 0 0 @accent_bg_color; }
.macroclickwerk-running-icon { color: @accent_bg_color; }
.macroclickwerk-running-parent-icon { color: alpha(@accent_bg_color, 0.7); }

/* The selected row: where Run starts and where recorded steps land. The same
   blue as the running step, quieter — one is where the run is now, the other
   where the next one begins, and they are the same idea a beat apart. Red
   instead while the recording is actually running and the next click goes in
   here. A row that opens gets the rail only — a fill would run down everything
   inside it and read as though all of that were selected too. */
.macroclickwerk-record-target {
    background-color: alpha(@accent_bg_color, 0.13);
    box-shadow: inset 4px 0 0 alpha(@accent_bg_color, 0.65);
}
.macroclickwerk-record-target-block { box-shadow: inset 4px 0 0 alpha(@accent_bg_color, 0.65); }
/* A rail alone is easy to miss on a row that already has one for the branch it
   is in, so a row that opens is filled too — but only across its own header.
   That is the line you pointed at; what it holds is a list of other lines, each
   of which can be selected on its own. libadwaita builds an expander as
   row.expander > box > list > row.header, and the body it reveals is in the
   sibling the selector stops short of. */
.macroclickwerk-record-target-block > box > list > row.header {
    background-color: alpha(@accent_bg_color, 0.13);
}
.macroclickwerk-recording-now {
    background-color: alpha(@error_color, 0.28);
    box-shadow: inset 4px 0 0 @error_color;
}
.macroclickwerk-recording-now-block { box-shadow: inset 4px 0 0 @error_color; }
/* The same header fill a selected block gets, in red while it is recording. */
.macroclickwerk-recording-now-block > box > list > row.header {
    background-color: alpha(@error_color, 0.28);
}

/* − and + as slim as a spin button's own, which is what they stand in for. */
.macroclickwerk-spin > button { min-width: 14px; padding-left: 4px; padding-right: 4px; }

/* The editor is a list of program lines, not of settings: one line each, as
   tight as a button allows. A row is as tall as the buttons on it plus a hair,
   and the buttons give up the padding that only made them wide. Entry rows
   keep their height — their title floats above the text and needs it. */
.macroclickwerk-editor row:not(.entry) > box.header { min-height: 40px; }
.macroclickwerk-editor row > box.header > box.title { margin-top: 3px; margin-bottom: 3px; }
.macroclickwerk-line button.image-button { min-width: 16px; padding-left: 6px; padding-right: 6px; }
.macroclickwerk-line dropdown > button { padding-left: 6px; padding-right: 3px; }
.macroclickwerk-line dropdown > button > box { border-spacing: 2px; }

/* Every row a click selects says so under the pointer, the way the theme's
   own clickable rows do — plain steps and add rows too, which the theme
   leaves alone because it does not know a click does anything there. Only
   the line itself: an expander counts as hovered while the pointer is on a row
   inside it, so it is its header that lights up, never the whole block. */
row.macroclickwerk-selectable:not(.expander):hover,
row.macroclickwerk-selectable.expander > box > list > row.header:hover {
    background-color: color-mix(in srgb, currentColor 4%, transparent);
}
/* A row that is already filled — selected, recording into, running — keeps
   its colour under the pointer and deepens it, rather than going grey or
   not answering at all. After the rule above, which they must win over. */
row.macroclickwerk-selectable.macroclickwerk-record-target:hover,
row.macroclickwerk-selectable.macroclickwerk-record-target-block > box > list > row.header:hover {
    background-color: alpha(@accent_bg_color, 0.2);
}
row.macroclickwerk-selectable.macroclickwerk-recording-now:hover,
row.macroclickwerk-selectable.macroclickwerk-recording-now-block > box > list > row.header:hover {
    background-color: alpha(@error_color, 0.36);
}
row.macroclickwerk-selectable.macroclickwerk-running:hover {
    background-color: alpha(@accent_bg_color, 0.36);
}

/* "Add step here" is a place, not a step: half the height of one. */
.macroclickwerk-editor row.macroclickwerk-add > box.header { min-height: 28px; }
.macroclickwerk-add menubutton > button { min-height: 20px; padding: 1px 8px; }
.macroclickwerk-add menubutton:not(.destructive-action) > button { opacity: 0.75; }

/* The line under a model check: advice, or what the model said. Small, so it
   reads as a note about the row above rather than a row of its own. */
.macroclickwerk-hint > box.header > box.title > .title { font-size: smaller; }

/* The macro's name is the heading of its card. */
.macroclickwerk-macro-name text { font-weight: bold; }

/* The fold arrow is an icon, not a button: as narrow as its arrow. */
.macroclickwerk-fold { min-width: 18px; min-height: 18px; padding: 0; }

/* The grip whispers until the pointer is near it. */
.macroclickwerk-grip { opacity: 0.4; }
row:hover .macroclickwerk-grip { opacity: 1; }

/* Where a drag would land: a line above or below, or the container filled. */
.macroclickwerk-drop-above { box-shadow: inset 0 3px 0 @accent_bg_color; }
.macroclickwerk-drop-below { box-shadow: inset 0 -3px 0 @accent_bg_color; }
.macroclickwerk-drop-into  { background-color: alpha(@accent_bg_color, 0.25); }
`;

/** The width of the fold arrow on the left of a step, and of the blank kept in its place. */
const FOLD_ARROW_PX = 18;

/**
 * The steps that act on the game, and so can wait after themselves for it to
 * register what they did — see `ThenWait` in the model.
 */
const THEN_WAIT_KINDS: StepKind[] = ['click', 'move', 'key', 'text', 'scroll'];

/** Hovering a drag over a folded container this long springs it open. */
const SPRING_OPEN_MS = 600;

/** Where a drop would land, relative to the row under the pointer. */
type DropZone = 'before' | 'after' | 'into';

const DROP_CLASSES = [
    'macroclickwerk-drop-above', 'macroclickwerk-drop-below', 'macroclickwerk-drop-into',
];

/** What a row painted as the recording target may be wearing, row or block. */
const RECORD_CLASSES = [
    'macroclickwerk-record-target', 'macroclickwerk-record-target-block',
    'macroclickwerk-recording-now', 'macroclickwerk-recording-now-block',
];

/** The same for a row the runner is standing on, and for its icon. */
const RUN_ROW_CLASSES = ['macroclickwerk-running', 'macroclickwerk-running-block'];
const RUN_ICON_CLASSES = [
    'macroclickwerk-running-icon', 'macroclickwerk-running-parent-icon',
];

/** How far a step inside a body sits in from the rail of that body. */
const INDENT_PX = 8;

/**
 * How long a rebuilt page is given to settle before the scroll position is left
 * alone again. Long enough for the frames that empty and refill it, short
 * enough that a later resize — an expander opening — is your doing, not ours.
 */
const SCROLL_SETTLE_MS = 400;

/** What a trigger can take over, beside any key by name. */
const TRIGGER_SOURCES = ['BTN_LEFT', 'BTN_RIGHT', 'BTN_MIDDLE', 'BTN_SIDE', 'BTN_EXTRA'] as const;

const triggerSourceLabels = (): Record<string, string> => ({
    BTN_LEFT: _('Left click'),
    BTN_RIGHT: _('Right click'),
    BTN_MIDDLE: _('Middle click'),
    BTN_SIDE: _('Side button'),
    BTN_EXTRA: _('Extra button'),
    custom: _('A key…'),
});

const TRIGGER_ACTIONS = ['none', 'run', 'pause', 'stop', 'record', 'capture', 'panic'] as const;

const triggerActionLabels = (): Record<string, string> => ({
    none: _('Nothing yet'),
    run: _('Starts'),
    pause: _('Pauses'),
    stop: _('Stops'),
    record: _('Starts or stops recording'),
    capture: _('Captures a step'),
    panic: _('Emergency stop'),
});

/** How a modifier is written by people, and how GTK spells it. */
const MODIFIERS: [string, string][] = [
    ['Ctrl', '<Control>'], ['Shift', '<Shift>'], ['Alt', '<Alt>'], ['Super', '<Super>'],
];

/** <Control><Shift>F6 → Ctrl+Shift+F6, the way people write a shortcut. */
function shortcutLabel(accel: string): string {
    let rest = accel.replace(/<Primary>|<Ctrl>/gi, '<Control>');
    const parts: string[] = [];
    for (const [label, spelled] of MODIFIERS) {
        if (rest.toLowerCase().includes(spelled.toLowerCase())) {
            parts.push(label);
            rest = rest.replace(new RegExp(spelled, 'ig'), '');
        }
    }
    return [...parts, rest.replace(/<[^>]*>/g, '')].filter(Boolean).join('+');
}

/**
 * Ctrl+Shift+F6 → <Control><Shift>F6, for the settings; GTK's own spelling is
 * taken as it is. Null when it does not read as a shortcut — a key, after any
 * number of modifiers.
 */
function shortcutAccel(text: string): string | null {
    const typed = text.trim();
    if (typed.includes('<')) {
        const [ok, keyval] = Gtk.accelerator_parse(typed);
        return ok && keyval !== 0 ? typed : null;
    }
    const parts = typed.split('+').map(part => part.trim()).filter(Boolean);
    const key = parts.pop() ?? '';
    const mods = parts.map(part => MODIFIERS.find(([label]) =>
        label.toLowerCase() === part.toLowerCase() || (label === 'Ctrl' && part.toLowerCase() === 'control'))?.[1]);
    if (!key || mods.some(mod => !mod)) {
        return null;
    }
    // GTK's key names are case-sensitive — F5, not f5 — and people type them
    // either way, so the key is tried as typed, then as GTK would spell it.
    for (const spelling of [key, key.toUpperCase(), key[0].toUpperCase() + key.slice(1).toLowerCase()]) {
        const accel = `${mods.join('')}${spelling}`;
        const [ok, keyval] = Gtk.accelerator_parse(accel);
        if (ok && keyval !== 0) {
            return accel;
        }
    }
    return null;
}

/** The actions that name a macro; the rest act on their own. */
const MACRO_TRIGGER_ACTIONS: readonly string[] = ['run', 'pause', 'stop'];

/**
 * The keyboard shortcuts, by settings key, and what each does — said the way a
 * trigger's action is, since they share one list.
 */
const keyboardShortcuts = (): [string, string][] => [
    ['run-macro', _('Starts or pauses everything switched on')],
    ['record-toggle', _('Starts or stops recording')],
    ['capture-step', _('Captures a step')],
    ['panic-stop', _('Emergency stop')],
];


/**
 * What decides whether a check works: advice first, then what your words are
 * actually sent as. That part is built from the real thing rather than
 * described, so it cannot quietly stop being true — and it is different for
 * the two kinds of model: a chat model gets your words inside an instruction
 * asking for a JSON verdict, a decision model gets them as one yes/no question
 * and answers with how likely yes is.
 */
function promptHelp(kind: 'chat' | 'decision', thresholdPercent: number): string {
    const lines = [
        _('<b>Ask so that Yes means: what you are waiting for is on the screen.</b>'),
        _('Put what the macro should then do in the If’s <b>Yes</b> branch, and waiting or trying again in <b>No</b>.'),
        '',
        _('<b>Good:</b>  Is the Ready button green?  → Yes: click it.  No: wait, try again.'),
        _('<b>Good:</b>  The player has over $900  → Yes: buy.  No: keep playing.'),
        _('<b>Avoid:</b>  Is the button not green? — say what you expect to see instead.'),
        _('<b>Avoid:</b>  The restart button is gone — ask whether it is there, and use No.'),
        _('<b>Cannot work:</b>  What colour is the button? — the answer is a word, not yes or no.'),
        _('<b>Cannot work:</b>  Count the enemies — that is an order, not a question.'),
        '',
        _('• One thing at a time. “green and enabled” lets the model be half right.'),
        _('• Say where it is: “the button at the bottom right”.'),
        _('• A tight <b>Area</b> helps more than any wording.'),
        _('• ▶ asks the model about the screen right now, so you can try the question before a macro relies on it.'),
        _('• If the model cannot be reached or gives no answer, the macro stops and the problem log says why.'),
        '',
    ];
    if (kind === 'decision') {
        lines.push(
            _('<b>When the model is not sure, the answer is No.</b> It only says Yes from') +
                ` ${thresholdPercent}% ` + _('sure. Raise that under Settings → Setup → <b>Yes from (%)</b> and the macro ' +
                'acts only when the model is very sure; when it is unsure, it waits.'),
            '',
        );
    }
    if (kind === 'decision') {
        lines.push(
            _('<b>Sent to a decision model</b> as one yes/no question about the screenshot. It answers with how likely yes is, ' +
              'and the check counts as yes from') + ` ${thresholdPercent}% ` + _('(Settings → Setup):'),
            '',
            `<tt>${GLib.markup_escape_text(JSON.stringify(
                { questions: { check: { type: 'noul', instructions: _('…your words go here…') } } }, null, 1), -1)}</tt>`,
        );
    } else {
        lines.push(
            _('<b>Your words are not sent on their own.</b> Every check sends the screenshot together with this, your text on the STATEMENT line:'),
            '',
            `<tt>${GLib.markup_escape_text(buildInstruction(_('…your words go here…')), -1)}</tt>`,
        );
    }
    return lines.join('\n');
}

/** What a hint under a check is saying, which decides how it looks. */
type HintTone = 'advice' | 'yes' | 'no' | 'failed';

/** What the model said when a check was tried, for showing where it applies; null clears it. */
type CheckAnswer = { match: boolean; reason: string; seconds: string } | null;

/** One entry of a menu: what it says, and what it does when picked. */
interface Choice {
    label: string;
    tooltip?: string;
    /** Drawn with a switch showing this, which `run` flips. */
    on?: boolean;
    run: () => void;
}

/** What highlighting a running step needs to get at, per step id. */
interface StepRow {
    /** An expander when the step folds or holds a block, a plain row when not. */
    row: Adw.ActionRow | Adw.ExpanderRow;
    icon: Gtk.Image;
    kindIcon: string;
    /** Rows that hold others get a rail rather than a fill: a fill would flood them. */
    container: boolean;
    /** An if's Yes and No headers, which follow its row and light up with it. */
    branchRows: Adw.ExpanderRow[];
}

export default class MacroclickwerkPreferences extends ExtensionPreferences {
    private _settings!: Gio.Settings;
    private _store!: MacroStore;
    private _window?: Adw.PreferencesWindow;
    private _macrosPage!: Adw.PreferencesPage;
    private _macroGroups: Adw.PreferencesGroup[] = [];

    // Structural edits rebuild the whole page, which would otherwise collapse
    // every expander. Expansion is keyed by step id so it survives a rebuild —
    // and it is persisted to settings, so the window reopens the way it was
    // left rather than every macro folded shut again.
    private _expanded = new Set<string>();
    private _collapsed = new Set<string>();
    private _persistExpansion = debounce(() => this._saveExpansion());
    private _rebuilding = false;
    private _rebuildScheduled = false;
    // Seeded from the clock, not 0: a reopened preferences window would otherwise
    // restart at 1 and could write a request identical to a previous one, which
    // GSettings does not signal.
    private _requestSerial = GLib.get_real_time();
    private _closed = false;

    // Rows the shell's running position is painted onto. Rebuilt with the page,
    // so highlighting can toggle style classes instead of rebuilding anything.
    private _stepRows = new Map<string, StepRow>();
    private _highlighted: string[] = [];
    /** Settings watchers held for the life of the window, dropped when it closes. */
    private _watchers: number[] = [];
    /** The ▶ beside each macro's name, by macro id: it becomes a pause. */
    private _runButtons = new Map<string, Gtk.Button>();

    // The selected row: click one and a recording goes there, and the macro
    // holding it continues from there. One across the whole page, in whichever
    // macro. Kept in settings rather than in a widget because the shell is what
    // acts on it, and because a rebuild of the page must not lose it.
    // "end:<macroId>" is the end of a macro, "after:<stepId>" a step,
    // "in:<stepId>:<branch>" a body.
    private _targetRows = new Map<string, Gtk.Widget>();
    /** The same rows, by widget: what `_innermostRow` tests a press against. */
    private _selectableRows = new Set<Gtk.Widget>();
    private _recordControls: Gtk.Widget[] = [];
    /** The row currently painted as the target, so it can be unpainted. */
    private _markedRow?: Gtk.Widget;

    // Every page but Macros. Their rows read the settings once, when built, so
    // importing settings has to build them again to show what arrived.
    private _settingsPages: Adw.PreferencesPage[] = [];
    private _triggersGroup!: Adw.PreferencesGroup;
    private _triggerRows: Adw.ActionRow[] = [];
    // Drag state: the row currently painted as the drop spot, and the folded
    // container a hovering drag is about to spring open.
    private _dropHighlight: Gtk.Widget | null = null;
    // Steps and checks at a named place whose numbers were asked for — for
    // this window only, since by the coordinates alone they are still the place.
    private _showNumbers = new WeakSet<object>();
    private _springId = 0;
    private _springRow: Adw.ExpanderRow | null = null;

    /**
     * **Pick** and **Show**, the pair every place on the screen gets, in that
     * order — first put something in the field, then look at it. Pick fills
     * the place in from the screen, and what that takes differs per caller;
     * Show flashes it, which is the only thing that makes raw numbers
     * meaningful. Either may be left out.
     */
    private _spotButtons(
        pick: { tooltip: string; run: () => void } | null,
        show: (() => void) | null,
    ): Gtk.Widget[] {
        const buttons: Gtk.Widget[] = [];
        if (pick) {
            buttons.push(iconButton('find-location-symbolic', pick.tooltip, pick.run));
        }
        if (show) {
            buttons.push(iconButton('view-reveal-symbolic',
                _('Flash this on the screen for a couple of seconds'), show));
        }
        return buttons;
    }


    /**
     * A group of numbers — a point, an area — as a field on a line rather than
     * a row of its own, so it can share the line with the buttons that act on
     * it. As wide as the numbers in it.
     */
    private _numbersEntry(
        values: number[],
        onChange: (values: number[]) => void,
        placeholder = 'x, y',
    ): Gtk.Entry {
        const entry = new Gtk.Entry({
            text: values.join(', '),
            placeholder_text: placeholder,
            valign: Gtk.Align.CENTER,
            xalign: 1,
        });
        fitToText(entry, values.map(() => '00').join(', '));
        commitNumbers(entry, values.length, values, onChange);
        return entry;
    }

    /**
     * Where a click or a move acts, as words on the step's own line: a
     * dropdown naming the place — the way every other choice in the editor
     * is made — and after it the numbers, when the place has some. A spot on
     * the screen also gets **Pick** and **Show**; an offset is numbers that
     * are not a place, so it gets neither. Picking another place redraws the
     * line, since what follows the dropdown changes with it.
     */
    private _positionControls<M extends string>(opts: {
        step: { id: string; mode: M; x?: number; y?: number; dx?: number; dy?: number };
        places: { mode: M; label: string; numbers?: 'spot' | 'offset' }[];
    }): Gtk.Widget[] {
        const { step } = opts;
        const doc = this._store.document;
        const spot = opts.places.find(place => place.numbers === 'spot')!.mode;
        // The named points come after the places, as places of their own; a
        // step aimed at one shows its name instead of its numbers — unless
        // x,y was picked to see and change them.
        const labels: Record<string, string> = {};
        for (const place of opts.places) {
            labels[place.mode] = place.label;
        }
        const points = livePoints(doc);
        for (const point of points) {
            labels[`point:${point.name}`] = point.name;
        }
        const named = step.mode === spot && !this._showNumbers.has(step)
            ? pointAt(doc, step.x, step.y) : undefined;
        // An area is aimed at its middle.
        const centre = named ? placeCentre(named) : undefined;
        const dropdown = chooser(
            [...opts.places.map(place => place.mode as string), ...points.map(point => `point:${point.name}`)],
            labels, named ? `point:${named.name}` : step.mode,
            centre ? `${_('Where this acts')}: ${centre.x}, ${centre.y}` : _('Where this acts'),
            value => {
                const point = points.find(p => `point:${p.name}` === value);
                if (point) {
                    step.mode = spot;
                    Object.assign(step, placeCentre(point));
                    this._showNumbers.delete(step);
                } else {
                    step.mode = value as M;
                    this._showNumbers.add(step); // only matters at x,y
                }
                this._saveAndRebuild();
            }, 14);
        const widgets: Gtk.Widget[] = [dropdown];

        const nameButton = () => this._placeNameButton(
            () => pointAt(doc, step.x, step.y), () => ({ x: step.x ?? 0, y: step.y ?? 0 }), true);
        if (centre) {
            widgets.push(nameButton(), ...this._spotButtons(null, () => this._showMarker(centre.x, centre.y)));
            return widgets;
        }
        const numbers = opts.places.find(place => place.mode === step.mode)?.numbers;
        if (numbers === 'offset') {
            widgets.push(this._numbersEntry([step.dx ?? 0, step.dy ?? 0], ([dx, dy]) => {
                step.dx = dx;
                step.dy = dy;
                this._save();
            }));
        } else if (numbers === 'spot') {
            const entry = this._numbersEntry([step.x ?? 0, step.y ?? 0], ([x, y]) => {
                step.x = x;
                step.y = y;
                this._save();
            });
            widgets.push(entry, nameButton(), ...this._spotButtons({
                tooltip: _('Click the spot on the screen: that position lands here'),
                run: () => this._pickPointInto(({ x, y }) => entry.set_text(`${x}, ${y}`)),
            }, () => {
                const [x, y] = parseNumbers(entry.get_text() ?? '', 2) ?? [0, 0];
                this._showMarker(x, y);
            }));
        }
        return widgets;
    }

    /**
     * The ▾ after a spot or an area: a name for it, so other steps and checks
     * can pick it from their list. The name belongs to the coordinates —
     * everything aimed at the same place shows it. The target moves the place,
     * and everything aimed at it with it; the trash takes the name away again,
     * leaving the numbers.
     *
     * `named` is the named place this field is at, if any; `place` what naming
     * it would name — read when the popup opens, from the numbers as they are.
     * A spot field is no place to pick an area again: there the target is
     * greyed out for an area, which is picked again from a check over it.
     */
    private _placeNameButton(
        named: () => NamedPoint | undefined,
        place: () => Place | null,
        spot = false,
    ): Gtk.MenuButton {
        const doc = this._store.document;
        const entry = new Gtk.Entry({ placeholder_text: _('Name this place'), width_chars: 14 });
        const trash = iconButton('user-trash-symbolic', _('Forget this name — everything keeps its coordinates'), () => {
            entry.set_text('');
            button.popdown();
        });
        const ok = new Gtk.Button({ label: _('OK'), css_classes: ['suggested-action'], tooltip_text: _('Save the name') });
        ok.connect('clicked', () => button.popdown());
        const moved = (point: NamedPoint) => (to: Place) => {
            const problem = movePoint(doc, point.name, to);
            if (problem) {
                this._toast(problem);
            } else {
                this._saveAndRebuild();
            }
        };
        const target = iconButton('find-location-symbolic',
            _('Pick it again on the screen: everything aimed at it moves there'), () => {
                const point = named();
                button.popdown();
                if (point?.w !== undefined) {
                    this._pickRegionInto(moved(point));
                } else if (point) {
                    this._pickPointInto(moved(point));
                }
            });
        const box = new Gtk.Box({ spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        box.append(entry);
        box.append(ok);
        box.append(target);
        box.append(trash);
        const popover = new Gtk.Popover({ child: box });
        const button = new Gtk.MenuButton({
            icon_name: 'pan-down-symbolic',
            tooltip_text: _('Name this place'),
            valign: Gtk.Align.CENTER,
            popover,
        });
        button.add_css_class('flat');
        // Taken however it closes — OK, Enter, a click elsewhere, the trash.
        popover.connect('show', () => {
            const point = named();
            entry.set_text(point?.name ?? '');
            // The whole screen is no place to name.
            const nameable = point !== undefined || place() !== null;
            entry.set_sensitive(nameable);
            entry.set_placeholder_text(nameable ? _('Name this place') : _('Pick an area first'));
            ok.set_visible(nameable);
            trash.set_visible(point !== undefined);
            target.set_visible(point !== undefined);
            const fromArea = spot && point?.w !== undefined;
            target.set_sensitive(!fromArea);
            target.set_tooltip_text(fromArea
                ? _('The middle of an area — pick the area again from a check over it')
                : _('Pick it again on the screen: everything aimed at it moves there'));
            entry.grab_focus();
        });
        popover.connect('closed', () => {
            const name = (entry.get_text() ?? '').trim();
            const point = named();
            const where = point ?? place();
            if (name === (point?.name ?? '') || !where) {
                return;
            }
            const problem = namePlace(doc, where, name);
            if (problem) {
                this._toast(problem);
            } else {
                this._saveAndRebuild();
            }
        });
        entry.connect('activate', () => button.popdown());
        return button;
    }

    /**
     * Where a check looks, when there are named areas to choose from: a
     * dropdown of them, before the numbers. A check over exactly a named area
     * shows its name instead of its numbers — until x,y,w,h is picked to see
     * and change them. The ▾ to name the area comes after the numbers' field,
     * `numbers[0]`; the rest of `numbers` are its buttons.
     */
    private _areaControls(
        holder: object,
        area: () => Region | null,
        set: (area: Region) => void,
        numbers: Gtk.Widget[],
    ): Gtk.Widget[] {
        const doc = this._store.document;
        const nameButton = this._placeNameButton(() => areaAt(doc, area()), area);
        const named = this._showNumbers.has(holder) ? undefined : areaAt(doc, area());
        const areas = livePoints(doc).filter(point => point.w !== undefined);
        if (areas.length === 0) {
            return [numbers[0], nameButton, ...numbers.slice(1)];
        }
        const labels: Record<string, string> = { '': _('x,y,w,h') };
        for (const each of areas) {
            labels[`area:${each.name}`] = each.name;
        }
        const dropdown = chooser(['', ...areas.map(each => `area:${each.name}`)], labels,
            named ? `area:${named.name}` : '',
            named ? `${_('Where this looks')}: ${named.x}, ${named.y}, ${named.w}, ${named.h}` : _('Where this looks'),
            value => {
                const chosen = areas.find(each => `area:${each.name}` === value);
                if (chosen) {
                    set({ x: chosen.x, y: chosen.y, w: chosen.w!, h: chosen.h! });
                    this._showNumbers.delete(holder);
                } else {
                    this._showNumbers.add(holder);
                }
                this._saveAndRebuild();
            }, 14);
        if (named) {
            return [dropdown, nameButton, ...this._spotButtons(null,
                () => this._showMarker(named.x, named.y, named.w, named.h))];
        }
        return [dropdown, numbers[0], nameButton, ...numbers.slice(1)];
    }

    /**
     * `defaultExpanded` opens a row the first time it is seen — a repeat with
     * steps in it, and every if — so the page opens onto steps rather than
     * closed rows. Collapsing is remembered separately, or the default would
     * undo it on the next rebuild.
     */
    private _expander(
        key: string,
        props: Partial<Adw.ExpanderRow.ConstructorProps>,
        defaultExpanded = false,
    ): Adw.ExpanderRow {
        const expanded = this._collapsed.has(key)
            ? false
            : defaultExpanded || this._expanded.has(key);
        const row = new Adw.ExpanderRow({ ...props, expanded });
        row.connect('notify::expanded', () => {
            if (this._rebuilding) {
                return; // teardown, not a user action
            }
            if (row.get_expanded()) {
                this._expanded.add(key);
                this._collapsed.delete(key);
            } else {
                this._expanded.delete(key);
                this._collapsed.add(key);
            }
            this._persistExpansion();
        });
        return row;
    }

    /** Restore which rows were open when the window was last used. */
    private _loadExpansion(): void {
        try {
            const raw = JSON.parse(this._settings.get_string('expanded-rows')) as {
                open?: string[]; shut?: string[];
            };
            this._expanded = new Set(Array.isArray(raw.open) ? raw.open : []);
            this._collapsed = new Set(Array.isArray(raw.shut) ? raw.shut : []);
        } catch {
            // A bad document is a fresh start, not a crash.
        }
    }

    /**
     * Written debounced on every toggle rather than on close: a settings
     * window has no reliable goodbye, but it always has a latest state.
     */
    private _saveExpansion(): void {
        if (this._closed) {
            return;
        }
        // Keys are `step:<id>`, for the repeats and ifs that fold, and
        // `macro:<id>` for the macros. Keys of deleted ones are dropped here,
        // or everything ever removed would leave its state behind forever.
        const ids = new Set<string>();
        for (const macro of this._store.macros) {
            ids.add(macro.id);
            walk(macro.body, location => { ids.add(location.step.id); });
        }
        const alive = (key: string) => ids.has(key.split(':')[1] ?? '');
        this._settings.set_string('expanded-rows', JSON.stringify({
            open: [...this._expanded].filter(alive),
            shut: [...this._collapsed].filter(alive),
        }));
    }

    /** Load the editor's own style classes once, on top of whatever theme is set. */
    private _installCss(): void {
        const display = Gdk.Display.get_default();
        if (!display) {
            return;
        }
        try {
            const provider = new Gtk.CssProvider();
            provider.load_from_string(EDITOR_CSS);
            Gtk.StyleContext.add_provider_for_display(
                display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        } catch (error) {
            // Cosmetic only: an unparsable rule must not cost you the editor.
            log(`macroclickwerk: could not load editor styles: ${(error as Error).message}`);
        }
    }

    /**
     * Raise the clamp libadwaita puts inside a preferences page. It is internal
     * to the page, so this walks down to it rather than setting a property; if a
     * future libadwaita builds the page some other way there is simply no clamp
     * to find, and the page keeps whatever width it came with.
     */
    private _widen(widget: Gtk.Widget, max: number): number {
        let found = 0;
        for (const child of descendants(widget)) {
            if (child instanceof Adw.Clamp) {
                child.maximum_size = max;
                found++;
            }
        }
        return found;
    }

    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._window = window;
        const [width, height] = window.get_default_size();
        if (width < EDITOR_WINDOW_WIDTH) {
            window.set_default_size(EDITOR_WINDOW_WIDTH, height);
        }
        this._settings = this.getSettings();
        this._store = new MacroStore(this._settings);
        this._loadExpansion();
        this._installCss();

        this._macrosPage = new Adw.PreferencesPage({
            title: _('Macros'),
            iconName: 'view-list-symbolic',
            css_classes: ['macroclickwerk-editor'],
        });
        // Only this page: the settings pages beside it are ordinary rows, and
        // 600 is what those are meant to be. Done once here — a rebuild swaps
        // the groups out, not the page, so the clamp outlives it.
        if (this._widen(this._macrosPage, EDITOR_MAX_WIDTH) === 0) {
            // Nothing to widen means libadwaita stopped building the page the
            // way this expects. Cosmetic, so it is a line in the journal rather
            // than a failure — but a silent narrow editor is hard to tell from a
            // stale build, and this says which it is.
            log('macroclickwerk: no clamp in the macros page, editor stays at its default width');
        }
        window.add(this._macrosPage);
        this._addSettingsPages();

        this._rebuildMacros();

        // The shell writes to the same document — after recording, for instance.
        // Every step object we are holding is stale at that point, so rebuild.
        const unsubscribe = this._store.onChanged(external => {
            if (external) {
                this._rebuildMacros();
            }
        });

        // Kept as a list so that connecting and disconnecting cannot drift
        // apart: a watcher added here is dropped below without being named
        // twice more.
        this._watchers.push(
            // Where the shell's runner currently is. Only style classes change,
            // so this can arrive several times a second without disturbing an
            // edit.
            this._settings.connect('changed::running-steps', () => {
                this._reportEditedStops();
                this._applyRunningHighlight();
            }),
            // Both are painted by the same pass: the target only reads as a
            // target once you can see whether it is live.
            this._settings.connect('changed::record-into', () => this._applyRecordTarget()),
            // The help under every model check describes what is sent, which
            // depends on the kind of model and, for a decision model, the bar.
            this._settings.connect('changed::llm-kind', () => this._saveAndRebuild()),
            this._settings.connect('changed::llm-decision-threshold', debounce(() => this._saveAndRebuild())),
            this._settings.connect('changed::recording', () => this._applyRecordTarget()),
        );

        window.connect('close-request', () => {
            this._closed = true;
            unsubscribe();
            for (const id of this._watchers.splice(0)) {
                this._settings.disconnect(id);
            }
            this._store.destroy();
            return false;
        });
    }

    private _save(): void {
        this._store.save();
    }

    /**
     * Most rebuilds are triggered from a widget's own signal handler, which would
     * mean destroying that widget mid-emission. Defer to an idle so the handler
     * returns first; the flag also collapses several edits into one rebuild.
     */
    private _saveAndRebuild(): void {
        this._store.save();
        if (this._rebuildScheduled) {
            return;
        }
        this._rebuildScheduled = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildScheduled = false;
            if (!this._closed) {
                this._rebuildMacros();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- macros page -------------------------------------------------------

    /** The scrolled window the macros page puts its own content in. */
    private _scroller(): Gtk.ScrolledWindow | null {
        return firstDescendant(this._macrosPage,
            (child): child is Gtk.ScrolledWindow => child instanceof Gtk.ScrolledWindow);
    }

    /**
     * A rebuild throws away every row and builds new ones, and the view goes
     * back to the top with them — so adding a step deep in a macro used to take
     * you away from the place you were editing.
     *
     * Setting the offset once is not enough. At the moment the rebuild returns,
     * neither the removal nor the additions have reached the adjustment yet, so
     * the value looks like it took; a frame later the page is briefly empty,
     * GTK clamps against that, and the view is at the top again. So put it back
     * on every change of geometry until the layout settles.
     *
     * The other way back to the top is the keyboard focus: whatever it lands on
     * gets scrolled into view. The rebuild drops the focus rather than let GTK
     * choose, but a popover closing after the rebuild — the list of a dropdown
     * you just picked from — can still hand it somewhere. So watch that too,
     * and put the view back after it.
     */
    private _restoreScroll(offset: number): void {
        const adjustment = this._scroller()?.get_vadjustment();
        if (!adjustment || offset <= 0) {
            return;
        }
        const put = () => {
            const max = Math.max(adjustment.get_upper() - adjustment.get_page_size(), 0);
            adjustment.set_value(Math.min(offset, max));
        };
        put();

        const undo: Array<() => void> = [];
        const adjustmentId = adjustment.connect('changed', put);
        undo.push(() => adjustment.disconnect(adjustmentId));

        const window = this._window;
        if (window) {
            const focusId = window.connect('notify::focus-widget', () => {
                // After the scrolled window has had its say about the new
                // focus, not before it.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    put();
                    return GLib.SOURCE_REMOVE;
                });
            });
            undo.push(() => window.disconnect(focusId));
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_SETTLE_MS, () => {
            while (undo.length > 0) {
                undo.pop()?.();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    private _rebuildMacros(): void {
        const offset = this._scroller()?.get_vadjustment().get_value() ?? 0;
        // Whatever had the keyboard focus is about to be destroyed — a dropdown
        // you just picked from, say. GTK would hand the focus to some other row
        // and scroll that one into view, undoing the restore below. It is gone
        // either way, so let go of it here rather than let GTK choose.
        this._window?.set_focus(null);
        this._rebuilding = true;
        for (const group of this._macroGroups) {
            this._macrosPage.remove(group);
        }
        this._macroGroups = [];
        this._rebuilding = false;
        // Every row just went away, so nothing is highlighted any more either.
        this._stepRows.clear();
        this._targetRows.clear();
        this._selectableRows.clear();
        this._markedRow = undefined;
        this._runButtons.clear();
        this._recordControls = [];
        this._highlighted = [];

        // A heading and nothing under it: backup is two menus beside Add rather
        // than a card of its own, so the first macro starts one line down.
        const actions = new Adw.PreferencesGroup({ title: _('Macros') });

        const addButton = new Gtk.Button({
            label: _('Add macro'),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => {
            this._store.addMacro(newMacro(`Macro ${this._store.macros.length + 1}`));
            this._rebuildMacros();
        });
        const headerButtons = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        headerButtons.append(this._livePopupButton(new Gtk.MenuButton({
            label: _('Collections'),
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Files of macros: load them, switch them on and off, save them'),
        }), () => this._collectionChoices()));
        for (const button of this._transferButtons()) {
            headerButtons.append(button);
        }
        headerButtons.append(addButton);
        actions.set_header_suffix(headerButtons);

        this._macrosPage.add(actions);
        this._macroGroups.push(actions);

        const shown = this._store.macros.filter(macro => macroLive(this._store.document, macro));
        if (shown.length === 0) {
            const empty = new Adw.PreferencesGroup();
            empty.add(new Adw.ActionRow({
                title: _('No macros yet'),
                subtitle: this._store.macros.length > 0
                    ? _('Add one, or switch a collection on')
                    : _('Add one, then record into it'),
            }));
            this._macrosPage.add(empty);
            this._macroGroups.push(empty);
            return;
        }

        for (const macro of shown) {
            const group = this._buildMacroGroup(macro);
            this._macrosPage.add(group);
            this._macroGroups.push(group);
        }

        // A rebuild in the middle of a run — after a recording, say — must not
        // lose the marker on the step the runner is on.
        this._applyRunningHighlight();
        this._applyRecordTarget();
        this._restoreScroll(offset);
    }

    // --- running position --------------------------------------------------

    /**
     * The shell publishes the chain of steps its runner is inside. Light up the
     * last one, and mark the loops and ifs above it: those stay visible even when
     * the step itself is inside a collapsed body.
     */
    private _applyRunningHighlight(): void {
        for (const id of this._highlighted) {
            const entry = this._stepRows.get(id);
            if (entry) {
                this._setRunState(entry, 'idle');
            }
        }
        this._highlighted = [];

        const paths = this._runningPaths();
        for (const { steps } of paths) {
            steps.forEach((id, index) => {
                const entry = this._stepRows.get(id);
                if (!entry) {
                    return; // a step just deleted
                }
                this._setRunState(entry, index === steps.length - 1 ? 'active' : 'ancestor');
                this._highlighted.push(id);
            });
        }

        // The ▶ beside each macro is the other half of this: a macro whose steps
        // are all inside folded bodies would otherwise show nothing at all.
        const running = new Set(paths.map(entry => entry.macro));
        for (const [macroId, button] of this._runButtons) {
            this._setRunButton(button, running.has(macroId));
        }
    }

    private _setRunButton(button: Gtk.Button, running: boolean): void {
        button.set_icon_name(running
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic');
        button.set_tooltip_text(running
            ? _('Pause — the next ▶ continues from where this got to')
            : _('Run this macro now'));
        if (running) {
            button.add_css_class('macroclickwerk-running-icon');
        } else {
            button.remove_css_class('macroclickwerk-running-icon');
        }
    }

    /** The line under a macro's name: what the switch beside it means. */
    private _macroHint(macro: Macro): string {
        return macroEnabled(macro)
            ? _('On — runs with the others when you press Run')
            : _('Off — only runs from its own ▶');
    }

    /**
     * Paint the mark: on the row Run starts from and a recording goes into,
     * turning red while a recording is actually running — the point of showing
     * it here at all is that the panel icon is a long way from the body you
     * chose.
     */
    private _applyRecordTarget(): void {
        clearClasses(this._markedRow, RECORD_CLASSES);

        // A selection nothing on the page answers to — none yet, or one left in
        // a macro that has since gone — becomes the first step of the macro
        // being worked on, so a macro opened for the first time says out loud
        // that it starts at the top. Written back rather than only painted:
        // this is the step Run begins at, and a mark shown on one row while the
        // run obeys another would be worse than no mark at all.
        const macro = this._store.activeMacro;
        const first = macro?.body[0];
        // A folded macro has no rows to find the selection among, which is not
        // the same as the selection being gone: it stays where it was.
        if (macro && first && !this._macroFolded(macro) &&
            !this._targetRows.has(this._settings.get_string('record-into'))) {
            this._selectTarget(macro.id, `after:${first.id}`);
        }

        // A macro with nothing in it yet has only its "add step here" row to
        // offer, which is where a recording would land anyway.
        const target = this._settings.get_string('record-into');
        const row = this._targetRows.get(target)
            ?? this._targetRows.get(`end:${macro?.id ?? ''}`);
        this._markedRow = row;

        const recording = this._settings.get_string('recording') !== '';
        if (row) {
            const base = recording ? 'macroclickwerk-recording-now' : 'macroclickwerk-record-target';
            row.add_css_class(row instanceof Adw.ExpanderRow ? `${base}-block` : base);
        }

        // The record controls cannot start anything else during a whole
        // recording, and go red rather than dead so the reason is visible.
        for (const control of this._recordControls) {
            setClass(control, 'destructive-action', recording);
        }
    }

    // --- drag and drop ------------------------------------------------------

    /**
     * The GNOME grip: drag it and the whole step comes along, subtree and all
     * — an `if` moves with both its branches, which is the only thing moving
     * an `if` can mean. The grip is the one drag handle so nothing else on a
     * row ever starts a drag by accident, and rows without one (Yes/No
     * headers, add rows) are visibly places rather than things.
     */
    private _grip(macro: Macro, step: Step, row: Gtk.Widget): Gtk.Widget {
        const grip = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['macroclickwerk-grip'],
            tooltip_text: _('Drag to move this step; what is inside moves with it'),
        });
        grip.set_cursor_from_name('grab');
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', () =>
            Gdk.ContentProvider.new_for_value(`${macro.id} ${step.id}`));
        source.connect('drag-begin', () => {
            // The row itself as the drag image, so what floats under the
            // pointer is what was picked up.
            source.set_icon(new Gtk.WidgetPaintable({ widget: row }), 12, 12);
        });
        grip.add_controller(source);
        return grip;
    }

    /**
     * Accept step drops on a row. `zone` maps where the pointer is (0 top … 1
     * bottom) to what a drop there means; `place` turns that into a spot in
     * the document, resolved at drop time so it is read against the current
     * tree, not the one from when the row was built. A `springRow` folds open
     * after a moment of hovering, so a drop can reach into closed containers.
     *
     * On a row that holds others — a repeat, a When, a Yes or No — the
     * pointer is placed against the row's own line, not the whole block: the
     * block is as tall as everything open inside it, so halves of it put the
     * line's own bottom half in "before". The drop mark goes on that line too;
     * one drawn under the whole block would say "after all of this", which is
     * not where the step goes.
     */
    private _droppable(
        row: Gtk.Widget,
        macro: Macro,
        zone: (fraction: number) => DropZone | null,
        place: (where: DropZone) => { list: Step[]; at: number } | null,
        springRow?: Adw.ExpanderRow,
    ): void {
        const line = (row instanceof Adw.ExpanderRow ? this._headerOf(row) : null) ?? row;
        const fraction = (y: number) => y / Math.max(1, line.get_height());
        const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        target.connect('motion', (_target, _x, y) => {
            const where = zone(fraction(y));
            this._paintDrop(line, where);
            if (springRow && !springRow.get_expanded()) {
                this._armSpring(springRow);
            }
            return where ? Gdk.DragAction.MOVE : 0;
        });
        target.connect('leave', () => {
            this._paintDrop(line, null);
            this._disarmSpring();
        });
        target.connect('drop', (_target, value, _x, y) => {
            this._paintDrop(line, null);
            this._disarmSpring();
            const [macroId, stepId] = String(value).split(' ');
            if (macroId !== macro.id) {
                return false;   // each card is one document; no reaching across
            }
            const where = zone(fraction(y));
            const dest = where ? place(where) : null;
            if (!dest || !moveStepTo(macro.body, stepId, dest.list, dest.at)) {
                return false;   // e.g. a loop dropped into its own body
            }
            this._saveAndRebuild();
            return true;
        });
        row.add_controller(target);
    }

    private _paintDrop(row: Gtk.Widget, where: DropZone | null): void {
        if (this._dropHighlight !== row) {
            clearClasses(this._dropHighlight, DROP_CLASSES);
        }
        clearClasses(row, DROP_CLASSES);
        if (where) {
            row.add_css_class(where === 'before' ? 'macroclickwerk-drop-above'
                : where === 'after' ? 'macroclickwerk-drop-below'
                    : 'macroclickwerk-drop-into');
            this._dropHighlight = row;
        } else {
            this._dropHighlight = null;
        }
    }

    private _armSpring(row: Adw.ExpanderRow): void {
        if (this._springRow === row) {
            return;
        }
        this._disarmSpring();
        this._springRow = row;
        this._springId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPRING_OPEN_MS, () => {
            this._springId = 0;
            this._springRow = null;
            row.set_expanded(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _disarmSpring(): void {
        if (this._springId) {
            GLib.source_remove(this._springId);
            this._springId = 0;
        }
        this._springRow = null;
    }

    /**
     * Register a row under its target name, for the painter to find, and make a
     * click on it the selection. One mark with two jobs: it is where a
     * recording lands, and it is the step Run starts from — so pointing at a
     * row is how you say "start here", and the blue on it is the answer.
     *
     * On the default bubble phase, which is the whole difference from the last
     * time rows took a click. A press that a button, a dropdown or an entry on
     * the row has already claimed never reaches here, so stepping a number
     * field no longer drags the mark along with it — that roaming was why the click
     * was taken away in the first place.
     */
    private _selectable(row: Gtk.Widget, target: string, macroId: string): void {
        const click = new Gtk.GestureClick({ button: Gdk.BUTTON_PRIMARY });
        click.connect('pressed', (_gesture, _presses, x: number, y: number) => {
            if (this._innermostRow(row, x, y) === row) {
                this._selectTarget(macroId, target);
            }
        });
        row.add_controller(click);
        row.add_css_class('macroclickwerk-selectable');
        this._targetRows.set(target, row);
        this._selectableRows.add(row);
    }

    /**
     * Of the rows a press landed in, the one actually pointed at.
     *
     * Rows contain rows — the steps of a loop body are children of the loop's
     * own row — so one press runs the gesture on every row it is inside, in
     * that order, and the outermost has the last word. That is how clicking a
     * wait marked the loop three levels above it instead.
     *
     * Settled by asking what is under the pointer rather than by claiming the
     * press: a claim here would be taking it from the drag that starts on the
     * grip and from the chevron that folds a body, which are the two things on
     * a row that answer to being held rather than tapped. So every row the
     * press passes through asks this, and all but the nearest stand aside.
     */
    private _innermostRow(row: Gtk.Widget, x: number, y: number): Gtk.Widget | null {
        let widget = row.pick(x, y, Gtk.PickFlags.DEFAULT);
        while (widget) {
            if (this._selectableRows.has(widget)) {
                return widget;
            }
            widget = widget.get_parent();
        }
        return null;
    }

    /**
     * Put the mark back on a macro's first step — where a run starts when it
     * has not been told otherwise. Said in the editor rather than left to the
     * shell's own forgetting, so the blue lands on the macro whose button was
     * pressed rather than on whichever one was last worked on. A macro with no
     * steps has only its end to point at.
     */
    private _selectTop(macro: Macro): void {
        const first = macro.body[0];
        this._selectTarget(macro.id, first ? `after:${first.id}` : `end:${macro.id}`);
    }

    /**
     * Make a row's spot the selection: which macro is being worked on, and
     * where recordings land. Written only on change, so re-selecting the same
     * row does not churn `changed::` signals.
     */
    private _selectTarget(macroId: string, target: string): void {
        if (this._store.activeMacroId !== macroId) {
            this._store.activeMacroId = macroId;
        }
        if (this._settings.get_string('record-into') !== target) {
            this._settings.set_string('record-into', target);
        }
    }

    /** What the shell publishes: one chain of step ids per running macro. */
    private _runningPaths(): { macro: string; steps: string[] }[] {
        try {
            const raw = this._settings.get_string('running-steps');
            if (!raw) {
                return [];
            }
            const parsed = JSON.parse(raw) as { running?: unknown };
            if (!Array.isArray(parsed.running)) {
                return [];
            }
            return parsed.running
                .filter((entry): entry is { macro: string; steps: string[] } =>
                    !!entry && typeof entry.macro === 'string' && Array.isArray(entry.steps))
                .map(entry => ({
                    macro: entry.macro,
                    steps: entry.steps.filter(id => typeof id === 'string'),
                }));
        } catch {
            return [];
        }
    }

    private _runningMacroIds(): string[] {
        return this._runningPaths().map(entry => entry.macro);
    }

    /**
     * The shell stops a macro that is edited while it runs, because the run is
     * walking the steps it started with and cannot be handed new ones. Say so:
     * on its own, the highlight simply going out reads as a crash.
     */
    private _reportEditedStops(): void {
        let edited: unknown;
        try {
            edited = (JSON.parse(this._settings.get_string('running-steps') || '{}') as
                { edited?: unknown }).edited;
        } catch {
            return;
        }
        if (!Array.isArray(edited)) {
            return;
        }
        for (const id of edited) {
            if (typeof id !== 'string') {
                continue;
            }
            const name = this._store.getMacro(id)?.name;
            this._toast(`Stopped “${name ?? 'macro'}” — it changed while running. ` +
                'Press play to run the new version.');
        }
    }

    private _setRunState(entry: StepRow, state: 'idle' | 'active' | 'ancestor'): void {
        clearClasses(entry.row, RUN_ROW_CLASSES);
        clearClasses(entry.icon, RUN_ICON_CLASSES);
        entry.icon.icon_name = entry.kindIcon;
        // The body headers sit beside the step now, not inside it, so they need
        // the same rail or the chain of rails breaks at every loop.
        for (const branch of entry.branchRows) {
            setClass(branch, 'macroclickwerk-running-block', state !== 'idle');
        }

        if (state === 'active') {
            entry.icon.icon_name = 'media-playback-start-symbolic';
            entry.icon.add_css_class('macroclickwerk-running-icon');
            entry.row.add_css_class(entry.container ? 'macroclickwerk-running-block' : 'macroclickwerk-running');
        } else if (state === 'ancestor') {
            entry.icon.add_css_class('macroclickwerk-running-parent-icon');
            entry.row.add_css_class('macroclickwerk-running-block');
        }
    }

    /**
     * The row that ends a macro and every nested block: two buttons, one that
     * appends a step into `into` and one that records there — one step, or a
     * whole recording landing there. No title: "Add step" on the button is the
     * whole of what the row says. `stepId` and `listKey` name the nested body
     * the row sits in, null for the macro itself — the selection target is
     * derived from them here, so the two ways of recording cannot disagree
     * about the spot.
     */
    private _addStepRow(into: Step[], macroId: string, stepId: string | null, listKey: string | null): Adw.ActionRow {
        const target = stepId ? `in:${stepId}:${listKey}` : `end:${macroId}`;
        // A place rather than a step, so it is drawn smaller than one: a short
        // line, flat buttons as tall as their text.
        const row = new Adw.ActionRow({ css_classes: ['macroclickwerk-add'] });

        // Named as the rows name them, so what you pick is what you see.
        const titles = stepTitles();
        const add = this._menuButton(_('Add step'), STEP_KINDS.map(kind => ({
            label: titles[kind],
            run: () => {
                into.push(newStep(kind));
                this._saveAndRebuild();
            },
        })), 'list-add-symbolic');

        const record = this._menuButton(_('Record'), [
            { label: _('One step'), run: () => this._captureStepInto(macroId, stepId, listKey) },
            { label: _('Multiple steps'), run: () => this._recordInto(macroId, target) },
        ], 'media-record-symbolic');
        record.set_tooltip_text(_('One step: click anywhere on screen, or move the pointer and hold still. ' +
            'Multiple steps: everything until recording is stopped'));
        this._recordControls.push(record);

        const buttons = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        buttons.append(add);
        buttons.append(record);
        row.add_prefix(buttons);
        return row;
    }

    private _buildMacroGroup(macro: Macro): Adw.PreferencesGroup {
        // No heading: the name field is the heading, and the controls for the
        // whole macro sit on its line — a title saying the name, a line under
        // it saying what the switch means and a field saying the name again
        // were three lines for one.
        const group = new Adw.PreferencesGroup();

        // Its own ▶, whether it is switched on or not: the switch is about the
        // next press of Run, this is about now. It turns into a Pause while the
        // macro is going, which is also how the editor shows that it is — the
        // panel icon is a long way from the window you are looking at.
        const runButton = iconButton('media-playback-start-symbolic',
            _('Run this macro now'),
            () => this._runMacroNow(macro.id,
                this._runningMacroIds().includes(macro.id) ? 'pause' : 'run'));
        this._runButtons.set(macro.id, runButton);

        // Beside it always, not only while something is running. Both buttons
        // end a run; the difference is where the next ▶ begins — here, or at
        // the top — and that is a choice worth two buttons rather than one that
        // guesses. Left standing when nothing is running because the second
        // half of what it does still applies: it is how you say "back to the
        // top" to a macro you last ran halfway through, without hunting for the
        // first row to click on.
        const stopButton = iconButton('media-playback-stop-symbolic',
            _('Stop — ends the run, and the next ▶ starts from the top'),
            () => {
                this._runMacroNow(macro.id, 'stop');
                this._selectTop(macro);
            });

        // What the switch means is its tooltip, and changes with it.
        const enabled = new Gtk.Switch({
            active: macroEnabled(macro),
            valign: Gtk.Align.CENTER,
            tooltip_text: this._macroHint(macro),
        });
        enabled.connect('notify::active', () => {
            macro.enabled = enabled.get_active();
            enabled.set_tooltip_text(this._macroHint(macro));
            this._save();
        });

        // One at a time: a lock, pressed in while it takes turns with the
        // others — a second switch beside the on/off one would read as the same.
        const exclusive = new Gtk.ToggleButton({
            active: macroExclusive(macro),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const showExclusive = () => {
            const on = exclusive.get_active();
            exclusive.set_icon_name(on ? 'changes-prevent-symbolic' : 'changes-allow-symbolic');
            exclusive.set_tooltip_text(on
                ? _('One at a time — takes turns with the others that do: acts until a Wait, an On Event, ' +
                    'a pause or the next round of a Repeat, then lets them go first. From its next run')
                : _('Side by side — acts whenever it likes, without waiting for or holding up any other. ' +
                    'From its next run'));
        };
        showExclusive();
        exclusive.connect('toggled', () => {
            macro.exclusive = exclusive.get_active() ? undefined : false;
            // Redrawn: the locks on its Waits and Repeats grey out with it.
            this._saveAndRebuild();
        });

        const remove = iconButton('user-trash-symbolic', _('Delete this macro'), () => {
            this._store.removeMacro(macro.id);
            this._rebuildMacros();
        });

        const nameRow = entryRow(macro.collection
            ? `${_('Macro')} · ${collectionName(macro.collection)}` : _('Macro'), macro.name, text => {
            macro.name = text;
            this._save();
        });
        nameRow.add_css_class('macroclickwerk-macro-name');
        // Into and out of collections: built as it opens, since what there is
        // to move to changes with every load.
        const more = this._livePopupButton(new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Move or copy it to a collection'),
        }), () => this._macroChoices(macro));
        // Its place in the list, on its line: a step up or down among the
        // macros shown, greyed out at either end.
        const doc = this._store.document;
        const shown = doc.macros.filter(other => macroLive(doc, other));
        const index = shown.indexOf(macro);
        const step = (delta: 1 | -1) => {
            const button = iconButton(delta < 0 ? 'go-up-symbolic' : 'go-down-symbolic',
                delta < 0 ? _('Move this macro up') : _('Move this macro down'), () => {
                    moveMacro(doc, macro.id, delta);
                    this._saveAndRebuild();
                });
            button.set_sensitive(delta < 0 ? index > 0 : index < shown.length - 1);
            return button;
        };
        // The order every line in the editor keeps: what this line is about,
        // then ▶, then the bin last.
        for (const widget of [step(-1), step(1), exclusive, enabled, runButton, stopButton, more, remove]) {
            nameRow.add_suffix(widget);
        }
        group.add(nameRow);

        // Folded, a macro is its one line: the arrow on the left, the way a
        // Repeat or an If folds, and remembered the same way. Drawn that way
        // rather than hidden after: folding redraws the page, so nothing under
        // the line can come back on its own — an If's Yes and No follow their
        // If, and would otherwise follow it back into view.
        const folded = this._macroFolded(macro);
        const fold = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            icon_name: folded ? 'pan-end-symbolic' : 'pan-down-symbolic',
            css_classes: ['flat', 'macroclickwerk-fold'],
            tooltip_text: _('Fold or unfold'),
        });
        fold.connect('clicked', () => {
            const key = `macro:${macro.id}`;
            if (folded) {
                this._collapsed.delete(key);
            } else {
                this._collapsed.add(key);
            }
            this._persistExpansion();
            this._rebuildMacros();
        });
        nameRow.add_prefix(fold);
        if (folded) {
            // It still says how much is in it, as a folded Repeat does.
            const count = macro.body.length;
            nameRow.set_title(`${nameRow.get_title()} · ${count} ${count === 1 ? _('step') : _('steps')}`);
            return group;
        }

        const addRow = this._addStepRow(macro.body, macro.id, null, null);
        this._selectable(addRow, `end:${macro.id}`, macro.id);
        this._droppable(addRow, macro,
            () => 'into',
            () => ({ list: macro.body, at: macro.body.length }));

        // Which event each step answers to, worked out once for the macro: every
        // row needs it, and asking per row rescanned the whole macro per row.
        const under = eventFollows(macro.body);
        for (const widget of this._buildStepList(macro, macro.body, under, 0)) {
            group.add(widget);
        }
        // Under the steps, where what it adds will appear.
        group.add(addRow);

        return group;
    }

    /**
     * A step's title. Steps that name another macro say its name rather than
     * its id, so a renamed macro reads correctly everywhere it is referred to —
     * and likewise for the step a start begins at. Ids are unique across the
     * document, so the step is looked for in every macro rather than threading
     * through which one the caller is editing.
     */
    private _describe(step: Step): string {
        const doc = this._store.document;
        return describeStep(step, id => this._store.getMacro(id)?.name, stepId => {
            for (const macro of this._store.macros) {
                const loc = findStep(macro.body, stepId);
                if (loc) {
                    return describeStep(loc.step, id => this._store.getMacro(id)?.name, undefined, doc);
                }
            }
            return undefined;
        }, doc);
    }

    /**
     * A step's title as a row shows it. Every kind but `if` is one word — see
     * `stepTitles` — and a repeat adds, dimmed, how much its body holds, so a
     * folded one still says. An `if` says its condition instead, which is the
     * one thing about it not on its line. Row titles are Pango markup, so any
     * colour the condition names is followed by a block of that colour, and
     * everything else is escaped: a prompt is free to hold an ampersand.
     */
    private _rowTitle(step: Step): string {
        if (step.kind === 'if') {
            return withColorSwatches(this._describe(step));
        }
        if (step.kind === 'loop') {
            return this._titleWith(stepTitles().loop, step.body.length === 0
                ? _('empty — skipped') : this._countLabel(step.body.length));
        }
        return this._titleWith(stepTitles()[step.kind]);
    }

    /**
     * A row title as markup, with an optional note after it that annotates
     * rather than names — "Repeat  3 steps", "Area  whole screen" — dimmed.
     */
    private _titleWith(title: string, note?: string): string {
        const escaped = GLib.markup_escape_text(title, -1);
        return note === undefined
            ? escaped
            : `${escaped}  <span alpha="55%">${GLib.markup_escape_text(note, -1)}</span>`;
    }

    /**
     * "3 steps", "empty" — the same phrasing wherever something is counted.
     * `words` is the singular and the plural, steps unless said otherwise.
     */
    private _countLabel(count: number, words = [_('step'), _('steps')]): string {
        if (count === 0) {
            return _('empty');
        }
        return `${count} ${count === 1 ? words[0] : words[1]}`;
    }

    /**
     * The switch a click, key or pad step gets when it sits under a "When …":
     * take the edge from the event, or decide for yourself. On is the absent
     * action — the step goes down when the person pressed and up when they let
     * go. Off puts it back on its own feet with a plain click, which is what
     * the whole-click mode used to be, and the action dropdown comes back out
     * beside it. It shows the event's own icon: what this is bound to.
     *
     * Nothing is hidden by this. The old rule was to strip the action from any
     * step under an event, since the editor showed no way to see or change it;
     * the toggle is that way, so the setting can stay.
     */
    private _followToggle(
        step: ClickStep | KeyStep,
        event: OnEventStep,
    ): Gtk.Widget {
        const toggle = toggleButton(STEP_ICONS.onevent,
            `${_('Follow')} “${this._describe(event)}” — ` +
            _('down when it is pressed, up when it is released. ' +
              'Off: this step decides for itself.'),
            step.action === undefined);
        toggle.connect('toggled', () => {
            // 'tap' rather than nothing when it stops following: a step with no
            // action *is* a follower, so there would be nothing to turn off.
            step.action = toggle.get_active() ? undefined : 'tap';
            this._saveAndRebuild();
        });
        return toggle;
    }

    /**
     * The words a click and a key press both say: the follow toggle, when
     * there is an event above to follow, and otherwise what to do with the
     * button and how long to hold it. A step that is following says neither —
     * the choice was made one row up, and a half-press has no duration. Only
     * the wording differs between the two kinds, so that is all `words`
     * carries.
     */
    private _pressControls(
        step: ClickStep | KeyStep,
        follows: OnEventStep | null,
        words: { actions: Record<string, string>; action: string; hold: string },
    ): Gtk.Widget[] {
        const widgets: Gtk.Widget[] = [];
        if (follows) {
            widgets.push(this._followToggle(step, follows));
            if (step.action === undefined) {
                return widgets;
            }
        }
        widgets.push(chooser(PRESS_ACTIONS, words.actions, step.action ?? 'tap',
            words.action, value => {
                step.action = value;
                this._saveAndRebuild();   // the hold field comes and goes with tap
            }));
        if ((step.action ?? 'tap') === 'tap') {
            // Greyed, like the clock after it: this one is how long it is
            // held down, that one how long to wait once it is let go.
            const held = this._joiner('↓');
            held.set_tooltip_text(words.hold);
            widgets.push(held);
            widgets.push(numberEntry(step.holdMs ?? 20, 0, 10000, words.hold, value => {
                step.holdMs = value;
                this._save();
            }, true));
        }
        return widgets;
    }

    /** A dimmed word between controls: "±" between a wait and its jitter. */
    private _joiner(text: string): Gtk.Label {
        return new Gtk.Label({ label: text, valign: Gtk.Align.CENTER, css_classes: ['dim-label'] });
    }

    /**
     * Take folding away from libadwaita's own arrow: the arrow on the right of
     * an expander goes, and so does folding by clicking the header, which on
     * these rows is how they are selected. A Repeat or an If folds from the
     * arrow on its left instead — see `_foldArrow` — and the rest are blocks
     * that stay open: a When with the steps after it, the Yes and No of an If.
     * libadwaita builds the header and its arrow privately, so they are found
     * by looking; if it ever builds them differently, the row simply keeps
     * its own arrow as well.
     */
    private _ownFold(row: Adw.ExpanderRow): void {
        this._headerOf(row)?.set_activatable(false);
        firstDescendant(row, child => child.has_css_class('expander-row-arrow'))?.set_visible(false);
    }

    /** The arrow that folds a Repeat or an If, pointing the way the row is. */
    private _foldArrow(row: Adw.ExpanderRow): Gtk.Button {
        const button = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'macroclickwerk-fold'],
            tooltip_text: _('Fold or unfold'),
        });
        const sync = () => button.set_icon_name(row.get_expanded() ? 'pan-down-symbolic' : 'pan-end-symbolic');
        button.connect('clicked', () => row.set_expanded(!row.get_expanded()));
        row.connect('notify::expanded', sync);
        sync();
        return button;
    }

    /**
     * An expander's own line — libadwaita builds it as a row of its own, and
     * keeps it to itself. The first one found is the expander's: the rows it
     * holds come after it.
     */
    private _headerOf(row: Adw.ExpanderRow): Adw.ActionRow | null {
        return firstDescendant(row, (child): child is Adw.ActionRow =>
            child instanceof Adw.ActionRow && child.has_css_class('header'));
    }

    /**
     * The rows of one list of steps. A "When …" takes the steps after it, up to
     * the next one, as its block — they are what runs once the event comes, so
     * they are drawn inside it the way a body is drawn inside its repeat. The
     * document has no such nesting: they stay where they are in the list, and
     * only the drawing groups them. Steps above a When in a repeat run under it
     * too, on the next time round, but they are above it, and drawn as such.
     */
    private _buildStepList(
        macro: Macro,
        steps: Step[],
        under: Map<string, OnEventStep>,
        indent: number,
    ): Gtk.Widget[] {
        const widgets: Gtk.Widget[] = [];
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            let block: Step[] = [];
            if (step.kind === 'onevent') {
                let end = i + 1;
                while (end < steps.length && steps[end].kind !== 'onevent') {
                    end++;
                }
                block = steps.slice(i + 1, end);
                i = end - 1;
            }
            widgets.push(...this._buildStepWidgets(macro, step, under, indent, block));
        }
        return widgets;
    }

    /**
     * One step, followed by its Yes/No blocks as sibling rows rather than rows
     * inside it — folding an `if` shut to get at its condition must not take
     * its branches off the screen with it.
     *
     * Every step is one line, laid out the same way: grip, icon and title on
     * the left; on the right what the step does, then the bin, then the
     * chevron. A step that does not fold still keeps the chevron's slot, so
     * the bin makes one straight column down the page. There is no ▶ per
     * step: click a row and the macro's own ▶ starts there, and running one
     * step alone is in the right-click menu.
     * Only a repeat and an if fold: a repeat over its body, an if over its
     * condition and its branches. Nothing else has anything to hide.
     *
     * `indent` is how far in this row sits within whatever contains it. The rail
     * belongs to the enclosing body, not to the step, so a step draws none of
     * its own — the indent alone puts it under the right one.
     */
    private _buildStepWidgets(
        macro: Macro,
        step: Step,
        under: Map<string, OnEventStep>,
        indent: number,
        /** For a When, the steps drawn inside it — see `_buildStepList`. */
        block: Step[],
    ): Gtk.Widget[] {
        const stepKey = `step:${step.id}`;
        const children = childLists(step);
        // A loop has one body and nothing to choose between, so it holds that
        // body itself instead of putting a "Body" header under it. An `if`
        // keeps its Yes and No headers — there the header is the only thing
        // saying which of the two you are reading.
        const inline = step.kind === 'loop';
        const props = { title: this._rowTitle(step), title_lines: 1 };
        // A When with steps after it holds them, in an expander that is always
        // open: it is a block, not a fold. Everything else is a plain row.
        const holds = block.length > 0;
        const expander = step.kind === 'loop' || step.kind === 'if'
            ? this._expander(stepKey, props, true)
            : holds ? new Adw.ExpanderRow(props) : null;
        const row: Adw.ActionRow | Adw.ExpanderRow = expander ?? new Adw.ActionRow(props);
        if (holds && expander) {
            expander.set_expanded(true);
            expander.add_css_class('macroclickwerk-event');
        }
        const widgets: Gtk.Widget[] = [row];
        const branchRows: Adw.ExpanderRow[] = [];

        row.set_margin_start(indent);

        const kindIcon = STEP_ICONS[step.kind];
        const icon = new Gtk.Image({ icon_name: kindIcon, valign: Gtk.Align.CENTER });

        // Affixes go in boxes of our own rather than one add_prefix/add_suffix
        // call each: AdwActionRow and AdwExpanderRow pack them in opposite
        // directions, so the same code produced mirrored rows depending on
        // whether the step folds.
        const prefixes = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER });
        const suffixes = new Gtk.Box({
            spacing: 2,
            valign: Gtk.Align.CENTER,
            css_classes: ['macroclickwerk-line'],
        });
        prefixes.append(this._grip(macro, step, row));
        // The fold arrow on the left, before the icon, the way a tree shows
        // one. A row that does not fold keeps the room empty, or its icon and
        // title would sit further left than a Repeat's beside it and read as
        // a level of nesting that is not there.
        prefixes.append(expander && !holds ? this._foldArrow(expander) : new Gtk.Box({ width_request: FOLD_ARROW_PX }));
        prefixes.append(icon);
        row.add_prefix(prefixes);
        row.add_suffix(suffixes);
        if (expander) {
            this._ownFold(expander);
        }

        // Dropping on a step: the top half means before it, the bottom half
        // after it — or, for a loop holding its own body, into that body,
        // since its steps render directly beneath this row anyway.
        this._droppable(row, macro,
            fraction => {
                if (inline) {
                    return fraction < 0.5 ? 'before' : 'into';
                }
                return fraction < 0.5 ? 'before' : 'after';
            },
            where => {
                if (where === 'into') {
                    return children.length > 0 ? { list: children[0].steps, at: 0 } : null;
                }
                const loc = findStep(macro.body, step.id);
                return loc
                    ? { list: loc.list, at: loc.index + (where === 'after' ? 1 : 0) }
                    : null;
            },
            inline ? expander ?? undefined : undefined);
        this._stepRows.set(step.id, {
            row,
            icon,
            kindIcon,
            container: children.length > 0 || holds,
            branchRows,
        });

        // The "When …" this step runs under, if any: what a press step can
        // take its edge from — see `_pressControls`.
        const follows = under.get(step.id) ?? null;

        for (const widget of this._stepControls(macro, step, follows)) {
            suffixes.append(widget);
        }

        if (THEN_WAIT_KINDS.includes(step.kind)) {
            const acting = step as Step & { afterMs?: number };
            // The Wait step's own clock, greyed: wait, after this one.
            suffixes.append(new Gtk.Image({
                icon_name: STEP_ICONS.wait,
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
                tooltip_text: _('Then wait this long before the next step'),
            }));
            suffixes.append(numberEntry(acting.afterMs ?? 0, 0, 600000,
                _('Then wait this long before the next step, so the game has registered it. 0: go straight on'),
                value => {
                    acting.afterMs = value > 0 ? value : undefined;
                    this._save();
                }, true));
        }
        suffixes.append(iconButton('user-trash-symbolic', _('Delete'), () => {
            removeStep(macro.body, step.id);
            this._saveAndRebuild();
        }));

        this._selectable(row, `after:${step.id}`, macro.id);

        // Right-click anywhere on the row. On the row rather than on a button
        // of its own: a step's line is already full, and this is the gesture
        // people try on a list without being told to.
        const secondary = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY });
        secondary.connect('pressed', (_gesture, _presses, x: number, y: number) => {
            this._stepMenu(macro, step, row, x, y);
        });
        row.add_controller(secondary);

        if (holds) {
            for (const widget of this._buildStepList(macro, block, under, INDENT_PX)) {
                expander?.add_row(widget);
            }
        }

        // An answer from Check now goes on the branch it would take: model
        // says yes, the Yes line; no, the No line. Filled as the headers are
        // built below, read when an answer comes back.
        const branchHeaders = new Map<string, { row: Adw.ExpanderRow; title: string }>();
        const showAnswer = (answer: CheckAnswer) => {
            for (const { row, title } of branchHeaders.values()) {
                row.set_title(title);
                this._headerOf(row)?.remove_css_class('success');
            }
            const header = answer && branchHeaders.get(answer.match ? 'then' : 'else');
            if (answer && header) {
                const said = `${_('model says')} ${answer.match ? _('yes') : _('no')} · ${answer.reason} · ${answer.seconds}`;
                header.row.set_title(`${header.title}  — ${GLib.markup_escape_text(said, -1)}`);
                this._headerOf(header.row)?.add_css_class('success');
            }
        };

        if (step.kind === 'if') {
            for (const child of this._buildConditionSection(_('Condition'), step.cond, next => {
                step.cond = next;
                this._saveAndRebuild();
            }, 0, undefined, step.cond.type === 'llm' ? showAnswer : undefined)) {
                expander?.add_row(child);
            }
        }

        // Nested bodies. Each is its own block: coloured rail, own icon, and the
        // steps inside it indented one step further under that rail. A loop's
        // body is the step's own row (see `inline`); everything below is written
        // against whichever row is holding the steps.
        for (const list of children) {
            const branch = list.key === 'then' || list.key === 'else' ? list.key : null;
            let nested: Adw.ExpanderRow;
            if (inline && expander) {
                nested = expander;
            } else {
                const style = branchStyles()[branch ?? 'then'];
                const title = this._titleWith(style.title, this._countLabel(list.steps.length));
                nested = new Adw.ExpanderRow({ title, tooltip_text: style.hint });
                branchHeaders.set(list.key, { row: nested, title });
                nested.set_expanded(true);
                this._ownFold(nested);
                nested.set_margin_start(indent + INDENT_PX);
                nested.add_prefix(new Gtk.Image({
                    icon_name: style.icon,
                    valign: Gtk.Align.CENTER,
                }));
                branchRows.push(nested);
                widgets.push(nested);
                // The step row is already selectable as "after this step"; a
                // block of its own gets a selection of its own.
                this._selectable(nested, `in:${step.id}:${list.key}`, macro.id);
                // A branch header is a place: dropping on it puts the step
                // first in that branch.
                this._droppable(nested, macro,
                    () => 'into',
                    () => ({ list: list.steps, at: 0 }));
            }
            nested.add_css_class('macroclickwerk-branch');
            if (branch) {
                nested.add_css_class(`macroclickwerk-branch-${branch}`);
            }

            const addNested = this._addStepRow(list.steps, macro.id, step.id, list.key);
            addNested.set_margin_start(INDENT_PX);   // lines up with the steps below it
            // The add row sits at the end of the list, so a drop on it goes
            // there — the counterpart to the branch header meaning "first".
            this._droppable(addNested, macro,
                () => 'into',
                () => ({ list: list.steps, at: list.steps.length }));
            if (inline) {
                this._selectable(addNested, `in:${step.id}:${list.key}`, macro.id);
            }

            for (const widget of this._buildStepList(macro, list.steps, under, INDENT_PX)) {
                nested.add_row(widget);
            }
            // Last, because that is where what it adds ends up.
            nested.add_row(addNested);
        }

        // An if's blocks sit beside its row, not inside it (that is how the
        // rails line up), so its chevron would fold only the condition editor
        // and leave both blocks standing. Have them follow it by hand.
        if (branchRows.length > 0 && expander) {
            const follow = () => {
                for (const branch of branchRows) {
                    branch.set_visible(expander.get_expanded());
                }
            };
            expander.connect('notify::expanded', follow);
            follow();
        }

        return widgets;
    }

    /**
     * Whether a Wait or a Repeat lets the other macros have their turn — the
     * lock the macro's own line has, saying the same thing: open lets them in,
     * the default; closed keeps them out, through the wait or between rounds.
     * Greyed out in a macro that runs side by side, which has no turn to keep.
     */
    private _turnToggle(macro: Macro, step: WaitStep | LoopStep): Gtk.ToggleButton {
        const button = new Gtk.ToggleButton({
            active: step.keepTurn === true,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'image-button'],
            sensitive: macroExclusive(macro),
        });
        const wait = step.kind === 'wait';
        const show = () => {
            const keep = button.get_active();
            button.set_icon_name(keep ? 'changes-prevent-symbolic' : 'changes-allow-symbolic');
            button.set_tooltip_text(!macroExclusive(macro)
                ? _('This macro runs side by side, so it has no turn to give up or keep')
                : keep
                    ? (wait ? _('Keeps the turn: no other macro acts during this wait')
                        : _('Keeps the turn: goes round without letting other macros act between rounds'))
                    : (wait ? _('Lets the others go: other macros may act during this wait')
                        : _('Lets the others go: other macros may act after every round')));
        };
        show();
        button.connect('toggled', () => {
            if (button.get_active()) {
                step.keepTurn = true;
            } else {
                delete step.keepTurn;
            }
            show();
            this._save();
        });
        return button;
    }

    /**
     * What a step does, as controls for its own line, in the order the line
     * reads: what is acted on, how, for how long, and where. Controls that
     * only some choices need come after the dropdown that makes the choice.
     * The one toggle that hides a field — a repeat's ∞ — sits right of it, so
     * the toggle stays put under the pointer that pressed it.
     */
    private _stepControls(macro: Macro, step: Step, follows: OnEventStep | null): Gtk.Widget[] {
        const save = () => this._save();
        switch (step.kind) {
        case 'loop': {
            // The count stays what it was while the toggle hides it, so
            // turning the limit back on brings back the number it had.
            let count = typeof step.count === 'number' ? step.count : 10;
            const spin = numberEntry(count, 1, 1000000, _('How many times to go round'), value => {
                count = value;
                if (step.count !== 'forever') {
                    step.count = value;
                    save();
                }
            });
            spin.set_visible(step.count !== 'forever');
            // Not the loop's own kind icon, which already sits on this row:
            // repeat-song is the "keep going" variant of the same family.
            const forever = toggleButton('media-playlist-repeat-song-symbolic',
                _('Repeat without a limit'), step.count === 'forever');
            forever.connect('toggled', () => {
                step.count = forever.get_active() ? 'forever' : count;
                spin.set_visible(!forever.get_active());
                save();
            });
            return [spin, forever, this._turnToggle(macro, step)];
        }

        case 'click':
            return [
                chooser(MOUSE_BUTTONS, mouseButtonLabels(), step.button,
                    _('Which mouse button'), value => {
                        step.button = value;
                        save();
                    }, 7),
                ...this._pressControls(step, follows, {
                    actions: clickActionLabels(),
                    action: _('A whole click, or one half of one: press it and leave it down, or release what is down'),
                    hold: _('How long the button stays down'),
                }),
                ...this._positionControls({
                    step,
                    places: [
                        { mode: 'abs', label: _('x,y'), numbers: 'spot' },
                        { mode: 'current', label: _('current') },
                    ],
                }),
            ];

        case 'move':
            return this._positionControls({
                step,
                places: [
                    { mode: 'abs', label: _('x,y'), numbers: 'spot' },
                    { mode: 'rel', label: _('offset'), numbers: 'offset' },
                ],
            });

        case 'key':
            return [
                // One field for the whole combo, in the order the fingers go
                // down: modifiers first, the key last. Shown without the KEY_
                // every name starts with, which is put back on the way in.
                suffixEntry(
                    [...(step.mods ?? []), step.code].map(name => name.replace(/^KEY_/, '')).join(' '),
                    'LEFTCTRL C',
                    _('Keys by evdev name, modifiers first: LEFTCTRL C. The KEY_ in front is optional'),
                    text => {
                        const names = text.split(/[\s,+]+/).filter(Boolean).map(evdevKeyName);
                        // An empty field is a field being retyped, not a step
                        // asking to lose its key: leave the last good combo in
                        // place until something replaces it.
                        if (names.length > 0) {
                            step.code = names[names.length - 1];
                            step.mods = names.slice(0, -1);
                        }
                        save();
                    }, { width: 8, max: 14, settle: true }),
                ...this._pressControls(step, follows, {
                    actions: keyActionLabels(),
                    action: _('A whole keystroke, or one half of one: press it and leave it down, or release what is down'),
                    hold: _('How long the key stays down'),
                }),
            ];

        case 'text':
            return [
                suffixEntry(step.value, _('Text to type'), _('The text to type'), text => {
                    step.value = text;
                    save();
                }, { width: 10, max: 24, settle: true }),
                numberEntry(step.delayMs ?? 12, 0, 1000,
                    _('Delay between keys, in milliseconds'), value => {
                        step.delayMs = value;
                        save();
                    }, true),
            ];

        case 'wait':
            return [
                numberEntry(step.ms, 0, 3600000,
                    _('How long to wait, in milliseconds'), value => {
                        step.ms = value;
                        save();
                    }, true),
                this._joiner('±'),
                numberEntry(step.jitterMs ?? 0, 0, 600000,
                    _('Vary each wait by up to this much, either way, in milliseconds'), value => {
                        step.jitterMs = value;
                        save();
                    }, true),
                this._turnToggle(macro, step),
            ];

        case 'scroll':
            return [
                this._joiner('↔'),
                numberEntry(step.dx, -1000, 1000,
                    _('Horizontal scroll clicks'), value => {
                        step.dx = value;
                        save();
                    }),
                this._joiner('↕'),
                numberEntry(step.dy, -1000, 1000,
                    _('Vertical scroll clicks'), value => {
                        step.dy = value;
                        save();
                    }),
            ];

        case 'onevent': {
            const isButton = (TRIGGER_SOURCES as readonly string[]).includes(step.source);
            const widgets: Gtk.Widget[] = [
                chooser([...TRIGGER_SOURCES, 'custom'], eventSourceLabels(),
                    isButton ? step.source : 'custom',
                    _('Which button or key this step waits for — the event is swallowed'),
                    value => {
                        step.source = value === 'custom' ? '' : value;
                        this._saveAndRebuild();
                    }, 7),
            ];
            if (!isButton) {
                widgets.push(suffixEntry(step.source, 'KEY_F13',
                    _('The key waited for, by evdev name'), text => {
                        step.source = text.trim().toUpperCase();
                        save();
                    }, { width: 7, max: 12, settle: true }));
            }
            // Which edge wakes it. The default takes the next one whichever it
            // is, so the first such step in the flow catches the press and the
            // next one the release — a hold is two of them around whatever
            // should happen in between. Naming one edge instead says it
            // outright, and sleeps through the other.
            widgets.push(chooser(EVENT_EDGES, eventEdgeLabels(), step.edge ?? 'either',
                _('Which edge wakes the run: the press, the release, or ' +
                  'whichever comes next'),
                value => {
                    step.edge = value === 'either' ? undefined : value;
                    // The steps below follow this edge, and their tooltips
                    // say so: redraw rather than save.
                    this._saveAndRebuild();
                }, 7));
            return widgets;
        }

        case 'start':
        case 'stop':
            return this._startStopChoosers(macro, step);

        default:
            return [];
        }
    }

    /**
     * The two choices a start or a stop makes — which macro, and where in it —
     * as controls for the step's own line. Both lists are built fresh each
     * time: the macros as they are now, and the steps of whichever macro is
     * named. Picking a macro rebuilds the page rather than only the title,
     * because the other dropdown is a list of that macro's steps.
     */
    private _startStopChoosers(
        macro: Macro,
        step: Extract<Step, { kind: 'start' | 'stop' }>,
    ): Gtk.Widget[] {
        // Every macro but this one, and "this one" as the first choice — a
        // start pointing here is a restart, a stop pointing here ends the run,
        // and both are worth having without picking a name.
        const others = this._store.macros.filter(other => other.id !== macro.id);
        const options = ['', ...others.map(other => other.id)];
        const labels: Record<string, string> = { '': _('This one') };
        for (const other of others) {
            labels[other.id] = this._macroLabel(other);
        }
        // A macro that has since been deleted is said to be missing, in red,
        // until another is picked — not shown as "This one", which a stop
        // would take as stopping itself, and which the shell would not do
        // anyway: it still holds the old name, and refuses it when it runs.
        const missing = Boolean(step.macro) && !others.some(other => other.id === step.macro);
        if (missing) {
            options.push(step.macro!);
            labels[step.macro!] = _('Missing macro');
        }
        const which = chooser(options, labels, step.macro ?? '',
            missing ? _('The macro this named has been deleted — pick another') : _('Which macro'),
            value => {
                step.macro = value;
                // Whatever step was chosen belonged to the previous macro.
                step.at = '';
                this._saveAndRebuild();
            }, 14);
        setClass(which, 'error', missing);
        const widgets: Gtk.Widget[] = [which];

        if (step.kind === 'start') {
            // The steps of whichever macro is being started, indented the way
            // the editor nests them, so the list reads as the macro does.
            const target = step.macro ? others.find(other => other.id === step.macro) : macro;
            const stepIds = [''];
            const stepLabels: Record<string, string> = { '': _('From top') };
            walk(target?.body ?? [], loc => {
                // Not this step itself: starting at it would only run it again,
                // and again.
                if (loc.step.id === step.id) {
                    return;
                }
                stepIds.push(loc.step.id);
                stepLabels[loc.step.id] = `${'    '.repeat(loc.depth)}${this._describe(loc.step)}`;
            });
            // A step that has since been deleted is not a choice any more; the
            // top is the fallback the runner uses anyway.
            if (step.at && !stepIds.includes(step.at)) {
                step.at = '';
            }
            widgets.push(chooser(stepIds, stepLabels, step.at ?? '', _('Where in it to begin'), value => {
                step.at = value;
                this._save();
            }, 12));
        }

        return widgets;
    }

    /**
     * A condition as rows under its `if`: its own settings, then what it
     * contains, indented one level per level of nesting rather than folded —
     * the `if` is what folds, and a fold inside a fold hid the one line you
     * were looking for. `onRemove` puts a bin on the first line, for a member
     * of an "all of" or "any of".
     */
    private _buildConditionSection(
        title: string,
        condition: Condition,
        replace: (next: Condition) => void,
        depth: number,
        onRemove?: () => void,
        /** For the If's own model check: where its answer is shown — see `_buildStepWidgets`. */
        onAnswer?: (answer: CheckAnswer) => void,
    ): Gtk.Widget[] {
        const rows = this._buildConditionRows(condition, depth, onAnswer);
        const trailing: Gtk.Widget[] = [chooser(
            CONDITION_TYPES, conditionTypeLabels(), condition.type,
            _('What this condition checks'),
            type => replace(newCondition(type)),
            8,
        )];
        if (onRemove) {
            trailing.push(iconButton('user-trash-symbolic', _('Remove'), onRemove));
        }

        // The type and the setting that qualifies it are one sentence — ask
        // the LLM, about this prompt — so the chooser joins that setting
        // rather than spending a line above it saying only its own name.
        // Conditions with nothing of their own to show (always, and the ones
        // that only hold others) keep a line for it.
        const headline = rows[0];
        if ((condition.type === 'llm' || condition.type === 'color') &&
            (headline instanceof Adw.ActionRow || headline instanceof Adw.EntryRow)) {
            for (const widget of trailing) {
                headline.add_suffix(widget);
            }
            return rows;
        }

        // A group's line is the one thing that holds its members together, so
        // it says how many there are.
        const group = condition.type === 'and' || condition.type === 'or' ? condition.of : null;
        const row = new Adw.ActionRow({
            title: this._titleWith(title, group
                ? this._countLabel(group.length, [_('condition'), _('conditions')])
                : undefined),
        });
        row.set_margin_start(depth * INDENT_PX);
        for (const widget of trailing) {
            row.add_suffix(widget);
        }
        return [row, ...rows];
    }

    /** Which kind of model the checks go to — see the Setup page. */
    private _llmKind(): 'chat' | 'decision' {
        return this._settings.get_string('llm-kind') === 'decision' ? 'decision' : 'chat';
    }

    /**
     * A line under a check that is hidden until it has something to say:
     * advice about the wording, or what the model answered when asked. One
     * line for both, since an answer is about the wording that was just tried
     * and stops being true as soon as it changes.
     */
    private _hintRow(): { row: Adw.ActionRow; say: (tone: HintTone | null, text: string) => void } {
        const row = new Adw.ActionRow({ visible: false, title_lines: 0, css_classes: ['macroclickwerk-hint'] });
        const icon = new Gtk.Image({ valign: Gtk.Align.CENTER });
        row.add_prefix(icon);
        const icons: Record<HintTone, string> = {
            advice: 'dialog-warning-symbolic',
            yes: 'object-select-symbolic',
            no: 'window-close-symbolic',
            failed: 'dialog-error-symbolic',
        };
        const say = (tone: HintTone | null, text: string) => {
            clearClasses(row, ['warning', 'success', 'error']);
            row.set_visible(tone !== null);
            if (!tone) {
                return;
            }
            icon.set_from_icon_name(icons[tone]);
            row.set_title(text);
            if (tone === 'advice') {
                row.add_css_class('warning');
            } else if (tone === 'yes') {
                row.add_css_class('success');
            } else if (tone === 'failed') {
                row.add_css_class('error');
            }
        };
        return { row, say };
    }

    /**
     * Ask the model the check as it stands — the words in the field, even
     * before they are saved — about the screen right now. The window gets out
     * of the way first, since the screenshot is of whatever it was covering,
     * and comes back with the answer. While it is asking, the button says so.
     *
     * The answer goes where it means something: with `onAnswer`, onto the
     * branch the If would take; otherwise — a question inside an "all of", say,
     * which decides no branch on its own — under the question. Not getting an
     * answer is said under the question either way.
     */
    private _checkNow(
        condition: LlmCondition,
        promptRow: Adw.EntryRow,
        button: Gtk.Button,
        hint: ReturnType<typeof this._hintRow>,
        onAnswer?: (answer: CheckAnswer) => void,
    ): void {
        button.set_sensitive(false);
        button.set_icon_name('content-loading-symbolic');
        this._askShell('check-condition', { condition: { ...condition, prompt: promptRow.get_text() ?? '' } }, {
            minimize: true,
            onResult: answer => {
                button.set_sensitive(true);
                button.set_icon_name('media-playback-start-symbolic');
                if (!answer.ok) {
                    onAnswer?.(null);
                    hint.say('failed', `${_('No answer')} — ${answer.message ?? _('unknown reason')}`);
                    return;
                }
                const said = {
                    match: Boolean(answer.match),
                    reason: answer.reason || _('no reason given'),
                    seconds: `${(Number(answer.latencyMs ?? 0) / 1000).toFixed(1)} s`,
                };
                if (onAnswer) {
                    const advice = promptAdvice(promptRow.get_text() ?? '');
                    hint.say(advice ? 'advice' : null, advice ?? '');
                    onAnswer(said);
                } else {
                    hint.say(said.match ? 'yes' : 'no',
                        `${said.match ? _('Yes') : _('No')} — ${said.reason} · ${said.seconds}`);
                }
            },
        });
    }

    private _buildConditionRows(
        condition: Condition,
        depth: number,
        onAnswer?: (answer: CheckAnswer) => void,
    ): Gtk.Widget[] {
        const rows: Gtk.Widget[] = [];
        const save = () => this._save();
        const rebuild = () => this._saveAndRebuild();
        const indent = (row: Gtk.Widget) => {
            row.set_margin_start(depth * INDENT_PX);
            row.add_css_class('macroclickwerk-line');
            rows.push(row);
        };

        switch (condition.type) {
            case 'always':
            case 'never':
                break;

            case 'llm': {
                const promptRow = entryRow(_('Yes/no question'), condition.prompt, text => {
                    condition.prompt = text;
                    save();
                });
                const hint = this._hintRow();
                const check = iconButton('media-playback-start-symbolic',
                    _('Check now: ask the model about the screen as it is'),
                    () => this._checkNow(condition, promptRow, check, hint, onAnswer));
                // The question, and on the same line where on the screen it is
                // asked about: an area, or nothing for the whole screen.
                const area = this._regionEntry(condition);
                for (const widget of [
                    check,
                    infoButton(_('How to word this, and what is actually sent'),
                        promptHelp(this._llmKind(), this._settings.get_int('llm-decision-threshold')), 64),
                    this._joiner(_('in')),
                    ...this._areaControls(condition, () => condition.region ?? null, next => {
                        condition.region = next;
                    }, [area.entry, ...this._spotButtons({
                        tooltip: _('Drag a rectangle over the screen to select the area'),
                        run: () => this._pickRegionInto(region => {
                            condition.region = region;
                            this._saveAndRebuild();
                        }),
                    }, null), area.show]),
                ]) {
                    promptRow.add_suffix(widget);
                }
                indent(promptRow);
                // Under the question, as it is typed: whether yes or no can
                // answer it at all. An answer from Check now was about the
                // wording that was tried, so a change takes it away again.
                const advise = () => {
                    const advice = promptAdvice(promptRow.get_text() ?? '');
                    hint.say(advice ? 'advice' : null, advice ?? '');
                    onAnswer?.(null);
                };
                promptRow.connect('changed', advise);
                advise();
                indent(hint.row);

                break;
            }

            case 'color': {
                // One line, read as a sentence: this colour, give or take
                // this much, in this area. The colour leads because it is what
                // the check is about; the type chooser joins the end.
                const line = new Adw.ActionRow();
                const colour = suffixEntry(condition.color, '#rrggbb', _('The colour, as #rrggbb'), text => {
                    condition.color = text.trim();
                    save();
                }, { settle: true });
                fitToText(colour, '#000000');
                // Redrawn as the field changes rather than as it commits: the
                // commit is on a delay, and a swatch that lags what you typed
                // by half a second is a swatch you stop trusting.
                const swatch = colorSwatch(() => colour.get_text() ?? '', _('What this colour looks like'));
                colour.connect('changed', () => swatch.queue_draw());
                const area = this._numbersEntry([condition.x, condition.y, condition.w, condition.h],
                    ([x, y, w, h]) => {
                        this._setColorArea(condition, { x, y, w, h });
                        rebuild();
                    }, 'x, y, w, h');
                area.set_tooltip_text(_('The area, as x, y, width, height — a 1×1 area is a single pixel'));
                for (const widget of [
                    colour,
                    swatch,
                    this._joiner('±'),
                    numberEntry(condition.tolerance, 0, 442,
                        _('Tolerance: how far off this colour the area may be and still count'), value => {
                            condition.tolerance = value;
                            save();
                        }),
                    iconButton('color-select-symbolic',
                        _('Fill the colour in from the screen as it is now — over an area, its average'),
                        () => this._readColorFor(condition)),
                    this._joiner(_('in')),
                    ...this._areaControls(condition,
                        () => ({ x: condition.x, y: condition.y, w: condition.w, h: condition.h }),
                        next => this._setColorArea(condition, next),
                        [area, ...this._spotButtons({
                            tooltip: _('Click a pixel on the screen, or drag over an area: where it is and what colour it is both land here'),
                            run: () => this._pickColorFor(condition),
                        }, () => {
                            const [x, y, w, h] = parseNumbers(area.get_text() ?? '', 4)
                                ?? [condition.x, condition.y, condition.w, condition.h];
                            this._showMarker(x, y, Math.max(1, w), Math.max(1, h));
                        })]),
                ]) {
                    line.add_suffix(widget);
                }
                indent(line);
                break;
            }

            case 'not':
                rows.push(...this._buildConditionSection(_('Not this'), condition.of, next => {
                    condition.of = next;
                    rebuild();
                }, depth + 1));
                break;

            case 'and':
            case 'or': {
                // Members first, then the line that adds one — the order the
                // steps of a body keep, for the same reason: it adds below.
                condition.of.forEach((child, index) => {
                    rows.push(...this._buildConditionSection(`${index + 1}.`, child, next => {
                        condition.of[index] = next;
                        rebuild();
                    }, depth + 1, () => {
                        condition.of.splice(index, 1);
                        rebuild();
                    }));
                });

                const addRow = new Adw.ActionRow({ css_classes: ['macroclickwerk-add'] });
                addRow.add_prefix(this._menuButton(_('Add condition'), GROUPABLE_TYPES.map(type => ({
                    label: conditionTypeLabels()[type],
                    run: () => {
                        condition.of.push(newCondition(type));
                        rebuild();
                    },
                })), 'list-add-symbolic'));
                // Under the members, at their depth: it adds one of them.
                addRow.set_margin_start((depth + 1) * INDENT_PX);
                rows.push(addRow);
                break;
            }
        }

        return rows;
    }

    // --- import / export ---------------------------------------------------

    /**
     * Export and Import over both files. Each is a menu rather than a button
     * because there are two things to move — the steps, and the machine they
     * run on — and four buttons in a row is a row nobody reads.
     */
    private _transferButtons(): Gtk.MenuButton[] {
        const export_ = this._menuButton(_('Export'), [
            { label: _('Macros'), run: () => this._exportDocument() },
            { label: _('Settings'), run: () => this._exportSettings() },
        ]);
        export_.set_tooltip_text(_('Macros are the steps; settings are everything else'));
        const import_ = this._menuButton(_('Import'), [
            { label: _('Macros'), run: () => this._importDocument() },
            { label: _('Settings'), run: () => this._importSettings() },
        ]);
        import_.set_tooltip_text(_('Macros are the steps; settings are everything else'));
        return [export_, import_];
    }

    /**
     * A button that opens a list of things to do, each done as it is picked.
     * The popover goes down before the choice runs, so the choice is free to
     * open a file dialog, or rebuild the page from under the button. `icon`
     * makes it a flat one with an icon before the label, the way an add row
     * draws it.
     */
    private _menuButton(
        label: string,
        choices: Choice[],
        icon?: string,
    ): Gtk.MenuButton {
        const popover = this._choicePopover(choices);
        if (!icon) {
            return new Gtk.MenuButton({ label, popover, valign: Gtk.Align.CENTER });
        }
        const content = new Gtk.Box({ spacing: 6 });
        content.append(new Gtk.Image({ icon_name: icon }));
        content.append(new Gtk.Label({ label }));
        return new Gtk.MenuButton({
            child: content,
            popover,
            always_show_arrow: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
    }

    /**
     * A menu button whose list is built each time it opens, from `choices` as
     * they are then — for menus whose entries depend on what has been loaded,
     * moved or edited since the page was drawn.
     */
    private _livePopupButton(button: Gtk.MenuButton, choices: () => Choice[]): Gtk.MenuButton {
        button.set_create_popup_func(() => button.set_popover(this._choicePopover(choices())));
        return button;
    }

    /**
     * Collections: load one, and for each loaded, a switch — off takes its
     * macros out of the editor and out of running, without forgetting them —
     * then save it, or save it under another file. A dot marks unsaved changes.
     */
    private _collectionChoices(): Choice[] {
        const doc = this._store.document;
        const choices: Choice[] = [{
            label: _('New collection…'),
            tooltip: _('A new file, with a new macro in it to start from'),
            run: () => this._chooseFile('save', `${_('Collection')}.json`, path => this._newCollection(path),
                _('New collection')),
        }, {
            label: _('Load collection…'),
            tooltip: _('Add the macros of a file — a collection, or an export of macros'),
            run: () => this._chooseFile('open', 'macros.json', path => this._loadCollection(path),
                _('Load collection')),
        }];
        for (const path of collectionPaths(doc)) {
            const name = collectionName(path);
            const on = collectionOn(doc, path);
            choices.push({
                label: name,
                tooltip: on ? _('On — its macros are here and run') : _('Off — its macros are put away, and do not run'),
                on,
                run: () => {
                    setCollectionOn(doc, path, !on);
                    this._saveAndRebuild();
                },
            }, {
                label: `${_('Save')} “${name}”${collectionUnsaved(doc, path) ? ' •' : ''}`,
                tooltip: path,
                run: () => this._saveCollection(path),
            }, {
                label: `${_('Save')} “${name}” ${_('as…')}`,
                run: () => this._chooseFile('save', `${name}.json`, to => this._saveCollectionAs(path, to),
                    `${_('Save')} “${name}” ${_('as')}`),
            });
        }
        return choices;
    }

    /** A macro's name in a list of them, saying so when its collection is off. */
    private _macroLabel(macro: Macro): string {
        return macroLive(this._store.document, macro) ? macro.name : `${macro.name} (${_('off')})`;
    }

    private _macroFolded(macro: Macro): boolean {
        return this._collapsed.has(`macro:${macro.id}`);
    }

    /** What a macro's ⋯ offers: its collection. */
    private _macroChoices(macro: Macro): Choice[] {
        const doc = this._store.document;
        const choices: Choice[] = [];
        const act = (change: () => void) => () => {
            change();
            this._saveAndRebuild();
        };
        for (const path of collectionPaths(doc)) {
            const name = collectionName(path);
            // Into one switched off is out of sight, so it says so.
            const off = collectionOn(doc, path) ? '' : ` (${_('off')})`;
            if (path !== macro.collection) {
                choices.push({ label: `${_('Move to')} “${name}”${off}`, run: act(() => { macro.collection = path; }) });
            }
            choices.push({ label: `${_('Copy to')} “${name}”${off}`, run: act(() => copyMacro(doc, macro.id, path)) });
        }
        if (macro.collection) {
            choices.push({
                label: `${_('Move out of')} “${collectionName(macro.collection)}”`,
                run: act(() => { macro.collection = undefined; }),
            });
        }
        const intoNew = (copy: boolean) => () => this._chooseFile('save', `${_('Collection')}.json`, path => {
            forgetEmptyCollections(doc);
            const collections = doc.collections;
            const from = macro.collection;
            const added = copy ? copyMacro(doc, macro.id, path) : null;
            macro.collection = copy ? from : path;
            // Nothing changes unless the file is written: a collection that
            // never reached its file would only be lost on the next save.
            if (!this._saveCollection(path)) {
                doc.collections = collections;
                doc.macros = doc.macros.filter(other => other !== added);
                macro.collection = from;
            }
        }, copy ? _('Copy to a new collection') : _('Move to a new collection'));
        choices.push(
            { label: _('Move to a new collection…'), run: intoNew(false) },
            { label: _('Copy to a new collection…'), run: intoNew(true) },
        );
        return choices;
    }

    /**
     * A collection is its macros, so a new one starts with one: empty, and
     * ready to record into. Written straight away, so it is a file from the
     * start; if it cannot be, nothing changes.
     */
    private _newCollection(path: string): void {
        const doc = this._store.document;
        if (collectionPaths(doc).includes(path)) {
            this._toast(`“${collectionName(path)}” ${_('is already a collection here — pick another file')}`);
            return;
        }
        forgetEmptyCollections(doc);
        const macro = newMacro(`Macro ${doc.macros.length + 1}`);
        macro.collection = path;
        doc.macros.push(macro);
        if (!this._saveCollection(path)) {
            doc.macros = doc.macros.filter(other => other !== macro);
        }
    }

    private _loadCollection(path: string): void {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok) {
                throw new Error(_('could not read the file'));
            }
            const count = loadCollection(this._store.document, path, new TextDecoder().decode(bytes));
            this._saveAndRebuild();
            this._toast(`${_('Loaded')} “${collectionName(path)}”: ${count} ${count === 1 ? _('macro') : _('macros')}`);
        } catch (error) {
            this._toast(`${_('Could not load')} “${collectionName(path)}”: ${(error as Error).message}`);
        }
    }

    /** Write a collection to its file as it is now. True when it was written. */
    private _saveCollection(path: string): boolean {
        const doc = this._store.document;
        try {
            GLib.file_set_contents(path, `${collectionText(doc, path)}\n`);
            markCollectionSaved(doc, path);
            this._saveAndRebuild();
            this._toast(`${_('Saved')} “${collectionName(path)}”`);
            return true;
        } catch (error) {
            this._toast(`${_('Could not save')} “${collectionName(path)}”: ${(error as Error).message}`);
            return false;
        }
    }

    /** Save as: the collection is written to `to`, and lives there from now on. */
    private _saveCollectionAs(from: string, to: string): void {
        const doc = this._store.document;
        if (to !== from && collectionPaths(doc).includes(to)) {
            this._toast(`“${collectionName(to)}” ${_('is already a collection here — pick another file')}`);
            return;
        }
        renameCollection(doc, from, to);
        if (!this._saveCollection(to)) {
            renameCollection(doc, to, from);   // nothing was written there; stay where it was
            this._save();
        }
    }

    /**
     * A popover listing things to do, each a flat button. The popover goes down
     * before the choice runs: a choice may open a file dialog, minimise the
     * window or rebuild the page, and a popover left up over any of those comes
     * back with the window, or hangs over the dialog.
     */
    private _choicePopover(choices: Choice[]): Gtk.Popover {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const popover = new Gtk.Popover({ child: box });
        for (const choice of choices) {
            const button = new Gtk.Button({ label: choice.label, css_classes: ['flat'] });
            if (choice.on !== undefined) {
                const line = new Gtk.Box({ spacing: 12 });
                line.append(new Gtk.Label({ label: choice.label, hexpand: true, xalign: 0 }));
                line.append(new Gtk.Switch({ active: choice.on, can_target: false, can_focus: false }));
                button.set_child(line);
            }
            // Set apart: GJS refuses `undefined` for a property in a constructor.
            if (choice.tooltip) {
                button.set_tooltip_text(choice.tooltip);
            }
            button.connect('clicked', () => {
                popover.popdown();
                choice.run();
            });
            box.append(button);
        }
        return popover;
    }

    /**
     * Ask for a file, and hand its path back. The window is the parent, so the
     * dialog is modal to the editor rather than to the whole session; cancelling
     * throws out of `*_finish`, which is not a failure and says nothing.
     */
    private _chooseFile(
        mode: 'open' | 'save',
        suggestedName: string,
        onChosen: (path: string) => void,
        title = mode === 'save' ? _('Export to…') : _('Import from…'),
    ): void {
        const json = new Gtk.FileFilter({ name: _('JSON files') });
        json.add_suffix('json');
        const any = new Gtk.FileFilter({ name: _('All files') });
        any.add_pattern('*');
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
        filters.append(json);
        filters.append(any);

        const dialog = new Gtk.FileDialog({
            title,
            modal: true,
            filters,
            default_filter: json,
            initial_folder: Gio.File.new_for_path(GLib.get_home_dir()),
        });
        if (mode === 'save') {
            dialog.set_initial_name(suggestedName);
        }

        const done = (result: Gio.AsyncResult) => {
            let file: Gio.File | null = null;
            try {
                file = mode === 'save' ? dialog.save_finish(result) : dialog.open_finish(result);
            } catch {
                return;   // dismissed
            }
            const path = file?.get_path();
            if (path) {
                onChosen(path);
            }
        };
        if (mode === 'save') {
            dialog.save(this._window ?? null, null, (_source, result) => done(result));
        } else {
            dialog.open(this._window ?? null, null, (_source, result) => done(result));
        }
    }

    private _exportDocument(): void {
        this._chooseFile('save', MACROS_FILE, path => {
            const json = stringifyDocument(this._store.document);
            try {
                GLib.file_set_contents(path, JSON.stringify(JSON.parse(json), null, 2));
                this._toast(`Exported ${this._store.macros.length} macros to ${path}`);
            } catch (error) {
                this._toast(`Export failed: ${(error as Error).message}`);
            }
        });
    }

    private _importDocument(): void {
        this._chooseFile('open', MACROS_FILE, path => {
            try {
                const [ok, contents] = GLib.file_get_contents(path);
                if (!ok) {
                    throw new Error('could not read the file');
                }
                const doc = parseDocument(new TextDecoder().decode(contents));
                this._store.replaceDocument(doc.macros.length > 0 ? doc : emptyDocument());
                this._rebuildMacros();
                this._toast(`Imported ${doc.macros.length} macros from ${path}`);
            } catch (error) {
                this._toast(`Import failed: ${(error as Error).message}`);
            }
        });
    }

    /**
     * Everything on the other three pages. Values are written in GVariant text
     * form — `'a string'`, `1280`, `['<Control>r']` — which is one notation that
     * covers every type in the schema and can be checked against it on the way
     * back in, so a hand-edited file cannot put a bad value into dconf.
     */
    private _exportSettings(): void {
        this._chooseFile('save', SETTINGS_FILE, path => {
            const values: Record<string, string> = {};
            for (const key of this._settings.settings_schema.list_keys()) {
                if (isTransferableKey(key)) {
                    values[key] = this._settings.get_value(key).print(false);
                }
            }
            try {
                const file = { type: 'macroclickwerk-settings', version: 1, settings: values };
                GLib.file_set_contents(path, `${JSON.stringify(file, null, 2)}\n`);
                this._toast(`Exported ${Object.keys(values).length} settings to ${path}`);
            } catch (error) {
                this._toast(`Settings export failed: ${(error as Error).message}`);
            }
        });
    }

    private _importSettings(): void {
        this._chooseFile('open', SETTINGS_FILE, path => this._applySettingsFile(path));
    }

    private _applySettingsFile(path: string): void {
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok) {
                throw new Error('could not read the file');
            }
            const parsed = JSON.parse(new TextDecoder().decode(contents)) as {
                settings?: Record<string, string>;
            };
            if (!parsed.settings || typeof parsed.settings !== 'object') {
                throw new Error('no settings in the file');
            }

            const schema = this._settings.settings_schema;
            const skipped: string[] = [];
            let applied = 0;
            for (const [key, text] of Object.entries(parsed.settings)) {
                if (!isTransferableKey(key) || !schema.has_key(key)) {
                    skipped.push(key);   // from another version, or not ours to write
                    continue;
                }
                const schemaKey = schema.get_key(key);
                let value: GLib.Variant;
                try {
                    value = GLib.Variant.parse(schemaKey.get_value_type(), text, null, null);
                } catch {
                    skipped.push(key);
                    continue;
                }
                // Out-of-range values are a hard error inside GSettings, so they
                // are dropped here rather than taking the whole import down.
                if (!schemaKey.range_check(value)) {
                    skipped.push(key);
                    continue;
                }
                this._settings.set_value(key, value);
                applied++;
            }

            this._addSettingsPages();
            const ignored = skipped.length > 0 ? `, ignored ${skipped.join(', ')}` : '';
            this._toast(`Imported ${applied} settings from ${path}${ignored}`);
        } catch (error) {
            this._toast(`Settings import failed: ${(error as Error).message}`);
        }
    }

    /** Build the non-macro pages, replacing them if they are already there. */
    private _addSettingsPages(): void {
        const window = this._window;
        if (!window) {
            return;
        }
        for (const page of this._settingsPages) {
            window.remove(page);
        }
        this._settingsPages = [this._buildSetupPage(), this._buildShortcutsPage()];
        for (const page of this._settingsPages) {
            window.add(page);
        }
    }

    /** Adwaita's own toast where the window has one, the journal either way. */
    private _toast(message: string): void {
        log(`macroclickwerk: ${message}`);
        const window = this._window as unknown as { add_toast?: (toast: object) => void } | undefined;
        if (typeof window?.add_toast === 'function') {
            window.add_toast(new Adw.Toast({ title: message, timeout: 5 }));
        }
    }

    /**
     * Preferences runs in its own process and cannot see or draw on the screen,
     * so anything screen-related is a request to the shell: write a serialled
     * payload to one settings key, wait for the matching answer on another.
     * `minimize` gets the window out of the way for requests you have to look
     * at the screen to satisfy.
     */
    private _askShell(
        name: string,
        payload: object,
        options: {
            minimize?: boolean;
            /** With `minimize`, whether this answer brings the window back; default yes. */
            presentOn?: (answer: Record<string, any>) => boolean;
            onResult?: (answer: Record<string, any>) => void;
        } = {},
    ): void {
        const settings = this._settings;
        const serial = ++this._requestSerial;

        if (options.onResult) {
            const resultKey = `${name}-result`;
            let handlerId = 0;
            handlerId = settings.connect(`changed::${resultKey}`, () => {
                let answer: Record<string, any> | null = null;
                try {
                    answer = JSON.parse(settings.get_string(resultKey));
                } catch {
                    answer = null;
                }
                if (!answer || typeof answer.serial !== 'number' || answer.serial < serial) {
                    return; // unreadable, or an exchange older than ours
                }
                // Ours, or a newer one — done either way. Without the newer
                // case, an exchange the shell never answered would leave this
                // handler parsing every future result on the key forever.
                settings.disconnect(handlerId);
                if (answer.serial > serial) {
                    return; // a newer exchange overtook this one; its handler answers
                }
                if (options.minimize && (options.presentOn?.(answer) ?? true)) {
                    this._window?.present();
                }
                options.onResult!(answer);
            });
        }

        if (options.minimize) {
            this._window?.minimize();
        }
        settings.set_string(`${name}-request`, JSON.stringify({ serial, ...payload }));
    }

    /**
     * Start a whole recording landing at `target` — the row it was asked from,
     * made the selection first so the shell agrees on the spot. The window
     * stays away while the answer is "recording": what is being recorded is
     * the real screen. It comes back on failure, and when this same control
     * stopped a recording that was already going.
     */
    private _recordInto(macroId: string, target: string): void {
        this._selectTarget(macroId, target);
        this._askShell('record', {}, {
            minimize: true,
            presentOn: answer => !(answer.ok && answer.recording),
            onResult: answer => {
                if (!answer.ok) {
                    this._toast(`recording failed: ${answer.message ?? 'unknown reason'}`);
                }
            },
        });
    }

    /** Watch for one click or move and append it as a step. */
    private _captureStepInto(macroId: string, parentStepId: string | null, listKey: string | null): void {
        this._askShell('capture-step', { macroId, parentStepId, listKey }, {
            minimize: true,
            onResult: answer => {
                if (!answer.ok) {
                    this._toast(`capture failed: ${answer.message ?? 'unknown reason'}`);
                }
                // A successful capture lands in `macros`, which rebuilds us anyway.
            },
        });
    }

    /**
     * The menu a step's row opens on a right click.
     *
     * The ▶ at the top of the macro starts from the selected row — click a
     * step, press ▶. The menu says the two things that does not: "Run from
     * here" is that in one go, from a right click that need not move the
     * selection first; "Run this step only" does the one step and stops,
     * for the kinds that are one action each.
     */
    private _stepMenu(macro: Macro, step: Step, row: Gtk.Widget, x: number, y: number): void {
        const choices: Choice[] = [{
            label: _('Run from here'),
            tooltip: _('Start the macro at this step and carry on from it'),
            run: () => this._runFrom(macro, step),
        }];
        if (RUNNABLE_ALONE.includes(step.kind)) {
            choices.push({
                label: _('Run this step only'),
                tooltip: _('Do this one step now, on the real screen'),
                run: () => this._runStepNow(macro.id, step),
            });
        }
        const popover = this._choicePopover(choices);
        popover.set_position(Gtk.PositionType.BOTTOM);
        popover.set_parent(row);
        popover.set_pointing_to(new Gdk.Rectangle({
            x: Math.round(x), y: Math.round(y), width: 1, height: 1,
        }));
        // A popover parented by hand is unparented by hand, and not from inside
        // the signal that is still using it — hence the idle.
        popover.connect('closed', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                popover.unparent();
                return GLib.SOURCE_REMOVE;
            });
        });
        popover.popup();
    }

    /**
     * Start this macro at this step. The mark moves here too: it is what the
     * editor highlights and where a pause would continue from, so leaving it
     * pointing at some other row would make the next press disagree with this
     * one. The step is named in the request as well, so the run does not depend
     * on the mark's write arriving first.
     */
    private _runFrom(macro: Macro, step: Step): void {
        this._selectTarget(macro.id, `after:${step.id}`);
        this._save();
        this._window?.minimize();
        this._askShell('run-macro', { macroId: macro.id, action: 'run', at: step.id }, {
            onResult: answer => {
                if (!answer.ok) {
                    this._window?.present();
                    this._toast(answer.message ?? _('it did not run'));
                }
            },
        });
    }

    /**
     * Do one step on the real screen, right now. The window gets out of the way
     * first for anything aimed at a position, or the click would land on this
     * window instead of on whatever you are pointing it at; a wait has nothing
     * to look at, so it does not bother.
     */
    private _runStepNow(macroId: string, step: Step): void {
        this._save();   // the shell runs what is in the document, not what is on screen
        this._askShell('run-step', { macroId, stepId: step.id }, {
            minimize: step.kind !== 'wait',
            onResult: answer => {
                if (!answer.ok) {
                    this._toast(`${this._describe(step)}: ${answer.message ?? _('it did not run')}`);
                    return;
                }
                // Stepping through a macro: the insertion point moves past what
                // just ran, so anything recorded next goes on from there rather
                // than back where the selection happened to be.
                this._selectTarget(macroId, `after:${step.id}`);
            },
        });
    }

    /**
     * Start or stop one macro from the button beside its name. The window gets
     * out of the way first, the same as for a single step: whatever the macro
     * clicks on, it is not meant to be this window. It comes back only if the
     * shell says no, because a message behind a minimised window is no message.
     */
    private _runMacroNow(macroId: string, action: 'run' | 'pause' | 'stop'): void {
        this._save();   // the shell runs what is in the document, not what is on screen
        if (action === 'run') {
            this._window?.minimize();
        }
        this._askShell('run-macro', { macroId, action }, {
            onResult: answer => {
                if (!answer.ok) {
                    this._window?.present();
                    this._toast(answer.message ?? _('it did not run'));
                }
            },
        });
    }

    /**
     * Get out of the way, let the picker take a click on the real screen, and
     * hand back where it landed. The window comes back either way; a pick that
     * caught nothing says so rather than leaving the field looking picked.
     */
    private _pickPointInto(onPoint: (point: { x: number; y: number }) => void): void {
        this._askShell('pick-point', {}, {
            minimize: true,
            onResult: answer => {
                if (answer.ok && typeof answer.x === 'number' && typeof answer.y === 'number') {
                    onPoint({ x: answer.x, y: answer.y });
                } else {
                    this._toast(`${_('nothing was picked')}: ${answer.message ?? _('it was cancelled')}`);
                }
            },
        });
    }

    /** As `_pickPointInto`, for a rectangle dragged over the screen. */
    private _pickRegionInto(onRegion: (region: Region) => void): void {
        this._askShell('pick-region', {}, {
            minimize: true,
            onResult: answer => {
                if (answer.region) {
                    onRegion(answer.region as Region);
                }
            },
        });
    }

    /**
     * Where a model check looks, as a field: x, y, width, height — or empty,
     * for the whole screen, which is what clearing it means. With **Show**
     * beside it, which has an area to flash only while there is one.
     */
    private _regionEntry(condition: LlmCondition): { entry: Gtk.Entry; show: Gtk.Widget } {
        const region = condition.region;
        const entry = new Gtk.Entry({
            text: region ? `${region.x}, ${region.y}, ${region.w}, ${region.h}` : '',
            placeholder_text: _('whole screen'),
            tooltip_text: _('The area, as x, y, width, height. Empty: the whole screen'),
            valign: Gtk.Align.CENTER,
            xalign: 1,
        });
        fitToText(entry, _('whole screen'));
        const read = (): Region | null | undefined => {
            const text = (entry.get_text() ?? '').trim();
            if (text === '') {
                return null;
            }
            const numbers = parseNumbers(text, 4);
            return numbers ? { x: numbers[0], y: numbers[1], w: numbers[2], h: numbers[3] } : undefined;
        };
        const [show] = this._spotButtons(null, () => {
            const now = read();
            if (now) {
                this._showMarker(now.x, now.y, now.w, now.h);
            }
        });
        const sync = () => show.set_visible(Boolean(read()));
        entry.connect('changed', sync);
        // Committed once typing pauses, and only what reads: half a rectangle
        // is a field being typed, not the whole screen.
        entry.connect('changed', debounce(() => {
            const next = read();
            setClass(entry, 'error', next === undefined);
            if (next !== undefined) {
                condition.region = next;
                this._save();
            }
        }));
        sync();
        return { entry, show };
    }

    /** Move a colour check onto an area, from the field or from the screen. */
    private _setColorArea(condition: ColorCondition, region: Region): void {
        condition.x = region.x;
        condition.y = region.y;
        condition.w = Math.max(1, region.w);
        condition.h = Math.max(1, region.h);
    }

    /**
     * Point at the screen and take a whole colour check off it: a click is the
     * pixel it landed on, a drag is the rectangle, the colour that rectangle is
     * made of, and how much of it that colour covers. Nothing here waits for
     * the daemon — the picker is the shell's own overlay, the same one the
     * model's area comes from.
     */
    private _pickColorFor(condition: ColorCondition): void {
        this._askShell('pick-color', {}, {
            minimize: true,
            onResult: answer => {
                const region = answer.region as Region | undefined;
                if (!answer.ok || !region) {
                    this._toast(`${_('nothing was picked')}: ${answer.message ?? _('it was cancelled')}`);
                    return;
                }
                this._setColorArea(condition, region);
                this._applyMeasuredColor(condition, answer);
                this._saveAndRebuild();
            },
        });
    }

    /** What the area this check already points at looks like right now. */
    private _readColorFor(condition: ColorCondition): void {
        const region: Region = {
            x: condition.x,
            y: condition.y,
            w: Math.max(1, condition.w),
            h: Math.max(1, condition.h),
        };
        this._askShell('pick-color', { region }, {
            minimize: true,
            onResult: answer => {
                if (!answer.ok || typeof answer.color !== 'string') {
                    this._toast(`${_('could not read that colour')}: ${answer.message ?? _('unknown reason')}`);
                    return;
                }
                this._applyMeasuredColor(condition, answer);
                this._saveAndRebuild();
            },
        });
    }

    /** The colour the shell read off that area, into the check. */
    private _applyMeasuredColor(condition: ColorCondition, answer: Record<string, any>): void {
        if (typeof answer.color === 'string') {
            condition.color = answer.color;
        }
    }

    /** Flash an X, or a rectangle, at these coordinates. */
    private _showMarker(x: number, y: number, w?: number, h?: number): void {
        this._askShell('show-marker', { x, y, w, h });
    }

    // --- other pages -------------------------------------------------------

    /**
     * Everything that is set up once and then left alone, on one page: the
     * vision model and its screenshots first, since those are what gets
     * changed, then recording, then the daemon, which is set up at install.
     */
    private _buildSetupPage(): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Setup'),
            iconName: 'preferences-system-symbolic',
        });
        this._addModelGroups(page);
        this._addInputGroups(page);
        return page;
    }

    private _addModelGroups(page: Adw.PreferencesPage): void {
        const group = new Adw.PreferencesGroup({
            title: _('Vision model'),
            description: _('A chat model on any OpenAI-compatible endpoint — llama.cpp-server, LM Studio, vLLM, ' +
                'Ollama on /v1 — or a decision model on its SystemOne endpoint, such as llama.cpp-server’s /v1/systemone.'),
        });

        const endpoint = new Adw.EntryRow({ title: _('Endpoint') });
        endpoint.set_text(this._settings.get_string('llm-endpoint'));
        const commitEndpoint = debounce(() => {
            this._settings.set_string('llm-endpoint', endpoint.get_text() ?? '');
        });
        endpoint.connect('changed', commitEndpoint);

        // Which kind of model the endpoint serves. Both answer the same yes or
        // no; a chat model writes it out, a decision model gives a probability
        // and nothing else, several times faster. The model's name stays a
        // field of its own — the server decides what it is called.
        const threshold = spinRow(_('Yes from (%)'), this._settings.get_int('llm-decision-threshold'),
            50, 99, 5, value => this._settings.set_int('llm-decision-threshold', Math.round(value)));
        threshold.set_subtitle(_('Below this, a check counts as No. Higher: the macro acts only when the model is very sure'));
        const kindHint = (value: string) => value === 'decision'
            ? _('Answers with how likely yes is — fast, nothing generated')
            : _('Answers in words, with a short reason');
        const kind = comboRow(_('Kind'), ['chat', 'decision'] as const, {
            chat: _('Chat'),
            decision: _('Decision'),
        }, this._llmKind(), value => {
            this._settings.set_string('llm-kind', value);
            kind.set_subtitle(kindHint(value));
            threshold.set_visible(value === 'decision');
            // The two are usually one server with two paths. Only the path
            // is changed, and only when it is the other kind's own: anything
            // else in the field is somebody's deliberate choice.
            const url = endpoint.get_text() ?? '';
            const [from, to] = value === 'decision'
                ? ['/chat/completions', '/systemone'] : ['/systemone', '/chat/completions'];
            if (url.endsWith(from)) {
                endpoint.set_text(url.slice(0, -from.length) + to);
            }
        });
        kind.set_subtitle(kindHint(this._llmKind()));
        threshold.set_visible(this._llmKind() === 'decision');
        group.add(kind);
        group.add(endpoint);

        const model = entryRow(_('Model'), this._settings.get_string('llm-model'), text => {
            this._settings.set_string('llm-model', text);
        });
        group.add(model);
        const apiKey = passwordRow(_('API key (usually empty locally)'), this._settings.get_string('llm-api-key'), text => {
            this._settings.set_string('llm-api-key', text);
        });
        group.add(apiKey);
        group.add(spinRow(_('Timeout (ms)'), this._settings.get_int('llm-timeout-ms'), 1000, 300000, 1000, value => {
            this._settings.set_int('llm-timeout-ms', Math.round(value));
        }));
        group.add(threshold);

        const testRow = new Adw.ActionRow({
            title: _('Test the connection'),
            subtitle: _('Sends one small picture'),
        });
        const testButton = new Gtk.Button({ label: _('Test'), valign: Gtk.Align.CENTER });
        testRow.add_suffix(testButton);
        testButton.connect('clicked', () => {
            for (const style of ['error', 'warning', 'success']) {
                testRow.remove_css_class(style);
            }
            testButton.sensitive = false;
            testRow.subtitle = _('Asking the model…');

            // Read straight off the rows, not out of settings: their writes are
            // debounced, and testing what is on screen is what you meant.
            void testConnection({
                endpoint: endpoint.get_text() ?? '',
                model: model.get_text() ?? '',
                apiKey: apiKey.get_text() ?? '',
                timeoutMs: this._settings.get_int('llm-timeout-ms'),
                kind: this._llmKind(),
                threshold: this._settings.get_int('llm-decision-threshold') / 100,
            }).then(result => {
                testButton.sensitive = true;
                if (!result.ok) {
                    testRow.add_css_class('error');
                    testRow.subtitle = result.message;
                } else if (result.sawImage) {
                    testRow.add_css_class('success');
                    testRow.subtitle = `Answered in ${result.latencyMs} ms — “${result.message}”`;
                } else {
                    // Reachable and talking, but blind: almost always a model
                    // name that is not the vision one.
                    testRow.add_css_class('warning');
                    testRow.subtitle = `Answered in ${result.latencyMs} ms, but called a plain red ` +
                        `picture something else — check that “${model.get_text()}” can see images`;
                }
            });
        });
        group.add(testRow);
        page.add(group);

        const imageGroup = new Adw.PreferencesGroup({
            title: _('Screenshots'),
            description: _('Sent as PNG, so text stays sharp. A tight screen area helps more than scaling.'),
        });
        const scale = scaleWidthFor(this._settings.get_int('llm-max-width'));
        if (Number(scale) !== this._settings.get_int('llm-max-width')) {
            this._settings.set_int('llm-max-width', Number(scale));   // so the row is not lying
        }
        imageGroup.add(comboRow(_('Scale down to'), SCALE_WIDTHS, scaleLabels(), scale, value => {
            this._settings.set_int('llm-max-width', Number(value));
        }));
        page.add(imageGroup);
    }

    private _addInputGroups(page: Adw.PreferencesPage): void {
        const recording = new Adw.PreferencesGroup({ title: _('Recording') });
        recording.add(spinRow(
            _('Pauses longer than this become waits (ms, 0 = never)'),
            this._settings.get_int('record-gap-ms'), 0, 60000, 10,
            value => this._settings.set_int('record-gap-ms', Math.round(value)),
        ));
        page.add(recording);

        const daemon = new Adw.PreferencesGroup({
            title: _('Daemon'),
            description: _('Injects and observes events. Start it with: sudo systemctl start macroclickwerk'),
        });
        daemon.add(entryRow(_('Control socket'), this._settings.get_string('control-socket'), text => {
            this._settings.set_string('control-socket', text);
        }));
        daemon.add(entryRow(_('Event socket'), this._settings.get_string('event-socket'), text => {
            this._settings.set_string('event-socket', text);
        }));
        page.add(daemon);
    }

    // --- triggers -----------------------------------------------------------

    /**
     * One list of what a key or button does: the keyboard shortcuts first, then
     * the triggers. Both are "when this is pressed, do that", and both are
     * shown that way. They differ in what is pressed — a shortcut is a key
     * combination that works anywhere and leaves the keys alone otherwise, a
     * trigger takes a whole mouse button or key over through the daemon — so
     * a shortcut's action is fixed and a trigger's is chosen.
     */
    private _buildTriggersGroup(): Adw.PreferencesGroup {
        this._triggersGroup = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('What a key or button does. Keyboard shortcuts work anywhere. ' +
                'With + you add a mouse button or key that is taken over completely — the game never ' +
                'sees it — even when no macro is running.'),
        });
        this._triggersGroup.set_header_suffix(iconButton('list-add-symbolic', _('Add a mouse button or key'), () => {
            const triggers = this._loadTriggers();
            triggers.push({ id: newId(), source: 'BTN_SIDE', action: 'none' });
            this._saveTriggers(triggers, true);
        }));
        for (const [key, does] of keyboardShortcuts()) {
            this._triggersGroup.add(this._shortcutRow(key, does));
        }
        this._fillTriggersGroup();
        return this._triggersGroup;
    }

    /**
     * A keyboard shortcut as a trigger reads: When [keys] → does this. The
     * keys are shown and typed the way people write them — Ctrl+Shift+F6 —
     * and empty removes the shortcut.
     */
    private _shortcutRow(key: string, does: string): Adw.ActionRow {
        const row = new Adw.ActionRow({ title: _('When') });
        row.add_prefix(new Gtk.Image({ icon_name: 'input-keyboard-symbolic', valign: Gtk.Align.CENTER }));
        const line = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER, css_classes: ['macroclickwerk-line'] });
        const keys = suffixEntry(shortcutLabel(this._settings.get_strv(key)[0] ?? ''), 'Ctrl+Shift+F6',
            _('The keys, like Ctrl+Shift+F6. Empty: no shortcut'), text => {
                // Empty is a shortcut removed, not a shortcut typed wrong.
                const accel = text.trim() === '' ? '' : shortcutAccel(text);
                setClass(keys, 'error', accel === null);
                if (accel !== null) {
                    this._settings.set_strv(key, accel === '' ? [] : [accel]);
                }
            }, { width: 10, max: 16, settle: true });
        line.append(keys);
        line.append(this._joiner('→'));
        line.append(new Gtk.Label({ label: does, valign: Gtk.Align.CENTER }));
        row.add_suffix(line);
        return row;
    }

    private _loadTriggers(): Trigger[] {
        return parseTriggers(this._settings.get_string('triggers'));
    }

    /** Writes through to gsettings, where the running extension picks it up live. */
    private _saveTriggers(triggers: Trigger[], rebuild = false): void {
        this._settings.set_string('triggers', JSON.stringify(triggers));
        if (rebuild) {
            this._fillTriggersGroup();
        }
    }

    private _fillTriggersGroup(): void {
        for (const row of this._triggerRows) {
            this._triggersGroup.remove(row);
        }
        this._triggerRows = [];
        const triggers = this._loadTriggers();
        triggers.forEach((_trigger, index) => {
            const row = this._triggerRow(triggers, index);
            this._triggerRows.push(row);
            this._triggersGroup.add(row);
        });
    }

    /**
     * One trigger as one sentence, the way a step reads in the editor: When
     * [this button] → [starts] [that macro]. The controls are the sentence;
     * there is no summary beside them saying the same thing again. A line
     * under it speaks up only when there is something to know — a trigger
     * that does nothing yet, or one that takes over a click everywhere.
     */
    private _triggerRow(triggers: Trigger[], index: number): Adw.ActionRow {
        const trigger = triggers[index];
        const isButton = (TRIGGER_SOURCES as readonly string[]).includes(trigger.source);
        const row = new Adw.ActionRow({ title: _('When'), subtitle: this._triggerCaveat(trigger) });
        row.add_prefix(new Gtk.Image({
            icon_name: isButton ? 'input-mouse-symbolic' : 'input-keyboard-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        const line = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER, css_classes: ['macroclickwerk-line'] });
        row.add_suffix(line);

        // What is taken over: one of the mouse buttons, or any key by name.
        line.append(chooser([...TRIGGER_SOURCES, 'custom'], triggerSourceLabels(), isButton ? trigger.source : 'custom',
            _('Which button or key this trigger takes over'), value => {
                trigger.source = value === 'custom' ? '' : value;
                this._saveTriggers(triggers, true);
            }, 14));
        if (!isButton) {
            line.append(suffixEntry(trigger.source, 'KEY_F13', _('The key taken over, by evdev name'), text => {
                trigger.source = text.trim().toUpperCase();
                this._saveTriggers(triggers);
                row.set_subtitle(this._triggerCaveat(trigger));
            }));
        }

        line.append(this._joiner('→'));
        line.append(chooser(TRIGGER_ACTIONS, triggerActionLabels(), trigger.action,
            _('What a press does instead'), value => {
                trigger.action = value;
                this._saveTriggers(triggers, true);
            }, 14));

        if (MACRO_TRIGGER_ACTIONS.includes(trigger.action)) {
            const macros = this._store.macros;
            const options = ['', ...macros.map(macro => macro.id)];
            const labels: Record<string, string> = { '': _('Everything switched on') };
            for (const macro of macros) {
                labels[macro.id] = this._macroLabel(macro);
            }
            line.append(chooser(options, labels, trigger.macro ?? '', _('Which macro this drives'), value => {
                trigger.macro = value;
                this._saveTriggers(triggers);
            }, 22));
        }

        line.append(iconButton('user-trash-symbolic', _('Remove this trigger'), () => {
            triggers.splice(index, 1);
            this._saveTriggers(triggers, true);
        }));
        return row;
    }

    private _triggerCaveat(trigger: Trigger): string {
        if (!isArmed(trigger)) {
            // The user's rule: an onevent with nothing attached is still a click.
            return _('Does nothing yet — the button works as usual until you pick what it does');
        }
        if (trigger.source === 'BTN_LEFT' || trigger.source === 'BTN_RIGHT') {
            return _('Taken over everywhere, in every app, while Macroclickwerk runs');
        }
        return '';
    }

    private _buildShortcutsPage(): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Shortcuts'),
            iconName: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });
        // Each row is a sentence — what is pressed, what it does, and the
        // macro it names — and at the settings width of 600 its dropdowns were
        // cut down to "A…". Wider, like the editor.
        this._widen(page, SHORTCUTS_MAX_WIDTH);
        page.add(this._buildTriggersGroup());
        return page;
    }
}
