// Rearrange: picking up an object (objectAt) and moving it — or a group,
// turned or not — keeping everything it was wired to (moveObjects).

import {
    DIRS, ID_INSULATOR_PLAIN, ID_NEG, ID_POS, NEIGHBORS_8, OFF, isConductorId, isMuxId, isInsulatorId,
    isLed, isSwitch, isToggle, isWireId, makeConductor, mirrorId, rotateId, stripId,
} from './cells.js';
import {
    B, getCell, idx, inBounds, isCrossoverAt, isLocked,
} from './board.js';
import {
    blockCellIdxs, blockState, cellConnects, mirrorPinCode, restoreBlockState, ringViolations, topBlockOf,
    turnPinCode,
} from './blocks.js';
import {
    recomputeRoles,
} from './edit.js';
import {
    netReaches, orphanWire, wireNetKey,
} from './nets.js';
import {
    muxBlob, muxBodyCells,
} from './regions.js';
import {
    ROUTE_SLACK, ROUTE_STRETCH, anchorNode, floodNet, loopsIn, pathSpan, reduceNet, routeNet, terminalGroups,
} from './route.js';

// ===== Rearrange: whole-object move/rotate that keeps connectivity =====
//
// objectAt identifies the movable "object" under a cell at the
// granularity a user actually thinks in: a whole mux (with the contact
// soldered to each lead, see macroFootprint), mux body that makes up no
// whole mux, an LED/switch/toggle pad (8-connected,
// matching how pads light/press as one), a lone +V/-V cell, or — for
// wires — the straight SEGMENT under the cursor (see wireSegmentAt),
// not the whole net: rearranging is about nudging one run at a time,
// with the rest of the net stretching/rerouting to follow.

function flood8(x0, y0, memberFn) {
    const stack = [[x0, y0]], seen = new Set([idx(x0, y0)]), out = [];
    while (stack.length) {
        const [x, y] = stack.pop();
        out.push([x, y]);
        for (const [dx, dy] of NEIGHBORS_8) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(nx, ny) || seen.has(idx(nx, ny)) || !memberFn(B.cells[idx(nx, ny)])) continue;
            seen.add(idx(nx, ny));
            stack.push([nx, ny]);
        }
    }
    return out;
}

// The mux as one draggable object: its six body cells, plus whatever is
// soldered straight onto a lead — a +V/-V pad, or the first cell of the
// wire leaving it.
//
// Carrying one cell per lead means a dragged part arrives wired the way
// it left, by construction, and only the long haul back to the rest of
// each net is left to re-route — which is exactly what a pending link is
// for when it cannot.
//
// A contact shared with a second mux stays put: taking it along would
// silently unhook the other part, which is a worse surprise.
function macroFootprint(macro) {
    const out = muxBodyCells(macro);
    for (const [[cx, cy], [ox, oy]] of macro.leads) {
        const sx = cx + ox, sy = cy + oy;
        if (!inBounds(sx, sy)) continue;
        const id = B.cells[idx(sx, sy)];
        const takeable = id === ID_POS || id === ID_NEG ||
            (isConductorId(id) && !isCrossoverAt(sx, sy));
        if (!takeable || leadsFacing(sx, sy) > 1 || B.blockAt[idx(sx, sy)]) continue;

        out.push([sx, sy]);
    }
    return out;
}

// How many mux leads point at this cell — 2 when one pad feeds two parts.
// Only leads count, not wires: a pad with a wire on one side and a lead
// on the other is still this mux's alone.
function leadsFacing(x, y) {
    let n = 0;
    for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny) || !isMuxId(B.cells[idx(nx, ny)])) continue;
        const role = B.roles[idx(nx, ny)];
        if (role && role.lead && role.lead[0] === -dx && role.lead[1] === -dy) n++;
    }
    return n;
}

// The wire "object" a click grabs: not the whole 4-connected net (too
// coarse to rearrange with), but the maximal STRAIGHT run of wire cells
// through the clicked cell — including any elbow/tee cell it ends on, so
// dragging a run perpendicular takes its corners along and the adjoining
// legs stretch/shrink via re-routing. At a corner or tee the busier axis
// wins (ties go horizontal) — click one cell over to get the other leg.
//
// A run goes on straight through a crossing, both sides of it: dragging
// one arm alone left the crossing a T, welding its two runs together.
// The crossing cell itself is shared — the move leaves it behind as
// plain wire for the run going the other way, and where the dragged run
// lands across that run, a new crossing forms (see moveObjects).
// Clicking the crossing itself grabs the horizontal run.
function wireSegmentAt(x, y) {
    const wireAt = (ax, ay) => isWireId(getCell(ax, ay));
    const hc = (wireAt(x - 1, y) ? 1 : 0) + (wireAt(x + 1, y) ? 1 : 0);
    const vc = (wireAt(x, y - 1) ? 1 : 0) + (wireAt(x, y + 1) ? 1 : 0);
    const axis = vc > hc ? [0, 1] : [1, 0];
    const out = [[x, y]];
    for (const s of [-1, 1]) {
        let cx = x + axis[0] * s, cy = y + axis[1] * s;
        while (isWireId(getCell(cx, cy)) && !B.blockAt[idx(cx, cy)]) {
            out.push([cx, cy]);
            cx += axis[0] * s;
            cy += axis[1] * s;
        }
    }
    return out;
}

function objectAt(x, y) {
    if (!inBounds(x, y)) return null;
    // Anywhere on a block is the whole block, outermost first: its
    // insides are not the player's to pick apart without decapping it.
    if (B.blockAt[idx(x, y)]) {
        const t = topBlockOf(B.blockAt[idx(x, y)]);
        return { kind: 'block', id: t, cells: blockCellIdxs(t).map((i) => [i % B.w, (i - i % B.w) / B.w]) };
    }
    const id = B.cells[idx(x, y)];
    if (isInsulatorId(id)) return null;
    const role = B.roles[idx(x, y)];
    if (role && role.macro) return { kind: 'mux', cells: macroFootprint(role.macro) };
    if (id === ID_POS || id === ID_NEG) return { kind: 'source', cells: [[x, y]] };
    if (isWireId(id)) return { kind: 'wire', cells: wireSegmentAt(x, y) };
    if (isMuxId(id)) return { kind: 'blob', cells: muxBlob(x, y) };
    if (isLed(id)) return { kind: 'pad', cells: flood8(x, y, isLed) };
    if (isSwitch(id)) return { kind: 'pad', cells: flood8(x, y, isSwitch) };
    if (isToggle(id)) return { kind: 'pad', cells: flood8(x, y, isToggle) };
    return null;
}

// Rigid transform for a move gesture: flip left for right (`mirror`)
// about the object's bounding box, then rotate quarterTurns times 90° CW
// about the box's center (the box's w/h swap and the center is kept put,
// rounded on half-cell ties), then translate. Where the cells go, only:
// what a cell says about its own way round (a mux cell's direction, a
// pin's face) is turned where it is put down (see place).
function transformObjectCells(objCells, dx, dy, quarterTurns, mirror) {
    let pts = objCells.map(([x, y]) => [x, y]);
    if (mirror) {
        const xs = pts.map((p) => p[0]), sum = Math.min(...xs) + Math.max(...xs);
        pts = pts.map(([x, y]) => [sum - x, y]);
    }
    const q = ((quarterTurns % 4) + 4) % 4;
    for (let i = 0; i < q; i++) {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = maxX - minX + 1, h = maxY - minY + 1;
        const nMinX = Math.round((minX + maxX) / 2 - (h - 1) / 2);
        const nMinY = Math.round((minY + maxY) / 2 - (w - 1) / 2);
        pts = pts.map(([x, y]) => [nMinX + (maxY - y), nMinY + (x - minX)]);
    }
    return pts.map(([x, y]) => [x + dx, y + dy]);
}

