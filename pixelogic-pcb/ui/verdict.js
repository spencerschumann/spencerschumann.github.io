// A level's status line: the coach, Verify and its replay, the truth
// table, and trying a row by hand.

import {
    levelBar, levelStatusEl, levelTableBodyEl, levelTableEl,
} from './page.js';
import {
    gameLevel, gameProgress, packStage, showTargetRect,
} from './campaign.js';
import {
    forgetTiming, startTiming, timingButton,
} from './scope.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const G = window.PixelogicGame;

// ---- The status line ----------------------------------------------------
//
// One fixed-height line under the brief says what to do now: the next
// step of the level's coach (see game.js), or — once Verify has run — how
// it went, with a thin bar marking each test case off as the replay plays
// it. It replaced a numbered list of every step plus a truth table that
// grew under it, which buried the board in text and, because the bar
// changed height, re-framed the board several times per Verify.
//
// `verifyStatus` is the last Verify while it is still current, or null.
// Editing the board makes a verdict stale, and the line goes back to the
// coach. While the tests are still running (off the page's thread) it is
// {level, checking: true}.
let verifyStatus = null;   // {level, result, marks:[], index, done, shelved}
let lastStatusHtml = '';

const bits = (names, vals) => `<span class="bits">${names.map((n) => `${n}=${vals[n] & 1}`).join(' ')}</span>`;

// Segments for the bar: 'done'/'ok', 'bad', 'active' or '' (not reached).
const caseBar = (marks) => `<div class="case-bar">${marks.map((m) => `<span class="${m}"></span>`).join('')}</div>`;

function nextLevelButton(level) {
    const next = G.nextLevel(level.id);
    return next ? `<button class="tool-btn primary" data-act="next" data-level="${next.id}">Next: ${next.title} →</button>` : '';
}

// `c` is the level's coachState, or null for a level without a coach.
// The truth table is always a click away — before a Verify too, when
// it is the level's spec, with any row there to try by hand.
const TABLE_BTN = '<button class="tool-btn" data-act="table">Table</button>';
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function coachHtml(level, c) {
    if (c && c.index < c.total) {
        const marks = [];
        for (let i = 0; i < c.total; i++) marks.push(i < c.index ? 'done' : i === c.index ? 'active' : '');
        return `<div class="status-row"><span class="status-step">Step ${c.index + 1} of ${c.total}</span>`
            + `<span class="status-text">${c.text}</span>`
            + `<span class="status-actions">${TABLE_BTN}</span></div>${caseBar(marks)}`;
    }
    if (gameProgress.completed[level.id]) {
        const next = G.nextLevel(level.id);
        return `<div class="status-row"><span class="level-done">✓ Solved</span>`
            + `<span class="status-text">${next ? 'On to the next one when you are ready.'
                : 'That is the last level built so far.'}</span>`
            + `<span class="status-actions">${nextLevelButton(level)}${TABLE_BTN}</span></div>`;
    }
    // A slice made since the board was laid: it can be laid out for it.
    const offer = G.stackOffer(level);
    if (offer) {
        return `<div class="status-row"><span class="status-text">Your part <b>${escapeHtml(offer.name)}</b> stacks — lay the board out for it, its pads level with each slice?</span>`
            + `<span class="status-actions"><button class="tool-btn primary" data-act="relay">Lay out</button>${TABLE_BTN}</span></div>`;
    }
    const idle = packStage(level) ? level.pack.text : 'Build it, then press <b>Verify</b> to test it.';
    return `<div class="status-row"><span class="status-text">${c ? c.text : idle}</span>`
        + `<span class="status-actions">${TABLE_BTN}</span></div>`;
}

