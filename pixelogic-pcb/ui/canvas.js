// The board's pointer input: a press starts a gesture made by the tool in
// hand; two fingers pan and zoom; scroll pans, Ctrl+scroll zooms; hover
// says what a cell is.

import {
    partEditGesture, partEditHover, partEditing,
} from './makepart.js';
import {
    arrayEditGesture, arrayEditHover, arrayEditing,
} from './arrayedit.js';
import {
    zoomValueEl,
} from './page.js';
import {
    endUndoBatch, scheduleViewSave,
} from './history.js';
import {
    PAINT_TOOLS, drawMode, setDrawMode,
} from './tools.js';
import {
    clipboard, commitPasteFloat, floatBase, floatGesture, floatPos, setSelection,
} from './clipboard.js';
import {
    bandGesture, dragGesture, selHasCell, setArrangeSel, toggleInSel,
} from './arrange.js';
import {
    paintGesture, straightLock,
} from './paint.js';
import {
    cellPoint, refreshStampPreview, stampAt,
} from './stamp.js';
import {
    placePartAt, toggleLid,
} from './parts.js';
import {
    gameLevel,
} from './campaign.js';
import {
    abortReplay,
} from './verdict.js';
import {
    probeAt, toggleProbeAt,
} from './scope.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
// How far (in screen px) a press-and-hold in Interact must move before
// it's read as "pan the view" instead of "hold this switch/toggle".
const INTERACT_PAN_THRESHOLD = 8;
let lastHoveredCell = null;
// Where the mouse is over the board, in canvas pixels; null once it has
// left. Kept whatever the tool, so picking MUX shows the part at once,
// under a mouse that has not moved.
let mousePos = null;

// ---- Gestures ----
// A press on the board starts a gesture, made by the tool in hand (see
// startGesture): {move(p), end(), abort()}. `move` gets the pointer as
// {sx, sy, c, e} — screen point, cell, event — and may return another
// gesture to carry on as (an Interact press that turns into a pan).
// `end` is letting go; `abort` is a second finger landing, which means a
// pinch or a two-finger pan was meant, so whatever the first finger began
// is taken back. What a gesture needs it keeps itself, for as long as it
// lasts. A press that is done at once — a mux stamped, a part put down,
// a level's toggle flipped — makes none.

// Panning the view with the pointer. Hover feedback waits while it lasts
// (`pans`).
function panGesture(e) {
    let last = { x: e.clientX, y: e.clientY };
    return {
        pans: true,
        move({ e: ev }) {
            V.pan(ev.clientX - last.x, ev.clientY - last.y);
            last = { x: ev.clientX, y: ev.clientY };
            scheduleViewSave();
            V.drawGrid();
        },
        end() { }, abort() { },
    };
}

// Pressing a switch or a toggle (`held`: a momentary switch now down,
// let go with the press; `flipped`: a toggle flipped, and staying so).
// Not an edit, so no undo batch. Moving far enough before letting go
// makes it a pan instead, and takes the press back — a toggle by
// flipping it again — so a drag to look around leaves nothing behind.
function pressGesture(c, sx, sy, held, flipped) {
    const release = () => { if (held) { M.setSwitch(c.x, c.y, false); held = false; V.drawGrid(); } };
    return {
        move({ sx: x, sy: y, e }) {
            if (Math.hypot(x - sx, y - sy) <= INTERACT_PAN_THRESHOLD) return null;
            release();
            if (flipped) M.toggleAt(c.x, c.y);
            V.drawGrid();
            return panGesture(e);
        },
        end: release,
        abort: release,
    };
}

// Select: a region from where the press began to the pointer.
function selectGesture(c) {
    setSelection({ x0: c.x, y0: c.y, x1: c.x, y1: c.y });
    V.drawGrid();
    return {
        move({ c: p }) {
            const cx = Math.max(0, Math.min(M.GRID_W - 1, p.x));
            const cy = Math.max(0, Math.min(M.GRID_H - 1, p.y));
            setSelection({
                x0: Math.min(c.x, cx), y0: Math.min(c.y, cy),
                x1: Math.max(c.x, cx), y1: Math.max(c.y, cy),
            });
            V.drawGrid();
        },
        end() { }, abort() { },
    };
}

