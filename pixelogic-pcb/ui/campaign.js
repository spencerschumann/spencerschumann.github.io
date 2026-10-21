// The campaign: entering a level and leaving for the sandbox, the level
// bar, the level browser, and where the app opens.

import {
    campaignBtn, hintBtn, levelBar, levelBriefEl, levelCollapseBtn, levelHintEl, levelStatusEl,
    levelTableBodyEl, levelTableEl, levelTitleEl, levelsBackdrop, levelsBtn, levelsCloseBtn, levelsListEl,
    levelsPanel, resetProgressBtn, sandboxBtn, sandboxToggleBtn, verifyBtn,
} from './page.js';
import {
    applyPinLabels,
} from './prefs.js';
import {
    cancelSave, flushSave, persistCircuit, resetHistory, scheduleViewSave,
} from './history.js';
import {
    MATERIALS, drawMode, setDrawMode, toolAllowed,
} from './tools.js';
import {
    availableParts, dropPart, placingPart, placingPartValid,
} from './parts.js';
import {
    updateZoomLabel,
} from './canvas.js';
import {
    setMenuOpen,
} from './toolbar.js';
import {
    setRunning,
} from './loop.js';
import {
    closeArray,
} from './arrayedit.js';
import {
    closeMakePart, forgetMemories, partEditing,
} from './makepart.js';
import {
    ask,
} from './ask.js';
import {
    openReport, scopeHeight, startTiming,
} from './scope.js';
import {
    abortReplay, closeTable, doVerify, forgetVerdict, openTable, probeRow, renderStatus, setGuide,
} from './verdict.js';
import {
    exitSteps, goToStep, startSteps, stepBack, stepOn, steps,
} from './steps.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const S = window.PixelogicStorage;
const G = window.PixelogicGame;

// The active campaign level, or null in the sandbox. Almost everything
// about the editor is unchanged inside a level; what differs is where the
// circuit is saved, that the board is a fixed size with locked I/O pads,
// and that there is something to verify against.
let gameLevel = null;
let gameProgress = G.loadProgress();

let levelBarCollapsed = S.getJSON(S.KEYS.levelBar, false) === true;

// The level bar floats over the canvas, so the view has to know how much
// of the foot it hides. Called whenever the bar appears, collapses, or
// opens its hint. The truth table popover sits on top of the bar and
// follows it.
// The scope, when it is out, sits above the level bar (or at the bottom,
// in the sandbox), and the board is framed above the both of them.
function syncViewInset() {
    const open = gameLevel && levelBar.classList.contains('open');
    const bar = open ? levelBar.offsetHeight + 16 : 0, scope = scopeHeight();
    document.getElementById('scope').style.bottom = (open ? bar : 8) + 'px';
    const inset = scope ? (open ? bar : 8) + scope + 8 : bar;
    V.setViewInset(inset);
    if (open) levelTableEl.style.bottom = inset + 'px';
}

// The level bar's height moves when the player collapses it or opens the
// hint, and each move changes how much of the canvas is actually visible.
// (Nothing automatic moves it: the status line has a fixed height, so
// building and verifying never shift the board.) Re-frame afterwards, but only for a view
// that was already framed: if the player has zoomed in on some corner,
// yanking them back out to the whole board every time the bar twitches is
// worse than a bit of the board sitting behind it.
function reframeAfter(change) {
    const wasFramed = Math.abs(V.zoom - V.minZoom) < 1e-6;
    change();
    syncViewInset();
    if (wasFramed) V.fitToWindow(); else V.clampView();
    updateZoomLabel();
    V.drawGrid();
}

function showBoard() {
    syncViewInset();
    V.fitToWindow();
    updateZoomLabel();
    scheduleViewSave();
    V.drawGrid();
}

