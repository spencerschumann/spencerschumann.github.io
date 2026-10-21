// Painting cells and pressing switches; the roles the board's muxes are
// read into after every edit (recomputeRoles); laying a mux down whole
// (muxLayout, stampMux).

import {
    DIRS, ID_INSULATOR_PLAIN, ID_MUX_X, ID_NEG, ID_POS, ID_SWITCH_OFF, ID_SWITCH_ON, ID_TOGGLE_OFF,
    ID_TOGGLE_ON, MK_C, MK_M, MK_NC, MK_NO, MK_O, MK_X, NEIGHBORS_8, OFF, SEL_NC, isConductorId, isMuxId,
    isInsulatorId, isLed, isSwitch, isToggle, isWireId, isXover, makeConductor, makeLed, makeMuxC, makeMuxM,
    makeMuxNC, makeMuxNO, makeMuxO, mirrorId, muxDirOf, muxKindOf, rotateId, toggleIsOn, armInto, combineCharge,
    conductorCharge, makeXover, xoverH, xoverV,
} from './cells.js';
import {
    B, idx, inBounds,
} from './board.js';
import {
    cellConnects, computeBlockGeom, computeRingMask, isProtected,
} from './blocks.js';
import {
    prunePendingLinks,
} from './nets.js';

// ===== Painting =====
// Colors: 'insulator', 'conductor', 'pos', 'neg', 'led', 'switch',
// 'toggle'. A mux is not painted cell by cell: it is put down whole, its
// cells typed (muxLayout, stampMux).
function idForColor(color) {
    switch (color) {
        case 'conductor': return makeConductor(OFF);
        case 'pos': return ID_POS;
        case 'neg': return ID_NEG;
        case 'led': return makeLed(OFF);
        case 'switch': return ID_SWITCH_OFF;
        case 'toggle': return ID_TOGGLE_OFF;
        case 'insulator': return ID_INSULATOR_PLAIN;
        default: return null;
    }
}
function paintCell(x, y, color) { paintCells([[x, y]], color); }
// Several cells in one go, re-reading the board once at the end — a
// stroke joined up across a fast drag can be dozens of cells.
//
// Nothing is painted over mux body: a wire drawn into a mux would leave
// five cells that are no mux at all. If a wire has to go where a mux is,
// the mux is erased (the eraser takes it whole) or moved first. Erasing
// — painting bare substrate — is the one paint that may touch it.
function paintCells(list, color) {
    const id = idForColor(color);
    if (id === null) return false;
    const painted = [];
    for (const [x, y] of list) {
        if (!inBounds(x, y) || isProtected(x, y)) continue;
        if (!isInsulatorId(id) && isMuxId(B.cells[idx(x, y)])) continue;
        B.cells[idx(x, y)] = id;
        painted.push(idx(x, y));
    }
    if (!painted.length) return;
    // Wire erased from beside a crossing may leave it crossing nothing.
    plainLoneCrossings(painted);
    recomputeRoles();
}

