import {
    parseDocument, stringifyDocument, newStep, describeStep, describeCondition,
    removeStep, walk, findStep, newMacro,
    newCondition,
    resolveRecordTarget,
    resolveRunStart,
    macroEnabled,
    changedDefinitions,
    parseNumbers, reachesEnd, lastPointerEndpoint,
    AUTHORABLE_STEP_KINDS, EVENT_EDGES, followsEvent,
} from '../dist/src/model.js';
import { textToEvents, keyCode, keyName, charToKey, buttonFromCode } from '../dist/src/keymap.js';
import { starterMacro } from '../dist/src/starter.js';
import { parseDecision, parseVerdict, promptAdvice, verdictFromObjects } from '../dist/src/llm.js';
import {
    collectionName, collectionPaths, collectionText, collectionUnsaved, copyMacro, loadCollection,
    macrosOf, markCollectionSaved, moveMacro, renameCollection,
    collectionOn, setCollectionOn, macroLive, livePoints,
    movePoint, namePlace, pointAt, areaAt, placeCentre,
} from '../dist/src/model.js';
import {
    reportProblem, listProblems, problemCount, clearProblems, onProblemsChanged,
} from '../dist/src/problems.js';

let failures = 0;
const check = (name, cond, extra = '') => {
    if (!cond) { failures++; print(`FAIL ${name} ${extra}`); }
    else print(`ok   ${name}`);
};

// every step kind builds and describes
const kinds = AUTHORABLE_STEP_KINDS;
for (const kind of kinds) {
    const step = newStep(kind);
    const text = describeStep(step);
    check(`describe ${kind}`, typeof text === 'string' && text.length > 0, text);
}

// tree ops
const macro = newMacro('t');
const a = newStep('click'), b = newStep('wait'), loop = newStep('loop'), inner = newStep('key');
loop.body.push(inner);
macro.body.push(a, b, loop);
check('findStep nested', findStep(macro.body, inner.id)?.step.id === inner.id);
check('remove', removeStep(macro.body, b.id)?.id === b.id);
let counted = 0;
walk(macro.body, () => counted++);
check('walk visits nested', counted >= 3, String(counted));

{
    // The row the editor selected, as the shell reads it back. Landing a
    // recording in a loop body rather than after the loop is the whole point,
    // so it is worth a test that does not need a compositor to run.
    const m = newMacro('m');
    const first = newStep('click'), loop = newStep('loop'), gate = newStep('if');
    m.body.push(first, loop, gate);
    const inside = newStep('wait');
    loop.body.push(inside);

    const drop = (raw, step) => {
        const target = resolveRecordTarget(m.body, raw);
        target.list.splice(target.at, 0, step);
        return target;
    };

    check('no selection is the end of the macro',
          resolveRecordTarget(m.body, '').at === 3 &&
          resolveRecordTarget(m.body, '').where === '');
    check('a body lands inside the loop, after what is already there',
          drop(`in:${loop.id}:body`, newStep('text')).list === loop.body &&
          loop.body.map(s => s.kind).join() === 'wait,text');
    check('and says where it went',
          resolveRecordTarget(m.body, `in:${loop.id}:body`).where === 'the body of Repeat forever');
    check('an if names the branch it was given',
          resolveRecordTarget(m.body, `in:${gate.id}:else`).list === gate.else);
    check('a step lands right behind it, not at the end',
          drop(`after:${first.id}`, newStep('scroll')).at === 1 &&
          m.body.map(s => s.kind).join() === 'click,scroll,loop,if');
    check('a nested step lands inside the body it lives in',
          drop(`after:${inside.id}`, newStep('key')).list === loop.body &&
          loop.body.map(s => s.kind).join() === 'wait,key,text');
    check('a deleted step falls back to the end of the macro',
          resolveRecordTarget(m.body, 'after:gone').where === '' &&
          resolveRecordTarget(m.body, 'after:gone').at === m.body.length);
    check('so does a target from an older version',
          resolveRecordTarget(m.body, `${loop.id}:body`).where === '');

    // The same selection says where a run starts, so that there is one mark
    // for "here" rather than a second button meaning almost the same thing.
    check('a selected step is where the next run starts',
          resolveRunStart(m.body, `after:${first.id}`) === first.id);
    check('a step inside a body counts too',
          resolveRunStart(m.body, `after:${inside.id}`) === inside.id);
    check('a selected body starts at the top',
          resolveRunStart(m.body, `in:${loop.id}:body`) === '');
    check('so does no selection at all',
          resolveRunStart(m.body, '') === '');
    check('and so does a step that has been deleted since',
          resolveRunStart(m.body, 'after:gone') === '');
    check('a step in another macro leaves this one starting at the top',
          resolveRunStart(newMacro('other').body, `after:${first.id}`) === '');
    check('the end of a macro is a target like any other',
          resolveRecordTarget(m.body, `end:${m.id}`).at === m.body.length);
}

// switched on and off
{
    check('a new macro is switched on', macroEnabled(newMacro('n')));
    check('so is one written before the flag existed',
          macroEnabled({ id: 'm', name: 'old', body: [] }));
    check('off is off', !macroEnabled({ id: 'm', name: 'off', enabled: false, body: [] }));
    const kept = parseDocument(JSON.stringify({
        version: 1,
        macros: [{ id: 'a', name: 'a', enabled: false, body: [] }, { id: 'b', name: 'b', body: [] }],
    })).macros;
    check('the flag survives a round trip', kept[0].enabled === false);
    check('and an absent one stays absent, for the store to migrate',
          kept[1].enabled === undefined);
}

// round trip
const doc = { version: 1, macros: [starterMacro()] };
const back = parseDocument(stringifyDocument(doc));
check('round trip macros', back.macros.length === 1);
check('round trip nested body', back.macros[0].body[0].body.length === 2,
      String(back.macros[0].body[0].body.length));
check('parse empty', parseDocument('').macros.length === 0);
check('parse garbage', parseDocument('{{{').macros.length === 0);

