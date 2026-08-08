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
    /** evdev name of the key mirrored onto the source, for 'key'. */
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
        return sourceCode(trigger.key ?? '') !== null;
    }
    return true;
}

export interface TriggerActions {
    /** Put a key down or up through the daemon, tracked for emergency release. */
    injectKey(code: number, down: boolean): void;
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
        // Mirror the press: down on 1, up on 0. Value 2 is the kernel's
        // autorepeat, which a held injected key produces on its own.
        const code = sourceCode(trigger.key ?? '');
        if (code !== null && (event.value === 0 || event.value === 1)) {
            actions.injectKey(code, event.value === 1);
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

/** A run parked on an `onevent` step, waiting for its code to be pressed. */
export interface Waiter {
    code: number;
    /** Fired with true on the press, false when the wait was called off. */
    resolve: (fired: boolean) => void;
}

/**
 * Remove and return every waiter the event wakes. Waiters outrank configured
 * triggers for the same code: a run that is explicitly parked on this click is
 * more specific than a standing remap, and firing both would act twice on one
 * press. Releases (value 0) and autorepeat wake nobody.
 */
export function claimWaiters(waiters: Waiter[], event: StreamedEvent): Waiter[] {
    if (!event.trig || event.type !== EV_KEY || event.value !== 1) {
        return [];
    }
    const claimed = waiters.filter(waiter => waiter.code === event.code);
    if (claimed.length > 0) {
        // Every run waiting on this code wakes: two macros parked on the same
        // button are both asking "when it is clicked", and it was.
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].code === event.code) {
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
     * Park a run until `source` is pressed; the press is consumed. The promise
     * resolves true on the press and false when cancelled, and never rejects —
     * being woken for nothing is a normal way for a wait to end (the run was
     * stopped). Returns null for a source that names no real button or key.
     */
    waitFor(source: string): { promise: Promise<boolean>; cancel: () => void } | null {
        const code = sourceCode(source);
        if (code === null) {
            return null;
        }
        let waiter!: Waiter;
        const promise = new Promise<boolean>(resolve => {
            waiter = { code, resolve };
            this._waiters.push(waiter);
        });
        this._refresh();
        return {
            promise,
            cancel: () => {
                const index = this._waiters.indexOf(waiter);
                if (index >= 0) {
                    this._waiters.splice(index, 1);
                    waiter.resolve(false);
                    this._refresh();
                }
            },
        };
    }

    handle(event: StreamedEvent): void {
        const woken = claimWaiters(this._waiters, event);
        if (woken.length > 0) {
            for (const waiter of woken) {
                waiter.resolve(true);
            }
            this._refresh();
            return;
        }
        dispatch(this._byCode, event, this._actions);
    }

    destroy(): void {
        this._destroyed = true;
        this._byCode.clear();
        for (const waiter of this._waiters.splice(0)) {
            waiter.resolve(false);
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

    /** Everything currently worth consuming: standing triggers and parked runs. */
    private _codes(): number[] {
        return [...new Set([...this._byCode.keys(), ...this._waiters.map(waiter => waiter.code)])];
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
