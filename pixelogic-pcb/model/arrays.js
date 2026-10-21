// A part repeated: n copies in a row, joined up and wrapped as one part
// (arrayClip), and which ways a part can repeat (arrayPlan). Works on clips;
// touches no board.

import {
    DIRS, ID_CONDUCTOR_BASE, isMuxId, isWireId, isXover,
} from './cells.js';
import {
    MAX_CELLS,
} from './board.js';
import {
    edgeHost, idConnects, pinCode, pinFaceOf, pinIndex,
} from './blocks.js';
import {
    clipPins, clipRing, clipTops,
} from './clips.js';

// ---- Arrays: one part, repeated ----
// A part laid down n times in a row, like a modelling program's array
// modifier, joined up and wrapped as one part: four full-adder slices
// stacked are a 4-bit adder, and eight an 8-bit one. `spec`: {dir, pitch,
// shared: [pin names], taps: [pin names], tapSide, reverse, name}. Copy k
// sits k * pitch cells from copy 0 in direction `dir` (a DIRS index), and
// the part's pins each go one of three ways:
//   chained — an output facing the next copy and an input of its facing
//     back (a carry out on top, a carry in below): each copy's is wired to
//     the next's, and only the first copy's input and the last's output
//     are the array's. With no wire at all if they meet head on — each
//     pin's cell on the other's terminal, the copies flush; straight
//     across if they are in line; if not — and
//     only when they are the one output facing on and the one input
//     facing back, so there is no guessing which meets which — the run
//     steps across in a row between the copies, which needs the copies
//     that much further apart (as a stack of such slices does). An input
//     that passes straight through the part — facing on, and joined by
//     wire inside to an input facing back (an enable run up a stack of
//     latch slices) — chains the same way: the first copy's back-facing
//     input and the last copy's onward one are the array's. And so does
//     one pin with terminals both ways — its wire drawn on through the
//     part to a terminal at the other side: each copy's on into the next's,
//     the first copy's back-facing terminal the array's pin;
//   shared — an input every copy takes (a clock, an enable): one wire
//     along the copies' terminals, and one pin;
//   each — every copy's own, numbered by copy: A becomes A0, A1, ...,
//     copy 0 being bit 0 (or the last copy, `reverse`).
// A chained output may also be in `taps`: every copy's is the array's
// too, numbered (a shift register's bits) — a wire from the gap between
// two copies straight out to the side `tapSide`, which needs a gap clear
// of both copies' edges to run in.
// Copies must sit as parts may: nothing of one joining another where
// that one keeps bare, no two nets touching. Their edges may share cells — the
// shared row of a tight stack — whatever each says there: such a cell
// stays bare unless the array lays wire on it, and it lays none on a cell
// one copy keeps bare or another pin's terminal shares, but for a chain's
// run, which joins the two as it should. The array's own pin is its
// copy's pin (`via` it), so the array's edge hugs its copies and has every
// terminal the copy's pin has — a carry in can be wired from whichever side
// of the first copy it reaches — but where a bus or a tap the array lays
// runs past it: there it is on its copy's terminal, made wire, a cell out.
// (Every pin was so once, a stub out of every copy and the array a cell
// bigger all round: `spec.stubs` makes one that way still, to know one put
// down then.) Pure: reads and writes no board.
// Returns {clip, origin: copy 0's top left in it, pitch, chains: [[out,
// in]], shared, each, taps, sources} or {error}. `sources`: each of the
// array's pins, as {name, base, role} — the part's pin it comes from, and
// 'chain' (the chain's ends), 'tap', 'each' or 'shared'.
//
// `spec.apart`: the copies side by side and nothing more — n parts, each
// its own, nothing joined and no lid over them (four latches for a
// register, wired by hand) — so they need only sit as parts may. Then
// {clip, origin, pitch, apart: true}, the clip's parts its copies.
function arrayClip(base, spec, n) {
    const tops = base && base.blocks && base.bmap ? clipTops(base) : [];
    if (tops.length !== 1) return { error: 'Only a single part can be repeated' };
    n = Math.max(1, Math.min(64, n | 0));
    const d = DIRS[spec.dir & 3], pitch = spec.pitch | 0;
    const bit = (k) => (spec.reverse ? n - 1 - k : k);
    const along = Math.abs(d[0]) ? base.w : base.h;
    if (pitch < along) return { error: 'Copies that close would overlap' };
    const off = (k) => [d[0] * pitch * k, d[1] * pitch * k];
    if (spec.apart === true) return apartClip(base, off, n, pitch);
    const pins = clipPins(base);
    if (pins.some((p) => !p.at)) return { error: 'The part has a pin with no terminal' };
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    const faces = (p, f) => p.face[0] === f[0] && p.face[1] === f[1];
    const back = [-d[0], -d[1]];
    // Chains: an output facing on along the row, an input of the next
    // copy facing back at it on the same line.
    const at = (p, k) => [p.at[0] + off(k)[0], p.at[1] + off(k)[1]];
    const chains = [], role = new Map(), direct = new Set();
    // Which terminal of a chain's pins the run goes from and to, where
    // that is not its own: a pin running through, from its terminal facing
    // on to its own facing back. Name -> {on, back}.
    const through = new Map();
    const inLine = (p, c) => (d[0] ? c.at[1] === p.at[1] : c.at[0] === p.at[0]);
    const hostAt = (p, k) => [p.host[0] + off(k)[0], p.host[1] + off(k)[1]];
    const onward = pins.filter((c) => c.dir === 'out' && faces(c, d));
    const chain = (p, q) => {
        // Head on: the onward pin's terminal is the next copy's pin, and
        // that pin's terminal is the onward one — joined, with no wire.
        if (same(p.at, hostAt(q, 1)) && same(at(q, 1), p.host)) direct.add(p.name);
        else {
            const gap = (at(q, 1)[0] - p.at[0]) * d[0] + (at(q, 1)[1] - p.at[1]) * d[1];
            if (gap < 0) return 'Copies that close would overlap';
            if (!inLine(p, q) && gap < 2) return `${p.name} steps across to ${q.name}: the copies need a row between them to do it in`;
        }
        chains.push([p.name, q.name]);
        role.set(p.name, 'chain'); role.set(q.name, 'chain');
        return null;
    };
    for (const p of pins) {
        if (p.dir !== 'out' || !faces(p, d)) continue;
        const backs = pins.filter((c) => c.dir === 'in' && faces(c, back) && !role.has(c.name));
        const q = backs.find((c) => inLine(p, c)) || (onward.length === 1 && backs.length === 1 ? backs[0] : null);
        const why = q && chain(p, q);
        if (why) return { error: why };
    }
    // Inputs passing through: one facing on, joined inside to one facing
    // back.
    for (const p of pins) {
        if (p.dir !== 'in' || !faces(p, d) || role.has(p.name)) continue;
        const backs = pins.filter((c) => c !== p && c.dir === 'in' && faces(c, back) && !role.has(c.name) && wiredThrough(base, p.host, c.host));
        const q = backs.find((c) => inLine(p, c)) || (backs.length === 1 ? backs[0] : null);
        const why = q && chain(p, q);
        if (why) return { error: why };
    }
    // One pin running through, with a terminal facing on and one facing
    // back (in line, if it has such a pair).
    for (const p of pins) {
        if (role.has(p.name)) continue;
        const all = [{ host: p.host, face: p.face, at: p.at }, ...(p.others || [])];
        let pair = null;
        for (const a of all.filter((t) => faces(t, d)))
            for (const b of all.filter((t) => faces(t, back)))
                if (!pair || (inLine(a, b) && !inLine(pair[0], pair[1]))) pair = [a, b];
        if (!pair) continue;
        const why = chain({ ...p, ...pair[0] }, { ...p, ...pair[1] });
        if (why) return { error: why };
        through.set(p.name, { on: pair[0], back: pair[1] });
    }
    // Only an output's chain can be tapped: an input passing through is
    // one signal all the way up.
    const tapSet = new Set((spec.taps || []).filter((t) => chains.some(([o]) => o === t) && pins.some((p) => p.name === t && p.dir === 'out')));
    const side = DIRS[spec.tapSide === undefined ? (d[0] ? 2 : 1) : spec.tapSide & 3];
    if (tapSet.size && side[0] * d[0] + side[1] * d[1] !== 0) return { error: 'Taps leave sideways to the row' };
    const sharedSet = new Set(spec.shared || []);
    for (const p of pins) {
        if (role.has(p.name)) continue;
        const across = faces(p, d) || faces(p, back);
        if (sharedSet.has(p.name)) {
            if (p.dir !== 'in') return { error: `${p.name} is an output: every copy has its own` };
            if (across) return { error: `${p.name} faces along the row, so it cannot run along it` };
            role.set(p.name, 'shared');
        } else {
            if (across && n > 1) return { error: `${p.name} faces the next copy, with nothing there to meet it` };
            role.set(p.name, 'each');
        }
    }

    // Every cell, and every copy's edge.
    const meet = new Set(chains.filter(([o]) => direct.has(o)).flatMap(([o, i]) => [o + '|' + i, i + '|' + o]));
    const laid = layCopies(base, off, n, 1, meet);
    if (laid.error) return laid;
    const { cells, edge, maxLid } = laid;
    const key = (x, y) => x + ',' + y;
    // The wire the array adds, each cell tagged with the net it is.
    const wire = new Map();      // 'x,y' -> net
    const pinIdx = new Map(pins.map((p, i) => [p.name, i]));
    // What a copy's edge says to something of `pinName`'s (copy `copy`'s)
    // on the cell: nothing, or why not.
    const clash = (kk, pinName, copy) => {
        for (const e of edge.get(kk) || []) {
            if (e.cls === 'X') continue;
            if (e.cls === 'T' && pinName && e.pin === pinIdx.get(pinName) && (copy === undefined || copy === e.copy)) continue;
            if (e.cls === 'T' && pinName && role.get(pinName) === 'chain' && chains.some(([o, i]) => (pins[e.pin].name === o || pins[e.pin].name === i) && (o === pinName || i === pinName))) continue;
            return e.cls === 'R' ? 'A wire the array needs would run where a copy keeps bare'
                : 'Two copies’ terminals would meet';
        }
        return null;
    };
    const lay = (x, y, net, pinName, copy) => {
        const kk = key(x, y);
        if (cells.has(kk)) return 'A wire the array needs would cross a copy';
        const why = clash(kk, pinName, copy);
        if (why) return why;
        const was = wire.get(kk);
        if (was && was !== net) return 'Two copies’ terminals would meet';
        wire.set(kk, net);
        return null;
    };
    const run = (a, b, net, pinName, copy) => {
        const sx = Math.sign(b[0] - a[0]), sy = Math.sign(b[1] - a[1]);
        for (let [x, y] = a; ; x += sx, y += sy) {
            const why = lay(x, y, net, pinName, copy);
            if (why) return why;
            if (x === b[0] && y === b[1]) return null;
        }
    };
    const outPins = [];          // {name, dir, host, face}
    const pinNamed = (nm) => pins.find((p) => p.name === nm);
    // A chain's run from one copy's output terminal to the next copy's
    // input terminal: straight, or — not in line — one step on, across,
    // and on into the input.
    const chainPath = (from, to) => {
        if (from[0] === to[0] || from[1] === to[1]) return [from, to];
        const m1 = [from[0] + d[0], from[1] + d[1]];
        const m2 = d[0] ? [m1[0], to[1]] : [to[0], m1[1]];
        return [from, m1, m2, to];
    };
    const cellsOf = (corners) => {
        const out = [];
        for (let j = 0; j + 1 < corners.length; j++) {
            const [a, b] = [corners[j], corners[j + 1]];
            const sx = Math.sign(b[0] - a[0]), sy = Math.sign(b[1] - a[1]);
            for (let [x, y] = a; ; x += sx, y += sy) {
                if (!out.length || out[out.length - 1][0] !== x || out[out.length - 1][1] !== y) out.push([x, y]);
                if (x === b[0] && y === b[1]) break;
            }
        }
        return out;
    };
    // A tap runs to the cell just past the copies on its side (the copies
    // all sit level that way, the side being across the row).
    const reach = side[0] > 0 ? base.w : side[1] > 0 ? base.h : -1;
    for (let k = 0; k + 1 < n; k++)
        for (const [o, i] of chains) {
            if (direct.has(o)) {
                if (tapSet.has(o)) return { error: `Spread them out to tap ${o}: the copies meet head on there` };
                continue;
            }
            const from = at(through.has(o) ? through.get(o).on : pinNamed(o), k);
            const to = at(through.has(i) ? through.get(i).back : pinNamed(i), k + 1), net = `chain:${o}:${k}`;
            const corners = chainPath(from, to);
            for (let j = 0; j + 1 < corners.length; j++) {
                const why = run(corners[j], corners[j + 1], net, o);
                if (why) return { error: why };
            }
            if (!tapSet.has(o)) continue;
            // A tap: from a cell of the run clear of both copies' edges.
            const m = cellsOf(corners).find((c) => !edge.has(key(c[0], c[1]))) || null;
            if (!m) return { error: `Spread them out to tap ${o}: there is no room between them` };
            const end = side[0] ? [reach, m[1]] : [m[0], reach];
            const whyT = run([m[0] + side[0], m[1] + side[1]], end, net, o);
            if (whyT) return { error: whyT };
            outPins.push({ name: o + bit(k), dir: 'out', host: end, face: side, base: o, role: 'tap' });
        }
    // A shared input: along the line of its terminals if that is free,
    // else a line one further out, each terminal a stub on to it. Laid
    // first: its wire is part of the box the other pins are judged against.
    const sharedHost = new Map();
    for (const p of pins) {
        if (role.get(p.name) !== 'shared') continue;
        const net = `shared:${p.name}`, ends = [at(p, 0), at(p, n - 1)];
        const snap = new Map(wire);
        let why = run(ends[0], ends[1], net, p.name);
        let host = ends[0];
        if (why) {
            wire.clear(); for (const [kk, v] of snap) wire.set(kk, v);
            const out = (c) => [c[0] + p.face[0], c[1] + p.face[1]];
            why = run(out(ends[0]), out(ends[1]), net, p.name);
            for (let k = 0; k < n && !why; k++) why = lay(...at(p, k), net, p.name, k);
            host = out(ends[0]);
        }
        if (why) return { error: why };
        sharedHost.set(p.name, host);
    }
    // The box the copies and the array's own wire take, so far.
    const boxOf = () => {
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const kk of [...cells.keys(), ...wire.keys()]) {
            const [x, y] = kk.split(',').map(Number);
            bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
        }
        return { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    };
    const box = boxOf();
    const outside = (c) => c[0] < box.x0 || c[0] > box.x1 || c[1] < box.y0 || c[1] > box.y1;
    const topRec = base.blocks.find((b) => b.lid === tops[0]);
    // A copy's pin that is the array's — through terminal `t` of copy k —
    // is the copy's own (`via` it: its terminals the array's, the array's
    // edge hugging the copies), where that terminal is outside the copies
    // and the array's wire. Where it is not (a bus or a tap runs past it),
    // it is on its terminal, made wire: a stub out to the edge. (`stubs`:
    // every pin so, as arrays were made before a part's pin could be a
    // nested part's — so that one put down then is known again.)
    const own = (p, t, k, name, r, net) => {
        const term = at(t, k);
        if (!spec.stubs && outside(term)) {
            const why = clash(key(...term), p.name, k);
            if (why) return why;
            outPins.push({
                name, dir: p.dir, host: hostAt(t, k), face: t.face, base: p.name, role: r,
                via: 1 + k * maxLid + tops[0], viaPin: topRec.pins.findIndex((q) => q.name === p.name),
            });
            return null;
        }
        const why = lay(...term, net, p.name, k);
        if (why) return why;
        outPins.push({ name, dir: p.dir, host: term, face: t.face, base: p.name, role: r });
        return null;
    };
    for (const p of pins) {
        const r = role.get(p.name);
        if (r === 'chain') {
            // A pin running through is the array's at the first copy's
            // back-facing terminal (its other end, at the last copy, is the
            // array's terminal too: the array's edge follows its wire).
            const first = chains.some(([, i]) => i === p.name), k = first ? 0 : n - 1;
            const t = through.has(p.name) ? through.get(p.name).back : p;
            const why = own(p, t, k, tapSet.has(p.name) ? p.name + bit(k) : p.name, 'chain', `chain:${p.name}:end`);
            if (why) return { error: why };
        } else if (r === 'each') {
            for (let k = 0; k < n; k++) {
                const why = own(p, p, k, n > 1 ? p.name + bit(k) : p.name, 'each', `each:${p.name}:${k}`);
                if (why) return { error: why };
            }
        } else outPins.push({ name: p.name, dir: p.dir, host: sharedHost.get(p.name), face: p.face, base: p.name, role: 'shared' });
    }
    // No two nets side by side: a wire of one beside a wire of another
    // joins them.
    for (const [kk, net] of wire) {
        const [x, y] = kk.split(',').map(Number);
        for (const [dx, dy] of DIRS) {
            const other = wire.get(key(x + dx, y + dy));
            if (other && other !== net) return { error: 'Two copies’ terminals would touch' };
        }
    }
    const names = outPins.map((p) => p.name);
    if (new Set(names).size !== names.length) return { error: 'Two of its pins would have the same name' };

    // Wrapped: everything in one box, the array's pins in it.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const kk of [...cells.keys(), ...wire.keys()]) {
        const [x, y] = kk.split(',').map(Number);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    for (const p of outPins) {
        const tx = p.host[0] + p.face[0], ty = p.host[1] + p.face[1];
        if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) return { error: `${p.name} would end up inside the array` };
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w * h > MAX_CELLS) return { error: 'Too big' };
    const data = new Uint8Array(w * h), bmap = new Int32Array(w * h).fill(1), pmap = new Int16Array(w * h);
    for (const [kk, c] of cells) {
        const [x, y] = kk.split(',').map(Number), i = (y - y0) * w + (x - x0);
        data[i] = c.id; bmap[i] = c.lid; pmap[i] = c.pin;
    }
    for (const kk of wire.keys()) {
        const [x, y] = kk.split(',').map(Number);
        data[(y - y0) * w + (x - x0)] = ID_CONDUCTOR_BASE;
    }
    // Inputs, then outputs; a bus most significant bit first.
    const num = (p) => { const m = /(\d+)$/.exec(p.name); return m ? +m[1] : -1; };
    const stem = (p) => p.name.replace(/\d+$/, '');
    const ranked = (dir) => outPins.filter((p) => p.dir === dir).map((p, i) => ({ p, i }))
        .sort((a, b) => (stem(a.p) === stem(b.p) ? num(b.p) - num(a.p) : a.i - b.i)).map((e) => e.p);
    const order = ranked('in').concat(ranked('out'));
    // (A pin via a copy has no cell of its own: the copy's pin is it.)
    order.forEach((p, j) => {
        if (p.via) return;
        const fd = DIRS.findIndex(([fx, fy]) => fx === p.face[0] && fy === p.face[1]);
        pmap[(p.host[1] - y0) * w + (p.host[0] - x0)] = pinCode(j, fd);
    });
    const blocksOut = [{
        lid: 1, name: String((spec.name || topRec.name) + (n > 1 ? n : '')).slice(0, 40), source: '', parent: 0, open: false,
        pins: order.map((p) => (p.via ? { name: p.name, dir: p.dir, via: p.via, viaPin: p.viaPin } : { name: p.name, dir: p.dir })),
    }];
    for (let k = 0; k < n; k++)
        for (const b of base.blocks)
            blocksOut.push({
                ...b, lid: 1 + k * maxLid + b.lid, parent: b.parent ? 1 + k * maxLid + b.parent : 1, open: false,
                pins: b.pins.map((p) => (p.via ? { ...p, via: 1 + k * maxLid + p.via } : { ...p })),
            });
    return {
        clip: { w, h, data, blocks: blocksOut, bmap, pmap },
        origin: [-x0, -y0], pitch, chains,
        shared: pins.filter((p) => role.get(p.name) === 'shared').map((p) => p.name),
        each: pins.filter((p) => role.get(p.name) === 'each').map((p) => p.name),
        taps: [...tapSet],
        sources: order.map((p) => ({ name: p.name, base: p.base, role: p.role })),
    };
}
// Is the clip's cell `a` joined to `b` by its own wire — wire to wire,
// straight on over a crossing — inside it?
function wiredThrough(c, a, b) {
    const inClip = (x, y) => x >= 0 && y >= 0 && x < c.w && y < c.h;
    const wireAt = (x, y) => inClip(x, y) && isWireId(c.data[y * c.w + x]);
    if (!wireAt(a[0], a[1]) || !wireAt(b[0], b[1])) return false;
    const cross = (x, y) => inClip(x, y) && isXover(c.data[y * c.w + x]);
    const seen = new Set(), stack = [[a[0], a[1], -1]];
    while (stack.length) {
        const [x, y, d] = stack.pop();
        if (x === b[0] && y === b[1]) return true;
        const c4 = cross(x, y), k = x + ',' + y + (c4 ? (d & 1 ? 'h' : 'v') : '');
        if (seen.has(k)) continue;
        seen.add(k);
        for (const w of c4 && d >= 0 ? [d] : [0, 1, 2, 3]) {
            const nx = x + DIRS[w][0], ny = y + DIRS[w][1];
            if (wireAt(nx, ny)) stack.push([nx, ny, w]);
        }
    }
    return false;
}

