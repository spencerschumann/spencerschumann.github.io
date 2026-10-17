// Painting: a stroke of a material, cell to cell, straight with Shift or
// the Straight toggle, and what a stroke does over muxes and parts.

import {
    flashStatus, straightBtn,
} from './page.js';
import {
    applyExpansion, beginUndoBatch, endUndoBatch, restoreEntry, scheduleSave, undoBatchOpen, undoStack,
} from './history.js';
import {
    updateActionButtons,
} from './toolbar.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;

// Every cell on a straight path between two cells, stepping one axis at
// a time: diagonal neighbours don't connect here, so a staircase is the
// only line that is also a wire.
function cellPath(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0);
    const out = [[x0, y0]];
    let x = x0, y = y0;
    for (let ix = 0, iy = 0; ix < dx || iy < dy;) {
        if ((0.5 + ix) / dx < (0.5 + iy) / dy) { x += sx; ix++; } else { y += sy; iy++; }
        out.push([x, y]);
    }
    return out;
}

let straightLock = false;
// The Straight toggle (L): the latched form of holding Shift, for a
// touchscreen, which has no Shift to hold.
function setStraightLock(v) {
    straightLock = v;
    straightBtn.setAttribute('aria-pressed', String(v));
}

// What a stroke of `color` actually changes along `path`. Cells already
// that color are skipped, so a stroke over existing wires neither resets
// their charge nor opens a pointless undo step, and so are locked pads,
// which no stroke may change.
//
// An eraser that touches a mux takes the whole part. A mux is one thing,
// and what a stroke through one leaves behind is not a smaller mux — it
// is inert material that looks like a part.
//
// A part is never painted into (its cells are protected, like the pads);
// see strokeParts for what a stroke over one does instead.
//
// Nothing but the eraser goes over a mux: a wire drawn into one leaves
// five cells of material that is no part at all (the model refuses it
// too). If a wire has to go there, the mux is erased or moved first —
// see strokeParts for the word that says so.
function strokeCells(path, color) {
    const todo = path.filter(([x, y]) =>
        M.inBounds(x, y) && !M.isProtected(x, y) && M.colorOfCell(M.getCell(x, y)) !== color
        && (color === 'insulator' || !M.isMuxId(M.getCell(x, y))));
    if (color !== 'insulator') return todo;
    const seen = new Set(todo.map(([x, y]) => x + ',' + y));
    for (const [x, y] of todo.slice()) {
        if (!M.isMuxId(M.getCell(x, y))) continue;
        for (const [bx, by] of M.muxBlob(x, y)) {
            if (seen.has(bx + ',' + by) || M.isProtected(bx, by)) continue;
            seen.add(bx + ',' + by);
            todo.push([bx, by]);
        }
    }
    return todo;
}

// The parts a stroke passes over. The eraser takes one whole, as it
// takes a mux; any other tool leaves it alone and says how to get in —
// once a stroke (`s.warned`). Returns whether anything was erased.
function strokeParts(path, color, s) {
    const hit = new Set();
    let edgeName = null, overMux = false;
    for (const [x, y] of path) {
        const b = M.blockAtCell(x, y);
        if (!b && color !== 'insulator' && M.isMuxId(M.getCell(x, y))) overMux = true;
        if (b) hit.add(M.topBlockOf(b));
        else if (color !== 'insulator' && M.isProtected(x, y) && !M.isLocked(x, y) && !edgeName) {
            const e = M.edgeAt(x, y).find((q) => q.cls === 'R');
            const info = e && M.blockInfo(e.id);
            edgeName = info ? info.name : 'a part';
        }
    }
    const warn = (msg) => { if (!s.warned) flashStatus(msg); s.warned = true; };
    if (edgeName && !hit.size) {
        warn(`${edgeName} keeps that cell bare — anything there would join its circuit`);
        return false;
    }
    if (overMux && !hit.size) {
        warn('That is a mux — erase it (2) or move it (Rearrange) to put something there');
        return false;
    }
    if (!hit.size) return false;
    if (color !== 'insulator') {
        warn('That is a part — double-click it to look inside, or Decap it (Rearrange) to change it');
        return false;
    }
    if (!undoBatchOpen) beginUndoBatch();
    for (const b of hit) M.removeBlock(b);
    return true;
}