// What a press at (sx, sy) starts, with the tool in hand: a gesture, or
// null for one that is done at once. `erase` is the right button.
// `o`: {isTouch, toggle (Ctrl/Cmd held), shift}.
function startGesture(sx, sy, erase, o) {
    const c = V.screenToCell(sx, sy);
    // Touching the board ends any verification replay: it is driving
    // the inputs, and two things fighting over them helps nobody.
    abortReplay();
    // A level's I/O pads are locked, so no tool can paint them — which
    // frees the press to mean the only thing left that it could usefully
    // mean. Flipping an input to watch what the circuit does is half of
    // building one, and reaching for the Interact tool every time to do
    // it was pure ceremony.
    // Making a part: the board is its drawing (see makepart.js). Setting
    // out a part's copies, likewise (arrayedit.js).
    if (partEditing()) return partEditGesture(c, sx, sy, erase);
    if (arrayEditing()) return arrayEditGesture(c, sx, sy, erase);
    // A probe goes on (or comes off) anything, a level's pads included.
    if (drawMode === 'probe') { toggleProbeAt(c.x, c.y); return null; }
    if (gameLevel && !erase && M.isLocked(c.x, c.y) && drawMode !== 'interact') {
        if (M.setSwitch(c.x, c.y, true)) { V.drawGrid(); return pressGesture(c, sx, sy, true, false); }
        if (M.toggleAt(c.x, c.y)) { V.drawGrid(); return null; }
    }
    if (drawMode === 'interact') {
        // Nothing under a shut lid can be pressed: it cannot be seen.
        const shut = M.visibleBlockAt(c.x, c.y);
        const hidden = shut && !(M.blockInfo(shut) || {}).open;
        if (!M.inBounds(c.x, c.y) || hidden) return null;
        const held = M.setSwitch(c.x, c.y, true);
        const flipped = !held && M.toggleAt(c.x, c.y);
        if (held || flipped) V.drawGrid();
        return pressGesture(c, sx, sy, held, flipped);
    }
    if (drawMode === 'select') return M.inBounds(c.x, c.y) ? selectGesture(c) : null;
    if (drawMode === 'rearrange') {
        const obj = M.inBounds(c.x, c.y) ? M.objectAt(c.x, c.y) : null;
        // Empty space starts a rubber band. It doubles as "clear the
        // selection": a tap that never moves ends with an empty band.
        if (!obj) {
            if (M.inBounds(c.x, c.y)) return bandGesture(c);
            setArrangeSel([]);
            V.drawGrid();
            return null;
        }
        if (o.toggle) { toggleInSel(obj); return null; }   // Ctrl/Cmd-click
        // Pressing something already selected drags the whole group;
        // pressing anything else selects just it first.
        if (!selHasCell(c.x, c.y)) setArrangeSel([obj]);
        return dragGesture(c, obj, o.isTouch);
    }
    if (drawMode === 'paste') {
        if (!floatBase) return null;
        const inFloat = c.x >= floatPos.x && c.x <= floatPos.x + clipboard.w - 1 &&
            c.y >= floatPos.y && c.y <= floatPos.y + clipboard.h - 1;
        if (inFloat) return floatGesture(c);
        // Tapping elsewhere on the canvas drops the float in place.
        commitPasteFloat();
        setDrawMode('select');
        return null;
    }
    if (drawMode === 'mux' && !erase) { stampAt(cellPoint(sx, sy)); return null; }
    if (drawMode === 'part' && !erase) { placePartAt(cellPoint(sx, sy)); return null; }
    // Right-click with a part in hand erases, as right-drag does with
    // any tool; otherwise the material in hand. Right button (mouse)
    // always erases.
    if (drawMode === 'part') return paintGesture(c, 'insulator', false);
    return paintGesture(c, erase ? 'insulator' : drawMode, o.shift || straightLock);
}

