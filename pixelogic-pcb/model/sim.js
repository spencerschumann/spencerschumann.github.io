// The tick (stepSimulation): the board as a netlist (netlist.js) of wires
// and the muxes' contacts between them. A wire is filled at once — a net,
// and every net a contact joins to it, is +V's (1) or −V's (0) the moment
// either drives it — or, driven by nothing, floating (Z). A contact takes
// a tick to move: each mux's sits where its control's net was a tick ago —
// on NO for a 1, NC for a 0, and on neither, open, for a Z. +V and −V
// joined is a short, and trips the breaker: the board stands still until
// it is reset (an edit, a pad pressed or turned, resetCharges).
//
// Nothing on a net remembers anything: what a circuit holds, it holds in
// where its contacts sit, driven round a loop through a control. So the
// state of the board is its cells — the values the last tick wrote into
// them, the contacts in the switch cells, the input pads — and copying
// the cells copies it (copyCells, setCharges).
//
// Also: putting the board back at rest (resetCharges) or every contact
// over (primeCharges), and what a probe on a cell reads (chargeAt).

import {
    DIRS, DRAIN, ID_SWITCH_OFF, ID_TOGGLE_OFF, MK_C, MK_M, MK_NC, MK_NO, MK_O, MK_X, OFF, ON, SEL_NC,
    SEL_NO, Z, combineCharge, conductorCharge, isConductorId, isLed, isMuxId, isPosSource, isSource, isSwitch,
    isToggle, isXover,
    ledCharge, makeConductor, makeLed, makeMuxC, makeMuxM, makeMuxNC, makeMuxNO, makeMuxO, makeXover, muxAuxOf,
    muxChOf, muxDirOf, muxKindOf, switchIsPressed, toggleIsOn, xoverH, xoverV,
} from './cells.js';
import {
    B, boardLent, idx, inBounds,
} from './board.js';
import {
    netlistOf,
} from './netlist.js';
import {
    cellConnects,
} from './blocks.js';

// Where a contact is: on NO, on NC, or open (its control floating).
const C_NO = 0, C_NC = 1, C_OPEN = 2;

// What a mux's control read when the nets were last filled — kept in the
// mux's own cells, the control's on (a 1) and the NO pin's mark (a Z), so
// it is the board's like the rest of its state. Read from there, and not
// off the net as it is now, so a pad pressed since moves a contact a tick
// later wherever it is, right against the control or a wire away.
function selWas(N, m) {
    if (muxAuxOf[B.cells[N.muxC[m]]]) return ON;
    return muxAuxOf[B.cells[N.muxNoCell[m]]] ? Z : OFF;
}

