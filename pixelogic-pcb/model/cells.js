// The cell: what one byte of the board means. Every cell is one byte (an
// id) saying what it is and holding its state — wire and its value, a
// source, a lamp, a switch, a crossing's two values, the six typed cells of
// a mux. No board here, and no rule: only ids and the tables that read
// them. (What the values come to, tick by tick, is sim.js's.)

// ===== Values: 0, 1, and floating =====
const OFF = 0, ON = 1, FALLING = 2;
// Since wires fill at once (sim.js), nothing drains: the third value is a
// net driven by nothing, floating — Z. (FALLING is its old name, from the
// charge model, in which it was a wire draining.)
const Z = FALLING;

// ===== Cell ID space (fits in a Uint8Array) =====
//
// Insulator: 0 (plain only - a bare insulator is inert, and an insulator
//            hole no longer means anything special)
// Conductor: 10-12 (charge 0-2)
// +V: 160-175, -V: 176-191 (160/176 + stubs) - the sources, each soldered
//            on the sides its stubs say (a bit a side, N E S W as DIRS),
//            joined there and nowhere else: a wire may run past one.
//            13 and 14 are the old +V and -V, joined to whatever touched
//            them: they still read, as a source with a stub every side,
//            and a board is rewritten as it is next looked over (see
//            edit.js dropDeadStubs).
// 15-26:     unassigned, and kept that way: circuits saved by older builds
//            use them (21-26 were old-style mux body, read off the wire
//            round it), and an id this build does not define loads as
//            insulator (see isValidId) rather than as whatever might move
//            into the number later.
// Crossover conductor: 27-35 (27 + v*3 + h) - a wire cell that routes its
//            vertical axis (N<->S) independently of its horizontal axis
//            (E<->W), and so holds two charges. A cell of its own: the
//            player makes one (a stroke drawn straight across a wire, or
//            a click on a 4-way), and it stays one, whatever is drawn or
//            erased round it. (It was once read off the shape: any wire
//            with wire all round and running straight through was a
//            crossing — see inferCrossings, which reads old boards so.)
// LED (output): 36-38 (36 + charge) - a pure sink that never drives a wire,
//            but LED cells join each other over the 8-neighborhood so a
//            multi-cell pad lights as one square unit.
// Switch (momentary input): 39 released, 40 pressed - drives like +V while
//            pressed and like -V (pulls down) when released. Pressing floods
//            the whole 8-connected switch pad, so a big button acts as one.
// Toggle (latching input): 41 off, 42 on - same drive as the switch (+V on,
//            -V off), but a click flips and holds instead of press-and-hold.
// Mux cells: 64-152, typed (see "Mux material" below).
const ID_INSULATOR_PLAIN = 0;
const ID_CONDUCTOR_BASE = 10, ID_CONDUCTOR_MAX = 12;
const ID_POS = 13;
const ID_NEG = 14;
const ID_SRC_POS = 160, ID_SRC_NEG = 176, ID_SRC_MAX = 191;
const ID_XOVER_BASE = 27, ID_XOVER_MAX = 35;
const ID_LED_BASE = 36, ID_LED_MAX = 38;
const ID_SWITCH_OFF = 39, ID_SWITCH_ON = 40;
const ID_TOGGLE_OFF = 41, ID_TOGGLE_ON = 42;

function isInsulatorId(id) { return id === ID_INSULATOR_PLAIN; }
// A source: +V or -V, and the sides it is soldered to (its stubs, a
// bit a side as DIRS: 1 north, 2 east, 4 south, 8 west).
function isSource(id) { return id === ID_POS || id === ID_NEG || (id >= ID_SRC_POS && id <= ID_SRC_MAX); }
function isPosSource(id) { return id === ID_POS || (id >= ID_SRC_POS && id < ID_SRC_NEG); }
function sourceStubs(id) { return id === ID_POS || id === ID_NEG ? 15 : id >= ID_SRC_POS && id <= ID_SRC_MAX ? (id - ID_SRC_POS) & 15 : 0; }
function makeSource(pos, stubs) { return (pos ? ID_SRC_POS : ID_SRC_NEG) + (stubs & 15); }
// The same source with its stub way `d` (a DIRS index) on or off.
function withStub(id, d, on) { return makeSource(isPosSource(id), on ? sourceStubs(id) | (1 << d) : sourceStubs(id) & ~(1 << d)); }
// Which DIRS index an offset [dx, dy] is.
function dirIndex([dx, dy]) { return dy < 0 ? 0 : dx > 0 ? 1 : dy > 0 ? 2 : 3; }
function isLed(id) { return id >= ID_LED_BASE && id <= ID_LED_MAX; }
function ledCharge(id) { return id - ID_LED_BASE; }
function makeLed(charge) { return ID_LED_BASE + charge; }
function ledIsOn(id) { return ledCharge(id) === ON; }
function isSwitch(id) { return id === ID_SWITCH_OFF || id === ID_SWITCH_ON; }
function switchIsPressed(id) { return id === ID_SWITCH_ON; }
function isToggle(id) { return id === ID_TOGGLE_OFF || id === ID_TOGGLE_ON; }
function toggleIsOn(id) { return id === ID_TOGGLE_ON; }

