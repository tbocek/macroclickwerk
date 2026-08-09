// Resume tests. The runner normally drives the daemon and asks the condition
// evaluator real questions; both are stubbed here so the only thing under test
// is which steps a run visits, and in what order.

import GLib from 'gi://GLib';

import { MacroRunner } from '../dist/src/runner.js';
import { followsEvent, moveStepTo, newMacro, newStep, pathToStep } from '../dist/src/model.js';
import { BUTTON_CODES } from '../dist/src/keymap.js';
import { clearProblems, listProblems } from '../dist/src/problems.js';

let failures = 0;
const check = (name, cond, extra = '') => {
    if (!cond) { failures++; print(`FAIL ${name} ${extra}`); }
    else print(`ok   ${name}`);
};

// --- stubs -----------------------------------------------------------------

const daemon = {
    play: async () => ({ aborted: false }),
    stop: async () => {},
};

let condition = true;
let evaluated = 0;
const evaluator = {
    evaluate: async () => {
        evaluated++;
        return condition;
    },
};

const BTN_LEFT = BUTTON_CODES.left;

/** Spin the main loop until the condition holds, or give up after two seconds. */
const until = cond => new Promise(resolve => {
    let tries = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
        if (cond() || ++tries > 400) {
            resolve();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
});

/** A step that does nothing but be identifiable in the trace. */
function named(kind, name) {
    const step = newStep(kind);
    step.note = name;
    NAMES.set(step.id, name);
    return step;
}
const NAMES = new Map();

/**
 * Run the macro and return the names of the steps it entered, in order. Loops
 * and ifs appear too — they are steps the runner enters like any other.
 */
async function trace(macro, resumeAt = '', onStep = null) {
    const seen = [];
    const runner = new MacroRunner(daemon, evaluator, {}, {}, {
        onStepsChanged: path => {
            if (path.length === 0) {
                return;
            }
            const id = path[path.length - 1].id;
            seen.push(NAMES.get(id) ?? id);
            onStep?.(runner, id);
        },
    });
    await runner.run(macro, resumeAt);
    return { seen: seen.join(' '), runner };
}

// --- a flat macro ----------------------------------------------------------

const flat = newMacro('flat');
const [f1, f2, f3] = [named('key', 'f1'), named('key', 'f2'), named('key', 'f3')];
flat.body.push(f1, f2, f3);

check('no resume point runs everything', (await trace(flat)).seen === 'f1 f2 f3');
check('resuming skips what came before', (await trace(flat, f2.id)).seen === 'f2 f3');
check('resuming at the last step runs only it', (await trace(flat, f3.id)).seen === 'f3');
check('an id from a deleted step starts at the top',
      (await trace(flat, 'gone')).seen === 'f1 f2 f3');

// --- inside a loop ---------------------------------------------------------

const looped = newMacro('looped');
const loop = named('loop', 'loop');
loop.count = 2;
const [l1, l2, l3] = [named('key', 'l1'), named('key', 'l2'), named('key', 'l3')];
loop.body.push(l1, l2, l3);
const after = named('key', 'after');
looped.body.push(loop, after);

check('a loop runs its body every time',
      (await trace(looped)).seen === 'loop l1 l2 l3 l1 l2 l3 after');
// The point of consuming the chain on the way down: only the iteration you
// stopped in starts part-way, the next one is a whole pass.
check('resuming into a loop only shortens the first pass',
      (await trace(looped, l2.id)).seen === 'loop l2 l3 l1 l2 l3 after');
check('resuming at the loop itself runs the whole loop',
      (await trace(looped, loop.id)).seen === 'loop l1 l2 l3 l1 l2 l3 after');

// --- inside a branch -------------------------------------------------------

const branched = newMacro('branched');
const branch = named('if', 'if');
const [t1, t2] = [named('key', 't1'), named('key', 't2')];
const [e1, e2] = [named('key', 'e1'), named('key', 'e2')];
branch.then.push(t1, t2);
branch.else = [e1, e2];
branched.body.push(branch, named('key', 'tail'));

condition = true;
evaluated = 0;
check('a true condition takes then', (await trace(branched)).seen === 'if t1 t2 tail');
check('the condition was asked', evaluated === 1, String(evaluated));

// Asking again could send the run down the other branch, which would skip the
// step you picked — so a resume into a branch does not ask.
evaluated = 0;
check('resuming into else ignores a true condition',
      (await trace(branched, e2.id)).seen === 'if e2 tail');
check('the condition was not asked', evaluated === 0, String(evaluated));

evaluated = 0;
check('resuming into then works the same way',
      (await trace(branched, t2.id)).seen === 'if t2 tail');
check('still not asked', evaluated === 0, String(evaluated));

// --- what the shell reads off the runner -----------------------------------

// Pausing writes down runner.currentStepId, so it has to be the step that is
// running at the moment it is read.
let at = '';
await trace(looped, '', (runner, id) => {
    if (NAMES.get(id) === 'l2' && !at) {
        at = runner.currentStepId;
        runner.stop();
    }
});
check('currentStepId is the innermost step', at === l2.id, at);

const broken = newMacro('broken');
const bad = named('key', 'bad');
bad.code = 'no-such-key';
const badLoop = named('loop', 'badLoop');
badLoop.count = 1;
badLoop.body.push(named('key', 'ok'), bad);
broken.body.push(badLoop);
print('--- the JS ERROR below is this test working: the run is meant to fail ---');
const failed = await trace(broken);
check('a failing run stops at the step that threw', failed.seen === 'badLoop ok bad', failed.seen);
check('and reports it as the place to continue from',
      failed.runner.failedStepId === bad.id, failed.runner.failedStepId);

// --- the path the resume walks ---------------------------------------------

check('pathToStep finds a top-level step',
      pathToStep(looped.body, after.id).join('/') === after.id);
check('pathToStep names every container on the way down',
      pathToStep(looped.body, l2.id).join('/') === `${loop.id}/${l2.id}`);
check('pathToStep reaches into an else branch',
      pathToStep(branched.body, e1.id).join('/') === `${branch.id}/${e1.id}`);
check('pathToStep of a missing step is empty', pathToStep(flat.body, 'gone').length === 0);

// --- two macros at once ----------------------------------------------------

// Every enabled macro runs, and they run alongside each other rather than one
// after the other: a runner each, over the one daemon, taking turns a step at
// a time.
{
    const order = [];
    const shared = {
        play: async () => {
            await null;   // the turn another runner needs to get a step in
            return { aborted: false };
        },
        stop: async () => {},
    };
    const run = (name, steps) => {
        const macro = newMacro(name);
        for (let i = 0; i < steps; i++) {
            macro.body.push(newStep('scroll'));
        }
        const runner = new MacroRunner(shared, evaluator, {}, {}, {
            onStepsChanged: path => {
                if (path.length > 0) {
                    order.push(name);
                }
            },
        });
        return runner.run(macro);
    };
    await Promise.all([run('a', 3), run('b', 3)]);
    check('both macros ran', order.filter(n => n === 'a').length === 3 &&
          order.filter(n => n === 'b').length === 3, order.join(''));
    check('and their steps interleaved', order.join('') !== 'aaabbb', order.join(''));
}

// --- and one macro's walk to a coordinate is not cut into ------------------

// A click at a fixed position is a conversation with the pointer: nudge, read
// it back, nudge again. Another macro playing in the middle of that moves the
// very pointer being measured, so the walk holds the daemon until it has
// clicked. Played against the real queue, with only the socket stubbed out.
{
    const { DaemonClient } = await import('../dist/src/daemon.js');
    const { EV_REL, REL_X } = await import('../dist/src/keymap.js');

    let pointer = [0, 0];
    globalThis.global = { get_pointer: () => pointer };

    const log = [];
    // Stands in for the daemon: applies half of every movement it is asked for,
    // the way an acceleration curve does, so the walk takes several passes and
    // there is a gap to slip into.
    DaemonClient.prototype._play = async function (events) {
        await null;
        for (const event of events) {
            if (event.type === EV_REL) {
                if (event.code === REL_X) {
                    pointer = [pointer[0] + event.value / 2, pointer[1]];
                    log.push('m');
                } else {
                    log.push('s');   // the other macro's scrolling
                }
            } else {
                log.push('c');
            }
        }
        return { aborted: false };
    };

    const daemon = new DaemonClient();
    const walk = newMacro('walk');
    const click = newStep('click');
    click.x = 100;
    click.y = 0;
    walk.body.push(click);
    const noise = newMacro('noise');
    for (let i = 0; i < 6; i++) {
        noise.body.push(newStep('scroll'));
    }
    const start = macro => new MacroRunner(daemon, evaluator, {}, {}, {}).run(macro);
    await Promise.all([start(walk), start(noise)]);

    const trace = log.join('');
    check('the walk converged and clicked', trace.includes('c'), trace);
    check('nothing played between its nudges and its click',
          /^s*m+c+s*$/.test(trace), trace);
    check('and it took several passes to get there', trace.indexOf('c') > 2, trace);

    // A click "@ previous" undoes the excursion: back to where the pointer
    // was before the last positioned step, then the click.
    pointer = [5, 0];
    const excursion = newMacro('excursion');
    const away = newStep('click');
    away.x = 100;
    away.y = 0;
    const back = newStep('click');
    back.mode = 'prev';
    excursion.body.push(away, back);
    await start(excursion);
    // Within 2: the relative-walk fallback under test stops at a rounded
    // delta of 1, so its true distance can be up to 1.5.
    check('a click @ previous returns to where the excursion began',
          Math.abs(pointer[0] - 5) <= 2, String(pointer));
}

// --- starting and stopping other macros ------------------------------------
{
    // The runner knows about one macro: its own. Steps that name another one
    // hand the name back to whoever owns the rest of them.
    const asked = [];
    const control = (action, macroId, at) => {
        asked.push(`${action}:${macroId}${at ? `@${at}` : ''}`);
        return macroId === 'gone' ? 'that macro is no longer there' : null;
    };
    const runWith = async body => {
        const macro = newMacro('m');
        macro.id = 'self';
        macro.body.push(...body);
        let problem = null;
        let entered = 0;
        const runner = new MacroRunner(daemon, evaluator, {}, {}, {
            onMacroControl: control,
            onStepsChanged: path => { if (path.length > 0) { entered++; } },
            onFinished: (reason, error) => {
                problem = reason === 'error' ? error.message : null;
            },
        });
        await runner.run(macro, '');
        return { problem, entered };
    };

    const other = kind => {
        const step = newStep(kind);
        step.macro = 'other';
        return step;
    };

    await runWith([other('start'), other('stop')]);
    check('a named macro is started and stopped through the callback',
          asked.join(' ') === 'start:other stop:other', asked.join(' '));

    asked.length = 0;
    const after = newStep('wait');
    after.ms = 0;
    const stopped = await runWith([newStep('stop'), after]);
    check('a stop with no macro named ends this run',
          asked.length === 0 && stopped.entered === 1,
          `${asked.join(' ')} entered=${stopped.entered}`);

    asked.length = 0;
    await runWith([newStep('start')]);
    check('a start with no macro named restarts this one',
          asked.join(' ') === 'start:self', asked.join(' '));

    // A start step naming a step is a jump: the shell ends the run and begins
    // it again at that step, so the id has to arrive with the request.
    asked.length = 0;
    const jump = newStep('start');
    jump.at = 'landing';
    await runWith([jump]);
    check('a start step passes the step to begin at through the callback',
          asked.join(' ') === 'start:self@landing', asked.join(' '));

    const missing = newStep('stop');
    missing.macro = 'gone';
    const failed = await runWith([missing]);
    check('a macro that is not there is reported, not swallowed',
          typeof failed.problem === 'string' && failed.problem.includes('no longer there'),
          String(failed.problem));
}

// --- a repeat with nothing in it -------------------------------------------

// The shape that wedged a desktop: a forever repeat whose body is empty, with
// the steps that were meant to go in it sitting beside it instead. Entering it
// never returns, so the run has to step over it and say why.
{
    const empty = newMacro('empty repeat');
    const spin = named('loop', 'spin');
    spin.count = 'forever';
    const next = named('key', 'next');
    empty.body.push(spin, next);

    // A real timeout, because the failure mode under test is "never finishes":
    // without the skip this await would still be pending at logout.
    const finished = await Promise.race([
        trace(empty).then(result => result.seen),
        new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000,
            () => (resolve('TIMED OUT'), GLib.SOURCE_REMOVE))),
    ]);
    check('an empty forever repeat does not spin', finished !== 'TIMED OUT', finished);
    check('and the run carries on past it', finished === 'spin next', finished);

    const complaint = listProblems().find(p => p.message.includes('nothing in it'));
    check('and it is reported rather than passed over in silence',
          complaint !== undefined, JSON.stringify(listProblems().map(p => p.message)));

    // Reported once per repeat per run, not once per pass: an empty repeat
    // nested in a real one used to be thousands of identical lines.
    const outer = newMacro('nested empty repeat');
    const rounds = named('loop', 'rounds');
    rounds.count = 5;
    const inner = named('loop', 'inner');
    inner.count = 'forever';
    rounds.body.push(inner);
    outer.body.push(rounds);
    clearProblems();
    await trace(outer);
    const counted = listProblems().find(p => p.message.includes('nothing in it'));
    check('and said once per run, however many passes reach it',
          counted !== undefined && counted.count === 1,
          `count ${counted?.count}`);
}

