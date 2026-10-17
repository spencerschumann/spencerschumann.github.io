// The board's size (growing and clearing it), structural snapshots for
// undo, and the region edits: copy, clear, paste, turn and flip.

import {
    ID_INSULATOR_PLAIN, isMuxId, isInsulatorId, mirrorId, stripId,
} from './cells.js';
import {
    copyPin, B, DEFAULT_H, DEFAULT_W, copyBlockRec, idx, inBounds, isLocked, withRep,
} from './board.js';
import {
    restartTicks,
} from './sim.js';
import {
    blockCellIdxs, blockParent, blockState, blocksInside, isProtected, isTerminalCell, mirrorPinCode,
    restoreBlockState, ringViolations, topBlockOf,
} from './blocks.js';
import {
    applyClearance, clearanceFor, clipBlockFits, rotateClipCW,
} from './clips.js';
import {
    floodFill, recomputeRoles,
} from './edit.js';

// A flat cell index re-addressed for a grid whose width changed and whose
// content moved by (offX, offY). The ratsnest stores flat indices, so it
// is the one thing that has to be carried across a resize by hand.
function remapIdx(i, oldW, newW, offX, offY) {
    const x = i % oldW, y = (i - x) / oldW;
    return (y + offY) * newW + (x + offX);
}

// Reallocate the cell arrays at a new size, copying existing content offset
// by (offX, offY). Used both by auto-expansion and by load/undo restoring a
// different size.
function resizeGrid(newW, newH, offX, offY, keepContent) {
    const oldW = B.w, oldH = B.h, old = B.cells, oldLocked = B.locked;
    const oldBlockAt = B.blockAt, oldPinAt = B.pinAt;
    const newCells = new Uint8Array(newW * newH); // 0 = insulator
    const newLocked = new Uint8Array(newW * newH);
    const newBlockAt = new Int32Array(newW * newH), newPinAt = new Int16Array(newW * newH);
    if (keepContent) {
        for (let y = 0; y < oldH; y++)
            for (let x = 0; x < oldW; x++) {
                const ni = (y + offY) * newW + (x + offX), oi = y * oldW + x;
                newCells[ni] = old[oi];
                newLocked[ni] = oldLocked[oi];
                newBlockAt[ni] = oldBlockAt[oi];
                newPinAt[ni] = oldPinAt[oi];
            }
        // Left alone, every owed connection would point at the wrong
        // cells once the width changes, and the next prune would drop it
        // as erased: drawing up against the top or left edge used to make
        // the ratsnest silently vanish.
        B.pendingLinks = B.pendingLinks.map((l) => l.map((i) => remapIdx(i, oldW, newW, offX, offY)));
    } else {
        B.anyLocked = false;  // a wholesale reload brings its own locks, if any
        B.pendingLinks = [];  // ...and its own ratsnest (a snapshot restores one after)
        B.blocks = new Map(); // ...and its own blocks
        B.blockGeom = new Map();
    }
    B.cells = newCells;
    B.locked = newLocked;
    B.blockAt = newBlockAt;
    B.pinAt = newPinAt;
    B.ringMask = new Uint8Array(newW * newH);
    B.nextCells = new Uint8Array(newW * newH);
    B.roles = new Array(newW * newH).fill(null);
    B.w = newW; B.h = newH;
}

// Auto-grow the grid so drawn content always keeps a 1-cell empty border.
// Returns how much was added on each side; {left, top} is how far existing
// content shifted, which the view uses to compensate pan so the drawing
// doesn't appear to move.
function expandForBorder() {
    let left = 0, top = 0, right = 0, bottom = 0;
    // A block's margin is empty substrate, but it is the block's.
    const used = (x, y) => B.cells[idx(x, y)] !== ID_INSULATOR_PLAIN || B.blockAt[idx(x, y)] !== 0;
    for (let y = 0; y < B.h; y++) {
        if (used(0, y)) left = 1;
        if (used(B.w - 1, y)) right = 1;
    }
    for (let x = 0; x < B.w; x++) {
        if (used(x, 0)) top = 1;
        if (used(x, B.h - 1)) bottom = 1;
    }
    if (left || top || right || bottom) {
        resizeGrid(B.w + left + right, B.h + top + bottom, left, top, true);
        recomputeRoles();
    }
    return { left, top, right, bottom };
}

