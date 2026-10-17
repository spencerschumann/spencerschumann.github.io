// Repeating a part, on the board: its copies set out where they will go
// down, and how they repeat set there, on the copies themselves — and, with
// a part in hand, the bar over the board: turn it, flip it, and how many
// copies go down this time.

import {
    arrayBarEl, arrayCountEl, arrayMsgEl, arrayOkBtn, flashStatus, handBarEl,
} from './page.js';
import {
    drawMode, setDrawMode,
} from './tools.js';
import {
    availableParts, closeComponents, holdPart, placeClipAt, placingPart, turnPart,
} from './parts.js';
import {
    cellPoint, handAt, refreshStampPreview,
} from './stamp.js';
import {
    gameLevel,
} from './campaign.js';
import {
    flushSave, snapshotEntry,
} from './history.js';
import {
    setArrangeSel,
} from './arrange.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const G = window.PixelogicGame;

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const MAX_COPIES = 64;
let handApart = null;       // {key, apart}: joined or apart, for the part in hand

// ---- The part in hand ----
// While the Parts tool holds a part, a bar over the board: turn it (R),
// flip it (M), and — for a part that repeats — how many copies, − and +
// ([ and ]) or typed. How many is chosen here each time, not kept with the
// part: only how it repeats is the part's own. (Not while the copies are
// being set out: their own bar is up then.)
function updateHandBar() {
    const on = drawMode === 'part' && !!placingPart && !arrayEdit;
    handBarEl.classList.toggle('open', on);
    if (!on) return;
    const repeats = !placingPart.loose && !!G.arraySpec(placingPart.key);
    document.getElementById('handName').textContent = placingPart.name;
    document.getElementById('handCount').style.display = repeats ? '' : 'none';
    const apartBtn = document.getElementById('handApartBtn'), apart = apartInHand();
    apartBtn.style.display = repeats ? '' : 'none';
    apartBtn.textContent = apart ? 'Apart' : 'Joined';
    apartBtn.setAttribute('aria-pressed', String(apart));
    apartBtn.title = apart ? 'Copies side by side, each its own part, nothing joined — click to join them up under one lid'
        : 'Copies joined up under one lid — click to put them down side by side instead, each its own part, nothing joined';
    const input = document.getElementById('handCountInput');
    if (document.activeElement !== input) input.value = String(placingPart.array ? placingPart.array.count : 1);
    const arrayBtn = document.getElementById('handArrayBtn');
    arrayBtn.style.display = placingPart.loose ? 'none' : '';
    arrayBtn.title = repeats ? 'How it repeats — set out on the board' : 'Make it repeat: copies in a row, joined up, as one part';
}
// How many copies are in hand: one is the plain part. More than one of a
// part that does not repeat yet sets them out on the board, to say how.
// Joined or apart, as chosen for the part in hand.
const apartInHand = () => !!placingPart && !!handApart && handApart.key === placingPart.key && handApart.apart;
const wayFor = (key, apart) => (apart ? G.apartSpec(key) : G.arraySpec(key));
function setArrayCount(n) {
    if (!placingPart || placingPart.loose) return;
    const part = availableParts().find((q) => q.key === placingPart.key);
    if (!part) return;
    n = Math.max(1, Math.min(MAX_COPIES, n | 0 || 1));
    const spec = G.arraySpec(part.key), apart = apartInHand();
    if (n > 1 && !spec) { openArray(part); return; }
    holdPart(part, n > 1 ? { spec: wayFor(part.key, apart), count: n, apart } : null, placingPart.ops || []);
    updateHandBar();
}
// Joined up, or apart: the bar's switch.
function setHandApart(apart) {
    if (!placingPart || placingPart.loose) return;
    const part = availableParts().find((q) => q.key === placingPart.key);
    if (!part) return;
    const was = handApart;
    handApart = { key: part.key, apart };
    const n = countInHand();
    if (n > 1 && !holdPart(part, { spec: wayFor(part.key, apart), count: n, apart }, placingPart.ops || [])) handApart = was;
    updateHandBar();
}
const countInHand = () => (placingPart && placingPart.array ? placingPart.array.count : 1);

