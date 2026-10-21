// Saving and loading a board: serialize, deserialize.

import {
    ID_INSULATOR_PLAIN, inferCrossings, isValidId,
} from './cells.js';
import {
    readPin, B, MAX_CELLS, copyBlockRec, packRuns, unpackRuns, withRep,
} from './board.js';
import {
    restartTicks,
} from './sim.js';
import {
    pinIndex, topBlockOf,
} from './blocks.js';
import {
    plainIfLone, recomputeRoles,
} from './edit.js';
import {
    resizeGrid,
} from './regions.js';

// Blocks, when there are any, as their records plus the two cell arrays.
// `xo`: its crossings are cells of their own. A save without it is from
// before, and is read by the rule it was drawn under (inferCrossings).
function serialize() {
    const o = { w: B.w, h: B.h, xo: 1, cells: packRuns(B.cells) };
    if (B.blocks.size) {
        o.blocks = {
            pv: 2, recs: [...B.blocks.values()].map(copyBlockRec),
            at: packRuns(B.blockAt), pin: packRuns(B.pinAt),
        };
    }
    return JSON.stringify(o);
}

// Replaces the board wholesale, so the old board's ratsnest goes with it
// (resizeGrid drops it): its flat indices would otherwise be read as
// cells of the new board, and could come back as a dashed line between
// two unrelated things there.
// Saved blocks, checked the way sanitizeClip checks a clip's.
function loadBlocks(b) {
    B.blocks = new Map();
    B.blockAt.fill(0);
    B.pinAt.fill(0);
    const at = b && unpackRuns(b.at, B.blockAt.length), pins = b && unpackRuns(b.pin, B.blockAt.length);
    if (!b || !Array.isArray(b.recs) || !at || at.length !== B.blockAt.length) return;
    for (const r of b.recs) {
        if (!r || !Number.isInteger(r.id) || r.id <= 0 || B.blocks.has(r.id)) continue;
        B.blocks.set(r.id, withRep({
            id: r.id, name: String(r.name || 'Part').slice(0, 40), source: r.source ? String(r.source) : '',
            parent: Number.isInteger(r.parent) ? r.parent : 0, open: !!r.open,
            pins: (Array.isArray(r.pins) ? r.pins : []).slice(0, 256).map(readPin),
        }, r));
    }
    for (const r of B.blocks.values()) {
        let p = r.parent, steps = 0;
        while (p && B.blocks.has(p) && p !== r.id && steps++ < B.blocks.size) p = B.blocks.get(p).parent;
        if (!B.blocks.has(r.parent) || p === r.id || steps >= B.blocks.size) r.parent = 0;
    }
    for (const r of B.blocks.values())
        for (const p of r.pins) {
            const child = p.via && B.blocks.get(p.via);
            if (p.via && !(child && child.parent === r.id && p.viaPin < child.pins.length)) { delete p.via; delete p.viaPin; }
        }
    for (let i = 0; i < B.blockAt.length; i++) {
        const id = at[i] | 0;
        if (B.blocks.has(id)) B.blockAt[i] = id;
    }
    for (let i = 0; i < B.blockAt.length; i++) {
        const id = B.blockAt[i], p = id && pins ? pins[i] | 0 : 0;
        if (p > 0 && pinIndex(p) < B.blocks.get(id).pins.length) B.pinAt[i] = p;
    }
    onePiece();
    for (const id of B.blocks.keys()) if (id >= B.nextBlockId) B.nextBlockId = id + 1;
}

// A part is one piece — its rectangle. Cells of one cut off from the rest
// are not the part's: Rearrange once left a crossing inside a part behind
// as wire still marked as the part's, and the part's outline stretched back
// to it. The cell itself stays, as whatever it is.
function onePiece() {
    const top = new Int32Array(B.blockAt.length);
    for (let i = 0; i < top.length; i++) if (B.blockAt[i]) top[i] = topBlockOf(B.blockAt[i]);
    const pieces = new Map(), seen = new Uint8Array(top.length);
    for (let s = 0; s < top.length; s++) {
        if (!top[s] || seen[s]) continue;
        const piece = [s];
        seen[s] = 1;
        for (let k = 0; k < piece.length; k++) {
            const i = piece[k], x = i % B.w;
            for (const j of [x > 0 ? i - 1 : -1, x < B.w - 1 ? i + 1 : -1, i - B.w, i + B.w]) {
                if (j < 0 || j >= top.length || seen[j] || top[j] !== top[s]) continue;
                seen[j] = 1;
                piece.push(j);
            }
        }
        if (!pieces.has(top[s])) pieces.set(top[s], []);
        pieces.get(top[s]).push(piece);
    }
    for (const list of pieces.values()) {
        if (list.length < 2) continue;
        const keep = list.reduce((a, b) => (b.length > a.length ? b : a));
        for (const piece of list) if (piece !== keep) for (const i of piece) { B.blockAt[i] = 0; B.pinAt[i] = 0; }
    }
}

function deserialize(text) {
    try {
        const data = JSON.parse(text);
        const cells = data && unpackRuns(data.cells, MAX_CELLS);
        if (!cells) return false;
        // Restore the saved size (grids grow, so it may differ from now).
        const w = Number.isInteger(data.w) && data.w > 0 ? data.w : B.w;
        const h = Number.isInteger(data.h) && data.h > 0 ? data.h : B.h;
        if (w * h > MAX_CELLS) return false;
        resizeGrid(w, h, 0, 0, false);
        const n = Math.min(cells.length, B.cells.length);
        for (let i = 0; i < n; i++) {
            const v = cells[i] & 0xff;
            B.cells[i] = isValidId(v) ? v : ID_INSULATOR_PLAIN;
        }
        if (!data.xo) inferCrossings(B.cells, B.w, B.h);
        loadBlocks(data.blocks);
        // A crossing left crossing nothing, from before that made it plain
        // wire (plainIfLone): the same circuit either way.
        for (let i = 0; i < B.cells.length; i++) plainIfLone(i);
        restartTicks();
        recomputeRoles();
        return true;
    } catch (e) {
        return false;
    }
}

export {
    serialize, loadBlocks, deserialize,
};