// Move (and/or rotate) an object's cells as one rigid piece, keeping
// every electrical contact it had: each stationary net that was touching
// the object gets re-connected to the same node (pin) of the object at
// its new place. The steps:
//
//   1. Record contacts (stationary connecting neighbor -> object node).
//   2. Validate the destination. Solid cells (mux/pad/source) reject
//      outright; stationary WIRE cells are forgiving: a moved wire
//      landing on one merges with it (the cell stays a wire, nothing is
//      severed), and a non-wire cell may land on one only if that wire
//      belongs to a net already attached to the object — absorbing a few
//      cells of a net that's being re-routed anyway is repairable, while
//      eating an unrelated net is not, and still rejects.
//   3. Lift the object, flood each contact's stationary net (crossover-
//      aware: the two axes of a crossing are separate nets), and dedupe
//      contacts into per-(net, node) contracts.
//   4. Place the object; absorb overlapped net cells; TRIM net cells now
//      flush against a different node of a multi-node object (a mux)
//      than the one they're contracted to — in an adjacency world flush
//      IS connected, and rotation frequently parks a body cell right on
//      the old wire, which must not silently rewire COM onto a pin.
//   5. Re-route each contract whose net no longer touches its node, from
//      any surviving net cell (or the net's terminal pads/pins/sources
//      if every wire cell was consumed) to any cell of the node (see
//      routeNet). Unroutable contracts are counted in `unrouted`, never
//      guessed at. Returns {ok, cells (moved positions, same order),
//      unrouted}.
// Move one object. Thin wrapper over moveObjects, which is the general
// form (a multi-select drag moves several objects as one rigid piece).
function moveObject(objCells, dx, dy, quarterTurns, mirror) {
    const res = moveObjects([{ cells: objCells }], dx, dy, quarterTurns, mirror);
    return res.ok ? { ok: true, cells: res.objects[0].cells, unrouted: res.unrouted, pending: res.pending } : res;
}

// Move a GROUP as one rigid piece. Everything below is driven by a
// per-cell node key rather than a single "is this a mux" flag: within a
// mux each cell is its own electrical node (its pins must not be welded
// to each other), while any other object is one node however many cells
// it has — and in a group each object contributes its own. That one map
// is what lets a mixed selection of muxes, wires and pads move together
// without their contracts getting confused.
// `mirror` flips the group left for right first (transformObjectCells).
// Returns {ok, objects:[{cells}] in input order, unrouted}.
function moveObjects(objectList, dx, dy, quarterTurns, mirror) {
    const mv = { objectList, dx, dy, quarterTurns, mirror: !!mirror };
    return pickUp(mv)
        || remember(mv)
        || survey(mv)
        || place(mv)
        || reroute(mv)
        || check(mv)
        || oweLinks(mv)
        || finish(mv);
}

// moveObjects, 1 of 8. What is being moved: its cells, the node each belongs
// to, and whether the move can be made at all.
function pickUp(mv) {
    // Within a mux each cell is its own node. SELECT sits right beside
    // COM, but it is an input that must never read as joined to the
    // output: keying the two together merged their contracts, so a
    // re-route for COM was free to land on SELECT's wire (and then get
    // pruned again, taking COM's connection with it). Which cell is
    // which comes off the macro.
    //
    // A carried contact cell (see macroFootprint) belongs to the node of
    // the lead it is soldered to, not to one of its own. Give it its own
    // and COM plus COM's own stub read as two nodes touching, which is a
    // weld — the object would refuse to move at all.
    // (Only a cell that is not mux itself: a mux's own cell is its own
    // node, even with another mux's lead on it head on — following lead to
    // lead between two muxes facing each other went round for ever.)
    const muxNodeKey = (x, y) => {
        if (!isMuxId(B.cells[idx(x, y)])) for (const [dx2, dy2] of DIRS) {
            const bx = x + dx2, by = y + dy2;
            if (!inBounds(bx, by) || !isMuxId(B.cells[idx(bx, by)])) continue;
            const br = B.roles[idx(bx, by)];
            if (br && br.macro && br.lead && br.lead[0] === -dx2 && br.lead[1] === -dy2)
                return muxNodeKey(bx, by);
        }
        const r = B.roles[idx(x, y)];
        if (r && r.macro && r.kind === 'com') return 'm' + r.macro.key + '|com';
        return 'm' + idx(x, y);
    };
    // A mux carries its contact cells (see macroFootprint), so selecting a
    // mux AND the wire running off it legitimately names the same cell
    // twice. The first claim wins — grabbing a mux and its own feed should
    // move both, not report an overlap — and only a cell claimed twice by
    // objects that both really want it is a genuine conflict, which cannot
    // happen once duplicates collapse.
    mv.objCells = [];
    mv.nodeKeys = [];
    mv.objSet = new Set();
    mv.objectList.forEach((o, oi) => {
        const isMux = o.cells.some(([x, y]) => { const r = B.roles[idx(x, y)]; return r && r.macro; });
        for (const [x, y] of o.cells) {
            if (mv.objSet.has(idx(x, y))) continue;
            mv.objSet.add(idx(x, y));
            mv.objCells.push([x, y]);
            mv.nodeKeys.push(isMux ? muxNodeKey(x, y) : 'o' + oi);
        }
    });
    // A level's fixed I/O pad is not draggable, and nothing may be dropped
    // onto one. (Re-routing can't hit a locked cell on its own: the router
    // only lays wire through insulator, and a locked cell always holds a
    // pad.) Checked before anything is written, so there's nothing to undo.
    if (B.anyLocked) {
        const dest = transformObjectCells(mv.objCells, mv.dx, mv.dy, mv.quarterTurns, mv.mirror);
        for (let i = 0; i < mv.objCells.length; i++) {
            if (isLocked(mv.objCells[i][0], mv.objCells[i][1]) || isLocked(dest[i][0], dest[i][1]))
                return { ok: false, reason: 'locked' };
        }
    }
    // A block moves whole or not at all.
    {
        const tops = new Set();
        for (const i of mv.objSet) if (B.blockAt[i]) tops.add(topBlockOf(B.blockAt[i]));
        for (const t of tops) for (const i of blockCellIdxs(t)) if (!mv.objSet.has(i)) return { ok: false, reason: 'block' };
    }
    const rawIds = mv.objCells.map(([x, y]) => B.cells[idx(x, y)]);
    mv.ids = rawIds.map(stripId);
}