// Grow (never shrink) to at least w x h, adding only on the right and the
// bottom so no existing cell moves. For an edit that needs more room than
// the one-cell border provides, such as a region rotated off the edge.
function growTo(w, h) {
    if (w <= B.w && h <= B.h) return false;
    resizeGrid(Math.max(w, B.w), Math.max(h, B.h), 0, 0, true);
    recomputeRoles();
    return true;
}

// Grow on any side, never shrinking — for putting a part down that
// reaches past the sandbox's edge. Returns how much was added where;
// {left, top} is how far everything moved.
function growBy(left, top, right, bottom) {
    const g = { left: Math.max(0, left | 0), top: Math.max(0, top | 0), right: Math.max(0, right | 0), bottom: Math.max(0, bottom | 0) };
    if (!g.left && !g.top && !g.right && !g.bottom) return g;
    resizeGrid(B.w + g.left + g.right, B.h + g.top + g.bottom, g.left, g.top, true);
    recomputeRoles();
    return g;
}

// A structural snapshot grown the way expandForBorder just grew the grid
// (`g` is its return value), for a caller holding a snapshot across an
// expansion — the floating paste's base. The ratsnest is re-addressed
// along with the cells, or restoring the base would drop it.
function growSnapshot(snap, g) {
    const newW = snap.w + g.left + g.right, newH = snap.h + g.top + g.bottom;
    const data = new Uint8Array(newW * newH);
    const b = snap.blocks, at = new Int32Array(newW * newH), pin = new Int16Array(newW * newH);
    for (let y = 0; y < snap.h; y++)
        for (let x = 0; x < snap.w; x++) {
            const ni = (y + g.top) * newW + (x + g.left), oi = y * snap.w + x;
            data[ni] = snap.data[oi];
            if (b) { at[ni] = b.at[oi]; pin[ni] = b.pin[oi]; }
        }
    const links = (snap.links || []).map((l) => l.map((i) => remapIdx(i, snap.w, newW, g.left, g.top)));
    const blocksOut = b ? { at, pin, recs: b.recs.map(copyBlockRec), next: b.next } : null;
    return { w: newW, h: newH, data, links, blocks: blocksOut };
}

// With locks in play (a campaign level) "clear" means "clear what the
// player drew": the board keeps its size and its fixed I/O pads, so
// starting over doesn't destroy the level's terminals. In the sandbox
// there are no locks and this is the original full reset.
function clearGrid() {
    B.pendingLinks = [];
    if (B.anyLocked) {
        for (let i = 0; i < B.cells.length; i++)
            if (B.locked[i] !== 1) B.cells[i] = ID_INSULATOR_PLAIN;
        B.blockAt.fill(0);
        B.pinAt.fill(0);
        B.blocks = new Map();
    } else {
        resizeGrid(DEFAULT_W, DEFAULT_H, 0, 0, false);
    }
    restartTicks();
    recomputeRoles();
}

// Pending links ride along. They are the one thing here not derivable
// from the pixels, so a restore that put back only cells left them
// behind — and a drag restamps on every pointer move (restore the base,
// re-apply the whole offset), which prunes the links the board already
// owed as their mux end moves out from under them. Escape, undo and
// starting a second drag all come through here, and all three want the
// ratsnest the board had at that moment.
function getStructuralSnapshot() {
    const data = new Uint8Array(B.cells.length);
    for (let i = 0; i < B.cells.length; i++) data[i] = stripId(B.cells[i]);
    return {
        w: B.w, h: B.h, data, links: B.pendingLinks.map((l) => l.slice()),
        blocks: B.blocks.size ? blockState() : null,
    };
}

