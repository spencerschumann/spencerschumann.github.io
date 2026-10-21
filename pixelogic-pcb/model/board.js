// The board: the one being worked on (B), and making, copying and
// switching boards (createBoard, cloneBoard, useBoard, withBoard) — plus
// reading and writing its cells, and a level's locked pads.

import {
    ID_INSULATOR_PLAIN, isXover,
} from './cells.js';

const CELL_SIZE = 32;
const DEFAULT_W = 48, DEFAULT_H = 30;
// The board being worked on (see Boards, below): its size, its cells and
// everything about them, in one object. The grid grows on demand (see
// expandForBorder) so drawing never runs out of room, so its dimensions
// are mutable.
let B = newBoard(DEFAULT_W, DEFAULT_H);

function idx(x, y) { return y * B.w + x; }
function inBounds(x, y) { return x >= 0 && x < B.w && y >= 0 && y < B.h; }
function getCell(x, y) { return inBounds(x, y) ? B.cells[idx(x, y)] : ID_INSULATOR_PLAIN; }
function setCellRaw(x, y, id) { if (inBounds(x, y)) B.cells[idx(x, y)] = id; }

// Locked cells (game.js): the campaign's fixed input/output pads. Every
// structural edit path refuses to touch one, so a level's terminals stay
// where the verifier expects them however the player rearranges the rest.
// Empty (all zero) in the sandbox, which is the only state the editor
// itself ever produces. (`B.locked`, and `B.anyLocked` while any is.)
function isLocked(x, y) { return B.anyLocked && inBounds(x, y) && B.locked[idx(x, y)] === 1; }

// Replaces the whole lock set with the given cell list ([[x,y],...]).
// Called once when a level loads and cleared on the way back to the
// sandbox; nothing incremental, so there's no partial state to get wrong.
function setLockedCells(list) {
    B.locked.fill(0);
    B.anyLocked = false;
    for (const [x, y] of (list || [])) {
        if (!inBounds(x, y)) continue;
        B.locked[idx(x, y)] = 1;
        B.anyLocked = true;
    }
}
function lockedCells() {
    const out = [];
    if (!B.anyLocked) return out;
    for (let i = 0; i < B.locked.length; i++)
        if (B.locked[i] === 1) out.push([i % B.w, Math.floor(i / B.w)]);
    return out;
}

// A pin of a block record, copied: its name and way, and — for a pin that
// is a nested part's pin (`via`: that part, `viaPin`: which of its pins) —
// that too, its part renamed by `rename` (ids to clip lids, or back) where
// the copy needs it. A part's pin is usually a cell of its own; one `via`
// a nested part has none, and is wherever that part's pin is.
const copyPin = (p, rename) => {
    const out = { name: p.name, dir: p.dir };
    if (p.via) {
        const v = rename ? rename(p.via) : p.via;
        if (v) { out.via = v; out.viaPin = p.viaPin | 0; }
    }
    return out;
};
// A pin read from outside (a save, an import): checked, `via` included.
const readPin = (p) => {
    const out = { name: String((p && p.name) || '?').slice(0, 12), dir: p && p.dir === 'out' ? 'out' : 'in' };
    if (p && Number.isInteger(p.via) && p.via > 0 && Number.isInteger(p.viaPin) && p.viaPin >= 0) {
        out.via = p.via;
        out.viaPin = p.viaPin;
    }
    return out;
};
// How an array repeats, on its lid's record (`rep`): which part, which
// way, how far apart, its pins' roles, which end is bit 0 — so that one
// already down can be set out again as it was. Read from outside, checked;
// null if there is none.
const readRep = (r) => {
    if (!r || typeof r !== 'object' || typeof r.key !== 'string' || !Number.isInteger(r.dir) || !Number.isInteger(r.pitch)) return null;
    const names = (a) => (Array.isArray(a) ? a.slice(0, 64).map((s) => String(s).slice(0, 12)) : []);
    const out = { key: r.key.slice(0, 80), dir: r.dir & 3, pitch: Math.max(1, Math.min(999, r.pitch | 0)), reverse: !!r.reverse, shared: names(r.shared), taps: names(r.taps) };
    if (Number.isInteger(r.tapSide)) out.tapSide = r.tapSide & 3;
    return out;
};
// A block record with its `rep`, if it has one, copied over from `r`.
const withRep = (out, r) => {
    const rep = r && readRep(r.rep);
    if (rep) out.rep = rep;
    return out;
};
const copyBlockRec = (r) => withRep({
    id: r.id, name: r.name, source: r.source, parent: r.parent, open: !!r.open,
    pins: r.pins.map((p) => copyPin(p)),
}, r);

// A crossover: a cell of its own (see cells.js), whose two axes pass over
// each other without connecting — whatever is round it. (It was read off
// the shape round the cell once, and flipped to a T and back as wire was
// drawn and erased near it.)
function isCrossoverAt(x, y) {
    return isXover(getCell(x, y));
}