// moveObjects, 2 of 8. The board as it was, to put back on a refusal, and
// what holds it together: who is wired to whom, and what every mux is.
function remember(mv) {
    // Every rejection path restores wholesale from this: the checks that
    // can only be made after the object is placed (see the new-contact
    // scan below) would otherwise have to unpick absorbed and trimmed
    // cells by hand. The grid is small, so a copy is cheaper than the
    // bookkeeping.
    mv.savedCells = B.cells.slice();
    const savedBlocks = blockState();
    // Who is wired to whom, to hold the finished board to (see the end).
    mv.startNetOf = new Map();
    mv.joinedAtStart = terminalGroups((i) => i, mv.startNetOf);
    // Connections the player made by putting a dragged wire down against
    // something (see the contact scan): [its group before, the cell met].
    mv.madeJoins = [];
    mv.reject = (why) => {
        B.cells.set(mv.savedCells);
        restoreBlockState(savedBlocks);
        recomputeRoles();
        return { ok: false, reason: why || 'blocked' };
    };
    // What every mux cell on the board currently is. A drag that would
    // leave a mux as something else is refused rather than silently
    // spinning it around. A typed mux is its cells, so nothing round it
    // can do that; this is a backstop. Checked after the move lands, and
    // covers stationary muxes too. Kind alone is not identity: a mux's
    // six cells keep the same kinds when it flips end-for-end, so which
    // FACE each cell connects through is part of the snapshot too. That
    // is what catches a move that hands SELECT to the opposite end and
    // quietly swaps NO for NC.
    mv.muxRoleBefore = new Map();
    for (let i = 0; i < B.cells.length; i++) {
        const r = B.roles[i];
        if (r && r.macro) mv.muxRoleBefore.set(i, { kind: r.kind, lead: r.lead || null });
    }
    // The object itself may be turning, so a lead is expected to turn with
    // it — flipped first, if it is flipping. 90° CW in screen coordinates
    // (y down) is (dx,dy) -> (-dy,dx).
    mv.turnLead = (lead, turns) => {
        let [dx, dy] = lead;
        if (mv.mirror) dx = -dx;
        for (let t = ((turns % 4) + 4) % 4; t > 0; t--) { const nx = -dy; dy = dx; dx = nx; }
        return [dx, dy];
    };
}

// moveObjects, 3 of 8. What the object touches and must keep reaching, where
// every cell goes, and the stationary nets its contacts belong to; then lift
// it.
function survey(mv) {
    // Crossings the object runs through (see wireSegmentAt): shared
    // with the run going the other way, which keeps the cell — where that
    // run is not the object's too. A crossing inside a part, both its runs
    // the part's, goes with it. (Left behind, it stayed marked as the
    // part's, and the part's outline stretched back to it.)
    const sharedX = new Set();
    for (const [cx, cy] of mv.objCells) {
        if (!isCrossoverAt(cx, cy)) continue;
        if (DIRS.some(([ax, ay]) => inBounds(cx + ax, cy + ay) && !mv.objSet.has(idx(cx + ax, cy + ay))
            && cellConnects(cx + ax, cy + ay, [-ax, -ay]))) sharedX.add(idx(cx, cy));
    }
    // A mux's stub that is more than an end — a junction (the run going
    // on past the pin as well as into it, a T) or one arm of a crossing
    // — is carried, so the part keeps its leads and reads as itself
    // where it lands, and ALSO left where it was, so the junction or
    // the crossing stays whole. Carried off alone, it took the junction
    // with it, or left the crossing a T welding its two runs, and on a
    // tight board the pieces could not be joined up again.
    mv.keptBehind = new Set();
    mv.objCells.forEach(([cx, cy], k) => {
        if (!String(mv.nodeKeys[k]).startsWith('m') || !isConductorId(B.cells[idx(cx, cy)])) return;
        let others = 0, crossing = false;
        for (const [ax, ay] of DIRS) {
            const nx = cx + ax, ny = cy + ay;
            if (!inBounds(nx, ny) || mv.objSet.has(idx(nx, ny))) continue;
            if (isCrossoverAt(nx, ny)) crossing = true;
            if (cellConnects(nx, ny, [-ax, -ay])) others++;
        }
        if (crossing || others > 1) mv.keptBehind.add(idx(cx, cy));
    });

    // Raw contacts, collected against the pre-move grid.
    const contacts = [];
    for (const [cx, cy] of mv.objCells) {
        if (!cellConnects(cx, cy)) continue;
        for (const [ddx, ddy] of DIRS) {
            const ax = cx + ddx, ay = cy + ddy;
            // Both ends are asked about the face they actually meet on,
            // so a wire merely sitting beside a mux's package is not
            // recorded as a contact and then dragged along by it.
            if (!inBounds(ax, ay) || mv.objSet.has(idx(ax, ay))) continue;
            if (!cellConnects(cx, cy, [ddx, ddy]) || !cellConnects(ax, ay, [-ddx, -ddy])) continue;
            // A crossing the object runs through: the run going the
            // other way only passes it, and is no contact of the object.
            if (sharedX.has(idx(cx, cy)) && !mv.objSet.has(idx(cx - ddx, cy - ddy))) continue;
            contacts.push({ anchor: [ax, ay], objCell: [cx, cy], entry: [ddx, ddy] });
        }
    }

    // What each contact actually has to keep reaching. The immediate
    // neighbour is not the point — it usually survives, still touching,
    // while the terminal at the FAR end of its net quietly comes adrift.
    // So walk each anchor's net now and remember the terminals, then
    // re-check those after the move. This is what catches a connection
    // lost to the shrink pass or to a route that satisfied a different
    // contract; the router's own `unrouted` count sees none of it.
    // `netKey` is what the contact was attached TO, before anything moved.
    // A net that runs alongside the object touches it at every cell it
    // passes, and a drag that takes a mux together with the wire feeding
    // it meets that net at the wire AND at the pin — so one connection
    // arrives here as several contacts. They are the same owed thing, and
    // the pre-move net is what says so.
    mv.contactTerminals = contacts.map((c) => {
        const net = floodNet(c.anchor[0], c.anchor[1], c.entry[0], c.entry[1]);
        const ts = [...net.terminals].filter((t) => !mv.objSet.has(t));
        return { objCell: idx(c.objCell[0], c.objCell[1]), terminals: ts, netKey: net.key };
    });

    mv.moved = transformObjectCells(mv.objCells, mv.dx, mv.dy, mv.quarterTurns, mv.mirror);
    mv.movedSet = new Set(mv.moved.map(([x, y]) => idx(x, y)));
    mv.newIdxOf = new Map();
    mv.objCells.forEach(([x, y], i) => mv.newIdxOf.set(idx(x, y), idx(mv.moved[i][0], mv.moved[i][1])));
    // Moved cells that can carry a connection (for a mux, everything but
    // its inert select-sense spacer) — the trim step's notion of "flush
    // against a node". Uses pre-move roles, captured before the lift below.
    mv.capableMoved = new Set();
    mv.objCells.forEach(([x, y], i) => {
        const r = B.roles[idx(x, y)];
        if (!r || (r.kind !== 'switch' && r.kind !== 'body')) mv.capableMoved.add(idx(mv.moved[i][0], mv.moved[i][1]));
    });
    // Which pairs of the object's own cells already touch, captured on the
    // pre-move grid. A rigid move preserves them, so a pair that touches
    // afterwards and is in here is not a new connection — it is the same
    // one, carried along. Only a pair NOT in here is a weld.
    mv.joinedBefore = new Set();
    for (const [cx, cy] of mv.objCells) {
        for (const [ddx, ddy] of DIRS) {
            const nx = cx + ddx, ny = cy + ddy;
            if (!inBounds(nx, ny) || !mv.objSet.has(idx(nx, ny))) continue;
            if (!cellConnects(cx, cy, [ddx, ddy]) || !cellConnects(nx, ny, [-ddx, -ddy])) continue;
            const a = idx(cx, cy), b = idx(nx, ny);
            mv.joinedBefore.add(Math.min(a, b) + ':' + Math.max(a, b));
        }
    }
    mv.origOfMoved = new Map();
    mv.objCells.forEach(([x, y], i) => mv.origOfMoved.set(idx(mv.moved[i][0], mv.moved[i][1]), idx(x, y)));

    // Cells belonging to one electrical node share an id, so the shrink
    // pass can tell "these two are already joined" from "these two need
    // a wire between them" (see reduceNet).
    const nodeOfOrig = new Map();
    mv.nodeOfMoved = new Map();
    const cellsOfNode = new Map();
    mv.objCells.forEach(([x, y], i) => {
        const mi = idx(mv.moved[i][0], mv.moved[i][1]);
        nodeOfOrig.set(idx(x, y), mv.nodeKeys[i]);
        mv.nodeOfMoved.set(mi, mv.nodeKeys[i]);
        if (!cellsOfNode.has(mv.nodeKeys[i])) cellsOfNode.set(mv.nodeKeys[i], new Set());
        cellsOfNode.get(mv.nodeKeys[i]).add(mi);
    });
    mv.nodeIdFor = (map) => (ci) => {
        if (map.has(ci)) return map.get(ci);
        const nx = ci % B.w, ny = (ci - nx) / B.w;
        return anchorNode(nx, ny).key;
    };

    // Bounds/solidity validation; wire overlaps noted for later.
    const overlaps = [];
    for (let i = 0; i < mv.moved.length; i++) {
        const [mx, my] = mv.moved[i];
        if (!inBounds(mx, my)) return { ok: false };
        const di = idx(mx, my);
        if (!mv.objSet.has(di) && B.blockAt[di]) return { ok: false }; // nothing lands on a block
        if (mv.objSet.has(di) || isInsulatorId(B.cells[di])) continue;
        if (isWireId(B.cells[di])) { overlaps.push({ di, movedIsWire: isWireId(mv.ids[i]) }); continue; }
        return { ok: false }; // something solid in the way
    }

    // Wire that already led nowhere before the move. A run with no
    // terminal on it at either end is the user's business — they may be
    // half-way through drawing it — so the litter sweep at the end has to
    // know which orphans it inherited and which ones it made.
    mv.preOrphans = orphanWire();

    // Crossings as they stand before anything moves. A mux carries the
    // stub on each of its leads, so lifting it can take away one arm of
    // a crossing right beside it — which then reads as a T, joining its
    // two axes, and the floods below would make two nets one: the move
    // then "kept" a connection between them, shorting them for good. So
    // everything the move traces treats a cell that was a crossing as
    // one still. (If it ends up a T after all, the check for joins at
    // the end refuses the move.)
    const preXover = new Set();
    for (let i = 0; i < B.cells.length; i++)
        if (isWireId(B.cells[i]) && isCrossoverAt(i % B.w, (i - i % B.w) / B.w)) preXover.add(i);
    mv.xo = (x, y) => isWireId(B.cells[idx(x, y)]) && (preXover.has(idx(x, y)) || isCrossoverAt(x, y));

    // Lift the object so the net floods see only the stationary world.
    // A block's record rides along in the side arrays.
    const sideOf = mv.objCells.map(([x, y]) => [B.blockAt[idx(x, y)], B.pinAt[idx(x, y)]]);
    for (const [x, y] of mv.objCells) {
        const i = idx(x, y);
        // What stays (see above) is plain wire, and no part's: the part's
        // own copy of the cell goes with it.
        B.cells[i] = sharedX.has(i) || mv.keptBehind.has(i) ? makeConductor(OFF) : ID_INSULATOR_PLAIN;
        B.blockAt[i] = 0;
        B.pinAt[i] = 0;
    }

    mv.components = new Map(); // key -> {cells:Set, terminals:Set}
    mv.contracts = new Map();  // key|node -> {compKey, targets:Set of moved idx}
    for (const ct of contacts) {
        const ai = idx(ct.anchor[0], ct.anchor[1]);
        let comp = isWireId(B.cells[ai]) && !B.blockAt[ai]
            ? floodNet(ct.anchor[0], ct.anchor[1], ct.entry[0], ct.entry[1], mv.xo)
            : anchorNode(ct.anchor[0], ct.anchor[1]);
        if (mv.components.has(comp.key)) comp = mv.components.get(comp.key);
        else mv.components.set(comp.key, comp);
        comp.preTouch.add(idx(ct.objCell[0], ct.objCell[1]));
        // The object-side node this contact is against — its whole node
        // is the re-route target, so a wire that met a pad anywhere along
        // its edge may come back to any part of that pad.
        const gk = nodeOfOrig.get(idx(ct.objCell[0], ct.objCell[1]));
        const ck = comp.key + '|' + gk;
        if (!mv.contracts.has(ck)) mv.contracts.set(ck, { compKey: comp.key, targets: new Set() });
        for (const mi of cellsOfNode.get(gk)) mv.contracts.get(ck).targets.add(mi);
    }

    // Dangles that already existed BEFORE the move (a stub the user drew
    // on purpose, going nowhere). They're protected from the shrink pass
    // below, which is only meant to clean up tails this move orphaned —
    // never to quietly delete wire that was already like that.
    for (const comp of mv.components.values()) {
        if (!comp.isNet) continue;
        comp.preDangling = reduceNet(comp.cells, new Set([...comp.terminals, ...comp.preTouch]), null, mv.nodeIdFor(nodeOfOrig));
    }

    // A part lands on wire by overwriting it — wire of its own nets,
    // which it absorbs, or anyone else's, which it cuts. Refusing used to
    // mean erasing a stub by hand before every drag on a tight board; a
    // cut is owed instead (a dashed line, see the end), never silent. A
    // moved WIRE landing on wire is a join, not a cut, and the check for
    // joins at the end refuses that.
    const contractedWire = new Set();
    for (const comp of mv.components.values()) for (const ci of comp.cells) contractedWire.add(ci);

    // Place the object (overwriting overlapped wire cells) and drop the
    // absorbed cells from their nets' bookkeeping.
    for (const comp of mv.components.values())
        for (const ci of [...comp.cells]) if (mv.movedSet.has(ci)) comp.cells.delete(ci);
    mv.moved.forEach(([x, y], i) => {
        const mi = idx(x, y);
        B.cells[mi] = rotateId(mv.mirror ? mirrorId(mv.ids[i]) : mv.ids[i], mv.quarterTurns);
        B.blockAt[mi] = sideOf[i][0];
        B.pinAt[mi] = turnPinCode(mv.mirror ? mirrorPinCode(sideOf[i][1]) : sideOf[i][1], mv.quarterTurns);
    });
    recomputeRoles();
}

