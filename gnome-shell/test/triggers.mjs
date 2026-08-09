// Trigger tests. The daemon and the event stream are out of the picture: what
// is under test is the pure middle — which triggers arm, and what a tagged
// event turns into.

import { parseTriggers, isArmed, armedByCode, dispatch, sourceCode, claimWaiters } from '../dist/src/triggers.js';
import { EV_KEY, BUTTON_CODES, GAMEPAD_CODES, KEY_CODES } from '../dist/src/keymap.js';

let failures = 0;
const check = (name, cond, extra = '') => {
    if (!cond) { failures++; print(`FAIL ${name} ${extra}`); }
    else print(`ok   ${name}`);
};

/** A stream event as the daemon tags it; overrides for the interesting bits. */
const trig = (code, value, extra = {}) =>
    ({ seq: 1, t: 0, dev: 0, type: EV_KEY, code, value, trig: 1, ...extra });

/** Collects what the engine asked for instead of doing it. */
function recordingActions() {
    const done = [];
    return {
        done,
        injectKey: (code, down) => done.push(`key ${code} ${down ? 'down' : 'up'}`),
        control: (action, macroId) => done.push(`${action} ${macroId || '(all)'}`),
    };
}

// --- names and codes -------------------------------------------------------

check('a mouse button resolves', sourceCode('BTN_SIDE') === BUTTON_CODES.side);
check('a key resolves', sourceCode('KEY_E') === KEY_CODES.KEY_E);
check('case does not matter', sourceCode('btn_side') === BUTTON_CODES.side);
check('nonsense resolves to nothing', sourceCode('BTN_NOPE') === null);

// --- what arms -------------------------------------------------------------

const remap = { id: '1', source: 'BTN_SIDE', action: 'key', key: 'KEY_E' };
const bare = { id: '2', source: 'BTN_EXTRA', action: 'none' };
const runner = { id: '3', source: 'KEY_F13', action: 'run', macro: 'm1' };
const halfway = { id: '4', source: 'BTN_MIDDLE', action: 'key', key: '' };

check('a remap with a key arms', isArmed(remap));
// The point of 'none': an onevent with no body is still a click.
check('a trigger with no action stays inert', !isArmed(bare));
check('a remap without its key stays inert', !isArmed(halfway));
check('a macro trigger arms', isArmed(runner));

const byCode = armedByCode([remap, bare, runner, halfway]);
check('only the armed ones are consumed', byCode.size === 2,
      `${byCode.size}: ${[...byCode.keys()].join(',')}`);
check('the inert ones claim no code',
      !byCode.has(BUTTON_CODES.extra) && !byCode.has(BUTTON_CODES.middle));

// --- what a press does -----------------------------------------------------

{
    const actions = recordingActions();
    dispatch(byCode, trig(BUTTON_CODES.side, 1), actions);
    dispatch(byCode, trig(BUTTON_CODES.side, 0), actions);
    check('a remapped click mirrors down and up',
          actions.done.join(' | ') === `key ${KEY_CODES.KEY_E} down | key ${KEY_CODES.KEY_E} up`,
          actions.done.join(' | '));
}

{
    const actions = recordingActions();
    dispatch(byCode, trig(BUTTON_CODES.side, 2), actions);
    check('autorepeat is not re-injected', actions.done.length === 0, actions.done.join());
}

{
    const actions = recordingActions();
    dispatch(byCode, trig(KEY_CODES.KEY_F13, 1), actions);
    dispatch(byCode, trig(KEY_CODES.KEY_F13, 0), actions);
    check('a macro trigger fires once, on the press',
          actions.done.join(' | ') === 'run m1', actions.done.join(' | '));
}

{
    const actions = recordingActions();
    const all = armedByCode([{ id: '5', source: 'BTN_EXTRA', action: 'stop' }]);
    dispatch(all, trig(BUTTON_CODES.extra, 1), actions);
    check('no macro named means everything', actions.done.join() === 'stop (all)',
          actions.done.join());
}

