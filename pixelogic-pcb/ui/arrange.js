// Rearrange: picking objects (one, a band of them, Ctrl/Cmd-click or hold
// to add), dragging them as one rigid piece, and turning them in place.

import {
    flashStatus,
} from './page.js';
import {
    afterEdit, applyExpansion, beginUndoBatch, endUndoBatch, scheduleSave, undoStack,
} from './history.js';
import {
    updateActionButtons,
} from './toolbar.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
// Rearrange tool: `arrangeSel` is the selected object list (a
// multi-select drags them as one rigid piece), `arrange` the drag in
// progress — kept here rather than in its gesture, since R turns it
// mid-drag and a tool switch drops it.
let arrange = null;         // {objs,base,grabX,grabY,dx,dy,rot,last,cur,unrouted,moved}
let arrangeSel = [];        // [{cells:[[x,y],...]}]
const LONG_PRESS_MS = 450;  // touch: hold to add/remove one object

// ---- Rearrange (whole-object drag / rotate, single or multi) ----
// Pressing on a mux/wire/pad/source in Rearrange grabs the whole object
// (M.objectAt); dragging restamps it live by restoring the pre-grab
// snapshot and re-applying the cumulative move (the floating-paste
// pattern), so however long the drag wanders it collapses into one undo
// step and one final set of rerouted wires. Release commits; the
// selection survives so R can keep rotating it in place.
//
// Selecting more than one: drag from empty space for a rubber band
// (mouse or one finger — the gesture that works everywhere), Ctrl/Cmd-
// click to add or remove one, or press and hold on touch to do the same.
// Dragging any member then moves the whole group rigidly.
const objKey = (o) => Math.min(...o.cells.map(([x, y]) => M.idx(x, y)));
function setArrangeSel(objs) {
    arrangeSel = objs || [];
    const flat = [];
    for (const o of arrangeSel) for (const c of o.cells) flat.push(c);
    V.setObjectHighlight(flat.length ? flat : null);
    updateActionButtons();
}
function selHasCell(x, y) {
    const i = M.idx(x, y);
    return arrangeSel.some((o) => o.cells.some(([cx, cy]) => M.idx(cx, cy) === i));
}
function toggleInSel(obj) {
    const k = objKey(obj);
    const rest = arrangeSel.filter((o) => objKey(o) !== k);
    setArrangeSel(rest.length === arrangeSel.length ? arrangeSel.concat([obj]) : rest);
    V.drawGrid();
}
// Everything the band touches, deduped — intersecting rather than fully
// enclosing, which is much easier to hit on a phone.
//
// A cell already inside something found is skipped: every cell of a part
// answers with the whole part, and asking again for each of them made a
// band over a big part crawl.
function selectInBand(r) {
    const seen = new Map(), covered = new Set();
    for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
            if (covered.has(M.idx(x, y))) continue;
            const o = M.objectAt(x, y);
            if (!o || seen.has(objKey(o))) continue;
            seen.set(objKey(o), o);
            if (o.kind === 'block') for (const [cx, cy] of o.cells) covered.add(M.idx(cx, cy));
        }
    }
    setArrangeSel([...seen.values()]);
}
// Re-derive the selection from where the cells actually ended up, so a
// dropped group stays selected (and stays rotatable) at its new spot.
function selFromMoved(objs, g) {
    return objs.map((o) => ({
        cells: (g && (g.left || g.top)) ? o.cells.map(([x, y]) => [x + g.left, y + g.top]) : o.cells,
    }));
}

// Rotation usually needs a little room: once turned, the pins face new
// directions and the wires have to come in differently, so the turn often
// does not fit exactly where the object stands even though it fits a cell
// or two over. Rather than refuse outright, try the nearest positions
// too — nudging is far less disruptive than making the user clear space
// by hand. Nearest-first, and among equals the one with the smaller total
// shift.
function nudgeOffsets(radius) {
    const out = [];
    for (let dx = -radius; dx <= radius; dx++)
        for (let dy = -radius; dy <= radius; dy++) out.push([dx, dy]);
    return out.sort((a, b) =>
        (Math.max(Math.abs(a[0]), Math.abs(a[1])) - Math.max(Math.abs(b[0]), Math.abs(b[1]))) ||
        (Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1]))));
}
// Try a move, falling back to nearby offsets when it won't fit. Reports
// where it actually landed, so a drag can remember that rather than the
// spot the pointer asked for and did not get.
function moveWithNudge(objs, dx, dy, rot, radius, mirror) {
    for (const [ox, oy] of nudgeOffsets(radius)) {
        const res = M.moveObjects(objs, dx + ox, dy + oy, rot, mirror);
        if (res.ok) return { res, nudged: ox !== 0 || oy !== 0, at: { dx: dx + ox, dy: dy + oy, rot, mirror } };
    }
    return { res: { ok: false }, nudged: false, at: null };
}