// starter describes the requested loop
const starter = starterMacro();
check('starter is forever loop', describeStep(starter.body[0]) === 'Repeat forever', describeStep(starter.body[0]));
const outerIf = starter.body[0].body[0];
check('starter gate is now an if', outerIf.kind === 'if', outerIf.kind);
check('starter if mentions the prompt', describeStep(outerIf).includes('button on the left green'), describeStep(outerIf));
check('starter wait is outside the if', describeStep(starter.body[0].body[1]) === 'Wait 10s',
      describeStep(starter.body[0].body[1]));
check('starter acts inside the if', outerIf.then[0].kind === 'click');
const innerIf = outerIf.then[1];
check('starter nested colour check', innerIf.kind === 'if' && describeCondition(innerIf.cond).startsWith('pixel'),
      describeCondition(innerIf.cond));
check('starter nested body', innerIf.then.length === 1 && innerIf.then[0].kind === 'key');

// legacy inline `when` guards migrate into an if rather than vanishing
const legacy = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'legacy', body: [
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2,
      when: { type: 'pixel', x: 3, y: 4, color: '#fff', tolerance: 5 } },
    { id: 'b', kind: 'loop', count: 2, body: [
        { id: 'c', kind: 'key', code: 'KEY_E', action: 'tap',
          when: { type: 'llm', prompt: 'ready?' } },
    ] },
    { id: 'd', kind: 'wait', ms: 5, when: { type: 'always' } },
] }] });
const mig = parseDocument(legacy).macros[0].body;
check('guard migrated to if', mig[0].kind === 'if' && mig[0].then[0].id === 'a', mig[0].kind);
check('guard condition preserved', describeCondition(mig[0].cond).startsWith('pixel'), describeCondition(mig[0].cond));
check('guard removed from step', mig[0].then[0].when === undefined);
check('nested guard migrated', mig[1].body[0].kind === 'if' && mig[1].body[0].then[0].id === 'c');
check('always guard not wrapped', mig[2].kind === 'wait' && mig[2].when === undefined, mig[2].kind);

// keymap
check('keyCode KEY_E', keyCode('KEY_E') === 18);
check('keyCode bare e', keyCode('e') === 18);
check('keyName 18', keyName(18) === 'KEY_E');
check('buttonFromCode', buttonFromCode(272) === 'left');
check('charToKey shift', charToKey('A').shift === true && charToKey('a').shift === false);
const ev = textToEvents('Hi!', 0);
// H(shift) i(unshift) !(shift) -> shift down, H down/up, shift up, i down/up, shift down, ! down/up, shift up
check('textToEvents balanced', ev.filter(e => e.value === 1).length === ev.filter(e => e.value === 0).length, JSON.stringify(ev.length));
check('textToEvents releases shift at end', ev[ev.length - 1].value === 0 && ev[ev.length - 1].code === 42);

// the add-a-step menu should only offer things you can actually author
check('verbatim steps are gone entirely', !AUTHORABLE_STEP_KINDS.includes('raw'));
// a document from before verbatim recording was removed loses only those steps
const rawDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'r', body: [
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
    { id: 'b', kind: 'raw', label: 'old', events: [{ dt: 0, type: 1, code: 2, value: 1 }] },
    { id: 'l', kind: 'loop', count: 'forever', body: [
        { id: 'c', kind: 'raw', label: 'nested', events: [] },
        { id: 'd', kind: 'wait', ms: 5 }] },
] }] });
const rawKept = parseDocument(rawDoc).macros[0].body;
check('raw dropped at the top level', rawKept.map(s => s.kind).join(',') === 'click,loop',
      rawKept.map(s => s.kind).join(','));
check('raw dropped inside a loop', rawKept[1].body.map(s => s.kind).join(',') === 'wait',
      rawKept[1].body.map(s => s.kind).join(','));
check('every offered kind builds something usable',
      AUTHORABLE_STEP_KINDS.every(k => newStep(k).kind === k));

// where a macro leaves the pointer, so a new recording knows where it resumes
const eqp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('no endpoint in an empty macro', lastPointerEndpoint([]) === null);
check('endpoint from the last positioned step', eqp(lastPointerEndpoint([
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
    { id: 'b', kind: 'move', mode: 'abs', x: 9, y: 8 },
]), { x: 9, y: 8 }));
check('relative moves do not count', eqp(lastPointerEndpoint([
    { id: 'a', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
    { id: 'b', kind: 'move', mode: 'rel', dx: 5, dy: 5 },
]), { x: 1, y: 2 }));
check('endpoint found inside a loop', eqp(lastPointerEndpoint([
    { id: 'r', kind: 'loop', count: 'forever', body: [
        { id: 'c', kind: 'click', button: 'left', mode: 'abs', x: 7, y: 7 }] },
]), { x: 7, y: 7 }));
check('keys have no endpoint', lastPointerEndpoint([
    { id: 'k', kind: 'key', code: 'KEY_A', action: 'tap' }]) === null);

// reachability, so recordings are not appended somewhere unreachable
const mk = (kind, extra = {}) => ({ id: 'x', kind, ...extra });
const loopStep = (extra) => ({ id: 'a', kind: 'loop', count: 'forever', body: [], ...extra });
check('plain list reaches the end', reachesEnd([mk('click'), mk('wait')]));
check('endless loop does not', !reachesEnd([loopStep({ body: [mk('click')] })]));
check('endless loop with a break does', reachesEnd([
    loopStep({ body: [mk('click'), { id: 'b', kind: 'break' }] })]));
check('break inside an if still counts', reachesEnd([
    loopStep({ body: [
        { id: 'i', kind: 'if', cond: { type: 'always' }, then: [{ id: 'b', kind: 'break' }], else: [] }] })]));
check('a break in a nested loop does not free the outer one', !reachesEnd([
    loopStep({ body: [loopStep({ id: 'n', body: [{ id: 'b', kind: 'break' }] })] })]));
check('counted loop reaches the end', reachesEnd([loopStep({ count: 5 })]));
check('a loop with a break reaches the end', reachesEnd([
    loopStep({ body: [{ id: 'b', kind: 'break' }] })]));
check('stop ends the list', !reachesEnd([mk('click'), { id: 's', kind: 'stop' }]));

// "proceed when the answer is no" was an inversion, so it becomes `not`
const invDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'i', body: [
    { id: 'a', kind: 'if', cond: { type: 'llm', prompt: 'ready?', expect: false, onError: 'abort' },
      then: [], else: [] },
    { id: 'b', kind: 'if', cond: { type: 'llm', prompt: 'ready?', expect: true, onError: 'false' },
      then: [], else: [] },
] }] });
const inv = parseDocument(invDoc).macros[0].body;
check('expect:false becomes not', inv[0].cond.type === 'not' && inv[0].cond.of.type === 'llm',
      JSON.stringify(inv[0].cond.type));
