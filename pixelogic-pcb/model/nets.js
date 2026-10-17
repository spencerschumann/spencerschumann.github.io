// Nets: what is wired to what (walkNet, reaches, parts, muxCount), and the
// ratsnest — connections a move could not keep, owed as dashed lines
// (prunePendingLinks, pendingLinkList).

import {
    DIRS, isLed, isSwitch, isToggle, isWireId,
} from './cells.js';
import {
    B, idx, inBounds, isCrossoverAt,
} from './board.js';
import {
    blockParent, cellConnects,
} from './blocks.js';

// ===== Pending links (the ratsnest) =====
//
// A connection a rearrange could not keep. Rather than refuse the whole
// drag — which used to leave you nudging a part around wondering which
// of its wires was the problem — the move goes through and what it owes
// is drawn as a straight dashed line, the way a PCB tool shows an
// unrouted airwire. Draw the wire yourself and the line goes away.
//
// Transient by design: this is the one thing here NOT derivable from the
// pixels, so it is session state rather than something serialized. A
// link survives until it is satisfied or one of its ends stops being
// connectable at all. (`B.pendingLinks`.)

// May the walk continue from `a` into `b`, or does `b` end the net? Wire
// always continues. So does another cell of the same multi-cell NODE — a
// pad is one terminal however many cells it spans, and so is a mux's COM
// row. Everything else is where a net stops: two pins of the same mux are
// separate nodes and must never read as joined.
function passesThrough(a, b) {
    if (isWireId(B.cells[b])) return true;
    const ia = B.cells[a], ib = B.cells[b];
    if (isLed(ia) && isLed(ib)) return true;
    if (isSwitch(ia) && isSwitch(ib)) return true;
    if (isToggle(ia) && isToggle(ib)) return true;
    return false;
}

// Is `to` in the same electrical net as `from`? Walks wire and whole
// multi-cell nodes, and enters a cell only through a face that actually
// connects — a mux is reachable through its leads and nowhere else.
// A crossing passes STRAIGHT through. A 4-way junction of wire is not a
// junction in this world, it is two runs going over each other, so the
// walk carries the direction it arrived by and may only leave a crossover
// the way it came in. Turning a corner there had the whole machinery
// believe two nets that merely cross were joined: a drag that cut a
// connection and laid a route across the remains reported nothing owed,
// and the circuit quietly stopped working. `hit(cell, through)` is called
// for every cell reached — `through` says whether the walk continues past
// it — and returning true stops the walk.
//
// A block's edge is where a walk stops, unless it is `electrical`: seen
// from outside, a block's pins are terminals like a mux's leads — what
// is inside is the block's business, and a re-route or a pruning pass
// that followed its wires in would rewire a part it cannot see. A walk
// that starts ON a pin stands outside the block, facing out. The coach
// asks electrically (reaches), since for "does A get to Q" the wire
// through a part is as good as any other.
function walkNet(fromIdx, hit, electrical) {
    const fx = fromIdx % B.w, fy = (fromIdx - fx) / B.w;
    const ctx = electrical ? -1 : (B.pinAt[fromIdx] ? blockParent(B.blockAt[fromIdx]) : B.blockAt[fromIdx]);
    const seen = new Set(), stack = [];
    for (let d = 0; d < 4; d++) stack.push([fx, fy, d]);
    while (stack.length) {
        const [x, y, d] = stack.pop();
        const [dx, dy] = DIRS[d];
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const ci = idx(x, y), ni = idx(nx, ny);
        if (!cellConnects(x, y, [dx, dy]) || !cellConnects(nx, ny, [-dx, -dy])) continue;
        const cross = isCrossoverAt(nx, ny);
        const key = cross ? ni + (dx !== 0 ? 'h' : 'v') : ni;
        if (seen.has(key)) continue;
        seen.add(key);
        const through = passesThrough(ci, ni) && (ctx < 0 || B.blockAt[ni] === ctx);
        if (hit(ni, through)) return true;
        if (!through) continue;
        if (cross) { stack.push([nx, ny, d]); continue; }
        for (let nd = 0; nd < 4; nd++) stack.push([nx, ny, nd]);
    }
    return false;
}