// A connection the move could not keep is not lost — it is drawn as a
// dashed line to whatever it should still reach, so say that rather than
// just reporting a number.
function flashUnrouted(n) {
    if (n) flashStatus(n === 1 ? '1 connection left dashed — draw it to finish'
        : `${n} connections left dashed — draw them to finish`);
}

function restampArrange() {
    const a = arrange;
    M.restoreStructuralSnapshot(a.base);
    // The batch opens only once a real move happens (a plain click
    // shouldn't leave a no-op undo step), and only right after the base
    // restore, so the snapshot it captures is exactly the pre-drag grid.
    if (!a.moved) { beginUndoBatch(); a.moved = true; }
    // When the exact spot won't take it, look outward for the nearest one
    // that will. `nudgeOffsets` is ordered by ring, so the first hit IS
    // the nearest, which is where the object should sit — following the
    // pointer as closely as the board allows. Snapping back to where the
    // drag last happened to fit (or worse, to where it started) threw away
    // everything the user had dragged past.
    let res = M.moveObjects(a.objs, a.dx, a.dy, a.rot, a.mirror);
    let nudge = null;
    if (!res.ok) {
        // Only somewhere that gets the part nearer the pointer than where
        // it already is — or as near, but on the way there. A spot that
        // fits but lies the other way (left, on a drag to the right) is
        // a jump nobody asked for; then it stays where it is.
        const from = a.last || { dx: 0, dy: 0, rot: a.rot };
        const far = (dx, dy) => Math.max(Math.abs(dx - a.dx), Math.abs(dy - a.dy));
        const onward = ([ox, oy]) => {
            const dx = a.dx + ox, dy = a.dy + oy, f = far(dx, dy), f0 = far(from.dx, from.dy);
            const dot = (dx - from.dx) * (a.dx - from.dx) + (dy - from.dy) * (a.dy - from.dy);
            return f < f0 || (f === f0 && dot > 0);
        };
        nudge = { res: { ok: false }, at: null };
        for (const [ox, oy] of nudgeOffsets(3).filter(onward)) {
            const r = M.moveObjects(a.objs, a.dx + ox, a.dy + oy, a.rot, a.mirror);
            if (r.ok) { nudge = { res: r, at: { dx: a.dx + ox, dy: a.dy + oy, rot: a.rot, mirror: a.mirror } }; break; }
        }
        res = nudge.res;
    }
    if (res.ok) a.last = nudge && nudge.at ? nudge.at : { dx: a.dx, dy: a.dy, rot: a.rot, mirror: a.mirror };
    else if (a.last) res = M.moveObjects(a.objs, a.last.dx, a.last.dy, a.last.rot, a.last.mirror); // nothing nearer fits
    // Nothing has fit yet — the drag just hasn't found a legal spot. The
    // grid is already back at its pre-drag state from the restore above,
    // so leave the selection where it was rather than reading cells off a
    // refusal.
    if (res.ok) {
        a.cur = res.objects;
        a.unrouted = res.unrouted || 0;
        a.pending = res.pending || 0;
        setArrangeSel(a.cur);
    }
    V.drawGrid();
}

function commitArrange() {
    if (!arrange) return;
    const a = arrange;
    arrange = null;
    if (!a.moved) return; // plain click: the object just stays selected
    // a.last is unset when no offset the drag tried would fit: the grid is
    // already back where it started, so this is a no-op like any other.
    const noop = !a.last || (a.last.dx === 0 && a.last.dy === 0 && a.last.rot % 4 === 0 && !a.last.mirror);
    endUndoBatch();
    if (noop) { undoStack.pop(); updateActionButtons(); return; } // drag ended back where it started
    const g = applyExpansion(); // dropped on the border: grow to keep the 1-cell margin
    setArrangeSel(selFromMoved(a.cur, g));
    flashUnrouted(a.pending || a.unrouted);
    afterEdit();
}

// Roll a drag back entirely (Escape, or a second finger landing turned
// the gesture into pan/zoom): restore the pre-grab grid and drop the
// undo step the drag had opened.
function abortArrange() {
    if (!arrange) return;
    const a = arrange;
    arrange = null;
    if (a.moved) {
        M.restoreStructuralSnapshot(a.base);
        endUndoBatch();
        undoStack.pop();
        updateActionButtons();
        scheduleSave();
    }
    setArrangeSel(a.objs);
    V.drawGrid();
}