// ---- Repeating a part: set out on the board ----
// Like a modelling program's array modifier: a part laid down n times in a
// row and joined up, under one lid (model.arrayClip) — or apart, side by
// side, each its own part and nothing joined (four latches for a register,
// to wire by hand). Which way the copies go, how far apart, which pins are
// shared or tapped and which end is bit 0 belong to the part: kept with it
// (G.arraySpec), and set here, on the copies themselves, where they will go
// down. Drag the next copy (outlined blue) to where it goes — which side,
// how far; drag any other to move them all; click a pin's tag to share it
// among all the copies or give each its own, a carry's to bring it out of
// every copy as well; click bit 0 to count from the other end. The bar
// over the board holds the rest — turn and flip them, joined or apart,
// how far apart and how many — and Put down puts them down there, keeps
// the way they repeat with the part, and leaves as many again in hand.
// Joined or apart may each go their own way (a latch chains Q to D in a
// row, but stacks for a register).
//
// (This was a panel with a drawing of the copies in it: the way they
// repeated was set there, and then the copies were put in hand to place.)
//
// An array already down is set out again the same way, where it is: picked
// out with Rearrange, Array… lifts it off the board and sets out its copies
// as they were, to make more or fewer of, space, turn or send another way;
// Put down puts the new ones there (one step to undo, back to the old), and
// Cancel puts the old one back.
let arrayEdit = null;   // {part, spec, apart, had, count, ops, anchor, note, noteBad, shown, tool, lifted}
const arrayEditing = () => !!arrayEdit;
// The tool the copies were set out with: another one puts them away.
const arrayEditTool = () => (arrayEdit ? arrayEdit.tool : null);
const WAY_WORDS = ['above', 'to the right of', 'below', 'to the left of'];
const ROLE_TITLE = {
    each: 'each copy’s own — click to make it one for all',
    shared: 'one for all — click to give each copy its own',
    chain: 'joined copy to copy',
    tap: 'out of every copy — click for the other side, then not at all',
};

// A way (0 up, 1 right, 2 down, 3 left) of the part's own, as it shows
// turned and flipped by `ops` ('t' a quarter turn, 'm' a flip) — and back.
const turnWay = (d, ops) => ops.reduce((w, op) => (op === 'm' ? (4 - w) % 4 : (w + 1) % 4), d);
const unturnWay = (d, ops) => ops.reduceRight((w, op) => (op === 'm' ? (4 - w) % 4 : (w + 3) % 4), d);
const along = (part, dir) => (dir % 2 ? part.w : part.h);
// The way being set — the joined copies' spec, or apart, its own {dir,
// pitch} — and it as arrayPart takes it; the copies it makes.
const way = () => (arrayEdit.apart ? arrayEdit.spec.apartWay : arrayEdit.spec);
const wayOpts = () => (arrayEdit.apart ? { ...arrayEdit.spec.apartWay, apart: true } : arrayEdit.spec);
const roleOpts = (spec) => ({ shared: spec.shared, taps: spec.taps, tapSide: spec.tapSide, reverse: spec.reverse });
// Which ways it could go (G.planArray), kept while what it depends on
// stays the same: the bar asks every time it is drawn.
let planKept = { key: null, plan: null };
function planFor() {
    const opts = arrayEdit.apart ? { apart: true } : roleOpts(arrayEdit.spec);
    const key = arrayEdit.part.key + '|' + JSON.stringify(opts);
    if (planKept.key !== key) planKept = { key, plan: G.planArray(arrayEdit.part.key, opts) };
    return planKept.plan;
}
const tried = () => G.arrayPart(arrayEdit.part.key, wayOpts(), arrayEdit.count);
const copySpec = (s) => ({ ...s, shared: [...s.shared], taps: [...s.taps], apartWay: s.apartWay && { ...s.apartWay } });

