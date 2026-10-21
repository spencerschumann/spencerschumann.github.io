// Clips: a region of cells with the parts in it, as data — the one form
// copy and paste, the parts shelf and a level's part all use — and whether,
// and over what, a clip's parts may be put down (blockFits, clearance).

import {
    DIRS, ID_INSULATOR_PLAIN, inferCrossings, isMuxId, isInsulatorId, mirrorId, rotateId, stripId,
} from './cells.js';
import {
    readPin, copyPin, B, MAX_CELLS, idx, inBounds, packRuns, unpackRuns, withRep,
} from './board.js';
import {
    blockCellIdxs, cellConnects, classifyRing, edgeAt, edgeHost, idConnects, mirrorPinCode, pinFaceOf, pinIndex,
    terminalsByPin, topBlockOf, turnPinCode,
} from './blocks.js';
import {
    recomputeRoles,
} from './edit.js';
import {
    muxBlob,
} from './regions.js';

// ---- Clips that carry blocks ----
// A clip is {w, h, data} — cell ids, row by row — and, when blocks came
// with it, `blocks` (records keyed by a clip-local id `lid`, `parent`
// another lid or 0), `bmap` (each cell's innermost lid, 0 = loose) and
// `pmap` (pin codes, as pinAt). Copy/paste, the parts shelf and a
// level's solution all use this one form.
const clipTops = (c) => (c.blocks || []).filter((b) => !b.parent).map((b) => b.lid);
// Is lid `l` inside lid `top` (or it)?
function clipUnder(c, l, top) {
    const parentOf = c._parentOf || (c._parentOf = new Map(c.blocks.map((b) => [b.lid, b.parent])));
    for (let n = 0; l && n <= c.blocks.length; n++, l = parentOf.get(l)) if (l === top) return true;
    return false;
}
// Where each pin of a clip's block `lid` is, by pin: {x, y, d} (its cell
// and face) or null. A pin `via` a nested part is wherever that part's
// pin is.
function clipPinGeom(c, lid, depth = 0) {
    const rec = c.blocks.find((b) => b.lid === lid);
    if (!rec) return [];
    const out = rec.pins.map(() => null);
    for (let i = 0; i < c.pmap.length; i++) {
        if (c.bmap[i] !== lid || !c.pmap[i]) continue;
        const k = pinIndex(c.pmap[i]);
        if (k >= out.length || rec.pins[k].via) continue;
        out[k] = { x: i % c.w, y: Math.floor(i / c.w), d: pinFaceOf(c.pmap[i]) };
    }
    if (depth < 8)
        rec.pins.forEach((p, k) => {
            const child = p.via && c.blocks.find((b) => b.lid === p.via);
            if (child && child.parent === lid) out[k] = clipPinGeom(c, p.via, depth + 1)[p.viaPin] || null;
        });
    return out;
}
// A block of a clip, at (ox, oy) on the board, as a core for classifyRing.
function coreInClip(c, lid, ox, oy) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) {
            const k = y * c.w + x, l = c.bmap[k];
            if (!l || !clipUnder(c, l, lid)) continue;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    const rec = c.blocks.find((b) => b.lid === lid);
    const pins = [];
    clipPinGeom(c, lid).forEach((g, k) => {
        if (!g) return;
        const dir = rec && rec.pins[k] ? rec.pins[k].dir : 'in';
        pins.push({ hx: ox + g.x, hy: oy + g.y, d: g.d, k, dir });
    });
    const at = (x, y) => {
        const cx = x - ox, cy = y - oy;
        return cx >= 0 && cy >= 0 && cx < c.w && cy < c.h ? cy * c.w + cx : -1;
    };
    return {
        x0: ox + x0, y0: oy + y0, x1: ox + x1, y1: oy + y1,
        id: (x, y) => { const k = at(x, y); return k < 0 ? ID_INSULATOR_PLAIN : c.data[k]; },
        nested: (x, y) => {
            const k = at(x, y);
            if (k < 0) return 0;
            let l = c.bmap[k];
            if (!l || l === lid || !clipUnder(c, l, lid)) return 0;
            while (c._parentOf.get(l) !== lid) l = c._parentOf.get(l);
            return l;
        },
        ringOf: (l) => clipRingOf(c, l, ox, oy),
        pins,
    };
}
function clipRingOf(c, lid, ox, oy) {
    const cache = c._rings || (c._rings = new Map());
    const k = lid + '@' + ox + ',' + oy;
    if (!cache.has(k)) cache.set(k, classifyRing(coreInClip(c, lid, ox, oy)));
    return cache.get(k);
}
// A clip with its outermost part's lid taken off — its cells loose, the
// parts nested in it still parts. What Edit puts down to work on.
function decapClip(c) {
    if (!c.blocks || !c.bmap) return c;
    const tops = new Set(clipTops(c));
    const out = { w: c.w, h: c.h, data: c.data.slice(), bmap: new Int32Array(c.bmap), pmap: new Int16Array(c.pmap) };
    for (let i = 0; i < out.bmap.length; i++) if (tops.has(out.bmap[i])) { out.bmap[i] = 0; out.pmap[i] = 0; }
    out.blocks = c.blocks.filter((b) => !tops.has(b.lid))
        .map((b) => ({ ...b, parent: tops.has(b.parent) ? 0 : b.parent, pins: b.pins.map((p) => ({ ...p })) }));
    if (!out.blocks.length) { delete out.blocks; delete out.bmap; delete out.pmap; }
    return out;
}
// The pins of a clip's outermost block (or the outermost `lid`, of
// several), in the clip's own coordinates:
// [{name, dir, host, face, at, others}], `at` being the terminal outside
// and `others` its other terminals (as blockList has them).
function clipPins(c, lid) {
    const tops = c.blocks && c.bmap ? clipTops(c) : [];
    if (!tops.length) return [];
    const top = c.blocks.find((b) => b.lid === (lid || tops[0]));
    if (!top) return [];
    const ring = clipRingOf(c, top.lid, 0, 0);
    const box = coreInClip(c, top.lid, 0, 0), others = terminalsByPin(ring, box, top.pins.length);
    const pins = top.pins.map((p, k) => ({ name: p.name, dir: p.dir, host: null, face: null, at: null, others: others[k] }));
    clipPinGeom(c, top.lid).forEach((g, k) => {
        if (!g || !pins[k]) return;
        const [dx, dy] = DIRS[g.d], at = [g.x + dx, g.y + dy];
        Object.assign(pins[k], { host: [g.x, g.y], face: [dx, dy], at, others: others[k].filter((t) => t.at[0] !== at[0] || t.at[1] !== at[1]) });
    });
    return pins;
}
// The edge of a clip's outermost block (or the outermost `lid`), in the
// clip's own coordinates.
function clipRing(c, lid) {
    const tops = c.blocks && c.bmap ? clipTops(c) : [];
    return tops.length ? [...clipRingOf(c, lid || tops[0], 0, 0).values()] : [];
}
// Every outermost part of a clip — one, or several put down together (a
// row of copies side by side): [{lid, name, x0, y0, x1, y1, pins, ring}],
// in the clip's own coordinates.
function clipParts(c) {
    return (c.blocks && c.bmap ? clipTops(c) : []).map((lid) => {
        const box = coreInClip(c, lid, 0, 0);
        return {
            lid, name: c.blocks.find((b) => b.lid === lid).name, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
            pins: clipPins(c, lid), ring: clipRing(c, lid),
        };
    });
}

