// Parts placed whole (blocks): their records, where they are, their pins,
// and their edges — which cells round a part are its terminals, which must
// stay bare and which are free (classifyRing, ringMask).

import {
    DIRS, ID_CONDUCTOR_BASE, ID_INSULATOR_PLAIN, ID_NEG, ID_POS, armInto, crossingFrom, hasMuxLead, isConductorId, isMuxId,
    isInsulatorId, isLed, isSwitch, isToggle, isWireId, isXover, muxDirOf, stripId,
} from './cells.js';
import {
    B, copyBlockRec, idx, inBounds, isCrossoverAt,
} from './board.js';
import {
    recomputeRoles,
} from './edit.js';

// ===== Blocks: a part placed whole =====
//
// A block is a circuit dropped onto the board at full size — its own
// cells, simulated exactly like any others — plus a record of what it
// is: a name, its pins and what they are called, the blocks nested inside
// it, and whether its lid is shut. The pixels cannot say any of that, so
// it rides alongside them: two per-cell arrays (which block holds a cell,
// which pin leaves it) and a map of records. Everything that moves cells
// carries the arrays with them.
//
// A cell belongs to the innermost block holding it; the blocks around
// that one are its ancestors (`parent`). Block cells are off limits to
// every ordinary edit — paint, erase, paste, the router — the way a
// level's locked pads are. The only ways to change one are to take the
// whole block (erase, move, copy, turn) or to decap it, which drops the
// record and leaves its cells as loose parts.
//
// A block's cells are its CORE: the muxes, sources and wiring of its
// circuit and nothing else. Its terminals are not its cells. A pin is a
// core cell and a face of it — `pinAt` holds pinCode(pin, face) — and the
// pin's TERMINAL is the cell just outside that face: where a wire, a
// switch or another part's terminal wire goes to connect. The ring of
// cells round the core is the block's EDGE, and each of those cells is
// one of three kinds (classifyRing): a terminal; a cell that must stay
// bare substrate, because anything there would join the circuit or make
// a mux read itself differently; or a cell nothing inside cares about,
// free for anything — another part's edge included. Edges are not stored:
// they are worked out from the core, and kept (ringMask) so every edit
// can respect them.
const RING_R = 1, RING_T = 2;
// A pin's cell value: which pin, and which face of the cell it leaves by
// (an index into DIRS: north, east, south, west). That is the pin's own
// terminal, the one arrays and layouts use; the edge beside the rest of
// its wire is its terminal too (see classifyRing), and needs no marking.
const pinCode = (k, d) => k * 4 + d + 1;
const pinIndex = (v) => (v - 1) >> 2;
const pinFaceOf = (v) => (v - 1) & 3;
const turnPinCode = (v, turns) => (v ? pinCode(pinIndex(v), (pinFaceOf(v) + turns + 4) & 3) : 0);
const mirrorPinCode = (v) => (v ? pinCode(pinIndex(v), [0, 3, 2, 1][pinFaceOf(v)]) : 0);

function blockParent(id) { const r = B.blocks.get(id); return r ? r.parent : 0; }
// Cells no edit may write: a block's own cells, a level's locked pads, and
// cells a block's edge keeps bare.
function isProtected(x, y) {
    if (!inBounds(x, y)) return false;
    const i = idx(x, y);
    return B.blockAt[i] !== 0 || (B.anyLocked && B.locked[i] === 1) || (B.ringMask[i] & RING_R) !== 0;
}
// A cell some block's edge has as a terminal: wire may go there, mux body
// may not.
function isTerminalCell(x, y) { return inBounds(x, y) && (B.ringMask[idx(x, y)] & RING_T) !== 0; }
// Is cell i inside block `id`, directly or nested deeper?
function cellInBlock(i, id) {
    for (let b = B.blockAt[i]; b; b = blockParent(b)) if (b === id) return true;
    return false;
}
function topBlockOf(id) {
    let b = id;
    while (b && blockParent(b)) b = blockParent(b);
    return b;
}
// Every cell of block `id`, nested blocks included, as flat indices.
function blockCellIdxs(id) {
    const g = B.blockGeom.get(id);
    if (!g) return [];
    const out = [];
    for (let y = g.y0; y <= g.y1; y++)
        for (let x = g.x0; x <= g.x1; x++) {
            const i = idx(x, y);
            if (B.blockAt[i] && cellInBlock(i, id)) out.push(i);
        }
    return out;
}
// Blocks whose every cell lies inside a rectangle.
function blocksInside(r) {
    const out = new Set();
    for (const [id, g] of B.blockGeom)
        if (g.x0 >= r.x0 && g.x1 <= r.x1 && g.y0 >= r.y0 && g.y1 <= r.y1) out.add(id);
    return out;
}