// The copies as they go down, turned and flipped as in hand: {r, clip,
// boxes, wire} — the array (G.arrayPart), each copy's box in it and the
// array's own wire; or, while the copies do not go together, no clip, and
// copy 0 with the others where they would sit.
function layout() {
    const { part, count, ops } = arrayEdit, w = way(), r = tried();
    if (!r.error) {
        let clip = r.clip;
        for (const op of ops) clip = op === 'm' ? M.mirrorClipH(clip) : M.rotateClipCW(clip);
        // A copy is a part directly under the array's lid (lid 1), or —
        // apart — a part on its own.
        const top = r.apart ? 0 : 1, parentOf = new Map(clip.blocks.map((b) => [b.lid, b.parent]));
        const copyOf = (l) => { while (l && parentOf.get(l) !== top) l = parentOf.get(l); return l; };
        const byCopy = new Map(), wire = [];
        for (let i = 0; i < clip.data.length; i++) {
            const x = i % clip.w, y = (i - x) / clip.w, l = clip.bmap[i];
            if (!l) continue;     // between copies set apart: nobody's
            if (!r.apart && l === 1) { if (M.isConductorId(clip.data[i])) wire.push([x, y]); continue; }
            const k = copyOf(l), b = byCopy.get(k) || { x0: x, y0: y, x1: x, y1: y };
            b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
            byCopy.set(k, b);
        }
        return { r, clip, boxes: [...byCopy.keys()].sort((a, b) => a - b).map((k) => byCopy.get(k)), wire };
    }
    const d = DIRS[w.dir];
    let boxes = [];
    for (let k = 0; k < count; k++) {
        const x = d[0] * w.pitch * k, y = d[1] * w.pitch * k;
        boxes.push({ x0: x, y0: y, x1: x + part.w - 1, y1: y + part.h - 1 });
    }
    const x0 = Math.min(...boxes.map((b) => b.x0)), y0 = Math.min(...boxes.map((b) => b.y0));
    boxes = boxes.map((b) => ({ x0: b.x0 - x0, y0: b.y0 - y0, x1: b.x1 - x0, y1: b.y1 - y0 }));
    let W = Math.max(...boxes.map((b) => b.x1)) + 1, H = Math.max(...boxes.map((b) => b.y1)) + 1;
    for (const op of ops) {
        boxes = boxes.map((b) => (op === 'm' ? { x0: W - 1 - b.x1, y0: b.y0, x1: W - 1 - b.x0, y1: b.y1 }
            : { x0: H - 1 - b.y1, y0: b.x0, x1: H - 1 - b.y0, y1: b.x1 }));
        if (op !== 'm') [W, H] = [H, W];
    }
    return { r, clip: null, boxes, wire: [] };
}
// Copy 0 is where it is put (`anchor`, its top-left on the board); the
// rest go from there, so turning them, spacing them or sending them
// another way leaves it where it was. Where the array's top-left is, then.
const atOf = (L) => ({ x: arrayEdit.anchor.x - L.boxes[0].x0, y: arrayEdit.anchor.y - L.boxes[0].y0 });
// Copy 0 stays on a level's board; in the sandbox, which grows to take
// what is put down past its edge, on it at least in part.
function clampAnchor(a, L) {
    const b = (L || arrayEdit.shown.L).boxes[0], w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    const lo = gameLevel ? [0, 0] : [1 - w, 1 - h], hi = gameLevel ? [M.GRID_W - w, M.GRID_H - h] : [M.GRID_W - 1, M.GRID_H - 1];
    return { x: Math.max(lo[0], Math.min(hi[0], a.x)), y: Math.max(lo[1], Math.min(hi[1], a.y)) };
}
// How much board the copies take: the array's, or — while they do not go
// together — their boxes'.
const extentOf = (L) => (L.clip ? { w: L.clip.w, h: L.clip.h }
    : { w: Math.max(...L.boxes.map((b) => b.x1)) + 1, h: Math.max(...L.boxes.map((b) => b.y1)) + 1 });
// The array's top-left moved as little as it takes for all of it to be on
// the board — with a cell to spare round it for its terminals, if there is
// room — where it fits on it at all.
function onBoard(at, L) {
    const { w, h } = extentOf(L), fit = (a, n, N) => {
        if (n > N) return a;
        const m = n + 2 <= N ? 1 : 0;
        return Math.max(m, Math.min(N - n - m, a));
    };
    return { x: fit(at.x, w, M.GRID_W), y: fit(at.y, h, M.GRID_H) };
}
// Where the copies are first set out: copy 0 where the part in hand was
// last over the board, or else all of them mid-view — and all of them on
// the board, if they fit on it.
function startAnchor() {
    const L = layout(), b0 = L.boxes[0], { w, h } = extentOf(L);
    let at;
    if (handAt) at = { x: Math.round(handAt.fx - (b0.x0 + b0.x1 + 1) / 2), y: Math.round(handAt.fy - (b0.y0 + b0.y1 + 1) / 2) };
    else {
        const p = cellPoint(V.width / 2, V.height * 0.45);
        at = { x: Math.round(p.fx - w / 2), y: Math.round(p.fy - h / 2) };
    }
    at = onBoard(at, L);
    return clampAnchor({ x: at.x + b0.x0, y: at.y + b0.y0 }, L);
}
// After a change that grows them or turns them: copy 0 moved as little as
// keeps them all on the board.
function keepOnBoard() {
    const L = layout(), at = atOf(L), to = onBoard(at, L);
    arrayEdit.anchor = { x: arrayEdit.anchor.x + to.x - at.x, y: arrayEdit.anchor.y + to.y - at.y };
}

