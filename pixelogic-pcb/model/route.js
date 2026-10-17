// The router Rearrange uses: walking a net, working out which of its wire
// is still needed (reduceNet), and laying the shortest clean route between
// two places (routeNet).

import {
    DIRS, isMuxId, isInsulatorId, isLed, isSwitch, isToggle, isWireId,
} from './cells.js';
import {
    B, getCell, idx, inBounds, isCrossoverAt,
} from './board.js';
import {
    RING_R, cellConnects,
} from './blocks.js';
import {
    flood8,
} from './rearrange.js';

// The electrical net reachable from a wire cell, walked over the CURRENT
// grid (call after lifting the object, so the walk sees only the
// stationary world): plain conductors spread all four ways, a crossover
// only passes straight through (its two axes are separate nets), and
// every non-wire connecting neighbor is recorded as a terminal
// (pin/pad/source) rather than entered. Crossover cells are
// pass-throughs, not members — you can't attach to one axis of a
// crossover by adjacency anyway. (entryDx/entryDy: the direction the
// walk enters the first cell with, in case that cell is itself a
// crossover.)
// `xo` says which cells are crossings (default: the board's own test); a
// move passes one that remembers the crossings it started with.
function floodNet(ax, ay, entryDx, entryDy, xo) {
    const crossing = xo || isCrossoverAt;
    const cellsOut = new Set(), terminals = new Set(), seen = new Set();
    const stack = [[ax, ay, entryDx, entryDy]];
    while (stack.length) {
        const [x, y, dx2, dy2] = stack.pop();
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        // A block's pin is a terminal from out here (see walkNet).
        if (!isWireId(B.cells[i]) || B.blockAt[i]) {
            // Reached from (dx2,dy2), so this cell must connect on the
            // face pointing back that way — a wire lying against a mux's
            // package is not attached to it.
            if (cellConnects(x, y, [-dx2, -dy2])) terminals.add(i);
            continue;
        }
        if (crossing(x, y)) {
            const k = i + (dx2 !== 0 ? ':h' : ':v');
            if (seen.has(k)) continue;
            seen.add(k);
            stack.push([x + dx2, y + dy2, dx2, dy2]);
            continue;
        }
        if (seen.has(i)) continue;
        seen.add(i);
        cellsOut.add(i);
        for (const [ddx, ddy] of DIRS) stack.push([x + ddx, y + ddy, ddx, ddy]);
    }
    let min = Infinity;
    for (const i of cellsOut) if (i < min) min = i;
    if (min === Infinity) for (const i of terminals) if (i < min) min = i;
    return {
        key: 'w' + (min === Infinity ? idx(ax, ay) : min), cells: cellsOut, terminals,
        isNet: true, preTouch: new Set(), routed: new Set(), failed: false,
    };
}