function verifyHtml(s) {
    if (s.checking) {
        return `<div class="status-row"><span class="status-text">Checking every ${s.level.sequential ? 'step' : 'case'}…</span>`
            + `<span class="status-actions">${TABLE_BTN}</span></div>`;
    }
    const level = s.level, result = s.result, n = result.cases.length;
    const unit = level.sequential ? 'step' : 'case';
    const tableBtn = TABLE_BTN;
    let row;
    if (!s.done) {
        // While a case runs, its inputs; once it has settled, what came
        // out — so a case whose answer is "nothing lights" still visibly
        // happens, instead of flashing past looking like no case at all.
        const c = result.cases[Math.max(0, s.index)];
        const shown = s.shown && s.shown.index === s.index ? s.shown : null;
        const outcome = shown
            ? ' → ' + level.outputs.map((o) => `<b>${o}=${shown.got[o]}</b>`).join(' ')
                + (shown.ok ? ' <span class="mark-ok">✓</span>' : ' <span class="mark-bad">✗</span>')
            : '…';
        row = `<span class="status-text">${level.sequential ? 'Step' : 'Case'} ${s.index + 1} of ${n}: `
            + `${bits(level.inputs, c.inputs)}${outcome}</span>`
            + `<span class="status-actions">${tableBtn}</span>`;
    } else if (result.passed && s.verdict && !s.verdict.solved) {
        // Right answers, and something still wanted: fewer muxes, or
        // the circuit packed into its square.
        row = `<span class="result-partial">✓ It works</span>`
            + `<span class="status-text">${s.firstPack ? level.pack.text.replace(/^It works\. /, '') : s.verdict.why}</span>`
            + `<span class="status-actions">${tableBtn}</span>`;
    } else if (result.passed) {
        // A packed level says how it came out — stacked, how often it
        // repeats — and the record.
        const core = s.verdict && s.verdict.core, per = s.verdict && s.verdict.period;
        const rec = level.pack && level.pack.record;
        const packed = !core ? '' : (() => {
            const w = core.x1 - core.x0 + 1, h = core.y1 - core.y0 + 1;
            const size = ` Packed into ${w}×${h}${per ? `, it repeats every ${per} rows stacked` : ''}`;
            if (!rec || !per) return size + '.';
            return per <= rec ? `${size} — as good as the best known.` : `${size}; the best known repeats every ${rec}.`;
        })();
        row = `<span class="result-pass">✓ Solved</span>`
            + `<span class="status-text">All ${n} ${unit}s pass${!s.shelved ? ''
                : s.shelved.compact ? `; it is the <b>${s.shelved.name}</b> part now`
                    : `; it is the <b>${s.shelved.name}</b> part now, a large one — `
                    + `${s.shelved.why.charAt(0).toLowerCase() + s.shelved.why.slice(1)}`}.${packed}</span>`
            + `<span class="status-actions">${nextLevelButton(level)}${timingButton(level)}${tableBtn}</span>`;
    } else {
        const f = result.failure;
        // In a storage level the inputs alone say nothing — the same
        // vector legitimately gives different answers at different points
        // in the run — so the step number is what locates the fault.
        const where = f.step === undefined
            ? bits(level.inputs, f.inputs)
            : `step ${f.step + 1} of ${n} (${bits(level.inputs, f.inputs)})`;
        const wrong = level.outputs.filter((o) => f.expected[o] != null && (f.expected[o] & 1) !== (f.actual[o] & 1))
            .map((o) => `<b>${o}</b> should be ${f.expected[o] & 1}, got ${f.actual[o] & 1}`).join('; ');
        const why = f.settled ? wrong : 'it never settles — something keeps changing';
        // Passing from rest and not from a charged start: something it
        // reads is driven by nothing — or, storing, it leaned on waking up
        // holding 0 (see G.verify).
        const primed = !f.primed ? ''
            : f.step !== undefined
                ? ' — starting from a charged board. What it holds before anything is stored could be anything, and it has to '
                + 'work from there; or something it reads is not driven: wire every input to something, even one meant to be 0 (−V)'
                : ' — with every wire starting charged. Something it reads is not driven, and holds whatever charge it last had: '
                + 'wire every input to something, even one meant to be 0 (−V)';
        row = `<span class="result-fail">✗ Not yet</span>`
            + `<span class="status-text">At ${where}: ${why}${primed}.</span>`
            + `<span class="status-actions">${tableBtn}</span>`;
    }
    return `<div class="status-row">${row}</div>${caseBar(s.marks)}`;
}