function setupCanvasEvents() {
    const canvas = V.canvas;

    // Pointer Events unify mouse, pen and touch. Touch adds two things
    // the mouse path can't do on a phone: a single finger draws/selects/
    // pastes (there's no hover, so paste is a direct tap), and two
    // fingers pan + pinch-zoom. Once a second finger lands we abandon any
    // in-progress single-finger stroke and stay in gesture mode until
    // every finger lifts, so a pinch never leaves a stray drawn line.
    const activeTouches = new Map(); // pointerId -> {x, y}, touch pointers only
    let touchGesture = false;
    let lastMid = null, lastDist = 0;
    let gesture = null;   // the one in progress (see Gestures)

    function pointerPos(e) {
        const rect = canvas.getBoundingClientRect();
        return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
    }
    function begin(sx, sy, erase, o) {
        if (gesture) endGesture();
        gesture = startGesture(sx, sy, erase, o);
    }
    function endGesture() {
        const g = gesture;
        gesture = null;
        if (g) g.end();
        endUndoBatch();
    }
    function abortGesture() {
        const g = gesture;
        gesture = null;
        if (g) g.abort();
        endUndoBatch();
    }

    function beginTwoFinger() {
        const pts = [...activeTouches.values()];
        lastMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    }

    // Incremental: each move applies the change since the last one — pan
    // by the midpoint's shift, zoom about that midpoint by the ratio the
    // fingers spread. No absolute anchor bookkeeping needed.
    function updateTwoFinger() {
        const pts = [...activeTouches.values()];
        const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const rect = canvas.getBoundingClientRect();
        V.pan(midX - lastMid.x, midY - lastMid.y);
        zoomAt(midX - rect.left, midY - rect.top, dist / lastDist);
        lastMid = { x: midX, y: midY };
        lastDist = dist;
        scheduleViewSave();
        V.drawGrid();
    }

    canvas.addEventListener('pointerdown', (e) => {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
        if (e.pointerType === 'touch') {
            e.preventDefault();
            activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (activeTouches.size >= 2) {
                abortGesture();       // abandon + roll back any single-finger draw
                touchGesture = true;
                beginTwoFinger();
                return;
            }
            if (touchGesture) return; // still settling from a prior gesture
            const { sx, sy } = pointerPos(e);
            begin(sx, sy, false, { isTouch: true });
            return;
        }
        // mouse / pen. Shift-drag pans, except with a paint tool, where it
        // draws a straight line — the convention every paint program has.
        const shiftPans = e.shiftKey && !PAINT_TOOLS.includes(drawMode)
            && !(drawMode === 'rearrange' && (e.ctrlKey || e.metaKey));
        if (e.button === 1 || shiftPans) {
            if (gesture) endGesture();
            gesture = panGesture(e);
            return;
        }
        if ((drawMode === 'select' || drawMode === 'paste' || drawMode === 'rearrange') && e.button !== 0 && !partEditing()) return;
        const { sx, sy } = pointerPos(e);
        begin(sx, sy, e.button === 2, { toggle: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    });

    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') {
            if (activeTouches.has(e.pointerId)) activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (touchGesture) { if (activeTouches.size >= 2) updateTwoFinger(); return; }
        }
        const { sx, sy } = pointerPos(e);
        if (gesture) {
            const p = { sx, sy, c: V.screenToCell(sx, sy), e };
            const next = gesture.move(p);
            if (next) { gesture = next; gesture.move(p); }
            if (gesture.pans) return;
        }
        if (e.pointerType !== 'touch') {
            if (partEditing()) partEditHover(sx, sy, V.screenToCell(sx, sy));
            if (arrayEditing()) arrayEditHover(sx, sy);
            updateCellInfo(sx, sy);
            // Show where the MUX tool would put its part.
            mousePos = { sx, sy };
            if (refreshStampPreview()) V.drawGrid();
        }
    });

    function onPointerEnd(e) {
        if (e.pointerType === 'touch') {
            activeTouches.delete(e.pointerId);
            if (activeTouches.size >= 2) { beginTwoFinger(); return; } // e.g. 3->2 fingers
            if (activeTouches.size === 0) touchGesture = false;
            // One finger still down after a gesture stays inert until all
            // lift, so it can't start a stray stroke.
        }
        endGesture();
    }
    canvas.addEventListener('pointerup', onPointerEnd);
    canvas.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') endGesture(); });

    canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'mouse') return;
        document.getElementById('cellInfo').textContent = '';
        lastHoveredCell = null;
        mousePos = null;
        if (refreshStampPreview()) V.drawGrid();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Double-click a part to lift its lid, and again to put it back. The
    // part it means is the one you can see there: the outermost with its
    // lid shut, or else the innermost.
    canvas.addEventListener('dblclick', (e) => {
        const { sx, sy } = pointerPos(e);
        const c = V.screenToCell(sx, sy);
        const b = M.visibleBlockAt(c.x, c.y);
        if (!b) return;
        e.preventDefault();
        toggleLid(b);
        updateCellInfo(sx, sy);
    });

    // Scroll pans (so two-finger trackpad scrolling just works);
    // Ctrl+scroll — which is also what a trackpad pinch reports — zooms
    // about the cursor. Zoom is proportional to the scroll delta, so a
    // trackpad's stream of small deltas gives a smooth glide instead of
    // compounding a flat 10% per event.
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            const rect = canvas.getBoundingClientRect();
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.004, -e.deltaY));
        } else {
            V.pan(-e.deltaX, -e.deltaY);
        }
        scheduleViewSave();
        refreshStampPreview();
        V.drawGrid();
    }, { passive: false });
}