function render() {
    const { part, apart, spec: joined } = arrayEdit;
    const L = layout(), at = atOf(L), off = (c) => c && [at.x + c[0], at.y + c[1]];
    const why = L.clip ? M.blockFits(L.clip, at.x, at.y, { grow: !gameLevel, replace: true }) : null;
    const src = new Map((L.r.sources || []).map((s) => [s.name, s]));
    const pinsOf = (list, own) => list.map((q) => ({
        name: q.name, dir: q.dir, host: off(q.host), face: q.face, at: off(q.at),
        role: own ? 'each' : (src.get(q.name) || {}).role || 'each',
    }));
    const ringOf = (ring) => ring.map((e) => ({ x: at.x + e.x, y: at.y + e.y, cls: e.cls }));
    let pins = [], rings = [];
    if (L.clip && L.r.apart) for (const p of M.clipParts(L.clip)) { pins = pins.concat(pinsOf(p.pins, true)); rings.push(ringOf(p.ring)); }
    else if (L.clip) { pins = pinsOf(M.clipPins(L.clip), false); rings = [ringOf(M.clipRing(L.clip))]; }
    const n = L.boxes.length, bit0 = joined.reverse ? n - 1 : 0;
    arrayEdit.shown = { L, at, why, pins };
    V.setArrayEdit({
        copies: L.boxes.map((b, k) => ({
            x0: at.x + b.x0, y0: at.y + b.y0, x1: at.x + b.x1, y1: at.y + b.y1,
            label: apart ? part.name : joined.reverse ? n - 1 - k : k,
            next: k === 1, bad: !L.clip && k > 0, bit0: !apart && k === bit0,
        })),
        wire: L.wire.map(([x, y]) => [at.x + x, at.y + y]),
        rings, pins, blocked: !L.clip || !!why,
    });
    V.drawGrid();
    renderBar();
}
// The bar: the way they are set, and what is wrong — that they do not go
// together, or cannot go down where they are — or a word on what was just
// tried, or else what to do.
function renderBar() {
    const { part, apart, count, ops, shown } = arrayEdit, w = way(), { L, why } = shown;
    document.getElementById('arrayName').textContent = part.name;
    const apartBtn = document.getElementById('arrayApartBtn');
    apartBtn.textContent = apart ? 'Apart' : 'Joined';
    apartBtn.setAttribute('aria-pressed', String(apart));
    apartBtn.title = apart ? 'Side by side, each its own part, nothing joined — click to join them up under one lid'
        : 'Joined up under one lid — click to set them side by side instead, each its own part, nothing joined';
    const rows = turnWay(w.dir, ops) % 2 === 0 ? 'rows' : 'columns';
    const pitchEl = document.getElementById('arrayPitch');
    pitchEl.textContent = `every ${w.pitch}`;
    pitchEl.title = `A copy every ${w.pitch} ${rows}`;
    if (document.activeElement !== arrayCountEl) arrayCountEl.value = String(count);
    // The ways, as they show on screen: the one they go pressed, one they
    // cannot go greyed, saying why.
    const plan = planFor();
    document.querySelectorAll('#arrayBar .array-way').forEach((b) => {
        const d = unturnWay(Number(b.dataset.way), ops), p = plan.ways[d];
        b.setAttribute('aria-pressed', String(d === w.dir));
        b.disabled = !!p.error && d !== w.dir;
        b.title = p.error ? `Not this way: ${p.error.charAt(0).toLowerCase() + p.error.slice(1)}` : `Each copy ${WAY_WORDS[Number(b.dataset.way)]} the one before`;
    });
    document.getElementById('arrayForgetBtn').style.display = arrayEdit.had && !arrayEdit.lifted ? '' : 'none';
    arrayOkBtn.disabled = !L.clip || !!why;
    const bad = L.r.error || (arrayEdit.noteBad && arrayEdit.note) || why;
    arrayMsgEl.textContent = L.r.error || arrayEdit.note || why
        || `${count} × ${part.name}, a copy every ${w.pitch} ${rows} — the arrows, or drag the next copy (blue), for which way${apart ? '' : '; click a pin to change it'}`;
    arrayMsgEl.classList.toggle('bad', !!bad);
}
function say(text, bad) {
    arrayEdit.note = text || '';
    arrayEdit.noteBad = !!bad;
    render();
}