check('the inverted prompt survives', inv[0].cond.of.prompt === 'ready?');
check('expect:true stays a plain check', inv[1].cond.type === 'llm');
check('expect is gone', inv[0].cond.of.expect === undefined && inv[1].cond.expect === undefined);
check('onError is gone', inv[0].cond.of.onError === undefined && inv[1].cond.onError === undefined);

// coordinate field parsing
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('numbers comma', eq(parseNumbers('100, 200', 2), [100, 200]));
check('numbers space', eq(parseNumbers('100 200', 2), [100, 200]));
check('numbers x', eq(parseNumbers('40x60', 2), [40, 60]));
check('numbers rect', eq(parseNumbers('10, 20, 30, 40', 4), [10, 20, 30, 40]));
check('numbers negative', eq(parseNumbers('-5, 12', 2), [-5, 12]));
check('numbers rounded', eq(parseNumbers('10.6, 20.2', 2), [11, 20]));
check('numbers padded', eq(parseNumbers('  100 ,  200  ', 2), [100, 200]));
check('numbers too few', parseNumbers('100', 2) === null);
check('numbers too many', parseNumbers('1,2,3', 2) === null);
check('numbers not a number', parseNumbers('abc, 2', 2) === null);
check('numbers empty', parseNumbers('', 2) === null);

// repeat and while fold onto one loop
const loopDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'l', body: [
    { id: 'a', kind: 'repeat', count: 'forever', body: [{ id: 'x', kind: 'wait', ms: 1 }] },
    { id: 'b', kind: 'repeat', count: 7, body: [] },
    { id: 'c', kind: 'while', cond: { type: 'llm', prompt: 'go?' }, maxIterations: 0, body: [] },
    { id: 'd', kind: 'while', cond: { type: 'llm', prompt: 'go?' }, maxIterations: 4, body: [] },
] }] });
const loops = parseDocument(loopDoc).macros[0].body;
check('all loops become one kind', loops.every(s => s.kind === 'loop'), JSON.stringify(loops.map(s => s.kind)));
check('no loop carries a condition any more', loops.every(s => s.cond === undefined));
check('maxIterations is gone', loops[3].maxIterations === undefined);
check('repeat forever keeps its shape', loops[0].count === 'forever' && loops[0].body.length === 1);
check('counted repeat keeps its count', loops[1].count === 7);
check('uncapped while becomes forever', loops[2].count === 'forever');
check('capped while keeps its cap', loops[3].count === 4);
check('repeat forever still reads as before', describeStep(loops[0]) === 'Repeat forever', describeStep(loops[0]));
check('counted repeat reads naturally', describeStep(loops[1]) === 'Repeat 7×', describeStep(loops[1]));

// a while condition becomes the `if … break` it was shorthand for
const guardStep = loops[2].body[0];
check('while condition became an if', guardStep?.kind === 'if', JSON.stringify(guardStep?.kind));
check('it breaks out of the loop', guardStep?.then[0]?.kind === 'break');
check('and it breaks when the condition fails', guardStep?.cond.type === 'not' && guardStep.cond.of.type === 'llm',
      JSON.stringify(guardStep?.cond));
check('the guard runs before the body', loops[2].body.length === 1);

// gate steps migrate into plain control flow
const gateDoc = (onFalse, extra = {}) => JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'g', body: [
    { id: 'r', kind: 'loop', count: 'forever', body: [
        { id: 'g1', kind: 'gate', onFalse, ...extra, cond: { type: 'llm', prompt: 'ready?' } },
        { id: 's1', kind: 'click', button: 'left', mode: 'abs', x: 1, y: 2 },
        { id: 's2', kind: 'wait', ms: 10000 },
    ] },
] }] });
const gateBody = onFalse => parseDocument(gateDoc(onFalse)).macros[0].body[0].body;

const skip = gateBody('skip-rest');
check('gate skip-rest wraps the rest in an if', skip.length === 1 && skip[0].kind === 'if', JSON.stringify(skip.map(s => s.kind)));
check('gate skip-rest keeps the following steps', skip[0].then.length === 2 && skip[0].then[0].id === 's1');
const brk = gateBody('break');
check('gate break becomes if-not-break', brk[0].kind === 'if' && brk[0].cond.type === 'not' && brk[0].then[0].kind === 'break');
check('gate break leaves later steps alone', brk.length === 3 && brk[1].id === 's1');
const cont = gateBody('continue');
check('gate continue becomes if-not-continue', cont[0].then[0].kind === 'continue');
const abort = gateBody('abort');
check('gate abort becomes if-not-stop', abort[0].then[0].kind === 'stop');
const retryBody = parseDocument(gateDoc('retry', { retryMs: 500 })).macros[0].body[0].body;
check('gate retry becomes a loop that breaks when ready',
      retryBody[0].kind === 'loop' && retryBody[0].body[0].kind === 'if'
      && retryBody[0].body[0].then[0].kind === 'break');
check('gate retry waits inside the loop', retryBody[0].body[1].kind === 'wait' && retryBody[0].body[1].ms === 500);