function enterLevel(id) {
    const level = G.getLevel(id);
    if (!level || !G.isUnlocked(id, gameProgress)) return;
    abortReplay();
    closeArray();      // an array lifted to change goes back before the board is saved
    flushSave();
    gameLevel = level;
    G.loadBoard(level, G.loadCircuit(id));
    V.setLabels(G.padLabels(level));
    showTargetRect(level);
    gameProgress.current = id;
    gameProgress.mode = 'campaign';
    G.saveProgress(gameProgress);
    resetHistory();
    forgetVerdict();
    closeTable();
    setHintOpen(false);
    updateLevelBar();
    closeLevels();
    // Build tools, not Interact: you arrive at a level to draw in it.
    setDrawMode('conductor');
    // A level always runs. Only a fresh page load used to start it:
    // arriving from the sandbox, where a build tool had paused the board,
    // left it paused, and the tutorial's "click A and watch the charge
    // run" did nothing at all.
    setRunning(true);
    showBoard();
}

// The board laid out afresh for the player's slice, made since this one
// was laid (G.stackOffer): the register stood on end, D and Q level with
// each slice. What is on the board is cleared, so it asks first; the
// fresh board is saved at once, or a reload would bring the old one back.
async function relayBoard() {
    const level = gameLevel, offer = level && G.stackOffer(level);
    if (!offer) return;
    if (!await ask(`Lay the board out afresh for your slice “${offer.name}”? Everything on it now is cleared, and that cannot be undone.`,
        { ok: 'Lay out', danger: true })) return;
    if (gameLevel !== level || !G.stackOffer(level)) return;
    abortReplay();
    closeArray();
    if (partEditing()) closeMakePart(false);
    cancelSave();
    G.applyBoard(gameLevel);
    persistCircuit();
    forgetMemories();
    V.setLabels(G.padLabels(gameLevel));
    showTargetRect(gameLevel);
    resetHistory();
    forgetVerdict();
    closeTable();
    updateLevelBar();
    showBoard();
}

// A level in stages shows its square once the first stage is done.
const packStage = (level) => !!level.pack
    && (gameProgress.reached[level.id] === 'pack' || !!gameProgress.completed[level.id]);
function showTargetRect(level) {
    V.setTargetRect(level && packStage(level) ? level.pack.rect : null);
}

function exitToSandbox() {
    abortReplay();
    closeArray();
    flushSave();
    gameLevel = null;
    forgetVerdict();
    M.setLockedCells([]);
    V.setLabels([]);
    V.setTargetRect(null);
    // `current` is kept, not cleared: it is where the Sandbox toggle
    // brings you back to.
    gameProgress.mode = 'sandbox';
    G.saveProgress(gameProgress);
    const saved = S.getText(S.KEYS.sandbox);
    if (saved) M.deserialize(saved); else M.clearGrid();
    resetHistory();
    updateLevelBar();
    closeLevels();
    setDrawMode('conductor');
    showBoard();
}

// Grey out the materials this level does not use (its `tools`), and put
// down whichever one was in hand if it is one of them.
function applyToolAvailability() {
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
        if (!MATERIALS.includes(btn.dataset.tool)) return;
        if (btn.dataset.title === undefined) btn.dataset.title = btn.title;
        const ok = toolAllowed(btn.dataset.tool);
        btn.disabled = !ok;
        btn.title = ok ? btn.dataset.title : 'Not needed in this level';
    });
    // Parts, only when there are some to put down.
    const partsBtn = document.querySelector('.tool-btn[data-tool="part"]');
    if (partsBtn) {
        if (partsBtn.dataset.title === undefined) partsBtn.dataset.title = partsBtn.title;
        const any = availableParts().length > 0;
        partsBtn.disabled = !any;
        partsBtn.title = any ? partsBtn.dataset.title
            : (gameLevel ? 'No parts yet — every level you solve becomes one for the levels after it' : 'No parts yet');
        if (!placingPartValid()) dropPart();
    }
    if (!toolAllowed(drawMode) || (drawMode === 'part' && !placingPart)) setDrawMode('conductor');
}

