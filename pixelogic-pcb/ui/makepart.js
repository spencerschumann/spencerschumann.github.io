// Make part…: a part drawn on the board itself — its bounds, its terminals
// and their names, all where the circuit is — and saved to the shelf (or
// back over the part it was opened from).

import {
    flashStatus, partAsEl, partBarEl, partMsgEl, partNameEl, partOkBtn,
} from './page.js';
import {
    afterEdit, beginUndoBatch, endUndoBatch,
} from './history.js';
import {
    selection, setSelection,
} from './clipboard.js';
import {
    applyToolAvailability, gameLevel,
} from './campaign.js';
import {
    ask,
} from './ask.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const G = window.PixelogicGame;

// ---- Make part, on the board ----
// The player draws the part. The selection is its bounds, exactly: drag
// an edge of them to move it, drag across the board to draw new ones, or
// Fit to shrink them to the smallest part round what they hold
// (M.fitPart). Round them, every cell where something outside meets the
// circuit is a terminal — it has to be: it is joined to it — and a click
// on any other cell where something inside meets the edge (a wire's end,
// a mux's lead, a nested part's pin) makes one there too; a right-click on
// a terminal takes it away (as the right button erases). Each terminal is
// named on the board, on its tag (click it to type), and set in or out by
// its arrow, in its cell (click to turn it);
// terminals with one name are one pin, its wire running through the part
// to each of them (an enable carried up through a latch, in at the bottom
// and out at the top, to stack). Terminals on one wire start with one
// name; name one apart to make it a pin of its own. What is wrong with
// the part as it stands is shown on the cells where it is wrong
// (M.partInBounds), and Make part waits until nothing is. A bar over the
// board holds the rest: what to save it as, its name, Fit, Make part.
//
// (This was a panel with a drawing of the part in it — a second, smaller
// board for naming terminals on — and the bounds were always fitted,
// never drawn; a pin could not be carried through a part at all.)
let partEdit = null;    // {rect, terms: [{x, y, name, dir}], info, restore}
const PIN_LETTERS_IN = 'ABCDEFGHIJKLMNOP', PIN_LETTERS_OUT = 'QRSTUVWXYZ';
const partEditing = () => !!partEdit;
// The player chose what to save as: bounds moved later do not change it.
const partEditChose = () => { if (partEdit) partEdit.chose = true; };
const asTarget = () => (partAsEl.value ? G.getPart(partAsEl.value) : null);
const sameCell = (x, y) => (t) => t.x === x && t.y === y;