// moveObjects, 4 of 8. Put the object down where it goes, over wire it lands
// on, and trim wire now against a node it does not belong to.
function place(mv) {
    // Trim: a surviving net cell flush against a node it is NOT
    // contracted to would silently connect to the wrong pin — delete it;
    // the re-route below reconnects the net properly. (A single-node
    // object trims nothing, since every target cell is then allowed.)
    {
        const allowed = new Map(); // compKey -> Set of moved idx it may touch
        for (const c of mv.contracts.values()) {
            const s = allowed.get(c.compKey) || new Set();
            for (const t of c.targets) s.add(t);
            allowed.set(c.compKey, s);
        }
        for (const [key, comp] of mv.components) {
            const ok = allowed.get(key) || new Set();
            for (const ci of [...comp.cells]) {
                if (!isWireId(B.cells[ci])) continue;
                const cx2 = ci % B.w, cy2 = (ci - cx2) / B.w;
                // Flush on a face that CONNECTS: a wire running past a
                // part's package on a dead face is not on any of its
                // pins, and trimming it cut nets for nothing — on a
                // tight board even a move by nothing broke the circuit.
                const bad = DIRS.some(([bdx, bdy]) => {
                    const nx = cx2 + bdx, ny = cy2 + bdy;
                    if (!inBounds(nx, ny)) return false;
                    const ni = idx(nx, ny);
                    return mv.capableMoved.has(ni) && !ok.has(ni) && cellConnects(nx, ny, [-bdx, -bdy]);
                });
                if (bad) { B.cells[ci] = ID_INSULATOR_PLAIN; comp.cells.delete(ci); }
            }
        }
    }

    // Preserving connectivity means not INVENTING it either: a move that
    // parks the object flush against something it wasn't touching before
    // has silently wired the two together. The classic case is a wire
    // dragged under a mux body, which shorts the first end, COM and the
    // last end into one node — every destination cell is empty, so
    // nothing above catches it. Identify each stationary node the object
    // now touches and reject anything that wasn't in contact before.
    // A crossing is no net's own cell: what the object meets through
    // one is the run straight beyond it, so look through to that.
    const nodeKeyAt = (nx, ny, ddx, ddy) => {
        if (isWireId(B.cells[idx(nx, ny)]) && !B.blockAt[idx(nx, ny)]) {
            let cx = nx, cy = ny;
            while (mv.xo(cx, cy) && inBounds(cx + ddx, cy + ddy)) { cx += ddx; cy += ddy; }
            for (const [key, comp] of mv.components)
                if (comp.cells.has(idx(cx, cy)) || comp.routed.has(idx(cx, cy))) return key;
            return 'new:' + idx(nx, ny);
        }
        return anchorNode(nx, ny).key; // stationary, so its key is stable across the move
    };
    for (const mi of mv.movedSet) {
        if (!mv.capableMoved.has(mi)) continue;
        const mx = mi % B.w, my = (mi - mx) / B.w;
        if (!cellConnects(mx, my)) continue;
        for (const [ddx, ddy] of DIRS) {
            const nx = mx + ddx, ny = my + ddy;
            if (!inBounds(nx, ny)) continue;
            if (!cellConnects(mx, my, [ddx, ddy]) || !cellConnects(nx, ny, [-ddx, -ddy])) continue;
            // A moved run that lands across a stationary one makes a
            // crossing: that run only passes through.
            if (isCrossoverAt(mx, my) && !mv.movedSet.has(idx(nx, ny)) && !mv.movedSet.has(idx(mx - ddx, my - ddy))) continue;
            // The copy of a stub the move left behind (see keptBehind) is
            // the part's own connection, not someone else's wire to cut.
            if (mv.keptBehind.has(idx(nx, ny)) && !mv.movedSet.has(idx(nx, ny))) continue;
            // Two cells that both moved: fine if they are the same node
            // (a pad's own cells, a mux's COM row), a weld if they are
            // not. A mux carries a contact stub per lead now, and a turn
            // can bring two of them together — which would short SELECT
            // to COM without either ever touching anything stationary,
            // the one way past the check below.
            if (mv.movedSet.has(idx(nx, ny))) {
                if (mv.nodeOfMoved.get(mi) === mv.nodeOfMoved.get(idx(nx, ny))) continue;
                const a = mv.origOfMoved.get(mi), b = mv.origOfMoved.get(idx(nx, ny));
                if (a !== undefined && b !== undefined &&
                    mv.joinedBefore.has(Math.min(a, b) + ':' + Math.max(a, b))) continue;
                return mv.reject('welded');
            }
            // One of the object's own connections: re-routed as ever —
            // unless it is now against a different node of the object
            // than it was (a pin turned onto the source that feeds
            // another), which is a join the drop made, like any other.
            const nk = nodeKeyAt(nx, ny, ddx, ddy);
            if (mv.components.has(nk)) {
                if (!mv.contracts.has(nk + '|' + mv.nodeOfMoved.get(mi))) {
                    const orig = mv.origOfMoved.get(mi);
                    const k = orig !== undefined && mv.startNetOf.has(orig) ? mv.startNetOf.get(orig) : 'drag:' + mv.nodeOfMoved.get(mi);
                    mv.madeJoins.push([k, idx(nx, ny)]);
                }
                continue;
            }
            // A part's own edge that is not a pin is its insides showing,
            // and joins nothing: someone else's wire against it is cut
            // back rather than refusing the drag — as with wire it lands
            // on, the cut is owed — and anything else is in the way.
            if (B.blockAt[mi] && !B.pinAt[mi]) {
                if (isWireId(B.cells[idx(nx, ny)]) && !B.blockAt[idx(nx, ny)]) { B.cells[idx(nx, ny)] = ID_INSULATOR_PLAIN; continue; }
                return mv.reject();
            }
            // Anything else dragged — a wire, a mux, a source, a part by
            // its pins — put down against something joins it. That is
            // what touching means here, and the player can see it:
            // dropping a run onto the stub it should meet, or a part's
            // pin onto its wire, is how a connection is made by
            // dragging, as drawing the cell would be. (It used to be
            // refused, or the wire cut, as a connection invented.)
            // Through a crossing, what it meets is the run beyond.
            let cx = nx, cy = ny;
            while (mv.xo(cx, cy) && inBounds(cx + ddx, cy + ddy)) { cx += ddx; cy += ddy; }
            const orig = mv.origOfMoved.get(mi);
            const k = orig !== undefined && mv.startNetOf.has(orig) ? mv.startNetOf.get(orig) : 'drag:' + mv.nodeOfMoved.get(mi);
            mv.madeJoins.push([k, idx(cx, cy)]);
        }
    }
    recomputeRoles();
}

