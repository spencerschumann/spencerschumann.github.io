// Running the board: play and pause, the speed slider, and the frame loop
// that steps the simulation and keeps the level bar current.

import {
    intervalSlider, intervalValueEl, playPauseBtn,
} from './page.js';
import {
    gameLevel,
} from './campaign.js';
import {
    probe, renderStatus, replayTimer, updateProbe, verifyStatus,
} from './verdict.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
let running = false;
// Exponential so the slider gives fine control at the slow end and still
// reaches a genuinely fast rate at the top (was capped at 20 steps/s).
// The default is fast enough that a circuit visibly *runs* on first
// contact rather than creeping; the slider is there to slow it down when
// you want to watch a signal propagate.
const MIN_TPS = 1, MAX_TPS = 200, DEFAULT_TPS = 60;
let tickIntervalMs = 1000 / DEFAULT_TPS;
let lastTick = 0;

function setRunning(v) {
    running = v;
    playPauseBtn.textContent = running ? '⏸' : '▶';
    playPauseBtn.setAttribute('aria-pressed', String(running));
}

// The slider's own max is the resolution: it's fine-grained (1000 steps)
// so that a whole-number target rate like DEFAULT_TPS lands on it exactly
// instead of a step either side of it.
function updateIntervalFromSlider() {
    const v = Number(intervalSlider.value);
    const tps = MIN_TPS * Math.pow(MAX_TPS / MIN_TPS, v / Number(intervalSlider.max));
    tickIntervalMs = 1000 / tps;
    intervalValueEl.textContent = `${Math.round(tps)} tps`;
}
// The scale is exponential, so the position for a given rate is derived
// rather than hard-coded — changing DEFAULT_TPS is enough.
function sliderPosForTps(tps) {
    return Math.round(Number(intervalSlider.max) * Math.log(tps / MIN_TPS) / Math.log(MAX_TPS / MIN_TPS));
}

// A tick interval faster than one frame (~16ms at 60Hz) can't be reached by
// stepping at most once per requestAnimationFrame callback, so this steps
// in a catch-up loop, running as many ticks as the elapsed time calls for.
//
// Bounded by TIME, not by a step count. A cap of 1000 steps a frame let a
// big board, or a tab coming back from the background, spiral: each frame
// took longer than the ticks it was catching up on, so every frame ran
// the full thousand and the page froze. Past the budget the backlog is
// simply dropped — the board runs slower than asked, and stays usable.
const FRAME_BUDGET_MS = 12;
function tickLoop(now) {
    // A Verify replay drives the board itself, one tick at a time. Letting
    // this loop step it as well ran it at two rates at once, and could
    // make an oscillating board look settled to the replay's check.
    if (running && !replayTimer) {
        const deadline = performance.now() + FRAME_BUDGET_MS;
        let steps = 0;
        while (now - lastTick >= tickIntervalMs) {
            lastTick += tickIntervalMs;
            M.stepSimulation();
            steps++;
            if (performance.now() > deadline) { lastTick = now; break; }
        }
        if (steps > 0) V.drawGrid();
        if (steps > 0 && probe) updateProbe();
    } else {
        lastTick = now;
    }
    // Some coach steps are about what the circuit DOES (the lamp lights),
    // not what is drawn, so the coach is re-checked as the board runs,
    // not only after edits.
    if (gameLevel && !verifyStatus && now - lastCoachCheck > 250) {
        lastCoachCheck = now;
        renderStatus();
    }
    requestAnimationFrame(tickLoop);
}
let lastCoachCheck = 0;

export {
    running, MIN_TPS, MAX_TPS, DEFAULT_TPS, tickIntervalMs, lastTick, setRunning, updateIntervalFromSlider,
    sliderPosForTps, FRAME_BUDGET_MS, tickLoop, lastCoachCheck,
};