// A rubber band from empty space: everything it touches, on release. A
// band that never grew is a tap on empty space, and clears the
// selection.
function bandGesture(c) {
    const band = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    const rect = () => ({
        x0: Math.min(band.x0, band.x1), y0: Math.min(band.y0, band.y1),
        x1: Math.max(band.x0, band.x1), y1: Math.max(band.y0, band.y1),
    });
    V.setSelection(rect());
    V.drawGrid();
    return {
        move({ c: p }) {
            band.x1 = Math.max(0, Math.min(M.GRID_W - 1, p.x));
            band.y1 = Math.max(0, Math.min(M.GRID_H - 1, p.y));
            V.setSelection(rect());
            V.drawGrid();
        },
        end() {
            V.setSelection(null);
            if (band.x1 === band.x0 && band.y1 === band.y0 && !M.objectAt(band.x0, band.y0)) setArrangeSel([]);
            else selectInBand(rect());
            V.drawGrid();
        },
        abort() { V.setSelection(null); },
    };
}
// Grabbing an object (or the group it is in) and dragging it; release
// drops it. On touch, which has no modifier key, holding still instead
// adds or removes this one object.
function dragGesture(c, obj, isTouch) {
    arrange = {
        objs: arrangeSel, base: M.getStructuralSnapshot(),
        grabX: c.x, grabY: c.y, dx: 0, dy: 0, rot: 0, mirror: false,
        last: { dx: 0, dy: 0, rot: 0, mirror: false }, cur: arrangeSel, unrouted: 0, moved: false,
    };
    let hold = !isTouch ? null : setTimeout(() => {
        hold = null;
        arrange = null;   // nothing moved yet, so nothing to roll back
        toggleInSel(obj);
    }, LONG_PRESS_MS);
    const stopHold = () => { if (hold) { clearTimeout(hold); hold = null; } };
    V.drawGrid();
    return {
        move({ c: p }) {
            if (!arrange) return;   // held instead, or dropped by a key
            if (p.x - arrange.grabX === arrange.dx && p.y - arrange.grabY === arrange.dy) return;
            stopHold();   // it's a drag, not a hold
            arrange.dx = p.x - arrange.grabX;
            arrange.dy = p.y - arrange.grabY;
            restampArrange();
        },
        end() { stopHold(); commitArrange(); },
        abort() { stopHold(); abortArrange(); },
    };
}

function rotateArrangeSelected() {
    if (arrange) { // mid-drag: fold the turn into the live drag
        arrange.rot = (arrange.rot + 1) % 4;
        restampArrange();
        return;
    }
    if (!arrangeSel.length) return;
    beginUndoBatch();
    const { res, nudged } = moveWithNudge(arrangeSel, 0, 0, 1, 3);
    endUndoBatch();
    if (!res.ok) {
        undoStack.pop(); // nothing changed — drop the no-op undo step
        updateActionButtons();
        flashStatus('No room to rotate — move things apart');
        return;
    }
    const g = applyExpansion();
    setArrangeSel(selFromMoved(res.objects, g));
    if (nudged) flashStatus('Rotated (nudged to fit)');
    afterEdit();
}
// M: flip what is picked out left for right, where it stands — or, mid-
// drag, the object being dragged. A flip after a turn is the turn the
// other way round, then the flip (the drag applies its flip first).
function mirrorArrangeSelected() {
    if (arrange) {
        arrange.mirror = !arrange.mirror;
        arrange.rot = (4 - arrange.rot) % 4;
        restampArrange();
        return;
    }
    if (!arrangeSel.length) return;
    beginUndoBatch();
    const { res, nudged } = moveWithNudge(arrangeSel, 0, 0, 0, 3, true);
    endUndoBatch();
    if (!res.ok) {
        undoStack.pop();
        updateActionButtons();
        flashStatus('No room to flip it — move things apart');
        return;
    }
    const g = applyExpansion();
    setArrangeSel(selFromMoved(res.objects, g));
    if (nudged) flashStatus('Flipped (nudged to fit)');
    afterEdit();
}

export {
    arrange, arrangeSel, LONG_PRESS_MS, objKey, setArrangeSel, selHasCell, toggleInSel, selectInBand,
    selFromMoved, nudgeOffsets, moveWithNudge, flashUnrouted, restampArrange, commitArrange, abortArrange,
    bandGesture, dragGesture, rotateArrangeSelected, mirrorArrangeSelected,
};