function renderStatus() {
    if (!gameLevel) { setGuide(null); return; }
    const c = verifyStatus ? null : G.coachState(gameLevel);
    // The coach's colour-by-number ghost for this step, if it has one.
    setGuide(c && c.guide);
    const html = verifyStatus ? verifyHtml(verifyStatus) : coachHtml(gameLevel, c);
    if (html === lastStatusHtml) return;   // the coach is re-checked often; don't churn the DOM
    lastStatusHtml = html;
    levelStatusEl.innerHTML = html;
}

let lastGuideKey = '';
function setGuide(g) {
    const key = g ? JSON.stringify(g) : '';
    if (key === lastGuideKey) return;
    lastGuideKey = key;
    V.setGuide(g || null);
    V.drawGrid();
}

// The pads' names on the board, and while Verify plays, their values:
// inputs as set, outputs once the case has settled — green if right, red
// if not. The board shows what the table says, where you are looking.
// With `expected` null the outputs are shown unjudged: still settling, or
// in a storage level, where one row's expected value depends on the rows
// before it. So is an output the row itself does not judge.
function labelPads(level, inputs, got, expected) {
    const COLOR_OK = '#7dffb3', COLOR_BAD = '#ff8a8a', COLOR_VALUE = '#e8e8e8';
    V.setLabels(G.padLabels(level).map((l) => {
        if (inputs && level.inputs.includes(l.text)) return Object.assign(l, { text: `${l.text}=${inputs[l.text] & 1}`, color: COLOR_VALUE });
        if (got && level.outputs.includes(l.text)) {
            if (!expected || expected[l.text] == null) return Object.assign(l, { text: `${l.text}=${got[l.text]}`, color: COLOR_VALUE });
            const ok = got[l.text] === (expected[l.text] & 1);
            return Object.assign(l, { text: `${l.text}=${got[l.text]} ${ok ? '✓' : '✗'}`, color: ok ? COLOR_OK : COLOR_BAD });
        }
        return l;
    }));
    V.drawGrid();
}

// ---- Trying a row by hand ----
// Clicking a row of the truth table sets the switches to that row and
// lets the board run toward it — from wherever it is now, so you watch
// the charge move rather than a reset. The pads show the outputs as they
// go, and once the board has stopped changing, whether they match the
// row.
let probe = null;   // {level, inputs, expected, prev, quiet}

function probeRow(i) {
    const level = gameLevel;
    if (!level || tableFor !== level || !tableRows[i]) return;
    abortReplay();
    const c = tableRows[i];
    for (const p of G.layout(level).inputs) M.setToggle(p.x, p.y, !!c.inputs[p.name]);
    probe = { level, row: i, inputs: c.inputs, expected: level.sequential ? null : c.expected, prev: null, quiet: 0 };
    levelTableBodyEl.querySelectorAll('tr.picked').forEach((tr) => tr.classList.remove('picked'));
    const tr = levelTableBodyEl.querySelector(`tr[data-row="${i}"]`);
    if (tr) tr.classList.add('picked');
    labelPads(level, c.inputs, readOutputs(level), null);
}

function readOutputs(level) {
    const got = {};
    for (const p of G.layout(level).outputs) got[p.name] = M.ledIsOn(M.getCell(p.x, p.y)) ? 1 : 0;
    return got;
}