// moveObjects, 5 of 8. Re-route every contract the move broke, re-laying a
// net’s own wire where it has to and keeping the player’s loops whole; then
// shrink what now leads nowhere.
function reroute(mv) {
    // Re-route each contract until it is genuinely satisfied.
    //
    // A contract is not "some cell of the net still touches the pin" —
    // absorbing and trimming can SPLIT a net, and the piece left touching
    // the pin is often not the piece carrying the net's source or pad.
    // (That is exactly how a rotation could drop a connection while
    // reporting success: the far half was then orphaned, and the shrink
    // pass, quite correctly, saw wire joining nothing to nothing.) So the
    // test is reachability: every terminal the net had must end up in one
    // piece with the object's node, and anything still adrift is routed
    // in, one piece at a time.
    mv.unrouted = 0;
    const volatileCells = new Set();
    for (const comp of mv.components.values()) for (const ci of comp.cells) volatileCells.add(ci);
    // Everything reachable from a set of cells through wire (a crossover
    // passes straight through): the wire covered, and the non-wire
    // connecting cells touched at the edges.
    //
    // Out of a start cell only through the faces it really connects on.
    // A mux pin has one lead; a wire running past its package on another
    // face is some other net, and flooding into it made that net part of
    // this one — the router then took touching it as fine, and laid a
    // cell against it that shorted the two. On a tight board, wires run
    // against muxes' dead faces everywhere.
    const floodFrom = (startIdxs) => {
        const wires = new Set(), touched = new Set(), seen = new Set(), stack = [];
        for (const si of startIdxs) {
            const sx = si % B.w, sy = (si - sx) / B.w;
            for (const [dx2, dy2] of DIRS)
                if (cellConnects(sx, sy, [dx2, dy2])) stack.push([sx + dx2, sy + dy2, dx2, dy2]);
        }
        while (stack.length) {
            const [x, y, dx2, dy2] = stack.pop();
            if (!inBounds(x, y)) continue;
            const i = idx(x, y);
            if (!isWireId(B.cells[i]) || B.blockAt[i]) { if (cellConnects(x, y, [-dx2, -dy2])) touched.add(i); continue; }
            if (mv.xo(x, y)) {
                const k = i + (dx2 !== 0 ? 'h' : 'v');
                if (seen.has(k)) continue;
                seen.add(k);
                stack.push([x + dx2, y + dy2, dx2, dy2]);
                continue;
            }
            if (seen.has(i)) continue;
            seen.add(i);
            wires.add(i);
            for (const [a2, b2] of DIRS) stack.push([x + a2, y + b2, a2, b2]);
        }
        return { wires, touched };
    };
    // One pass at a contract, laying whatever routes it needs. Returns the
    // pair it could not join, or null when everything got through.
    const attemptContract = (c) => {
        const comp = mv.components.get(c.compKey);
        // What has to end up joined to the object's node. A net with no
        // terminals at all (wire dead-ending on the object) just has to
        // stay attached, so its own surviving cells stand in.
        for (let guard = 0; guard < 8; guard++) {
            const at = floodFrom([...c.targets]);
            // What has to end up joined to the object's node: every
            // terminal the net had. A comp that IS a pad or pin, with no
            // wire of its own, joins via its own cells; a wire net with
            // no terminals just has to stay attached, so one of its cells
            // stands in. (Testing a pad against the wire set alone marks
            // it adrift even when it is flush against the pin, and lays a
            // second route beside the connection that already exists.)
            const mustJoin = comp.terminals.size ? [...comp.terminals]
                : [...comp.cells].filter((ci) => !isWireId(B.cells[ci]));
            if (!mustJoin.length && comp.cells.size) mustJoin.push([...comp.cells][0]);
            // By NODE, not by cell. A pad is one terminal however many
            // cells it spans, so reaching any one of them settles all of
            // them — asking cell by cell had a 3x3 switch demand four
            // separate routes, three of which were laid around the back
            // of it and then left dangling because nothing needed them.
            const keyOf = (ci) => anchorNode(ci % B.w, Math.floor(ci / B.w)).key;
            const had = new Set([...at.touched].map(keyOf));
            const want = mustJoin.filter((t) =>
                !at.touched.has(t) && !at.wires.has(t) && !had.has(keyOf(t)));
            if (!want.length) break;
            const from = want[0];
            const island = floodFrom([from]);
            const seeds = [...island.wires, from].filter((ci) => !mv.xo(ci % B.w, Math.floor(ci / B.w)));
            const targetCells = new Set([...at.wires, ...c.targets]);
            let path = routeNet(seeds, targetCells, new Set(seeds), comp.terminals, volatileCells);
            // A route is only worth taking if it looks like the connection
            // it replaces. On a tight board the shortest LEGAL path can be
            // a lap of the whole layout — a path may not run flush beside
            // anything, so it detours around every net it meets — and
            // snaking twenty cells to rejoin something two away is not
            // what the user asked for by dragging a part. Past that, the
            // honest answer is a dashed link: the connection is owed, and
            // they can draw it where they actually want it.
            if (path && path.length > ROUTE_SLACK + ROUTE_STRETCH * pathSpan(path)) path = null;
            // Which two things this contract failed to join. The immediate
            // contact next door is often still touching — what got
            // orphaned is the terminal at the far end of the net, which is
            // what the dashed line has to point at.
            if (!path) return [from, [...c.targets][0]];
            for (const [px, py] of path) {
                B.cells[idx(px, py)] = makeConductor(OFF);
                comp.routed.add(idx(px, py));
            }
        }
        return null;
    };

    // Re-routing has so far only ever ADDED wire: it keeps whatever the
    // net already had and looks for a corridor from there to the part's
    // new position. On a board with any density that fails constantly —
    // the run that used to reach the pin is now in the way of the run that
    // needs to reach it, and the only path left is a lap of the layout.
    //
    // So when a contract can't be met as it stands, the net's own wire is
    // fair game: rip it up and lay the connection again from the terminal.
    // The user drew a wire to say "these two are joined", not to say
    // "these particular cells are wire", and moving a run they can see is
    // far less surprising than a dashed line saying it gave up. What is
    // NOT fair game is anything that holds meaning of its own — the
    // terminals, the object's own cells, another net's route, and stubs
    // that were already dangling before the move (drawn on purpose).
    //
    // All or nothing: if the re-lay does not fully satisfy the contract,
    // the board goes back exactly as it was and the connection is owed
    // instead. A half-ripped net is worse than either outcome.
    const ripAndRelay = (c) => {
        const comp = mv.components.get(c.compKey);
        const spared = new Set([...comp.terminals, ...(comp.preDangling || []), ...mv.movedSet]);
        const rip = [...comp.cells].filter((ci) => isWireId(B.cells[ci]) && !spared.has(ci));
        if (!rip.length) return null;
        const before = B.cells.slice();
        const beforeCells = new Set(comp.cells), beforeRouted = new Set(comp.routed);
        // Deliberately no recomputeRoles here: the roles belong to the
        // object as PLACED. Only `cells` changes, which is all routeNet
        // reads for free space.
        for (const ci of rip) { B.cells[ci] = ID_INSULATOR_PLAIN; comp.cells.delete(ci); }
        const failed = attemptContract(c);
        if (!failed) return null;
        B.cells.set(before);
        comp.cells = beforeCells;
        comp.routed = beforeRouted;
        return failed;
    };

    // The player's own loops — thick wire, a ring — stand or go whole.
    // Pruning takes out wire nothing needs, and a loop always has some
    // to spare: it thinned a blob drawn on purpose, far from anything
    // that moved, a cell here and a cell there. So a loop of wire that
    // was there before the move, and is still all there, is kept whole
    // if any of it is kept, and goes whole only if all of it would (a
    // blob at the end of a run to where the part was). One the move
    // broke open is no loop any more, and one a route closed is not
    // the player's: both are pruned as before.
    const keepLoops = (removed) => {
        const out = new Set(removed);
        const old = new Set();
        for (let i = 0; i < B.cells.length; i++)
            if (isWireId(B.cells[i]) && isWireId(mv.savedCells[i]) && !mv.movedSet.has(i) && !B.blockAt[i]) old.add(i);
        for (const comp of mv.components.values()) for (const ci of comp.routed) old.delete(ci);
        for (const loop of loopsIn(old)) {
            if (loop.every((ci) => out.has(ci))) continue;
            for (const ci of loop) out.delete(ci);
        }
        return out;
    };

    // Before routing to the part, clear what of the net now leads
    // nowhere — the run that went to where the part WAS, past whatever
    // still needs it. Left standing, it got in its own net's way (a
    // route may not run alongside its own wire), the route went the
    // long way round it, and it was then left as a stub with the detour
    // beside it.
    const clearDeadRuns = (c) => {
        const comp = mv.components.get(c.compKey);
        if (!comp.isNet) return false;
        const wire = [...comp.cells].filter((ci) => isWireId(B.cells[ci]) && !mv.movedSet.has(ci));
        if (!wire.length) return false;
        const keep = new Set([...(comp.preDangling || []), ...mv.keptBehind]);
        const dead = [...keepLoops(reduceNet(new Set(wire), new Set(comp.terminals), keep, mv.nodeIdFor(mv.nodeOfMoved)))]
            .filter((ci) => isWireId(B.cells[ci]));
        if (!dead.length) return false;
        for (const ci of dead) { B.cells[ci] = ID_INSULATOR_PLAIN; comp.cells.delete(ci); }
        return true;
    };
    // Both ways are tried — from what of the net is left, as always, and
    // with its dead runs cleared first — and the one that lays less new
    // wire is kept (the usual one on a tie, so the player's own wire is
    // kept wherever it serves).
    const runContract = (c) => {
        const comp = mv.components.get(c.compKey);
        const snap = () => ({ cells: B.cells.slice(), compCells: new Set(comp.cells), routed: new Set(comp.routed) });
        const back = (s0) => { B.cells.set(s0.cells); comp.cells = new Set(s0.compCells); comp.routed = new Set(s0.routed); };
        const start = snap();
        let failed = attemptContract(c);
        const usual = failed ? null : snap();
        back(start);
        let cleared = null;
        if (clearDeadRuns(c) && !attemptContract(c)) cleared = snap();
        const laid = (s0) => s0.routed.size - start.routed.size;
        if (cleared && (!usual || laid(cleared) < laid(usual))) { back(cleared); failed = null; }
        else if (usual) { back(usual); failed = null; }
        else { back(start); failed = attemptContract(c); }
        if (failed) failed = ripAndRelay(c);
        if (failed) { mv.unrouted++; comp.failed = true; mv.owedPairs.push(failed); }
    };

    // Contracts compete for the same free space, so the order they are
    // laid in decides whether they all fit: route the wrong one first and
    // it takes the only corridor another one needed. Rather than commit
    // to one guess, try a few orders and keep the first that gets
    // everything through — most-constrained-first is usually right, but
    // not always, so plain and reversed are tried too.
    const approachRoom = (c) => {
        let n = 0;
        for (const ti of c.targets) {
            const tx = ti % B.w, ty = (ti - tx) / B.w;
            for (const [ax, ay] of DIRS) if (inBounds(tx + ax, ty + ay) && isInsulatorId(B.cells[idx(tx + ax, ty + ay)])) n++;
        }
        return n;
    };
    mv.owedPairs = [];
    const contractList = [...mv.contracts.values()];
    const orders = [
        [...contractList].sort((p, q) => approachRoom(p) - approachRoom(q)),
        contractList,
        [...contractList].reverse(),
    ];
    // Shrink: erase whatever the move left leading nowhere — the tail of
    // a run a component was dragged along, the far end of a wire whose
    // middle got absorbed. Without this a drag "into" a wire strands the
    // old endpoint where it was instead of the wire following the part
    // that moved. The object's own cells and pre-existing dangles are
    // kept, and a net whose contract couldn't be re-routed is left
    // untouched rather than made worse.
    //
    // One pass over ALL the object's nets together rather than one at a
    // time. Two contracts' routes legitimately meet — everything wired to
    // a dragged WIRE ends up on that one node, so the second route can
    // reach the object by joining the first — and a net examined on its
    // own cannot see that: it read as a run joining a pad at one end to
    // nothing at the other, and pruned away a connection the router had
    // genuinely made. Handing reduceNet the union is safe, since it only
    // ever removes and only ever preserves which node reaches which;
    // pieces disjoint on the board stay disjoint here.
    const shrinkNets = () => {
        // Only wire is prunable; a component's own non-wire cells (the
        // pin or pad it stands for) are things the net must stay on.
        const net = new Set(), required = new Set(mv.capableMoved), keep = new Set(mv.movedSet);
        for (const comp of mv.components.values()) {
            if (comp.failed) continue;
            for (const ci of comp.cells) (isWireId(B.cells[ci]) ? net : required).add(ci);
            for (const ci of comp.routed) net.add(ci);
            for (const t of comp.terminals) required.add(t);
            for (const ci of comp.preDangling || []) keep.add(ci);
        }
        // The stubs left behind as copies (keptBehind) are wire of these
        // nets too: without them a run reaching the part through one
        // read as going nowhere, and was pruned.
        for (const ci of mv.keptBehind) if (isWireId(B.cells[ci])) net.add(ci);
        for (const ci of keepLoops(reduceNet(net, required, keep, mv.nodeIdFor(mv.nodeOfMoved)))) {
            if (!isWireId(B.cells[ci])) continue;
            B.cells[ci] = ID_INSULATOR_PLAIN;
            // Keep the bookkeeping honest: a cell that is gone must not
            // come back as a "required" anchor on a later pass.
            for (const comp of mv.components.values()) { comp.cells.delete(ci); comp.routed.delete(ci); }
        }
    };
    const preRoute = B.cells.slice();
    const preCompCells = new Map([...mv.components].map(([k, c]) => [k, new Set(c.cells)]));
    for (const order of orders) {
        B.cells.set(preRoute);
        for (const [k, comp] of mv.components) {
            comp.routed.clear(); comp.failed = false; comp.cells = new Set(preCompCells.get(k));
        }
        mv.unrouted = 0;
        mv.owedPairs.length = 0;
        for (const c of order) runContract(c);
        if (mv.unrouted) {
            // Second chance. Routes are laid before the shrink, so a
            // contract can fail against wire that is only still there
            // because nothing has cleaned it up yet — the run that led to
            // where the part WAS, lying across the corridor the part now
            // needs. Tidy the nets that did get through (the failed ones
            // are skipped, as always) and retry the rest against the
            // board as it will actually end up.
            shrinkNets();
            const retry = [];
            for (const c of order) {
                const comp = mv.components.get(c.compKey);
                if (!comp.failed) continue;
                comp.failed = false;
                retry.push(c);
            }
            mv.unrouted = 0;
            mv.owedPairs.length = 0;
            for (const c of retry) runContract(c);
        }
        if (!mv.unrouted) break;
    }
    shrinkNets();
    recomputeRoles();
}