// After a change of way or of a pin's role: if the copies no longer go
// together at this spacing, the nearest spacing at which they do.
function fitSpacing() {
    const { part } = arrayEdit, w = way();
    if (!tried().error) return;
    const best = planFor().ways[w.dir];
    if (!best.error && best.pitch > w.pitch) { w.pitch = best.pitch; return; }
    for (let p = Math.max(w.pitch, along(part, w.dir)), top = w.pitch + 8; p <= top; p++) {
        w.pitch = p;
        if (!tried().error) return;
    }
    if (!best.error) w.pitch = best.pitch;
}
// A change to how it repeats is tried, and kept only if the copies still
// go together (`fit`: spread them if that is all it takes). If they do not,
// it is taken back and the bar says why — so what is drawn is always a way
// the part does repeat. `change` is given the way being set.
function tryChange(change, fit) {
    const before = copySpec(arrayEdit.spec);
    change(way());
    if (fit) fitSpacing();
    const why = tried().error;
    if (why) arrayEdit.spec = before;
    else keepOnBoard();
    say(why, true);
}
// Which way, from the bar's arrows (`d` the part's own way): as close
// together as they go that way.
function setArrayDir(d) {
    if (!arrayEdit) return;
    const w = way(), best = planFor().ways[d];
    if (best.error) { say(best.error, true); return; }
    w.dir = d;
    w.pitch = best.pitch;
    if (!arrayEdit.apart) w.tapSide = undefined;
    keepOnBoard();
    say('');
}
function setArrayPitch(p) {
    if (!arrayEdit) return;
    tryChange((w) => { w.pitch = Math.max(along(arrayEdit.part, w.dir), Math.min(99, p)); }, false);
}
// Which way is being set: joined up, or apart.
function setArrayApart(apart) {
    if (!arrayEdit) return;
    const { part, spec } = arrayEdit;
    if (apart && !spec.apartWay) {
        const w = G.apartSpec(part.key, spec);
        spec.apartWay = { dir: w ? w.dir : spec.dir, pitch: w ? w.pitch : along(part, spec.dir) };
    }
    arrayEdit.apart = apart;
    if (!arrayEdit.shown) return;
    keepOnBoard();
    say('');
}
function setEditCount(n) {
    if (!arrayEdit) return;
    arrayEdit.count = Math.max(2, Math.min(MAX_COPIES, n | 0 || 2));
    keepOnBoard();
    say('');
}
function turnArray(mirror) {
    if (!arrayEdit) return;
    arrayEdit.ops.push(mirror ? 'm' : 't');
    keepOnBoard();
    say('');
}
// A pin's tag clicked: what it is in the array says what a click changes.
function pinClicked(name) {
    const { L } = arrayEdit.shown, src = (L.r.sources || []).find((s) => s.name === name);
    if (!src) { say(`${name} is each copy’s own: apart, nothing is shared`, false); return; }
    const pin = arrayEdit.part.pins.find((q) => q.name === src.base), chains = L.r.chains || [];
    if (src.role === 'each' && pin && pin.dir === 'in') tryChange((s) => { s.shared = s.shared.concat(src.base); }, true);
    else if (src.role === 'shared') tryChange((s) => { s.shared = s.shared.filter((t) => t !== src.base); }, true);
    else if (src.role === 'chain' && pin && pin.dir === 'out' && chains.some(([o]) => o === src.base)) tryChange((s) => { s.taps = s.taps.concat(src.base); s.tapSide = undefined; }, true);
    else if (src.role === 'tap') {
        // Out the other side, then not out at all.
        tryChange((s) => {
            if (s.tapSide === undefined) s.tapSide = s.dir % 2 ? 0 : 3;
            else { s.taps = s.taps.filter((t) => t !== src.base); s.tapSide = undefined; }
        }, true);
    } else {
        say(src.role !== 'chain' ? `${src.base} is an output: every copy has its own`
            : pin && pin.dir === 'in' && chains.some(([o]) => o === src.base) ? `${src.base} runs on through every copy`
                : `${src.base} comes from the copy before`, false);
    }
}

// ---- On the board: the gesture while the copies are out ----
// A press on a pin's tag changes the pin; on the next copy, drags it to
// where it goes; on any other copy, moves them all — or, on bit 0 and let
// go without moving, counts from the other end.
const hitAt = (sx, sy) => {
    const hits = V.arrayEditHits || [], on = (h) => sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h;
    return hits.find((h) => h.kind !== 'copy' && on(h)) || hits.find((h) => h.kind === 'copy' && on(h)) || null;
};
function arrayEditGesture(c, sx, sy, erase) {
    if (erase) return null;
    const hit = hitAt(sx, sy);
    if (!hit) return null;
    if (hit.kind === 'pin') { pinClicked(hit.name); return null; }
    if (hit.kind === 'bit0') return moveGesture(c, () => { arrayEdit.spec.reverse = !arrayEdit.spec.reverse; say(''); });
    return hit.k === 1 ? nextGesture() : moveGesture(c);
}
// Dragging the next copy: which side of copy 0 the pointer is on is the
// way the copies go, and how far, the spacing — never closer than the part
// is long that way. Let go where they do not go together, and the nearest
// spacing that does is taken, or else it goes back.
function nextGesture() {
    const before = copySpec(arrayEdit.spec);
    arrayEdit.note = '';
    return {
        move(p) {
            const { part, ops, anchor } = arrayEdit, b0 = arrayEdit.shown.L.boxes[0], cs = M.CELL_SIZE * V.zoom;
            const fx = (p.sx - V.panX) / cs - (anchor.x + (b0.x1 - b0.x0 + 1) / 2);
            const fy = (p.sy - V.panY) / cs - (anchor.y + (b0.y1 - b0.y0 + 1) / 2);
            const shown = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 1 : 3) : (fy > 0 ? 2 : 0);
            const dir = unturnWay(shown, ops), w = way(), len = along(part, dir);
            const pitch = Math.max(len, Math.min(len + 12, Math.round(Math.abs(shown % 2 ? fx : fy))));
            if (dir === w.dir && pitch === w.pitch) return;
            if (dir !== w.dir && !arrayEdit.apart) w.tapSide = undefined;
            w.dir = dir;
            w.pitch = pitch;
            render();
        },
        end() {
            fitSpacing();
            const why = tried().error;
            if (why) arrayEdit.spec = before;
            say(why, true);
        },
        abort() { arrayEdit.spec = before; say(''); },
    };
}
// Dragging any other copy: all of them, copy 0 kept on the board. Let go
// where it was pressed, it was a click (`clicked`).
function moveGesture(c0, clicked) {
    const start = { ...arrayEdit.anchor };
    let moved = false;
    return {
        move(p) {
            if (p.c.x !== c0.x || p.c.y !== c0.y) moved = true;
            const a = clampAnchor({ x: start.x + p.c.x - c0.x, y: start.y + p.c.y - c0.y });
            if (a.x === arrayEdit.anchor.x && a.y === arrayEdit.anchor.y) return;
            arrayEdit.anchor = a;
            render();
        },
        end() { if (!moved && clicked) clicked(); },
        abort() { arrayEdit.anchor = start; render(); },
    };
}
// The pointer over them says what a press there would do.
let hovering = null;
function arrayEditHover(sx, sy) {
    if (!arrayEdit) return;
    const hit = hitAt(sx, sy);
    V.canvas.style.cursor = !hit ? '' : hit.kind === 'copy' ? (hit.k === 1 ? 'grab' : 'move') : 'pointer';
    let says = null;
    if (hit && hit.kind === 'pin') {
        const p = arrayEdit.shown.pins.find((q) => q.name === hit.name);
        says = p && `${p.name}: ${ROLE_TITLE[p.role] || ROLE_TITLE.each}`;
    } else if (hit && hit.kind === 'bit0') says = 'Bit 0 — click to count from the other end';
    else if (hit && hit.k === 1) says = 'The next copy — drag it to where it goes';
    else if (hit) says = 'Drag to move them all';
    if (says === hovering) return;
    hovering = says;
    if (says && !arrayEdit.shown.L.r.error) { arrayMsgEl.textContent = says; arrayMsgEl.classList.remove('bad'); } else renderBar();
}

