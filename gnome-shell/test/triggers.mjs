// Trigger tests. The daemon and the event stream are out of the picture: what
// is under test is the pure middle — which triggers arm, and what a tagged
// event turns into.

import {
    parseTriggers, isArmed, armedByCode, dispatch, sourceCode, claimWaiters, TriggerEngine,
} from '../dist/src/triggers.js';
import { EV_KEY, BUTTON_CODES, KEY_CODES } from '../dist/src/keymap.js';

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
        injectKeys: (codes, down) => done.push(`key ${codes.join('+')} ${down ? 'down' : 'up'}`),
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
    const waiter = code => ({ code, edge: 'either', resolve: fired => woken.push(`${code}:${fired}`) });
    const waiters = [waiter(BUTTON_CODES.side), waiter(BUTTON_CODES.side), waiter(BUTTON_CODES.extra)];

    let claimed = claimWaiters(waiters, trig(BUTTON_CODES.side, 1));
    claimed.forEach(w => w.resolve(true));
    check('a press wakes every run parked on that code',
          woken.join(' ') === `${BUTTON_CODES.side}:true ${BUTTON_CODES.side}:true`,
          woken.join(' '));
    check('and removes exactly them', waiters.length === 1 && waiters[0].code === BUTTON_CODES.extra);

    claimed = claimWaiters(waiters, trig(BUTTON_CODES.extra, 1, { trig: undefined }));
    check('an unconsumed press wakes nobody', claimed.length === 0 && waiters.length === 1);
    claimed = claimWaiters(waiters, trig(BUTTON_CODES.extra, 0));
    check('a release wakes a parked run just as a press does',
          claimed.length === 1 && waiters.length === 0);
}

// A waiter wakes on the next edge, whichever it is. Two in sequence bracket one
// hold — first the press, then the release — which is what turns two onevent
// steps into "hold E while I hold the button".
{
    const woken = [];
    const parked = () => ({ code: BUTTON_CODES.left, edge: 'either', resolve: f => woken.push(f) });
    const waiters = [parked()];
    claimWaiters(waiters, trig(BUTTON_CODES.left, 1)).forEach(w => w.resolve(true));
    check('the first waiter wakes on the press', woken.length === 1 && waiters.length === 0);
    waiters.push(parked());
    claimWaiters(waiters, trig(BUTTON_CODES.left, 2)).forEach(w => w.resolve(true));
    check('autorepeat wakes nobody', woken.length === 1);
    claimWaiters(waiters, trig(BUTTON_CODES.left, 0)).forEach(w => w.resolve(true));
    check('the next one wakes on the release',
          woken.length === 2 && waiters.length === 0, `${woken.length}`);
}

// A waiter that names one edge sleeps through the other, so an event set to
// "press" is not woken by the letting go — which is what makes the two-step
// hold spellable: one event on the press, one on the release.
{
    const woken = [];
    const waiters = [
        { code: BUTTON_CODES.left, edge: 'press', resolve: () => woken.push('press') },
        { code: BUTTON_CODES.left, edge: 'release', resolve: () => woken.push('release') },
    ];
    claimWaiters(waiters, trig(BUTTON_CODES.left, 0)).forEach(w => w.resolve());
    check('a release passes the press-only waiter by',
          woken.join() === 'release' && waiters.length === 1, woken.join());
    claimWaiters(waiters, trig(BUTTON_CODES.left, 1)).forEach(w => w.resolve());
    check('and the press wakes the one that was waiting for it',
          woken.join() === 'release,press' && waiters.length === 0, woken.join());
}

// A waiter and a configured trigger on the same code: the waiter wins, the
// standing action stays quiet. Mirrored in TriggerEngine.handle, which only
// falls through to dispatch when no waiter claimed the event.
{
    const actions = recordingActions();
    const map = armedByCode([{ id: 'r', source: 'BTN_SIDE', action: 'key', key: 'KEY_E' }]);
    const waiters = [{ code: BUTTON_CODES.side, edge: 'either', resolve: () => {} }];
    const event = trig(BUTTON_CODES.side, 1);
    if (claimWaiters(waiters, event).length === 0) {
        dispatch(map, event, actions);
    }
    check('a parked run outranks a standing remap of the same button',
          actions.done.length === 0, actions.done.join());
}

// --- the wake says which edge it was -----------------------------------------