// Where each block is, re-read from the cell arrays after any change
// (recomputeRoles calls it). A cell naming a block with no record, or a
// record with no cells left, is dropped rather than drawn half-there.
function computeBlockGeom() {
    B.blockGeom = new Map();
    if (!B.blocks.size) {
        // Nothing to find — but a stray id left in the arrays must not
        // survive to be read as a block later.
        for (let i = 0; i < B.blockAt.length; i++) if (B.blockAt[i]) { B.blockAt[i] = 0; B.pinAt[i] = 0; }
        return;
    }
    for (let i = 0; i < B.blockAt.length; i++) {
        const b0 = B.blockAt[i];
        if (!b0) continue;
        if (!B.blocks.has(b0)) { B.blockAt[i] = 0; B.pinAt[i] = 0; continue; }
        const x = i % B.w, y = (i - x) / B.w;
        for (let b = b0; b; b = blockParent(b)) {
            const rec = B.blocks.get(b);
            if (!rec) break;
            let g = B.blockGeom.get(b);
            if (!g) {
                g = { x0: x, y0: y, x1: x, y1: y, pins: rec.pins.map(() => null), count: 0 };
                B.blockGeom.set(b, g);
            }
            if (x < g.x0) g.x0 = x;
            if (x > g.x1) g.x1 = x;
            if (y < g.y0) g.y0 = y;
            if (y > g.y1) g.y1 = y;
            g.count++;
        }
        const p = B.pinAt[i];
        if (p) {
            const g = B.blockGeom.get(b0);
            if (pinIndex(p) >= g.pins.length) B.pinAt[i] = 0;
            else g.pins[pinIndex(p)] = { host: [x, y], d: pinFaceOf(p) };
        }
    }
    for (const id of [...B.blocks.keys()]) if (!B.blockGeom.has(id)) B.blocks.delete(id);
    // A pin `via` a nested part is wherever that part's pin is — so long as
    // it is a part directly inside this one.
    const resolve = (id, k, depth) => {
        const rec = B.blocks.get(id), g = B.blockGeom.get(id), p = rec && rec.pins[k];
        if (!p || !g) return null;
        if (!p.via) return g.pins[k];
        if (depth > 8 || blockParent(p.via) !== id) return null;
        return resolve(p.via, p.viaPin, depth + 1);
    };
    for (const [id, rec] of B.blocks) {
        const g = B.blockGeom.get(id);
        rec.pins.forEach((p, k) => { if (p.via) g.pins[k] = resolve(id, k, 0); });
    }
}