// ===== Crossings =====
//
// A crossing is a cell of its own (cells.js): made only so, and unmade
// so — or by taking away what it crossed (plainIfLone).
// Whether (x, y) has an arm going way d: a wire there, or a mux's lead
// facing in (the stub of wire it is drawn as).
function armAt(x, y, d) {
    const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
    return inBounds(nx, ny) && armInto(B.cells[idx(nx, ny)], d);
}
// A plain wire with an arm every way: a 4-way, which can be a crossing.
function crossable(x, y) {
    return inBounds(x, y) && isConductorId(B.cells[idx(x, y)]) && [0, 1, 2, 3].every((d) => armAt(x, y, d));
}
// Makes (x, y) a crossing (on) or a plain wire, keeping its charge.
// Whether it changed.
function setCrossing(x, y, on) {
    if (!inBounds(x, y) || isProtected(x, y)) return false;
    const i = idx(x, y), id = B.cells[i];
    if (on && isConductorId(id)) B.cells[i] = makeXover(conductorCharge(id), conductorCharge(id));
    else if (!on && isXover(id)) B.cells[i] = makeConductor(combineCharge(xoverV(id), xoverH(id)));
    else return false;
    recomputeRoles();
    return true;
}
// A stroke of wire drawn straight across a wire makes a crossing where it
// passes: `path` the stroke's cells in order, `drawn` (a Set of idx) the
// ones it laid. A cell it went straight through — in one side and out the
// other — that was wire before it came, running the other way only (an
// arm each side that way, none along the stroke), becomes a crossing.
// Anything else the stroke meets it joins: a T, a corner, a 4-way made
// by drawing its fourth arm. The crossings it made — or, `dry`, would make.
function crossWhereDrawn(path, drawn, dry) {
    const made = [];
    const old = (x, y, d) => {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        return armAt(x, y, d) && !drawn.has(idx(nx, ny));
    };
    for (let k = 1; k + 1 < path.length; k++) {
        const [x, y] = path[k], [ax, ay] = path[k - 1], [bx, by] = path[k + 1];
        if (!inBounds(x, y) || drawn.has(idx(x, y)) || !isConductorId(B.cells[idx(x, y)])) continue;
        const along = ay === y && by === y && ax !== bx ? [1, 3] : ax === x && bx === x && ay !== by ? [0, 2] : null;
        if (!along) continue;
        const across = along[0] === 1 ? [0, 2] : [1, 3];
        if (!across.every((d) => old(x, y, d)) || along.some((d) => old(x, y, d)) || isProtected(x, y)) continue;
        if (dry || setCrossing(x, y, true)) made.push([x, y]);
    }
    return made;
}
// A crossing that crosses nothing any more — nothing on either side of it
// one way — is plain wire again: what is left of it runs the other way
// only, or ends there, which plain wire carries just the same. One with a
// wire on one side each way, an L, stays a crossing: plain, it would join
// the two. A part's is the part's. (A crossing used to stay one until it
// was clicked, whatever was erased round it, and one dragged off in
// Rearrange went on crossing nothing where it landed.) `at`: a board
// index; whether it changed.
function plainIfLone(at) {
    const x = at % B.w, y = (at - x) / B.w, id = B.cells[at];
    if (!isXover(id) || B.blockAt[at]) return false;
    const side = (d) => { const [dx, dy] = DIRS[d]; return cellConnects(x + dx, y + dy, [-dx, -dy]); };
    if ((side(0) || side(2)) && (side(1) || side(3))) return false;
    B.cells[at] = makeConductor(combineCharge(xoverV(id), xoverH(id)));
    return true;
}
// The crossings beside `list`'s cells (board indices), when what was there
// has been taken away: plainIfLone each. Whether any changed.
function plainLoneCrossings(list) {
    let any = false;
    for (const i of list) {
        const x = i % B.w, y = (i - x) / B.w;
        for (const [dx, dy] of DIRS) if (inBounds(x + dx, y + dy) && plainIfLone(idx(x + dx, y + dy))) any = true;
    }
    return any;
}

function colorOfCell(id) {
    if (isMuxId(id)) return 'mux';
    if (id === ID_POS) return 'pos';
    if (id === ID_NEG) return 'neg';
    if (isLed(id)) return 'led';
    if (isSwitch(id)) return 'switch';
    if (isToggle(id)) return 'toggle';
    if (isConductorId(id) || isXover(id)) return 'conductor';
    return 'insulator';
}

// Flood the whole 8-connected pad the touched cell belongs to (same-kind
// cells) to a target id, so a large button/pad acts as one.
function floodPad(x, y, memberFn, target) {
    const stack = [[x, y]], seen = new Set([idx(x, y)]);
    while (stack.length) {
        const [cx, cy] = stack.pop();
        B.cells[idx(cx, cy)] = target;
        for (const [dx, dy] of NEIGHBORS_8) {
            const nx = cx + dx, ny = cy + dy;
            if (!inBounds(nx, ny) || seen.has(idx(nx, ny)) || !memberFn(B.cells[idx(nx, ny)])) continue;
            seen.add(idx(nx, ny));
            stack.push([nx, ny]);
        }
    }
}