// moveObjects, 6 of 8. Hold the finished board to what it was: nothing
// stranded, no part reached into, no edge broken, no mux read differently,
// nothing joined that was apart.
function check(mv) {
    // Litter sweep. The shrink pass above works net by net and leaves a
    // net whose contract failed alone, quite deliberately — but that is
    // exactly the case that strands wire: the far half of a run whose
    // middle the part absorbed, or the remains of a crossing whose other
    // axis moved out from under it, left joined to nothing at either end.
    // Anything the move itself cut adrift goes; anything that was already
    // adrift, and anything the object brought with it, stays.
    {
        const gone = [];
        for (const ci of orphanWire())
            if (!mv.preOrphans.has(ci) && !mv.movedSet.has(ci) && !B.blockAt[ci]) gone.push(ci);
        if (gone.length) {
            for (const ci of gone) B.cells[ci] = ID_INSULATOR_PLAIN;
            recomputeRoles();
        }
    }

    // Nothing here may have reached inside a block that stood still. The
    // walks stop at their pins and the router keeps out, so this should
    // never fire — it is the backstop that keeps a missed case a refused
    // drag instead of a quietly rewired part.
    for (let i = 0; i < B.cells.length; i++)
        if (B.blockAt[i] && !mv.movedSet.has(i) && stripId(B.cells[i]) !== stripId(mv.savedCells[i])) return mv.reject('block');
    // Nor may anything end up on a part's kept-bare edge — the part that
    // moved, or one it moved up against.
    if (ringViolations().length) return mv.reject('edge');

    // Identity is not negotiable the way routing is: a part that ends up
    // reading as something else is not the part you dragged, so that one
    // still refuses outright.
    for (const [before, was] of mv.muxRoleBefore) {
        const moved = mv.newIdxOf.has(before);
        const r = B.roles[moved ? mv.newIdxOf.get(before) : before];
        if (!r || r.kind !== was.kind) return mv.reject('reread');
        // A stationary mux keeps its leads pointing where they were; a
        // moved one turns them with the object.
        const want = was.lead && moved ? mv.turnLead(was.lead, mv.quarterTurns) : was.lead;
        const got = r.lead || null;
        if (!want !== !got) return mv.reject('reread');
        if (want && (want[0] !== got[0] || want[1] !== got[1])) return mv.reject('reread');
    }

    // And nothing joined that was apart. Each step above is meant to
    // keep to that — the trim, the routes, the rip-and-relay, the
    // shrink — but a mistake in any of them is a short the player cannot
    // see until the circuit stops working, so the finished board is held
    // to it directly: every terminal on it (the moved ones by where they
    // came from) with everything it is wired to, against the board
    // before. Connections may be owed (dashed); never invented.
    mv.groupsAfter = terminalGroups((i) => (mv.origOfMoved.has(i) ? mv.origOfMoved.get(i) : i));
    {
        // ...but for the joins the player made, which merge the groups
        // either side of them: anything else joined is a short.
        const startGroup = (k) => (mv.joinedAtStart.has(k) ? mv.joinedAtStart.get(k) : 'alone:' + k);
        const merged = new Map();
        const canon = (g) => { while (merged.has(g)) g = merged.get(g); return g; };
        for (const [k, b] of mv.madeJoins) {
            const kb = mv.startNetOf.get(b);
            if (kb === undefined) continue;     // bare wire with nothing on it: nothing to short
            const ra = canon(String(k).startsWith('drag:') ? k : startGroup(k)), rb = canon(startGroup(kb));
            if (ra !== rb) merged.set(ra, rb);
        }
        // (Even two of the object's own pins: a lead put down on the
        // source at the end of another lead's wire shorts the part, but
        // that is where the player put it, and they can see it. Refusing
        // meant switching to Erase for a cell and back.)
        const after = mv.groupsAfter;
        const wasOf = new Map();
        for (const [t, g] of after) {
            const was = canon(mv.joinedAtStart.has(t) ? mv.joinedAtStart.get(t) : 'alone:' + t);
            if (!wasOf.has(g)) wasOf.set(g, was);
            else if (wasOf.get(g) !== was) return mv.reject('short');
        }
    }
}

