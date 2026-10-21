// Making a part: fitting the smallest core round a circuit, with its
// terminals and edge (fitPart), and capturing it as a clip or capping it
// where it stands (captureRect, capPart, captureBlock).

import {
    DIRS, ID_CONDUCTOR_BASE, ID_NEG, ID_POS, OFF, isConductorId, isMuxId, isInsulatorId, isLed, isSwitch,
    isToggle, isWireId, makeConductor, stripId,
} from './cells.js';
import {
    copyPin, B, idx, inBounds, isCrossoverAt,
} from './board.js';
import {
    blockInfo, blockCellIdxs, blockParent, cellConnects, cellsJoin, classifyRing, coreOnBoard, pinCode, pinIndex, topBlockOf,
} from './blocks.js';
import {
    recomputeRoles,
} from './edit.js';
import {
    netCellsOf, walkNet,
} from './nets.js';
import {
    muxBodyCells, normalizeRect,
} from './regions.js';

// The fallback, for a level whose wiring cannot be fitted to a tight edge
// (see fitPart): a part made from everything joined to the given pads —
// and nothing else, so a doodle in a corner stays behind — trimmed to
// what that is, with a one-cell margin round it, and each pad turned into
// wire with a lead run straight out to the margin's edge, where it
// becomes a pin. It is as big as the board's pads are far apart. `pads`: [{name, dir: 'in'|'out', x, y}], each a single
// cell (a level's switch or lamp). `rect`, if given, bounds what may be
// taken. Blocks already on the board come along whole, nested inside
// the new one. Returns {clip} or {error}.
//
// A lead leaves from the pad itself if it can — to the west for an
// input, the east for an output, the way the pads face — and otherwise
// from any wire on the pad's net that has a clear run to the edge: a
// circuit is free to wall its own switch in, running wire round the
// outside of it, and the pin then comes out of that wire instead.
function captureBlock(name, source, pads, rect) {
    if (!pads.length) return { error: 'A part needs at least one pin' };
    const within = (x, y) => inBounds(x, y) && (!rect || (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1));
    const padSet = new Set();
    for (const p of pads) {
        if (!within(p.x, p.y)) return { error: 'A pin is outside the part' };
        padSet.add(idx(p.x, p.y));
    }
    const incl = new Set(padSet), stack = [...padSet], takenTops = new Set();
    while (stack.length) {
        const i = stack.pop();
        const x = i % B.w, y = (i - x) / B.w;
        if (B.blockAt[i]) {
            const top = topBlockOf(B.blockAt[i]);
            if (!takenTops.has(top)) {
                takenTops.add(top);
                for (const j of blockCellIdxs(top)) {
                    const jx = j % B.w, jy = (j - jx) / B.w;
                    if (!within(jx, jy)) return { error: 'A part it uses is not wholly inside' };
                    if (!incl.has(j)) { incl.add(j); stack.push(j); }
                }
            }
            // A block leads anywhere else only through its own pins.
            if (!(B.pinAt[i] && B.blockAt[i] === top)) continue;
        }
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (!within(nx, ny)) continue;
            const ni = idx(nx, ny);
            if (incl.has(ni)) continue;
            if (B.blockAt[ni]) {
                if (!(B.pinAt[ni] && B.blockAt[ni] === topBlockOf(B.blockAt[ni]))) continue;
            } else if (isInsulatorId(B.cells[ni])) continue;
            incl.add(ni);
            stack.push(ni);
        }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of incl) {
        const x = i % B.w, y = (i - x) / B.w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    x0--; y0--; x1++; y1++;   // the margin
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const has = (x, y) => incl.has(inBounds(x, y) ? idx(x, y) : -1);
    const onEdge = (x, y, d) => (d === 0 ? y === y0 : d === 1 ? x === x1 : d === 2 ? y === y1 : x === x0);
    // Each pad's way out: straight to the margin's edge, through cells
    // the part does not use, with nothing of the part flush beside it.
    // Where it starts from must be left with at most three wires: with
    // a fourth it would be a crossing, not a junction.
    const leadCells = new Set(), leads = [];
    const clearRun = (sx, sy, d) => {
        const [dx, dy] = DIRS[d], path = [];
        let x = sx, y = sy;
        while (!onEdge(x, y, d)) {
            x += dx; y += dy;
            if (has(x, y) || leadCells.has(x + ',' + y)) return null;
            const side = d % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
            if (side.some(([ex, ey]) => has(x + ex, y + ey) || leadCells.has((x + ex) + ',' + (y + ey)))) return null;
            path.push([x, y]);
        }
        return path.length ? path : null;
    };
    const armsAt = (x, y) => {
        let n = 0;
        for (const [dx, dy] of DIRS) if (has(x + dx, y + dy) && cellConnects(x + dx, y + dy, [-dx, -dy])) n++;
        return n;
    };
    for (let k = 0; k < pads.length; k++) {
        const p = pads[k];
        const order = p.dir === 'out' ? [1, 0, 2, 3] : [3, 0, 2, 1];
        const padIdx = idx(p.x, p.y);
        // The pad first, then the rest of its wire.
        const starts = [padIdx, ...[...netCellsOf(padIdx)].filter((i) =>
            i !== padIdx && incl.has(i) && isConductorId(B.cells[i]) && !B.blockAt[i]
            && !isCrossoverAt(i % B.w, (i - i % B.w) / B.w))];
        let found = null;
        for (const d of order) {
            let best = null;
            for (const si of starts) {
                const sx = si % B.w, sy = (si - sx) / B.w;
                if (armsAt(sx, sy) >= 3) continue;
                const path = clearRun(sx, sy, d);
                if (path && (!best || path.length < best.path.length)) best = { path, d };
                if (best && si === padIdx) break;   // the pad itself wins
            }
            if (best) { found = best; break; }
        }
        if (!found) return { error: `Nothing clear around ${p.name} to bring its pin out` };
        for (const [x, y] of found.path) leadCells.add(x + ',' + y);
        leads.push(found);
    }
    const data = new Uint8Array(w * h);
    const bmap = new Int32Array(w * h).fill(1);
    const pmap = new Int16Array(w * h);
    const lidOf = new Map();
    let nextLid = 2;
    for (const i of incl) {
        const x = i % B.w, y = (i - x) / B.w;
        const k = (y - y0) * w + (x - x0);
        data[k] = padSet.has(i) ? makeConductor(OFF) : stripId(B.cells[i]);
        if (!B.blockAt[i]) continue;
        for (let b = B.blockAt[i]; b; b = blockParent(b)) if (!lidOf.has(b)) lidOf.set(b, nextLid++);
        bmap[k] = lidOf.get(B.blockAt[i]);
        pmap[k] = B.pinAt[i];
    }
    const recs = [{ lid: 1, name, source: source || '', parent: 0, open: false, pins: pads.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in' })) }];
    for (const [b, lid] of lidOf) {
        const r = B.blocks.get(b);
        recs.push({ lid, name: r.name, source: r.source, parent: r.parent ? lidOf.get(r.parent) : 1, open: false, pins: r.pins.map((p) => copyPin(p, (v) => lidOf.get(v))) });
    }
    leads.forEach(({ path, d }, k) => {
        for (const [x, y] of path) data[(y - y0) * w + (x - x0)] = makeConductor(OFF);
        const [px, py] = path[path.length - 1];
        pmap[(py - y0) * w + (px - x0)] = pinCode(k, d);
    });
    return { clip: { w, h, data, blocks: recs, bmap, pmap } };
}

// ===== Fitting a part =====
//
// A part is its core and nothing more: the smallest rectangle holding
// its muxes, sources and parts, and the wires that only join them to
// each other. Everything round it is edge (see classifyRing), and the
// edge is where the terminals are — the wires, switches or lamps that
// meet the circuit from outside. An inverter is its 3x2 mux and the row
// of sources under it: 3x3, its input and output wires just outside.
//
// `fitPart` finds that rectangle round a circuit on the board. It starts
// from everything that has to be inside and grows an edge wherever the
// ring round it holds something it may not: a wire that joins the
// circuit somewhere that cannot be a pin (a source, the middle of a
// wire run inside, a part nested in it), one terminal meeting the
// circuit twice (the meeting nearest where the wire leads is kept —
// unless the other is beside the same wire inside, which makes it the
// same pin's terminal too), or anything on a cell the edge must keep
// bare. What lies on the edge's
// free cells — a wire running past, a test switch — is left outside. One
// edge at a time, the one with the most trouble, then look again.
//
// `region` bounds the core (the board, or a selection — which says where
// the part may reach, so a selection of just the core is enough); the
// ring round it may sit a cell outside, off the board included (off the
// board is bare). `pads`, in a level, are its switches and lamps: each must
// meet exactly one terminal, which takes its name. Without pads — the
// sandbox — a terminal is anything on the ring that meets the circuit.
// Returns {core, ring, pins: [{x, y, hx, hy, d, side, dir, name?}],
// edge: [{x, y, cls, pin}]}, or {error, cells}.
const SIDE_OF_FACE = ['n', 'e', 's', 'w'];
function fitPart(region, pads) {
    const r0 = normalizeRect(region.x0, region.y0, region.x1, region.y1);
    const inRegion = (x, y) => x >= r0.x0 && x <= r0.x1 && y >= r0.y0 && y <= r0.y1;
    const fail = (error, list) => ({ error, cells: list || [] });
    const padAt = new Map();
    if (pads) for (const p of pads) padAt.set(idx(p.x, p.y), p);
    const isFixture = (i) => !B.blockAt[i] && (isToggle(B.cells[i]) || isSwitch(B.cells[i]) || isLed(B.cells[i]));
    const xy = (i) => [i % B.w, (i - i % B.w) / B.w];
    const connectsWay = (x, y, dx, dy) => inBounds(x, y) && inBounds(x + dx, y + dy)
        && cellConnects(x, y, [dx, dy]) && cellConnects(x + dx, y + dy, [-dx, -dy]);

    // What has to be inside: muxes, sources, parts.
    const core = new Set(), tops = new Set();
    for (let y = r0.y0; y <= r0.y1; y++)
        for (let x = r0.x0; x <= r0.x1; x++) {
            const i = idx(x, y), id = B.cells[i];
            if (B.blockAt[i]) { core.add(i); tops.add(topBlockOf(B.blockAt[i])); continue; }
            if (isMuxId(id) || id === ID_POS || id === ID_NEG) core.add(i);
            else if (pads && isFixture(i) && !padAt.has(i))
                return fail('Only the level’s own switches and lamps can be on the board', [[x, y]]);
        }
    for (const t of tops)
        for (const j of blockCellIdxs(t)) {
            const [jx, jy] = xy(j);
            if (!inRegion(jx, jy)) return fail('A part it uses is not wholly inside', [[jx, jy]]);
        }
    // ...and every mux, whole: one cut in two is no mux on either side.
    for (const i of core) {
        const r = B.roles[i];
        if (B.blockAt[i] || !r || !r.macro) continue;
        for (const [mx, my] of muxBodyCells(r.macro))
            if (!inRegion(mx, my)) return fail('A mux it uses is not wholly inside', [[mx, my]]);
    }
    if (!core.size) return fail('There is nothing here to make a part of: a part needs a mux or a part inside it');

    // Every wire net: what it touches, where it leads. (Wires on the
    // ring just outside the region count: that is where terminals are.)
    const netOf = new Map(), nets = [];
    for (let y = r0.y0 - 1; y <= r0.y1 + 1; y++)
        for (let x = r0.x0 - 1; x <= r0.x1 + 1; x++) {
            if (!inBounds(x, y)) continue;
            const i = idx(x, y);
            if (netOf.has(i) || !isWireId(B.cells[i]) || B.blockAt[i]) continue;
            const net = { id: nets.length, cells: [i], core: false, out: false, ext: [], leaves: false };
            nets.push(net);
            netOf.set(i, net.id);
            walkNet(i, (ci, through) => {
                if (through) {
                    if (!netOf.has(ci)) netOf.set(ci, net.id);
                    net.cells.push(ci);
                    const [cx, cy] = xy(ci);
                    if (!inRegion(cx, cy)) net.leaves = true;
                    return false;
                }
                if (core.has(ci)) {
                    net.core = true;
                    const r = B.roles[ci];
                    if (r && r.macro && r.kind === 'com') net.out = true;
                    if (B.blockAt[ci] && B.pinAt[ci]) {
                        const rec = B.blocks.get(B.blockAt[ci]);
                        const pin = rec && rec.pins[pinIndex(B.pinAt[ci])];
                        if (pin && pin.dir === 'out') net.out = true;
                    }
                } else if (padAt.has(ci) || (!pads && isFixture(ci))) {
                    net.ext.push(ci);
                    if (isLed(B.cells[ci])) net.out = true;
                }
                return false;
            });
        }
    // A pad the core cannot help taking in — a switch whose wire forks
    // right at it, one way up the board and one across, so the fork has
    // to be inside the part — becomes a plain wire junction in the part,
    // with its terminal the cell beyond it on the board's edge side.
    // (Before, that failed the fit, and the level's part fell back to the
    // whole board.) Only where it stays a junction: a switch with at most
    // two wires leaving it, so that wiring its terminal makes a tee and
    // not a crossing; a lamp with one, so no two wires are joined that
    // were not.
    const outwardFace = (p) => (p.face !== undefined ? p.face
        : p.x <= 1 ? 3 : p.x >= B.w - 2 ? 1 : p.y <= 1 ? 0 : p.y >= B.h - 2 ? 2 : -1);
    const deadEnd = (i) => {
        const [x, y] = xy(i);
        let n = 0;
        for (const [dx, dy] of DIRS) if (connectsWay(x, y, dx, dy)) n++;
        return n <= 1;
    };
    // Two of the level's pads on one wire, with nothing of the circuit on
    // it, are just wired together. (Through the circuit they may be: a pin
    // can run straight through a part to another of its own — a slice's
    // SEL in at the bottom and out again at the top as SELo — and which
    // pad each terminal leads to is found from the terminal outward.)
    for (const net of nets) {
        net.pin = net.core && (net.ext.length > 0 || net.leaves || (!pads && net.cells.some(deadEnd)));
        if (pads && net.ext.length > 1 && !net.core) {
            const names = net.ext.map((i) => padAt.get(i).name);
            return fail(`${names.join(' and ')} are wired together`, net.ext.map(xy));
        }
    }
    // How far each wire of a terminal is from where it leads — to pick,
    // when a terminal meets the circuit twice, the meeting that is really
    // its way in.
    const dist = new Map();
    for (const net of nets) {
        if (!net.pin) continue;
        const inNet = new Set(net.cells), queue = [];
        for (const ci of net.cells) {
            const [cx, cy] = xy(ci);
            const ends = !inRegion(cx, cy) || (!pads && deadEnd(ci))
                || DIRS.some(([dx, dy]) => inBounds(cx + dx, cy + dy) && net.ext.includes(idx(cx + dx, cy + dy)));
            if (ends) { dist.set(ci, 0); queue.push(ci); }
        }
        for (let q = 0; q < queue.length; q++) {
            const ci = queue[q], [cx, cy] = xy(ci);
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx, ny = cy + dy;
                if (!inBounds(nx, ny)) continue;
                const ni = idx(nx, ny);
                if (!inNet.has(ni) || dist.has(ni)) continue;
                dist.set(ni, dist.get(ci) + 1);
                queue.push(ni);
            }
        }
    }

    // Start from everything that must be inside.
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const take = (i) => {
        const [x, y] = xy(i);
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
    };
    for (const i of core) take(i);
    for (const net of nets) if (net.core && !net.pin) for (const ci of net.cells) take(ci);
    const C = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    const bound = { n: 'y0', s: 'y1', w: 'x0', e: 'x1' };
    const roomy = () => C.x0 >= r0.x0 && C.y0 >= r0.y0 && C.x1 <= r0.x1 && C.y1 <= r0.y1;

    for (let iter = 0; iter < 4 * (B.w + B.h); iter++) {
        const grow = { n: 0, e: 0, s: 0, w: 0 }, bad = [];
        const inC = (x, y) => x >= C.x0 && x <= C.x1 && y >= C.y0 && y <= C.y1;
        const junction = new Map();     // pad cell taken in -> the face its terminal is on
        for (let y = C.y0; y <= C.y1; y++)
            for (let x = C.x0; x <= C.x1; x++) {
                if (!inBounds(x, y)) continue;
                const i = idx(x, y);
                if (padAt.has(i)) {
                    const p = padAt.get(i), f = outwardFace(p);
                    const inner = DIRS.filter(([dx, dy], d) => d !== f && connectsWay(x, y, dx, dy)).length;
                    if (f >= 0 && !inC(x + DIRS[f][0], y + DIRS[f][1]) && inner <= (p.dir === 'out' ? 1 : 2)) {
                        junction.set(i, f);
                        continue;
                    }
                }
                if (padAt.has(i) || isFixture(i)) return fail('A switch or lamp is in the way of the part', [[x, y]]);
            }
        // The level's pads a terminal's wire leads to, walked from it on the
        // board outside the core — never back through the circuit, where a
        // pin may run on to another of its own. (A pad the core has taken in,
        // a junction, is still a pad: never part of the circuit.)
        const padsBeyond = (i) => {
            const found = new Map(), seen = new Set(), stack = [[i, -1]];
            while (stack.length) {
                const [ci, d] = stack.pop();
                const [cx, cy] = xy(ci), cross = isCrossoverAt(cx, cy), k = cross ? ci + (d & 1 ? 'h' : 'v') : ci;
                if (seen.has(k)) continue;
                seen.add(k);
                for (const w of cross && d >= 0 ? [d] : [0, 1, 2, 3]) {
                    const [dx, dy] = DIRS[w], nx = cx + dx, ny = cy + dy;
                    if (!inBounds(nx, ny) || !connectsWay(cx, cy, dx, dy)) continue;
                    const ni = idx(nx, ny);
                    if (padAt.has(ni)) found.set(ni, padAt.get(ni));
                    else if (!inC(nx, ny) && isWireId(B.cells[ni]) && !B.blockAt[ni]) stack.push([ni, w]);
                }
            }
            return [...found.values()];
        };
        const ring = [];
        for (let x = C.x0 - 1; x <= C.x1 + 1; x++) { ring.push([x, C.y0 - 1]); ring.push([x, C.y1 + 1]); }
        for (let y = C.y0; y <= C.y1; y++) { ring.push([C.x0 - 1, y]); ring.push([C.x1 + 1, y]); }
        const sideOf = (x, y) => (y < C.y0 ? 'n' : y > C.y1 ? 's' : x < C.x0 ? 'w' : 'e');
        const flag = (x, y, why) => { grow[sideOf(x, y)] += 1; bad.push([x, y, why]); };
        const terms = [], others = [];
        for (const [x, y] of ring) {
            const corner = (x < C.x0 || x > C.x1) && (y < C.y0 || y > C.y1);
            // The core cell it faces, and the face.
            const hx = Math.min(Math.max(x, C.x0), C.x1), hy = Math.min(Math.max(y, C.y0), C.y1);
            const d = DIRS.findIndex(([dx, dy]) => hx + dx === x && hy + dy === y);
            const hi = !corner && inBounds(hx, hy) ? idx(hx, hy) : -1;
            // A pad taken in has its terminal here, wired or not — off
            // the board, for a pad on its very edge.
            const jt = hi >= 0 && junction.get(hi) === d;
            if (!inBounds(x, y)) {
                if (jt) {
                    const pad = padAt.get(hi);
                    terms.push({ x, y, hx, hy, d, side: SIDE_OF_FACE[d], key: 'p' + hi, pad, out: pad.dir === 'out', i: -1, jt });
                }
                continue;
            }
            const i = idx(x, y);
            const blank = isInsulatorId(B.cells[i]) && !B.blockAt[i];
            if (corner) { if (!blank) others.push([x, y]); continue; }
            const hid = B.cells[hi];
            // So does a wire of a terminal's that ends at the core's
            // edge pointing straight out: in the sandbox a wire end is a
            // terminal, and when the core has had to grow over the
            // stub drawn to mark one — past a crossing right behind it,
            // which cannot be a pin (unwired, it would turn into a tee
            // and join its two wires) — the terminal is the cell beyond
            // the stub's end, still to be wired.
            const st = !pads && blank && !jt && isWireId(hid) && !isCrossoverAt(hx, hy) && !B.blockAt[hi]
                && netOf.has(hi) && nets[netOf.get(hi)].pin
                && DIRS.every(([dx, dy], k) => connectsWay(hx, hy, dx, dy) === (k === (d + 2) % 4));
            if (blank && !jt && !st) continue;
            if (!jt && !st && !connectsWay(hx, hy, DIRS[d][0], DIRS[d][1])) { others.push([x, y]); continue; }
            // A part nested inside, its pin facing straight out here: that
            // pin can be this part's own (`via` it) — the nested part's
            // mux COM, say, as the terminal, with no wire in between.
            let via = null;
            if (B.blockAt[hi] && !B.blockAt[i]) {
                const top = topBlockOf(B.blockAt[hi]), info = blockInfo(top);
                const j = info ? info.pins.findIndex((q) => q.host && q.host[0] === hx && q.host[1] === hy
                    && q.face[0] === DIRS[d][0] && q.face[1] === DIRS[d][1]) : -1;
                if (j >= 0) via = { via: top, viaPin: j, out: info.pins[j].dir === 'out' };
            }
            if ((B.blockAt[hi] && !via) || B.blockAt[i]) { flag(x, y, 'part'); continue; }
            const wireHost = (isWireId(hid) && !isCrossoverAt(hx, hy)) || junction.has(hi);
            if (!via && !wireHost && !isMuxId(hid)) { flag(x, y, 'solid'); continue; }
            // What it leads to: in a level, one of the pads.
            let key, pad = null, out = false;
            if (jt) { pad = padAt.get(hi); key = 'p' + hi; }
            else if (st) { const net = nets[netOf.get(hi)]; key = 'n' + net.id; out = net.out; }
            else if (padAt.has(i)) { pad = padAt.get(i); key = 'p' + i; }
            else if (isWireId(B.cells[i])) {
                const net = nets[netOf.get(i)];
                if (!net) { flag(x, y, 'stray'); continue; }
                if (pads) {
                    // Two pads out there: they are wired together beyond the
                    // core, which has to take in where they meet.
                    const found = padsBeyond(i);
                    if (found.length !== 1) { flag(x, y, found.length ? 'joined' : 'not a terminal'); continue; }
                    pad = found[0];
                    key = 'p' + idx(pad.x, pad.y);
                } else key = 'n' + net.id;
                out = net.out;
            } else if (!pads && isFixture(i)) { key = 'f' + i; out = isLed(B.cells[i]); }
            else { flag(x, y, 'solid'); continue; }
            if (isMuxId(hid) && !via) {
                const r = B.roles[hi];
                if (r && r.macro && r.macro.comCell[0] === hx && r.macro.comCell[1] === hy) out = true;
            }
            if (via) out = via.out;
            terms.push({ x, y, hx, hy, d, side: SIDE_OF_FACE[d], key, pad, out, i, jt, st, via: via && via.via, viaPin: via && via.viaPin });
        }
        // One meeting per terminal: the one nearest where its wire leads
        // (a pad taken in is where it leads). A stub's end is only the
        // terminal when its wire meets the ring nowhere else, and a
        // second stub end is just a stub.
        const byKey = new Map();
        for (const t of terms) { if (!byKey.has(t.key)) byKey.set(t.key, []); byKey.get(t.key).push(t); }
        const pins = [], again = [];
        const far = (t) => (t.jt ? -1 : dist.has(t.i) ? dist.get(t.i) : 1e9);
        for (const all of byKey.values()) {
            const met = all.filter((t) => !t.st), list = met.length ? met : all.slice(0, 1);
            list.sort((a, b) => far(a) - far(b));
            pins.push(list[0]);
            for (const t of list.slice(1)) again.push([t, pins.length - 1]);
        }
        const edge = classifyRing(coreOnBoard(C, 0, pins.map((p, k) => ({
            hx: p.hx, hy: p.hy, d: p.d, k, dir: p.pad ? p.pad.dir : (p.out ? 'out' : 'in'),
        })), new Set(junction.keys())));
        // Its wire meeting the circuit again is fine where that is beside
        // the same pin's wire inside: one more of that pin's terminals.
        // Anywhere else it joins two things inside that are not one.
        for (const [t, k] of again) {
            const e = edge.get(t.x + ',' + t.y);
            if (!(e && e.cls === 'T' && e.pin === k)) flag(t.x, t.y, 'twice');
        }
        if (!bad.length) {
            // Whatever else is on the ring must be on cells nothing
            // inside cares about.
            for (const [x, y] of others) {
                const e = edge.get(x + ',' + y);
                if (e && e.cls !== 'X') flag(x, y, 'kept bare');
            }
        }
        if (!bad.length) {
            const found = pins.slice();      // the order the edge numbers them in
            if (pads) {
                for (const p of pads)
                    if (!pins.some((q) => q.pad === p)) return fail(`${p.name} never meets the part`, [[p.x, p.y]]);
                pins.sort((a, b) => pads.indexOf(a.pad) - pads.indexOf(b.pad));
            }
            if (!pins.length) return fail('Nothing meets it from outside: a part needs at least one terminal', []);
            return {
                core: { x0: C.x0, y0: C.y0, x1: C.x1, y1: C.y1 },
                ring: { x0: C.x0 - 1, y0: C.y0 - 1, x1: C.x1 + 1, y1: C.y1 + 1 },
                pins: pins.map((p) => ({
                    x: p.x, y: p.y, hx: p.hx, hy: p.hy, d: p.d, side: p.side,
                    dir: p.pad ? p.pad.dir : (p.out ? 'out' : 'in'),
                    name: p.pad ? p.pad.name : undefined, pad: p.pad || undefined,
                    ...(p.via ? { via: p.via, viaPin: p.viaPin } : {}),
                })),
                edge: [...edge.values()].map((e) => ({ x: e.x, y: e.y, cls: e.cls, pin: e.pin >= 0 ? pins.indexOf(found[e.pin]) : -1 })),
                // Pads taken in, which the part has as plain wire.
                junctions: [...junction.keys()].map(xy),
            };
        }
        // One edge at a time — the one with the most trouble — and look
        // again: growing one edge often clears another's trouble too.
        const order = ['n', 'e', 's', 'w'].filter((s) => grow[s] > 0).sort((a, b) => grow[b] - grow[a]);
        let grew = false;
        for (const s of order) {
            C[bound[s]] += s === 'n' || s === 'w' ? -1 : 1;
            if (roomy()) { grew = true; break; }
            C[bound[s]] -= s === 'n' || s === 'w' ? -1 : 1;
        }
        if (!grew) return fail('Something against it could not be taken inside — there is no room left', bad.map(([x, y]) => [x, y]));
    }
    return fail('Could not find an edge for it');
}

// Make a fitted core a part right where it is: its cells become the
// part's, parts already inside it nest in it, and its pins are
// recorded ([{hx, hy, d, name, dir}]). What is round it stays as it was —
// the fit has already made sure that suits the new part's edge. Returns
// the new block's id.
function capPart(r, pins, name, source) {
    const id = B.nextBlockId++;
    B.blocks.set(id, {
        id, name, source: source || '', parent: 0, open: false,
        pins: pins.map((p) => copyPin({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', via: p.via, viaPin: p.viaPin })),
    });
    for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) {
            if (!inBounds(x, y)) continue;
            const i = idx(x, y);
            if (!B.blockAt[i]) { B.blockAt[i] = id; B.pinAt[i] = 0; continue; }
            const t = topBlockOf(B.blockAt[i]);
            if (t !== id) B.blocks.get(t).parent = id;
        }
    pins.forEach((p, k) => { if (!p.via) B.pinAt[idx(p.hx, p.hy)] = pinCode(k, p.d); });
    recomputeRoles();
    return id;
}

// The part a fitted core makes: every cell of it, parts nested inside
// coming along whole, and `pins` ([{hx, hy, d, name, dir}]) as its pins,
// in order — each a core cell and the face it meets the outside by.
// `junctions` ([[x, y]], from the fit) are pads it took in, which the
// part has as plain wire.
function captureRect(r, pins, name, source, junctions) {
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    const data = new Uint8Array(w * h), bmap = new Int32Array(w * h).fill(1), pmap = new Int16Array(w * h);
    const lidOf = new Map();
    let nextLid = 2;
    for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) {
            if (!inBounds(x, y)) continue;
            const i = idx(x, y), k = (y - r.y0) * w + (x - r.x0);
            data[k] = stripId(B.cells[i]);
            if (!B.blockAt[i]) continue;
            for (let b = B.blockAt[i]; b; b = blockParent(b)) if (!lidOf.has(b)) lidOf.set(b, nextLid++);
            bmap[k] = lidOf.get(B.blockAt[i]);
            pmap[k] = B.pinAt[i];
        }
    const recs = [{
        lid: 1, name, source: source || '', parent: 0, open: false,
        pins: pins.map((p) => copyPin({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', via: p.via, viaPin: p.viaPin }, (v) => lidOf.get(v))),
    }];
    for (const [b, lid] of lidOf) {
        const rec = B.blocks.get(b);
        recs.push({
            lid, name: rec.name, source: rec.source, open: false,
            parent: rec.parent && lidOf.has(rec.parent) ? lidOf.get(rec.parent) : 1,
            pins: rec.pins.map((p) => copyPin(p, (v) => lidOf.get(v))),
        });
    }
    for (const [x, y] of junctions || [])
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) data[(y - r.y0) * w + (x - r.x0)] = ID_CONDUCTOR_BASE;
    // A pin via a nested part has no cell of its own: that part's pin is it.
    pins.forEach((p, k) => { if (!p.via) pmap[(p.hy - r.y0) * w + (p.hx - r.x0)] = pinCode(k, p.d); });
    return { w, h, data, blocks: recs, bmap, pmap };
}

// ===== A part's bounds, as the player draws them =====
//
// Make part on the board: the player says where the part's edge is — a
// rectangle, `rect`, its core — and which cells round it are its
// terminals, and names them (`terms`: [{x, y, name, dir}], ring cells).
// Nothing is guessed or grown: this reads the rectangle as that part.
// What meets it from outside — a wire, a switch, a lamp, a mux's lead
// joining something inside — has to be a terminal; terminals can go
// wherever else something inside meets the edge (a wire's end, a mux's
// lead, a nested part's pin); terminals with one name are one pin, its
// first one its own, and must be one wire inside; and a mux or a part the
// edge cuts in two, or a level's switch inside, is no part at all.
//
// Returns {meetings, candidates, problems, pins, edge}: `meetings`, where
// something outside meets it, and `candidates`, where a terminal could go
// with nothing there yet — both [{x, y, hx, hy, d, side, net, hint, out}], `net`
// naming the wire inside it meets (terminals on one wire are one pin
// unless named apart), `hint` a name to start from (the nested part's
// pin it is, or meets), `out` a guess at the way its signal goes (a lamp
// outside, a mux's COM inside); `problems` [{x, y, why}]; `pins` [{name,
// dir, x, y, hx, hy, d, side, via?, viaPin?}] as captureRect and capPart
// take them, one per name; `edge` the edge those pins give it.
function partInBounds(rect, terms) {
    const r = normalizeRect(rect.x0, rect.y0, rect.x1, rect.y1);
    const inR = (x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
    const xy = (i) => [i % B.w, (i - i % B.w) / B.w];
    const problems = [], seenTop = new Set();
    const problem = (x, y, why) => { if (!problems.some((q) => q.x === x && q.y === y)) problems.push({ x, y, why }); };
    const isFixture = (i) => isToggle(B.cells[i]) || isSwitch(B.cells[i]) || isLed(B.cells[i]);
    // Inside: something to be a part of, nothing cut in two, no level pad.
    let any = false;
    for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) {
            const i = idx(x, y), id = B.cells[i];
            if (B.anyLocked && B.locked[i] === 1) { problem(x, y, 'A level’s switch or lamp cannot be inside a part'); continue; }
            if (B.blockAt[i]) {
                any = true;
                const top = topBlockOf(B.blockAt[i]);
                if (seenTop.has(top)) continue;
                seenTop.add(top);
                for (const j of blockCellIdxs(top)) {
                    const [jx, jy] = xy(j);
                    if (!inR(jx, jy)) { problem(x, y, 'The edge cuts a part in two: take all of it in, or none'); break; }
                }
                continue;
            }
            if (isMuxId(id)) {
                any = true;
                const role = B.roles[i];
                if (role && role.macro && muxBodyCells(role.macro).some(([mx, my]) => !inR(mx, my)))
                    problem(x, y, 'The edge cuts a mux in two: take all of it in, or none');
            } else if (id === ID_POS || id === ID_NEG) any = true;
            else if (isFixture(i)) problem(x, y, 'A switch or lamp cannot be inside a part: it is how you try one out');
        }
    if (!any) problem(r.x0, r.y0, 'There is nothing here to make a part of: a part needs a mux or a part inside it');
    // The wires inside, one name for each: followed wire to wire, straight
    // over a crossing (whose two ways are two wires). And whether each
    // carries a signal out — from a mux's COM, a nested part's output —
    // and the name of the first nested part's pin it meets, if any: a
    // name for a terminal on it to start from.
    const netOf = new Map(), outNet = new Set(), hintOf = new Map();
    const ownWire = (x, y) => inR(x, y) && isWireId(B.cells[idx(x, y)]) && !B.blockAt[idx(x, y)];
    const keyOf = (x, y, d) => (isCrossoverAt(x, y) ? `${idx(x, y)}${d & 1 ? 'h' : 'v'}` : String(idx(x, y)));
    const flood = (x0, y0, d0, net) => {
        const stack = [[x0, y0, d0]];
        while (stack.length) {
            const [x, y, d] = stack.pop(), k = keyOf(x, y, d);
            if (netOf.has(k)) continue;
            netOf.set(k, net);
            const cross = isCrossoverAt(x, y);
            for (const w of cross ? [d, (d + 2) & 3] : [0, 1, 2, 3]) {
                const [dx, dy] = DIRS[w], nx = x + dx, ny = y + dy;
                if (!inBounds(nx, ny) || !cellsJoin(x, y, nx, ny)) continue;
                if (ownWire(nx, ny)) { stack.push([nx, ny, w]); continue; }
                if (!inR(nx, ny)) continue;
                const ni = idx(nx, ny), role = B.roles[ni];
                if (isMuxId(B.cells[ni]) && !B.blockAt[ni] && role && role.kind === 'com') outNet.add(net);
                if (B.blockAt[ni] && B.pinAt[ni]) {
                    const rec = B.blocks.get(B.blockAt[ni]), pin = rec && rec.pins[pinIndex(B.pinAt[ni])];
                    if (pin && pin.dir === 'out') outNet.add(net);
                    if (pin && !hintOf.has(net)) hintOf.set(net, pin.name);
                }
            }
        }
    };
    const netAt = (x, y, d) => {
        const k = keyOf(x, y, d);
        if (!netOf.has(k)) flood(x, y, d, 'w' + netOf.size);
        return netOf.get(k);
    };
    // Round the edge: where something meets it, where a terminal could go.
    const meetings = [], candidates = [];
    const ring = [];
    for (let x = r.x0; x <= r.x1; x++) ring.push([x, r.y0 - 1, 0], [x, r.y1 + 1, 2]);
    for (let y = r.y0; y <= r.y1; y++) ring.push([r.x0 - 1, y, 3], [r.x1 + 1, y, 1]);
    for (const [x, y, d] of ring) {
        const hx = x - DIRS[d][0], hy = y - DIRS[d][1], hi = idx(hx, hy);
        const outside = inBounds(x, y) ? idx(x, y) : -1;
        const blank = outside < 0 || (isInsulatorId(B.cells[outside]) && !B.blockAt[outside]);
        // What the cell inside is to a terminal: a wire, a mux's lead, a
        // nested part's pin facing out — or nothing that could be one.
        let net = null, via = null, out = false, why = null;
        if (B.blockAt[hi]) {
            const top = topBlockOf(B.blockAt[hi]), info = blockInfo(top);
            const j = info ? info.pins.findIndex((q) => q.host && q.host[0] === hx && q.host[1] === hy
                && q.face[0] === DIRS[d][0] && q.face[1] === DIRS[d][1]) : -1;
            if (j >= 0) { via = { via: top, viaPin: j }; net = `v${top}:${j}`; out = info.pins[j].dir === 'out'; hintOf.set(net, info.pins[j].name); }
            else why = 'Something meets a part inside here, where that part has no pin';
        } else if (isWireId(B.cells[hi])) {
            // A crossing too: a terminal beyond it is on the one of its two
            // wires that runs out to it (netAt goes by the way, d), and
            // joins nothing else. (It was refused when crossings were read
            // off the shape: wiring it could have made it a tee.)
            net = netAt(hx, hy, d);
            out = outNet.has(net);
        } else if (isMuxId(B.cells[hi])) {
            if (cellConnects(hx, hy, DIRS[d])) { net = `m${hi}`; out = !!(B.roles[hi] && B.roles[hi].kind === 'com'); }
        } else if (!isInsulatorId(B.cells[hi])) why = 'A source or a lamp cannot be a terminal’s cell';
        const side = SIDE_OF_FACE[d];
        if (!blank && inBounds(x, y) && cellsJoin(x, y, hx, hy)) {
            if (why || !net) { problem(x, y, why || 'Something meets it here where nothing inside can be a terminal'); continue; }
            meetings.push({ x, y, hx, hy, d, side, net, hint: hintOf.get(net), out: out || isLed(B.cells[outside]), ...(via || {}) });
        } else if (blank && net) {
            // Room for a wire there. (Not beside a tee, once: a fourth wire
            // on one made a crossing of it. It makes a 4-way, which joins.)
            candidates.push({ x, y, hx, hy, d, side, net, hint: hintOf.get(net), out, ...(via || {}) });
        }
    }
    const at = (list, x, y) => list.find((m) => m.x === x && m.y === y);
    // The player's terminals: one pin to a name, on one wire.
    const pins = [], byName = new Map();
    for (const t of terms || []) {
        const m = at(meetings, t.x, t.y) || at(candidates, t.x, t.y);
        if (!m) { problem(t.x, t.y, 'Nothing inside meets this cell: a terminal goes beside a wire, a mux’s lead or a part’s pin'); continue; }
        const name = String(t.name || '').trim();
        if (!name) { problem(t.x, t.y, 'Every terminal needs a name'); continue; }
        if (!byName.has(name)) {
            byName.set(name, m);
            pins.push({
                name, dir: t.dir === 'out' ? 'out' : 'in', x: m.x, y: m.y, hx: m.hx, hy: m.hy, d: m.d, side: m.side,
                ...(m.via ? { via: m.via, viaPin: m.viaPin } : {}),
            });
        } else if (byName.get(name).net !== m.net) problem(t.x, t.y, `Two terminals named ${name} are not one wire inside: name one of them apart`);
        else if (m.via || isMuxId(B.cells[idx(m.hx, m.hy)])) problem(t.x, t.y, `${name} has only the one terminal there`);
    }
    for (const m of meetings)
        if (!(terms || []).some((t) => t.x === m.x && t.y === m.y)) problem(m.x, m.y, 'Something meets it here: make it a terminal (click it), or move it away');
    // The edge those pins give it: the rest of a name's terminals must be
    // that pin's (not a wire there that would cut it in two).
    const edge = classifyRing(coreOnBoard(r, 0, pins.map((p, k) => ({ hx: p.hx, hy: p.hy, d: p.d, k, dir: p.dir }))));
    for (const t of terms || []) {
        const k = pins.findIndex((p) => p.name === String(t.name || '').trim()), e = edge.get(t.x + ',' + t.y);
        if (k >= 0 && !(pins[k].x === t.x && pins[k].y === t.y) && !(e && e.cls === 'T' && e.pin === k))
            problem(t.x, t.y, `Not ${pins[k].name}’s terminal: a wire here would cut its wire in two`);
    }
    return {
        rect: r, meetings, candidates, problems, pins,
        edge: [...edge.values()].map((e) => ({ x: e.x, y: e.y, cls: e.cls, pin: e.pin })),
    };
}

export {
    captureBlock, SIDE_OF_FACE, fitPart, partInBounds, capPart, captureRect,
};
