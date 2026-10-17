// The tool in hand: which one it is, picking it, and what changes with it.

import {
    flashStatus,
} from './page.js';
import {
    applyGridVisibleForMode,
} from './prefs.js';
import {
    clipboard, commitPasteFloat, enterPasteFloat, floatBase, selection,
} from './clipboard.js';
import {
    arrange, arrangeSel, commitArrange, setArrangeSel,
} from './arrange.js';
import {
    refreshStampPreview, turnStamp,
} from './stamp.js';
import {
    openComponents, placingPartValid,
} from './parts.js';
import {
    arrayEditTool, arrayEditing, closeArray, updateHandBar,
} from './arrayedit.js';
import {
    updateActionButtons,
} from './toolbar.js';
import {
    setRunning,
} from './loop.js';
import {
    gameLevel,
} from './campaign.js';

const V = window.PixelogicView;

// drawMode is a material ('conductor', 'insulator' — Erase — 'mux' —
// MUX — 'pos', 'neg', 'led', 'toggle', 'switch'), 'part' (Parts: puts
// down a whole part from the shelf) or a mode ('interact', 'select',
// 'rearrange', 'probe' — clips the scope's probes on — 'paste'). The paint tools are the materials a stroke lays
// cell by cell; MUX and Parts are not among them, since each places a
// whole thing per click.
const PAINT_TOOLS = ['conductor', 'insulator', 'pos', 'neg', 'led', 'toggle', 'switch'];
const MATERIALS = PAINT_TOOLS.concat(['mux']);
// A level may allow only some materials (`tools` in game.js); the rest
// are disabled while it is open. Modes (Select, Rearrange...) are never
// restricted.
const toolAllowed = (tool) => !gameLevel || !gameLevel.tools
    || !MATERIALS.includes(tool) || gameLevel.tools.includes(tool);
let drawMode = 'conductor';

// A tool button or its key. Picking MUX when it is already out turns the
// next part — R's job, for a screen with no keyboard, and the same on
// the 3 key so the key does what the button does.
//
// Parts is the same idea: picking it with a part already in hand puts
// that part down again; picking it while it is out — or with nothing in
// hand — opens the shelf to choose one.
function pickTool(mode) {
    if (mode === 'mux' && drawMode === 'mux') turnStamp();
    else if (mode === 'part' && (drawMode === 'part' || !placingPartValid())) openComponents();
    else setDrawMode(mode);
}

function setDrawMode(mode) {
    if (!toolAllowed(mode)) { flashStatus('Not needed in this level'); return; }
    // Copies of a part set out on the board are the tool's they were set
    // out with (Parts, or Rearrange for an array lifted to change): another
    // tool puts them away, as Cancel does.
    if (arrayEditing() && mode !== arrayEditTool()) closeArray();
    // Leaving Paste while a clip is still floating commits it in place.
    if (floatBase && mode !== 'paste') commitPasteFloat();
    // A tool switch mid-drag (keyboard) drops the grabbed object where
    // it is; leaving Rearrange also clears its highlight.
    if (arrange) commitArrange();
    if (mode !== 'rearrange' && arrangeSel.length) setArrangeSel([]);
    drawMode = mode;
    updateHandBar();
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        const on = btn.dataset.tool === mode;
        btn.classList.toggle('selected', on);
        // The rail scrolls (sideways on a phone, vertically in the wide
        // rail on a short screen), so a tool picked by keyboard could
        // otherwise become the active one while sitting off-screen.
        if (on) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    // The overlay only shows state relevant to the active tool: the
    // selection highlight in Select and Paste (the floating clip). The
    // selection itself survives tool switches (Ctrl+C still works),
    // only its highlight goes away.
    if (mode === 'paste' && clipboard) {
        enterPasteFloat(); // pastes immediately and selects/highlights it
    } else {
        V.setSelection(mode === 'select' ? selection : null);
    }
    // In the sandbox, build modes pause the simulation and Interact
    // resumes it. In a level the simulation just runs, whatever tool is
    // held: you want to see charge move into the piece you have only half
    // finished, and having a tool change quietly stop the board was the
    // single most confusing thing about building in one. Play/pause still
    // works by hand, for when you want to freeze a state and look at it.
    // Probing is watching it run: Probe runs it too.
    if (!gameLevel) setRunning(mode === 'interact' || mode === 'probe');
    applyGridVisibleForMode(mode);
    refreshStampPreview();
    // Rotate's target and the floating action bar both depend on the
    // mode, not just on the selection, so they have to be re-evaluated
    // on every tool switch.
    updateActionButtons();
    V.drawGrid();
}

export {
    PAINT_TOOLS, MATERIALS, toolAllowed, drawMode, pickTool, setDrawMode,
};