// Orthogonal + diagonal offsets (the 8-neighborhood / Moore neighborhood),
// used for pad-internal spreading so pads fill a solid square rather than a
// 4-connected diamond.
const NEIGHBORS_8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]];

function isConductorId(id) { return id >= ID_CONDUCTOR_BASE && id <= ID_CONDUCTOR_MAX; }
function conductorCharge(id) { return id - ID_CONDUCTOR_BASE; }
function makeConductor(charge) { return ID_CONDUCTOR_BASE + charge; }

function isXover(id) { return id >= ID_XOVER_BASE && id <= ID_XOVER_MAX; }
function xoverV(id) { return Math.floor((id - ID_XOVER_BASE) / 3); }
function xoverH(id) { return (id - ID_XOVER_BASE) % 3; }
function makeXover(v, h) { return ID_XOVER_BASE + v * 3 + h; }

// A "wire" is anything a conductor run connects to for the purpose of
// deciding crossovers: a plain conductor or an existing crossover. Sources
// and mux pins are deliberately excluded, so a junction of two wires is a
// crossover but a wire meeting a source/mux stays a normal connection.
function isWireId(id) { return isConductorId(id) || isXover(id); }
function combineCharge(v, h) {
    if (v === ON || h === ON) return ON;
    if (v === FALLING || h === FALLING) return FALLING;
    return OFF;
}