function netReaches(fromIdx, toIdx) {
    if (fromIdx === toIdx) return true;
    return walkNet(fromIdx, (ci) => ci === toIdx);
}

// Coordinate form of netReaches, for callers outside the model (the
// campaign's step-by-step coach): is (x1,y1) on the net (x0,y0) drives?
function reaches(x0, y0, x1, y1) {
    if (!inBounds(x0, y0) || !inBounds(x1, y1)) return false;
    const a = idx(x0, y0), b = idx(x1, y1);
    return a === b || walkNet(a, (ci) => ci === b, true);
}

// How many muxes are on the board, those inside parts included — what a
// level that asks for no more than so many counts.
function muxCount() {
    const seen = new Set();
    for (let i = 0; i < B.roles.length; i++) {
        const r = B.roles[i];
        if (r && r.macro) seen.add(r.macro);
    }
    return seen.size;
}

// Every mux on the board (not inside a part), as {state: 'mux'} with its
// terminal cells. Each terminal is the mux's own cell whose lead faces
// out, so reaches() from it walks out through the lead.
function parts() {
    const out = [], seen = new Set();
    for (let i = 0; i < B.roles.length; i++) {
        const r = B.roles[i];
        if (!r || B.blockAt[i]) continue;
        if (r.macro) {
            const m = r.macro;
            if (seen.has(m)) continue;
            seen.add(m);
            const no = m.selIsFirst ? m.pinFirst : m.pinLast;
            const nc = m.selIsFirst ? m.pinLast : m.pinFirst;
            out.push({ state: 'mux', sel: m.selCorner.slice(), com: m.comCell.slice(), no: no.slice(), nc: nc.slice() });
        }
    }
    return out;
}

// Every cell electrically joined to `from`, itself included — the same
// walk netReaches does, run to completion instead of stopping at a target.
//
// Only cells the walk PASSES THROUGH are in it. A cell it merely arrives
// at is where the net ends, and that cell belongs to whatever is on the
// other side: an LED does not conduct, so two runs meeting the same lamp
// are two nets, and counting the lamp in both had them read as touching.
// The ratsnest drew the resulting link as a dot.
function netCellsOf(fromIdx) {
    const out = new Set([fromIdx]);
    walkNet(fromIdx, (ci, through) => { if (through) out.add(ci); return false; });
    return out;
}

// A name for the thing an endpoint sits on, the same from either end: the
// lowest cell of the WIRE it is attached to, or the cell itself when it
// has no wire. Naming it by the whole net instead does not commute — a
// mux pin's net takes in the run soldered to its lead, while that run's
// net stops short of the pin — so the same owed connection got two
// different names depending on which end it was filed under, and came out
// as two dashed lines lying on top of each other.
function wireNetKey(ci) {
    let m = -1;
    for (const c of netCellsOf(ci)) if (isWireId(B.cells[c]) && (m < 0 || c < m)) m = c;
    return m < 0 ? ci : m;
}

// Does this net end on anything — a pad, a pin, a source?
function netHasTerminal(net) {
    for (const ci of net) {
        if (!isWireId(B.cells[ci])) return true;
        const cx = ci % B.w, cy = (ci - cx) / B.w;
        for (const [dx, dy] of DIRS) {
            const nx = cx + dx, ny = cy + dy;
            if (!inBounds(nx, ny)) continue;
            const ni = idx(nx, ny);
            if (isWireId(B.cells[ni]) && B.blockAt[ni] === B.blockAt[ci]) continue;
            if (cellConnects(cx, cy, [dx, dy]) && cellConnects(nx, ny, [-dx, -dy])) return true;
        }
    }
    return false;
}

