// The tick: every cell's next byte from its own and its neighbours'
// (stepSimulation), putting the charge back to rest (resetCharges), and
// what a probe on a cell reads (chargeAt).

import {
    DIRS, DRAIN, FALLING, ID_INSULATOR_PLAIN, ID_NEG, ID_POS, ID_SWITCH_OFF, ID_TOGGLE_OFF, MK_C, MK_M,
    MK_NC, MK_NO, MK_O, MK_X, NEIGHBORS_8, muxCharge, OFF, ON, SEL_NC, SEL_NO, combineCharge, conductorCharge, isConductorId,
    isLed, isMuxId, isSwitch, isToggle, isXover, ledCharge, makeConductor, makeLed, makeMuxC, makeMuxM,
    makeMuxNC, makeMuxNO, makeMuxO, makeXover, muxAuxOf, muxChOf, muxDirOf, muxKindOf, nextCharge,
    nextChargeN, restMuxId, chargedMuxId, switchIsPressed, toggleIsOn, xoverH, xoverV,
} from './cells.js';
import {
    B, boardLent, getCell, idx, inBounds,
} from './board.js';
import {
    recomputeRoles,
} from './edit.js';

// ===== Generic charge contribution (what a cell reports to a neighbor) =====
// What the cell at (x, y) puts out of its face `face` (a DIRS index: the
// way from it to whoever is asking).
function contribCharge(x, y, face) {
    if (!inBounds(x, y)) return OFF;
    const id = B.cells[idx(x, y)];
    if (isConductorId(id)) return conductorCharge(id);
    // A crossover reports its vertical charge to N/S queries and its
    // horizontal charge to E/W queries, keeping the two axes separate.
    if (isXover(id)) return face === 0 || face === 2 ? xoverV(id) : xoverH(id);
    if (id === ID_POS) return ON;
    if (id === ID_NEG) return FALLING;
    // Switch (momentary) and toggle (latching) both drive +V when on and
    // pull down (-V) when off.
    if (isSwitch(id)) return switchIsPressed(id) ? ON : FALLING;
    if (isToggle(id)) return toggleIsOn(id) ? ON : FALLING;
    if (isLed(id)) return OFF; // output sink, never drives
    // A mux cell puts its charge out through its lead and nowhere else —
    // so a wire laid against the package's plain side reads nothing
    // through the plastic — and its control (an input) never drives
    // its own select line.
    if (isMuxId(id)) {
        const k = muxKindOf[id];
        return (k === MK_O || k === MK_NO || k === MK_NC) && face === muxDirOf[id] ? muxChOf[id] : OFF;
    }
    return OFF;
}

// ===== Per-cell-kind next-state =====
// A plain conductor is one node taking charge from all four sides; a
// crossover (a cell of its own) keeps N<->S and E<->W apart, each with its
// own charge.
function nextConductor(x, y, id) {
    const n = contribCharge(x, y - 1, 2);
    const e = contribCharge(x + 1, y, 3);
    const s = contribCharge(x, y + 1, 0);
    const w = contribCharge(x - 1, y, 1);
    if (isXover(id)) return makeXover(nextCharge(xoverV(id), n, OFF, s, OFF), nextCharge(xoverH(id), OFF, e, OFF, w));
    return makeConductor(nextCharge(conductorCharge(id), n, e, s, w));
}