// A clip that came from storage or an import, made safe to paste: right
// lengths, known ids, parents that exist and do not loop. Returns null
// if there is no usable clip at all.
function sanitizeClip(c) {
    if (!c || !Number.isInteger(c.w) || !Number.isInteger(c.h) || c.w <= 0 || c.h <= 0) return null;
    const n = c.w * c.h;
    if (n > MAX_CELLS) return null;
    const cells = unpackRuns(c.data, n), bmap0 = c.bmap && unpackRuns(c.bmap, n), pmap0 = c.pmap && unpackRuns(c.pmap, n);
    if (!cells || cells.length !== n) return null;
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = stripId(cells[i] & 0xff);
    // A clip kept before crossings were cells of their own (no `xo`) is
    // read by the rule it was drawn under.
    if (!c.xo) inferCrossings(data, c.w, c.h);
    const out = { w: c.w, h: c.h, data };
    if (!Array.isArray(c.blocks) || !c.blocks.length || !bmap0 || bmap0.length !== n) return out;
    const recs = [];
    const seen = new Set();
    for (const b of c.blocks) {
        if (!b || !Number.isInteger(b.lid) || b.lid <= 0 || seen.has(b.lid)) continue;
        seen.add(b.lid);
        recs.push(withRep({
            lid: b.lid, name: String(b.name || 'Part').slice(0, 40), source: b.source ? String(b.source) : '',
            parent: Number.isInteger(b.parent) ? b.parent : 0, open: !!b.open,
            pins: (Array.isArray(b.pins) ? b.pins : []).slice(0, 256).map(readPin),
        }, b));
    }
    const byLid = new Map(recs.map((r) => [r.lid, r]));
    for (const r of recs) {
        // A parent that is missing, or that leads back round to this one,
        // is cut: the block stands on its own instead.
        let p = r.parent, steps = 0;
        while (p && byLid.has(p) && p !== r.lid && steps++ < recs.length) p = byLid.get(p).parent;
        if (!byLid.has(r.parent) || p === r.lid || steps >= recs.length) r.parent = 0;
    }
    // A pin via a nested part only of a part directly inside this one.
    for (const r of recs)
        for (const p of r.pins) {
            const child = p.via && byLid.get(p.via);
            if (p.via && !(child && child.parent === r.lid && p.viaPin < child.pins.length)) { delete p.via; delete p.viaPin; }
        }
    const bmap = new Int32Array(n), pmap = new Int16Array(n);
    for (let i = 0; i < n; i++) {
        const l = bmap0[i] | 0;
        if (byLid.has(l)) bmap[i] = l;
    }
    for (let i = 0; i < n; i++) {
        const l = bmap[i], p = pmap0 ? pmap0[i] | 0 : 0;
        if (l && p > 0 && pinIndex(p) < byLid.get(l).pins.length) pmap[i] = p;
    }
    out.blocks = recs;
    out.bmap = bmap;
    out.pmap = pmap;
    return out;
}
// Plain arrays, for JSON.
function clipToJSON(c) {
    const o = { w: c.w, h: c.h, xo: 1, data: packRuns(c.data) };
    if (c.blocks && c.blocks.length) {
        o.pv = 2;
        o.blocks = c.blocks.map((b) => withRep({
            lid: b.lid, name: b.name, source: b.source, parent: b.parent, open: !!b.open,
            pins: b.pins.map((p) => copyPin(p)),
        }, b));
        o.bmap = packRuns(c.bmap);
        o.pmap = packRuns(c.pmap);
    }
    return o;
}