// ---- Mux material ----
//
// Mux cells, 64-152. A mux, lying down with its control at the left:
//
//     C O X     C  the control input, its lead out the short side
//     1 M 2     O  COM, its lead out the long side
//               X  plain body
//               1  NO, the pin on C's side; 2 NC; their leads out the
//                  other long side
//               M  the switch, joining O to one pin
//
// Each cell stores at most one direction — C, O, 1 and 2 their lead's,
// M the way to its O — and finds its partners from that and its
// neighbours' kinds. So a mux means what its cells say whatever lies
// round it, and two can sit flush. What each holds: C whether the
// control read 1 last tick, NO also whether it read Z (see sim.js
// selWas); O, NO and NC their net's value; M its contact — the pin it
// is on (SEL_NO, SEL_NC) and COM's value, or open (DRAIN).
const ID_MUX_C = 64, ID_MUX_O = 72, ID_MUX_X = 84, ID_MUX_NO = 85, ID_MUX_NC = 109, ID_MUX_M = 121;
const MK_C = 1, MK_O = 2, MK_X = 3, MK_NO = 4, MK_NC = 5, MK_M = 6;
// A switch's fourth value: its contact open, on neither pin — its control
// floating. (The name is the charge model's, in which it was the tick a
// switch drained COM.)
const DRAIN = 3;
const SEL_NO = 0, SEL_NC = 1;
const muxKindOf = new Uint8Array(256), muxDirOf = new Uint8Array(256);
const muxChOf = new Uint8Array(256), muxAuxOf = new Uint8Array(256);
function makeMuxC(d, on) { return ID_MUX_C + d * 2 + (on ? 1 : 0); }
function makeMuxO(d, ch) { return ID_MUX_O + d * 3 + ch; }
function makeMuxNO(d, ch, ctl) { return ID_MUX_NO + (d * 3 + ch) * 2 + (ctl ? 1 : 0); }
function makeMuxNC(d, ch) { return ID_MUX_NC + d * 3 + ch; }
function makeMuxM(d, ch, sel) { return ID_MUX_M + (d * 4 + ch) * 2 + sel; }
for (let d = 0; d < 4; d++) {
    for (let on = 0; on < 2; on++) {
        const id = makeMuxC(d, on);
        muxKindOf[id] = MK_C; muxDirOf[id] = d; muxAuxOf[id] = on;
    }
    for (let ch = 0; ch < 3; ch++) {
        let id = makeMuxO(d, ch);
        muxKindOf[id] = MK_O; muxDirOf[id] = d; muxChOf[id] = ch;
        for (let ctl = 0; ctl < 2; ctl++) {
            id = makeMuxNO(d, ch, ctl);
            muxKindOf[id] = MK_NO; muxDirOf[id] = d; muxChOf[id] = ch; muxAuxOf[id] = ctl;
        }
        id = makeMuxNC(d, ch);
        muxKindOf[id] = MK_NC; muxDirOf[id] = d; muxChOf[id] = ch;
    }
    for (let ch = 0; ch < 4; ch++)
        for (let sel = 0; sel < 2; sel++) {
            const id = makeMuxM(d, ch, sel);
            muxKindOf[id] = MK_M; muxDirOf[id] = d; muxChOf[id] = ch; muxAuxOf[id] = sel;
        }
}
muxKindOf[ID_MUX_X] = MK_X;
// (> 0, not !== 0: past the table's 256 a lookup is undefined, which is
// not 0, and every number from 256 up was once a mux.)
function isMuxId(id) { return muxKindOf[id] > 0; }
// A mux cell with a lead: C, O and the pins.
function hasMuxLead(id) { const k = muxKindOf[id]; return k === MK_C || k === MK_O || k === MK_NO || k === MK_NC; }
// Is the cell `nid`, one step the way `d` (a DIRS index) from a wire, an
// arm of it there: a wire, or a mux cell whose lead faces back at it — a
// stub of wire out of the package, drawn as one and meeting it as one.
const leadInto = (nid, d) => hasMuxLead(nid) && muxDirOf[nid] === ((d + 2) & 3);
const armInto = (nid, d) => isWireId(nid) || leadInto(nid, d);
// Is a wire a crossing, from what is round it — `wire(d)`, `arm(d)`: the
// cell one step way d is a wire, an arm? An arm on all four sides, and a
// wire running straight past: wire both sides one way through. Four wires
// are a crossing; so is a mux's lead led straight into a wire running past,
// a wire carrying on out the other side — the player's selector, its COM
// crossing the SEL line on its way to Q. Two leads into a corner of wire
// (an input feeding one mux's pin and another's control) are not: no wire
// runs through there, and they join, as they always did.
const crossingFrom = (wire, arm) => [0, 1, 2, 3].every(arm) && ((wire(0) && wire(2)) || (wire(1) && wire(3)));
// The crossings a board made before they were cells of their own had, by
// the rule it had then (crossingFrom, an arm a wire or a mux's lead facing
// in): every wire cell that rule called a crossing becomes one, and any
// other a plain wire, each keeping its charge. `cells` is w x h, changed in
// place. (Old saves and clips are read through this once; see io.js and
// clips.js.)
function inferCrossings(cells, w, h) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? cells[y * w + x] : ID_INSULATOR_PLAIN);
    const cross = new Uint8Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
        if (!isWireId(cells[i])) continue;
        const x = i % w, y = (i - x) / w;
        const nb = (d) => at(x + DIRS[d][0], y + DIRS[d][1]);
        cross[i] = crossingFrom((d) => isWireId(nb(d)), (d) => armInto(nb(d), d)) ? 1 : 0;
    }
    for (let i = 0; i < cells.length; i++) {
        const id = cells[i];
        if (cross[i] && isConductorId(id)) cells[i] = makeXover(conductorCharge(id), conductorCharge(id));
        else if (!cross[i] && isXover(id)) cells[i] = makeConductor(combineCharge(xoverV(id), xoverH(id)));
    }
}
// The value a mux cell shows: a control's on, a pin's or COM's value,
// the switch's (open shows as floating).
function muxCharge(id) {
    switch (muxKindOf[id]) {
        case MK_C: return muxAuxOf[id] ? ON : OFF;
        case MK_O: case MK_NO: case MK_NC: return muxChOf[id];
        case MK_M: return muxChOf[id] === DRAIN ? FALLING : muxChOf[id];
        default: return OFF;
    }
}
// A mux cell at rest, as it is stored and copied: no value, its contact
// on NC (where a relay at rest has it).
function restMuxId(id) {
    const d = muxDirOf[id];
    switch (muxKindOf[id]) {
        case MK_C: return makeMuxC(d, false);
        case MK_O: return makeMuxO(d, OFF);
        case MK_NO: return makeMuxNO(d, OFF, false);
        case MK_NC: return makeMuxNC(d, OFF);
        case MK_M: return makeMuxM(d, OFF, SEL_NC);
        default: return id;
    }
}
// The same cell turned `turns` quarters clockwise, or mirrored left to
// right: a mux cell's direction goes with it. Nothing else has one.
const MIRROR_DIR = [0, 3, 2, 1];
function withMuxDir(id, d) {
    switch (muxKindOf[id]) {
        case MK_C: return makeMuxC(d, muxAuxOf[id]);
        case MK_O: return makeMuxO(d, muxChOf[id]);
        case MK_NO: return makeMuxNO(d, muxChOf[id], muxAuxOf[id]);
        case MK_NC: return makeMuxNC(d, muxChOf[id]);
        case MK_M: return makeMuxM(d, muxChOf[id], muxAuxOf[id]);
        default: return id;
    }
}
// A source's stubs turn with it, a bit a quarter.
function turnStubs(s, t) { return ((s << t) | (s >> (4 - t))) & 15; }
function rotateId(id, turns) {
    const t = ((turns % 4) + 4) % 4;
    if (isSource(id)) return makeSource(isPosSource(id), turnStubs(sourceStubs(id), t));
    return isMuxId(id) ? withMuxDir(id, (muxDirOf[id] + t) & 3) : id;
}
// For the editor: what a mux cell is ('sel', 'com', 'body', 'no', 'nc',
// 'switch', or null), and which way its lead faces (a DIRS index, or -1).
const MUX_CELL_NAMES = [null, 'sel', 'com', 'body', 'no', 'nc', 'switch'];
function muxCellKind(id) { return MUX_CELL_NAMES[muxKindOf[id]]; }
function muxLead(id) { return hasMuxLead(id) ? muxDirOf[id] : -1; }
function mirrorId(id) {
    if (isSource(id)) { const s = sourceStubs(id); return makeSource(isPosSource(id), (s & 5) | ((s & 2) << 2) | ((s & 8) >> 2)); }
    return isMuxId(id) ? withMuxDir(id, MIRROR_DIR[muxDirOf[id]]) : id;
}

