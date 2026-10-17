// The Parts tool and the shelf: the part in hand, putting it down,
// lifting and taking off lids.

import {
    componentsBackdrop, componentsEmptyEl, componentsListEl, componentsPanel, flashStatus,
} from './page.js';
import {
    afterEdit, applyExpansion, beginUndoBatch, endUndoBatch, gridOrigin, scheduleSave,
} from './history.js';
import {
    drawMode, setDrawMode,
} from './tools.js';
import {
    arrangeSel, setArrangeSel,
} from './arrange.js';
import {
    refreshStampPreview,
} from './stamp.js';
import {
    arrayEditing, closeArray, updateHandBar,
} from './arrayedit.js';
import {
    rememberEdit, renameMemories,
} from './makepart.js';
import {
    ask,
} from './ask.js';
import {
    setSelection,
} from './clipboard.js';
import {
    setMenuOpen, updateActionButtons,
} from './toolbar.js';
import {
    applyToolAvailability, gameLevel,
} from './campaign.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const G = window.PixelogicGame;
// The part the Parts tool puts down: {key, name, clip, pins}, the clip
// turned and flipped however R and M have left it.
let placingPart = null;

// ---- Parts ----
// The shelf of parts (game.js): what the Parts tool puts down. In a level
// it holds the parts made by the levels before it; in the sandbox,
// every part, the player's own included.
const availableParts = () => G.partsFor(gameLevel);
const placingPartValid = () => !!placingPart && availableParts().some((q) => q.key === placingPart.key);

