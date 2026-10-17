// What every edit ends with: undo and redo (structural snapshots, one
// per gesture), the debounced autosave of whichever board is open, the
// view's save, and growing the sandbox at its edge.

import {
    cancelPasteFloat, floatBase, setSelection,
} from './clipboard.js';
import {
    abortArrange, arrange, setArrangeSel,
} from './arrange.js';
import {
    refreshStampPreview,
} from './stamp.js';
import {
    loadMemories, shiftMemories,
} from './makepart.js';
import {
    updateActionButtons,
} from './toolbar.js';
import {
    gameLevel,
} from './campaign.js';
import {
    boardChanged,
} from './verdict.js';
import {
    arrayEditing, closeArray,
} from './arrayedit.js';
import {
    loadProbes, shiftProbes,
} from './scope.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const S = window.PixelogicStorage;
const G = window.PixelogicGame;

// ---- Autosave (debounced) ----
// Every edit schedules a save, so the circuit survives reloads without a
// manual Save button; Export/Import remain for sharing between browsers.
let saveTimer = null;
// The sandbox circuit and each level's attempt are stored separately, so
// switching between them never overwrites the other. Writes go wherever
// the board currently belongs.
function persistCircuit() {
    if (gameLevel) G.saveCircuit(gameLevel.id, M.serialize());
    else S.setText(S.KEYS.sandbox, M.serialize());
}
// Every structural edit comes through here, so it is also where the
// level's status line hears that the board changed (see boardChanged).
// `quiet` saves without that: lifting a part's lid changes how the
// board looks, not what it is, and must not retire a verdict.
function scheduleSave(quiet) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persistCircuit(); saveTimer = null; }, 300);
    if (!quiet) boardChanged();
}
// Anything that swaps the board out has to land the pending write first,
// or a debounced save fires after the swap and writes the new board into
// the old board's slot.
function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    persistCircuit();
}
// ...or, when what is here is about to be replaced wholesale (a backup
// restored), drop it unwritten.
function cancelSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

// ---- View (zoom/pan) persistence ----
let viewSaveTimer = null;
function scheduleViewSave() {
    if (viewSaveTimer) clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(() => {
        S.setJSON(S.KEYS.view, { zoom: V.zoom, panX: V.panX, panY: V.panY });
        viewSaveTimer = null;
    }, 300);
}
function loadView() {
    const v = S.getJSON(S.KEYS.view, null);
    if (!v || typeof v.zoom !== 'number' || typeof v.panX !== 'number' || typeof v.panY !== 'number') return false;
    V.setZoom(v.zoom);
    V.pan(v.panX - V.panX, v.panY - V.panY);
    return true;
}

// ---- Undo / redo ----
// Snapshots hold only circuit structure (charge stripped), so running
// the simulation between edits never adds undo steps. A "batch" groups
// one continuous gesture (a whole drag-paint stroke, one paste, one
// delete) into a single step: the pre-edit snapshot is pushed when the
// batch first opens and the batch closes at the gesture's end.
const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 100;
let undoBatchOpen = false;

// How many columns/rows the grid has grown off its left and top edges
// since the app started. Cell coordinates shift by this whenever
// expandForBorder() adds space, so it's what lets an undo tell "the grid
// moved under the drawing" apart from "the user panned".
const gridOrigin = { x: 0, y: 0 };

// Each entry snapshots the circuit and that origin — NOT the pan or zoom.
// Undo used to restore the pan outright, which meant any panning or
// zooming you did after an edit was thrown away the moment you undid it:
// the view jumped, which is jarring and never what undo was asked to do.
// Recording the origin instead is enough to keep the drawing visually
// still across an undo that shrinks the grid, while leaving the view
// exactly where you put it.
function snapshotEntry() {
    return { snap: M.getStructuralSnapshot(), originX: gridOrigin.x, originY: gridOrigin.y };
}
// `from`: the board as it was before, taken earlier (an array lifted off
// the board to be set out again is not an edit until it is put down).
function beginUndoBatch(from) {
    if (undoBatchOpen) return;
    undoBatchOpen = true;
    undoStack.push(from || snapshotEntry());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateActionButtons();
}
function endUndoBatch() { undoBatchOpen = false; }