// What the bounds meet, terminals or not (M.partInBounds with none).
const bare = () => M.partInBounds(partEdit.rect, null);
function analyse() {
    partEdit.info = M.partInBounds(partEdit.rect, partEdit.terms);
    render();
}
// Names for terminals without one: a wire's terminals one name; the
// nested part's pin it is or meets, if that is free; else the next
// letter — A, B, … for inputs, Q, R, … for outputs.
function nameAll(terms) {
    const b = bare(), netOf = (t) => (b.meetings.find(sameCell(t.x, t.y)) || b.candidates.find(sameCell(t.x, t.y)) || {});
    const taken = new Set(terms.filter((t) => t.name).map((t) => t.name)), byNet = new Map();
    // On a wire with terminals already, the name of the nearest of them.
    const dist = (u, t) => Math.abs(u.x - t.x) + Math.abs(u.y - t.y);
    const nearestOn = (t, net) => {
        let best = null;
        for (const u of terms) if (u !== t && u.name && netOf(u).net === net && (!best || dist(u, t) < dist(best, t))) best = u;
        return best || byNet.get(net);
    };
    for (const t of terms) {
        if (t.name) continue;
        const m = netOf(t), same = m.net && nearestOn(t, m.net);
        if (same) { t.name = same.name; t.dir = same.dir; continue; }
        const letters = t.dir === 'out' ? PIN_LETTERS_OUT : PIN_LETTERS_IN;
        t.name = m.hint && !taken.has(m.hint) ? m.hint
            : [...letters].find((l) => !taken.has(l)) || (t.dir === 'out' ? 'O' : 'I') + taken.size;
        taken.add(t.name);
        if (m.net) byNet.set(m.net, t);
    }
}
// The terminals for bounds just drawn or moved: every cell where
// something meets them, the player's own kept where they still can be —
// and, saving back a part being changed, its pins where they were.
function reconcile() {
    const b = bare(), terms = [];
    for (const t of partEdit.terms)
        if (b.meetings.some(sameCell(t.x, t.y)) || b.candidates.some(sameCell(t.x, t.y))) terms.push({ ...t });
    for (const m of b.meetings) if (!terms.some(sameCell(m.x, m.y))) terms.push({ x: m.x, y: m.y, name: '', dir: m.out ? 'out' : 'in' });
    partEdit.terms = terms;
    recallTerms(b);
    nameAll(terms);
}
// Saving back a part being changed (see editFor), its pins are put where
// they were — nothing to click again: on the same cells, if something
// inside still meets the bounds there; else on the same side, as far from
// the end of it they were nearer as they were (a column taken out of the
// middle moves the pins beyond it, not their distance from that end), or
// failing that the nearest. Each says whose it is (`recall`), for namesFor.
function recallTerms(b) {
    const mem = makePartMemory, target = asTarget();
    if (!mem || !target || target.key !== mem.key) return;
    const r = partEdit.rect, spots = [...b.meetings, ...b.candidates], key = (c) => c.x + ',' + c.y;
    const used = new Set(partEdit.terms.filter((t) => t.recall).map(key));
    const have = new Set(partEdit.terms.map((t) => t.recall).filter(Boolean));
    const sideOf = (x, y, q) => (y < q.y0 ? 'n' : y > q.y1 ? 's' : x < q.x0 ? 'w' : 'e');
    // How far along its side from the start, and from the end.
    const offs = (s, x, y, q) => (s === 'n' || s === 's' ? [x - q.x0, q.x1 - x] : [y - q.y0, q.y1 - y]);
    const score = (p, c) => {
        if (c.x === p.at[0] && c.y === p.at[1]) return 0;
        const s = sideOf(p.at[0], p.at[1], mem.rect);
        if (sideOf(c.x, c.y, r) !== s) return Infinity;
        const [ps, pe] = offs(s, p.at[0], p.at[1], mem.rect), [cs, ce] = offs(s, c.x, c.y, r);
        const near = ps <= pe ? cs === ps : ce === pe, far = ps <= pe ? ce === pe : cs === ps;
        return near ? 1 : far ? 2 : 3 + Math.abs(ps / Math.max(1, ps + pe) - cs / Math.max(1, cs + ce));
    };
    const pairs = [];
    for (const p of mem.pins) {
        if (!p.at || have.has(p.name)) continue;
        for (const c of spots) if (!used.has(key(c))) { const sc = score(p, c); if (sc < Infinity) pairs.push({ p, c, sc }); }
    }
    pairs.sort((u, v) => u.sc - v.sc);
    for (const { p, c } of pairs) {
        if (have.has(p.name) || used.has(key(c))) continue;
        have.add(p.name);
        used.add(key(c));
        const t = partEdit.terms.find(sameCell(c.x, c.y));
        if (t) { t.recall = p.name; t.name = p.name; t.dir = p.dir; } else partEdit.terms.push({ x: c.x, y: c.y, name: p.name, dir: p.dir, recall: p.name });
    }
}
// The cells a selection holds something on: its bounds, shrunk to them.
function contentBox(r) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = r.y0; y <= r.y1; y++)
        for (let x = r.x0; x <= r.x1; x++) {
            if (M.isInsulatorId(M.getCell(x, y)) && !M.blockAtCell(x, y)) continue;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    return x0 > x1 ? r : { x0, y0, x1, y1 };
}

function render() {
    const { info, terms } = partEdit, r = info.rect;
    const pinOf = (t) => info.pins.findIndex((p) => p.name === t.name);
    V.setPartEdit({
        rect: r, edge: info.edge, problems: info.problems,
        candidates: info.candidates.filter((c) => !terms.some(sameCell(c.x, c.y))),
        terms: terms.map((t) => ({
            x: t.x, y: t.y, name: t.name, dir: t.dir, pin: pinOf(t),
            side: t.y < r.y0 ? 'n' : t.y > r.y1 ? 's' : t.x < r.x0 ? 'w' : 'e',
        })),
        editing: termEditor ? termEditor.i : -1,
    });
    V.drawGrid();
    const target = asTarget(), n = info.pins.length, bad = info.problems.length;
    partNameEl.style.display = target ? 'none' : '';
    const how = bad && /needs a name/.test(info.problems[0].why) ? ': click its tag to name it, or clear the name (or right-click it) to take it away' : '';
    partMsgEl.textContent = bad ? info.problems[0].why + how + (bad > 1 ? ` — and ${bad - 1} more, red on the board` : '')
        : `${r.x1 - r.x0 + 1}×${r.y1 - r.y0 + 1} · ${n} pin${n === 1 ? '' : 's'}`;
    partMsgEl.classList.toggle('bad', !!bad);
    partOkBtn.disabled = !!bad || !n;
}