// When the grid size is unchanged, only touch cells whose structure differs,
// so unchanged cells keep their live charge instead of flashing back to
// charge-OFF. When the size differs (undo/redo across an auto-expand),
// reallocate to the snapshot's size and restore it wholesale.
function restoreStructuralSnapshot(snap) {
    if (snap.w === B.w && snap.h === B.h) {
        for (let i = 0; i < B.cells.length; i++) {
            if (stripId(B.cells[i]) !== snap.data[i]) B.cells[i] = snap.data[i];
        }
    } else {
        resizeGrid(snap.w, snap.h, 0, 0, false);
        B.cells.set(snap.data);
    }
    // A lid is a way of looking, not an edit: a block that is still
    // here after the restore keeps the lid it has now.
    const lids = new Map([...B.blocks].map(([id, r]) => [id, r.open]));
    restoreBlockState(snap.blocks);
    for (const [id, r] of B.blocks) if (lids.has(id)) r.open = lids.get(id);
    B.pendingLinks = (snap.links || []).map((l) => l.slice());
    recomputeRoles();   // prunes anything the restored grid already satisfies
}

function normalizeRect(x0, y0, x1, y1) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    return {
        x0: Math.max(0, Math.min(B.w - 1, x0)),
        y0: Math.max(0, Math.min(B.h - 1, y0)),
        x1: Math.max(0, Math.min(B.w - 1, x1)),
        y1: Math.max(0, Math.min(B.h - 1, y1)),
    };
}

// A block wholly inside the rectangle travels with the clip. One the
// rectangle cuts through does not: its cells inside come along loose.
function copyRegion(x0, y0, x1, y1) {
    const r = normalizeRect(x0, y0, x1, y1);
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
            data[y * w + x] = stripId(B.cells[idx(r.x0 + x, r.y0 + y)]);
    const clip = { w, h, data };
    const inside = blocksInside(r);
    if (!inside.size) return clip;
    const lid = new Map();
    for (const id of inside) lid.set(id, lid.size + 1);
    const up = (b) => { while (b && !inside.has(b)) b = blockParent(b); return b; };
    clip.blocks = [...inside].map((id) => {
        const rec = B.blocks.get(id);
        return withRep({
            lid: lid.get(id), name: rec.name, source: rec.source, open: rec.open,
            parent: lid.get(up(rec.parent)) || 0, pins: rec.pins.map((p) => copyPin(p, (v) => lid.get(v))),
        }, rec);
    });
    clip.bmap = new Int32Array(w * h);
    clip.pmap = new Int16Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = idx(r.x0 + x, r.y0 + y), b = up(B.blockAt[i]);
            if (!b) continue;
            clip.bmap[y * w + x] = lid.get(b);
            if (b === B.blockAt[i]) clip.pmap[y * w + x] = B.pinAt[i];
        }
    return clip;
}

// Blocks wholly inside go with the rectangle. One it only cuts through
// stays, whole — a part is one thing, and half of one is litter.
function clearRegion(x0, y0, x1, y1) {
    const r = normalizeRect(x0, y0, x1, y1);
    const inside = blocksInside(r);
    for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) {
            const i = idx(x, y);
            if (isLocked(x, y)) continue;
            if (B.blockAt[i] && !inside.has(topBlockOf(B.blockAt[i]))) continue;
            B.cells[i] = ID_INSULATOR_PLAIN;
            B.blockAt[i] = 0;
            B.pinAt[i] = 0;
        }
    recomputeRoles();
}

// Every cell of the mux material blob (4-connected) that (x,y) is part
// of, or [] if it is not mux material. What an eraser takes when it
// touches a mux: a part is one thing, and five-sixths of one is litter.
// The mux material a cell belongs to: a mux's six cells — not a flood,
// which would run on into a mux sitting flush beside it — or a blob of
// mux cells that make up no whole mux.
function muxBlob(x, y) {
    if (!inBounds(x, y) || !isMuxId(B.cells[idx(x, y)])) return [];
    const r = B.roles[idx(x, y)];
    if (r && r.macro) return muxBodyCells(r.macro);
    return floodFill(x, y, (nx, ny) => {
        const rr = B.roles[idx(nx, ny)];
        return isMuxId(B.cells[idx(nx, ny)]) && !(rr && rr.macro);
    }, new Set());
}
// A mux's six body cells.
function muxBodyCells(macro) {
    const out = [];
    for (let i = 0; i < 3; i++) {
        const gx = macro.rowStart[0] + macro.along[0] * i, gy = macro.rowStart[1] + macro.along[1] * i;
        out.push([gx, gy], [gx + macro.toward[0], gy + macro.toward[1]]);
    }
    return out;
}

