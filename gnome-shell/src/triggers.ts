// Input triggers: a button (or key) the daemon consumes, and what the
// extension does in its place — press another key, or drive a macro.
//
// The split mirrors who can do what. Only the daemon, holding the grab, can
// withhold the original event from the desktop; only the extension knows what
// the trigger means. So the daemon consumes registered codes and hands them
// over on the event stream tagged `trig`, and this engine turns them into
// actions. The daemon consumes only while the stream has a client, so if this
// engine is gone the button reverts to being a button — a trigger downgrades
// to a no-op, never to a click-eating hole.

import GLib from 'gi://GLib';

import { DaemonClient, EventStream, type StreamedEvent } from './daemon.js';
import { BUTTON_CODES, EV_KEY, keyCode } from './keymap.js';
import { reportProblem } from './problems.js';

export interface Trigger {
    id: string;
    /** evdev name of what is consumed: BTN_SIDE, KEY_F13, … */
    source: string;
    /**
     * What a press does. 'none' is a trigger still being set up: nothing is
     * consumed and the source keeps working as itself.
     */
    action: 'none' | 'key' | 'run' | 'pause' | 'stop';
    /**
     * What the source is remapped to, for 'key': one or more evdev names,
     * space separated. All go down on the press, in order, and come back up
     * in reverse on the release — so "KEY_LEFTMETA BTN_LEFT" on a mouse
     * button is a real Super+left-drag while that button is held, which is
     * how a button becomes "drag windows with me".
     */
    key?: string;
    /** Macro for run/pause/stop. '' means every enabled macro. */
    macro?: string;
}

/** The stored JSON, tolerantly: a bad document is no triggers, not a crash. */
export function parseTriggers(json: string): Trigger[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((t): t is Trigger =>
            typeof t === 'object' && t !== null &&
            typeof (t as Trigger).source === 'string' &&
            typeof (t as Trigger).action === 'string');
    } catch {
        return [];
    }
}

/** BTN_SIDE / KEY_E → evdev code; null for a name that is not a real input. */
export function sourceCode(name: string): number | null {
    const upper = name.trim().toUpperCase();
    for (const [button, code] of Object.entries(BUTTON_CODES)) {
        if (upper === `BTN_${button.toUpperCase()}`) {
            return code;
        }
    }
    return keyCode(upper);
}

/** The remap target as codes, in press order; null if any name is not real. */
export function comboCodes(key: string | undefined): number[] | null {
    const names = (key ?? '').trim().split(/\s+/).filter(name => name !== '');
    if (names.length === 0) {
        return null;
    }
    const codes: number[] = [];
    for (const name of names) {
        const code = sourceCode(name);
        if (code === null) {
            return null;
        }
        codes.push(code);
    }
    return codes;
}

/**
 * A trigger only consumes once it can actually do something: it needs a real
 * source, and its action's own parameters. Half-configured rows stay inert —
 * the user asked for exactly this: an onevent with no body still clicks.
 */
export function isArmed(trigger: Trigger): boolean {
    if (trigger.action === 'none' || sourceCode(trigger.source) === null) {
        return false;
    }
    if (trigger.action === 'key') {
        return comboCodes(trigger.key) !== null;
    }
    return true;
}

export interface TriggerActions {
    /**
     * Put keys down or up through the daemon, tracked for emergency release.
     * One call is one ordered event train: a combo's modifier must be down
     * before its key, and two separate requests would not promise that.
     */
    injectKeys(codes: number[], down: boolean): void;
    /** Drive a macro; macroId '' means every enabled macro. */
    control(action: 'run' | 'pause' | 'stop', macroId: string): void;
}

/** The armed triggers, keyed by the evdev code the daemon consumes for them. */
export function armedByCode(triggers: Trigger[]): Map<number, Trigger> {
    const byCode = new Map<number, Trigger>();
    for (const trigger of triggers) {
        if (isArmed(trigger)) {
            byCode.set(sourceCode(trigger.source)!, trigger);
        }
    }
    return byCode;
}