// ===== Boards =====
//
// A board is a value: everything one board is — its size, its cells and
// their charge, its parts, a level's locked pads, the ratsnest, its tick
// count, and what is derived from those — in one plain object of typed
// arrays and maps. The model works on one board at a time, the ACTIVE
// one, `B`; every read and write of board state goes through it, so
// switching boards is one assignment.
//
// So a second board — a copy to verify on, a part alone on its test
// bench, a level's saved board being rebuilt as a part — is made and
// worked on without the board being edited ever being touched
// (withBoard), where it used to be overwritten and put back. And a
// board's arrays are ready to hand to a worker or a GPU as they stand.
//
// Every board has the same fields, made in the same order (newBoard,
// cloneBoard), so the engine sees one shape of object and the hot loops
// stay fast.
function newBoard(w, h) {
    const n = w * h;
    return {
        w, h, cells: new Uint8Array(n), nextCells: new Uint8Array(n), roles: new Array(n).fill(null), tickCount: 0,
        locked: new Uint8Array(n), anyLocked: false,
        blockAt: new Int32Array(n), pinAt: new Int16Array(n), blocks: new Map(), nextBlockId: 1,
        blockGeom: new Map(), ringMask: new Uint8Array(n), ringCache: new Map(),
        pendingLinks: [], rev: 0,
    };
}
// Saved, an array is its runs: a long run of one value is most of a board
// (bare substrate; a part's id over its whole core), so "v*n" is n cells
// of v and "v" one, comma-separated — an empty 48x30 board is "0*1440".
function packRuns(a) {
    const out = [];
    for (let i = 0; i < a.length;) {
        const v = a[i];
        let j = i + 1;
        while (j < a.length && a[j] === v) j++;
        out.push(j - i > 1 ? `${v}*${j - i}` : String(v));
        i = j;
    }
    return out.join(',');
}
// An array as saved — runs, or a plain array as older saves have it — or
// null if it is neither, is malformed, or runs past `cap` values (a
// mangled or hostile save is refused rather than allocated).
function unpackRuns(s, cap) {
    if (typeof s !== 'string') return Array.isArray(s) || ArrayBuffer.isView(s) ? s : null;
    const out = [];
    if (!s) return out;
    for (const part of s.split(',')) {
        const star = part.indexOf('*');
        const v = Number(star < 0 ? part : part.slice(0, star)), k = star < 0 ? 1 : Number(part.slice(star + 1));
        if (!Number.isInteger(v) || !Number.isInteger(k) || k < 1 || out.length + k > cap) return null;
        for (let i = 0; i < k; i++) out.push(v);
    }
    return out;
}
// A new board, w x h, bare.
function createBoard(w, h) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w * h > MAX_CELLS) throw new Error(`A ${w}x${h} board is too big`);
    return newBoard(w, h);
}
// The board being worked on — the object itself, so what is done to the
// model from here on is done to it.
function activeBoard() { return B; }
// Work on `b` from here on. Returns the board that was active.
function useBoard(b) {
    const was = B;
    B = b;
    return was;
}
// fn(), with `b` the active board; then the board that was active is
// again, whatever fn does — a throw included. Returns what fn does.
let lent = 0;
function withBoard(b, fn) {
    const was = useBoard(b);
    lent++;
    try { return fn(); } finally { lent--; useBoard(was); }
}
// Whether the active board is one lent for a while (withBoard) — a copy
// being verified, say — rather than the one being worked on.
const boardLent = () => lent > 0;
// A board exactly as `b` is — charge, locks, parts, ratsnest and tick
// included — sharing nothing with it that either could change. (What
// is derived is rebuilt rather than edited, never changed in place, so
// a copy may start out sharing its records.)
function cloneBoard(b) {
    return {
        w: b.w, h: b.h, cells: b.cells.slice(), nextCells: new Uint8Array(b.cells.length), roles: b.roles.slice(), tickCount: b.tickCount,
        locked: b.locked.slice(), anyLocked: b.anyLocked,
        blockAt: b.blockAt.slice(), pinAt: b.pinAt.slice(),
        blocks: new Map([...b.blocks].map(([id, r]) => [id, copyBlockRec(r)])), nextBlockId: b.nextBlockId,
        blockGeom: new Map(b.blockGeom), ringMask: b.ringMask.slice(), ringCache: new Map(b.ringCache),
        pendingLinks: b.pendingLinks.map((l) => l.slice()), rev: b.rev,
    };
}

// Far past any board anyone draws (2048x2048), but small enough that a
// mangled or hostile import is refused instead of allocating gigabytes.
const MAX_CELLS = 1 << 22;

export {
    CELL_SIZE, DEFAULT_W, DEFAULT_H, B, idx, inBounds, getCell, setCellRaw, isLocked, setLockedCells,
    lockedCells, isCrossoverAt, copyPin, readPin, readRep, withRep, copyBlockRec, newBoard, createBoard, activeBoard, useBoard, withBoard, boardLent,
    cloneBoard, MAX_CELLS, packRuns, unpackRuns,
};