// --- what is ignored -------------------------------------------------------

{
    const actions = recordingActions();
    // Untagged: the daemon forwarded this normally, acting would double it.
    dispatch(byCode, trig(BUTTON_CODES.side, 1, { trig: undefined }), actions);
    // Tagged but unclaimed: a stale daemon set after triggers changed.
    dispatch(byCode, trig(BUTTON_CODES.extra, 1), actions);
    check('untagged and unclaimed events do nothing', actions.done.length === 0,
          actions.done.join());
}

// --- runs parked on a click ------------------------------------------------

{
    const woken = [];
    const waiter = (code, edge = 'press') =>
        ({ code, edge, resolve: fired => woken.push(`${code}:${edge}:${fired}`) });
    const waiters = [waiter(BUTTON_CODES.side), waiter(BUTTON_CODES.side), waiter(BUTTON_CODES.extra)];

    let claimed = claimWaiters(waiters, trig(BUTTON_CODES.side, 1));
    claimed.forEach(w => w.resolve(true));
    check('a press wakes every run parked on that code',
          woken.join(' ') === `${BUTTON_CODES.side}:press:true ${BUTTON_CODES.side}:press:true`,
          woken.join(' '));
    check('and removes exactly them', waiters.length === 1 && waiters[0].code === BUTTON_CODES.extra);

    claimed = claimWaiters(waiters, trig(BUTTON_CODES.extra, 0));
    check('a release wakes no press waiter', claimed.length === 0 && waiters.length === 1);
    claimed = claimWaiters(waiters, trig(BUTTON_CODES.extra, 1, { trig: undefined }));
    check('an unconsumed press wakes nobody', claimed.length === 0 && waiters.length === 1);
}

// The two edges are separate waits: a run parked on the release sleeps
// through the press, and the other way round — which is what turns two
// onevent steps into "hold E while I hold the button".
{
    const woken = [];
    const waiters = [
        { code: BUTTON_CODES.left, edge: 'press', resolve: f => woken.push(`press:${f}`) },
        { code: BUTTON_CODES.left, edge: 'release', resolve: f => woken.push(`release:${f}`) },
    ];
    claimWaiters(waiters, trig(BUTTON_CODES.left, 1)).forEach(w => w.resolve(true));
    check('the press wakes only the press waiter',
          woken.join(' ') === 'press:true' && waiters.length === 1, woken.join(' '));
    claimWaiters(waiters, trig(BUTTON_CODES.left, 2)).forEach(w => w.resolve(true));
    check('autorepeat wakes neither edge', woken.join(' ') === 'press:true');
    claimWaiters(waiters, trig(BUTTON_CODES.left, 0)).forEach(w => w.resolve(true));
    check('the release wakes the release waiter',
          woken.join(' ') === 'press:true release:true' && waiters.length === 0,
          woken.join(' '));
}

// The default: a click waiter (toggle off) wakes on the press — the
// release-swallowing that sets it apart happens in the engine's drain,
// after the wake.
{
    const woken = [];
    const waiters = [{ code: BUTTON_CODES.side, edge: 'click', resolve: f => woken.push(f) }];
    check('a release does not wake a click waiter',
          claimWaiters(waiters, trig(BUTTON_CODES.side, 0)).length === 0 && waiters.length === 1);
    claimWaiters(waiters, trig(BUTTON_CODES.side, 1)).forEach(w => w.resolve(true));
    check('the press wakes a click waiter', woken.join() === 'true' && waiters.length === 0,
          woken.join());
}

// The toggle: a split waiter wakes on the next edge, whichever it is. Two in
// sequence bracket one hold — first the press, then the release — which is
// the long click.
{
    const woken = [];
    const splitWaiter = () =>
        ({ code: BUTTON_CODES.left, edge: 'split', resolve: f => woken.push(f) });
    const waiters = [splitWaiter()];
    claimWaiters(waiters, trig(BUTTON_CODES.left, 1)).forEach(w => w.resolve(true));
    check('a split waiter wakes on the press', woken.length === 1 && waiters.length === 0);
    waiters.push(splitWaiter());
    claimWaiters(waiters, trig(BUTTON_CODES.left, 2)).forEach(w => w.resolve(true));
    check('autorepeat does not wake a split waiter', woken.length === 1);
    claimWaiters(waiters, trig(BUTTON_CODES.left, 0)).forEach(w => w.resolve(true));
    check('the next split waiter wakes on the release',
          woken.length === 2 && waiters.length === 0, `${woken.length}`);
}

