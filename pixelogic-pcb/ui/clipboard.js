// The Select tool's region, copy, cut and delete, the floating paste, and
// turning or flipping a region or a clip.

import {
    flashStatus,
} from './page.js';
import {
    afterEdit, applyExpansion, beginUndoBatch, endUndoBatch, restoreEntry, undoStack,
} from './history.js';
import {
    drawMode, setDrawMode,
} from './tools.js';
import {
    abortArrange, arrange, arrangeSel, mirrorArrangeSelected, rotateArrangeSelected, setArrangeSel,
} from './arrange.js';
import {
    mirrorStamp, turnStamp,
} from './stamp.js';
import {
    turnPart,
} from './parts.js';
import {
    lastHoveredCell,
} from './canvas.js';
import {
    updateActionButtons,
} from './toolbar.js';
import {
    gameLevel,
} from './campaign.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
// What a press on the board does from there — a stroke, a drag, a band —
// is a gesture's, and keeps its own state (see Gestures).
let selection = null;   // {x0,y0,x1,y1} normalized, or null
let clipboard = null;   // {w,h,data:Uint8Array} or null
// A pasted clip floats (draggable, not yet a permanent edit) from the
// moment Paste is selected until it's committed - see enterPasteFloat.
let floatBase = null;   // structural snapshot from just before the float started, or null when not floating
let floatPos = null;    // {x,y} - the floating clip's current top-left

// ---- Selection / clipboard ----
function setSelection(sel) {
    selection = sel;
    V.setSelection((drawMode === 'select' || drawMode === 'paste') ? selection : null);
    updateActionButtons();
}

function doCopy() {
    if (!selection) return;
    clipboard = M.copyRegion(selection.x0, selection.y0, selection.x1, selection.y1);
    updateActionButtons();
    flashStatus('Copied');
}
function deleteSelectionCells() {
    if (!selection) return;
    beginUndoBatch();
    M.clearRegion(selection.x0, selection.y0, selection.x1, selection.y1);
    endUndoBatch();
    afterEdit();
}
// Deletes whatever the current tool shows as selected: the region in
// Select, the picked objects in Rearrange, the floating clip in Paste
// (which is simply discarded). Returns false when nothing is.
//
// A region left over from Select is deliberately NOT deleted from any
// other tool. Its highlight is hidden there, and Delete used to erase it
// anyway — while in Rearrange, with objects plainly selected, it offered
// to clear the whole grid instead.
function deleteSelected() {
    if (drawMode === 'paste' && floatBase) { cancelPasteFloat(); return true; }
    if (drawMode === 'rearrange' && arrangeSel.length) {
        if (arrange) abortArrange();
        const flat = [];
        for (const o of arrangeSel) for (const c of o.cells) flat.push(c);
        beginUndoBatch();
        M.clearCells(flat);
        endUndoBatch();
        setArrangeSel([]);
        afterEdit();
        return true;
    }
    if (drawMode === 'select' && selection) { deleteSelectionCells(); return true; }
    return false;
}
function doCut() {
    if (!selection) return;
    doCopy();
    deleteSelectionCells();
}
// ---- Floating paste ----
// Selecting Paste stamps the clip right away, at the viewport center (or
// under the cursor, if it's already hovering the grid), and leaves it
// "floating": draggable, and not yet a permanent edit. Each drag redraws
// it at the new spot by restoring the pre-float snapshot and re-pasting,
// rather than mutating the grid incrementally, so the whole float —
// however many times it gets dragged — collapses into the single undo
// step opened by beginUndoBatch here. It becomes permanent (and the grid
// auto-expands if it landed on an edge) when the tool changes or the user
// taps outside it on the canvas.
function viewportCenterAnchor() {
    const c = V.screenToCell(V.width / 2, V.height / 2);
    return {
        x: Math.max(0, Math.min(Math.max(0, M.GRID_W - clipboard.w), c.x - Math.floor(clipboard.w / 2))),
        y: Math.max(0, Math.min(Math.max(0, M.GRID_H - clipboard.h), c.y - Math.floor(clipboard.h / 2))),
    };
}
// If dragging the float grew the grid (applyExpansion), floatBase — the
// pre-float snapshot the next stampFloat will restore — has to grow and
// shift the same way, or the next restore would shrink the grid back
// down and undo the expansion. The model does the copy, so the ratsnest
// in the snapshot is re-addressed too rather than dropped.
function expandFloatBase(g) {
    if (!g.left && !g.top && !g.right && !g.bottom) return;
    floatBase = M.growSnapshot(floatBase, g);
    floatPos = { x: floatPos.x + g.left, y: floatPos.y + g.top };
}
function stampFloat() {
    M.restoreStructuralSnapshot(floatBase);
    M.pasteRegion(clipboard, floatPos.x, floatPos.y, { replace: true }); // may clip against the not-yet-grown grid
    // Grow the grid immediately if the float reaches the border — waiting
    // until commit is too late, the grid would already be back to this
    // size by the next stampFloat. Then re-paste: growing just now may
    // have made room for the part the first paste above had to clip off.
    expandFloatBase(applyExpansion());
    M.pasteRegion(clipboard, floatPos.x, floatPos.y, { replace: true });
    setSelection({
        x0: floatPos.x, y0: floatPos.y,
        x1: Math.min(M.GRID_W - 1, floatPos.x + clipboard.w - 1),
        y1: Math.min(M.GRID_H - 1, floatPos.y + clipboard.h - 1),
    });
    V.drawGrid();
}
function enterPasteFloat() {
    if (!clipboard) return;
    beginUndoBatch();
    floatBase = undoStack[undoStack.length - 1].snap;
    floatPos = (lastHoveredCell && M.inBounds(lastHoveredCell.x, lastHoveredCell.y))
        ? { x: lastHoveredCell.x, y: lastHoveredCell.y } : viewportCenterAnchor();
    stampFloat();
}
// stampFloat already keeps the grid size, floatBase, and selection in
// sync on every move (including the last one before this runs), so
// there's nothing left to reconcile here.
function commitPasteFloat() {
    if (!floatBase) return;
    endUndoBatch();
    floatBase = null;
    afterEdit();
}
// Discard the floating clip instead (Escape, Delete, or undo mid-float):
// put the board back as it was and drop the undo step the float opened.
// The clipboard is kept, so V brings it straight back.
function cancelPasteFloat() {
    if (!floatBase) return;
    M.restoreStructuralSnapshot(floatBase);
    endUndoBatch();
    undoStack.pop();
    floatBase = null;
    setSelection(null);
    setDrawMode('select');
    afterEdit();
}
// Dragging the floating clip from where it was grabbed (Paste, pressed
// on the clip). If the float is dropped or cancelled mid-drag (a key),
// the rest of the drag does nothing.
function floatGesture(c) {
    const start = { cellX: c.x, cellY: c.y, origX: floatPos.x, origY: floatPos.y };
    return {
        move({ c: p }) {
            if (!floatBase) return;
            const nx = start.origX + (p.x - start.cellX), ny = start.origY + (p.y - start.cellY);
            if (nx === floatPos.x && ny === floatPos.y) return;
            floatPos = { x: nx, y: ny };
            stampFloat();
        },
        end() { }, abort() { },
    };
}