// Not just "something happened": the steps after an event take their own edge
// from this answer, so a click under one goes down on the press and up on
// the release. Driven through the engine because that is where the event
// becomes an answer; the socket underneath is not there, which the engine
// treats as "the daemon is down" and reports, and is why a complaint about it
// may follow this line.
{
    const asked = [];
    const engine = new TriggerEngine(
        { setTriggers: async codes => { asked.push(codes.join('+') || '(none)'); } },
        '/nonexistent/macroclickwerk-test.sock', recordingActions());
    const answers = [];
    engine.waitFor('BTN_SIDE').promise.then(edge => answers.push(edge));
    engine.handle(trig(BUTTON_CODES.side, 1));

    // The run is between the two halves here: it has been woken by the press
    // and has not yet come back to park on the release. Giving the code up now
    // would hand that release to the desktop and strand whatever the first
    // half pressed in the down position.
    check('the button stays claimed between the press and the release',
          !asked.includes('(none)'), asked.join(' , '));

    engine.waitFor('BTN_SIDE').promise.then(edge => answers.push(edge));
    engine.handle(trig(BUTTON_CODES.side, 0));
    const cancelled = engine.waitFor('BTN_SIDE');
    cancelled.promise.then(edge => answers.push(edge));
    cancelled.cancel();

    check('an unknown source still has no wait to give',
          engine.waitFor('BTN_NOPE') === null);
    check('and once the gesture is over the claim is dropped',
          asked[asked.length - 1] === '(none)', asked.join(' , '));
    engine.destroy();

    // The resolutions are microtasks, so they land on the next turn.
    await Promise.resolve();
    check('the wake names the edge, and a cancelled wait names none',
          answers.join(' ') === 'press release ', answers.join(' '));
}

// A run parked on the press twice over: the release in between is nobody's —
// the press-only waiter is not woken by it, and the desktop must not be handed
// the second half of a gesture whose first half a macro took. So it is
// swallowed, and the waiter is still there for the next real press.
{
    const engine = new TriggerEngine(
        { setTriggers: async () => {} },
        '/nonexistent/macroclickwerk-test.sock', recordingActions());
    const answers = [];
    engine.waitFor('BTN_SIDE', 'press').promise.then(edge => answers.push(String(edge)));
    engine.handle(trig(BUTTON_CODES.side, 1));
    engine.waitFor('BTN_SIDE', 'press').promise.then(edge => answers.push(String(edge)));
    engine.handle(trig(BUTTON_CODES.side, 0));
    await Promise.resolve();
    check('a press-only wait sleeps through the release that follows',
          answers.join() === 'press', answers.join());
    engine.handle(trig(BUTTON_CODES.side, 1));
    await Promise.resolve();
    check('and the next press finds it still parked',
          answers.join() === 'press,press', answers.join());
    engine.destroy();
}

// A run stopped mid-gesture, with the button still down: the leftover release
// is swallowed rather than delivered as a lone release the desktop never saw a
// press for, and the code is given up the moment it lands.
{
    const asked = [];
    const actions = recordingActions();
    const engine = new TriggerEngine(
        { setTriggers: async codes => { asked.push(codes.join('+') || '(none)'); } },
        '/nonexistent/macroclickwerk-test.sock', actions);
    const parked = engine.waitFor('BTN_SIDE');
    let ended = '';
    parked.promise.then(edge => { ended = String(edge); });
    engine.handle(trig(BUTTON_CODES.side, 1));
    // The press already ended that wait; stopping the run afterwards is the
    // run's own business and has nothing left to call off here.
    parked.cancel();
    check('stopping mid-gesture keeps the button claimed until it comes up',
          asked[asked.length - 1] !== '(none)', asked.join(' , '));
    engine.handle(trig(BUTTON_CODES.side, 0));
    check('the stray release goes nowhere', actions.done.length === 0, actions.done.join());
    check('and the button is handed back', asked[asked.length - 1] === '(none)',
          asked.join(' , '));
    engine.destroy();
    await Promise.resolve();
    check('and the wait that the press ended still reports the press',
          ended === 'press', ended);
}

// --- remaps mirror press and release, whatever the source --------------------

// A remap is a hold-follow on any EV_KEY source: mouse button to key, key to
// key, key to mouse button. Down mirrors down, up mirrors up, and the held
// source's autorepeat is left to the kernel.
{
    const map = armedByCode([
        { id: 'k', source: 'KEY_F13', action: 'key', key: 'KEY_E' },
        { id: 'b', source: 'BTN_LEFT', action: 'key', key: 'BTN_RIGHT' },
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
}

// Gamepads are not supported, so their button names name nothing — a trigger
// left over from when they were stays unarmed rather than eating a button.
check('gamepad names no longer resolve to anything',
      sourceCode('BTN_SOUTH') === null && sourceCode('BTN_THUMBR') === null);

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