// moveObjects, 7 of 8. What could not be kept is owed: one dashed link per
// pair of nets.
function oweLinks(mv) {
    // Every connection the object had, re-checked against the finished
    // board rather than taken on trust from the router's own count. That
    // count only knows about routes it was asked for and failed; it says
    // nothing about a connection lost to the shrink pass or to a contact
    // that looked already-satisfied. Whatever did not survive is owed,
    // and becomes a dashed line instead of vanishing silently.
    mv.owed = new Map();
    // ONE dashed line per pair of NETS, not per pair of cells.
    //
    // The same broken connection gets named several different ways. The
    // router reports the mux pin it could not reach while the terminal
    // re-check reports the stub soldered onto that pin and dragged along
    // with it. A net that runs alongside the object touches it at every
    // cell it passes, so it is recorded as that many contacts. And when a
    // drag takes a mux together with the wire feeding it, a switch at the
    // far end was joined to BOTH — one connection through two of the
    // object's nodes, which came out as two dashed lines fanning off the
    // same switch.
    //
    // So a link is filed under the two nets its ends sit on, each named
    // by its lowest cell index. Whatever else is on those nets, they owe
    // each other exactly one connection.
    const netKey = wireNetKey;
    // `a`/`b` are cells of the board before the move, unless `placed`:
    // the router's own failures name cells where the object now is, and
    // mapping those again sent the line wherever that cell had moved to
    // — on a one-cell drag, often a different pin of the same part.
    const oweLink = (a, b, keep, placed) => {
        if (a === undefined || b === undefined) return;
        const a2 = !placed && mv.newIdxOf.has(a) ? mv.newIdxOf.get(a) : a;
        const b2 = !placed && mv.newIdxOf.has(b) ? mv.newIdxOf.get(b) : b;
        if (a2 === b2 || netReaches(a2, b2)) return false;
        const ax = a2 % B.w, ay = (a2 - ax) / B.w;
        const bx = b2 % B.w, by = (b2 - bx) / B.w;
        if (!cellConnects(ax, ay) || !cellConnects(bx, by)) return false; // an end was erased
        const ka = netKey(a2), kb = netKey(b2);
        if (ka === kb) return false;                                      // one net, already joined
        const k = Math.min(ka, kb) + ':' + Math.max(ka, kb);
        if (keep && mv.owed.has(k)) return true;
        mv.owed.set(k, [a2, b2]);
        return true;
    };
    // What the router itself reported it could not join, re-checked in
    // case another contract's path happened to satisfy it anyway.
    for (const [a, b] of mv.owedPairs) oweLink(a, b, false, true);
    // ...and every terminal each contact was attached to, once per
    // (pre-move net, terminal). Several contacts on one net are one
    // connection however the move pulled its ends apart.
    const claimed = new Set();
    for (const ct of mv.contactTerminals) {
        if (!mv.newIdxOf.has(ct.objCell)) continue;
        for (const t0 of ct.terminals) {
            const k = ct.netKey + '#' + t0;
            if (claimed.has(k)) continue;
            if (oweLink(ct.objCell, t0)) claimed.add(k);
        }
    }
    // ...and whatever else came apart: wire the object overwrote or cut
    // back from its leads, or any connection lost some other way. Every
    // group of terminals wired together before that is now in pieces
    // owes a link between them.
    // Pieces a dashed line already joins (the object's own, filed above)
    // are not owed twice.
    {
        const termCell = (t) => +t.slice(1);
        const termAt = new Map();          // board cell -> terminal id, after
        for (const t of mv.groupsAfter.keys()) {
            const c = termCell(t);
            termAt.set(mv.newIdxOf.has(c) ? mv.newIdxOf.get(c) : c, t);
        }
        // The group an owed link's end is in: its own, for a terminal;
        // for a wire, that of a terminal on its net.
        const groupOfCell = (i) => {
            if (termAt.has(i)) return mv.groupsAfter.get(termAt.get(i));
            const x = i % B.w, y = (i - x) / B.w, id = B.cells[i];
            // Any cell of a pad stands for the pad, which is filed under
            // its lowest cell (see terminalGroups).
            if (isLed(id) || isSwitch(id) || isToggle(id)) {
                let min = Infinity;
                for (const c of anchorNode(x, y).cells) min = Math.min(min, mv.origOfMoved.has(c) ? mv.origOfMoved.get(c) : c);
                return mv.groupsAfter.has('p' + min) ? mv.groupsAfter.get('p' + min) : null;
            }
            if (!isWireId(id)) return null;
            for (const ti of floodNet(x, y, 0, 0).terminals)
                if (termAt.has(ti)) return mv.groupsAfter.get(termAt.get(ti));
            return null;
        };
        const linked = new Map();
        const find = (a) => { while (linked.has(a) && linked.get(a) !== a) a = linked.get(a); return a; };
        const join = (a, b) => { if (a !== null && b !== null) linked.set(find(a), find(b)); };
        for (const [a, b] of mv.owed.values()) join(groupOfCell(a), groupOfCell(b));
        const pieces = new Map();
        for (const [t, g] of mv.groupsAfter) {
            const was = mv.joinedAtStart.get(t);
            if (was === undefined) continue;
            if (!pieces.has(was)) pieces.set(was, new Map());
            if (!pieces.get(was).has(g)) pieces.get(was).set(g, t);
        }
        for (const m of pieces.values()) {
            const groups = [...m.keys()], reps = [...m.values()];
            for (let k = 1; k < reps.length; k++) {
                if (find(groups[0]) === find(groups[k])) continue;
                if (oweLink(termCell(reps[0]), termCell(reps[k]), true)) join(groups[0], groups[k]);
            }
        }
    }
    for (const link of mv.owed.values()) B.pendingLinks.push(link);
}

// moveObjects, 8 of 8. The result.
function finish(mv) {
    const out = [];
    let at = 0;
    for (const o of mv.objectList) { out.push({ cells: mv.moved.slice(at, at + o.cells.length) }); at += o.cells.length; }
    return { ok: true, objects: out, cells: mv.moved, unrouted: mv.unrouted, pending: [...mv.owed.values()].length };
}

export {
    flood8, macroFootprint, leadsFacing, wireSegmentAt, objectAt, transformObjectCells, moveObject,
    moveObjects,
};