// Erase an arbitrary cell list ([[x,y],...]) — a Rearrange selection,
// which is a set of objects rather than a rectangle.
// A block goes only if every cell of it is in the list.
function clearCells(list) {
    const set = new Set();
    for (const [x, y] of list) if (inBounds(x, y)) set.add(idx(x, y));
    const whole = new Set();
    for (const i of set) {
        if (!B.blockAt[i]) continue;
        const t = topBlockOf(B.blockAt[i]);
        if (!whole.has(t) && blockCellIdxs(t).every((j) => set.has(j))) whole.add(t);
    }
    for (const i of set) {
        if (B.anyLocked && B.locked[i] === 1) continue;
        if (B.blockAt[i] && !whole.has(topBlockOf(B.blockAt[i]))) continue;
        B.cells[i] = ID_INSULATOR_PLAIN;
        B.blockAt[i] = 0;
        B.pinAt[i] = 0;
    }
    recomputeRoles();
}

// Writes a clip (from copyRegion, or a stored component) with its
// top-left corner at (x0, y0), silently clipping whatever falls outside
// the grid. Data is re-stripped on the way in since components come
// back from localStorage as untrusted plain arrays.
//
// A block in the clip lands whole or not at all: if any cell of it would
// fall off the board or onto something protected, none of it is written
// (the count comes back as `skipped`). Pasted blocks get fresh ids.
// `opts.replace`: a part in the clip replaces what is under it
// (clearanceFor) instead of being left out where it does not fit — a
// part put down, or pasted, goes where it is put. Left out still where
// something is never replaced: another part, a level's pad.
function pasteRegion(clip, x0, y0, opts) {
    const recs = clip.blocks && clip.bmap ? clip.blocks : [];
    const parentOf = new Map(recs.map((b) => [b.lid, b.parent]));
    const topOf = (l) => { let n = 0; while (parentOf.get(l) && n++ < recs.length) l = parentOf.get(l); return l; };
    const skip = new Set();
    for (const b of recs) {
        if (b.parent) continue;
        if (opts && opts.replace) {
            const cl = clearanceFor(clip, b.lid, x0, y0);
            if (!cl.why) applyClearance(cl);
        }
        if (clipBlockFits(clip, b.lid, x0, y0, false, null)) skip.add(b.lid);
    }
    const newId = new Map();
    for (const b of recs) if (!skip.has(topOf(b.lid))) newId.set(b.lid, B.nextBlockId++);
    for (const b of recs) {
        if (!newId.has(b.lid)) continue;
        B.blocks.set(newId.get(b.lid), withRep({
            id: newId.get(b.lid), name: b.name, source: b.source || '', open: !!b.open,
            parent: b.parent && newId.has(b.parent) ? newId.get(b.parent) : 0,
            pins: b.pins.map((p) => copyPin(p, (v) => newId.get(v))),
        }, b));
    }
    for (let y = 0; y < clip.h; y++) {
        const gy = y0 + y;
        if (gy < 0 || gy >= B.h) continue;
        for (let x = 0; x < clip.w; x++) {
            const gx = x0 + x, k = y * clip.w + x;
            const l = recs.length ? clip.bmap[k] : 0;
            if (l && !newId.has(l)) continue;
            if (gx < 0 || gx >= B.w || isProtected(gx, gy)) continue;
            const i = idx(gx, gy);
            if (!l && isMuxId(clip.data[k]) && isTerminalCell(gx, gy)) continue;
            B.cells[i] = stripId(clip.data[k] & 0xff);
            B.blockAt[i] = l ? newId.get(l) : 0;
            B.pinAt[i] = l && clip.pmap ? clip.pmap[k] : 0;
        }
    }
    recomputeRoles();
    return { skipped: skip.size };
}