// Every block, outermost first, with where it is, where its pins are and
// its edge. A pin: `host` is its core cell, `face` the way it leaves, and
// `at` its terminal — the cell outside that face; `others`, its other
// terminals, the same way ([{host, face, at}]: the edge beside the rest of
// its wire). `hidden` is true when some block around it has its lid shut.
// `rep`, on an array's lid: how it repeats (see readRep).
//
// Worked out once per revision of the board (B.rev) and kept: the view asks
// for it every frame, and working out each part's edge means reading its
// whole box. The list is shared, so it is read-only.
let blockListKept = { board: null, rev: -1, list: null };
function blockList() {
    if (blockListKept.board === B && blockListKept.rev === B.rev) return blockListKept.list;
    const out = [];
    for (const [id, rec] of B.blocks) {
        const g = B.blockGeom.get(id);
        if (!g) continue;
        const ring = ringOfBlock(id), others = terminalsByPin(ring, g, rec.pins.length);
        let depth = 0, hidden = false;
        for (let p = rec.parent; p; p = blockParent(p)) {
            depth++;
            if (B.blocks.get(p) && !B.blocks.get(p).open) hidden = true;
        }
        out.push({
            id, name: rec.name, source: rec.source, parent: rec.parent, open: rec.open, depth, hidden,
            x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1,
            pins: rec.pins.map((p, k) => {
                const q = g.pins[k];
                if (!q) return { name: p.name, dir: p.dir, at: null, host: null, face: null, others: others[k] };
                const [dx, dy] = DIRS[q.d], at = [q.host[0] + dx, q.host[1] + dy];
                return {
                    name: p.name, dir: p.dir, host: q.host, face: [dx, dy], at,
                    others: others[k].filter((t) => t.at[0] !== at[0] || t.at[1] !== at[1]),
                };
            }),
            ring: [...ring.values()],
            rep: rec.rep || null,
        });
    }
    out.sort((a, b) => a.depth - b.depth);
    blockListKept = { board: B, rev: B.rev, list: out };
    return out;
}
function blockInfo(id) { return blockList().find((b) => b.id === id) || null; }
// Each pin's terminals on an edge, by pin: [{host, face, at}] — `at` the
// edge cell, `host` the core cell beside it (core: {x0, y0, x1, y1}).
function terminalsByPin(ring, core, n) {
    const out = Array.from({ length: n }, () => []);
    for (const e of ring.values()) {
        if (e.cls !== 'T' || !(e.pin >= 0 && e.pin < n)) continue;
        const hx = Math.min(Math.max(e.x, core.x0), core.x1), hy = Math.min(Math.max(e.y, core.y0), core.y1);
        out[e.pin].push({ host: [hx, hy], face: [e.x - hx, e.y - hy], at: [e.x, e.y] });
    }
    return out;
}

// The innermost block holding (x,y), or 0.
function blockAtCell(x, y) { return inBounds(x, y) ? B.blockAt[idx(x, y)] : 0; }
// The block a click at (x,y) is about: the outermost one with its lid
// shut (everything inside that is out of sight), or else the innermost.
function visibleBlockAt(x, y) {
    if (!inBounds(x, y)) return 0;
    const chain = [];
    for (let b = B.blockAt[idx(x, y)]; b; b = blockParent(b)) chain.push(b);
    for (let k = chain.length - 1; k >= 0; k--) if (!B.blocks.get(chain[k]).open) return chain[k];
    return chain.length ? chain[0] : 0;
}
// Whose edge a cell is on, and as what: [{id, cls, pin}] for the
// outermost blocks whose edge includes it.
function edgeAt(x, y) {
    const out = [];
    if (!inBounds(x, y) || !B.ringMask[idx(x, y)]) return out;
    for (const id of B.blocks.keys()) {
        if (blockParent(id)) continue;
        const r = ringOfBlock(id).get(x + ',' + y);
        if (r) out.push({ id, cls: r.cls, pin: r.pin });
    }
    return out;
}
function setBlockOpen(id, open) {
    const r = B.blocks.get(id);
    if (!r) return false;
    r.open = !!open;
    B.rev++;
    return true;
}
// Erase a block, nested blocks and all.
function removeBlock(id) {
    const list = blockCellIdxs(id);
    if (!list.length) return false;
    for (const i of list) { B.cells[i] = ID_INSULATOR_PLAIN; B.blockAt[i] = 0; B.pinAt[i] = 0; }
    recomputeRoles();
    return true;
}
// Take the lid off for good: the record goes, and its cells become loose
// parts of whatever it sat in (the board, or the block around it). Blocks
// nested inside it stay blocks, one level further out. Its edge goes
// with it: what was kept bare is ordinary board again.
function decapBlock(id) {
    const rec = B.blocks.get(id);
    if (!rec) return false;
    for (let i = 0; i < B.blockAt.length; i++)
        if (B.blockAt[i] === id) { B.blockAt[i] = rec.parent; B.pinAt[i] = 0; }
    for (const r of B.blocks.values()) if (r.parent === id) r.parent = rec.parent;
    B.blocks.delete(id);
    recomputeRoles();
    return true;
}
// Everything about the blocks, for a snapshot. (The edges are worked out
// again from the cores.)
function blockState() {
    return {
        at: B.blockAt.slice(), pin: B.pinAt.slice(),
        recs: [...B.blocks.values()].map(copyBlockRec), next: B.nextBlockId,
    };
}
function restoreBlockState(s) {
    if (!s || s.at.length !== B.blockAt.length) {
        B.blockAt.fill(0); B.pinAt.fill(0); B.blocks = new Map();
        return;
    }
    B.blockAt.set(s.at);
    B.pinAt.set(s.pin);
    B.blocks = new Map(s.recs.map((r) => [r.id, copyBlockRec(r)]));
    B.nextBlockId = Math.max(B.nextBlockId, s.next || 1);
}