// Momentary switch: press/release the whole pad. Toggle: flip the whole pad.
// Both are interaction (not structural edits, so not recorded for undo).
// Each returns true only if the touched cell was that kind.
function setSwitch(x, y, pressed) {
    if (!inBounds(x, y) || !isSwitch(B.cells[idx(x, y)])) return false;
    floodPad(x, y, isSwitch, pressed ? ID_SWITCH_ON : ID_SWITCH_OFF);
    return true;
}
function toggleAt(x, y) {
    if (!inBounds(x, y) || !isToggle(B.cells[idx(x, y)])) return false;
    floodPad(x, y, isToggle, toggleIsOn(B.cells[idx(x, y)]) ? ID_TOGGLE_OFF : ID_TOGGLE_ON);
    return true;
}
// Absolute form of toggleAt, for driving a level's input pads to a test
// vector: a flip would depend on where the previous case left the pad.
function setToggle(x, y, on) {
    if (!inBounds(x, y) || !isToggle(B.cells[idx(x, y)])) return false;
    floodPad(x, y, isToggle, on ? ID_TOGGLE_ON : ID_TOGGLE_OFF);
    return true;
}

// ===== Roles =====
//
// What each mux cell is part of, read off the cells (see buildMuxRoles),
// after every edit: grids here are small enough that a full rescan is
// cheap.

function floodFill(x0, y0, matchFn, visited) {
    const stack = [[x0, y0]];
    const cellsOut = [];
    visited.add(idx(x0, y0));
    while (stack.length) {
        const [x, y] = stack.pop();
        cellsOut.push([x, y]);
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            const ni = idx(nx, ny);
            if (visited.has(ni)) continue;
            if (!matchFn(nx, ny)) continue;
            visited.add(ni);
            stack.push([nx, ny]);
        }
    }
    return cellsOut;
}

// Every structural edit ends here, so this is also where the board's
// revision moves on (B.rev): what is worked out from the board once per
// revision (blockList) is worked out again. Before and after, so nothing
// read part-way through is kept.
function recomputeRoles() {
    B.rev++;
    computeBlockGeom();
    B.roles.fill(null);
    buildMuxRoles();
    computeRingMask();
    prunePendingLinks();
    B.rev++;
}