// --- dragging a step to an exact spot ----------------------------------------

// What a drop calls: `moveStepTo` places a step at a precise list+index. The
// cases that matter are the ones a drag can physically produce.
{
    const doc = newMacro('dnd');
    const spin = named('loop', 'spin');
    spin.count = 2;
    const [a, b, c] = [named('key', 'a'), named('key', 'b'), named('key', 'c')];
    doc.body.push(a, spin, c);
    spin.body.push(b);

    check('a drop lands exactly where it points',
          moveStepTo(doc.body, c.id, spin.body, 0) && spin.body[0].id === c.id
          && doc.body.length === 2, JSON.stringify(spin.body.map(s => NAMES.get(s.id))));
    check('a container refuses its own body',
          moveStepTo(doc.body, spin.id, spin.body, 0) === false);
    check('and stays where it was', doc.body[1].id === spin.id);
    check('moving forward in the same list lands past the gap it left',
          moveStepTo(doc.body, a.id, doc.body, 2) && doc.body.map(s => NAMES.get(s.id)).join('') === 'spina'
          || doc.body[doc.body.length - 1].id === a.id,
          doc.body.map(s => NAMES.get(s.id)).join(' '));
    check('a drop out of a body works too',
          moveStepTo(doc.body, b.id, doc.body, 0) && doc.body[0].id === b.id
          && spin.body.length === 1);
    check('a step that is gone moves nothing', moveStepTo(doc.body, 'gone', doc.body, 0) === false);
}