function updateLevelBar() {
    levelBar.classList.toggle('open', !!gameLevel);
    document.getElementById('app').classList.toggle('in-level', !!gameLevel);
    applyPinLabels();
    applyToolAvailability();
    if (!gameLevel) { closeTable(); setGuide(null); syncViewInset(); return; }
    levelTitleEl.textContent = gameLevel.subtitle
        ? `${gameLevel.title} — ${gameLevel.subtitle}` : gameLevel.title;
    levelBriefEl.textContent = gameLevel.brief;
    levelHintEl.textContent = gameLevel.hint || '';
    hintBtn.style.display = gameLevel.hint ? '' : 'none';
    renderStatus();
    applyCollapsed();
}

// Collapsing leaves the title row, the buttons and the status line, and
// hides the brief and the hint. The brief is worth reading once and then
// in the way — the board underneath is the thing — so the preference
// sticks across levels and reloads.
function applyCollapsed() {
    levelBar.classList.toggle('collapsed', levelBarCollapsed);
    levelCollapseBtn.setAttribute('aria-expanded', String(!levelBarCollapsed));
    levelCollapseBtn.innerHTML = levelBarCollapsed ? '&#x25B4;' : '&#x25BE;';
    levelCollapseBtn.title = levelBarCollapsed ? 'Show the level text (H)' : 'Minimize the level text (H)';
    syncViewInset();
}

function setCollapsed(v) {
    reframeAfter(() => {
        levelBarCollapsed = v;
        S.setJSON(S.KEYS.levelBar, v);
        applyCollapsed();
    });
}

function setHintOpen(open) {
    reframeAfter(() => {
        levelHintEl.classList.toggle('open', open);
        hintBtn.setAttribute('aria-pressed', String(open));
    });
}

// ---- Level browser ----
function renderLevels() {
    levelsListEl.innerHTML = '';
    for (const chapter of G.CHAPTERS) {
        const section = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'chapter-title';
        title.textContent = chapter.title;
        const blurb = document.createElement('div');
        blurb.className = 'chapter-blurb';
        blurb.textContent = chapter.blurb;
        section.append(title, blurb);

        const levels = G.levelsIn(chapter.id);
        if (levels.length) {
            const list = document.createElement('div');
            list.className = 'chapter-levels';
            for (const level of levels) {
                const done = !!gameProgress.completed[level.id];
                const open = G.isUnlocked(level.id, gameProgress);
                const row = document.createElement('button');
                row.className = 'level-row' + (gameLevel && gameLevel.id === level.id ? ' current' : '');
                row.disabled = !open;
                row.title = open ? level.brief : 'Solve the level before it to unlock this one';
                const status = document.createElement('span');
                status.className = 'level-status' + (done ? ' done' : '');
                status.textContent = done ? '✓' : (open ? '·' : '🔒');
                const name = document.createElement('span');
                name.className = 'level-row-title';
                name.textContent = level.title;
                const sub = document.createElement('span');
                sub.className = 'level-row-sub';
                sub.textContent = level.subtitle || '';
                row.append(status, name, sub);
                row.addEventListener('click', () => enterLevel(level.id));
                list.appendChild(row);
            }
            section.appendChild(list);
        }
        if (chapter.roadmap) {
            const strip = document.createElement('div');
            strip.className = 'roadmap';
            for (const item of chapter.roadmap) {
                const chip = document.createElement('span');
                chip.textContent = item;
                strip.appendChild(chip);
            }
            section.appendChild(strip);
        }
        levelsListEl.appendChild(section);
    }
    sandboxBtn.disabled = !gameLevel;
}

function openLevels() {
    renderLevels();
    levelsPanel.classList.add('open');
    levelsBackdrop.classList.add('open');
}
function closeLevels() {
    levelsPanel.classList.remove('open');
    levelsBackdrop.classList.remove('open');
}

// The campaign is the app; the sandbox is the side door. This flips
// between them and remembers which one you were in.
function toggleSandbox() {
    setMenuOpen(false);
    if (gameLevel) { exitToSandbox(); return; }
    const resume = gameProgress.current && G.getLevel(gameProgress.current);
    if (resume && G.isUnlocked(resume.id, gameProgress)) enterLevel(resume.id);
    else openLevels();
}