// The four directions as offsets, in the order every face index uses.
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N, E, S, W

// ===== Structural form =====
//
// Structural form = the cell with simulation-computed values stripped (a
// crossing stays a crossing, both ways 0). Undo snapshots and clipboard
// clips both use this, so stepping never creates bogus undo steps and
// pasting duplicates the drawing, not a frozen instant of the run.
function stripId(id) {
    if (isXover(id)) return makeXover(OFF, OFF);
    if (isConductorId(id)) return makeConductor(OFF);
    if (isMuxId(id)) return restMuxId(id);
    if (isLed(id)) return makeLed(OFF);    // lit state is transient, like charge
    if (isSwitch(id)) return ID_SWITCH_OFF; // pressed state is transient too
    if (isToggle(id)) return ID_TOGGLE_OFF; // latched state resets on copy/undo baseline
    return isValidId(id) ? id : ID_INSULATOR_PLAIN;
}

// Exactly the ids this build defines (see the id map). Anything else —
// including 15-20, which older builds used — loads as insulator rather
// than as a cell nothing knows how to draw or step.
function isValidId(id) {
    return id === ID_INSULATOR_PLAIN ||
        (id >= ID_CONDUCTOR_BASE && id <= ID_NEG) ||
        (id >= ID_XOVER_BASE && id <= ID_TOGGLE_ON) ||
        (id >= ID_SRC_POS && id <= ID_SRC_MAX) ||
        isMuxId(id);
}

export {
    OFF, ON, FALLING, Z, ID_INSULATOR_PLAIN, ID_CONDUCTOR_BASE, ID_CONDUCTOR_MAX, ID_POS, ID_NEG,
    isSource, isPosSource, sourceStubs, makeSource, withStub, dirIndex,
    ID_XOVER_BASE, ID_XOVER_MAX, ID_LED_BASE, ID_LED_MAX, ID_SWITCH_OFF, ID_SWITCH_ON, ID_TOGGLE_OFF,
    ID_TOGGLE_ON, isInsulatorId, isLed, ledCharge, makeLed, ledIsOn, isSwitch, switchIsPressed, isToggle,
    toggleIsOn, NEIGHBORS_8, isConductorId, conductorCharge, makeConductor, isXover, xoverV,
    xoverH, makeXover, isWireId, combineCharge, ID_MUX_C, ID_MUX_O, ID_MUX_X, ID_MUX_NO, ID_MUX_NC, ID_MUX_M,
    MK_C, MK_O, MK_X, MK_NO, MK_NC, MK_M, DRAIN, SEL_NO, SEL_NC, muxKindOf, muxDirOf, muxChOf, muxAuxOf,
    makeMuxC, makeMuxO, makeMuxNO, makeMuxNC, makeMuxM, isMuxId, hasMuxLead, leadInto, armInto, crossingFrom, inferCrossings, muxCharge, restMuxId,
    MIRROR_DIR, withMuxDir, rotateId, MUX_CELL_NAMES, muxCellKind, muxLead, mirrorId, DIRS, stripId,
    isValidId,
};
