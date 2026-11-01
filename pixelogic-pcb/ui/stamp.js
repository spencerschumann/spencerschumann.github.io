// The MUX tool: a whole mux per click, turned and flipped, previewed with
// its leads named.

import {
    flashStatus,
} from './page.js';
import {
    afterEdit, applyExpansion, beginUndoBatch, endUndoBatch, undoStack,
} from './history.js';
import {
    drawMode,
} from './tools.js';
import {
    partAnchor, partBlocked, placingPart,
} from './parts.js';
import {
    mousePos, touching,
} from './canvas.js';
import {
    updateActionButtons,
} from './toolbar.js';
import {
    arrayEditing,
} from './arrayedit.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;

// ---- The MUX tool: a whole part at a time ----
// A mux is six cells that say what each is — control, COM, the two pins,
// the switch and plain body — so the tool places a whole one, the way
// round it is set: R turns the next one a quarter, and so does picking
// MUX again (pressing 3 once more), or the bar over the board's turn; M
// (or its flip) flips it end for end, which puts its control on the other
// side. Those are all eight ways round. The preview shows its four
// leads, named, so it is plain where each wire goes before it is down,
// and the MUX button's swatch stands up with it. It goes down where the
// pointer lets go (canvas.js placeGesture); on a touchscreen, which has
// no hover, the next one waits on the board to be dragged into place (see
// `hand`, below). Clicking a mux with
// nothing wired to it turns that one. A tutorial's ghost outline does NOT
// snap the part into place: a part placed the wrong way round is how you
// find out it can be turned.
//
// The part is centred on the pointer, not hung off the cell under it:
// along its 3-cell side the middle cell is the one under the pointer,
// and along its 2-cell side the seam between its halves is the grid line
// nearest the pointer. So the outline sits where the hand is, and moves
// over by a cell as the pointer crosses a cell's middle.
let stampRot = 0, stampMirror = false;
let stampShown = '';     // the preview last shown, to redraw only when it changes
// The middle of where the part in hand was last shown over the board, in
// fractional cells: where its copies are set out, repeating it.
let handAt = null;

// A canvas position in fractional cells: 3.5 is the middle of column 3.
function cellPoint(sx, sy) {
    const cs = M.CELL_SIZE * V.zoom;
    return { fx: (sx - V.panX) / cs, fy: (sy - V.panY) / cs };
}

function setStampOrientation(rot, mirror) {
    stampRot = ((rot % 4) + 4) % 4;
    stampMirror = !!mirror;
    document.querySelector('.tool-btn[data-tool="mux"]').classList.toggle('stands', stampRot % 2 === 1);
    showHand();
    refreshStampPreview();
    V.drawGrid();
}
// Where the next mux's COM and control face, in words.
function stampWords() {
    const side = ['up', 'right', 'down', 'left'];
    const list = M.muxLayout(0, 0, stampRot, stampMirror);
    const lead = (kind) => { const c = list.find(([, , id]) => M.muxCellKind(id) === kind); return side[M.muxLead(c[2])]; };
    return `Mux: COM out ${lead('com')}, SEL out ${lead('sel')}`;
}
function turnStamp() {
    setStampOrientation(stampRot + 1, stampMirror);
    flashStatus(stampWords());
}
function mirrorStamp() {
    setStampOrientation(stampRot, !stampMirror);
    flashStatus(stampWords());
}

// The tutorial's ghost part, if one is showing: its cells, and whether it
// stands up.
function ghostPart() {
    const g = V.guide;
    if (!g || g.color !== 'mux') return null;
    const xs = g.cells.map((c) => c[0]), ys = g.cells.map((c) => c[1]);
    return { cells: g.cells, stands: Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs) };
}