// Every terminal on the board — anything that connects and is not wire:
// a mux's leads, a pad (as a whole), a source, a part's pin — with the
// group it is wired into: Map terminal id -> group id. Terminals join
// through a wire net they both touch (on a face that connects), or by
// touching each other directly. Ids go through `mapIdx`, so a board
// after a move can be compared cell for cell with the board before.
// `netOf`, if given, is filled in with the terminal standing for each
// cell's net (a terminal for itself), for asking about a cell later.
function terminalGroups(mapIdx, netOf) {
    const parent = new Map();
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const padKey = new Map();
    const termId = (i) => {
        const id = B.cells[i];
        if (!(isLed(id) || isSwitch(id) || isToggle(id))) return 'c' + mapIdx(i);
        if (!padKey.has(i)) {
            const x = i % B.w, y = (i - x) / B.w, n = anchorNode(x, y);
            let min = Infinity;
            for (const c of n.cells) min = Math.min(min, mapIdx(c));
            for (const c of n.cells) padKey.set(c, 'p' + min);
        }
        return padKey.get(i);
    };
    const add = (t) => { if (!parent.has(t)) parent.set(t, t); return t; };
    const isTerm = (i) => !isInsulatorId(B.cells[i]) && (!isWireId(B.cells[i]) || B.blockAt[i]);
    const seenWire = new Set();
    for (let i = 0; i < B.cells.length; i++) {
        const x = i % B.w, y = (i - x) / B.w;
        if (isTerm(i)) {
            if (!cellConnects(x, y)) continue;
            const t = add(termId(i));
            if (netOf) netOf.set(i, t);
            // Terminals touching one another directly: a source on a pin.
            for (const [dx, dy] of [[1, 0], [0, 1]]) {
                const nx = x + dx, ny = y + dy;
                if (!inBounds(nx, ny) || !isTerm(idx(nx, ny))) continue;
                if (cellConnects(x, y, [dx, dy]) && cellConnects(nx, ny, [-dx, -dy])) union(t, add(termId(idx(nx, ny))));
            }
            continue;
        }
        if (seenWire.has(i) || !isWireId(B.cells[i]) || isCrossoverAt(x, y)) continue;
        const net = floodNet(x, y, 0, 0);
        for (const c of net.cells) seenWire.add(c);
        let first = null;
        for (const ti of net.terminals) {
            const t = add(termId(ti));
            if (first === null) first = t; else union(first, t);
        }
        if (netOf && first !== null) for (const c of net.cells) if (!netOf.has(c)) netOf.set(c, first);
    }
    const out = new Map();
    for (const t of parent.keys()) out.set(t, find(t));
    return out;
}

// The stationary electrical node a non-wire contact belongs to: a pad
// (LED/switch/toggle) is its whole 8-connected clump, anything else —
// a mux pin, a source — is its own single cell.
function anchorNode(ax, ay) {
    const id = B.cells[idx(ax, ay)];
    const pad = isLed(id) ? isLed : isSwitch(id) ? isSwitch : isToggle(id) ? isToggle : null;
    // isNet:false — these carry no wire of their own, so the shrink pass
    // has nothing to prune here.
    const extra = { isNet: false, preTouch: new Set(), routed: new Set(), failed: false };
    if (!pad) return Object.assign({ key: 'n' + idx(ax, ay), cells: new Set([idx(ax, ay)]), terminals: new Set() }, extra);
    const set = new Set(flood8(ax, ay, pad).map(([x, y]) => idx(x, y)));
    let min = Infinity;
    for (const i of set) if (i < min) min = i;
    return Object.assign({ key: 'p' + min, cells: set, terminals: new Set() }, extra);
}

// The loops in a set of wire cells: each piece of it that stays in one
// piece whichever single link is cut (its 2-edge-connected parts, a
// bridge being a link with no way round it), as arrays of cells.
// Thick wire is all loops, and so is a ring. A crossing in the set
// counts as joining all four of its sides — two nets crossing make no
// loop that way unless one of them already had one.
function loopsIn(set) {
    const nbrs = (ci) => {
        const x = ci % B.w, y = (ci - x) / B.w, out = [];
        for (const [dx, dy] of DIRS) if (inBounds(x + dx, y + dy) && set.has(idx(x + dx, y + dy))) out.push(idx(x + dx, y + dy));
        return out;
    };
    const disc = new Map(), low = new Map(), bridge = new Set();
    let t = 0;
    for (const root of set) {
        if (disc.has(root)) continue;
        disc.set(root, t); low.set(root, t); t++;
        const stack = [[root, -1, nbrs(root), 0]];
        while (stack.length) {
            const top = stack[stack.length - 1];
            const [u, parent, list] = top;
            if (top[3] < list.length) {
                const v = list[top[3]++];
                if (v === parent) continue;
                if (!disc.has(v)) {
                    disc.set(v, t); low.set(v, t); t++;
                    stack.push([v, u, nbrs(v), 0]);
                } else low.set(u, Math.min(low.get(u), disc.get(v)));
                continue;
            }
            stack.pop();
            if (parent < 0) continue;
            low.set(parent, Math.min(low.get(parent), low.get(u)));
            if (low.get(u) > disc.get(parent)) bridge.add(Math.min(u, parent) + ':' + Math.max(u, parent));
        }
    }
    const seen = new Set(), loops = [];
    for (const s0 of set) {
        if (seen.has(s0)) continue;
        const part = [], stack = [s0];
        seen.add(s0);
        while (stack.length) {
            const u = stack.pop();
            part.push(u);
            for (const v of nbrs(u)) {
                if (seen.has(v) || bridge.has(Math.min(u, v) + ':' + Math.max(u, v))) continue;
                seen.add(v);
                stack.push(v);
            }
        }
        if (part.length > 1) loops.push(part);
    }
    return loops;
}