// A clip's own pins, where they are in it (the outermost block's).
const pinsOfClip = (clip) => M.clipPins(clip);
// ...and, when it is several parts side by side (copies put down apart),
// each of them, to show each where it will go; else null.
const partsOfClip = (clip) => { const p = M.clipParts(clip); return p.length > 1 ? p : null; };
// The part in hand: the shelf's, or — `array` {spec, count} — that many
// copies of it in a row (G.arrayPart), turned and flipped by `ops` ('t'
// a quarter turn, 'm' a flip), which are kept so that changing the count
// keeps the way round. False, and nothing in hand changed, if the copies
// will not go together that way.
function holdPart(part, array, ops, loose) {
    let clip = part.clip, name = part.name;
    if (array) {
        const r = G.arrayPart(part.key, array.spec, array.count);
        if (r.error) { flashStatus(r.error); return false; }
        clip = r.clip;
        name = r.clip.blocks[0].name;
    }
    for (const op of ops) clip = op === 'm' ? M.mirrorClipH(clip) : M.rotateClipCW(clip);
    placingPart = {
        key: part.key, name, clip, pins: pinsOfClip(clip), ring: M.clipRing(clip), parts: partsOfClip(clip),
        loose: !!loose, array: array || null, ops: ops.slice(),
    };
    updateHandBar();
    refreshStampPreview();
    V.drawGrid();
    return true;
}
// Nothing in hand any more (it is gone from the shelf, or the shelf is).
function dropPart() { placingPart = null; }
function choosePart(part, loose) {
    holdPart(part, null, [], loose);
    closeComponents();
    setDrawMode('part');
    if (loose) flashStatus(`Put down a copy of ${part.name} to change — it goes down with its lid off for good`);
}
// R and M, with a part in hand: turn or flip the one about to go down.
function turnPart(mirror) {
    if (!placingPart) return;
    placingPart.clip = mirror ? M.mirrorClipH(placingPart.clip) : M.rotateClipCW(placingPart.clip);
    placingPart.pins = pinsOfClip(placingPart.clip);
    placingPart.ring = M.clipRing(placingPart.clip);
    placingPart.parts = partsOfClip(placingPart.clip);
    if (placingPart.ops) placingPart.ops.push(mirror ? 'm' : 't');
    refreshStampPreview();
    V.drawGrid();
}
function renderComponentsList() {
    const parts = availableParts();
    componentsListEl.innerHTML = '';
    componentsEmptyEl.style.display = parts.length ? 'none' : 'block';
    componentsEmptyEl.textContent = gameLevel
        ? 'No parts for this level yet — every level you solve becomes one for the levels after it.'
        : 'No parts yet. Solve a level and it becomes one; or build a circuit, select round it, and Make part…';
    for (const part of parts) {
        const row = document.createElement('div');
        row.className = 'component-row part-row';
        const label = document.createElement('span');
        label.className = 'component-label';
        const ins = part.pins.filter((q) => q.dir === 'in').map((q) => q.name).join(' ');
        const outs = part.pins.filter((q) => q.dir === 'out').map((q) => q.name).join(' ');
        label.innerHTML = '';
        const nameEl = document.createElement('b');
        nameEl.textContent = part.name;
        const meta = document.createElement('span');
        meta.className = 'part-meta';
        meta.textContent = ` ${ins} → ${outs} · ${part.w}×${part.h}`;
        label.append(nameEl, meta);
        label.title = `${part.name}: ${ins} → ${outs}, ${part.w}×${part.h} cells`;
        // Repeating it is done on the board, from the bar over it once the
        // part is in hand (Array…): the shelf only gives it.
        const placeBtn = document.createElement('button');
        placeBtn.className = 'tool-btn primary';
        placeBtn.textContent = 'Place';
        placeBtn.addEventListener('click', () => choosePart(part));
        const editBtn = document.createElement('button');
        editBtn.className = 'tool-btn';
        editBtn.textContent = 'Edit';
        editBtn.title = `Put down a loose copy of ${part.name} to change; Make part… saves it back`;
        editBtn.addEventListener('click', () => choosePart(part, true));
        row.append(label, placeBtn, editBtn);
        if (part.key.startsWith('user:')) {
            // Renamed where its name is: the name becomes a box to type in.
            const renameBtn = document.createElement('button');
            renameBtn.className = 'tool-btn';
            renameBtn.textContent = 'Rename';
            renameBtn.title = `Give ${part.name} another name`;
            renameBtn.addEventListener('click', () => startRename(label, part));
            row.append(renameBtn);
            const del = document.createElement('button');
            del.className = 'tool-btn danger';
            del.textContent = 'Delete';
            del.addEventListener('click', async () => {
                if (!await ask(`Delete the part "${part.name}"? Copies already on a board stay.`, { ok: 'Delete', danger: true })) return;
                G.deletePart(part.key);
                if (placingPart && placingPart.key === part.key) placingPart = null;
                renderComponentsList();
                applyToolAvailability();
            });
            row.append(del);
        }
        componentsListEl.appendChild(row);
    }
}
// Renaming one of the player's own parts, on its row of the shelf: its
// name a box to type the new one in — Enter keeps it, Esc does not, and
// so does clicking away. A name another part has is refused, the box
// staying open. In hand, it is the renamed part; being changed (an Edit
// or a Decap not yet saved back), likewise.
function startRename(label, part) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 24;
    input.value = part.name;
    input.className = 'part-rename';
    input.setAttribute('aria-label', `New name for ${part.name}`);
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep, stay) => {
        if (done) return;
        const name = input.value.trim();
        if (keep && name && name !== part.name) {
            const res = G.renamePart(part.key, name);
            if (res.error) {
                flashStatus(res.error);
                if (stay) { input.focus(); input.select(); return; }
            } else {
                renameMemories(part.key, res.key, name);
                if (placingPart && placingPart.key === part.key) {
                    const now = G.getPart(res.key);
                    if (now) holdPart(now, placingPart.array, placingPart.ops || [], placingPart.loose);
                }
                flashStatus(`${part.name} is ${name} now — copies already down keep the old name`);
            }
        }
        done = true;
        renderComponentsList();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true, false));
}
function openComponents() {
    setMenuOpen(false);
    // Copies being set out are put away: what is picked here goes in hand.
    if (arrayEditing()) closeArray();
    renderComponentsList();
    componentsPanel.classList.add('open');
    componentsBackdrop.classList.add('open');
}
function closeComponents() {
    componentsPanel.classList.remove('open');
    componentsBackdrop.classList.remove('open');
}

