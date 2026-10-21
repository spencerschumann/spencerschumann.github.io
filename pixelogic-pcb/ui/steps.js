// Stepping through a storage level's run: back and on along its script on
// the board itself, the status line saying which step it is, what changed
// and how it went, the pads showing their values, a bar of the steps to
// jump along. A failing Verify drops into it at the step that failed; the
// status line's Steps button opens it any time. See G.stepRun.

import {
    levelTableBodyEl, levelTableEl, levelTableHintEl,
} from './page.js';
import {
    TABLE_BTN, abortReplay, labelPads, readOutputs, renderStatus, scrollRowIntoView, tableFor, verifyStatus,
} from './verdict.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const G = window.PixelogicGame;

// {level, run, index, seed, stale, anim}, or null when not stepping.
// `index` is the step the board is showing, -1 the start. `seed`: the
// verdict's cases, shown for a step not worked out here yet. `stale`: the
// board edited since, so nothing about this step is known until it is run
// again. `anim`: a step being played on the board.
let steps = null;

// A step played forward takes this many frames, however many ticks it
// took to settle: long enough to watch, short enough to step on.
const MIN_FRAMES = 20, MAX_FRAMES = 50;

// What step i gave, if known: worked out here, or the verdict's.
function caseAt(i) {
    if (!steps || i < 0) return null;
    if (steps.run.known(i)) return steps.run.at(i);
    const c = !steps.stale && steps.seed && steps.seed[i];
    return c ? { inputs: c.inputs, got: c.actual, expected: c.expected, ok: c.ok, settled: c.settled } : null;
}

// `opts`: {primed, seed, at} — the verdict's start and cases, and the step
// to stand at (-1, the start, by default).
function enterSteps(level, opts) {
    abortReplay();
    stopAnim();
    const o = opts || {};
    steps = { level, run: G.stepRun(level, !!o.primed), index: -1, seed: o.seed || null, stale: false, anim: null };
    show(o.at === undefined ? -1 : o.at);
}
// The Steps button: from the verdict on the line, if there is one — the
// run it failed, at the step it failed — or from the start, at rest.
function startSteps(level) {
    const s = verifyStatus;
    if (s && s.level === level && s.result && s.done) {
        const r = s.result;
        enterSteps(level, { primed: !!r.primed, seed: r.cases, at: r.failure ? r.failure.step : -1 });
    } else enterSteps(level, {});
}
function exitSteps() {
    if (!steps) return;
    const level = steps.level;
    dropSteps();
    labelPads(level);
    restoreTable();
    renderStatus();
}
// Gone with the board it was of (another level, the sandbox, a Verify).
function dropSteps() {
    stopAnim();
    steps = null;
    levelTableHintEl.textContent = TABLE_HINT;
}
// An edit: what was worked out was of the board before it.
function stepsEdited() {
    if (!steps) return;
    stopAnim();
    steps.run.forget();
    steps.stale = true;
    relabel();
}

// Puts the board at step i, there and then.
function show(i) {
    stopAnim();
    const run = steps.run;
    i = Math.max(-1, Math.min(run.total - 1, i));
    if (!M.setCharges(run.at(i).cells)) { run.forget(); M.setCharges(run.at(i).cells); }
    steps.index = i;
    steps.stale = false;
    shown();
}
// Plays step i on the board, from the step before it as it settled, for
// as many ticks as the step took.
function play(i) {
    stopAnim();
    const run = steps.run;
    if (!M.setCharges(run.at(i - 1).cells)) { run.forget(); M.setCharges(run.at(i - 1).cells); }
    const after = run.at(i);
    for (const p of run.g.inputs) M.setToggle(p.x, p.y, !!run.inputsAt(i)[p.name]);
    steps.index = i;
    steps.stale = false;
    const frames = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, after.ticks));
    steps.anim = { i, ticks: after.ticks, frames, frame: 0, done: 0, cells: after.cells, timer: 0 };
    steps.anim.timer = requestAnimationFrame(animFrame);
    shown();
}
function animFrame() {
    const an = steps && steps.anim;
    if (!an) return;
    an.frame++;
    const want = Math.round(an.ticks * an.frame / an.frames);
    while (an.done < want) { M.stepSimulation(); an.done++; }
    if (an.frame >= an.frames) { finishAnim(); return; }
    labelPads(steps.level, steps.run.inputsAt(an.i), readOutputs(steps.level), null);
    an.timer = requestAnimationFrame(animFrame);
}
// The step played out: the board as it settled (or, never settling, as
// it was when the run stopped looking).
function finishAnim() {
    const an = steps.anim;
    cancelAnimationFrame(an.timer);
    steps.anim = null;
    M.setCharges(an.cells);
    shown();
}
function stopAnim() {
    if (!steps || !steps.anim) return;
    cancelAnimationFrame(steps.anim.timer);
    steps.anim = null;
}
function shown() {
    relabel();
    V.drawGrid();
    renderStatus();
    syncTable();
}

function stepOn() {
    if (!steps) return;
    if (steps.anim) { finishAnim(); return; }
    if (steps.index < steps.run.total - 1) play(steps.index + 1);
}
function stepBack() {
    if (!steps) return;
    const i = steps.anim ? steps.anim.i : steps.index;
    if (i > -1) show(i - 1);
}
function goToStep(i) {
    if (steps) show(i);
}

// The pads: inputs as set, outputs as they came out — judged, once the
// step has settled and is known.
function relabel() {
    const i = steps.index, level = steps.level, c = steps.anim || steps.stale ? null : caseAt(i);
    labelPads(level, steps.run.inputsAt(i), c ? c.got : readOutputs(level), c ? c.expected : null);
}