// The typed mux whose switch (M) is at (mx, my), framed as the view and
// the editor know a mux — or null if its cells do not make a whole one.
// `rowStart` is the COM row's end at the smaller coordinate, `along` the
// row's direction from it and `toward` the way from the COM row to the
// pin row.
function typedMuxAt(mx, my) {
    const kindAt = (x, y) => (inBounds(x, y) ? muxKindOf[B.cells[idx(x, y)]] : 0);
    const dirAt = (x, y) => muxDirOf[B.cells[idx(x, y)]];
    const d = muxDirOf[B.cells[idx(mx, my)]], [ux, uy] = DIRS[d];
    const ox = mx + ux, oy = my + uy;
    if (kindAt(ox, oy) !== MK_O || dirAt(ox, oy) !== d) return null;
    const tw = (d + 2) & 3;
    let no = null, nc = null;
    for (const sd of [(d + 1) & 3, (d + 3) & 3]) {
        const px = mx + DIRS[sd][0], py = my + DIRS[sd][1];
        if (kindAt(px, py) === MK_NO && dirAt(px, py) === tw) no = [px, py, sd];
        if (kindAt(px, py) === MK_NC && dirAt(px, py) === tw) nc = [px, py, sd];
    }
    if (!no || !nc || no[2] === nc[2]) return null;
    const sc = [no[0] + ux, no[1] + uy], xc = [nc[0] + ux, nc[1] + uy];
    if (kindAt(sc[0], sc[1]) !== MK_C || dirAt(sc[0], sc[1]) !== no[2]) return null;
    if (kindAt(xc[0], xc[1]) !== MK_X) return null;
    const along = d & 1 ? [0, 1] : [1, 0], toward = [...DIRS[tw]];
    const dot = ([x, y]) => x * along[0] + y * along[1];
    const rowStart = dot(sc) < dot(xc) ? sc : xc;
    const at = (i, k) => [rowStart[0] + along[0] * i + toward[0] * k, rowStart[1] + along[1] * i + toward[1] * k];
    const all = [sc, [ox, oy], xc, [no[0], no[1]], [mx, my], [nc[0], nc[1]]];
    const xs = all.map((c) => c[0]), ys = all.map((c) => c[1]);
    const selOut = [...DIRS[no[2]]], comOut = [ux, uy], pinOut = toward;
    return {
        key: `box:${rowStart[0]},${rowStart[1]},${along[0]},${along[1]},${toward[0]},${toward[1]}`,
        rowStart, along, toward, selIsFirst: rowStart === sc,
        selCell: [mx, my], selCorner: sc, selOut, comCell: [ox, oy],
        noCell: [no[0], no[1]], ncCell: [nc[0], nc[1]], bodyCell: xc,
        pinFirst: at(0, 1), pinLast: at(2, 1), comOut, pinOut,
        rect: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 },
        leads: [[sc, selOut], [[ox, oy], comOut], [at(0, 1), pinOut], [at(2, 1), pinOut]],
    };
}
// Roles for the typed muxes: 'sel' (C), 'com' (O), 'body' (X), 'end' (a
// pin; `isFirst` the one at the row's start) and 'switch' (M), each with
// its mux and its lead. Mux cells that make up no whole mux are inert
// material.
function buildMuxRoles() {
    for (let i = 0; i < B.cells.length; i++) {
        if (muxKindOf[B.cells[i]] !== MK_M) continue;
        const mx = i % B.w, my = (i - mx) / B.w;
        const m = typedMuxAt(mx, my);
        if (!m) continue;
        const set = ([x, y], r) => { B.roles[idx(x, y)] = r; };
        set(m.selCorner, { kind: 'sel', macro: m, lead: m.selOut });
        set(m.comCell, { kind: 'com', macro: m, lead: m.comOut });
        set(m.bodyCell, { kind: 'body', macro: m, lead: null });
        for (const pc of [m.noCell, m.ncCell])
            set(pc, { kind: 'end', macro: m, isFirst: pc[0] === m.pinFirst[0] && pc[1] === m.pinFirst[1], lead: m.pinOut });
        set(m.selCell, { kind: 'switch', macro: m, lead: null });
    }
    for (let i = 0; i < B.cells.length; i++) if (isMuxId(B.cells[i]) && !B.roles[i]) B.roles[i] = { kind: 'isolatedMux' };
}

// A mux laid out whole: its six cells, [x, y, id], lying with its control
// at the top left (C O X over 1 M 2) when `rot` is 0, mirrored left to
// right first if `mirror`, then turned `rot` quarters clockwise, its
// bounding box's top left at (x0, y0).
function muxLayout(x0, y0, rot, mirror) {
    let list = [[0, 0, makeMuxC(3, false)], [1, 0, makeMuxO(0, OFF)], [2, 0, ID_MUX_X],
        [0, 1, makeMuxNO(2, OFF, false)], [1, 1, makeMuxM(0, OFF, SEL_NC)], [2, 1, makeMuxNC(2, OFF)]];
    let w = 3, h = 2;
    if (mirror) list = list.map(([x, y, id]) => [w - 1 - x, y, mirrorId(id)]);
    for (let t = 0; t < (((rot % 4) + 4) % 4); t++) {
        const hh = h;
        list = list.map(([x, y, id]) => [hh - 1 - y, x, rotateId(id, 1)]);
        [w, h] = [h, w];
    }
    return list.map(([x, y, id]) => [x0 + x, y0 + y, id]);
}
// Puts a mux's cells down (from muxLayout), over whatever is there —
// the caller has cleared what it replaces.
function stampMux(list) {
    for (const [x, y, id] of list) if (inBounds(x, y) && !(B.anyLocked && B.locked[idx(x, y)] === 1)) B.cells[idx(x, y)] = id;
    recomputeRoles();
}

export {
    idForColor, paintCell, paintCells, colorOfCell, floodPad, setSwitch, toggleAt, setToggle, floodFill,
    recomputeRoles, typedMuxAt, buildMuxRoles, muxLayout, stampMux, crossable, setCrossing, crossWhereDrawn,
    plainIfLone, plainLoneCrossings,
};