// ===== A part's edge =====
//
// Every cell of the ring round a core, as one of:
//   'T' — a terminal: where a wire (or a switch, a lamp, another part's
//         terminal) goes to connect to the pin inside;
//   'R' — kept bare: anything there would join the circuit inside;
//   'X' — nothing inside cares: free for anything, another part's edge
//         included.
//
// A part is only its cells grouped, so whatever is put beside a pin's
// wire joins that pin, wherever along the edge it is: the edge beside a
// pin's wire is that pin's terminal, all of it, and not only the cell
// its own lead faces (a pad as wide as the wire runs). It is kept bare
// only where a wire there would cut the pin's wire in two — a fourth
// wire on a tee makes it a crossing, whose two ways are then joined
// nowhere else (beside a blob of wire it only makes the blob bigger) —
// and beside any wire that is no pin's. Each cell is judged alone: two
// that are each fine can cut it together (both sides of a corner the
// wire turns), and the second is refused as it is wired (cutsPartWire).
//
// Next to a mux it is simple, since a mux means what its cells say
// whatever lies against it: the cell a lead faces is kept bare (or is
// the terminal, if that lead is a pin of the part), and every other is
// free.
//
// `core`: {x0, y0, x1, y1, id(x, y), nested(x, y) → a block inside it (0
// for its own cells), ringOf(b) → that block's edge, pins: [{hx, hy, d,
// k, dir}]}. Returns a Map 'x,y' -> {x, y, cls, pin}.
function classifyRing(core) {
    const key = (x, y) => x + ',' + y;
    const inCore = (x, y) => x >= core.x0 && x <= core.x1 && y >= core.y0 && y <= core.y1;
    const termOf = new Map();
    for (const p of core.pins) {
        const [dx, dy] = DIRS[p.d];
        termOf.set(key(p.hx + dx, p.hy + dy), p);
    }
    const wires = pinWires(core, inCore, key);
    const isW = (x, y) => inCore(x, y) && isWireId(core.id(x, y));
    const arm = (x, y, d) => inCore(x, y) && armInto(core.id(x, y), d);
    // Would a wire on (x, y), the rest of the edge bare, cut the wire of
    // (nx, ny) beside it?
    const cuts = (nx, ny, x, y) => {
        const w = (px, py) => isW(px, py) || (px === x && py === y), a = (px, py, d) => arm(px, py, d) || (px === x && py === y);
        return crossingFrom((d) => w(nx + DIRS[d][0], ny + DIRS[d][1]), (d) => a(nx + DIRS[d][0], ny + DIRS[d][1], d))
            && crossingCuts(w, inCore, nx, ny, a);
    };
    const ring = new Map();
    const put = (x, y, cls, pin) => ring.set(key(x, y), { x, y, cls, pin: pin ? pin.k : -1 });
    for (let y = core.y0 - 1; y <= core.y1 + 1; y++)
        for (let x = core.x0 - 1; x <= core.x1 + 1; x++) {
            if (inCore(x, y)) continue;
            const xin = x >= core.x0 && x <= core.x1, yin = y >= core.y0 && y <= core.y1;
            if (!xin && !yin) { put(x, y, 'X'); continue; }   // a corner only touches the ring
            const nx = xin ? x : (x < core.x0 ? core.x0 : core.x1);
            const ny = yin ? y : (y < core.y0 ? core.y0 : core.y1);
            const term = termOf.get(key(x, y));
            if (term) { put(x, y, 'T', term); continue; }
            // Beside a part inside: its edge, a terminal of ours where it
            // is one of a pin of its that is ours.
            const child = core.nested(nx, ny);
            if (child) {
                const e = core.ringOf(child).get(key(x, y)), p = e && e.cls === 'T' && wires.nested.get(child + ':' + e.pin);
                put(x, y, !e || e.cls === 'X' ? 'X' : p ? 'T' : 'R', p);
                continue;
            }
            const nid = core.id(nx, ny);
            if (isInsulatorId(nid)) { put(x, y, 'X'); continue; }
            if (!isMuxId(nid)) {
                // Wire, a source, a lamp: anything touching it joins it.
                const p = isWireId(nid) && wires.own.get(key(nx, ny));
                put(x, y, p && !cuts(nx, ny, x, y) ? 'T' : 'R', p);
                continue;
            }
            // Mux body: a mux joins what is on its lead and nothing
            // else, whatever lies round it, so the edge cell a lead faces
            // is kept bare (a pin's would have been a terminal, above)
            // and any other is free.
            const faces = hasMuxLead(nid) && nx + DIRS[muxDirOf[nid]][0] === x && ny + DIRS[muxDirOf[nid]][1] === y;
            put(x, y, faces ? 'R' : 'X');
        }
    return ring;
}
// Does a crossing at (cx, cy) cut its wire in two — its north-south way
// and its east-west way joined nowhere else? Walked from the cells north
// and south of it, never through it (and straight on over any other
// crossing), to see if the walk comes round to the cells east or west of
// it. `isW(x, y)`: wire there; `within(x, y)`: where the walk may go;
// `arm(x, y, d)`: an arm of the wire one step back the other way — a wire,
// or a mux's lead facing in (armInto) — wire alone if not given.
function crossingCuts(isW, within, cx, cy, arm) {
    const key = (x, y) => x + ',' + y;
    const armAt = arm || ((x, y) => isW(x, y));
    const cross = (x, y) => crossingFrom((d) => isW(x + DIRS[d][0], y + DIRS[d][1]), (d) => armAt(x + DIRS[d][0], y + DIRS[d][1], d));
    // A cell east or west reached the east-west way, if it is a crossing
    // itself: its other way is another wire.
    const goal = new Set([1, 3].map((d) => {
        const x = cx + DIRS[d][0], y = cy + DIRS[d][1];
        return key(x, y) + (cross(x, y) ? 'h' : '');
    }));
    const seen = new Set(), stack = [];
    const visit = (x, y, d) => {
        if ((x === cx && y === cy) || !within(x, y) || !isW(x, y)) return false;
        const c = cross(x, y), k = key(x, y) + (c ? (d & 1 ? 'h' : 'v') : '');
        if (goal.has(k)) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        for (const w of c ? [d] : [0, 1, 2, 3]) stack.push([x, y, w]);
        return false;
    };
    for (const d of [0, 2]) if (visit(cx + DIRS[d][0], cy + DIRS[d][1], d)) return false;
    while (stack.length) {
        const [x, y, w] = stack.pop();
        if (visit(x + DIRS[w][0], y + DIRS[w][1], w)) return false;
    }
    return true;
}
// Would a wire on (x, y) cut a part's wire beside it — make a crossing of
// an edge cell of it whose two ways are joined nowhere else, inside the
// part or out? (Its edge says no for each cell alone; two together can,
// as both sides of a corner the wire turns.) The part's id, or 0.
function cutsPartWire(x, y) {
    if (!inBounds(x, y) || isWireId(B.cells[idx(x, y)])) return 0;
    const isW = (px, py) => (px === x && py === y) || (inBounds(px, py) && isWireId(B.cells[idx(px, py)]));
    const arm = (px, py, d) => (px === x && py === y) || (inBounds(px, py) && armInto(B.cells[idx(px, py)], d));
    for (const [dx, dy] of DIRS) {
        const cx = x + dx, cy = y + dy;
        if (!inBounds(cx, cy) || !B.blockAt[idx(cx, cy)] || !isWireId(B.cells[idx(cx, cy)])) continue;
        if (!crossingFrom((d) => isW(cx + DIRS[d][0], cy + DIRS[d][1]), (d) => arm(cx + DIRS[d][0], cy + DIRS[d][1], d))) continue;
        if (crossingCuts(isW, inBounds, cx, cy, arm)) return topBlockOf(B.blockAt[idx(cx, cy)]);
    }
    return 0;
}
// Which pin each of a core's own wires is: followed from each pin's cell,
// wire to wire (straight on over a crossing), and on through the parts
// nested in it — a wire on a nested part's terminal is that part's pin,
// and goes on from every other terminal of it. A pin through a nested
// part (`via`) starts at that part's pin. The first pin to reach a wire
// has it. Returns {own: Map 'x,y' -> pin, nested: Map 'b:j' -> pin}.
function pinWires(core, inCore, key) {
    const own = new Map(), nested = new Map();
    const isW = (x, y) => inCore(x, y) && isWireId(core.id(x, y));
    const ownWire = (x, y) => isW(x, y) && !core.nested(x, y);
    const crossing = (x, y) => crossingFrom((d) => isW(x + DIRS[d][0], y + DIRS[d][1]),
        (d) => inCore(x + DIRS[d][0], y + DIRS[d][1]) && armInto(core.id(x + DIRS[d][0], y + DIRS[d][1]), d));
    for (const p of core.pins) {
        const seen = new Set(), stack = [];
        // A step onto (x, y), going way d (-1: from nowhere in particular).
        const visit = (x, y, d) => {
            const cross = crossing(x, y);
            const ways = cross ? (d < 0 ? [0, 1, 2, 3] : [d]) : [0, 1, 2, 3];
            const k = cross ? key(x, y) + (d < 0 ? '' : d & 1 ? 'h' : 'v') : key(x, y);
            if (seen.has(k)) return;
            seen.add(k);
            if (!cross && !own.has(key(x, y))) own.set(key(x, y), p);
            for (const w of ways) stack.push([x, y, w]);
        };
        // A nested part's pin is this pin: its wire goes on from every
        // other terminal of it — into this core's wire, or straight into
        // another nested part whose terminal for one of its own pins it
        // meets head on (stacked copies, a pin running up through them).
        const joinNested = (b, j) => {
            if (nested.has(b + ':' + j)) return;
            nested.set(b + ':' + j, p);
            for (const e of core.ringOf(b).values()) {
                if (e.cls !== 'T' || e.pin !== j || !inCore(e.x, e.y)) continue;
                const w = DIRS.findIndex(([dx, dy]) => core.nested(e.x - dx, e.y - dy) === b && inCore(e.x - dx, e.y - dy));
                if (ownWire(e.x, e.y)) { visit(e.x, e.y, w); continue; }
                const other = core.nested(e.x, e.y);
                if (!other || other === b || w < 0) continue;
                const back = core.ringOf(other).get(key(e.x - DIRS[w][0], e.y - DIRS[w][1]));
                if (back && back.cls === 'T') joinNested(other, back.pin);
            }
        };
        const via = core.nested(p.hx, p.hy);
        if (via) {
            const [dx, dy] = DIRS[p.d], e = core.ringOf(via).get(key(p.hx + dx, p.hy + dy));
            if (e && e.cls === 'T') joinNested(via, e.pin);
        } else if (ownWire(p.hx, p.hy)) visit(p.hx, p.hy, -1);
        while (stack.length) {
            const [x, y, w] = stack.pop(), [dx, dy] = DIRS[w], nx = x + dx, ny = y + dy;
            if (!inCore(nx, ny)) continue;
            const b = core.nested(nx, ny);
            if (b) {
                const e = core.ringOf(b).get(key(x, y));
                if (e && e.cls === 'T') joinNested(b, e.pin);
            } else if (ownWire(nx, ny)) visit(nx, ny, w);
        }
    }
    return { own, nested };
}