// Which cells of a net are surplus to requirement: everything whose
// removal still leaves every anchor it has to tie together mutually
// connected. That covers dead ends (a tail's removal disconnects
// nothing) AND redundant loops — a doubled-back run where each cell has
// two neighbours, so pure leaf-pruning can never unpick it, which is
// what a drag alongside a net's own wire used to leave behind.
//
// Removal is farthest-anchor-first so that when a loop is broken it's
// the long way round that goes and the direct connection that stays.
// The result is irreducible rather than provably minimal — good enough,
// and it can't disconnect anything by construction. Cells in `keep` are
// never removed and must stay reachable, so a stub the user drew (or a
// loop they drew) survives with its connection to the net intact.
// Pure analysis — the caller decides what to actually erase.
function reduceNet(netSet, requiredSet, keep, nodeId) {
    const live = new Set(netSet);
    const held = new Set([...(keep || [])].filter((ci) => live.has(ci)));
    const removed = new Set();
    const neighborsIn = (ci, set) => {
        const x = ci % B.w, y = (ci - x) / B.w, out = [];
        for (const [dx2, dy2] of DIRS) {
            const nx = x + dx2, ny = y + dy2;
            if (!inBounds(nx, ny)) continue;
            // Touching a mux is not joining it: it meets wire only
            // through a lead, so a run lying against its package on a
            // dead face holds nothing on — read as attached, it was kept
            // as a stub hugging the part. (Only a mux: anything else
            // here is joined all round, or is an object cell lifted for
            // the move, which reads as empty board.)
            if (set.has(idx(nx, ny))) {
                const deadA = isMuxId(B.cells[ci]) && !cellConnects(x, y, [dx2, dy2]);
                const deadB = isMuxId(B.cells[idx(nx, ny)]) && !cellConnects(nx, ny, [-dx2, -dy2]);
                if (!deadA && !deadB) out.push(idx(nx, ny));
                continue;
            }
            // A crossover belonging to some OTHER net is a pass-through:
            // the cell straight beyond it continues this same axis of
            // this net. Without this a route that crosses something reads
            // as two disconnected halves and gets reduced away as joining
            // nothing to nothing. Restricted to cells outside this net,
            // since a 4-way junction of the net's own wire is an ordinary
            // member here, not a bridge to jump over.
            if (!netSet.has(idx(nx, ny)) && isCrossoverAt(nx, ny)) {
                const fx = nx + dx2, fy = ny + dy2;
                if (inBounds(fx, fy) && set.has(idx(fx, fy))) out.push(idx(fx, fy));
            }
        }
        return out;
    };
    // Anchors are the things whose interconnection must survive: the
    // required cells the net touches, plus the protected cells
    // themselves — wire the user drew has to keep whatever attachment it
    // had, or the pass could strand it by cutting the run that feeds it.
    const anchors = [...requiredSet].filter((ri) => neighborsIn(ri, live).length > 0)
        .concat([...held]);
    const idOf = (ci) => (held.has(ci) ? 'h' + ci : nodeId(ci));
    // Which anchors can currently reach which, as a canonical string. The
    // rule is to PRESERVE this, not to require one connected whole: a net
    // whose middle the object just absorbed arrives here in two pieces,
    // and reduction still has useful work to do within each.
    // What must be preserved is which electrical NODE reaches which —
    // not which cell. Anchor cells are grouped by node (every cell of a
    // dragged wire is one node; each mux pin its own; a pad's cells one
    // between them), because a run reconnecting two cells the object
    // already joins internally is exactly the redundant doubling this
    // pass exists to remove. And what a node must keep reaching is the
    // OTHER nodes: one that ties to nothing else needs no wire at all,
    // so "reaches none" and "detached" are the same state — treating
    // them as different left an orphan cell clinging to every pin.
    const groupsOf = (set) => {
        const reach = new Map();
        for (const a of anchors) {
            const na = idOf(a);
            if (!reach.has(na)) reach.set(na, new Set());
            const ns = neighborsIn(a, set);
            if (!ns.length) continue;
            const seen = new Set(ns), stack = [...ns];
            while (stack.length) {
                const c = stack.pop();
                for (const n of neighborsIn(c, set)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
            }
            for (const b of anchors) {
                const nb = idOf(b);
                if (nb !== na && neighborsIn(b, seen).length) reach.get(na).add(nb);
            }
        }
        return [...reach.entries()].map(([k, v]) => k + ':' + [...v].sort().join(','))
            .sort().join('|');
    };
    const baseline = groupsOf(live);
    const holds = (set) => groupsOf(set) === baseline;
    for (;;) {
        const dist = new Map(), queue = [];
        for (const a of anchors) for (const n of neighborsIn(a, live)) if (!dist.has(n)) { dist.set(n, 1); queue.push(n); }
        if (!anchors.length) for (const h of held) if (!dist.has(h)) { dist.set(h, 0); queue.push(h); }
        for (let qi = 0; qi < queue.length; qi++) {
            const c = queue[qi];
            for (const n of neighborsIn(c, live)) if (!dist.has(n)) { dist.set(n, dist.get(c) + 1); queue.push(n); }
        }
        // A cell next to a crossover is load-bearing: take it away and
        // the crossing drops from four neighbours to three, which is no
        // longer two independent axes but a tee welding them together.
        const nearCrossing = (ci) => {
            const x = ci % B.w, y = (ci - x) / B.w;
            return DIRS.some(([dx2, dy2]) => isCrossoverAt(x + dx2, y + dy2));
        };
        // ...unless its partner across the crossing goes too: the
        // crossing's other run then passes a plain wire. A dead branch
        // that ran through a crossing used to be left standing, a stub
        // on each side, because neither arm could go alone.
        const across = (ci) => {
            const x = ci % B.w, y = (ci - x) / B.w;
            for (const [dx2, dy2] of DIRS) {
                if (!isCrossoverAt(x + dx2, y + dy2)) continue;
                const o = idx(x + 2 * dx2, y + 2 * dy2);
                return inBounds(x + 2 * dx2, y + 2 * dy2) && live.has(o) && !held.has(o) ? o : -1;
            }
            return -1;
        };
        const cand = [...live].filter((ci) => !held.has(ci) && (!nearCrossing(ci) || across(ci) >= 0))
            .sort((a, b) => (dist.has(b) ? dist.get(b) : Infinity) - (dist.has(a) ? dist.get(a) : Infinity));
        let did = false;
        for (const ci of cand) {
            const pair = nearCrossing(ci) ? across(ci) : -1;
            if (nearCrossing(ci) && pair < 0) continue;
            live.delete(ci);
            if (pair >= 0) live.delete(pair);
            if (holds(live)) { removed.add(ci); if (pair >= 0) removed.add(pair); did = true; break; }
            live.add(ci);
            if (pair >= 0) live.add(pair);
        }
        if (!did) break;
    }
    return removed;
}

// Shortest free path from ANY of a net's cells to ANY cell of the target
// node, preferring straight runs (a turn costs a fraction of a step).
//
// The search runs over (cell, travel direction) states and validates
// EDGES rather than cells: at each step, the two neighbors the path
// neither arrives from nor leaves by must not touch anything conductive.
// That single rule buys both of the things this router needs:
//
//  - It cannot tee into anything it passes — including its OWN net. An
//    earlier version allowed hugging the net it came from, which let it
//    lay a second path right alongside the existing run: that reads as a
//    loop, and it also strands the old run (now two-connected everywhere)
//    where the shrink pass can no longer prune it.
//  - It CAN cross an existing wire head-on, because the crossed cell
//    sits in the excluded "came from"/"going to" slots. A straight run
//    crossed at right angles picks up the path's cells as its other pair
//    of neighbors and becomes a 4-way crossover, which this world
//    already keeps electrically separate per axis (isCrossoverAt) — so
//    the crossing costs the circuit nothing and opens up routes that
//    would otherwise dead-end and report as unroutable.
//
// Touching the net's own TERMINALS (its pads, pins and sources) stays
// legal throughout: a pad is one node however many of its cells the path
// brushes, so that can't fork the net the way running beside its wire
// can — and forbidding it would wall a route in against the very pad it
// is leaving. The path's first cell may additionally touch the net's
// wire, since that is the connection being made.
// Returns the list of cells to fill with conductor, or null.
const ROUTE_STEP_COST = 16;  // turn penalty is 1, so length dominates
const ROUTE_CROSS_COST = 64; // a crossing is legal, but prefer a short detour
const OPP = (d) => (d + 2) % 4;
// How far a route actually had to span, measured on its OWN two ends —
// not on the closest pair of cells in the two nets it joins. Those nets
// can be long: a seed may sit one cell from a target and still be the
// wrong end to start from, and judging the route against THAT distance
// condemns every legitimate long haul. What matters is whether this path
// wandered between the points it actually connects.
function pathSpan(path) {
    if (!path || !path.length) return 0;
    const [ax, ay] = path[0], [bx, by] = path[path.length - 1];
    return Math.abs(ax - bx) + Math.abs(ay - by);
}
// Tuned so an ordinary detour around one obstacle still routes, while a
// lap of the board does not. Held fairly tight on purpose: a route much
// longer than the gap it bridges is not a connection the user would
// recognise as theirs, it is decoration, and a dashed line they can draw
// where they actually want it is the better answer. On the move sweep,
// 1.6 let 29 moves add 21 or more cells of wire; 1.25 lets 22, and costs
// four of 1351 moves their automatic re-route.
const ROUTE_SLACK = 3, ROUTE_STRETCH = 1.25;
function routeNet(seedIdxs, targetSet, netCells, terminalCells, volatileCells) {
    const free = (x, y) => inBounds(x, y) && isInsulatorId(B.cells[idx(x, y)]) && !B.blockAt[idx(x, y)]
        && !(B.ringMask[idx(x, y)] & RING_R);
    // A mux gets a one-cell berth on EVERY face. All of them say what the
    // part is: a wire at a long side's middle declares that side COM, at
    // its end declares a pin, and one on a short side declares SELECT —
    // which is the end that decides NO from NC. A route grazing any of
    // them on its way past can spin the part around or swap its pins,
    // and the short sides are not the harmless case they look like.
    //
    // Routes may still END on a terminal: that is the `dOut` direction,
    // which is never side-checked. Hand-drawing alongside a package stays
    // legal; this only constrains what the re-router lays down unasked.
    //
    // All mux material gets the berth, not only working parts. An unwired
    // package is read by exactly this — a route past the middle of its
    // long side would orient it — and unfinished material becomes a part
    // the moment it is completed, reading whatever was laid beside it.
    const bumpsPackage = (x, y) => isMuxId(B.cells[idx(x, y)]);
    const sidesClear = (x, y, dIn, dOut, allowed) => {
        for (let d = 0; d < 4; d++) {
            if (d === OPP(dIn) || d === dOut) continue; // where the path came from / goes
            const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
            if (!inBounds(nx, ny)) continue;
            if (bumpsPackage(nx, ny) && !allowed.has(idx(nx, ny))) return false;
            // Deliberately direction-agnostic: a route must not run
            // flush along ANY terminal it isn't ending on, whichever
            // face that terminal happens to present.
            if (!cellConnects(nx, ny)) continue;
            if (!allowed.has(idx(nx, ny))) return false;
        }
        return true;
    };
    // Note targetSet is deliberately NOT blanket-allowed: the step that
    // reaches the target already excludes the direction it steps in, so
    // the path meets its node at exactly one cell instead of being free
    // to run the length of it (which, for a multi-cell object like a
    // dragged wire, laid a parallel run right beside it — a loop).
    const openAllowed = new Set(terminalCells);
    const firstAllowed = new Set([...openAllowed, ...netCells]);
    // Dijkstra over (cell, incoming direction) with a bucket queue —
    // costs are small bounded integers, so buckets beat a real heap.
    const skey = (i, d) => i * 4 + d;
    const dist = new Map(), prev = new Map();
    const buckets = [];
    const push = (cost, i, d, from_) => {
        const k = skey(i, d);
        if (dist.get(k) !== undefined && dist.get(k) <= cost) return;
        dist.set(k, cost);
        prev.set(k, from_);
        (buckets[cost] || (buckets[cost] = [])).push([i, d]);
    };
    const rebuild = (k) => {
        const out = [];
        for (let cur = k; cur !== -1; cur = prev.get(cur)) out.push(Math.floor(cur / 4));
        return out.reverse().map((ci) => [ci % B.w, Math.floor(ci / B.w)]);
    };
    for (const si of seedIdxs) {
        const sx = si % B.w, sy = (si - sx) / B.w;
        for (let d = 0; d < 4; d++) {
            const nx = sx + DIRS[d][0], ny = sy + DIRS[d][1];
            if (free(nx, ny)) push(ROUTE_STEP_COST, idx(nx, ny), d, -1);
        }
    }
    for (let cost = 0; cost < buckets.length; cost++) {
        const bucket = buckets[cost];
        if (!bucket) continue;
        for (const [i, d] of bucket) {
            const k = skey(i, d);
            if (dist.get(k) !== cost) continue; // superseded by a cheaper entry
            const x = i % B.w, y = (i - x) / B.w;
            // Only the path's own first cell may touch the net it leaves.
            const allowed = prev.get(k) === -1 ? firstAllowed : openAllowed;
            for (let nd = 0; nd < 4; nd++) {
                if (nd === OPP(d)) continue; // no doubling back
                if (!sidesClear(x, y, d, nd, allowed)) continue;
                const turn = nd === d ? 0 : 1;
                const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
                if (!inBounds(nx, ny)) continue;
                if (targetSet.has(idx(nx, ny))) return rebuild(k);
                if (free(nx, ny)) { push(cost + ROUTE_STEP_COST + turn, idx(nx, ny), nd, k); continue; }
                // Cross straight through a perpendicular run (-> 4-way
                // crossover). Both of the crossed cell's side neighbors
                // must already be wires, so the crossing really is a
                // crossing and not a tee onto some wire's dead end.
                if (!isWireId(B.cells[idx(nx, ny)])) continue;
                // Only ever cross a net that is standing still. Crossing
                // one this same move is re-contracting means the cell
                // relied on can be reduced away underneath the crossing,
                // quietly severing it.
                if (volatileCells.has(idx(nx, ny))) continue;
                const perp = nd % 2 === 0 ? [1, 3] : [0, 2];
                if (!perp.every((q) => isWireId(getCell(nx + DIRS[q][0], ny + DIRS[q][1])))) continue;
                const bx = nx + DIRS[nd][0], by = ny + DIRS[nd][1];
                if (!free(bx, by)) continue; // must land clear on the far side
                push(cost + 2 * ROUTE_STEP_COST + ROUTE_CROSS_COST + turn, idx(bx, by), nd, k);
            }
        }
    }
    return null;
}

export {
    floodNet, terminalGroups, anchorNode, loopsIn, reduceNet, ROUTE_STEP_COST, ROUTE_CROSS_COST, OPP,
    pathSpan, ROUTE_SLACK, ROUTE_STRETCH, routeNet,
};