// ---- The status line --------------------------------------------------------
const bitList = (names, vals) => names.map((n) => `${n}=${vals[n] & 1}`).join(' ');
// What changed coming into step i: each input that went on (↑) or off (↓).
function changes(i) {
    const run = steps.run, was = run.inputsAt(i - 1), now = run.inputsAt(i);
    const moved = steps.level.inputs.filter((n) => (was[n] & 1) !== (now[n] & 1)).map((n) => `<b>${n}</b>${now[n] ? '↑' : '↓'}`);
    return moved.length ? moved.join(' ') : 'no input changes';
}
function outcome(c) {
    const level = steps.level;
    // Not settling before anything is judged is still waking up (G's stepOk).
    if (!c.settled && c.ok) return 'still changing: it woke up that way, and nothing is judged until something is stored — the clock that stores something should settle it';
    if (!c.settled) return 'it never settles — something keeps changing';
    const wrong = level.outputs.filter((o) => c.expected[o] != null && (c.expected[o] & 1) !== (c.got[o] & 1));
    if (wrong.length) return wrong.map((o) => `<b>${o}</b> should be ${c.expected[o] & 1}, got ${c.got[o] & 1} <span class="mark-bad">✗</span>`).join('; ');
    const judged = level.outputs.some((o) => c.expected[o] != null);
    return `<span class="bits">${bitList(level.outputs, c.got)}</span>${judged ? ' <span class="mark-ok">✓</span>' : ' (not judged: nothing stored yet)'}`;
}
function stepsHtml() {
    const s = steps, n = s.run.total, i = s.index;
    const back = `<button class="tool-btn step-nav" data-act="step-back" title="Back a step (←)" aria-label="Back a step"${i < 0 && !s.anim ? ' disabled' : ''}>&#x25C0;</button>`;
    const on = `<button class="tool-btn step-nav" data-act="step-on" title="On a step (→)" aria-label="On a step"${i >= n - 1 && !s.anim ? ' disabled' : ''}>&#x25B6;</button>`;
    const label = i < 0 ? 'Start' : `Step ${i + 1} of ${n}`;
    const cur = i < 0 || s.anim || s.stale ? null : caseAt(i);
    let text;
    if (i < 0) {
        text = s.run.primed
            ? 'Every input off, every wire charged — the start of the run Verify failed. ▶ plays step 1.'
            : 'Every input off, the board at rest. ▶ plays step 1.';
    } else if (s.anim) {
        text = `${changes(i)} → …`;
    } else if (s.stale) {
        text = `${changes(i)} — the board has changed: ◀, ▶ or a step on the bar runs it again from the start, with the change.`;
    } else {
        const c = caseAt(i);
        text = `${changes(i)} → ${outcome(c)}`;
        // The run started charged and this step is wrong: perhaps not the
        // storing, but something read that nothing drives.
        if (!c.ok && s.run.primed) text += ' — from a charged start: something read that nothing drives keeps its charge (wire every input, even a 0, to −V).';
    }
    const marks = [];
    for (let k = 0; k < n; k++) {
        const c = k === i && (s.anim || s.stale) ? null : caseAt(k);
        const cls = (c ? (c.ok ? 'ok' : 'bad') : '') + (k === i ? ' here' : '');
        marks.push(`<span class="${cls.trim()}" data-step="${k}" title="Step ${k + 1}"></span>`);
    }
    const actions = `${TABLE_BTN}<button class="tool-btn" data-act="steps-done" title="Stop stepping (Esc)">Done</button>`;
    return `<div class="status-row">${back}<span class="status-step${cur && !cur.ok ? ' bad' : ''}">${label}</span>${on}`
        + `<span class="status-text">${text}</span><span class="status-actions">${actions}</span></div>`
        + `<div class="case-bar steps">${marks.join('')}</div>`;
}

// ---- The table ----------------------------------------------------------------
// Its rows marked as the steps are: the one shown, and how each went.
function markTableRow(tr, cls) {
    tr.className = cls;
    const mark = tr.querySelector('.mark');
    if (mark) mark.textContent = cls === 'ok' ? '✓' : cls === 'bad' ? '✗' : '';
}
const TABLE_HINT = 'Truth table · click a row to try it', STEPS_HINT = 'The run · click a row to go to that step';
function syncTable() {
    if (!steps) return;
    levelTableHintEl.textContent = STEPS_HINT;
    if (tableFor !== steps.level) return;
    levelTableBodyEl.querySelectorAll('tr[data-row]').forEach((tr) => {
        const k = Number(tr.dataset.row), c = k === steps.index ? null : caseAt(k);
        markTableRow(tr, k === steps.index ? 'active' : c ? (c.ok ? 'ok' : 'bad') : '');
    });
    const cur = levelTableBodyEl.querySelector('tr.active');
    if (cur && levelTableEl.classList.contains('open')) scrollRowIntoView(cur);
}
// Back to the verdict's marks, if there is one still.
function restoreTable() {
    levelTableHintEl.textContent = TABLE_HINT;
    const marks = verifyStatus && verifyStatus.marks;
    levelTableBodyEl.querySelectorAll('tr[data-row]').forEach((tr) => markTableRow(tr, (marks && marks[Number(tr.dataset.row)]) || ''));
}

// For the e2e tests: where it is and what it shows.
function stepsState() {
    if (!steps) return null;
    const c = steps.stale ? null : caseAt(steps.index);
    return { level: steps.level.id, index: steps.index, total: steps.run.total, primed: steps.run.primed, playing: !!steps.anim, stale: steps.stale, ok: c ? c.ok : null, got: c ? c.got : null };
}

export {
    steps, enterSteps, startSteps, exitSteps, dropSteps, stepsEdited, stepOn, stepBack, goToStep, stepsHtml, stepsState,
};