// The mux a click centred on `p` (fractional cells) puts down, the way
// round the tool is set: [[x, y, id]] (see M.muxLayout). The cell under
// the pointer is always one of them.
function stampCells(p) {
    // Standing the way a ghost stands and clicked anywhere on it: exactly
    // on the ghost. The other way it lands as it is — how else would
    // anyone learn it turns?
    const cx = Math.floor(p.fx), cy = Math.floor(p.fy);
    const stands = stampRot % 2 === 1, w = stands ? 2 : 3, h = stands ? 3 : 2;
    const ghost = ghostPart();
    if (ghost && ghost.stands === stands && ghost.cells.some(([x, y]) => x === cx && y === cy))
        return M.muxLayout(Math.min(...ghost.cells.map((c) => c[0])), Math.min(...ghost.cells.map((c) => c[1])), stampRot, stampMirror);
    return M.muxLayout(Math.round(p.fx - w / 2), Math.round(p.fy - h / 2), stampRot, stampMirror);
}
// Its four leads, for the preview.
const LEAD_NAMES = { sel: 'SEL', com: 'COM', no: 'NO', nc: 'NC' };
const stampLeads = (list) => list.filter(([, , id]) => M.muxLead(id) >= 0)
    .map(([x, y, id]) => ({ x, y, d: M.muxLead(id), name: LEAD_NAMES[M.muxCellKind(id)] }));

// Why a mux cannot go here, or null if it can. It goes where it is put,
// as a paste does: whatever is in its way is replaced (M.muxClearance)
// — a mux it covers, whole; a part under it, or whose edge it would sit
// on, whole — but a level's pad.
function stampBlocked(list) {
    const cl = M.muxClearance(list);
    return cl.why || null;
}

// ---- The next one, waiting on the board ----
// A mouse shows where the next mux or part goes by hovering. A touchscreen
// has no hover, so there the next one waits on the board instead, on bare
// board in view (`hand`: its middle, in fractional cells) — turned and
// flipped where it can be seen, before anything is put down. A finger on
// it drags it into place and lets go to put it down; a finger anywhere
// else brings it there (canvas.js placeGesture). Once one is down, the
// next waits beside it: where it was is not bare any more.
let hand = null;
let handHeld = false;   // a finger is moving it: it goes where it is taken
// The cells the thing in hand would cover, its middle at `p`.
function handCells(p) {
    if (drawMode === 'mux') return stampCells(p).map(([x, y]) => [x, y]);
    if (drawMode !== 'part' || !placingPart) return [];
    const at = partAnchor(p), c = placingPart.clip, out = [];
    if (placingPart.shape.cells) return placingPart.shape.cells.map(([x, y]) => [at.x + x, at.y + y]);
    for (let y = at.y; y < at.y + c.h; y++) for (let x = at.x; x < at.x + c.w; x++) out.push([x, y]);
    return out;
}
// Would it sit there on bare board — and, with `margin`, a cell of bare
// board round it — and could it go down there?
function bareFor(p, margin) {
    const cells = handCells(p);
    if (!cells.length) return false;
    for (const [x, y] of cells) {
        if (!M.inBounds(x, y)) return false;
        for (let ey = -margin; ey <= margin; ey++)
            for (let ex = -margin; ex <= margin; ex++) {
                const nx = x + ex, ny = y + ey;
                if (!M.inBounds(nx, ny)) continue;
                if (!M.isInsulatorId(M.getCell(nx, ny)) || M.isLocked(nx, ny) || M.blockAtCell(nx, ny)) return false;
            }
    }
    return drawMode === 'mux' ? !stampBlocked(stampCells(p)) : !partBlocked(partAnchor(p));
}
function inView(p) {
    const cs = M.CELL_SIZE * V.zoom, sx = V.panX + p.fx * cs, sy = V.panY + p.fy * cs;
    return sx > cs * 1.5 && sx < V.width - cs * 1.5 && sy > cs * 1.5 && sy < V.height * 0.8 - cs;
}
// The nearest bare spot to `near` (or the middle of the view), in view.
function parkHand(near) {
    const start = near && M.inBounds(Math.floor(near.fx), Math.floor(near.fy)) ? near
        : cellPoint(V.width / 2, V.height * 0.4);
    const R = 20;
    const rings = [];
    for (let r = 0; r <= R; r++) {
        const ring = [];
        for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
        rings.push(ring.sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1]));
    }
    for (const [margin, seen] of [[1, true], [0, true], [0, false]])
        for (const ring of rings)
            for (const [dx, dy] of ring) {
                const p = { fx: start.fx + dx, fy: start.fy + dy };
                if ((!seen || inView(p)) && bareFor(p, margin)) { hand = p; return; }
            }
    hand = start;
}
const handShown = () => touching() && !mousePos && (drawMode === 'mux' || (drawMode === 'part' && !!placingPart)) && !arrayEditing();
// The tool picked, or the thing in hand turned, flipped or changed: where
// it can be seen.
function showHand() {
    if (handShown() && !handHeld && (!hand || !inView(hand) || !bareFor(hand, 0))) parkHand(hand && inView(hand) ? hand : null);
}
// Taken by a finger to `p` (`held`), or let go there.
function holdHand(p, held) {
    if (p) hand = p;
    handHeld = !!held;
}
const handPoint = () => (handShown() ? hand : null);
// Is `p` on the thing waiting on the board?
function handCovers(p) {
    if (!handShown() || !hand) return false;
    const x = Math.floor(p.fx), y = Math.floor(p.fy);
    return handCells(hand).some(([cx, cy]) => cx === x && cy === y);
}
// Where the preview goes: under the mouse; on a touchscreen, where the
// next one waits — moved off what is there now (one just put down there)
// unless a finger is taking it somewhere.
function previewPoint() {
    if (mousePos) return cellPoint(mousePos.sx, mousePos.sy);
    if (!handShown()) return null;
    if (!handHeld && (!hand || !bareFor(hand, 0))) parkHand(hand);
    return hand;
}