// A core on the board — a placed block's, or a rectangle being fitted —
// as classifyRing wants it.
// `asWire` (a set of cell indexes) reads those cells as plain wire: the
// pads a level part has had to take in (see fitPart).
function coreOnBoard(r, own, pins, asWire) {
    // The part directly inside this core that holds a cell (with no
    // `own`, the outermost part there), or 0 for the core's own cells.
    const child = (x, y) => {
        if (!inBounds(x, y)) return 0;
        let b = B.blockAt[idx(x, y)];
        if (!b || b === own) return 0;
        while (blockParent(b) && blockParent(b) !== own) b = blockParent(b);
        return own && blockParent(b) !== own ? 0 : b;
    };
    return {
        x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
        id: (x, y) => (!inBounds(x, y) ? ID_INSULATOR_PLAIN
            : asWire && asWire.has(idx(x, y)) ? ID_CONDUCTOR_BASE : B.cells[idx(x, y)]),
        nested: child,
        ringOf: ringOfBlock,
        pins,
    };
}
function blockSig(id, g) {
    let h = 0x811c9dc5;
    for (let y = g.y0; y <= g.y1; y++)
        for (let x = g.x0; x <= g.x1; x++) {
            const i = idx(x, y);
            h = Math.imul(h ^ stripId(B.cells[i]), 0x01000193);
            h = Math.imul(h ^ (B.blockAt[i] === id ? 0 : 1), 0x01000193);
            h = Math.imul(h ^ B.pinAt[i], 0x01000193);
        }
    return `${g.x0},${g.y0},${g.x1},${g.y1}:${h >>> 0}`;
}
// A placed block's edge, worked out once per shape and place.
function ringOfBlock(id) {
    const g = B.blockGeom.get(id);
    if (!g) return new Map();
    const sig = blockSig(id, g);
    const hit = B.ringCache.get(id);
    if (hit && hit.sig === sig) return hit.ring;
    const pins = [];
    const rec = B.blocks.get(id);
    g.pins.forEach((p, k) => { if (p) pins.push({ hx: p.host[0], hy: p.host[1], d: p.d, k, dir: rec.pins[k].dir }); });
    const ring = classifyRing(coreOnBoard(g, id, pins));
    B.ringCache.set(id, { sig, ring });
    return ring;
}
// The edges every edit has to respect, from the outermost blocks (a
// nested block's edge is inside its host, which is sealed anyway).
function computeRingMask() {
    if (B.ringMask.length !== B.cells.length) B.ringMask = new Uint8Array(B.cells.length);
    else B.ringMask.fill(0);
    for (const id of [...B.ringCache.keys()]) if (!B.blocks.has(id)) B.ringCache.delete(id);
    for (const id of B.blocks.keys()) {
        if (blockParent(id)) continue;
        for (const c of ringOfBlock(id).values()) {
            if (!inBounds(c.x, c.y)) continue;
            B.ringMask[idx(c.x, c.y)] |= c.cls === 'R' ? RING_R : c.cls === 'T' ? RING_T : 0;
        }
    }
}
// Cells where an edge is broken: something on a cell kept bare that
// joins the part there — a wire, a source, a mux whose lead faces it,
// another part's wire or pin — or wire on terminals that together cut the
// part's wire (see cutsPartWire). Anything else may sit against a part:
// on a terminal, whatever joins it there is joined to that pin, which is
// what a terminal is for (a mux's lead or another part's pin, straight
// on, with no wire between); and a mux's plain side, or another part's
// bare cell, joins nothing wherever it is.
function ringViolations() {
    const out = [];
    const isW = (x, y) => inBounds(x, y) && isWireId(B.cells[idx(x, y)]);
    for (const id of B.blocks.keys()) {
        if (blockParent(id)) continue;
        const g = B.blockGeom.get(id);
        for (const e of ringOfBlock(id).values()) {
            if (e.cls === 'X' || !inBounds(e.x, e.y)) continue;
            const [cx, cy] = edgeHost(g, e.x, e.y);
            if (e.cls === 'R') { if (cellsJoin(e.x, e.y, cx, cy)) out.push(idx(e.x, e.y)); continue; }
            if (isW(e.x, e.y) && isW(cx, cy) && isCrossoverAt(cx, cy) && crossingCuts(isW, inBounds, cx, cy)) out.push(idx(e.x, e.y));
        }
    }
    return out;
}
// The core cell an edge cell (x, y) is beside, `core` its box.
const edgeHost = (core, x, y) => [Math.min(Math.max(x, core.x0), core.x1), Math.min(Math.max(y, core.y0), core.y1)];
// Do the cells (ax, ay) and (bx, by), side by side, join — each meeting
// the other on that side?
function cellsJoin(ax, ay, bx, by) {
    return cellConnects(ax, ay, [bx - ax, by - ay]) && cellConnects(bx, by, [ax - bx, ay - by]);
}