// every press step under an event is offered the follow — click and key alike.
// A step keeps whatever action it stores: an empty one follows the edge,
// one that names an action does that instead, and the row shows which.
const heldDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'h', body: [
    { id: 'c0', kind: 'click', button: 'left', mode: 'current', action: 'down', holdMs: 200 },
    { id: 'e1', kind: 'onevent', source: 'BTN_RIGHT' },
    { id: 'c1', kind: 'click', button: 'left', mode: 'current', holdMs: 200 },
    { id: 'k1', kind: 'key', code: 'KEY_E' },
    { id: 'k2', kind: 'key', code: 'KEY_F', action: 'down' },
] }] });
const held = parseDocument(heldDoc).macros[0].body;
check('a click above the event follows nothing', followsEvent(held, 'c0') === null);
check('click and key below it both answer to the same event',
      followsEvent(held, 'c1')?.id === 'e1' && followsEvent(held, 'k1')?.id === 'e1'
      && followsEvent(held, 'k2')?.id === 'e1');
check('an empty action is left empty, which is what following looks like',
      held[2].action === undefined && held[3].action === undefined);
check('the hold time is left alone, for if the event goes away', held[2].holdMs === 200);
check('a follower reads as a plain click',
      describeStep(held[2]) === 'Click left at pointer', describeStep(held[2]));
// The row and the dropdown on it have to agree, and only the whole gesture is
// named differently between the two kinds: a mouse clicks, a keyboard types,
// and both halve into a press and a release.
check('half a click is a press', describeStep(held[0]) === 'Press left at pointer',
      describeStep(held[0]));
check('half a keystroke is a press too', describeStep(held[4]) === 'Press F',
      describeStep(held[4]));
check('a whole keystroke is a type', describeStep(held[3]) === 'Type E',
      describeStep(held[3]));
check('the other half is a release either way',
      describeStep({ ...held[0], action: 'up' }) === 'Release left at pointer'
      && describeStep({ ...held[4], action: 'up' }) === 'Release F');
check('and a step that names an action keeps it', held[4].action === 'down');

// The whole-click mode is gone: an event now waits for the press, the release,
// or whichever comes first, and a stored 'click' is dropped on the way in.
const wholeDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'w', body: [
    { id: 'e', kind: 'onevent', source: 'BTN_RIGHT', edge: 'click' },
    { id: 'c', kind: 'click', button: 'left', mode: 'current', action: 'down', holdMs: 900 },
] }] });
const whole = parseDocument(wholeDoc).macros[0].body;
check('a stored click/split mode is dropped', whole[0].edge === undefined,
      JSON.stringify(whole[0]));
check('the event reads as both edges',
      describeStep(whole[0]) === 'When the right button is pressed or released',
      describeStep(whole[0]));
check('and the click under it keeps the action it was given',
      whole[1].action === 'down' && whole[1].holdMs === 900,
      JSON.stringify(whole[1]));

// the two single edges survive the trip and each say so
const edgeDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'e', body: [
    { id: 'p', kind: 'onevent', source: 'BTN_RIGHT', edge: 'press' },
    { id: 'r', kind: 'onevent', source: 'KEY_F13', edge: 'release' },
] }] });
const edges = parseDocument(edgeDoc).macros[0].body;
check('a press-only event is kept', edges[0].edge === 'press'
      && describeStep(edges[0]) === 'When the right button is pressed',
      describeStep(edges[0]));
check('a release-only event is kept', edges[1].edge === 'release'
      && describeStep(edges[1]) === 'When F13 is released', describeStep(edges[1]));
check('and all three edges are offered', EVENT_EDGES.join() === 'either,press,release',
      EVENT_EDGES.join());

// pixel and regionColor fold onto one colour condition
const colDoc = JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'c', body: [
    { id: 'a', kind: 'if', cond: { type: 'pixel', x: 5, y: 6, color: '#abcdef', tolerance: 9 }, then: [], else: [] },
    { id: 'b', kind: 'if', cond: { type: 'regionColor', x: 1, y: 2, w: 30, h: 40, color: '#123456', tolerance: 7, coverage: 0.5 }, then: [], else: [] },
    { id: 'c', kind: 'if', cond: { type: 'and', of: [{ type: 'pixel', x: 1, y: 1, color: '#fff', tolerance: 2 }] }, then: [], else: [] },
] }] });
const cols = parseDocument(colDoc).macros[0].body;
check('pixel becomes 1x1 colour', cols[0].cond.type === 'color' && cols[0].cond.w === 1);
check('pixel keeps its position', cols[0].cond.x === 5 && cols[0].cond.y === 6 && cols[0].cond.color === '#abcdef');
check('regionColor becomes colour', cols[1].cond.type === 'color' && cols[1].cond.w === 30);
// The share of pixels a colour check used to demand is gone, and gone from the
// documents that carried it: it asked pixels to match an average, which is a
// colour they need not have, so the demand was routinely unmeetable.
check('the coverage share is dropped on the way in',
      cols[1].cond.coverage === undefined, JSON.stringify(cols[1].cond));
check('nested condition migrated', cols[2].cond.of[0].type === 'color');
check('1x1 colour describes as a pixel', describeCondition(cols[0].cond).startsWith('pixel'), describeCondition(cols[0].cond));
check('area colour describes as an average', describeCondition(cols[1].cond).startsWith('avg of 30×40'),
      describeCondition(cols[1].cond));
check('and both shapes say their tolerance', describeCondition(cols[0].cond).includes('±9')
      && describeCondition(cols[1].cond).includes('±7'), describeCondition(cols[0].cond));
check('the old per-check flash switch is dropped on load', parseDocument(JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'c', body: [
    { id: 'a', kind: 'if', cond: { type: 'not', of: { type: 'color', x: 1, y: 2, w: 3, h: 4, color: '#abcdef', tolerance: 9, flash: true } }, then: [], else: [] },
] }] })).macros[0].body[0].cond.of.flash === undefined);
check('…also from a condition an old while loop carried', !JSON.stringify(parseDocument(JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'w', body: [
    { id: 'a', kind: 'while', cond: { type: 'color', x: 1, y: 2, color: '#abcdef', tolerance: 9, flash: true }, body: [] },
] }] })).macros).includes('flash'));