function restoreEntry(e) {
    M.restoreStructuralSnapshot(e.snap);
    // Restoring a differently-sized grid re-lays the cells at the
    // snapshot's coordinates, so shift the pan by exactly the difference
    // in origin — the drawing stays put on screen and the zoom, and any
    // panning done since, are left alone.
    const cs = M.CELL_SIZE * V.zoom;
    const dx = (gridOrigin.x - e.originX) * cs, dy = (gridOrigin.y - e.originY) * cs;
    if (dx || dy) V.pan(dx, dy);
    gridOrigin.x = e.originX;
    gridOrigin.y = e.originY;
}
// Mid-gesture, undo means "not that": roll back the drag or the floating
// paste in progress, and stop there. Popping history out from under one
// used to leave the gesture still editing the board with no undo step of
// its own — and a drag that then ended where it began popped someone
// else's step off the stack as its "no-op".
function cancelGesture() {
    if (arrange) { abortArrange(); return true; }
    if (floatBase) { cancelPasteFloat(); return true; }
    if (arrayEditing()) { closeArray(); return true; }   // copies set out: put away, an array lifted put back
    return false;
}
function undo() {
    if (cancelGesture()) return;
    if (!undoStack.length) return;
    redoStack.push(snapshotEntry());
    restoreEntry(undoStack.pop());
    endUndoBatch();
    setArrangeSel([]); // the highlighted objects may not be there anymore
    afterEdit();
}
function redo() {
    if (cancelGesture()) return;
    if (!redoStack.length) return;
    undoStack.push(snapshotEntry());
    restoreEntry(redoStack.pop());
    endUndoBatch();
    setArrangeSel([]);
    afterEdit();
}

function afterEdit() {
    updateActionButtons();
    refreshStampPreview();
    V.drawGrid();
    scheduleSave();
}

// Grow the grid if the edit touched the border, and shift the view the
// opposite way so the existing drawing stays put on screen. Returns the
// {left, top, right, bottom} added.
function applyExpansion() {
    // A campaign board is a fixed size. Growing it would slide every cell
    // — including the locked I/O pads the verifier addresses by
    // coordinate — and the bounded workspace is part of the puzzle anyway.
    if (gameLevel) return { left: 0, top: 0, right: 0, bottom: 0 };
    const g = M.expandForBorder();
    if (g.left || g.top) {
        V.compensateExpansion(g.left, g.top);
        gridOrigin.x += g.left;
        gridOrigin.y += g.top;
        shiftMemories(g.left, g.top);
        shiftProbes(g.left, g.top);
    }
    return g;
}

// Entering a level swaps the whole board: the sandbox circuit is written
// back to its own key, the level's board (a saved attempt, or a fresh one)
// is loaded with its pads locked, and the editing history starts over —
// an undo across a board swap would restore the previous level's circuit
// into this one's grid.
function resetHistory() {
    loadMemories();         // the parts being changed are the new board's
    loadProbes();           // ...and so are the probes
    undoStack.length = 0;
    redoStack.length = 0;
    endUndoBatch();
    setSelection(null);
    setArrangeSel([]);
    gridOrigin.x = 0;
    gridOrigin.y = 0;
    updateActionButtons();
}

export {
    saveTimer, persistCircuit, scheduleSave, flushSave, cancelSave, viewSaveTimer, scheduleViewSave,
    loadView, undoStack, redoStack, UNDO_LIMIT, undoBatchOpen, gridOrigin, snapshotEntry, beginUndoBatch,
    endUndoBatch, restoreEntry, cancelGesture, undo, redo, afterEdit, applyExpansion, resetHistory,
};