// Whether the cell at (x,y) is something a wire visually/electrically
// joins onto — used to decide which of a wire pixel's four sides should
// actually be drawn reaching toward that neighbor (see view.js's thin-
// wire rendering) rather than filling the whole cell regardless of what,
// if anything, is actually there. Mirrors contribCharge's notion of "does
// this cell conduct" but direction-agnostic and boolean: a crossover's
// two axes are kept separate for charge, but both still read as "wire is
// here" for this shape/connectivity purpose.
// `out`, when given, is the direction from (x,y) toward whoever is
// asking. Only a mux cares: its cells connect on one face and are
// package everywhere else, so a neighbor that asks direction-agnostically
// gets "yes" from a pin it is merely sitting beside. That is what turned
// a wire elbowing past a pin into a tee with an arm buried in the
// plastic. Everything else here is per-cell and ignores `out`.
function cellConnects(x, y, out) {
    if (!inBounds(x, y)) return false;
    const i = idx(x, y), pc = B.blockAt[i] ? B.pinAt[i] : 0;
    return idConnects(B.cells[i], pc ? pinFaceOf(pc) : -1, out);
}
// The same for a cell that is not on the board yet: its id, and the face
// of the part's pin it is (-1 if none).
function idConnects(id, pinFace, out) {
    if (isInsulatorId(id)) return false;
    if (isConductorId(id) || isXover(id)) return true;
    if (id === ID_POS || id === ID_NEG) return true;
    if (isLed(id) || isSwitch(id) || isToggle(id)) return true;
    if (isMuxId(id)) {
        // A part's pin on a mux inside it connects on the pin's face,
        // and only there: that is what the part is.
        if (pinFace >= 0) {
            const [fx, fy] = DIRS[pinFace];
            return !out || (fx === out[0] && fy === out[1]);
        }
        // A mux cell connects through its lead and nowhere else — its
        // four leads are the four the view draws, and the rest of the
        // outline is package.
        if (!hasMuxLead(id)) return false;
        const [lx, ly] = DIRS[muxDirOf[id]];
        return !out || (lx === out[0] && ly === out[1]);
    }
    return false;
}

export {
    RING_R, RING_T, pinCode, pinIndex, pinFaceOf, turnPinCode, mirrorPinCode, blockParent, isProtected, terminalsByPin,
    isTerminalCell, cellInBlock, topBlockOf, blockCellIdxs, blocksInside, computeBlockGeom, blockList,
    blockInfo, blockAtCell, visibleBlockAt, edgeAt, setBlockOpen, removeBlock, decapBlock, blockState,
    restoreBlockState, classifyRing, coreOnBoard, blockSig, ringOfBlock, computeRingMask, ringViolations, cutsPartWire,
    cellConnects, idConnects, cellsJoin, edgeHost,
};