// never is a condition of its own, not a missing one: it survives a round trip
const neverDoc = parseDocument(JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'n', body: [
    { id: 'a', kind: 'if', cond: { type: 'never' }, then: [], else: [] },
] }] }));
check('never survives parsing', neverDoc.macros[0].body[0].cond.type === 'never');
check('never describes as never', describeCondition(neverDoc.macros[0].body[0].cond) === 'never',
      describeCondition(neverDoc.macros[0].body[0].cond));
check('never is not always', describeCondition(newCondition('never')) !== describeCondition(newCondition('always')));

// llm verdict parsing
check('verdict json', parseVerdict('{"match": true, "reason": "green"}').match === true);
check('verdict fenced', parseVerdict('```json\n{"match": false, "reason":"grey"}\n```').match === false);
check('verdict yes', parseVerdict('YES, it is green').match === true);
check('verdict no', parseVerdict('No.').match === false);
check('verdict string bool', parseVerdict('{"match":"yes"}').match === true);
check('verdict junk', parseVerdict('hmm') === null);
check('verdict empty', parseVerdict('') === null);
// small-model output shapes
check('verdict stringly false', parseVerdict('{"match":"false"}').match === false);
check('verdict numeric', parseVerdict('{"match":1}').match === true);
check('verdict numeric zero', parseVerdict('{"match":0}').match === false);
check('verdict alt key answer', parseVerdict('{"answer": true, "reason":"x"}').match === true);
check('verdict alt key result', parseVerdict('{"result": false}').match === false);
check('verdict alt key verdict', parseVerdict('{"verdict":"yes"}').match === true);
check('verdict reason via explanation', parseVerdict('{"match":true,"explanation":"grn"}').reason === 'grn');
check('verdict trailing chatter', parseVerdict('{"match": true, "reason":"ok"} I hope that helps!').match === true);
check('verdict two objects', parseVerdict('{"match": false, "reason":"a"}\n{"match": true}').match === false);
check('verdict preamble prose', parseVerdict('Sure! Here is the JSON:\n{"match": true, "reason":"green"}').match === true);
check('verdict unknown keys only', parseVerdict('{"colour":"green"}') === null,
      JSON.stringify(parseVerdict('{"colour":"green"}')));
// reasoning models: thinking is not the answer
check('verdict past a think block',
      parseVerdict('<think>Is it true? No, wait.</think>\n{"match": true, "reason":"red"}').match === true);
check('verdict think block only', parseVerdict('<think>It looks true to me.</think>') === null);
check('verdict cut off mid-thought', parseVerdict('<think>The statement seems true, so 1. **D') === null);
check('verdict braces in a thought are not the answer',
      parseVerdict('<think>maybe {"match": false}</think>{"match": true}').match === true);
check('objects-only reads written-out json',
      verdictFromObjects('I decided. {"match": false, "reason":"grey"}').match === false);
check('objects-only ignores a stray yes', verdictFromObjects('yes, that is true') === null);

// --- what counts as editing a macro out from under its own run ---------------

// The shell stops a run whose macro changed while it was going. The line
// between "changed" and "someone touched the document" is what this draws:
// too eager and renaming a macro kills a run in another one, too lax and the
// edit still appears to do nothing until a restart.
{
    // One baseline, deep-copied per case: `newStep` mints a fresh id every call,
    // so building the "same" document twice would differ in every step.
    const base = [
        { id: 'a', name: 'A', enabled: true, body: [newStep('click'), newStep('wait')] },
        { id: 'b', name: 'B', enabled: true, body: [newStep('key')] },
    ];
    const doc = () => JSON.parse(JSON.stringify(base));

    const same = changedDefinitions(doc(), doc());
    check('an untouched document changes nobody', same.size === 0, [...same].join());

    const renamed = doc();
    renamed[0].name = 'A renamed';
    renamed[1].enabled = false;
    const cosmetic = changedDefinitions(doc(), renamed);
    check('renaming and switching off leave the steps alone',
          cosmetic.size === 0, [...cosmetic].join());

    const edited = doc();
    edited[0].body[0].holdMs = 900;
    const one = changedDefinitions(doc(), edited);
    check('an edited step names its own macro', one.has('a') && one.size === 1, [...one].join());

    const deeper = doc();
    deeper[1].body[0].code = 'KEY_Z';
    const other = changedDefinitions(doc(), deeper);
    check('and only its own — the macro beside it is untouched',
          other.has('b') && !other.has('a'), [...other].join());

    const shorter = doc();
    shorter[0].body.pop();
    check('losing a step counts', changedDefinitions(doc(), shorter).has('a'));

    const gone = changedDefinitions(doc(), [doc()[1]]);
    check('and so does the whole macro going', gone.has('a') && !gone.has('b'), [...gone].join());

    const added = [...doc(), newMacro('C')];
    check('a new macro disturbs nothing that was already running',
          changedDefinitions(doc(), added).size === 0);
}

// problem log
clearProblems();
let notified = 0;
const stopListening = onProblemsChanged(() => notified++);
reportProblem('Model', 'connection refused', { hint: 'start it', where: 'if LLM' });
check('problem recorded', problemCount() === 1);
check('problem listener fired', notified === 1);
check('problem fields kept', listProblems()[0].hint === 'start it' && listProblems()[0].where === 'if LLM');
check('problem is timestamped', /^\d\d:\d\d:\d\d$/.test(listProblems()[0].time), listProblems()[0].time);
reportProblem('Model', 'connection refused');
check('repeat collapses', problemCount() === 1 && listProblems()[0].count === 2);
check('repeat keeps the hint', listProblems()[0].hint === 'start it');
reportProblem('Daemon', 'not running');
check('different source is its own entry', problemCount() === 2);
check('newest first', listProblems()[0].source === 'Daemon');
reportProblem('Model', 'connection refused');
check('a repeat comes back to the top', listProblems()[0].source === 'Model');
for (let i = 0; i < 40; i++) reportProblem('Step', `failure ${i}`);
check('log is capped', problemCount() === 25, String(problemCount()));
check('the cap keeps the newest', listProblems()[0].message === 'failure 39');
reportProblem('Screen', '   ');
check('blank message still says something', listProblems()[0].message === 'unknown error');
clearProblems();
check('cleared', problemCount() === 0);
stopListening();
const before = notified;
reportProblem('Macro', 'after unsubscribe');
check('unsubscribed listener is silent', notified === before);
clearProblems();