// --- a run parked on a click -----------------------------------------------

// The onevent step hands the waiting to the trigger engine; here that engine is
// a stub, so what is under test is the runner's half of the bargain — parking,
// continuing on the press, and being stoppable while parked.
{
    const waiters = [];
    const waitForInput = (_source, edge) => {
        let resolver;
        const promise = new Promise(resolve => { resolver = resolve; });
        const waiter = { edge, fire: (on = 'press') => resolver(on), cancelled: false };
        waiters.push(waiter);
        return {
            promise,
            cancel: () => { waiter.cancelled = true; resolver(null); },
        };
    };

    const clicky = newMacro('clicky');
    const on = named('onevent', 'on');
    on.source = 'BTN_SIDE';
    clicky.body.push(on, named('key', 'then'));

    const seen = [];
    let reason = '';
    const runnerFor = () => new MacroRunner(daemon, evaluator, {}, {}, {
        onStepsChanged: path => {
            if (path.length > 0) {
                seen.push(NAMES.get(path[path.length - 1].id) ?? '?');
            }
        },
        onFinished: r => { reason = r; },
        waitForInput,
    });

    const first = runnerFor();
    const run = first.run(clicky);
    await until(() => waiters.length === 1);
    check('the run parks on the onevent step', waiters.length === 1 && seen.join(' ') === 'on',
          seen.join(' '));
    check('and asks for the edge the step names', waiters[0].edge === 'click', waiters[0].edge);
    waiters[0].fire();
    await run;
    check('the press lets it continue', seen.join(' ') === 'on then', seen.join(' '));
    check('and the run ends well', reason === 'done', reason);

    seen.length = 0;
    const second = runnerFor();
    const parked = second.run(clicky);
    await until(() => waiters.length === 2);
    second.stop();
    await parked;
    check('stopping a parked run calls the wait off', waiters[1].cancelled === true);
    check('and it unwinds without running what follows',
          reason === 'stopped' && seen.join(' ') === 'on', `${reason}: ${seen.join(' ')}`);

    const askew = newMacro('askew');
    const bad = named('onevent', 'bad');
    bad.source = 'BTN_NOPE';
    askew.body.push(bad);
    const failing = new MacroRunner(daemon, evaluator, {}, {}, {
        onFinished: r => { reason = r; },
        waitForInput: () => null,
    });
    await failing.run(askew);
    check('a source that names nothing fails the run instead of hanging',
          reason === 'error', reason);
}