// A waiter and a configured trigger on the same code: the waiter wins, the
// standing action stays quiet. Mirrored in TriggerEngine.handle, which only
// falls through to dispatch when no waiter claimed the event.
{
    const actions = recordingActions();
    const map = armedByCode([{ id: 'r', source: 'BTN_SIDE', action: 'key', key: 'KEY_E' }]);
    const waiters = [{ code: BUTTON_CODES.side, edge: 'press', resolve: () => {} }];
    const event = trig(BUTTON_CODES.side, 1);
    if (claimWaiters(waiters, event).length === 0) {
        dispatch(map, event, actions);
    }
    check('a parked run outranks a standing remap of the same button',
          actions.done.length === 0, actions.done.join());
}

// --- remaps mirror press and release, whatever the source --------------------

// A remap is a hold-follow on any EV_KEY source: mouse button to key, key to
// key, key to mouse button, gamepad button to key. Down mirrors down, up
// mirrors up, and the held source's autorepeat is left to the kernel.
{
    const map = armedByCode([
        { id: 'k', source: 'KEY_F13', action: 'key', key: 'KEY_E' },
        { id: 'b', source: 'BTN_LEFT', action: 'key', key: 'BTN_RIGHT' },
        { id: 'g', source: 'BTN_SOUTH', action: 'key', key: 'KEY_SPACE' },
    ]);

    let actions = recordingActions();
    dispatch(map, trig(KEY_CODES.KEY_F13, 1), actions);
    dispatch(map, trig(KEY_CODES.KEY_F13, 2), actions);
    dispatch(map, trig(KEY_CODES.KEY_F13, 0), actions);
    check('a key source mirrors press and release onto its key',
          actions.done.join(' | ') === `key ${KEY_CODES.KEY_E} down | key ${KEY_CODES.KEY_E} up`,
          actions.done.join(' | '));

    actions = recordingActions();
    dispatch(map, trig(BUTTON_CODES.left, 1), actions);
    dispatch(map, trig(BUTTON_CODES.left, 0), actions);
    check('a mouse button remaps to another button, both edges',
          actions.done.join(' | ') === `key ${BUTTON_CODES.right} down | key ${BUTTON_CODES.right} up`,
          actions.done.join(' | '));

    actions = recordingActions();
    dispatch(map, trig(GAMEPAD_CODES.BTN_SOUTH, 1), actions);
    dispatch(map, trig(GAMEPAD_CODES.BTN_SOUTH, 0), actions);
    check('a gamepad button works as a source, both edges',
          actions.done.join(' | ') === `key ${KEY_CODES.KEY_SPACE} down | key ${KEY_CODES.KEY_SPACE} up`,
          actions.done.join(' | '));
}

check('gamepad names resolve like any other source',
      sourceCode('BTN_SOUTH') === 0x130 && sourceCode('btn_tr') === 0x137
      && sourceCode('BTN_THUMBR') === 0x13e);

// --- the stored form -------------------------------------------------------

check('bad json is no triggers', parseTriggers('{oops').length === 0);
check('a non-list is no triggers', parseTriggers('{"a":1}').length === 0);
check('junk entries are dropped, real ones kept',
      parseTriggers('[{"id":"1","source":"BTN_SIDE","action":"none"}, 42, {"broken":true}]').length === 1);

print(failures === 0 ? 'ALL PASSED' : `${failures} FAILURES`);
if (failures > 0) {
    // Non-zero exit so `npm test` fails loudly.
    imports.system.exit(1);
}