// ---- On the board: the gesture while it is open ----
// A press on a terminal's tag names it; on its arrow, turns it; near an
// edge of the bounds, drags that edge; on a cell round them, adds a
// terminal there (the right button, takes one away); anywhere else, draws
// new bounds.
function partEditGesture(c, sx, sy, erase) {
    closeTermEditor(true);
    if (erase) { eraseTerm(c.x, c.y); return null; }
    const hit = (V.partEditHits || []).find((h) => sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h);
    // (Named when the press ends: a box focused during the press would lose
    // the focus to the press itself.)
    if (hit && hit.kind === 'tag') return { move() { }, end() { openTermEditor(hit.term); }, abort() { } };
    if (hit && hit.kind === 'arrow') { turnTerm(hit.term); return null; }
    const side = edgeUnder(sx, sy);
    if (side) return resizeGesture(side, c);
    if (onRing(c.x, c.y)) { addTerm(c.x, c.y); return null; }
    return boundsGesture(c);
}
const cellSize = () => M.CELL_SIZE * V.zoom;
const onRing = (x, y) => {
    const r = partEdit.rect;
    return ((x === r.x0 - 1 || x === r.x1 + 1) && y >= r.y0 && y <= r.y1) || ((y === r.y0 - 1 || y === r.y1 + 1) && x >= r.x0 && x <= r.x1);
};
// Which edge of the bounds the pointer is on, if any: within a quarter
// of a cell of its line.
function edgeUnder(sx, sy) {
    const r = partEdit.rect, cs = cellSize(), tol = Math.max(4, cs * 0.25);
    const L = V.panX + r.x0 * cs, R = V.panX + (r.x1 + 1) * cs, T = V.panY + r.y0 * cs, Bm = V.panY + (r.y1 + 1) * cs;
    const alongX = sx > L + tol && sx < R - tol, alongY = sy > T + tol && sy < Bm - tol;
    if (alongY && Math.abs(sx - L) <= tol) return 'w';
    if (alongY && Math.abs(sx - R) <= tol) return 'e';
    if (alongX && Math.abs(sy - T) <= tol) return 'n';
    if (alongX && Math.abs(sy - Bm) <= tol) return 's';
    return null;
}
// Dragging an edge of the bounds: it moves to the grid line nearest the
// pointer. Not moved, it was a click on the cell there.
function resizeGesture(side, c0) {
    const before = { ...partEdit.rect };
    let moved = false;
    return {
        move(p) {
            const cs = cellSize(), fx = (p.sx - V.panX) / cs, fy = (p.sy - V.panY) / cs, r = { ...partEdit.rect };
            const W = M.activeBoard().w, H = M.activeBoard().h;
            if (side === 'w') r.x0 = Math.max(0, Math.min(r.x1, Math.round(fx)));
            if (side === 'e') r.x1 = Math.min(W - 1, Math.max(r.x0, Math.round(fx) - 1));
            if (side === 'n') r.y0 = Math.max(0, Math.min(r.y1, Math.round(fy)));
            if (side === 's') r.y1 = Math.min(H - 1, Math.max(r.y0, Math.round(fy) - 1));
            if (r.x0 === partEdit.rect.x0 && r.x1 === partEdit.rect.x1 && r.y0 === partEdit.rect.y0 && r.y1 === partEdit.rect.y1) return;
            moved = true;
            partEdit.rect = r;
            reconcile();
            analyse();
        },
        end() { if (!moved && onRing(c0.x, c0.y)) addTerm(c0.x, c0.y); else recallEdit(); },
        abort() { partEdit.rect = before; reconcile(); analyse(); },
    };
}
// Drawing new bounds: a rectangle from where the press was to the cell
// under the pointer.
function boundsGesture(c0) {
    const before = { ...partEdit.rect };
    return {
        move(p) {
            if (!M.inBounds(p.c.x, p.c.y) || (p.c.x === c0.x && p.c.y === c0.y && !partEdit.drawing)) return;
            partEdit.drawing = true;
            partEdit.rect = { x0: Math.min(c0.x, p.c.x), y0: Math.min(c0.y, p.c.y), x1: Math.max(c0.x, p.c.x), y1: Math.max(c0.y, p.c.y) };
            reconcile();
            analyse();
        },
        end() { partEdit.drawing = false; recallEdit(); },
        abort() { partEdit.drawing = false; partEdit.rect = before; reconcile(); analyse(); },
    };
}
// A terminal added where something inside meets the edge. A new one on a
// wire that already has one takes the nearest one's name: one pin,
// through the part. Saving as a part on the shelf, a new one on a wire of
// its own takes a name of that part's — the next of its way no terminal
// has — and not a letter the part has no pin of.
function addTerm(x, y) {
    if (partEdit.terms.some(sameCell(x, y))) return;
    const b = bare(), m = b.meetings.find(sameCell(x, y)) || b.candidates.find(sameCell(x, y));
    if (!m) { flashStatus('Nothing inside meets that cell: a terminal goes beside a wire, a mux’s lead or a part’s pin'); return; }
    const t = { x, y, name: '', dir: m.out ? 'out' : 'in' }, target = asTarget();
    partEdit.terms.push(t);
    if (target) {
        const netOf = (u) => (b.meetings.find(sameCell(u.x, u.y)) || b.candidates.find(sameCell(u.x, u.y)) || {}).net;
        const kin = m.net && partEdit.terms.find((u) => u !== t && u.name && netOf(u) === m.net);
        const used = new Set(partEdit.terms.map((u) => u.name));
        const free = target.pins.find((q) => q.dir === t.dir && !used.has(q.name));
        if (kin) { t.name = kin.name; t.dir = kin.dir; } else if (free) t.name = free.name;
    } else nameAll(partEdit.terms);
    analyse();
}
// Taking a terminal away — the right button, or its name cleared. Where
// loose wire outside meets the edge there, it has to be a terminal while
// the wire is there, so the wire goes instead, that one cell, as the right
// button erases anywhere: a stray left behind by a change, say.
function eraseTerm(x, y) {
    const i = partEdit.terms.findIndex(sameCell(x, y));
    const meets = bare().meetings.some(sameCell(x, y));
    if (meets && M.isWireId(M.getCell(x, y)) && !M.blockAtCell(x, y) && !M.isLocked(x, y)) {
        // The terminal too: with the wire gone the cell could still be one
        // (the wire inside ends there), but it is not wanted.
        if (i >= 0) partEdit.terms.splice(i, 1);
        beginUndoBatch();
        M.paintCell(x, y, 'insulator');
        endUndoBatch();
        afterEdit();
        reconcile();
        analyse();
        flashStatus('The wire there is gone, and its terminal with it');
        return;
    }
    if (i >= 0) { partEdit.terms.splice(i, 1); analyse(); }
}
// Bounds moved to where a part being changed stood: it is what this
// saves as — unless the player has said otherwise.
function recallEdit() {
    if (!partEdit || partEdit.chose) return;
    const mem = editFor(partEdit.rect, partEdit.terms);
    if (!mem || partAsEl.value === mem.key) return;
    makePartMemory = mem;
    partAsEl.value = mem.key;
    makePartAsChanged();
}
// One pin, one way: turning a terminal turns every one of its name.
function turnTerm(i) {
    const t = partEdit.terms[i], dir = t.dir === 'in' ? 'out' : 'in';
    for (const u of partEdit.terms) if (u.name === t.name) u.dir = dir;
    analyse();
}
// Naming a terminal, on its tag: typed — or, saving over a part on the
// shelf, chosen from that part's names. Only that terminal is renamed:
// named apart from the rest of its wire's, it is a pin of its own.
let termEditor = null;   // {i, el}
function openTermEditor(i) {
    const hit = (V.partEditHits || []).find((h) => h.kind === 'tag' && h.term === i);
    const vp = document.getElementById('viewport');
    if (!hit || !vp) return;
    const target = asTarget(), t = partEdit.terms[i];
    // Typed, always: the names to hand — the part's being saved over, and
    // the ones its other terminals have — offered as it is typed. (It was a
    // choice of the part's names alone, saving over one: a name of its own,
    // the latch's E carried out of the top as Eout, could not be given.)
    const el = document.createElement('input');
    el.type = 'text';
    el.maxLength = 8;
    let list = document.getElementById('partTermNames');
    if (!list) { list = document.createElement('datalist'); list.id = 'partTermNames'; document.body.appendChild(list); }
    list.innerHTML = '';
    for (const n of new Set([...(target ? target.pins.map((q) => q.name) : []), ...partEdit.terms.map((u) => u.name).filter(Boolean)])) {
        const o = document.createElement('option');
        o.value = n;
        list.appendChild(o);
    }
    el.setAttribute('list', 'partTermNames');
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); closeTermEditor(true); }
        if (e.key === 'Escape') { e.preventDefault(); closeTermEditor(false); }
        if (e.key === 'Tab') { e.preventDefault(); const next = (i + (e.shiftKey ? partEdit.terms.length - 1 : 1)) % partEdit.terms.length; closeTermEditor(true); openTermEditor(next); }
    });
    el.id = 'partTermEditor';
    el.className = 'part-term-editor';
    el.value = t.name;
    const cr = V.canvas.getBoundingClientRect(), vr = vp.getBoundingClientRect();
    Object.assign(el.style, {
        left: (cr.left - vr.left + hit.x) + 'px', top: (cr.top - vr.top + hit.y) + 'px',
        width: Math.max(hit.w, 48) + 'px', height: hit.h + 'px',
    });
    el.addEventListener('blur', () => closeTermEditor(true));
    vp.appendChild(el);
    termEditor = { i, el };
    render();
    el.focus();
    if (el.select) el.select();
}
function closeTermEditor(keep) {
    if (!termEditor) return;
    const { i, el } = termEditor;
    termEditor = null;
    const name = el.value.trim();
    el.remove();
    if (!partEdit || !partEdit.terms[i]) return;
    if (keep && !name) { const t = partEdit.terms[i]; eraseTerm(t.x, t.y); return; }
    if (keep && name !== partEdit.terms[i].name) {
        const target = asTarget(), tp = target && target.pins.find((q) => q.name === name);
        const t = partEdit.terms[i];
        t.name = name;
        // A name another terminal already has: its pin, and its way.
        const same = partEdit.terms.find((u) => u !== t && u.name === name);
        if (tp) t.dir = tp.dir;
        else if (same) t.dir = same.dir;
        // A pin a level's part does not have: it is not that part — a
        // level's part keeps its level's pins — but a new one of the
        // player's own, every terminal's name kept as it is.
        if (target && target.source && !tp) {
            partEditChose();
            partAsEl.value = '';
            analyse();
            partNameEl.focus();
            partMsgEl.textContent = `${name} is no pin of ${target.name} — a level’s part keeps its level’s pins — so this is a new part of your own: name it`;
            partMsgEl.classList.remove('bad');
            return;
        }
    }
    analyse();
}
// While it is open, the pointer over the board says what is wrong where
// it is, and an edge of the bounds offers to be dragged.
let hovering = null;   // the problem the bar is saying, for the cell under the pointer
function partEditHover(sx, sy, c) {
    if (!partEdit || termEditor) return;
    const side = edgeUnder(sx, sy);
    V.canvas.style.cursor = side === 'w' || side === 'e' ? 'ew-resize' : side ? 'ns-resize' : '';
    // A problem there says what it is; a terminal, what can be done with it.
    const p = partEdit.info.problems.find(sameCell(c.x, c.y)) || null;
    const t = !p && partEdit.terms.find(sameCell(c.x, c.y));
    const says = p ? p.why + (/needs a name/.test(p.why) ? ': click its tag to name it, or clear the name (or right-click it) to take it away' : '')
        : t ? `${t.name || 'A terminal'}: click its tag to rename it, its arrow to turn it — right-click it, or clear its name, to take it away` : null;
    if (says === hovering) return;
    hovering = says;
    if (says) { partMsgEl.textContent = says; partMsgEl.classList.toggle('bad', !!p); } else render();
}