// --- a click under a split event follows that event's edge -------------------

// The long click: press the side button and the left button goes down, let go
// and it comes up. Neither click step says which — they take it from the event
// above them, which is why the editor stops offering the choice.
{
    const played = [];
    const watching = {
        play: async events => { played.push(...events); return { aborted: false }; },
        stop: async () => {},
    };

    const waiters = [];
    const waitForInput = (_source, edge) => {
        let resolver;
        const promise = new Promise(resolve => { resolver = resolve; });
        waiters.push({ edge, fire: on => resolver(on) });
        return { promise, cancel: () => resolver(null) };
    };

    const hold = newMacro('hold');
    const down = named('onevent', 'down');
    down.source = 'BTN_SIDE';
    down.edge = 'split';
    const up = named('onevent', 'up');
    up.source = 'BTN_SIDE';
    up.edge = 'split';
    const clickA = named('click', 'clickA');
    const clickB = named('click', 'clickB');
    // Left, where the pointer is, and no action of their own: the follow.
    for (const click of [clickA, clickB]) {
        click.button = 'left';
        click.mode = 'current';
        delete click.action;
    }
    hold.body.push(down, clickA, up, clickB);

    check('the editor knows both clicks follow the split event',
          followsEvent(hold.body, clickA.id) === 'split'
          && followsEvent(hold.body, clickB.id) === 'split');
    check('and that the first event itself follows nothing',
          followsEvent(hold.body, down.id) === null);

    const running = new MacroRunner(watching, evaluator, {}, {}, { waitForInput }).run(hold);
    await until(() => waiters.length === 1);
    waiters[0].fire('press');
    await until(() => waiters.length === 2);
    check('the press puts the button down and leaves it there',
          played.length === 1 && played[0].value === 1 && played[0].code === BTN_LEFT,
          JSON.stringify(played));
    waiters[1].fire('release');
    await running;
    check('and letting go brings it up',
          played.length === 2 && played[1].value === 0 && played[1].code === BTN_LEFT,
          JSON.stringify(played));
}