// The campaign is the app's front door. A first-time visitor lands in
// the tutorial level rather than on an empty board with a rail of tools
// and no indication of what any of it is for; a returning one lands
// wherever they left off. Returns false for the sandbox.
function resumeCampaign() {
    let resume = gameProgress.mode === 'sandbox' ? null
        : G.getLevel(gameProgress.current) || G.LEVELS[0];
    // The level you were on can be locked now, when a new one has been
    // added in front of it: go to the first open level still unsolved,
    // rather than dropping out to the sandbox.
    if (resume && !G.isUnlocked(resume.id, gameProgress)) {
        resume = G.LEVELS.find((l) => G.isUnlocked(l.id, gameProgress) && !gameProgress.completed[l.id]) || null;
    }
    if (!resume || !G.isUnlocked(resume.id, gameProgress)) return false;
    gameLevel = resume;
    gameProgress.current = resume.id;
    G.loadBoard(resume, G.loadCircuit(resume.id));
    V.setLabels(G.padLabels(resume));
    showTargetRect(resume);
    updateLevelBar();
    setRunning(true);
    return true;
}

function setupCampaign() {
    campaignBtn.addEventListener('click', () => { setMenuOpen(false); openLevels(); });
    levelsCloseBtn.addEventListener('click', closeLevels);
    levelsBackdrop.addEventListener('click', closeLevels);
    levelsBtn.addEventListener('click', openLevels);
    sandboxBtn.addEventListener('click', exitToSandbox);
    sandboxToggleBtn.addEventListener('click', toggleSandbox);
    verifyBtn.addEventListener('click', doVerify);
    // The status line's buttons are re-rendered with it, so they are
    // handled here rather than bound one by one.
    levelStatusEl.addEventListener('click', (e) => {
        // Stepping, a step on the bar is where to go.
        const seg = e.target.closest('[data-step]');
        if (seg && steps) { goToStep(Number(seg.dataset.step)); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'steps') startSteps(gameLevel);
        else if (btn.dataset.act === 'step-back') stepBack();
        else if (btn.dataset.act === 'step-on') stepOn();
        else if (btn.dataset.act === 'steps-done') exitSteps();
        else if (btn.dataset.act === 'next') enterLevel(btn.dataset.level);
        else if (btn.dataset.act === 'relay') relayBoard();
        else if (btn.dataset.act === 'timing') startTiming(gameLevel, true);
        else if (btn.dataset.act === 'table') {
            if (levelTableEl.classList.contains('open')) closeTable(); else openTable();
        }
    });
    document.getElementById('levelTableCloseBtn').addEventListener('click', closeTable);
    levelTableBodyEl.addEventListener('click', (e) => {
        // A row is that step, stepping; else it is tried by hand.
        const tr = e.target.closest('tr[data-row]');
        if (tr && steps) goToStep(Number(tr.dataset.row));
        else if (tr) probeRow(Number(tr.dataset.row));
    });
    levelCollapseBtn.addEventListener('click', () => setCollapsed(!levelBarCollapsed));
    hintBtn.addEventListener('click', () => setHintOpen(!levelHintEl.classList.contains('open')));
    resetProgressBtn.addEventListener('click', async () => {
        if (!await ask('Forget which levels are solved, and discard every level circuit and '
            + 'the parts they made? Your sandbox and your own parts are untouched.', { ok: 'Reset', danger: true })) return;
        for (const level of G.LEVELS) G.clearCircuit(level.id);
        G.clearLevelParts();
        dropPart();
        gameProgress = { completed: {}, current: null, reached: {} };
        G.saveProgress(gameProgress);
        if (gameLevel) exitToSandbox(); else renderLevels();
    });
}

export {
    gameLevel, gameProgress, levelBarCollapsed, syncViewInset, reframeAfter, showBoard, enterLevel,
    packStage, showTargetRect, exitToSandbox, applyToolAvailability, updateLevelBar, applyCollapsed,
    setCollapsed, setHintOpen, renderLevels, openLevels, closeLevels, toggleSandbox, resumeCampaign,
    setupCampaign,
};