// ===== The mux, cell by cell =====
//
// Each mux cell's next state from its own byte and its four neighbours'
// — the rule a GPU would run. M is the switch: it joins O to whichever
// pin the control picks. The control reaches it by way of the NO pin,
// which carries a copy of C's state along with its own charge, so a
// control change takes three ticks to switch the mux (C, NO, M) and a
// signal three to cross it (pin, M, COM): a tick or two more than the
// old whole-mux update, the price of every cell being local.
//
// On the tick M switches, it joins neither pin. Leaving a charged pin for
// one that is not, it drains COM (falling toward O) rather than leave it
// latched on; onto a charged pin it simply carries on, which is what lets
// a latch's feedback hold when its enable drops. (Both as the old
// whole-mux update did it.)
function muxNeighbour(x, y, d) {
    const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
    return inBounds(nx, ny) ? B.cells[idx(nx, ny)] : ID_INSULATOR_PLAIN;
}
function nextMuxCell(x, y, id) {
    const k = muxKindOf[id], d = muxDirOf[id];
    const lead = () => contribCharge(x + DIRS[d][0], y + DIRS[d][1], (d + 2) & 3);
    switch (k) {
        case MK_C: return makeMuxC(d, lead() === ON);
        case MK_O: {
            const m = muxNeighbour(x, y, (d + 2) & 3);
            const fromM = muxKindOf[m] === MK_M ? (muxChOf[m] === DRAIN ? FALLING : muxChOf[m]) : OFF;
            return makeMuxO(d, nextCharge(muxChOf[id], lead(), fromM, OFF, OFF));
        }
        case MK_NO: case MK_NC: {
            // Its switch is the side neighbour of kind M facing the same
            // way as this pin's C (opposite its lead) — so another mux's
            // switch beside it is never taken for its own.
            const toC = (d + 2) & 3, want = k === MK_NO ? SEL_NO : SEL_NC;
            let fromM = OFF;
            for (const sd of [(d + 1) & 3, (d + 3) & 3]) {
                const m = muxNeighbour(x, y, sd);
                if (muxKindOf[m] === MK_M && muxDirOf[m] === toC && muxAuxOf[m] === want && muxChOf[m] !== DRAIN) fromM = muxChOf[m];
            }
            const ch = nextCharge(muxChOf[id], lead(), fromM, OFF, OFF);
            if (k === MK_NC) return makeMuxNC(d, ch);
            const c = muxNeighbour(x, y, toC);
            return makeMuxNO(d, ch, muxKindOf[c] === MK_C && muxAuxOf[c] === 1);
        }
        case MK_M: {
            const o = muxNeighbour(x, y, d);
            let no = 0, nc = 0;
            for (const sd of [(d + 1) & 3, (d + 3) & 3]) {
                const p = muxNeighbour(x, y, sd);
                if (muxKindOf[p] === MK_NO) no = p;
                if (muxKindOf[p] === MK_NC) nc = p;
            }
            const sel = muxAuxOf[id], ch = muxChOf[id];
            const want = no && muxAuxOf[no] ? SEL_NO : SEL_NC;
            const pinCh = (w) => { const p = w === SEL_NO ? no : nc; return p ? muxChOf[p] : OFF; };
            if (want !== sel) return makeMuxM(d, pinCh(want) === ON ? ON : ch === ON ? DRAIN : OFF, want);
            const oc = muxKindOf[o] === MK_O ? muxChOf[o] : OFF;
            return makeMuxM(d, nextCharge(ch === DRAIN ? FALLING : ch, oc, pinCh(sel), OFF, OFF), sel);
        }
        default: return id;   // X: plain body
    }
}

// Output LED. A pure sink (contribCharge returns OFF, so it never loads a
// wire), but LED cells spread charge to each other over the 8-neighborhood
// so a multi-cell pad lights and drains as one square. External drive is
// read from orthogonal non-LED neighbors (wires/sources/mux) as usual; the
// 3-state charge lets a pad drain when its driver falls instead of latching.
function nextLed(x, y, id) {
    const inputs = [];
    for (const [dx, dy] of NEIGHBORS_8) {
        const nid = getCell(x + dx, y + dy);
        if (isLed(nid)) inputs.push(ledCharge(nid));
    }
    const n = getCell(x, y - 1), e = getCell(x + 1, y), s = getCell(x, y + 1), w = getCell(x - 1, y);
    if (!isLed(n)) inputs.push(contribCharge(x, y - 1, 2));
    if (!isLed(e)) inputs.push(contribCharge(x + 1, y, 3));
    if (!isLed(s)) inputs.push(contribCharge(x, y + 1, 0));
    if (!isLed(w)) inputs.push(contribCharge(x - 1, y, 1));
    return makeLed(nextChargeN(ledCharge(id), inputs));
}

function nextState(x, y) {
    const id = B.cells[idx(x, y)];
    if (isConductorId(id) || isXover(id)) return nextConductor(x, y, id);
    if (id === ID_POS || id === ID_NEG || isSwitch(id) || isToggle(id)) return id; // fixed / set by interaction
    if (isLed(id)) return nextLed(x, y, id);
    if (isMuxId(id)) return nextMuxCell(x, y, id);
    return id; // insulator (inert)
}

