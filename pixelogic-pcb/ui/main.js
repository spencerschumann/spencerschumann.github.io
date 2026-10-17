// The editor's entry point: sets everything up once the page is ready.
// Each ui/ module owns one part of the editor and imports what it uses from
// the others; see ARCHITECTURE.md.

import {
    applyGridVisibleForMode, applyPinLabels,
} from './prefs.js';
import {
    loadView,
} from './history.js';
import {
    drawMode,
} from './tools.js';
import {
    clipboard, floatBase, floatPos,
} from './clipboard.js';
import {
    arrangeSel,
} from './arrange.js';
import {
    placingPart,
} from './parts.js';
import {
    loadMemories, partEditState,
} from './makepart.js';
import {
    arrayEditState,
} from './arrayedit.js';
import {
    setupCanvasEvents, updateZoomLabel,
} from './canvas.js';
import {
    setupToolbar, updateActionButtons,
} from './toolbar.js';
import {
    tickLoop,
} from './loop.js';
import {
    gameLevel, resumeCampaign, setupCampaign, syncViewInset,
} from './campaign.js';
import {
    setupAsk,
} from './ask.js';
import {
    loadProbes, scopeState, setupScope,
} from './scope.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const S = window.PixelogicStorage;
const G = window.PixelogicGame;

function init() {
    G.startVerifier();      // loads in the background, ready by the first Verify
    setupAsk();
    setupScope();
    setupToolbar();
    setupCanvasEvents();
    setupCampaign();
    const resumed = resumeCampaign();
    loadMemories();         // a change part way through, before a reload
    loadProbes();
    if (!resumed) {
        const saved = S.getText(S.KEYS.sandbox);
        if (saved) M.deserialize(saved);
    }
    applyGridVisibleForMode(drawMode);
    applyPinLabels();
    V.resizeCanvas();
    // A restored viewport belongs to whichever board was on screen; after
    // resuming into a level, fit that level's board instead.
    syncViewInset();
    if (gameLevel || !loadView()) V.fitToWindow();
    else V.clampView();     // a saved sandbox view predates these limits
    updateZoomLabel();
    updateActionButtons();
    V.drawGrid();
    requestAnimationFrame(tickLoop);
}

document.addEventListener('DOMContentLoaded', init);

// Minimal read-only hook for e2e tests: a floating paste's rectangle
// isn't otherwise observable from outside (its landing spot depends on
// cursor hover / viewport size), so tests need this to find where to
// grab it and drag it into place.
window.PixelogicUI = {
    getFloatRect() { return floatBase ? { x0: floatPos.x, y0: floatPos.y, w: clipboard.w, h: clipboard.h } : null; },
    // Rearrange's selection isn't observable from the DOM, so tests need
    // this to assert what a band/modifier-click actually picked up.
    getArrangeSelection() { return arrangeSel.map((o) => o.cells.map(([x, y]) => [x, y])); },
    // The part the Parts tool has in hand, by key.
    getPlacingPart() { return placingPart ? placingPart.key : null; },
    // ...and what it is: its name, size, how many copies, its pins' faces.
    getHand() {
        return placingPart ? {
            key: placingPart.key, name: placingPart.name, w: placingPart.clip.w, h: placingPart.clip.h,
            count: placingPart.array ? placingPart.array.count : 1, apart: !!(placingPart.array && placingPart.array.apart),
            parts: placingPart.parts ? placingPart.parts.length : 1,
            pins: placingPart.pins.map((q) => ({ name: q.name, face: q.face })),
        } : null;
    },
    // What Make part… has, while it is open on the board: its bounds,
    // terminals, pins, what is wrong, and where the tags and arrows are.
    getPartEdit() { return partEditState(); },
    // A part's copies, while they are set out on the board: which way, how
    // far, how many, where each copy is, what each pin is, where the tags are.
    getArrayEdit() { return arrayEditState(); },
    // The scope: its probes, what it has captured, what it shows, and the
    // timing report.
    getScope() { return scopeState(); },
};

export {
    init,
};