// The nets joined by the contacts where they are (N.contact), what drives
// each lot, and so every net's value — written into the cells. A lot both
// +V and −V drive is a short: the breaker trips, and its cells are kept
// (B.trip.cells) to show where.
function resolve(N) {
    const { nets, parent, pos, neg, value, contact } = N;
    for (let k = 0; k < nets; k++) parent[k] = k;
    const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
    for (let m = 0; m < N.muxes; m++) {
        const c = contact[m], com = N.muxCom[m], pin = c === C_NO ? N.muxNo[m] : c === C_NC ? N.muxNc[m] : -1;
        if (com < 0 || pin < 0) continue;
        const a = find(com), b = find(pin);
        if (a !== b) parent[b] = a;
    }
    pos.fill(0);
    neg.fill(0);
    for (let k = 0; k < nets; k++) {
        const r = find(k);
        if (N.netPos[k]) pos[r] = 1;
        if (N.netNeg[k]) neg[r] = 1;
        for (let p = N.netPadStart[k]; p < N.netPadStart[k + 1]; p++) {
            const id = B.cells[N.netPads[p]];
            if (toggleIsOn(id) || switchIsPressed(id)) pos[r] = 1; else neg[r] = 1;
        }
    }
    let shorted = null;
    for (let k = 0; k < nets; k++) {
        const r = find(k);
        if (pos[r] && neg[r]) { value[k] = Z; (shorted || (shorted = [])).push(k); } else value[k] = pos[r] ? ON : neg[r] ? OFF : Z;
    }
    // Into the cells: each net's sites (a driver's cell is left as it is).
    const cells = B.cells;
    for (let k = 0; k < nets; k++) {
        const v = value[k];
        for (let q = N.netSiteStart[k]; q < N.netSiteStart[k + 1]; q++) {
            const s = N.netSites[q], i = N.siteCell[s], id = cells[i];
            if (isConductorId(id)) { if (conductorCharge(id) !== v) cells[i] = makeConductor(v); }
            else if (isXover(id)) cells[i] = N.siteAxis[s] ? makeXover(xoverV(id), v) : makeXover(v, xoverH(id));
            else if (isMuxId(id)) {
                const d = muxDirOf[id], kd = muxKindOf[id];
                if (kd === MK_O) cells[i] = makeMuxO(d, v);
                else if (kd === MK_NO) cells[i] = makeMuxNO(d, v, false);
                else if (kd === MK_NC) cells[i] = makeMuxNC(d, v);
            }
        }
    }
    // Each mux's switch: where its contact is — and, closed, what COM has;
    // what its control reads now (see selWas): on for a 1, and the NO pin
    // marked for a Z.
    for (let m = 0; m < N.muxes; m++) {
        const mi = N.muxM[m], mid = cells[mi], c = contact[m];
        const com = N.muxCom[m] >= 0 ? value[N.muxCom[m]] : Z;
        cells[mi] = c === C_OPEN ? makeMuxM(muxDirOf[mid], DRAIN, muxAuxOf[mid]) : makeMuxM(muxDirOf[mid], com, c === C_NO ? SEL_NO : SEL_NC);
        const ci = N.muxC[m], ni = N.muxNoCell[m], sel = N.muxSel[m] >= 0 ? value[N.muxSel[m]] : Z;
        cells[ci] = makeMuxC(muxDirOf[cells[ci]], sel === ON);
        cells[ni] = makeMuxNO(muxDirOf[cells[ni]], muxChOf[cells[ni]], sel === Z);
    }
    // Lamps: lit by any net round them that is 1; dark on a 0; and floating
    // where all of them are.
    for (let l = 0; l < N.leds; l++) {
        let v = Z;
        for (let q = N.ledNetStart[l]; q < N.ledNetStart[l + 1] && v !== ON; q++) {
            const nv = value[N.ledNetList[q]];
            if (nv === ON) v = ON; else if (nv === OFF) v = OFF;
        }
        for (let q = N.ledCellStart[l]; q < N.ledCellStart[l + 1]; q++) cells[N.ledCellList[q]] = makeLed(v);
    }
    if (shorted) {
        const at = [], sites = [];
        for (const k of shorted)
            for (let q = N.netSiteStart[k]; q < N.netSiteStart[k + 1]; q++) { sites.push(N.netSites[q]); at.push(N.siteCell[N.netSites[q]]); }
        B.trip = { tick: B.tickCount, cells: at, sites };
    }
}

// The netlist, compiled again after an edit (netlistOf, which resets the
// breaker). An edit made with the breaker tripped fills the nets again
// there and then, from where the contacts are: wired so it no longer
// shorts, the board shows it at once, running or not; still shorted, it
// trips again.
function netNow() {
    const wasTripped = !!B.trip, was = B.netlist, N = netlistOf();
    if (N !== was && wasTripped) {
        for (let m = 0; m < N.muxes; m++) {
            const mid = B.cells[N.muxM[m]];
            N.contact[m] = muxChOf[mid] === DRAIN ? C_OPEN : muxAuxOf[mid] === SEL_NO ? C_NO : C_NC;
        }
        resolve(N);
    }
    return N;
}

// One tick: each contact moves to where its control's net was (as the
// last tick left it), and the nets are filled again. The board as it was
// is left in nextCells, for whoever wants to know whether anything moved.
// A tripped breaker holds everything still.
function stepSimulation() {
    const N = netNow();
    B.nextCells.set(B.cells);
    if (!B.trip) {
        for (let m = 0; m < N.muxes; m++) {
            const v = selWas(N, m);
            N.contact[m] = v === ON ? C_NO : v === OFF ? C_NC : C_OPEN;
        }
        resolve(N);
    }
    B.tickCount++;
    if (tickWatcher && !boardLent()) tickWatcher();
}

// Told of every tick of the board being worked on — however it is stepped:
// running, the Step button, a Verify replay — and of none on a board lent
// for a while (a copy being verified). The scope's probes sample here.
let tickWatcher = null;
function watchTicks(fn) { tickWatcher = fn || null; }