// Quarter turn / left-right flip of a clip's own data, for transforming a
// paste while it is still floating.
// (The model does it, so any parts in the clip turn with it.)
const rotateClip = (c) => M.rotateClipCW(c);
const mirrorClip = (c) => M.mirrorClipH(c);

function doRotate() {
    if (drawMode === 'rearrange') { rotateArrangeSelected(); return; }
    // With the MUX tool out, R turns the part the next click places.
    if (drawMode === 'mux') { turnStamp(); return; }
    if (drawMode === 'part') { turnPart(false); return; }
    // A floating paste turns the CLIP. Turning the stamped cells, as this
    // used to, lasted only until the next drag restamped the clip as it
    // was.
    if (drawMode === 'paste' && floatBase) { clipboard = rotateClip(clipboard); stampFloat(); return; }
    // Only a region you can see: from any other tool the Select region is
    // hidden, and R used to turn it anyway.
    if (drawMode !== 'select' || !selection) return;
    beginUndoBatch();
    // Turned, a region reaches h across and w down from its corner. The
    // sandbox grows to make room, as it does for any edit at its edge;
    // a level's board is a fixed size.
    const s = selection, w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1;
    if (!gameLevel) M.growTo(s.x0 + h + 1, s.y0 + w + 1);
    const r = M.rotateRegionCW(s.x0, s.y0, s.x1, s.y1);
    endUndoBatch();
    if (!r) {
        restoreEntry(undoStack.pop()); // takes back any growth, too
        updateActionButtons();
        V.drawGrid();
        flashStatus('No room to rotate — it would turn onto something');
        return;
    }
    applyExpansion();
    setSelection(r);
    afterEdit();
}
function doMirror() {
    // With the MUX tool out, M flips the part the next click places.
    if (drawMode === 'mux') { mirrorStamp(); return; }
    if (drawMode === 'paste' && floatBase) { clipboard = mirrorClip(clipboard); stampFloat(); return; }
    if (drawMode === 'part') { turnPart(true); return; }
    if (drawMode === 'rearrange') { mirrorArrangeSelected(); return; }
    if (drawMode !== 'select' || !selection) return;   // only a region you can see
    beginUndoBatch();
    const ok = M.mirrorRegionH(selection.x0, selection.y0, selection.x1, selection.y1);
    endUndoBatch();
    if (!ok) {
        undoStack.pop();
        updateActionButtons();
        flashStatus('Can’t mirror across a fixed pad');
        return;
    }
    afterEdit();
}

export {
    selection, clipboard, floatBase, floatPos, setSelection, doCopy, deleteSelectionCells, deleteSelected,
    doCut, viewportCenterAnchor, expandFloatBase, stampFloat, enterPasteFloat, commitPasteFloat,
    cancelPasteFloat, floatGesture, rotateClip, mirrorClip, doRotate, doMirror,
};