// Shows where the MUX tool would put its part, from the mouse's last
// position and the view as it is now — so it follows a pan or a zoom
// under a still mouse, too. Nothing over a part already on the board
// (a click there turns it) or off it. True if the preview changed.
//
// The Parts tool previews the same way: a ghost of the part's lid,
// centred on the pointer, red where it cannot go.
function refreshStampPreview() {
    const at = previewPoint();
    const p = drawMode === 'mux' ? at : null;
    const c = p && { x: Math.floor(p.fx), y: Math.floor(p.fy) };
    let preview = null;
    if (c && M.inBounds(c.x, c.y) && !M.isMuxId(M.getCell(c.x, c.y))) {
        const list = stampCells(p);
        preview = { cells: list.map(([x, y]) => [x, y]), leads: stampLeads(list), ok: !stampBlocked(list) };
    }
    V.setStampPreview(preview);
    let partPreview = null;
    const pt = at;
    // Off the board, nothing: there is nowhere there to put it. Nor while
    // the copies are being set out on the board, which is where they go.
    if (drawMode === 'part' && placingPart && !arrayEditing() && pt && M.inBounds(Math.floor(pt.fx), Math.floor(pt.fy))) {
        const at = partAnchor(pt);
        const pc = placingPart.clip;
        handAt = { fx: at.x + pc.w / 2, fy: at.y + pc.h / 2 };
        const off = (c) => c && [at.x + c[0], at.y + c[1]];
        const lid = (p) => ({
            x0: at.x + p.x0, y0: at.y + p.y0, x1: at.x + p.x1, y1: at.y + p.y1, name: p.name,
            pins: p.pins.map((q) => ({
                name: q.name, dir: q.dir, host: off(q.host), face: q.face, at: off(q.at),
                others: (q.others || []).map((t) => ({ host: off(t.host), face: t.face, at: off(t.at) })),
            })),
            ring: p.ring.map((e) => ({ x: at.x + e.x, y: at.y + e.y, cls: e.cls })),
            ...(p.outline ? {
                outline: p.outline.map((loop) => loop.map(([x, y]) => [at.x + x, at.y + y])),
                inner: { x0: at.x + p.inner.x0, y0: at.y + p.inner.y0, x1: at.x + p.inner.x1, y1: at.y + p.inner.y1 },
            } : {}),
        });
        // Copies apart are each their own lid.
        partPreview = placingPart.parts
            ? { parts: placingPart.parts.map(lid), ok: !partBlocked(at) }
            : { ...lid({ x0: 0, y0: 0, x1: pc.w - 1, y1: pc.h - 1, name: placingPart.name, pins: placingPart.pins, ring: placingPart.ring, ...placingPart.shape }), ok: !partBlocked(at) };
    }
    V.setPartPreview(partPreview);
    const key = (preview ? JSON.stringify(preview) : '') + '|' + (partPreview ? JSON.stringify(partPreview) : '');
    const changed = key !== stampShown;
    stampShown = key;
    return changed;
}