// ---- Opening, saving, closing ----
function doSaveComponent() {
    if (!selection) return;
    partEdit = { rect: { ...selection }, terms: [], info: null, restore: { ...selection } };
    reconcile();
    // Save as: a new part, or any part on the shelf. The one being edited
    // — decapped here, or put down loose from the shelf — is the choice
    // already made, its terminals named as they were.
    partAsEl.innerHTML = '';
    const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; partAsEl.appendChild(o); };
    opt('', 'A new part of your own');
    for (const part of G.allParts()) opt(part.key, `Save as ${part.name}${part.source ? ' (level part: must pass its level)' : ''}`);
    makePartMemory = editFor(partEdit.rect, partEdit.terms);
    partAsEl.value = makePartMemory ? makePartMemory.key : '';
    // Saving back a part being changed: bounds left where it was put down
    // are shrunk to what is there now (a column taken out leaves one bare
    // at the edge); its pins come back where they were (reconcile).
    if (makePartMemory) {
        const m = makePartMemory.rect, s = partEdit.rect;
        if (m.x0 === s.x0 && m.y0 === s.y0 && m.x1 === s.x1 && m.y1 === s.y1) partEdit.rect = contentBox(s);
        reconcile();
    }
    partNameEl.value = '';
    setSelection(null);
    partBarEl.classList.add('open');
    makePartAsChanged();
    if (!makePartMemory) partNameEl.focus();
    flashStatus('Drag an edge to move it · click a name to rename it, an arrow to turn it · click round the edge for a terminal, right-click to take one away');
}
// Saving as a part on the shelf, its terminals take that part's names;
// as a new one, names of their own again.
function makePartAsChanged() {
    const target = asTarget();
    for (const t of partEdit.terms) t.name = '';
    if (target) namesFor(target);
    else nameAll(partEdit.terms);
    analyse();
}
// Names for saving as `part`: a pin where one of the remembered part's
// was keeps that one's name; the rest take the part's remaining names of
// their way, in order.
function namesFor(part) {
    const byPos = (a, b) => a.y - b.y || a.x - b.x;
    nameAll(partEdit.terms);   // group them, one wire one pin, first
    const groups = new Map();
    for (const t of partEdit.terms) { if (!groups.has(t.name)) groups.set(t.name, []); groups.get(t.name).push(t); }
    const list = [...groups.values()], named = new Map(), taken = new Set();
    const mem = makePartMemory && makePartMemory.key === part.key ? makePartMemory
        : editMemories.filter((m) => m.key === part.key).pop();
    if (mem)
        for (const g of list) {
            const was = mem.pins.find((m) => g.some((t) => t.recall === m.name))
                || mem.pins.find((m) => m.at && g.some((t) => m.at[0] === t.x && m.at[1] === t.y));
            if (was && !taken.has(was.name)) { named.set(g, was); taken.add(was.name); }
        }
    for (const dir of ['in', 'out']) {
        const free = part.pins.filter((q) => q.dir === dir && !taken.has(q.name)).map((q) => q.name);
        for (const g of list.filter((gg) => !named.has(gg) && gg[0].dir === dir).sort((a, b) => byPos(a[0], b[0]))) {
            const n = free.shift();
            if (n) { named.set(g, { name: n, dir }); taken.add(n); }
        }
    }
    for (const g of list) {
        const w = named.get(g);
        for (const t of g) { t.name = w ? w.name : ''; if (w) t.dir = w.dir; }
    }
}
// Shrink the bounds to the smallest part round what they hold.
function fitPartEdit() {
    if (!partEdit) return;
    const fit = M.fitPart(partEdit.rect, null);
    if (fit.error) { flashStatus(fit.error); return; }
    partEdit.rect = { ...fit.core };
    reconcile();
    analyse();
    recallEdit();
}
function closeMakePart(cancelled) {
    closeTermEditor(false);
    const was = partEdit;
    partEdit = null;
    makePartMemory = null;
    partBarEl.classList.remove('open');
    V.setPartEdit(null);
    V.canvas.style.cursor = '';
    if (cancelled && was) setSelection(was.restore);
    V.drawGrid();
}
async function finishMakePart() {
    if (!partEdit) return;
    closeTermEditor(true);
    const { info } = partEdit;
    const target = asTarget();
    const name = target ? target.name : partNameEl.value.trim();
    if (info.problems.length) { flashStatus(info.problems[0].why); return; }
    if (!info.pins.length) { flashStatus('A part needs at least one terminal'); return; }
    if (!name) { partMsgEl.textContent = 'Give the part a name'; partMsgEl.classList.add('bad'); partNameEl.focus(); return; }
    // The pins in the part's own order when it is replacing one (so the
    // shelf's pin list reads the same), else inputs first, then outputs.
    let pins = info.pins.filter((q) => q.dir === 'in').concat(info.pins.filter((q) => q.dir === 'out'));
    if (target) {
        const order = target.pins.map((q) => q.name);
        pins = pins.slice().sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99));
    }
    const source = target ? target.source : '', rect = info.rect;
    const clip = M.captureRect(rect, pins, name, source, null);
    if (target && source) {
        // A level's part: it has to do the level's job — its tests run off
        // the page's thread, the bar saying so meanwhile. What they say is
        // used only if Make part is still open on the same board: closed,
        // or the board edited, it is dropped.
        const level = G.getLevel(source), was = partEdit, rev = M.activeBoard().rev;
        if (partOkBtn.disabled) return;     // already being checked (Enter, pressed again)
        partMsgEl.textContent = 'Checking it does the level’s job…';
        partMsgEl.classList.remove('bad');
        partOkBtn.disabled = true;
        const tested = await G.testPartOff(level, clip);
        partOkBtn.disabled = false;
        if (partEdit !== was) return;
        const say = (text) => { partMsgEl.textContent = text; partMsgEl.classList.add('bad'); };
        if (M.activeBoard().rev !== rev) { say('The board changed while it was being checked — save it again'); return; }
        const res = G.replaceLevelPart(level, clip, tested);
        if (!res.ok) {
            if (res.error) say(res.error);
            else {
                const f = res.failure, bits = (o) => Object.entries(o).map(([k, v]) => `${k}=${v & 1}`).join(' ');
                const wrong = Object.keys(f.expected).filter((k) => f.expected[k] != null && (f.expected[k] & 1) !== (f.actual[k] & 1));
                say(!f.settled ? `It never settles at ${bits(f.inputs)}`
                    : `Not the ${name} part: at ${bits(f.inputs)}, ${wrong.map((k) => `${k} should be ${f.expected[k] & 1}`).join(', ')}`
                    + (f.primed ? ' — from a charged start: something in it is not driven' : ''));
            }
            return;
        }
    } else {
        const was = partEdit;
        if (!target && G.getPart('user:' + name) && !await ask(`There is already a part called "${name}". Replace it?`, { ok: 'Replace', danger: true })) return;
        if (partEdit !== was) return;
        G.saveCustomPart(name, clip, gameLevel ? gameLevel.id : null);
    }
    // The circuit becomes the part where it stands, lid shut.
    beginUndoBatch();
    M.capPart(rect, pins, name, source);
    endUndoBatch();
    closeMakePart(false);
    // What was decapped here has been saved back, one way or another.
    editMemories = editMemories.filter((m) => !overlaps(m.rect, rect));
    keepMemories();
    setSelection(null);
    applyToolAvailability();
    afterEdit();
    flashStatus(target ? `Saved as the ${name} part — on the shelf and here` : `Made the part “${name}” — here, and on the shelf for Parts (9)`);
}