// ---- An array already down ----
// A part on the board is an array if it holds two or more copies of one
// part and nothing else.
function isArrayPart(id) {
    const kids = M.blockList().filter((b) => b.parent === id);
    return kids.length > 1 && kids.every((b) => b.name === kids[0].name && b.source === kids[0].source);
}
// Two cells the same thing: a wire is a wire, crossing or not (the board's
// crossings are marked as such once the simulation has run through them).
const wireish = (v) => M.isConductorId(v) || M.isXover(v);
const sameCell = (a, b) => a === b || (wireish(a) && wireish(b));
// The eight ways round a clip can be put down: turned, and flipped first.
const WAYS_ROUND = [[], ['t'], ['t', 't'], ['t', 't', 't'], ['m'], ['m', 't'], ['m', 't', 't'], ['m', 't', 't', 't']];
// The array `id` set out again as it was: {part, spec, count, ops} — or
// {error}. Its lid says how it repeats (`rep`); one put down before lids
// said is taken to repeat as its part does now, if that is what is there.
// Which way round it lies is read off the board: the copies, made again,
// have to be cell for cell what is there, one of the eight ways round.
function arrayOnBoard(id) {
    const info = M.blockInfo(id);
    if (!info || info.parent || !isArrayPart(id)) return { error: 'That is not an array' };
    const kids = M.blockList().filter((b) => b.parent === id);
    const key = info.rep ? info.rep.key : kids[0].source || 'user:' + kids[0].name;
    const part = availableParts().find((q) => q.key === key);
    if (!part) return { error: `${kids[0].name} is not on the shelf here, to make copies of` };
    const spec = info.rep ? { ...info.rep, shared: [...info.rep.shared], taps: [...info.rep.taps] } : G.arraySpec(key);
    if (!spec) return { error: `How ${part.name} repeats is not known any more` };
    delete spec.key;
    const had = G.arraySpec(key);
    if (had && had.apartWay) spec.apartWay = { ...had.apartWay };
    const there = M.copyRegion(info.x0, info.y0, info.x1, info.y1);
    // Copy 0, where the rest go from: the first put down (copies are
    // numbered in order, so it has the lowest id).
    const first = kids.reduce((a, b) => (b.id < a.id ? b : a));
    // As arrays are made now, or as they were before their pins could be
    // their copies' (a stub out of every copy: see M.arrayClip's `stubs`).
    // Put down again, it is made the way they are made now.
    let why = null;
    for (const made of [spec, { ...spec, stubs: true }]) {
        const r = G.arrayPart(key, made, kids.length);
        if (r.error) { why = why || r.error; continue; }
        for (const ops of WAYS_ROUND) {
            let c = r.clip;
            for (const op of ops) c = op === 'm' ? M.mirrorClipH(c) : M.rotateClipCW(c);
            if (c.w === there.w && c.h === there.h && c.data.every((v, i) => sameCell(v, there.data[i])))
                return { part, spec, count: kids.length, ops: ops.slice(), had: !!had, anchor: { x: first.x0, y: first.y0 } };
        }
    }
    return { error: why || `This ${info.name} is not laid out the way ${part.name} repeats now` };
}
// Picked out with Rearrange: lifted off the board — not an edit yet, and
// not saved so (what is saved is the board as it was) — and its copies set
// out where it was.
function openArrayInPlace(id) {
    const found = arrayOnBoard(id);
    if (found.error) { flashStatus(found.error); return; }
    if (arrayEdit) closeArray();
    const info = M.blockInfo(id);
    flushSave();
    const lifted = { entry: snapshotEntry(), back: M.copyRegion(info.x0, info.y0, info.x1, info.y1), at: { x: info.x0, y: info.y0 } };
    M.removeBlock(id);
    setArrangeSel([]);
    arrayEdit = {
        part: found.part, spec: found.spec, apart: false, had: found.had, count: found.count, ops: found.ops,
        anchor: { x: 0, y: 0 }, note: '', noteBad: false, shown: null, tool: drawMode, lifted,
    };
    arrayEdit.anchor = { ...found.anchor };
    hovering = null;
    letGoOfFocus();
    arrayBarEl.classList.add('open');
    updateHandBar();
    render();
    flashStatus(`${info.name} lifted to change — Put down puts the new one there, Cancel puts it back`);
}
// The keys are the board's while the copies are out: the button that set
// them out (on the shelf, on a bar) no longer has the focus, or Enter
// would press it again as well as put them down.
function letGoOfFocus() {
    const el = document.activeElement;
    if (el && el !== document.body && el.blur) el.blur();
}
// Each copy as Rearrange picks it out: the array, or — apart — each part.
function pickOut(clip, at) {
    const seen = new Set(), objs = [];
    for (let i = 0; i < clip.data.length; i++) {
        if (!clip.bmap[i]) continue;
        const x = at.x + i % clip.w, y = at.y + Math.floor(i / clip.w), b = M.blockAtCell(x, y), t = b && M.topBlockOf(b);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        const o = M.objectAt(x, y);
        if (o) objs.push(o);
    }
    return objs;
}