// Wire the model would not put down because it would cut a part's wire
// (two terminals on either side of a corner its wire turns, say): say so,
// once a stroke.
function warnCut(todo, s) {
    if (s.warned || s.color !== 'conductor') return;
    for (const [x, y] of todo) {
        if (M.colorOfCell(M.getCell(x, y)) === 'conductor') continue;
        const b = M.cutsPartWire(x, y), info = b && M.blockInfo(b);
        if (!info) continue;
        flashStatus(`Wire there would cut ${info.name}’s wire in two: with the wire already beside it, it would make a crossing of it`);
        s.warned = true;
        return;
    }
}

// A paint stroke of `color`, from cell `c`: {color, last, line, warned}.
// `last` is its previous cell. `line`, for a straight stroke — Shift
// held, or the Straight toggle (L) on — is {x0, y0, base, end, opened,
// painted}: it runs from where it began along whichever axis the
// pointer has moved furthest on, and is redrawn from the pre-stroke
// board (`base`) on every move, so pulling back shortens it rather than
// leaving the overshoot behind.
function paintGesture(c, color, straight) {
    const s = {
        color, last: null, warned: false,
        line: straight && M.inBounds(c.x, c.y)
            ? { x0: c.x, y0: c.y, base: M.getStructuralSnapshot(), end: null, opened: false, painted: false } : null,
    };
    paintTo(s, c);
    return {
        move({ c: p }) { paintTo(s, p); },
        // A straight stroke is only a preview until it ends: grow the
        // grid and save once, on release — or, if it ended back where
        // it began with nothing drawn, drop the undo step it opened.
        end() {
            const l = s.line;
            if (!l) return;
            if (l.painted) { applyExpansion(); scheduleSave(); }
            else if (l.opened) { endUndoBatch(); undoStack.pop(); updateActionButtons(); }
            V.drawGrid();
        },
        // A second finger landing means a two-finger gesture was meant,
        // not a stroke: take back what the first finger's touchdown
        // painted (its undo step is still the open one).
        abort() {
            if (!undoBatchOpen || !undoStack.length) return;
            restoreEntry(undoStack.pop());
            V.drawGrid();
            scheduleSave();
            updateActionButtons();
        },
    };
}

function paintStraight(s, c) {
    const l = s.line;
    const horizontal = Math.abs(c.x - l.x0) >= Math.abs(c.y - l.y0);
    const end = horizontal ? [c.x, l.y0] : [l.x0, c.y];
    if (l.end && l.end[0] === end[0] && l.end[1] === end[1]) return;
    l.end = end;
    M.restoreStructuralSnapshot(l.base);
    const path = cellPath(l.x0, l.y0, end[0], end[1]);
    const opening = !undoBatchOpen;
    const erased = strokeParts(path, s.color, s);
    if (erased && opening) l.opened = true;
    const todo = strokeCells(path, s.color);
    if (todo.length) {
        if (!undoBatchOpen) { beginUndoBatch(); l.opened = true; }
        M.paintCells(todo, s.color);
        warnCut(todo, s);
    }
    l.painted = todo.length > 0 || erased;
    V.drawGrid();
}

// Paints the whole way from the stroke's previous cell to this one.
// Pointer events are samples, and a quick drag — or any drag on a
// zoomed-out board — covers several cells between two of them. Painting
// only the sampled cells left a dotted line of separate pixels, which in
// an adjacency world is not a wire at all.
function paintTo(s, c) {
    if (s.line) { paintStraight(s, c); return; }
    const from = s.last || c;
    s.last = c;
    const path = cellPath(from.x, from.y, c.x, c.y);
    const erased = strokeParts(path, s.color, s);
    const todo = strokeCells(path, s.color);
    if (!todo.length) {
        if (erased) { V.drawGrid(); scheduleSave(); }
        return;
    }
    beginUndoBatch();
    M.paintCells(todo, s.color);
    warnCut(todo, s);
    const g = applyExpansion();
    // Growing on the left or top shifts every cell, this stroke's
    // previous one included.
    s.last = { x: c.x + g.left, y: c.y + g.top };
    V.drawGrid();
    scheduleSave();
}

export {
    cellPath, straightLock, setStraightLock, strokeCells, strokeParts, paintGesture, paintStraight, paintTo,
};