// Region rotate/mirror are pure pixel moves — cells here have no stored
// orientation (mux orientation is an emergent property of the pixel
// pattern), so unlike simulation/pixelogic there is no per-cell
// reorientation step. Rotation keeps the region's top-left anchor and
// swaps its w/h; the new bounds (clipped to the grid) are returned so
// the caller can update its selection, or null when it was refused.
// A region holding any locked cell can't be rotated or mirrored: the
// transform would slide a fixed I/O pad off its coordinates. Refusing the
// whole operation is the honest answer — silently transforming everything
// *except* the pad would scramble the circuit around it.
// A block counts as locked unless the whole of it is inside, in which
// case it simply turns with everything else.
function regionHasLocked(r) {
    const inside = blocksInside(r);
    for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) {
            const i = idx(x, y);
            if (B.anyLocked && B.locked[i] === 1) return true;
            if (B.blockAt[i] && !inside.has(topBlockOf(B.blockAt[i]))) return true;
        }
    return false;
}

// Turned, a w x h region is h wide and w tall from the same corner, so a
// non-square one reaches past its own rectangle — and everything it turns
// INTO has to be free: on the board, unlocked, and empty. Rotating used to
// write the clip straight over whatever was there, blank cells and all,
// which erased circuitry outside the selection (in a level, a locked pad
// too) and dropped whatever turned off the edge of the grid.
function rotateFits(r) {
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    for (let y = r.y0; y < r.y0 + w; y++)
        for (let x = r.x0; x < r.x0 + h; x++) {
            if (x <= r.x1 && y <= r.y1) continue; // inside the source: it moves anyway
            if (!inBounds(x, y) || isProtected(x, y) || !isInsulatorId(B.cells[idx(x, y)])) return false;
        }
    return true;
}

function rotateRegionCW(x0, y0, x1, y1) {
    const r = normalizeRect(x0, y0, x1, y1);
    if (regionHasLocked(r) || !rotateFits(r)) return null;
    const before = getStructuralSnapshot();
    const clip = copyRegion(r.x0, r.y0, r.x1, r.y1);
    for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) {
            const i = idx(x, y);
            B.cells[i] = ID_INSULATOR_PLAIN;
            B.blockAt[i] = 0;
            B.pinAt[i] = 0;
        }
    recomputeRoles();   // the edges of what was lifted go with it
    pasteRegion(rotateClipCW(clip), r.x0, r.y0);
    // Turned, something may now sit where a part's edge keeps bare.
    if (ringViolations().length) { restoreStructuralSnapshot(before); return null; }
    return { x0: r.x0, y0: r.y0, x1: r.x0 + clip.h - 1, y1: r.y0 + clip.w - 1 };
}

// Returns false when refused (the region holds a locked pad).
function mirrorRegionH(x0, y0, x1, y1) {
    const r = normalizeRect(x0, y0, x1, y1);
    if (regionHasLocked(r)) return false;
    const before = getStructuralSnapshot();
    for (let y = r.y0; y <= r.y1; y++) {
        for (let lo = r.x0, hi = r.x1; lo <= hi; lo++, hi--) {
            const li = idx(lo, y), hi2 = idx(hi, y);
            const a = stripId(B.cells[li]), b = stripId(B.cells[hi2]);
            B.cells[li] = mirrorId(b);
            B.cells[hi2] = mirrorId(a);
            const ba = B.blockAt[li], pa = B.pinAt[li];
            B.blockAt[li] = B.blockAt[hi2]; B.pinAt[li] = mirrorPinCode(B.pinAt[hi2]);
            B.blockAt[hi2] = ba; B.pinAt[hi2] = mirrorPinCode(pa);
        }
    }
    recomputeRoles();
    if (ringViolations().length) { restoreStructuralSnapshot(before); return false; }
    return true;
}

export {
    remapIdx, resizeGrid, expandForBorder, growTo, growBy, growSnapshot, clearGrid, getStructuralSnapshot,
    restoreStructuralSnapshot, normalizeRect, copyRegion, clearRegion, muxBlob, muxBodyCells, clearCells,
    pasteRegion, regionHasLocked, rotateFits, rotateRegionCW, mirrorRegionH,
};