// What a probe clipped to (x, y) reads: 1, 0, or 2 floating; null where
// there is nothing to read (bare board, a mux's plastic). A switch reads
// as it drives, a source as its rail, a crossing as either of its wires.
function chargeAt(x, y) {
    if (!inBounds(x, y)) return null;
    const id = B.cells[idx(x, y)];
    if (isConductorId(id)) return conductorCharge(id);
    if (isXover(id)) return combineCharge(xoverV(id), xoverH(id));
    if (isLed(id)) return ledCharge(id);
    if (isToggle(id)) return toggleIsOn(id) ? ON : OFF;
    if (isSwitch(id)) return switchIsPressed(id) ? ON : OFF;
    if (isSource(id)) return isPosSource(id) ? ON : OFF;
    if (isMuxId(id)) {
        const k = muxKindOf[id];
        if (k === MK_X) return null;
        if (k === MK_C) return muxAuxOf[id] ? ON : OFF;
        if (k === MK_M) return muxChOf[id] === DRAIN ? Z : muxChOf[id];
        return muxChOf[id];
    }
    return null;
}

// The tick count starts over on a reset, a clear or a load. Nothing is
// keyed on it: the board steps the same way whatever its history, which
// the verifier, resetting before every test vector, relies on.
function restartTicks() {
    B.tickCount = 0;
}

// Every contact on one side — NC, where a relay at rest has it, or NO —
// the switches off, and the nets filled from there; the breaker reset.
function startFrom(c) {
    const N = netlistOf();
    for (let i = 0; i < B.cells.length; i++) {
        const id = B.cells[i];
        if (isSwitch(id)) B.cells[i] = ID_SWITCH_OFF;
        else if (isToggle(id)) B.cells[i] = ID_TOGGLE_OFF;
    }
    N.contact.fill(c);
    B.trip = null;
    resolve(N);
    restartTicks();
}
// The board at rest: every contact on NC.
function resetCharges() { startFrom(C_NC); }
// ...and woken the other way: every contact on NO. A circuit that works
// from one and not the other leans on how it woke up (see the verifier).
function primeCharges() { startFrom(C_NO); }

// The breaker: tripped ({tick, cells, sites} where the short is), or null.
// (Asked after an edit, before a tick, it is reset already: see netlistOf.)
const tripped = () => { netNow(); return B.trip; };
function resetBreaker() { B.trip = null; }