// Called after each batch of simulation steps while a probe is live.
function updateProbe() {
    const cur = M.copyCells(), prev = probe.prev;
    let same = !!prev;
    if (same) for (let i = 0; i < cur.length; i++) if (cur[i] !== prev[i]) { same = false; break; }
    probe.prev = cur;
    probe.quiet = same ? probe.quiet + 1 : 0;
    const settled = probe.quiet >= 2;
    const got = readOutputs(probe.level);
    labelPads(probe.level, probe.inputs, got, settled ? probe.expected : null);
    if (!settled) return;
    // Mark the row too, so a table tried row by row fills itself in.
    if (probe.expected) {
        const ok = probe.level.outputs.every((o) => got[o] === (probe.expected[o] & 1));
        const tr = levelTableBodyEl.querySelector(`tr[data-row="${probe.row}"]`);
        if (tr) {
            tr.classList.remove('ok', 'bad');
            tr.classList.add(ok ? 'ok' : 'bad');
            const mark = tr.querySelector('.mark');
            if (mark) mark.textContent = ok ? '✓' : '✗';
        }
    }
    probe = null;
}

// A new board (another level, or the sandbox): nothing said about the
// last one carries over.
function forgetVerdict() {
    verifyStatus = null;
    probe = null;
    tableFor = null;
}

// Any structural edit. A verdict describes the board it was run on, so an
// edit retires it and the line goes back to what to do next.
function boardChanged() {
    forgetTiming();
    if (!gameLevel) return;
    if (replayTimer) abortReplay();
    probe = null;
    if (verifyStatus) {
        verifyStatus = null;
        labelPads(gameLevel);
        // The table stays open — it is a thing to work from — but its
        // marks belonged to the board the verdict was run on.
        fillTable(gameLevel, G.tableCases(gameLevel));
    }
    renderStatus();
}

// ---- The truth table, on demand ----
// It floats above the level bar instead of growing it, so opening it
// covers part of the board without moving any of it.
// What the table currently shows: which level, and its rows (inputs and
// expected outputs, from the last Verify or from the level itself).
let tableFor = null, tableRows = [];
function fillTable(level, rows) {
    tableFor = level;
    tableRows = rows;
    levelTableBodyEl.innerHTML = tableHtml(level, rows);
}

function openTable() {
    if (tableFor !== gameLevel) fillTable(gameLevel, G.tableCases(gameLevel));
    levelTableEl.style.bottom = (levelBar.offsetHeight + 16) + 'px';
    levelTableEl.classList.add('open');
    const active = levelTableBodyEl.querySelector('tr.active, tr.bad, tr.picked');
    if (active) scrollRowIntoView(active);
}
function closeTable() { levelTableEl.classList.remove('open'); }

// Scrolls only the table's own box. The browser's scrollIntoView walks
// every scrollable ancestor, and the ones here are overflow:hidden
// containers of the whole app.
function scrollRowIntoView(tr) {
    const body = levelTableBodyEl, b = body.getBoundingClientRect(), r = tr.getBoundingClientRect();
    const head = body.querySelector('th');
    const top = b.top + (head ? head.getBoundingClientRect().height : 0);
    if (r.top < top) body.scrollTop -= top - r.top;
    else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom;
}

// Solving a level makes its circuit that level's part (G.makeLevelPart),
// which is how the next level gets built from it rather than by drawing
// it all again. Returns the part's name, or null.
function shelveSolution(level) {
    if (!level.part) return null;
    const res = G.makeLevelPart(level);
    return res.ok ? { name: level.part, compact: res.compact, why: res.why } : null;
}

// ---- Verify: the verdict, then the demonstration ------------------------
//
// Two passes, and the split is the point. `G.verify` decides in a few
// milliseconds; announcing that and stopping is what made this
// anticlimactic — you build a circuit and a word appears. So the verdict
// comes first (instant, and correct even if the run is interrupted), and
// then the SAME vectors are driven through the board again slowly,
// letting charge actually travel, with the status line's bar marking each
// case off as it goes.
//
// A failing run stops at the offending case and leaves the board standing
// in that state, inputs and all. That is the most useful thing it can do:
// the circuit is sitting there getting the wrong answer, and you can look
// at where the charge went.
let replayTimer = null;
// What to show if the replay is cut short (see startReplay).
let replayOnAbort = null;