// Zoom about a fixed screen point, keeping whatever is under it exactly
// in place. Uses fractional cell coordinates — anchoring on the floored
// cell (screenToCell) would make each zoom step also jump by up to a
// cell.
function zoomAt(sx, sy, factor) {
    const cs0 = M.CELL_SIZE * V.zoom;
    const fx = (sx - V.panX) / cs0, fy = (sy - V.panY) / cs0;
    V.setZoom(V.zoom * factor);
    const cs1 = M.CELL_SIZE * V.zoom;
    V.pan(sx - fx * cs1 - V.panX, sy - fy * cs1 - V.panY);
    updateZoomLabel();
}

function zoomAtCenter(factor) {
    zoomAt(V.width / 2, V.height / 2, factor);
    scheduleViewSave();
    V.drawGrid();
}

// What a cell IS, in the terms the tools and the level text use. The
// readout used to print the model's internals — "gray (comMiddle)",
// "gray (boxSel)" — which named nothing a player could act on. For a mux
// it says which terminal the cell is, and for a part that is not wired up
// yet, what to wire next.
function describeCell(x, y) {
    const vb = M.visibleBlockAt(x, y);
    const part = vb ? M.blockInfo(vb) : null;
    if (part && !part.open) {
        const pin = part.pins.find((q) => q.host && q.host[0] === x && q.host[1] === y);
        return pin ? `${part.name}, pin ${pin.name} (${pin.dir === 'in' ? 'input' : 'output'})`
            : `${part.name} — a part; double-click to look inside`;
    }
    const plain = describeLooseCell(x, y);
    if (part) return `${plain} (inside ${part.name})`;
    // On a part's edge: a terminal, or a cell it keeps bare.
    for (const e of M.edgeAt(x, y)) {
        const info = M.blockInfo(e.id);
        if (!info) continue;
        if (e.cls === 'T') {
            const pin = info.pins[e.pin];
            return `${plain} — ${info.name}’s terminal ${pin ? pin.name : ''}${M.isInsulatorId(M.getCell(x, y)) ? ': wire it here' : ''}`;
        }
        if (e.cls === 'R') return `${plain} — kept bare by ${info.name}`;
    }
    return plain;
}
function describeLooseCell(x, y) {
    const id = M.getCell(x, y);
    if (M.isInsulatorId(id)) return 'empty';
    if (M.isConductorId(id) || M.isXover(id)) return M.isCrossoverAt(x, y) ? 'wire crossing' : 'wire';
    if (id === M.ID_POS) return '+V source';
    if (id === M.ID_NEG) return '−V source';
    if (M.isLed(id)) return M.ledIsOn(id) ? 'LED, lit' : 'LED';
    if (M.isSwitch(id)) return M.switchIsPressed(id) ? 'switch, held' : 'switch';
    if (M.isToggle(id)) return M.toggleIsOn(id) ? 'toggle, on' : 'toggle, off';
    const role = M.roles[M.idx(x, y)];
    if (!role || !role.macro) return 'mux material — not part of a whole mux, so inert';
    const m = role.macro;
    switch (role.kind) {
        case 'end': return role.isFirst === m.selIsFirst
            ? 'mux NO pin — joined to COM while SELECT is on'
            : 'mux NC pin — joined to COM while SELECT is off';
        case 'com': return 'mux COM';
        case 'sel': return 'mux SELECT';
        case 'switch': return 'mux switch — joins COM to NO or NC';
        default: return 'mux';
    }
}

function updateCellInfo(sx, sy) {
    const { x, y } = V.screenToCell(sx, sy);
    const cellInfo = document.getElementById('cellInfo');
    if (!M.inBounds(x, y)) { cellInfo.textContent = ''; lastHoveredCell = null; return; }
    lastHoveredCell = { x, y };
    let label = describeCell(x, y);
    // A level's pads carry the name the brief and the truth table use.
    const pad = V.labels.find((l) => l.x === x && l.y === y);
    if (pad) label = `${pad.text}: ${label} (fixed)`;
    const probe = probeAt(x, y);
    if (probe >= 0) label += ` — probe ${V.probes[probe].name}`;
    cellInfo.textContent = `(${x},${y}) ${label}`;
}

function updateZoomLabel() {
    zoomValueEl.textContent = Math.round(V.zoom * 100) + '%';
}

export {
    INTERACT_PAN_THRESHOLD, lastHoveredCell, mousePos, panGesture, pressGesture, selectGesture, startGesture,
    setupCanvasEvents, zoomAt, zoomAtCenter, describeCell, describeLooseCell, updateCellInfo,
    updateZoomLabel,
};