// Places a part centred on `p`, fractional cells (see stampCells).
function stampAt(p) {
    const c = { x: Math.floor(p.fx), y: Math.floor(p.fy) };
    if (!M.inBounds(c.x, c.y)) return;
    if (M.isMuxId(M.getCell(c.x, c.y))) {
        if (muxIsBare(c)) turnBareMux(c);
        else flashStatus('Already wired — Rearrange moves it (R turns it as you drag), Erase removes it');
        return;
    }
    const list = stampCells(p);
    const why = stampBlocked(list);
    if (why) { flashStatus(why); return; }
    beginUndoBatch();
    M.applyClearance(M.muxClearance(list));
    M.stampMux(list);
    endUndoBatch();
    applyExpansion();
    refreshStampPreview();
    afterEdit();
}

// Whether the mux at `c` has nothing on any of its leads.
function muxIsBare(c) {
    const role = M.roles[M.idx(c.x, c.y)];
    if (!role || !role.macro) return true;
    return role.macro.leads.every(([[lx, ly], [dx, dy]]) => !M.inBounds(lx + dx, ly + dy) || M.isInsulatorId(M.getCell(lx + dx, ly + dy)));
}
// A mux with nothing wired to it turns a quarter in place — only a bare
// one: a wired one turned would take its wires with it, which is what
// Rearrange is for.
function turnBareMux(c) {
    beginUndoBatch();
    const res = M.moveObjects([{ cells: M.muxBlob(c.x, c.y) }], 0, 0, 1);
    // Turned to stand the way a ghost it overlaps stands, it settles onto
    // the ghost, keeping the way round it now is: a quarter turn about
    // its middle can leave it a cell off.
    const ghost = ghostPart();
    if (res.ok && ghost) {
        const turned = res.objects[0].cells;
        const key = ([x, y]) => x + ',' + y, mine = new Set(turned.map(key));
        const xs = turned.map((t) => t[0]), ys = turned.map((t) => t[1]);
        const stands = Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs);
        const gx = Math.min(...ghost.cells.map((g) => g[0])), gy = Math.min(...ghost.cells.map((g) => g[1]));
        const free = ghost.cells.every((g) => mine.has(key(g)) || M.isInsulatorId(M.getCell(g[0], g[1])));
        if (stands === ghost.stands && free && ghost.cells.some((g) => mine.has(key(g))))
            M.moveObjects([{ cells: turned }], gx - Math.min(...xs), gy - Math.min(...ys), 0);
    }
    endUndoBatch();
    if (!res.ok) {
        undoStack.pop();
        updateActionButtons();
        flashStatus('No room to turn it here');
        return;
    }
    applyExpansion();
    afterEdit();
}

export {
    stampRot, stampMirror, stampShown, handAt, cellPoint, setStampOrientation, stampWords, turnStamp, mirrorStamp,
    showHand, holdHand, handPoint, handCovers,
    ghostPart, stampCells, LEAD_NAMES, stampLeads, stampBlocked, refreshStampPreview, stampAt, muxIsBare,
    turnBareMux,
};