function stopReplay() {
    cancelAnimationFrame(replayTimer);
    replayTimer = null;
    replayOnAbort = null;
    levelTableEl.classList.remove('running');
}
// Interrupting the performance must not interrupt the result: a touch on
// the board mid-replay jumps straight to how it ends — and one while the
// tests are still running means no show once they are in, just the end.
function abortReplay() {
    if (verifyStatus && verifyStatus.checking) verifyStatus.hurry = true;
    if (!replayTimer) return;
    const finish = replayOnAbort;
    stopReplay();
    if (finish) finish();
}

// The truth table, all rows up front: inputs, what is wanted, and a slot
// for what the board actually does, filled as the replay reaches each row.
// An output a row does not judge is a dot: anything goes there.
function tableHtml(level, cases) {
    const head = level.inputs.map((n) => `<th>${n}</th>`).join('')
        + '<th class="sep">→</th>'
        + level.outputs.map((n) => `<th>${n}</th>`).join('')
        + '<th></th>';
    const rows = cases.map((c, i) => {
        const ins = level.inputs.map((n) => `<td class="bits">${c.inputs[n] & 1}</td>`).join('');
        const outs = level.outputs.map((n) => `<td class="bits">${c.expected[n] == null ? '·' : c.expected[n] & 1}</td>`).join('');
        return `<tr data-row="${i}"><td class="idx">${level.sequential ? i + 1 : ''}</td>`
            + `${ins}<td class="sep"></td>${outs}<td class="mark"></td></tr>`;
    }).join('');
    return `<table class="result-table truth"><tr><th class="idx"></th>${head}</tr>${rows}</table>`;
}

// One case reaches a new state: its segment in the bar, its row in the
// table, and the "checking case N" text.
function markRow(i, state) {
    if (!verifyStatus) return;
    verifyStatus.marks[i] = state;
    if (state === 'active') verifyStatus.index = i;
    const tr = levelTableBodyEl.querySelector(`tr[data-row="${i}"]`);
    if (tr) {
        tr.className = state;                   // 'active' | 'ok' | 'bad'
        const mark = tr.querySelector('.mark');
        if (mark) mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : '';
        if (state !== 'ok' && levelTableEl.classList.contains('open')) scrollRowIntoView(tr);
    }
    renderStatus();
}

// How many simulation ticks to run per animation frame. Small vector sets
// get the slow, watchable version; a fifty-row table would take a minute
// at that rate, so bigger ones speed up rather than being cut short.
const replayRate = (n) => (n <= 8 ? 1 : n <= 20 ? 3 : 8);

// How long a settled case stays on screen before the next one, in frames.
// A case whose answer is "nothing lights" changes nothing on the board, so
// this pause — with the pads showing their values — is all there is to
// see; at a sixth of a second it was not visibly a case at all.
const replayHold = (n) => (n <= 8 ? 50 : n <= 20 ? 24 : 5);

// A case the verdict already knows never settles plays for this many
// frames — long enough to see the flicker — and then stops. Playing out
// the whole settle budget, at one tick a frame, made Verify look hung.
const UNSETTLED_FRAMES = 80;

function startReplay(level, result, onDone) {
    const r = G.replay(level);
    const rate = replayRate(result.cases.length);
    const holdFrames = replayHold(result.cases.length);
    let hold = 0, started = false, pending = null, caseFrames = 0;
    r.start(!!result.primed);
    levelTableEl.classList.add('running');
    replayOnAbort = () => onDone(result.passed);

    const frame = () => {
        replayTimer = requestAnimationFrame(frame);
        if (hold > 0) { hold--; return; }
        const begin = (i) => {
            r.begin(i, !!(result.cases[i] && result.cases[i].primed));
            caseFrames = 0;
            labelPads(level, r.vectorAt(i));
            markRow(i, 'active');
        };
        if (!started) { started = true; begin(0); }
        else if (pending !== null) {
            // The pause after a case is over: on to the next, or done.
            const i = pending;
            pending = null;
            if (i >= result.cases.length) { stopReplay(); onDone(true); return; }
            begin(i);
        }
        let settled = false;
        for (let i = 0; i < rate && !settled; i++) settled = r.tick();
        V.drawGrid();
        const known = result.cases[r.index];
        if (!settled && known && !known.settled && ++caseFrames >= UNSETTLED_FRAMES) settled = true;
        if (!settled) return;

        const c = result.cases[r.index];
        const got = r.outputs();
        verifyStatus.shown = { index: r.index, got, ok: !!(c && c.ok) };
        labelPads(level, r.vectorAt(r.index), got, c.expected);
        markRow(r.index, c && c.ok ? 'ok' : 'bad');
        // Stop where it went wrong, board and all — see above.
        if (c && !c.ok) { stopReplay(); onDone(false); return; }
        pending = r.index + 1;
        hold = holdFrames;
    };
    replayTimer = requestAnimationFrame(frame);
}