// A quarter turn clockwise, or a left-right flip, of a clip — blocks and
// pins turn with their cells, pins' faces too.
function transformClip(c, turn) {
    const w = turn ? c.h : c.w, h = turn ? c.w : c.h;
    const to = turn
        ? (x, y) => x * w + (c.h - 1 - y)     // (x, y) -> (c.h-1-y, x), as rotateRegionCW
        : (x, y) => y * w + (c.w - 1 - x);
    const out = { w, h, data: new Uint8Array(w * h) };
    const hasBlocks = !!(c.blocks && c.blocks.length && c.bmap);
    if (hasBlocks) {
        out.blocks = c.blocks.map((b) => ({ ...b, pins: b.pins.map((p) => ({ ...p })) }));
        out.bmap = new Int32Array(w * h);
        out.pmap = new Int16Array(w * h);
    }
    for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) {
            const k = y * c.w + x, t = to(x, y);
            out.data[t] = turn ? rotateId(c.data[k], 1) : mirrorId(c.data[k]);
            if (!hasBlocks) continue;
            out.bmap[t] = c.bmap[k];
            const p = c.pmap ? c.pmap[k] : 0;
            out.pmap[t] = turn ? turnPinCode(p, 1) : mirrorPinCode(p);
        }
    return out;
}
function rotateClipCW(c) { return transformClip(c, true); }
function mirrorClipH(c) { return transformClip(c, false); }