// --- collections ------------------------------------------------------------
{
    const fileMacro = newMacro('Ready');
    const starter = newStep('start');
    starter.macro = fileMacro.id;
    const restart = newMacro('Restart');
    restart.body.push(starter);
    const file = JSON.stringify({ version: 1, macros: [fileMacro, restart] });

    const doc = { version: 1, macros: [newMacro('Mine')] };
    const path = '/home/me/Tower defense.json';
    check('a collection is named after its file', collectionName(path) === 'Tower defense');
    check('loading adds its macros', loadCollection(doc, path, file) === 2 && doc.macros.length === 3);
    check('…marked as coming from it', macrosOf(doc, path).map(m => m.name).join() === 'Ready,Restart');
    check('a collection just loaded has nothing unsaved', !collectionUnsaved(doc, path));
    macrosOf(doc, path)[0].name = 'Ready!';
    check('an edit makes it unsaved', collectionUnsaved(doc, path));
    markCollectionSaved(doc, path);
    check('…until it is saved', !collectionUnsaved(doc, path));
    let threw = '';
    try { loadCollection(doc, path, file); } catch (e) { threw = e.message; }
    check('the same collection cannot be loaded twice', threw.includes('already loaded'), threw);

    // The same file under another name: every id is taken, so all are fresh,
    // and the Start inside follows its own collection's macro, not the other.
    const other = '/tmp/copy.json';
    loadCollection(doc, other, file);
    const copied = macrosOf(doc, other);
    const ids = new Set(doc.macros.map(m => m.id));
    check('clashing ids are made fresh', ids.size === doc.macros.length);
    check('…and a Start follows its own collection', copied[1].body[0].macro === copied[0].id,
          `${copied[1].body[0].macro} vs ${copied[0].id}`);

    const saved = JSON.parse(collectionText(doc, path));
    check('a saved collection holds its macros and not the membership',
          saved.macros.length === 2 && saved.macros.every(m => m.collection === undefined));
    check('a saved collection reads back as macros', parseDocument(collectionText(doc, path)).macros.length === 2);

    renameCollection(doc, path, '/home/me/td2.json');
    check('save as moves the membership', macrosOf(doc, '/home/me/td2.json').length === 2
          && collectionPaths(doc).join() === `/home/me/td2.json,${other}`, collectionPaths(doc).join());

    setCollectionOn(doc, other, false);
    check('a collection switched off keeps its macros, out of the running', doc.macros.length === 5
          && collectionPaths(doc).includes(other) && !macroLive(doc, macrosOf(doc, other)[0]) && macroLive(doc, doc.macros[0]));
    check('moving down skips what is switched off', !moveMacro(doc, macrosOf(doc, '/home/me/td2.json')[1].id, 1));
    check('…and it stays off through a save', !collectionOn(parseDocument(stringifyDocument(doc)), other));
    setCollectionOn(doc, other, true);
    check('switched on, its macros are back', macroLive(doc, macrosOf(doc, other)[0])
          && !('off' in doc.collections.find(ref => ref.path === other)));
    doc.macros = doc.macros.filter(macro => macro.collection !== other);
    check('a collection with no macros left is gone', !collectionPaths(doc).includes(other)
          && !parseDocument(stringifyDocument(doc)).collections.some(ref => ref.path === other));
    let empty = '';
    try { loadCollection(doc, '/home/me/empty.json', '{"version": 1, "macros": []}'); } catch (e) { empty = e.message; }
    check('…so an empty one is not loaded', empty.includes('no macros'), empty);

    check('macros move up and down', moveMacro(doc, doc.macros[1].id, -1) && doc.macros[0].name === 'Ready!');
    check('…but not past the ends', !moveMacro(doc, doc.macros[0].id, -1));

    const copy = copyMacro(doc, doc.macros.find(m => m.name === 'Restart').id, undefined);
    check('a copy goes right after, under fresh ids, out of any collection',
          doc.macros[doc.macros.indexOf(copy) - 1].name === 'Restart' && copy.collection === undefined
          && copy.id !== doc.macros[doc.macros.indexOf(copy) - 1].id && copy.name === 'Restart (copy)');

    let refused = '';
    try { loadCollection(doc, '/home/me/settings.json', '{"llm-endpoint": "x"}'); } catch (e) { refused = e.message; }
    check('a file that is not macros is not taken for a collection', refused.includes('not a file of macros')
          && !collectionPaths(doc).includes('/home/me/settings.json'), refused);
    refused = '';
    try { loadCollection(doc, '/home/me/broken.json', '{"macros": ['); } catch (e) { refused = e.message; }
    check('…nor is a broken one', refused.includes('not a file of macros'), refused);

    // Only what clashes is renewed: a Start elsewhere aimed at a macro of the
    // file keeps finding it, and an id used twice in the file comes apart.
    const target = newMacro('Target');
    const caller = newStep('start');
    caller.macro = target.id;
    const outside = { version: 1, macros: [Object.assign(newMacro('Outside'), { body: [caller] })] };
    const twin = newMacro('Twin');
    twin.id = outside.macros[0].id;
    const twice = Object.assign(newMacro('Twice'), { id: target.id });
    loadCollection(outside, '/home/me/t.json', JSON.stringify({ version: 1, macros: [target, twin, twice] }));
    const loadedIds = outside.macros.map(m => m.id);
    check('only clashing ids are renewed', loadedIds[1] === target.id && caller.macro === target.id
          && new Set(loadedIds).size === 4, loadedIds.join());

    const kept = parseDocument(stringifyDocument(doc));
    check('membership and the loaded list survive a save',
          collectionPaths(kept).join() === '/home/me/td2.json' && macrosOf(kept, '/home/me/td2.json').length === 2
          && collectionUnsaved(kept, '/home/me/td2.json') === collectionUnsaved(doc, '/home/me/td2.json'));
}