// The shape a repeat gives you for free: one event and one click going round
// alternate on their own — the first pass catches the press and holds the
// button, the second catches the release and lets go. Two steps for a long
// click of any length, which is what the four-step version was.
{
    const played = [];
    const waiters = [];
    const macro = newMacro('round');
    const on = named('onevent', 'round-on');
    on.source = 'BTN_RIGHT';
    on.edge = 'split';
    const click = named('click', 'round-click');
    click.button = 'left';
    click.mode = 'current';
    delete click.action;
    const loop = named('loop', 'round-loop');
    loop.count = 'forever';
    loop.body = [on, click];
    macro.body.push(loop);

    const runner = new MacroRunner({
        play: async events => { played.push(...events); return { aborted: false }; },
        stop: async () => {},
    }, evaluator, {}, {}, {
        waitForInput: () => {
            let resolver;
            const promise = new Promise(resolve => { resolver = resolve; });
            waiters.push({ fire: edge => resolver(edge) });
            return { promise, cancel: () => resolver(null) };
        },
    });
    const running = runner.run(macro);
    for (const edge of ['press', 'release', 'press', 'release']) {
        await until(() => waiters.length > 0);
        waiters.shift().fire(edge);
        await until(() => waiters.length > 0);
    }
    runner.stop();
    await running;
    check('a repeat over one event and one click alternates down and up',
          played.slice(0, 4).map(e => e.value).join('') === '1010',
          JSON.stringify(played.map(e => e.value)));
}

// A click with nothing waking it is still a whole click: down, then up after
// the hold. Only a run inside an event follows one.
{
    const played = [];
    const alone = newMacro('alone');
    const click = named('click', 'solo');
    click.button = 'left';
    click.mode = 'current';
    delete click.action;
    alone.body.push(click);
    await new MacroRunner({
        play: async events => { played.push(...events); return { aborted: false }; },
        stop: async () => {},
    }, evaluator, {}, {}, {}).run(alone);
    check('a click with no event above it is a whole click',
          played.length === 2 && played[0].value === 1 && played[1].value === 0,
          JSON.stringify(played));
}