// ---- Opening, putting down, closing ----
// The part's copies set out on the board: from the shelf, or the part in
// hand (turned and flipped as it is, as many as are in hand, two at the
// least).
function openArray(part, apart) {
    if (arrayEdit) closeArray();
    const had = G.arraySpec(part.key);
    let spec = had;
    if (!spec) {
        const best = G.planArray(part.key, {}).best;
        spec = { dir: best ? best.dir : 1, pitch: best ? best.pitch : part.w + 1, shared: [], taps: [], reverse: false };
    }
    const inHand = !!placingPart && placingPart.key === part.key && !placingPart.loose;
    const ops = inHand ? (placingPart.ops || []).slice() : [];
    const count = Math.max(2, inHand ? countInHand() : 2);
    closeComponents();
    if (!inHand) holdPart(part, null, []);
    if (drawMode !== 'part') setDrawMode('part');
    arrayEdit = {
        part, spec, apart: false, had: !!had, count, ops, anchor: { x: 0, y: 0 }, note: '', noteBad: false, shown: null,
        tool: 'part', lifted: null,
    };
    setArrayApart(!!apart);
    arrayEdit.anchor = startAnchor();
    hovering = null;
    letGoOfFocus();
    arrayBarEl.classList.add('open');
    updateHandBar();
    refreshStampPreview();
    render();
}
// Put down: there, where they are drawn — the way they repeat kept with
// the part from now on, and as many again in hand, to put down elsewhere.
// An array lifted to change goes down instead of the old one, one step to
// undo, and is picked out again as it was.
function putDownArray() {
    if (!arrayEdit) return;
    const { L, at } = arrayEdit.shown;
    if (!L.clip) { flashStatus(L.r.error); return; }
    const { part, spec, apart, count, ops, lifted, tool } = arrayEdit;
    const res = placeClipAt(L.clip, at, lifted && lifted.entry);
    if (res.why) { flashStatus(res.why); return; }
    G.saveArraySpec(part.key, spec);
    endArray();
    if (lifted) {
        if (tool === 'rearrange') setArrangeSel(pickOut(L.clip, res.at));
        flashStatus(`${count} of ${part.name}, ${apart ? 'apart' : 'joined up'}, in place of the old`);
        return;
    }
    handApart = { key: part.key, apart };
    holdPart(part, { spec: wayFor(part.key, apart), count, apart }, ops);
    updateHandBar();
    flashStatus(`${count} of ${part.name} put down, ${apart ? 'apart' : 'joined up'} — as many again in hand`);
}
// Cancel (Esc): nothing kept, the hand as it was — or an array lifted to
// change put back where it was, picked out again.
function closeArray() {
    if (!arrayEdit) return;
    const { lifted, tool } = arrayEdit;
    endArray();
    if (!lifted) return;
    M.pasteRegion(lifted.back, lifted.at.x, lifted.at.y, { replace: true });
    if (tool === 'rearrange') setArrangeSel(pickOut(lifted.back, lifted.at));
    V.drawGrid();
}
function endArray() {
    arrayEdit = null;
    hovering = null;
    arrayBarEl.classList.remove('open');
    V.setArrayEdit(null);
    V.canvas.style.cursor = '';
    updateHandBar();
    refreshStampPreview();
    V.drawGrid();
}
function forgetArray() {
    if (!arrayEdit) return;
    const { part } = arrayEdit;
    G.clearArraySpec(part.key);
    closeArray();
    if (placingPart && placingPart.key === part.key && placingPart.array) holdPart(part, null, placingPart.ops || []);
    updateHandBar();
    flashStatus(`${part.name} no longer repeats`);
}