// n copies of `base`, copy k at off(k): every cell, in copy 0's
// coordinates, as {id, lid, pin, copy} by 'x,y' — a copy's blocks
// numbered after the one before's, a cell no block holds given `free` —
// and every copy's edge, [{copy, cls, pin}] by 'x,y'. Or {error}: two
// copies overlap, or one joins another. Where it keeps bare, as on a
// board. On a terminal too, though a board would take it as a connection:
// copies are put down by the array, not by hand, and joining them is not
// theirs to do by happening to touch — a latch stacked flush would have its
// E on the Q loop of the one below — but for the pins `meet` names as
// meeting head on ('out|in', both ways round: a carry out on the next
// copy's carry in). What joins nothing — a bare cell, a mux's plain side
// — is nothing to it. Edge over edge is fine, whatever each says there:
// it is a bare cell, unless an array has a wire to lay there.
function layCopies(base, off, n, free, meet) {
    const cells = new Map();     // 'x,y' -> {id, lid, pin, copy}
    const key = (x, y) => x + ',' + y;
    let maxLid = 0;
    for (const b of base.blocks) maxLid = Math.max(maxLid, b.lid);
    for (let k = 0; k < n; k++) {
        const [ox, oy] = off(k);
        for (let y = 0; y < base.h; y++)
            for (let x = 0; x < base.w; x++) {
                const i = y * base.w + x, kk = key(ox + x, oy + y);
                if (cells.has(kk)) return { error: 'Copies that close would overlap' };
                cells.set(kk, { id: base.data[i], lid: base.bmap[i] ? 1 + k * maxLid + base.bmap[i] : free, pin: base.pmap[i], copy: k });
            }
    }
    const ring = clipRing(base), pins = clipPins(base), top = clipTops(base)[0];
    const box = { x0: 0, y0: 0, x1: base.w - 1, y1: base.h - 1 };
    const faceOf = (c) => (c.pin && isMuxId(c.id) ? pinFaceOf(c.pin) : -1);
    // The part's own pin a copy's cell is (its top block's), or null.
    const pinOf = (c) => (c.pin && c.lid === 1 + c.copy * maxLid + top ? pins[pinIndex(c.pin)] : null);
    const edge = new Map();      // 'x,y' -> [{copy, cls, pin}]
    for (let k = 0; k < n; k++) {
        const [ox, oy] = off(k);
        for (const r of ring) {
            const kk = key(ox + r.x, oy + r.y), c = cells.get(kk);
            if (c && c.copy !== k && r.cls !== 'X') {
                const [hx, hy] = edgeHost(box, r.x, r.y), own = cells.get(key(ox + hx, oy + hy));
                if (own && idConnects(c.id, faceOf(c), [hx - r.x, hy - r.y]) && idConnects(own.id, faceOf(own), [r.x - hx, r.y - hy])) {
                    if (r.cls === 'R') return { error: 'Copies that close would join where one keeps bare' };
                    const mine = pins[r.pin], theirs = pinOf(c);
                    if (!(mine && theirs && meet && meet.has(mine.name + '|' + theirs.name)))
                        return { error: `Copies that close would join: ${mine ? mine.name : 'a pin'} would meet the next copy` };
                }
            }
            if (!edge.has(kk)) edge.set(kk, []);
            edge.get(kk).push({ copy: k, cls: r.cls, pin: r.pin });
        }
    }
    return { cells, edge, maxLid };
}
// The copies side by side, each its own part (arrayClip's `apart`).
function apartClip(base, off, n, pitch) {
    const laid = layCopies(base, off, n, 0);
    if (laid.error) return laid;
    const { cells, maxLid } = laid;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const kk of cells.keys()) {
        const [x, y] = kk.split(',').map(Number);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w * h > MAX_CELLS) return { error: 'Too big' };
    const data = new Uint8Array(w * h), bmap = new Int32Array(w * h), pmap = new Int16Array(w * h);
    for (const [kk, c] of cells) {
        const [x, y] = kk.split(',').map(Number), i = (y - y0) * w + (x - x0);
        data[i] = c.id; bmap[i] = c.lid; pmap[i] = c.pin;
    }
    const blocks = [];
    for (let k = 0; k < n; k++)
        for (const b of base.blocks)
            blocks.push({
                ...b, lid: 1 + k * maxLid + b.lid, parent: b.parent ? 1 + k * maxLid + b.parent : 0, open: false,
                pins: b.pins.map((p) => (p.via ? { ...p, via: 1 + k * maxLid + p.via } : { ...p })),
            });
    return { clip: { w, h, data, blocks, bmap, pmap }, origin: [-x0, -y0], pitch, apart: true, chains: [], shared: [], each: [], taps: [], sources: [] };
}