// A tick asks nextState only of cells that could change. A cell's next
// state is a function of itself and the eight round it (the widest any
// rule reads, a lamp's), so a cell that the last tick did not change, with
// none round it changed either, comes out as it went in. What could have
// changed is known from what the last tick left (`stepped`) and what it
// started from (still in nextCells, which it swapped out): a cell that
// differs from the one or the other has been changed — by the tick, or by
// an edit since (a switch thrown, a stroke). A board the last tick did not
// leave — new, a copy, resized — gets every cell asked. Bare board never
// changes, and is never asked. (Asking every cell, every tick, was what a
// Verify's and a timing report's time went on.)
function stepSimulation() {
    const cells = B.cells, next = B.nextCells, w = B.w, h = B.h, n = cells.length;
    const out = B.stepped;
    if (out && B.stepRef === cells && B.prevRef === next && B.stepW === w && out.length === n) {
        const need = B.stepNeed;
        need.fill(0);
        for (let i = 0; i < n; i++) {
            if (cells[i] === out[i] && out[i] === next[i]) continue;
            const x = i % w, y = (i - x) / w;
            const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : x, y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : y;
            for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) need[yy * w + xx] = 1;
        }
        for (let i = 0; i < n; i++) {
            const id = cells[i];
            next[i] = need[i] && id !== ID_INSULATOR_PLAIN ? nextState(i % w, (i - i % w) / w) : id;
        }
    } else {
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                next[i] = cells[i] === ID_INSULATOR_PLAIN ? ID_INSULATOR_PLAIN : nextState(x, y);
            }
        B.stepped = new Uint8Array(n);
        B.stepNeed = new Uint8Array(n);
        B.stepW = w;
    }
    const tmp = B.cells; B.cells = B.nextCells; B.nextCells = tmp;
    B.stepped.set(B.cells);
    B.stepRef = B.cells;
    B.prevRef = B.nextCells;
    B.tickCount++;
    if (tickWatcher && !boardLent()) tickWatcher();
}

// Told of every tick of the board being worked on — however it is stepped:
// running, the Step button, a Verify replay — and of none on a board lent
// for a while (a copy being verified). The scope's probes sample here.
let tickWatcher = null;
function watchTicks(fn) { tickWatcher = fn || null; }

// What a probe clipped to (x, y) reads: 1 charged, 0 not, 2 draining; null
// where there is nothing to read (bare board, a mux's plastic). A switch
// reads as it drives, a source as its rail, a crossing as either of its
// wires.
function chargeAt(x, y) {
    if (!inBounds(x, y)) return null;
    const id = B.cells[idx(x, y)];
    if (isConductorId(id)) return conductorCharge(id);
    if (isXover(id)) return combineCharge(xoverV(id), xoverH(id));
    if (isLed(id)) return ledCharge(id);
    if (isToggle(id)) return toggleIsOn(id) ? ON : OFF;
    if (isSwitch(id)) return switchIsPressed(id) ? ON : OFF;
    if (id === ID_POS) return ON;
    if (id === ID_NEG) return OFF;
    if (isMuxId(id)) return muxKindOf[id] === MK_X ? null : muxCharge(id);
    return null;
}

// The tick count starts over on a reset, a clear or a load. Nothing is
// keyed on it — every cell steps by its own local rule, with no per-tick
// cache to go stale — so a board steps the same way whatever its history,
// which the verifier, resetting before every test vector, relies on.
function restartTicks() {
    B.tickCount = 0;
}

function resetCharges() {
    for (let i = 0; i < B.cells.length; i++) {
        const id = B.cells[i];
        if (isXover(id)) B.cells[i] = makeXover(OFF, OFF);
        else if (isConductorId(id)) B.cells[i] = makeConductor(OFF);
        else if (isMuxId(id)) B.cells[i] = restMuxId(id);
        else if (isLed(id)) B.cells[i] = makeLed(OFF);
        else if (isSwitch(id)) B.cells[i] = ID_SWITCH_OFF;
        else if (isToggle(id)) B.cells[i] = ID_TOGGLE_OFF;
    }
    restartTicks();
    recomputeRoles();
}

// A charged start: every wire, lamp and mux cell that holds charge holding
// it, the switches off. What is driven comes out the same from here as
// from rest — a source holds it up, a switch that is off or −V drains it —
// but what nothing drives keeps what it had, since charge only changes
// when something pushes it. So a circuit that only works from rest is
// leaning on something it never drives: a pin left unwired, read as 0
// because it started at 0 (see the verifier).
function primeCharges() {
    for (let i = 0; i < B.cells.length; i++) {
        const id = B.cells[i];
        if (isXover(id)) B.cells[i] = makeXover(ON, ON);
        else if (isConductorId(id)) B.cells[i] = makeConductor(ON);
        else if (isMuxId(id)) B.cells[i] = chargedMuxId(id);
        else if (isLed(id)) B.cells[i] = makeLed(ON);
        else if (isSwitch(id)) B.cells[i] = ID_SWITCH_OFF;
        else if (isToggle(id)) B.cells[i] = ID_TOGGLE_OFF;
    }
    restartTicks();
    recomputeRoles();
}

export {
    contribCharge, nextConductor, muxNeighbour, nextMuxCell, nextLed, nextState, stepSimulation,
    restartTicks, resetCharges, primeCharges, watchTicks, chargeAt,
};