/** One tagged event → one action. Pure, so tests can feed events straight in. */
export function dispatch(
    byCode: Map<number, Trigger>,
    event: StreamedEvent,
    actions: TriggerActions,
): void {
    if (!event.trig || event.type !== EV_KEY) {
        return;
    }
    const trigger = byCode.get(event.code);
    if (!trigger) {
        return;
    }
    if (trigger.action === 'key') {
        // Mirror the press: down on 1, up on 0, and a combo goes down in
        // order and comes up in reverse, like fingers would. Value 2 is the
        // kernel's autorepeat, which a held injected key produces on its own.
        const codes = comboCodes(trigger.key);
        if (codes !== null && (event.value === 0 || event.value === 1)) {
            actions.injectKeys(event.value === 1 ? codes : [...codes].reverse(),
                event.value === 1);
        }
        return;
    }
    // Macro actions fire on the press alone; the release is just the finger
    // coming back up. ('none' never reaches here — an unarmed trigger is not
    // in the map — but the type does not know that.)
    if (event.value === 1 && trigger.action !== 'none') {
        actions.control(trigger.action, trigger.macro ?? '');
    }
}

/**
 * Which edge woke a parked run, or null when the wait was called off. The
 * steps after the event need this, not just the fact of it: a click under a
 * split `onevent` goes down on the press and up on the release, so the answer
 * to "what happened" is the answer to "what should this click do".
 */
export type WokenEdge = 'press' | 'release' | null;

/** A run parked on an `onevent` step, waiting for its code. */
export interface Waiter {
    code: number;
    /**
     * What wakes this waiter. 'click' wakes on the press and the engine then
     * swallows the release as part of the gesture. 'split' wakes on the next
     * edge whichever it is — which is what lets two split steps in a row
     * bracket one hold: the first catches the press, the second the release.
     * 'press' and 'release' are the fixed halves, kept for older documents.
     */
    edge: 'click' | 'split' | 'press' | 'release';
    /** Fired with the edge that woke it, null when the wait was called off. */
    resolve: (edge: WokenEdge) => void;
}

/**
 * Remove and return every waiter the event wakes: click and press waiters on
 * value 1, release waiters on value 0, split waiters on either edge, and
 * autorepeat wakes nobody. Waiters outrank configured triggers for the same
 * code — a run explicitly parked on this click is more specific than a
 * standing remap, and firing both would act twice on one press.
 */
export function claimWaiters(waiters: Waiter[], event: StreamedEvent): Waiter[] {
    if (!event.trig || event.type !== EV_KEY ||
        (event.value !== 0 && event.value !== 1)) {
        return [];
    }
    const wakes = (waiter: Waiter) => waiter.code === event.code &&
        (waiter.edge === 'split' ||
            (event.value === 0 ? waiter.edge === 'release' : waiter.edge !== 'release'));
    const claimed = waiters.filter(wakes);
    if (claimed.length > 0) {
        // Every run waiting on this edge wakes: two macros parked on the same
        // button are both asking the same question, and it was answered.
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (wakes(waiters[i])) {
                waiters.splice(i, 1);
            }
        }
    }
    return claimed;
}

/** How long after the stream drops before trying it again. */
const RECONNECT_MS = 3000;

export class TriggerEngine {
    private _daemon: DaemonClient;
    private _stream: EventStream;
    private _actions: TriggerActions;
    private _byCode = new Map<number, Trigger>();
    private _waiters: Waiter[] = [];
    /**
     * Codes held down by a wake: consumed until their release lands, so a
     * gesture is not cut in half by the run letting go between the two edges.
     */
    private _draining = new Set<number>();
    private _retryId = 0;
    private _destroyed = false;

    constructor(daemon: DaemonClient, eventSocket: string, actions: TriggerActions) {
        this._daemon = daemon;
        this._stream = new EventStream(eventSocket);
        this._actions = actions;
    }

    /** Replace the trigger set; called at startup and whenever settings change. */
    setTriggers(triggers: Trigger[]): void {
        this._byCode = armedByCode(triggers);
        this._refresh();
    }

    /**
     * Park a run until the chosen edge of `source` — pressed, or released.
     * While anything waits on a code, the daemon consumes both of its edges:
     * the button belongs to the macro for the duration, so a run waiting on
     * the release is not surprised by the press doing its normal job first.
     * The promise resolves with the edge that woke it and null when cancelled,
     * and never rejects — being woken for nothing is a normal way for a wait to
     * end (the run was stopped). Returns null for a source that names no real
     * button or key.
     */
    waitFor(
        source: string,
        edge: 'click' | 'split' | 'press' | 'release' = 'click',
    ): { promise: Promise<WokenEdge>; cancel: () => void } | null {
        const code = sourceCode(source);
        if (code === null) {
            return null;
        }
        let waiter!: Waiter;
        const promise = new Promise<WokenEdge>(resolve => {
            waiter = { code, edge, resolve };
            this._waiters.push(waiter);
        });
        this._refresh();
        return {
            promise,
            cancel: () => {
                const index = this._waiters.indexOf(waiter);
                if (index >= 0) {
                    this._waiters.splice(index, 1);
                    waiter.resolve(null);
                    this._refresh();
                }
            },
        };
    }