// Wire that reaches no terminal at all — a run joined to nothing at
// either end. Not the same as a dangling stub, which still has a pad or a
// pin on one end and is a perfectly ordinary thing to have drawn; this is
// the piece a move can cut adrift when it absorbs the middle of a run or
// gives up half way through re-routing one, and it is pure litter.
function orphanWire() {
    const out = new Set(), seen = new Set();
    for (let i = 0; i < B.cells.length; i++) {
        // A block's wiring is its own business: never litter.
        if (!isWireId(B.cells[i]) || seen.has(i) || B.blockAt[i]) continue;
        const net = netCellsOf(i);
        for (const ci of net) seen.add(ci);
        if (!netHasTerminal(net)) for (const ci of net) out.add(ci);
    }
    return out;
}

function prunePendingLinks() {
    if (!B.pendingLinks.length) return;
    const live = ([a, b]) => {
        const ax = a % B.w, ay = (a - ax) / B.w;
        const bx = b % B.w, by = (b - bx) / B.w;
        if (!cellConnects(ax, ay) || !cellConnects(bx, by)) return false; // an end was erased
        return !netReaches(a, b);                                         // or it got joined
    };
    // One line per pair of NETS. Links are owed by one move at a time but
    // outlive it, and editing the board rearranges what is joined to
    // what, so two links laid down separately can end up saying the same
    // thing — a net drawn out to meet a second pin now owes that pin and
    // its neighbour the same single connection.
    const seen = new Set();
    const single = ([a, b]) => {
        const ka = wireNetKey(a), kb = wireNetKey(b);
        if (ka === kb) return false;
        const k = Math.min(ka, kb) + ':' + Math.max(ka, kb);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    };
    B.pendingLinks = B.pendingLinks.filter((l) => live(l) && single(l));
}

// Endpoint form for the view, in fractional cells.
//
// A link is stored between two TERMINALS — the mux lead and the pad or
// pin at the far end — because those are the two things that are still
// the same thing after an edit. What it is DRAWN between is the closest
// approach of the two NETS those terminals sit on: the connection is owed
// to the net, not to the pad at the end of it, so the line should land on
// the wire you have already run rather than fly past it to the pad. That
// also makes the ratsnest live while you draw — each cell of wire you add
// toward the part shortens the line, until it touches and the link goes.
//
// A mux terminal reports at its lead's FACE rather than its cell centre,
// so the line starts where the connection would actually land instead of
// floating inside the package.
function pendingLinkList() {
    const face = (i) => {
        const x = i % B.w, y = (i - i % B.w) / B.w;
        const role = B.roles[i];
        if (role && role.lead) return [x + role.lead[0] / 2, y + role.lead[1] / 2];
        return [x, y];
    };
    return B.pendingLinks.map(([a, b]) => {
        // Copper both sides share is nobody's closest approach. Two runs
        // that meet the same lamp are two nets — a lamp does not conduct —
        // but the lamp's own cells sit on both of them, and letting either
        // side anchor there drew the line as a dot on top of the lamp.
        const netA = netCellsOf(a), netB = netCellsOf(b);
        const as = [...netA].filter((i) => !netB.has(i) || i === a);
        const bs = [...netB].filter((i) => !netA.has(i) || i === b);
        let best = null, bestD = Infinity;
        for (const p of as) {
            const px = p % B.w, py = (p - px) / B.w;
            for (const q of bs) {
                const qx = q % B.w, qy = (q - qx) / B.w;
                const d = (px - qx) ** 2 + (py - qy) ** 2;
                if (d < bestD) { bestD = d; best = [p, q]; }
            }
        }
        return best ? [face(best[0]), face(best[1])] : [face(a), face(b)];
    });
}

export {
    passesThrough, walkNet, netReaches, reaches, muxCount, parts, netCellsOf, wireNetKey, netHasTerminal,
    orphanWire, prunePendingLinks, pendingLinkList,
};