// How a part would repeat each way ({dir, pitch, chains, error}, four of
// them), and the way it most likely means to: the way its chains run
// (a carry out on top: upward), at the tightest spacing that works. What
// counts is a chain out of an output — into the next copy's input — not
// an input running on through (an enable up a stack): a
// slice whose carry in has terminals both sides runs it through sideways
// too, and that made the player's incrementer slice go off to the right,
// its Q into the next one's A. Ties go up, the way the game's stacks carry.
// `opts`: the rest of a spec (shared, taps, tapSide), as it stands.
function arrayPlan(base, opts) {
    const ways = [0, 1, 2, 3].map((dir) => {
        const along = DIRS[dir][0] ? base.w : base.h;
        let last = null;
        for (let pitch = along; pitch <= along + 6; pitch++) {
            const r = arrayClip(base, { ...opts, dir, pitch }, 3);
            if (!r.error) return { dir, pitch, chains: r.chains, shared: r.shared, each: r.each, taps: r.taps };
            last = r.error;
        }
        return { dir, error: last };
    });
    const ok = ways.filter((w) => !w.error);
    const outs = new Set(clipPins(base).filter((p) => p.dir === 'out').map((p) => p.name));
    const into = (w) => w.chains.filter(([o]) => outs.has(o)).length;
    const best = ok.slice().sort((a, b) => into(b) - into(a) || a.dir - b.dir)[0] || null;
    return { ways, best };
}

export {
    arrayClip, arrayPlan,
};