    handle(event: StreamedEvent): void {
        // A wake on a press left its release in flight, and the release belongs
        // to whoever got the press: swallowed for a click-mode wake, handed on
        // to a run that has since parked on exactly that release. Either way
        // the code stays claimed until it lands — see `_draining`.
        if (event.type === EV_KEY && this._draining.has(event.code)) {
            const claimedByWaiter = event.value === 0 &&
                this._waiters.some(waiter => waiter.code === event.code &&
                    (waiter.edge === 'release' || waiter.edge === 'split'));
            if (event.value === 0) {
                this._draining.delete(event.code);
            }
            if (!claimedByWaiter) {
                if (event.value === 0) {
                    this._refresh();
                }
                return;
            }
            // Fall through: claimWaiters below hands it to the parked run.
        }
        const woken = claimWaiters(this._waiters, event);
        if (woken.length > 0) {
            // Any wake on a press holds the code until the release lands. For a
            // click waiter that is the swallowing above. For a split one it is
            // what keeps the gesture whole: the run is between its two halves
            // now, and it takes a moment to come back and park on the second —
            // if the code were given up here, the daemon would stop consuming
            // in that gap, hand the release to the desktop instead, and leave
            // whatever the first half pressed held down with nothing coming to
            // lift it.
            if (event.value === 1) {
                this._draining.add(event.code);
            }
            const edge: WokenEdge = event.value === 1 ? 'press' : 'release';
            for (const waiter of woken) {
                waiter.resolve(edge);
            }
            this._refresh();
            return;
        }
        // A waiter on either edge of this code owns the whole button: the
        // other edge must not fall through to a standing trigger while a
        // macro is in the middle of a press-and-release conversation with it.
        if (event.type === EV_KEY &&
            this._waiters.some(waiter => waiter.code === event.code)) {
            return;
        }
        dispatch(this._byCode, event, this._actions);
    }

    destroy(): void {
        this._destroyed = true;
        this._byCode.clear();
        this._draining.clear();
        for (const waiter of this._waiters.splice(0)) {
            waiter.resolve(null);
        }
        // Best effort: on disable the daemon should stop consuming, and if it
        // is unreachable it stops on its own the moment the stream closes.
        void this._push();
        this._closeStream();
    }

    /** The one recomputation behind every change: what to consume, and whether
     * the stream needs to be up to receive it. */
    private _refresh(): void {
        if (this._destroyed) {
            return;
        }
        if (this._codes().length === 0) {
            // Clearing the daemon first matters: with no stream client it would
            // stop consuming anyway, but only after the next event arrived.
            void this._push();
            this._closeStream();
            return;
        }
        void this._connect();
    }

    /** Everything currently worth consuming: standing triggers, parked runs,
     * and clicks whose release has not landed yet. */
    private _codes(): number[] {
        return [...new Set([
            ...this._byCode.keys(),
            ...this._waiters.map(waiter => waiter.code),
            ...this._draining,
        ])];
    }

    private async _connect(): Promise<void> {
        if (this._destroyed || this._codes().length === 0) {
            return;
        }
        try {
            if (!this._stream.active) {
                await this._stream.open(
                    event => this.handle(event),
                    () => this._scheduleReconnect(),
                );
            }
            // Pushed after the stream is up, and again on every reconnect: a
            // restarted daemon has forgotten the codes, and consuming without
            // a stream client never happens — so this order can't eat clicks.
            await this._push();
        } catch (error) {
            reportProblem('Daemon', `triggers are not active: ${(error as Error).message}`, {
                hint: 'The buttons behave normally until the daemon answers. ' +
                    'Check it with: systemctl status macroclickwerk',
            });
            this._scheduleReconnect();
        }
    }

    private async _push(): Promise<void> {
        await this._daemon.setTriggers(this._codes()).catch(() => {
            // A dead daemon consumes nothing, so silence here is safe; the
            // reconnect path reports when it matters.
        });
    }

    private _scheduleReconnect(): void {
        // Whatever gesture was in flight is over as far as we can tell: the
        // release will land while nobody is listening, so waiting for it would
        // hold the code claimed for the rest of the session — a button that
        // eats clicks, which is the one thing a trigger must never become.
        this._draining.clear();
        this._closeStream();
        if (this._destroyed || this._codes().length === 0 || this._retryId) {
            return;
        }
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECONNECT_MS, () => {
            this._retryId = 0;
            void this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _closeStream(): void {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        this._stream.close();
    }
}