function setupArrayEdit() {
    // The bar while the copies are out.
    document.getElementById('arrayTurnBtn').addEventListener('click', () => turnArray(false));
    document.getElementById('arrayFlipBtn').addEventListener('click', () => turnArray(true));
    document.getElementById('arrayApartBtn').addEventListener('click', () => { if (arrayEdit) setArrayApart(!arrayEdit.apart); });
    document.querySelectorAll('#arrayBar .array-way').forEach((b) => b.addEventListener('click', () => {
        if (arrayEdit) setArrayDir(unturnWay(Number(b.dataset.way), arrayEdit.ops));
    }));
    document.getElementById('arrayCloserBtn').addEventListener('click', () => { if (arrayEdit) setArrayPitch(way().pitch - 1); });
    document.getElementById('arrayFurtherBtn').addEventListener('click', () => { if (arrayEdit) setArrayPitch(way().pitch + 1); });
    document.getElementById('arrayFewerBtn').addEventListener('click', () => { if (arrayEdit) setEditCount(arrayEdit.count - 1); });
    document.getElementById('arrayMoreBtn').addEventListener('click', () => { if (arrayEdit) setEditCount(arrayEdit.count + 1); });
    arrayCountEl.addEventListener('input', () => { if (arrayEdit && arrayCountEl.value !== '' && Number(arrayCountEl.value) >= 2) setEditCount(Number(arrayCountEl.value)); });
    arrayCountEl.addEventListener('change', () => { if (arrayEdit) renderBar(); });
    arrayCountEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') arrayCountEl.blur();
        if (e.key === 'Enter') { arrayCountEl.blur(); putDownArray(); }
    });
    document.getElementById('arrayForgetBtn').addEventListener('click', forgetArray);
    arrayOkBtn.addEventListener('click', putDownArray);
    document.getElementById('arrayCancelBtn').addEventListener('click', closeArray);

    // The bar for the part in hand.
    document.getElementById('handTurnBtn').addEventListener('click', () => turnPart(false));
    document.getElementById('handFlipBtn').addEventListener('click', () => turnPart(true));
    document.getElementById('handFewerBtn').addEventListener('click', () => setArrayCount(countInHand() - 1));
    document.getElementById('handMoreBtn').addEventListener('click', () => setArrayCount(countInHand() + 1));
    const input = document.getElementById('handCountInput');
    input.addEventListener('input', () => { if (input.value !== '') setArrayCount(Number(input.value)); });
    input.addEventListener('change', () => updateHandBar());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
    document.getElementById('handApartBtn').addEventListener('click', () => setHandApart(!apartInHand()));
    document.getElementById('handArrayBtn').addEventListener('click', () => {
        const part = placingPart && availableParts().find((q) => q.key === placingPart.key);
        if (part) openArray(part, apartInHand());
    });
}

// For the tests and the hooks: the copies as they are set out, while they are.
function arrayEditState() {
    if (!arrayEdit || !arrayEdit.shown) return null;
    const { L, at, why, pins } = arrayEdit.shown, w = way(), n = L.boxes.length;
    return {
        dir: w.dir, shown: turnWay(w.dir, arrayEdit.ops), pitch: w.pitch, count: arrayEdit.count, apart: arrayEdit.apart,
        error: L.r.error || null, why: why || null, note: arrayEdit.note, at: { ...at }, anchor: { ...arrayEdit.anchor },
        lifted: !!arrayEdit.lifted, ops: arrayEdit.ops.join(''),
        copies: L.boxes.map((b) => ({ x0: at.x + b.x0, y0: at.y + b.y0, x1: at.x + b.x1, y1: at.y + b.y1 })),
        bits: arrayEdit.apart ? '' : L.boxes.map((b, k) => (arrayEdit.spec.reverse ? n - 1 - k : k)).join(''),
        pins: Object.fromEntries(pins.map((p) => [p.name, p.role])), wire: L.wire.length,
        hits: (V.arrayEditHits || []).map((h) => ({ ...h })),
    };
}

export {
    MAX_COPIES, updateHandBar, setArrayCount, setHandApart, countInHand, arrayEditing, arrayEditTool,
    isArrayPart, arrayOnBoard, openArrayInPlace, openArray,
    setArrayApart, setArrayDir, setArrayPitch, setEditCount, turnArray, pinClicked, arrayEditGesture, arrayEditHover,
    putDownArray, closeArray, forgetArray, setupArrayEdit, arrayEditState,
};