// A clip's cell, as about to be put down with its top-left at (x0, y0):
// does it meet the board cell beside it, (x, y) on the board one step `d`
// ([dx, dy]) from it, on that side? (`k` its index in the clip.)
const clipConnects = (c, k, d) => idConnects(c.data[k], c.bmap && c.bmap[k] && c.pmap[k] && isMuxId(c.data[k]) ? pinFaceOf(c.pmap[k]) : -1, d);
// Why the blocks of a clip cannot land with the clip's top-left at
// (x0, y0), or null if they can. A part's core needs empty board, and
// nothing of it may join another part where that part keeps bare; its
// own edge, likewise, nothing on it that joins it where it keeps bare.
// Anything else may meet: on a terminal, whatever joins it is joined to
// that pin — a mux's lead, another part's pin, straight on with no wire
// between — and what does not join it (a mux's plain side, a bare cell)
// is nothing to it. Edges overlap whatever each says: the cell is bare
// unless something is put there. `grow`: cells off the board are fine
// (the sandbox grows to take them). `gone`: cells taken as already
// cleared — what a part put down replaces (see clearanceFor).
function clipBlockFits(c, lid, x0, y0, grow, gone) {
    const at = (i) => (gone && gone.has(i) ? ID_INSULATOR_PLAIN : B.cells[i]);
    const boardConnects = (x, y, d) => !(gone && gone.has(idx(x, y))) && cellConnects(x, y, d);
    const core = coreInClip(c, lid, x0, y0);
    const k = (x, y) => (y - y0) * c.w + (x - x0);
    for (let y = core.y0; y <= core.y1; y++)
        for (let x = core.x0; x <= core.x1; x++) {
            if (!c.bmap[k(x, y)] || !clipUnder(c, c.bmap[k(x, y)], lid)) continue;
            if (!inBounds(x, y)) { if (grow) continue; return 'No room for it here'; }
            const i = idx(x, y);
            if (B.blockAt[i]) return 'It would sit on another part';
            if (B.anyLocked && B.locked[i] === 1) return 'It would sit on a pad';
            if (!isInsulatorId(at(i))) return 'It needs empty board to sit on';
            for (const e of edgeAt(x, y)) {
                if (e.cls !== 'R') continue;
                const [hx, hy] = edgeHost(B.blockGeom.get(e.id), x, y);
                if (clipConnects(c, k(x, y), [hx - x, hy - y]) && boardConnects(hx, hy, [x - hx, y - hy]))
                    return `It would join ${B.blocks.get(e.id).name} where that keeps bare`;
            }
        }
    for (const r of clipRingOf(c, lid, x0, y0).values()) {
        if (r.cls !== 'R' || !inBounds(r.x, r.y)) continue;
        const [hx, hy] = edgeHost(core, r.x, r.y);
        if (boardConnects(r.x, r.y, [hx - r.x, hy - r.y]) && clipConnects(c, k(hx, hy), [r.x - hx, r.y - hy]))
            return 'Something is in the way of its edge';
    }
    return null;
}
// What putting something down replaces. The player is saying "this,
// here, now, instead of whatever was there", so everything in its way
// goes but a level's pad, which never moves: loose cells under it, and
// on its edge whatever would join it where it keeps bare (wire there is
// cut, as it would reach inside); a mux it covers, or joins where it
// keeps bare, whole (a piece left would be inert material, not a mux);
// and another part under it, joining its kept-bare edge, or whose
// kept-bare edge it would join, whole. Whatever meets it on one of its
// terminals stays — wire, a source, a pad, a mux's lead, another part's
// pin: that is its connection — and so does whatever beside it joins
// nothing (a mux's plain side). `cellsOf` is where its body goes,
// `ringOf` its edge ({x, y, cls}, or none for a lone mux, which has no
// kept-bare edge), `core` its box, and `connects(i, d)` whether its body
// at cell i meets what is beside it on side d ([dx, dy]). Returns {why}
// if a level's pad is in the way, else {gone: cell indexes, parts: ids}.
function clearance(cellsOf, ringOf, core, connects) {
    const gone = new Set(), parts = new Set(), body = new Set(cellsOf);
    const xy = (i) => [i % B.w, Math.floor(i / B.w)];
    for (const i of body) {
        if (B.anyLocked && B.locked[i] === 1) return { why: 'A pad is in the way' };
        if (B.blockAt[i]) { parts.add(topBlockOf(B.blockAt[i])); continue; }
        // Against another part where it keeps bare, and joining it there:
        // that part goes.
        const [x, y] = xy(i);
        for (const e of edgeAt(x, y)) {
            if (e.cls !== 'R') continue;
            const [hx, hy] = edgeHost(B.blockGeom.get(e.id), x, y);
            if (connects(i, [hx - x, hy - y]) && cellConnects(hx, hy, [x - hx, y - hy])) parts.add(e.id);
        }
        if (!isInsulatorId(B.cells[i])) gone.add(i);
    }
    for (const r of ringOf) {
        if (r.cls !== 'R' || !inBounds(r.x, r.y)) continue;
        const i = idx(r.x, r.y), [hx, hy] = edgeHost(core, r.x, r.y);
        if (!cellConnects(r.x, r.y, [hx - r.x, hy - r.y]) || !connects(idx(hx, hy), [r.x - hx, r.y - hy])) continue;
        if (B.blockAt[i]) { parts.add(topBlockOf(B.blockAt[i])); continue; }
        if (B.anyLocked && B.locked[i] === 1) return { why: 'A pad is against its edge' };
        gone.add(i);
    }
    for (const i of [...gone]) {
        if (!isMuxId(B.cells[i]) || B.blockAt[i]) continue;
        const x = i % B.w, y = (i - x) / B.w;
        for (const [gx, gy] of muxBlob(x, y)) gone.add(idx(gx, gy));
    }
    return { gone, parts };
}
// The clearance for a clip's part (see clearance) with the clip's
// top-left at (x0, y0).
function clearanceFor(c, lid, x0, y0) {
    const core = coreInClip(c, lid, x0, y0), body = [], kOf = new Map();
    for (let y = core.y0; y <= core.y1; y++)
        for (let x = core.x0; x <= core.x1; x++) {
            const k = (y - y0) * c.w + (x - x0);
            if (!c.bmap[k] || !clipUnder(c, c.bmap[k], lid) || !inBounds(x, y)) continue;
            body.push(idx(x, y));
            kOf.set(idx(x, y), k);
        }
    return clearance(body, [...clipRingOf(c, lid, x0, y0).values()], core,
        (i, d) => kOf.has(i) && clipConnects(c, kOf.get(i), d));
}
// ...and for a lone mux about to be stamped over `list` ([x, y, id], as
// muxLayout gives it).
function muxClearance(list) {
    for (const [x, y] of list) if (!inBounds(x, y)) return { why: 'No room for a mux here' };
    const idAt = new Map(list.map(([x, y, id]) => [idx(x, y), id]));
    return clearance([...idAt.keys()], [], null, (i, d) => idConnects(idAt.get(i), -1, d));
}
// Clears what a clearance names: those cells, and those parts whole.
function applyClearance(cl) {
    for (const id of cl.parts || [])
        for (const i of blockCellIdxs(id)) { B.cells[i] = ID_INSULATOR_PLAIN; B.blockAt[i] = 0; B.pinAt[i] = 0; }
    for (const i of cl.gone || []) { B.cells[i] = ID_INSULATOR_PLAIN; B.blockAt[i] = 0; B.pinAt[i] = 0; }
    recomputeRoles();
}
// `opts.replace`: what is in the way is replaced (see clearance) — how a
// part is put down, as paste puts anything — so the only refusals are a
// level's pad and, on a level's board, the edge.
function blockFits(clip, x0, y0, opts) {
    if (!clip.bmap) return null;
    for (const lid of clipTops(clip)) {
        if (opts && opts.replace) {
            if (!opts.grow) {
                const core = coreInClip(clip, lid, x0, y0);
                for (let y = core.y0; y <= core.y1; y++)
                    for (let x = core.x0; x <= core.x1; x++) {
                        const k = (y - y0) * clip.w + (x - x0);
                        if (clip.bmap[k] && clipUnder(clip, clip.bmap[k], lid) && !inBounds(x, y)) return 'No room for it here';
                    }
            }
            const cl = clearanceFor(clip, lid, x0, y0);
            if (cl.why) return cl.why;
            continue;
        }
        const why = clipBlockFits(clip, lid, x0, y0, !!(opts && opts.grow), null);
        if (why) return why;
    }
    return null;
}

export {
    clipTops, clipUnder, coreInClip, clipRingOf, decapClip, clipPins, clipRing, clipParts, sanitizeClip,
    clipToJSON, transformClip, rotateClipCW, mirrorClipH, clipBlockFits, clearance,
    clearanceFor, muxClearance, applyClearance, blockFits,
};