// ---- The Parts tool: a whole part per click ----
// Centred on the pointer like the mux. It replaces what is under it; in
// the sandbox, a part reaching past the edge grows the board to take it,
// as drawing there would.
function partAnchor(p) {
    const c = placingPart.clip;
    return { x: Math.round(p.fx - c.w / 2), y: Math.round(p.fy - c.h / 2) };
}
// The model says where a part may go — its edge agreeing with what is
// round it (see M.blockFits). The sandbox grows to take one that reaches
// past its edge. What is under it is replaced, as a paste replaces it
// (clearanceFor, in the model): only another part, a level's pad, or
// something solid against its edge is in the way.
const partBlocked = (at) => M.blockFits(placingPart.clip, at.x, at.y, { grow: !gameLevel, replace: true });
function placePartAt(p) {
    if (!placingPartValid()) { openComponents(); return; }
    // A press on a part already there is the first half of a double-
    // click to lift its lid, not a try at stacking another on it.
    if (M.blockAtCell(Math.floor(p.fx), Math.floor(p.fy))) return;
    let at = partAnchor(p);
    const why = partBlocked(at);
    if (why) { flashStatus(why); return; }
    beginUndoBatch();
    at = roomFor(placingPart.clip, at);
    if (placingPart.loose) {
        // A copy to work on: its circuit loose, remembered as the part it
        // came from, and the tool put down — one copy is what editing
        // wants.
        M.pasteRegion(M.decapClip(placingPart.clip), at.x, at.y, { replace: true });
        const rect = { x0: at.x, y0: at.y, x1: at.x + placingPart.clip.w - 1, y1: at.y + placingPart.clip.h - 1 };
        rememberEdit(placingPart.key, placingPart.pins.map((q) => ({ ...q, at: q.at && [at.x + q.at[0], at.y + q.at[1]] })), rect);
        endUndoBatch();
        const g = applyExpansion();
        flashStatus(`A loose ${placingPart.name} to change — it stays selected: Make part… saves it back, its name and pins as they were`);
        placingPart = null;
        setDrawMode('select');
        // Selected, so saving it back is Make part… and nothing more.
        setSelection({ x0: rect.x0 + g.left, y0: rect.y0 + g.top, x1: rect.x1 + g.left, y1: rect.y1 + g.top });
        afterEdit();
        return;
    }
    M.pasteRegion(placingPart.clip, at.x, at.y, { replace: true });
    endUndoBatch();
    applyExpansion();
    afterEdit();
}
// In the sandbox, the board grown to take a clip going down at `at`, plus
// the one-cell border it keeps: where `at` is then. (In an undo batch.)
function roomFor(c, at) {
    if (gameLevel) return at;
    const g = M.growBy(1 - at.x, 1 - at.y, at.x + c.w + 1 - M.GRID_W, at.y + c.h + 1 - M.GRID_H);
    if (!g.left && !g.top) return at;
    V.compensateExpansion(g.left, g.top);
    gridOrigin.x += g.left;
    gridOrigin.y += g.top;
    return { x: at.x + g.left, y: at.y + g.top };
}
// A clip put down with its top-left at `at`, as a part in hand is: what is
// under it replaced, the sandbox grown to take it. {why} if it cannot go
// there, else {at}: where it went, the board grown or not. Undone, the
// board goes back to `from` if given (see beginUndoBatch).
function placeClipAt(clip, at, from) {
    const why = M.blockFits(clip, at.x, at.y, { grow: !gameLevel, replace: true });
    if (why) return { why };
    beginUndoBatch(from);
    at = roomFor(clip, at);
    M.pasteRegion(clip, at.x, at.y, { replace: true });
    endUndoBatch();
    const g = applyExpansion();
    afterEdit();
    return { at: { x: at.x + g.left, y: at.y + g.top } };
}

// A part's lid: shut, it is one package; open, its circuit shows where
// it sits. Not an edit, so no undo step and no retired verdict.
function toggleLid(id) {
    const info = M.blockInfo(id);
    if (!info) return;
    M.setBlockOpen(id, !info.open);
    updateActionButtons();
    V.drawGrid();
    scheduleSave(true);
}
// The one part picked out with Rearrange, if that is what is selected.
function selectedPart() {
    if (drawMode !== 'rearrange' || arrangeSel.length !== 1) return 0;
    const [x, y] = arrangeSel[0].cells[0];
    const b = M.blockAtCell(x, y);
    return b ? M.topBlockOf(b) : 0;
}
// Take the lid off for good: the part's circuit is loose parts from
// here, to change as you like. Parts nested in it stay parts. What it
// was is remembered, so that Make part… can save it back as that part —
// decap, refine, make part is how a part is edited where it is used.
function decapSelected() {
    const id = selectedPart();
    if (!id) return;
    const info = M.blockInfo(id);
    beginUndoBatch();
    M.decapBlock(id);
    endUndoBatch();
    setArrangeSel([]);
    if (info) {
        rememberEdit(info.source ? info.source : 'user:' + info.name, info.pins, { x0: info.x0, y0: info.y0, x1: info.x1, y1: info.y1 });
        // Selected (Select shows it), so saving it back is Make part….
        setSelection({ x0: info.x0, y0: info.y0, x1: info.x1, y1: info.y1 });
    }
    afterEdit();
    flashStatus(`${info ? info.name : 'The part'} is decapped — change it, then Make part… (in Select, S) saves it back, its name and pins as they were`);
}

export {
    placingPart, availableParts, placingPartValid, pinsOfClip, holdPart, dropPart, choosePart, turnPart,
    renderComponentsList, openComponents, closeComponents, partAnchor, partBlocked, placePartAt, placeClipAt, toggleLid,
    selectedPart, decapSelected,
};