// For the view: where current runs, and which way. It runs from what
// drives a 1 — +V, a pad turned on — along the wires and through the
// closed contacts, to what takes it: a lamp, or a mux's control (a relay's
// coil). Current flows only to a load, so only the way to one is given: a
// wire that leads nowhere is 1, and still. In a short, from its +V to its
// −V (`kind` 2; current is 1).
//
// Each source's way out is one tree — a breadth-first walk from it, each
// site reached from the one before that keeps it going straight where it
// can — and the trees are given as chains, runs of sites with nothing
// branching off them: `cells` and `axes` (a crossing's way, as in the
// netlist), in the order current passes them; `s0`, how many steps from
// its source the chain starts; `load`, how many loads it feeds; `toward`,
// the way from its last cell to the load it ends at (a DIRS index, or -1);
// and `kind`. A chain that branches starts again from where it forks, and
// one through a contact starts again on the far side.
function flowField() {
    const N = netNow(), cells = B.cells, w = B.w, S = N.sites;
    const valueOf = (s) => {
        const id = cells[N.siteCell[s]];
        if (isConductorId(id)) return conductorCharge(id);
        if (isXover(id)) return N.siteAxis[s] ? xoverH(id) : xoverV(id);
        if (isMuxId(id)) return muxChOf[id];
        if (isPosSource(id)) return ON;
        if (isToggle(id)) return toggleIsOn(id) ? ON : OFF;
        if (isSwitch(id)) return switchIsPressed(id) ? ON : OFF;
        return OFF;
    };
    const shorted = B.trip && B.trip.sites ? new Uint8Array(S) : null;
    if (shorted) for (const s of B.trip.sites) if (s < S) shorted[s] = 1;
    const isPad = (id) => isToggle(id) || isSwitch(id);
    const drives = (s) => { const id = cells[N.siteCell[s]]; return isPosSource(id) || (isPad(id) && valueOf(s) === ON); };
    // The closed contacts, as edges between sites: COM and the pin it is on.
    const extra = new Map();
    for (let m = 0; m < N.muxes; m++) {
        const mid = cells[N.muxM[m]];
        if (muxKindOf[mid] !== MK_M || muxChOf[mid] === DRAIN) continue;
        const a = N.muxComSite[m], b = muxAuxOf[mid] === SEL_NO ? N.muxNoSite[m] : N.muxNcSite[m];
        if (a < 0 || b < 0) continue;
        (extra.get(a) || extra.set(a, []).get(a)).push(b);
        (extra.get(b) || extra.set(b, []).get(b)).push(a);
    }
    const near = (s, fn) => {
        for (let e = N.siteAdjStart[s]; e < N.siteAdjStart[s + 1]; e++) fn(N.siteAdj[e]);
        const more = extra.get(s);
        if (more) for (const t of more) fn(t);
    };
    // The way from site a's cell to site b's, a DIRS index; -1 if they are
    // not side by side (a contact, across a mux).
    const stepDir = (a, b) => {
        const d = N.siteCell[b] - N.siteCell[a];
        return d === -w ? 0 : d === 1 ? 1 : d === w ? 2 : d === -1 ? 3 : -1;
    };
    const dist = new Int32Array(S).fill(-1), kindOf = new Uint8Array(S), order = [];
    const walk = (k, inSet) => {
        const start = order.length;
        for (let s = 0; s < S; s++) if (dist[s] < 0 && inSet(s) && drives(s)) { dist[s] = 0; kindOf[s] = k; order.push(s); }
        for (let q = start; q < order.length; q++) {
            const s = order[q];
            near(s, (t) => { if (dist[t] < 0 && inSet(t)) { dist[t] = dist[s] + 1; kindOf[t] = k; order.push(t); } });
        }
    };
    if (shorted) walk(2, (s) => shorted[s] === 1);
    walk(1, (s) => (!shorted || !shorted[s]) && valueOf(s) === ON);
    // Each site's parent: one a step nearer its source, the one it carries
    // straight on from if there is one — so a run through thick wire goes
    // straight, and turns once, rather than stepping down the stairs.
    const parent = new Int32Array(S).fill(-1), inDir = new Int8Array(S).fill(-1);
    for (const t of order) {
        if (!dist[t]) continue;
        let best = -1, straight = false;
        near(t, (p) => {
            if (straight || dist[p] !== dist[t] - 1 || kindOf[p] !== kindOf[t]) return;
            const d = stepDir(p, t);
            if (best < 0 || (d >= 0 && d === inDir[p])) { best = p; straight = d >= 0 && d === inDir[p]; }
        });
        parent[t] = best;
        inDir[t] = stepDir(best, t);
    }
    // The loads: a lamp, a mux's control — or, in a short, its −V.
    const toward = new Int8Array(S).fill(-1);
    for (const s of order) {
        const i = N.siteCell[s], id = cells[i], x = i % w, y = (i - x) / w;
        if (kindOf[s] === 2) {
            if ((isSource(id) && !isPosSource(id)) || (isPad(id) && valueOf(s) !== ON)) toward[s] = 4;
            continue;
        }
        for (let d = 0; d < 4 && toward[s] < 0; d++) {
            if (isXover(id) && (d & 1) !== N.siteAxis[s]) continue;
            const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
            if (!inBounds(nx, ny) || !cellConnects(x, y, DIRS[d])) continue;
            const j = idx(nx, ny), nid = cells[j];
            const coil = muxKindOf[nid] === MK_C && muxDirOf[nid] === ((d + 2) & 3) && B.roles[j] && B.roles[j].macro;
            if (isLed(nid) || coil) toward[s] = d;
        }
    }
    // How many loads each site feeds, and which of its children carry any.
    const load = new Int32Array(S), kids = new Int32Array(S), kid = new Int32Array(S).fill(-1);
    for (let q = order.length - 1; q >= 0; q--) {
        const s = order[q];
        if (toward[s] >= 0) load[s]++;
        if (load[s] && parent[s] >= 0) { load[parent[s]] += load[s]; kids[parent[s]]++; kid[parent[s]] = s; }
    }
    const chains = [];
    for (const s of order) {
        const p = parent[s];
        if (!load[s] || (p >= 0 && kids[p] === 1 && inDir[s] >= 0)) continue;
        const list = p >= 0 && inDir[s] >= 0 ? [p] : [];
        let c = s;
        for (;;) {
            list.push(c);
            if (kids[c] !== 1 || inDir[kid[c]] < 0) break;
            c = kid[c];
        }
        chains.push({
            kind: kindOf[s], load: load[s], s0: dist[list[0]],
            cells: list.map((t) => N.siteCell[t]), axes: list.map((t) => N.siteAxis[t]),
            toward: kids[c] ? -1 : toward[c] === 4 ? -1 : toward[c],
        });
    }
    return { chains };
}

export {
    stepSimulation, restartTicks, resetCharges, primeCharges, watchTicks, chargeAt, tripped, resetBreaker, flowField,
};