// --- named points -----------------------------------------------------------
{
    const aimed = (x, y) => Object.assign(newStep('click'), { mode: 'abs', x, y });
    const a = aimed(10, 20), b = aimed(10, 20), c = aimed(30, 40);
    const macro = newMacro('Aim');
    macro.body.push(a, b, c);
    const doc = { version: 1, macros: [macro] };

    check('a spot can be named', namePlace(doc, { x: 10, y: 20 }, ' Start ') === null && pointAt(doc, 10, 20)?.name === 'Start');
    check('…and every step at the same spot shares it', pointAt(doc, b.x, b.y)?.name === 'Start' && !pointAt(doc, c.x, c.y));
    check('a name means one place', namePlace(doc, { x: 30, y: 40 }, 'Start') !== null && !pointAt(doc, 30, 40));
    check('naming a named spot renames it', namePlace(doc, { x: 10, y: 20 }, 'Go') === null && doc.points.length === 1
          && doc.points[0].name === 'Go');
    namePlace(doc, { x: 30, y: 40 }, 'Shop');
    namePlace(doc, { x: 10, y: 20 }, '');
    check('forgetting a name keeps the coordinates', !pointAt(doc, 10, 20) && a.x === 10 && a.y === 20
          && doc.points.map(p => p.name).join() === 'Shop');
    check('an empty name takes the name away', namePlace(doc, { x: 30, y: 40 }, '  ') === null && (doc.points ?? []).length === 0);

    // Areas: a check over one shows its name, a click at its middle too.
    {
        const check1 = Object.assign(newStep('if'), { cond: { type: 'llm', prompt: 'ready?', region: { x: 100, y: 200, w: 50, h: 21 } } });
        const check2 = Object.assign(newStep('if'), { cond: { type: 'not', of: { type: 'color', x: 100, y: 200, w: 50, h: 21, color: '#00ff00', tolerance: 9 } } });
        const middle = aimed(125, 210);
        const areas = Object.assign(newMacro('Areas'), { body: [check1, check2, middle] });
        const adoc = { version: 1, macros: [areas] };
        check('an area is aimed at its middle', JSON.stringify(placeCentre({ x: 100, y: 200, w: 50, h: 21 })) === '{"x":125,"y":210}');
        check('an area can be named', namePlace(adoc, { x: 100, y: 200, w: 50, h: 21 }, 'Button') === null
              && areaAt(adoc, check1.cond.region)?.name === 'Button' && areaAt(adoc, check2.cond.of)?.name === 'Button');
        check('…and a click at its middle shows the name', pointAt(adoc, 125, 210)?.name === 'Button');
        check('…but a point of the same corner is another place', namePlace(adoc, { x: 100, y: 200 }, 'Corner') === null
              && adoc.points.length === 2 && namePlace(adoc, { x: 1, y: 1 }, 'Button') !== null);
        check('moving an area moves its checks and the clicks at its middle', movePoint(adoc, 'Button', { x: 0, y: 0, w: 10, h: 10 }) === null
              && JSON.stringify(check1.cond.region) === '{"x":0,"y":0,"w":10,"h":10}' && check2.cond.of.x === 0 && check2.cond.of.w === 10
              && middle.x === 5 && middle.y === 5 && adoc.points[0].w === 10);
        check('summaries call a named place by its name', describeStep(check2, undefined, undefined, adoc) === 'If not (avg of Button ≈ #00ff00 ±9)'
              && describeStep(middle, undefined, undefined, adoc) === 'Click left @ Button', describeStep(check2, undefined, undefined, adoc));
        check('areas survive a save', parseDocument(stringifyDocument(adoc)).points.map(p => `${p.name}:${p.w ?? '-'}`).join() === 'Button:10,Corner:-');
        areas.collection = '/home/me/areas.json';
        adoc.collections = [{ path: '/home/me/areas.json', saved: '' }];
        check('a collection takes along the areas its checks use', JSON.parse(collectionText(adoc, '/home/me/areas.json')).points.map(p => p.name).join() === 'Button');
    }

    namePlace(doc, { x: 10, y: 20 }, 'Go');
    namePlace(doc, { x: 30, y: 40 }, 'Shop');
    check('a point cannot move onto another', movePoint(doc, 'Go', { x: 30, y: 40 }) !== null && a.x === 10);
    check('moving a point takes every step at it along', movePoint(doc, 'Go', { x: 11, y: 22 }) === null
          && a.x === 11 && a.y === 22 && b.x === 11 && b.y === 22 && c.x === 30 && pointAt(doc, 11, 22)?.name === 'Go');
    movePoint(doc, 'Go', { x: 10, y: 20 });
    namePlace(doc, { x: 30, y: 40 }, '');
    const kept = parseDocument(stringifyDocument(doc));
    check('points survive a save', kept.points?.length === 1 && kept.points[0].name === 'Go');
    check('bad and doubled points are dropped on load', parseDocument(JSON.stringify({
        version: 1, macros: [], points: [{ name: 'A', x: 1, y: 2 }, { name: 'A', x: 3, y: 4 },
            { name: 'B', x: 1, y: 2 }, { name: '', x: 5, y: 5 }, { name: 'C', x: 'no', y: 1 }],
    })).points.map(p => p.name).join() === 'A');

    // A collection carries the names its steps are aimed at, and only those.
    namePlace(doc, { x: 99, y: 99 }, 'Unused');
    macro.collection = '/home/me/aim.json';
    const file = JSON.parse(collectionText(doc, '/home/me/aim.json'));
    check('a collection takes along the names it uses', file.points.map(p => p.name).join() === 'Go');
    const other = { version: 1, macros: [], points: [{ name: 'Mine', x: 10, y: 20 }] };
    loadCollection(other, '/home/me/aim.json', JSON.stringify(file));
    check('…and loading it keeps a name already given to that spot', other.points.map(p => p.name).join() === 'Mine');
    const fresh = { version: 1, macros: [] };
    loadCollection(fresh, '/home/me/aim.json', JSON.stringify(file));
    check('…or brings the name along', fresh.points?.map(p => p.name).join() === 'Go');
    check('…and a collection whose name was not taken starts out unsaved',
          collectionUnsaved(other, '/home/me/aim.json') && !collectionUnsaved(fresh, '/home/me/aim.json'));
    check('a macro of a collection that is not loaded is simply yours', parseDocument(JSON.stringify({
        version: 1, macros: [{ ...newMacro('Stray'), collection: '/gone.json' }],
    })).macros[0].collection === undefined);
    setCollectionOn(fresh, '/home/me/aim.json', false);
    check('a collection switched off takes its names out of the list', livePoints(fresh).length === 0
          && fresh.points.length === 1);
    fresh.macros.push(Object.assign(newMacro('Mine too'), { body: [aimed(10, 20)] }));
    namePlace(fresh, { x: 7, y: 7 }, 'Mine, unused');
    check('…but not one a macro still here uses, nor ones of your own',
          livePoints(fresh).map(p => p.name).join() === 'Go,Mine, unused', livePoints(fresh).map(p => p.name).join());
}