// The parts being changed: each the part, where it stood (`rect`) and
// where its terminals were ([{name, dir, at}]). All of them, not just the
// last — decapping a half adder and then the XOR and AND inside it is
// one edit of the half adder, and Make part… round the lot should offer
// to save it back as that. They are the board's — each level's and the
// sandbox's their own — and kept for the tab's session (sessionStorage),
// so a reload part way through a change does not forget what is being
// changed; nor does another board's change get taken for this one's.
let editMemories = [];
let makePartMemory = null;      // the one Make part… is saving back, if any
const overlaps = (r, c) => r.x0 <= c.x1 && r.x1 >= c.x0 && r.y0 <= c.y1 && r.y1 >= c.y0;
const MEMORIES_KEY = 'pixelogic-pcb.editing';
const boardKey = () => (gameLevel ? 'level:' + gameLevel.id : 'sandbox');
function keepMemories() {
    try {
        const all = JSON.parse(sessionStorage.getItem(MEMORIES_KEY) || '{}');
        all[boardKey()] = editMemories;
        sessionStorage.setItem(MEMORIES_KEY, JSON.stringify(all));
    } catch (e) { /* not kept: a reload forgets, as it used to */ }
}
// This board's, on opening it (or the page).
function loadMemories() {
    try {
        const mine = JSON.parse(sessionStorage.getItem(MEMORIES_KEY) || '{}')[boardKey()];
        editMemories = Array.isArray(mine) ? mine.filter((m) => m && m.key && m.rect && Array.isArray(m.pins)) : [];
    } catch (e) { editMemories = []; }
    makePartMemory = null;
}
// The board laid out afresh, empty: nothing on it is being changed.
function forgetMemories() {
    editMemories = [];
    makePartMemory = null;
    keepMemories();
}
// The board grown at its top or left: they move with it.
function shiftMemories(dx, dy) {
    if (!dx && !dy) return;
    for (const m of editMemories) {
        m.rect = { x0: m.rect.x0 + dx, y0: m.rect.y0 + dy, x1: m.rect.x1 + dx, y1: m.rect.y1 + dy };
        for (const p of m.pins) if (p.at) p.at = [p.at[0] + dx, p.at[1] + dy];
    }
    keepMemories();
}
// A part renamed (G.renamePart): one being changed is still that part,
// on every board.
function renameMemories(from, to, name) {
    const move = (list) => { for (const m of list || []) if (m.key === from) { m.key = to; m.name = name; } };
    move(editMemories);
    if (makePartMemory && makePartMemory.key === from) { makePartMemory.key = to; makePartMemory.name = name; }
    try {
        const all = JSON.parse(sessionStorage.getItem(MEMORIES_KEY) || '{}');
        for (const k of Object.keys(all)) if (Array.isArray(all[k])) move(all[k]);
        all[boardKey()] = editMemories;
        sessionStorage.setItem(MEMORIES_KEY, JSON.stringify(all));
    } catch (e) { /* this board's, at least, are renamed */ }
}
function rememberEdit(key, pins, rect) {
    const part = G.getPart(key);
    if (!part) return;
    editMemories = editMemories.filter((m) => !(m.key === key && overlaps(m.rect, rect)));
    editMemories.push({ key, name: part.name, rect: { ...rect }, pins: pins.map((p) => ({ name: p.name, dir: p.dir, at: p.at && [...p.at] })) });
    if (editMemories.length > 8) editMemories.shift();
    keepMemories();
}
// Which of them bounds drawn here are: one where it stood, with as many
// inputs and outputs, or else with terminals where its were — the most of
// those — or else only where it stood; then the biggest (the outermost of
// a nest).
function editFor(rect, terms) {
    const names = new Map();
    for (const t of terms) if (!names.has(t.name)) names.set(t.name, t.dir);
    const ins = [...names.values()].filter((d) => d === 'in').length, outs = names.size - ins;
    let best = null, bestScore = null;
    for (const m of editMemories) {
        const part = G.getPart(m.key);
        if (!part) continue;
        const at = terms.filter((t) => m.pins.some((p) => p.at && p.at[0] === t.x && p.at[1] === t.y)).length;
        const here = overlaps(m.rect, rect);
        const pIns = part.pins.filter((q) => q.dir === 'in').length;
        const same = here && pIns === ins && part.pins.length - pIns === outs;
        // Where it was put down is enough: a loose copy put down to change
        // has nothing wired to it to tell it by.
        if (!same && !at && !here) continue;
        const score = [same ? 1 : 0, at, here ? 1 : 0, (m.rect.x1 - m.rect.x0 + 1) * (m.rect.y1 - m.rect.y0 + 1)];
        const k = bestScore ? score.findIndex((v, j) => v !== bestScore[j]) : 0;
        if (!bestScore || (k >= 0 && score[k] > bestScore[k])) {
            best = m;
            bestScore = score;
        }
    }
    return best;
}

// For the tests and the hooks: what Make part has, while it is open.
function partEditState() {
    if (!partEdit) return null;
    return {
        rect: { ...partEdit.info.rect }, terms: partEdit.terms.map((t) => ({ ...t })),
        pins: partEdit.info.pins.map((p) => ({ ...p })), problems: partEdit.info.problems.map((p) => ({ ...p })),
        candidates: partEdit.info.candidates.map((c) => ({ x: c.x, y: c.y })), edge: partEdit.info.edge,
        hits: (V.partEditHits || []).map((h) => ({ ...h })),
    };
}

export {
    PIN_LETTERS_IN, PIN_LETTERS_OUT, partEditing, partEditChose, partEditGesture, partEditHover, partEditState, doSaveComponent,
    makePartAsChanged, fitPartEdit, closeMakePart, finishMakePart, closeTermEditor, editMemories, makePartMemory,
    loadMemories, forgetMemories, shiftMemories, renameMemories,
    overlaps, rememberEdit, editFor, namesFor,
};