// A whole-click event is over by the time the run moves on, so what follows it
// is not inside a gesture and clicks normally.
{
    const played = [];
    const waiters = [];
    const macro = newMacro('whole');
    const on = named('onevent', 'whole-on');
    on.source = 'BTN_SIDE';
    on.edge = 'click';
    const click = named('click', 'after');
    click.button = 'left';
    click.mode = 'current';
    delete click.action;
    macro.body.push(on, click);

    check('a step under a whole-click event follows a whole click',
          followsEvent(macro.body, click.id) === 'click');

    const running = new MacroRunner({
        play: async events => { played.push(...events); return { aborted: false }; },
        stop: async () => {},
    }, evaluator, {}, {}, {
        waitForInput: () => {
            let resolver;
            const promise = new Promise(resolve => { resolver = resolve; });
            waiters.push({ fire: on2 => resolver(on2) });
            return { promise, cancel: () => resolver(null) };
        },
    }).run(macro);
    await until(() => waiters.length === 1);
    waiters[0].fire('press');
    await running;
    check('and clicks whole rather than sticking down',
          played.length === 2 && played[0].value === 1 && played[1].value === 0,
          JSON.stringify(played));
}

// Where the follow reaches: after the event, into what comes after it, and
// round a repeat — an event in a loop body is before every step in that body
// from the second pass on.
{
    const nested = newMacro('nested');
    const before = named('click', 'before');
    const ev = named('onevent', 'ev');
    ev.edge = 'split';
    const inIf = named('click', 'inIf');
    const iff = named('if', 'iff');
    iff.then = [inIf];
    nested.body.push(before, ev, iff);
    check('a click above the event decides for itself',
          followsEvent(nested.body, before.id) === null);
    check('a click inside a branch below the event follows',
          followsEvent(nested.body, inIf.id) === 'split');

    const looped = newMacro('looped');
    const first = named('click', 'first');
    const wrapped = named('onevent', 'wrapped');
    wrapped.edge = 'split';
    const loop = named('loop', 'loop');
    loop.body = [first, wrapped];
    looped.body.push(loop);
    check('a repeat comes back round, so its whole body follows',
          followsEvent(looped.body, first.id) === 'split');
}

// --- a pad step is a key press in the gamepad range --------------------------

{
    const played = [];
    const padDaemon = {
        play: async events => { played.push(...events); return { aborted: false }; },
        stop: async () => {},
    };
    const macro = newMacro('paddy');
    macro.body.push(named('pad', 'a'));   // BTN_SOUTH, tap
    await new MacroRunner(padDaemon, evaluator, {}, {}, {}).run(macro);
    const keys = played.filter(e => e.type === 1);
    check('a pad step presses and releases its button',
          keys.length === 2 && keys[0].code === 0x130 && keys[0].value === 1
          && keys[1].code === 0x130 && keys[1].value === 0,
          JSON.stringify(keys));
}

// --- a dead model stops only the macros that ask it --------------------------

// The model being unreachable is a fact about one macro's conditions, not
// about the session: a macro with no LLM checks keeps running to the end
// while its neighbour dies. This is the isolation the problems popup implies
// when it says which macro stopped.
{
    const modelDown = {
        evaluate: async () => {
            throw new Error("the model could not answer: HTTP 400: model 'X' not found");
        },
    };
    const asks = newMacro('asks');
    asks.body.push(named('if', 'iff'), named('key', 'never'));
    const plain = newMacro('plain');
    plain.body.push(named('key', 'p1'), named('key', 'p2'));

    const outcomes = {};
    const seen = [];
    const runOne = (macro, evalr, name) => new MacroRunner(daemon, evalr, {}, {}, {
        onStepsChanged: path => {
            if (path.length > 0) {
                seen.push(NAMES.get(path[path.length - 1].id) ?? '?');
            }
        },
        onFinished: reason => { outcomes[name] = reason; },
    }).run(macro);

    print('--- the JS ERROR below is this test working: the model is meant to be down ---');
    await Promise.all([runOne(asks, modelDown, 'asks'), runOne(plain, evaluator, 'plain')]);
    check('the asking macro stops with the error', outcomes.asks === 'error', outcomes.asks);
    check('and never reaches what came after the check', !seen.includes('never'), seen.join(' '));
    check('the macro without LLM checks runs to the end untouched',
          outcomes.plain === 'done' && seen.includes('p2'),
          `${outcomes.plain}: ${seen.join(' ')}`);
    const told = listProblems().find(p => p.message.includes('“asks” stopped'));
    check('and the stop is logged, naming the macro', told !== undefined,
          JSON.stringify(listProblems().slice(0, 3).map(p => p.message)));
}

print(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
if (failures > 0) {
    imports.system.exit(1);
}