async function doVerify() {
    if (!gameLevel) return;
    abortReplay();
    const level = gameLevel;

    // The verdict, off-screen, on a copy of the board as it is now — and
    // off the page's thread (G.verifyOff), so the board goes on running
    // and drawing meanwhile, the line saying it is being checked. An edit,
    // or another level, before it is in makes it stale (boardChanged and
    // forgetVerdict drop `pending`), and it is thrown away.
    const pending = { level, checking: true };
    verifyStatus = pending;
    renderStatus();
    const result = await G.verifyOff(level);
    if (verifyStatus !== pending || gameLevel !== level) return;

    // A pass is final the moment the verdict is in, so it is recorded
    // now rather than when the replay finishes. It used to wait for the
    // end of the show, and touching the board, leaving the level or
    // reloading while a long table was still playing threw the pass
    // away and left the next level locked. Shelving it now also takes
    // the circuit exactly as verified, before anything else is drawn.
    // Right answers may not be all the level asks (see G.judge).
    const verdict = G.judge(level, result);
    let shelved = null, firstPack = false;
    if (result.passed && verdict.solved) {
        gameProgress.completed[level.id] = true;
        delete gameProgress.reached[level.id];
        G.saveProgress(gameProgress);
        shelved = shelveSolution(level);
        // A clocked level's timing is measured straight away, off the
        // page's thread, for the status line to offer (scope.js).
        if (level.clock) startTiming(level, false);
    } else if (result.passed && verdict.stage === 'pack') {
        // The first stage is done: the square appears, for good.
        firstPack = gameProgress.reached[level.id] !== 'pack';
        gameProgress.reached[level.id] = 'pack';
        G.saveProgress(gameProgress);
        showTargetRect(level);
        V.drawGrid();
    }

    verifyStatus = {
        level, result, shelved, verdict, firstPack, done: false, index: 0,
        marks: result.cases.map(() => ''),
    };
    fillTable(level, result.cases);
    levelTableBodyEl.scrollTop = 0;
    renderStatus();

    startReplay(level, result, (passed) => {
        // The board may have moved on by the time an interrupted replay
        // reports in; its status line is not ours to write.
        if (gameLevel !== level || !verifyStatus || verifyStatus.result !== result) return;
        // Whether it ran to the end or was cut short, mark every case up
        // to the verdict: all of them for a pass, up to the failing one
        // for a fail.
        const upTo = passed ? result.cases.length : result.cases.indexOf(result.failure) + 1;
        for (let i = 0; i < upTo; i++) markRow(i, result.cases[i].ok ? 'ok' : 'bad');
        verifyStatus.done = true;
        renderStatus();
    });
    // Touched while it was being checked: straight to how it ends.
    if (pending.hurry) abortReplay();
}

export {
    verifyStatus, lastStatusHtml, bits, caseBar, nextLevelButton, TABLE_BTN, coachHtml, verifyHtml,
    renderStatus, lastGuideKey, setGuide, labelPads, probe, probeRow, readOutputs, updateProbe,
    forgetVerdict, boardChanged, tableFor, tableRows, fillTable, openTable, closeTable, scrollRowIntoView,
    shelveSolution, replayTimer, replayOnAbort, stopReplay, abortReplay, tableHtml, markRow, replayRate,
    replayHold, UNSETTLED_FRAMES, startReplay, doVerify,
};