// --- one at a time, per macro ----------------------------------------------
{
    const kept = parseDocument(JSON.stringify({ version: 1, macros: [
        { ...newMacro('turns'), exclusive: true }, { ...newMacro('free'), exclusive: false }, newMacro('plain'),
    ] })).macros;
    check('one at a time is the default, and off is kept', kept.map(m => m.exclusive).join() === ',false,'
          && !JSON.stringify(kept[0]).includes('exclusive'), JSON.stringify(kept.map(m => m.exclusive)));
}

// --- the wait after an action ----------------------------------------------
{
    const c = newStep('click');
    c.afterMs = 30;
    check('a wait after a step is part of how it reads', describeStep(c).endsWith(', then wait 30ms'), describeStep(c));
    c.afterMs = 0;
    check('no wait, no mention', !describeStep(c).includes('then'), describeStep(c));
    const kept = parseDocument(JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'm', body: [
        { id: 'k', kind: 'key', code: 'KEY_E', action: 'tap', mods: [], afterMs: 40 }] }] }));
    check('the wait survives a save', kept.macros[0].body[0].afterMs === 40);
}

// --- Back and Remember are gone ---------------------------------------------
{
    const old = parseDocument(JSON.stringify({ version: 1, macros: [{ id: 'm', name: 'm', body: [
        { id: 'mark', kind: 'remember' },
        { id: 'stored', kind: 'move', mode: 'store' },
        { id: 'l', kind: 'loop', count: 2, body: [{ id: 'back', kind: 'move', mode: 'prev' }, { id: 'w', kind: 'wait', ms: 5 }] },
        { id: 'c', kind: 'click', button: 'left', mode: 'prev' },
        { id: 'to', kind: 'move', mode: 'abs', x: 1, y: 2 },
    ] }] }));
    const body = old.macros[0].body;
    check('remember steps and stored-pointer moves are dropped', body.map(s => s.id).join() === 'l,c,to', body.map(s => s.id).join());
    check('…and a move back, at any depth', body[0].body.map(s => s.id).join() === 'w', body[0].body.map(s => s.id).join());
    check('a click back becomes a click where the pointer is', body[1].mode === 'current', body[1].mode);
    check('remember is not offered any more', !AUTHORABLE_STEP_KINDS.includes('remember'));
}

// --- wording a check so yes or no can answer it -----------------------------
{
    const fine = [
        'Is the button on the left green?', 'there is a green button with the label ready',
        'The player has over $900', 'the light is green or yellow', 'Does the dialog show an error?',
        'Is there a restart button', '“Is the timer red?”',
        'There is a “Not ready” label', 'Is there a note on the board', 'Is the knot tied',
    ];
    for (const text of fine) {
        check(`fine as is: ${text}`, promptAdvice(text) === null, promptAdvice(text) ?? '');
    }
    const flagged = [
        ['What colour is the button?', 'words'],
        ['how many enemies are there', 'words'],
        ['Which tab is open?', 'words'],
        ['Count the enemies', 'instruction'],
        ['Describe the screen', 'instruction'],
        ['Is the light green or red?', 'which of the two'],
        ['Is it ready? Is it green?', 'more than one'],
        ['   ', 'yes/no question'],
        ['Is the button not green?', 'expect to see'],
        ['The restart button is gone', 'expect to see'],
        ["The dialog isn't open", 'expect to see'],
        ['There is no longer a timer', 'expect to see'],
    ];
    for (const [text, says] of flagged) {
        const advice = promptAdvice(text) ?? '';
        check(`flagged: ${text.trim() || '(empty)'}`, advice.includes(says), advice);
    }
}

// --- reading a decision model's answer ---------------------------------------
{
    const answer = p => JSON.stringify({ model: 'm', answers: { check: { type: 'noul', noul: p } }, usage: {} });
    const yes = parseDecision(answer(0.97), 0.5);
    check('a likely yes is yes', yes.match && yes.reason === '97% sure', JSON.stringify(yes));
    const no = parseDecision(answer(0.03), 0.5);
    check('an unlikely yes is no, and says how sure', !no.match && no.reason === '97% sure', JSON.stringify(no));
    const short = parseDecision(answer(0.72), 0.9);
    check('a yes under the threshold is no, and says why', !short.match && short.reason === '72% yes, short of 90%', JSON.stringify(short));
    check('the threshold itself counts as yes', parseDecision(answer(0.9), 0.9).match);
    let thrown = '';
    try { parseDecision(JSON.stringify({ error: { message: 'model not found' } }), 0.5); } catch (e) { thrown = e.message; }
    check('a server error is passed on', thrown === 'model not found', thrown);
    thrown = '';
    try { parseDecision(JSON.stringify({ answers: {} }), 0.5); } catch (e) { thrown = e.message; }
    check('an answer without a probability is a failure, not a no', thrown.startsWith('the decision model gave no'), thrown);
    thrown = '';
    try { parseDecision('<html>502</html>', 0.5); } catch (e) { thrown = e.message; }
    check('a non-JSON reply is a failure', thrown.startsWith('could not parse the decision'), thrown);
}

print(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
if (failures > 0) imports.system.exit(1);
