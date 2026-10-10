(function (window) {
    // model.js - pure-pixel adjacency simulation with direct mux support.
    //
    // Unlike simulation/pixelogic's tile world, connectivity here is purely
    // adjacency-based: two orthogonally-touching conductor-ish pixels are
    // connected, full stop - there is no per-side "pipe fitting" bitmask to
    // draw. Three pixel colors only: insulator, conductor, and mux body
    // (gray). Crossovers, voltage sources and mux macros are all *inferred*
    // from adjacency/shape rather than placed as distinct tools.

    const CELL_SIZE = 32;
    const DEFAULT_W = 48, DEFAULT_H = 30;
    // The grid grows on demand (see expandForBorder) so drawing never runs out
    // of room, so its dimensions are mutable.
    let GRID_W = DEFAULT_W, GRID_H = DEFAULT_H;

    // ===== Charge states (3-state decay model, ported from pixelogic/model.js) =====
    const OFF = 0, ON = 1, FALLING = 2;

    function nextCharge(charge, n, e, s, w) {
        if (charge === OFF) {
            if (n === ON || e === ON || s === ON || w === ON) return ON;
        } else if (charge === ON) {
            if (n === FALLING || e === FALLING || s === FALLING || w === FALLING) return FALLING;
        } else if (charge === FALLING) {
            return OFF;
        }
        return charge;
    }

    // ===== Cell ID space (fits in a Uint8Array) =====
    //
    // Insulator: 0 (plain only - a bare insulator is inert, and an insulator
    //            hole no longer means anything special)
    // Conductor: 10-12 (charge 0-2)
    // +V: 13   -V: 14  (explicit sources - they can sit right against a mux
    //            and drive it directly)
    // 15-20:     unassigned, and kept that way: circuits saved by older builds
    //            use them, and an id this build does not define loads as
    //            insulator (see isValidId) rather than as whatever might move
    //            into the number later.
    // Gray (mux body colored pixel):     21-26 (charge*2 + wasActive). Only a
    //            solid 3x2 of it is a part; any other shape is inert.
    // Crossover conductor: 27-35 (27 + v*3 + h) - a conductor whose four
    //            neighbors are all conductors routes its vertical axis (N<->S)
    //            independently from its horizontal axis (E<->W), so it needs to
    //            remember two charges. Crossover-ness itself is geometric (see
    //            isCrossoverAt); the distinct id only exists to hold both.
    // LED (output): 36-38 (36 + charge) - a pure sink that never drives a wire,
    //            but LED cells conduct to each other over the 8-neighborhood so
    //            a multi-cell pad lights (and drains) as one square unit.
    // Switch (momentary input): 39 released, 40 pressed - drives like +V while
    //            pressed and like -V (pulls down) when released. Pressing floods
    //            the whole 8-connected switch pad, so a big button acts as one.
    // Toggle (latching input): 41 off, 42 on - same drive as the switch (+V on,
    //            -V off), but a click flips and holds instead of press-and-hold.
    const ID_INSULATOR_PLAIN = 0;
    const ID_CONDUCTOR_BASE = 10, ID_CONDUCTOR_MAX = 12;
    const ID_POS = 13;
    const ID_NEG = 14;
    const ID_GRAY_BASE = 21, ID_GRAY_MAX = 26;
    const ID_XOVER_BASE = 27, ID_XOVER_MAX = 35;
    const ID_LED_BASE = 36, ID_LED_MAX = 38;
    const ID_SWITCH_OFF = 39, ID_SWITCH_ON = 40;
    const ID_TOGGLE_OFF = 41, ID_TOGGLE_ON = 42;

    function isInsulatorId(id) { return id === ID_INSULATOR_PLAIN; }
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

    // Variadic form of nextCharge for cells that read more than four inputs
    // (an LED sees up to eight LED neighbors plus its orthogonal drivers).
    function nextChargeN(cur, inputs) {
        if (cur === OFF) return inputs.some((c) => c === ON) ? ON : OFF;
        if (cur === ON) return inputs.some((c) => c === FALLING) ? FALLING : ON;
        if (cur === FALLING) return OFF;
        return cur;
    }

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


    function isGrayId(id) { return id >= ID_GRAY_BASE && id <= ID_GRAY_MAX; }
    function grayCharge(id) { return Math.floor((id - ID_GRAY_BASE) / 2); }
    function grayWasActive(id) { return ((id - ID_GRAY_BASE) % 2) === 1; }
    function makeGray(charge, wasActive) { return ID_GRAY_BASE + charge * 2 + (wasActive ? 1 : 0); }

    const AXIS_V = 0, AXIS_H = 1;

    var cells = new Uint8Array(GRID_W * GRID_H).fill(ID_INSULATOR_PLAIN);
    var nextCells = new Uint8Array(GRID_W * GRID_H);
    var roles = new Array(GRID_W * GRID_H).fill(null);
    var tickCount = 0;
    // Locked cells (game.js): the campaign's fixed input/output pads. Every
    // structural edit path refuses to touch one, so a level's terminals stay
    // where the verifier expects them however the player rearranges the rest.
    // Empty (all zero) in the sandbox, which is the only state the editor
    // itself ever produces.
    var locked = new Uint8Array(GRID_W * GRID_H);
    var anyLocked = false;

    function idx(x, y) { return y * GRID_W + x; }
    function inBounds(x, y) { return x >= 0 && x < GRID_W && y >= 0 && y < GRID_H; }
    function getCell(x, y) { return inBounds(x, y) ? cells[idx(x, y)] : ID_INSULATOR_PLAIN; }
    function setCellRaw(x, y, id) { if (inBounds(x, y)) cells[idx(x, y)] = id; }
    function isLocked(x, y) { return anyLocked && inBounds(x, y) && locked[idx(x, y)] === 1; }

    // Replaces the whole lock set with the given cell list ([[x,y],...]).
    // Called once when a level loads and cleared on the way back to the
    // sandbox; nothing incremental, so there's no partial state to get wrong.
    function setLockedCells(list) {
        locked.fill(0);
        anyLocked = false;
        for (const [x, y] of (list || [])) {
            if (!inBounds(x, y)) continue;
            locked[idx(x, y)] = 1;
            anyLocked = true;
        }
    }
    function lockedCells() {
        const out = [];
        if (!anyLocked) return out;
        for (let i = 0; i < locked.length; i++)
            if (locked[i] === 1) out.push([i % GRID_W, Math.floor(i / GRID_W)]);
        return out;
    }

    // ===== Blocks: a part placed whole =====
    //
    // A block is a circuit dropped onto the board at full size — its own
    // cells, simulated exactly like any others — plus a record of what it
    // is: a name, its pins and what they are called, the blocks nested inside
    // it, and whether its lid is shut. The pixels cannot say any of that, so
    // it rides alongside them: two per-cell arrays (which block holds a cell,
    // which pin leaves it) and a map of records. Everything that moves cells
    // carries the arrays with them.
    //
    // A cell belongs to the innermost block holding it; the blocks around
    // that one are its ancestors (`parent`). Block cells are off limits to
    // every ordinary edit — paint, erase, paste, the router — the way a
    // level's locked pads are. The only ways to change one are to take the
    // whole block (erase, move, copy, turn) or to decap it, which drops the
    // record and leaves its cells as loose parts.
    //
    // A block's cells are its CORE: the muxes, sources and wiring of its
    // circuit and nothing else. Its terminals are not its cells. A pin is a
    // core cell and a face of it — `pinAt` holds pinCode(pin, face) — and the
    // pin's TERMINAL is the cell just outside that face: where a wire, a
    // switch or another part's terminal wire goes to connect. The ring of
    // cells round the core is the block's EDGE, and each of those cells is
    // one of three kinds (classifyRing): a terminal; a cell that must stay
    // bare substrate, because anything there would join the circuit or make
    // a mux read itself differently; or a cell nothing inside cares about,
    // free for anything — another part's edge included. Edges are not stored:
    // they are worked out from the core, and kept (ringMask) so every edit
    // can respect them.
    var blockAt = new Int32Array(GRID_W * GRID_H);   // innermost block id, 0 = none
    var pinAt = new Int16Array(GRID_W * GRID_H);     // pinCode(pin, face) of that block, 0 = none
    var blocks = new Map();      // id -> {id, name, source, pins: [{name, dir}], parent, open}
    var blockGeom = new Map();   // id -> {x0, y0, x1, y1, pins: [{host: [x, y], d} | null], count}
    var ringMask = new Uint8Array(GRID_W * GRID_H);  // RING_R | RING_T from the outermost blocks' edges
    var ringCache = new Map();   // id -> {sig, ring}
    var nextBlockId = 1;
    const RING_R = 1, RING_T = 2;
    // A pin's cell value: which pin, and which face of the cell it leaves by
    // (an index into DIRS: north, east, south, west).
    const pinCode = (k, d) => k * 4 + d + 1;
    const pinIndex = (v) => (v - 1) >> 2;
    const pinFaceOf = (v) => (v - 1) & 3;
    const turnPinCode = (v, turns) => (v ? pinCode(pinIndex(v), (pinFaceOf(v) + turns + 4) & 3) : 0);
    const mirrorPinCode = (v) => (v ? pinCode(pinIndex(v), [0, 3, 2, 1][pinFaceOf(v)]) : 0);

    function blockParent(id) { const r = blocks.get(id); return r ? r.parent : 0; }
    // Cells no edit may write: a block's own cells, a level's locked pads, and
    // cells a block's edge keeps bare.
    function isProtected(x, y) {
        if (!inBounds(x, y)) return false;
        const i = idx(x, y);
        return blockAt[i] !== 0 || (anyLocked && locked[i] === 1) || (ringMask[i] & RING_R) !== 0;
    }
    // A cell some block's edge has as a terminal: wire may go there, mux body
    // may not.
    function isTerminalCell(x, y) { return inBounds(x, y) && (ringMask[idx(x, y)] & RING_T) !== 0; }
    // Is cell i inside block `id`, directly or nested deeper?
    function cellInBlock(i, id) {
        for (let b = blockAt[i]; b; b = blockParent(b)) if (b === id) return true;
        return false;
    }
    function topBlockOf(id) {
        let b = id;
        while (b && blockParent(b)) b = blockParent(b);
        return b;
    }
    // Every cell of block `id`, nested blocks included, as flat indices.
    function blockCellIdxs(id) {
        const g = blockGeom.get(id);
        if (!g) return [];
        const out = [];
        for (let y = g.y0; y <= g.y1; y++)
            for (let x = g.x0; x <= g.x1; x++) {
                const i = idx(x, y);
                if (blockAt[i] && cellInBlock(i, id)) out.push(i);
            }
        return out;
    }
    // Blocks whose every cell lies inside a rectangle.
    function blocksInside(r) {
        const out = new Set();
        for (const [id, g] of blockGeom)
            if (g.x0 >= r.x0 && g.x1 <= r.x1 && g.y0 >= r.y0 && g.y1 <= r.y1) out.add(id);
        return out;
    }

    // Where each block is, re-read from the cell arrays after any change
    // (recomputeRoles calls it). A cell naming a block with no record, or a
    // record with no cells left, is dropped rather than drawn half-there.
    function computeBlockGeom() {
        blockGeom = new Map();
        if (!blocks.size) {
            // Nothing to find — but a stray id left in the arrays must not
            // survive to be read as a block later.
            for (let i = 0; i < blockAt.length; i++) if (blockAt[i]) { blockAt[i] = 0; pinAt[i] = 0; }
            return;
        }
        for (let i = 0; i < blockAt.length; i++) {
            const b0 = blockAt[i];
            if (!b0) continue;
            if (!blocks.has(b0)) { blockAt[i] = 0; pinAt[i] = 0; continue; }
            const x = i % GRID_W, y = (i - x) / GRID_W;
            for (let b = b0; b; b = blockParent(b)) {
                const rec = blocks.get(b);
                if (!rec) break;
                let g = blockGeom.get(b);
                if (!g) {
                    g = { x0: x, y0: y, x1: x, y1: y, pins: rec.pins.map(() => null), count: 0 };
                    blockGeom.set(b, g);
                }
                if (x < g.x0) g.x0 = x;
                if (x > g.x1) g.x1 = x;
                if (y < g.y0) g.y0 = y;
                if (y > g.y1) g.y1 = y;
                g.count++;
            }
            const p = pinAt[i];
            if (p) {
                const g = blockGeom.get(b0);
                if (pinIndex(p) < g.pins.length) g.pins[pinIndex(p)] = { host: [x, y], d: pinFaceOf(p) };
                else pinAt[i] = 0;
            }
        }
        for (const id of [...blocks.keys()]) if (!blockGeom.has(id)) blocks.delete(id);
    }

    // Every block, outermost first, with where it is, where its pins are and
    // its edge. A pin: `host` is its core cell, `face` the way it leaves, and
    // `at` its terminal — the cell outside that face. `hidden` is true when
    // some block around it has its lid shut.
    function blockList() {
        const out = [];
        for (const [id, rec] of blocks) {
            const g = blockGeom.get(id);
            if (!g) continue;
            let depth = 0, hidden = false;
            for (let p = rec.parent; p; p = blockParent(p)) {
                depth++;
                if (blocks.get(p) && !blocks.get(p).open) hidden = true;
            }
            out.push({
                id, name: rec.name, source: rec.source, parent: rec.parent, open: rec.open, depth, hidden,
                x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1,
                pins: rec.pins.map((p, k) => {
                    const q = g.pins[k];
                    if (!q) return { name: p.name, dir: p.dir, at: null, host: null, face: null };
                    const [dx, dy] = DIRS[q.d];
                    return { name: p.name, dir: p.dir, host: q.host, face: [dx, dy], at: [q.host[0] + dx, q.host[1] + dy] };
                }),
                ring: [...ringOfBlock(id).values()],
            });
        }
        out.sort((a, b) => a.depth - b.depth);
        return out;
    }
    function blockInfo(id) { return blockList().find((b) => b.id === id) || null; }

    // The innermost block holding (x,y), or 0.
    function blockAtCell(x, y) { return inBounds(x, y) ? blockAt[idx(x, y)] : 0; }
    // The block a click at (x,y) is about: the outermost one with its lid
    // shut (everything inside that is out of sight), or else the innermost.
    function visibleBlockAt(x, y) {
        if (!inBounds(x, y)) return 0;
        const chain = [];
        for (let b = blockAt[idx(x, y)]; b; b = blockParent(b)) chain.push(b);
        for (let k = chain.length - 1; k >= 0; k--) if (!blocks.get(chain[k]).open) return chain[k];
        return chain.length ? chain[0] : 0;
    }
    // Whose edge a cell is on, and as what: [{id, cls, pin}] for the
    // outermost blocks whose edge includes it.
    function edgeAt(x, y) {
        const out = [];
        if (!inBounds(x, y) || !ringMask[idx(x, y)]) return out;
        for (const id of blocks.keys()) {
            if (blockParent(id)) continue;
            const r = ringOfBlock(id).get(x + ',' + y);
            if (r) out.push({ id, cls: r.cls, pin: r.pin });
        }
        return out;
    }
    function setBlockOpen(id, open) {
        const r = blocks.get(id);
        if (!r) return false;
        r.open = !!open;
        return true;
    }
    // Erase a block, nested blocks and all.
    function removeBlock(id) {
        const list = blockCellIdxs(id);
        if (!list.length) return false;
        for (const i of list) { cells[i] = ID_INSULATOR_PLAIN; blockAt[i] = 0; pinAt[i] = 0; }
        recomputeRoles();
        return true;
    }
    // Take the lid off for good: the record goes, and its cells become loose
    // parts of whatever it sat in (the board, or the block around it). Blocks
    // nested inside it stay blocks, one level further out. Its edge goes
    // with it: what was kept bare is ordinary board again.
    function decapBlock(id) {
        const rec = blocks.get(id);
        if (!rec) return false;
        for (let i = 0; i < blockAt.length; i++)
            if (blockAt[i] === id) { blockAt[i] = rec.parent; pinAt[i] = 0; }
        for (const r of blocks.values()) if (r.parent === id) r.parent = rec.parent;
        blocks.delete(id);
        recomputeRoles();
        return true;
    }

    const copyBlockRec = (r) => ({
        id: r.id, name: r.name, source: r.source, parent: r.parent, open: !!r.open,
        pins: r.pins.map((p) => ({ name: p.name, dir: p.dir })),
    });
    // Everything about the blocks, for a snapshot. (The edges are worked out
    // again from the cores.)
    function blockState() {
        return {
            at: blockAt.slice(), pin: pinAt.slice(),
            recs: [...blocks.values()].map(copyBlockRec), next: nextBlockId,
        };
    }
    function restoreBlockState(s) {
        if (!s || s.at.length !== blockAt.length) {
            blockAt.fill(0); pinAt.fill(0); blocks = new Map();
            return;
        }
        blockAt.set(s.at);
        pinAt.set(s.pin);
        blocks = new Map(s.recs.map((r) => [r.id, copyBlockRec(r)]));
        nextBlockId = Math.max(nextBlockId, s.next || 1);
    }

    // ===== How a mux reads itself =====
    // Which long side is COM (comD: 0 for the row at the smaller coordinate,
    // 1 for the other) and which COM-row end is SELECT (sel: 0 or 2), each
    // null until something says. `wired(x, y)` says whether a cell against
    // the part is taken — by anything at all, not only wire. buildBoxMux
    // reads the board this way; classifyRing asks it "what if?".
    //
    // The ORDER is the whole story, and it is why a part's edge has to be
    // worked out rather than guessed: a wire at the middle of a long side
    // settles COM before anything else is looked at; failing that, a short
    // side of either row decides, the row at the smaller coordinate first;
    // failing that, a wire at a long side's end puts COM on the far side.
    // SELECT is the first COM-row end with its short side taken.
    function readBox(minX, minY, w, wired) {
        const along = w === 3 ? [1, 0] : [0, 1];
        const perp = w === 3 ? [0, 1] : [1, 0];
        const gridAt = (i, d) => [minX + along[0] * i + perp[0] * d, minY + along[1] * i + perp[1] * d];
        const out = (p, [dx, dy]) => wired(p[0] + dx, p[1] + dy);
        const perpOut = (d) => (d === 0 ? [-perp[0], -perp[1]] : perp);
        const alongOut = (i) => (i === 0 ? [-along[0], -along[1]] : along);
        let comD = null;
        for (const d of [0, 1]) if (out(gridAt(1, d), perpOut(d))) { comD = d; break; }
        if (comD === null)
            for (const d of [0, 1]) if ([0, 2].some((i) => out(gridAt(i, d), alongOut(i)))) { comD = d; break; }
        if (comD === null)
            for (const d of [0, 1]) if ([0, 2].some((i) => out(gridAt(i, d), perpOut(d)))) { comD = 1 - d; break; }
        let sel = null;
        if (comD !== null) for (const i of [0, 2]) if (out(gridAt(i, comD), alongOut(i))) { sel = i; break; }
        return { comD, sel };
    }
    // The leads a reading gives the part: [[x, y, dx, dy]] — COM, SELECT and
    // both pins once it works; COM and the pins once COM is known.
    function boxLeads(minX, minY, w, r) {
        if (r.comD === null) return [];
        const along = w === 3 ? [1, 0] : [0, 1];
        const perp = w === 3 ? [0, 1] : [1, 0];
        const gridAt = (i, d) => [minX + along[0] * i + perp[0] * d, minY + along[1] * i + perp[1] * d];
        const toward = r.comD === 0 ? perp : [-perp[0], -perp[1]];
        const leads = [[...gridAt(1, r.comD), -toward[0], -toward[1]],
            [...gridAt(0, 1 - r.comD), toward[0], toward[1]], [...gridAt(2, 1 - r.comD), toward[0], toward[1]]];
        if (r.sel !== null) {
            const out = r.sel === 0 ? [-along[0], -along[1]] : along;
            leads.push([...gridAt(r.sel, r.comD), out[0], out[1]]);
        }
        return leads;
    }

    // ===== A part's edge =====
    //
    // Every cell of the ring round a core, as one of:
    //   'T' — a terminal: where a wire (or a switch, a lamp, another part's
    //         terminal) goes to connect to the pin inside;
    //   'R' — kept bare: anything there would join the circuit inside, or
    //         make one of its muxes read itself differently;
    //   'X' — nothing inside cares: free for anything, another part's edge
    //         included. (Except mux body against mux body, which is never
    //         allowed anywhere — the two would merge into a blob that is
    //         neither.)
    //
    // Worked out, not guessed, because a mux reads its orientation off
    // whatever lies against it, in an order that depends on which way round
    // it stands (see readBox). So for each edge cell next to a mux, the
    // question is asked for every way the part could be turned or flipped,
    // and for every mix of its terminals being wired or not — with at least
    // one wired, since a part with nothing connected does nothing to get
    // wrong. If a thing on the edge cell changes the reading in any of those,
    // or meets a lead that is not a terminal, the cell is kept bare.
    //
    // A change only counts if it matters: a mux with no SELECT does nothing
    // at all, so two readings that both leave it without one are the same.
    // That is what lets an output wire bend along the edge past the COM
    // row's far end — the only reading it could spoil is one where, with
    // nothing on SELECT, the mux is dead whichever way round it reads.
    //
    // `core`: {x0, y0, x1, y1, id(x, y), nested(x, y) → a block inside it (0
    // for its own cells), nestedRing(b, x, y) → that block's class there,
    // pins: [{hx, hy, d, k, dir}]}. Returns a Map 'x,y' -> {x, y, cls, pin}.
    const TRANSFORMS = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0],
        [-1, 0, 0, 1], [1, 0, 0, -1], [0, 1, 1, 0], [0, -1, -1, 0]];
    function classifyRing(core) {
        const key = (x, y) => x + ',' + y;
        const inCore = (x, y) => x >= core.x0 && x <= core.x1 && y >= core.y0 && y <= core.y1;
        const termOf = new Map(), hostOf = new Map();
        for (const p of core.pins) {
            const [dx, dy] = DIRS[p.d];
            termOf.set(key(p.hx + dx, p.hy + dy), p);
            hostOf.set(key(p.hx, p.hy), p);
        }
        // The muxes in the core itself (not inside a part nested in it).
        const muxOf = new Map(), seen = new Set();
        for (let y = core.y0; y <= core.y1; y++)
            for (let x = core.x0; x <= core.x1; x++) {
                if (seen.has(key(x, y)) || !isGrayId(core.id(x, y)) || core.nested(x, y)) continue;
                const blob = [], stack = [[x, y]];
                seen.add(key(x, y));
                while (stack.length) {
                    const [cx, cy] = stack.pop();
                    blob.push([cx, cy]);
                    for (const [dx, dy] of DIRS) {
                        const nx = cx + dx, ny = cy + dy;
                        if (!inCore(nx, ny) || seen.has(key(nx, ny)) || !isGrayId(core.id(nx, ny)) || core.nested(nx, ny)) continue;
                        seen.add(key(nx, ny));
                        stack.push([nx, ny]);
                    }
                }
                const xs = blob.map((c) => c[0]), ys = blob.map((c) => c[1]);
                const minX = Math.min(...xs), minY = Math.min(...ys);
                const w = Math.max(...xs) - minX + 1, h = Math.max(...ys) - minY + 1;
                const m = blob.length === 6 && w * h === 6 ? { cells: blob, minX, minY, w } : null;
                for (const [bx, by] of blob) muxOf.set(key(bx, by), m);
            }
        const taken = (x, y, wired, probe) => (probe !== null && probe[0] === x && probe[1] === y)
            || (inCore(x, y) ? !isInsulatorId(core.id(x, y)) : wired.has(key(x, y)));
        const reading = (m, T, wired, probe) => {
            const [a, b, c, d] = T;
            const pts = m.cells.map(([x, y]) => [a * x + b * y, c * x + d * y]);
            const minX = Math.min(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1]));
            const w = Math.max(...pts.map((p) => p[0])) - minX + 1;
            // (The transforms are orthogonal: the inverse is the transpose.)
            const r = readBox(minX, minY, w, (tx, ty) => taken(a * tx + c * ty, b * tx + d * ty, wired, probe));
            return r.sel === null ? 'dead' : r.comD + ':' + r.sel;
        };
        const ring = new Map();
        const put = (x, y, cls, pin) => ring.set(key(x, y), { x, y, cls, pin: pin ? pin.k : -1 });
        for (let y = core.y0 - 1; y <= core.y1 + 1; y++)
            for (let x = core.x0 - 1; x <= core.x1 + 1; x++) {
                if (inCore(x, y)) continue;
                const xin = x >= core.x0 && x <= core.x1, yin = y >= core.y0 && y <= core.y1;
                if (!xin && !yin) { put(x, y, 'X'); continue; }   // a corner only touches the ring
                const nx = xin ? x : (x < core.x0 ? core.x0 : core.x1);
                const ny = yin ? y : (y < core.y0 ? core.y0 : core.y1);
                const term = termOf.get(key(x, y));
                if (term) { put(x, y, 'T', term); continue; }
                const child = core.nested(nx, ny);
                if (child) { put(x, y, core.nestedRing(child, x, y) === 'X' ? 'X' : 'R'); continue; }
                const nid = core.id(nx, ny);
                if (isInsulatorId(nid)) { put(x, y, 'X'); continue; }
                if (!isGrayId(nid)) {
                    // Wire, a source, a lamp: anything touching it joins it. A
                    // pin's wire reached from another face is the same pin.
                    const host = hostOf.get(key(nx, ny));
                    if (host && isWireId(nid)) put(x, y, 'T', host);
                    else put(x, y, 'R');
                    continue;
                }
                const m = muxOf.get(key(nx, ny));
                if (!m) { put(x, y, 'R'); continue; }
                const near = [];
                for (const [tk] of termOf) {
                    const [tx, ty] = tk.split(',').map(Number);
                    if (m.cells.some(([mx, my]) => Math.abs(mx - tx) + Math.abs(my - ty) === 1)) near.push(tk);
                }
                // At least one terminal of the part wired — a terminal elsewhere
                // can be the wired one, and then any mix here counts.
                const allMine = near.length === termOf.size && termOf.size > 0;
                let upset = false;
                for (let mask = allMine ? 1 : 0; mask < (1 << near.length) && !upset; mask++) {
                    const wired = new Set(near.filter((_, j) => mask & (1 << j)));
                    for (const T of TRANSFORMS)
                        if (reading(m, T, wired, null) !== reading(m, T, wired, [x, y])) { upset = true; break; }
                }
                if (upset) { put(x, y, 'R'); continue; }
                // A lead facing it, with every terminal wired, would take
                // whatever is put there as a connection.
                const r = readBox(m.minX, m.minY, m.w, (tx, ty) => taken(tx, ty, new Set(near), null));
                const faces = boxLeads(m.minX, m.minY, m.w, r)
                    .some(([lx, ly, dx, dy]) => lx === nx && ly === ny && lx + dx === x && ly + dy === y);
                put(x, y, faces ? 'R' : 'X');
            }
        return ring;
    }

    // A core on the board — a placed block's, or a rectangle being fitted —
    // as classifyRing wants it.
    // `asWire` (a set of cell indexes) reads those cells as plain wire: the
    // pads a level part has had to take in (see fitPart).
    function coreOnBoard(r, own, pins, asWire) {
        // The part directly inside this core that holds a cell (with no
        // `own`, the outermost part there), or 0 for the core's own cells.
        const child = (x, y) => {
            if (!inBounds(x, y)) return 0;
            let b = blockAt[idx(x, y)];
            if (!b || b === own) return 0;
            while (blockParent(b) && blockParent(b) !== own) b = blockParent(b);
            return own && blockParent(b) !== own ? 0 : b;
        };
        return {
            x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
            id: (x, y) => (!inBounds(x, y) ? ID_INSULATOR_PLAIN
                : asWire && asWire.has(idx(x, y)) ? ID_CONDUCTOR_BASE : cells[idx(x, y)]),
            nested: child,
            nestedRing: (b, x, y) => { const c = ringOfBlock(b).get(x + ',' + y); return c ? c.cls : 'X'; },
            pins,
        };
    }
    function blockSig(id, g) {
        let h = 0x811c9dc5;
        for (let y = g.y0; y <= g.y1; y++)
            for (let x = g.x0; x <= g.x1; x++) {
                const i = idx(x, y);
                h = Math.imul(h ^ stripId(cells[i]), 0x01000193);
                h = Math.imul(h ^ (blockAt[i] === id ? 0 : 1), 0x01000193);
                h = Math.imul(h ^ pinAt[i], 0x01000193);
            }
        return `${g.x0},${g.y0},${g.x1},${g.y1}:${h >>> 0}`;
    }
    // A placed block's edge, worked out once per shape and place.
    function ringOfBlock(id) {
        const g = blockGeom.get(id);
        if (!g) return new Map();
        const sig = blockSig(id, g);
        const hit = ringCache.get(id);
        if (hit && hit.sig === sig) return hit.ring;
        const pins = [];
        const rec = blocks.get(id);
        g.pins.forEach((p, k) => { if (p) pins.push({ hx: p.host[0], hy: p.host[1], d: p.d, k, dir: rec.pins[k].dir }); });
        const ring = classifyRing(coreOnBoard(g, id, pins));
        ringCache.set(id, { sig, ring });
        return ring;
    }
    // The edges every edit has to respect, from the outermost blocks (a
    // nested block's edge is inside its host, which is sealed anyway).
    function computeRingMask() {
        if (ringMask.length !== cells.length) ringMask = new Uint8Array(cells.length);
        else ringMask.fill(0);
        for (const id of [...ringCache.keys()]) if (!blocks.has(id)) ringCache.delete(id);
        for (const id of blocks.keys()) {
            if (blockParent(id)) continue;
            for (const c of ringOfBlock(id).values()) {
                if (!inBounds(c.x, c.y)) continue;
                ringMask[idx(c.x, c.y)] |= c.cls === 'R' ? RING_R : c.cls === 'T' ? RING_T : 0;
            }
        }
    }
    // Cells where an edge is broken: something on a cell kept bare, or mux
    // body — or another part's insides — on a terminal.
    function ringViolations() {
        const out = [];
        for (let i = 0; i < ringMask.length; i++) {
            const m = ringMask[i];
            if (!m) continue;
            if ((m & RING_R) && !isInsulatorId(cells[i])) out.push(i);
            else if ((m & RING_T) && (isGrayId(cells[i]) || blockAt[i])) out.push(i);
        }
        return out;
    }

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
    // A block of a clip, at (ox, oy) on the board, as a core for classifyRing.
    function coreInClip(c, lid, ox, oy) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const pins = [];
        for (let y = 0; y < c.h; y++)
            for (let x = 0; x < c.w; x++) {
                const k = y * c.w + x, l = c.bmap[k];
                if (!l || !clipUnder(c, l, lid)) continue;
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
                if (l === lid && c.pmap[k]) {
                    const pk = pinIndex(c.pmap[k]), rec = c.blocks.find((b) => b.lid === lid);
                    pins.push({ hx: ox + x, hy: oy + y, d: pinFaceOf(c.pmap[k]), k: pk, dir: rec && rec.pins[pk] ? rec.pins[pk].dir : 'in' });
                }
            }
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
            nestedRing: (l, x, y) => { const r = clipRingOf(c, l, ox, oy).get(x + ',' + y); return r ? r.cls : 'X'; },
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
    // The pins of a clip's outermost block, in the clip's own coordinates:
    // [{name, dir, host, face, at}], `at` being the terminal outside.
    function clipPins(c) {
        const tops = c.blocks && c.bmap ? clipTops(c) : [];
        if (!tops.length) return [];
        const top = c.blocks.find((b) => b.lid === tops[0]);
        const pins = top.pins.map((p) => ({ name: p.name, dir: p.dir, host: null, face: null, at: null }));
        for (let i = 0; i < c.pmap.length; i++) {
            if (c.bmap[i] !== top.lid || !c.pmap[i]) continue;
            const k = pinIndex(c.pmap[i]), [dx, dy] = DIRS[pinFaceOf(c.pmap[i])];
            const hx = i % c.w, hy = Math.floor(i / c.w);
            if (pins[k]) Object.assign(pins[k], { host: [hx, hy], face: [dx, dy], at: [hx + dx, hy + dy] });
        }
        return pins;
    }
    // The edge of a clip's outermost block, in the clip's own coordinates.
    function clipRing(c) {
        const tops = c.blocks && c.bmap ? clipTops(c) : [];
        return tops.length ? [...clipRingOf(c, tops[0], 0, 0).values()] : [];
    }

    // A clip that came from storage or an import, made safe to paste: right
    // lengths, known ids, parents that exist and do not loop. Returns null
    // if there is no usable clip at all. Clips saved before pins recorded
    // their face (no `pv`) had every pin on its block's edge, facing out,
    // which is what they are read as.
    function sanitizeClip(c) {
        if (!c || !Number.isInteger(c.w) || !Number.isInteger(c.h) || c.w <= 0 || c.h <= 0) return null;
        const n = c.w * c.h;
        if (n > MAX_CELLS || !c.data || c.data.length !== n) return null;
        const data = new Uint8Array(n);
        for (let i = 0; i < n; i++) data[i] = stripId(c.data[i] & 0xff);
        const out = { w: c.w, h: c.h, data };
        if (!Array.isArray(c.blocks) || !c.blocks.length || !c.bmap || c.bmap.length !== n) return out;
        const recs = [];
        const seen = new Set();
        for (const b of c.blocks) {
            if (!b || !Number.isInteger(b.lid) || b.lid <= 0 || seen.has(b.lid)) continue;
            seen.add(b.lid);
            recs.push({
                lid: b.lid, name: String(b.name || 'Part').slice(0, 40), source: b.source ? String(b.source) : '',
                parent: Number.isInteger(b.parent) ? b.parent : 0, open: !!b.open,
                pins: (Array.isArray(b.pins) ? b.pins : []).slice(0, 256).map((p) => ({
                    name: String((p && p.name) || '?').slice(0, 12), dir: p && p.dir === 'out' ? 'out' : 'in',
                })),
            });
        }
        const byLid = new Map(recs.map((r) => [r.lid, r]));
        for (const r of recs) {
            // A parent that is missing, or that leads back round to this one,
            // is cut: the block stands on its own instead.
            let p = r.parent, steps = 0;
            while (p && byLid.has(p) && p !== r.lid && steps++ < recs.length) p = byLid.get(p).parent;
            if (!byLid.has(r.parent) || p === r.lid || steps >= recs.length) r.parent = 0;
        }
        const bmap = new Int32Array(n), pmap = new Int16Array(n);
        for (let i = 0; i < n; i++) {
            const l = c.bmap[i] | 0;
            if (byLid.has(l)) bmap[i] = l;
        }
        const legacy = !c.pv;
        const box = legacy ? lidBoxes(bmap, c.w, c.h) : null;
        for (let i = 0; i < n; i++) {
            const l = bmap[i];
            let p = c.pmap ? c.pmap[i] | 0 : 0;
            if (!l || p <= 0) continue;
            if (legacy) p = pinCode(p - 1, outwardFace(box.get(l), i % c.w, Math.floor(i / c.w)));
            if (pinIndex(p) < byLid.get(l).pins.length) pmap[i] = p;
        }
        out.blocks = recs;
        out.bmap = bmap;
        out.pmap = pmap;
        return out;
    }
    // Each lid's own bounding box (its own cells only), for reading old pins.
    function lidBoxes(bmap, w, h) {
        const box = new Map();
        for (let i = 0; i < bmap.length; i++) {
            const l = bmap[i];
            if (!l) continue;
            const x = i % w, y = Math.floor(i / w);
            const b = box.get(l) || { x0: x, y0: y, x1: x, y1: y };
            b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
            box.set(l, b);
        }
        return box;
    }
    // The face of a cell on a box's edge that looks out of it.
    function outwardFace(b, x, y) {
        if (x === b.x0) return 3;
        if (x === b.x1) return 1;
        if (y === b.y0) return 0;
        return 2;
    }
    // Plain arrays, for JSON.
    function clipToJSON(c) {
        const o = { w: c.w, h: c.h, data: Array.from(c.data) };
        if (c.blocks && c.blocks.length) {
            o.pv = 2;
            o.blocks = c.blocks.map((b) => ({
                lid: b.lid, name: b.name, source: b.source, parent: b.parent, open: !!b.open,
                pins: b.pins.map((p) => ({ name: p.name, dir: p.dir })),
            }));
            o.bmap = Array.from(c.bmap);
            o.pmap = Array.from(c.pmap);
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
                out.data[t] = c.data[k];
                if (!hasBlocks) continue;
                out.bmap[t] = c.bmap[k];
                const p = c.pmap ? c.pmap[k] : 0;
                out.pmap[t] = turn ? turnPinCode(p, 1) : mirrorPinCode(p);
            }
        return out;
    }
    function rotateClipCW(c) { return transformClip(c, true); }
    function mirrorClipH(c) { return transformClip(c, false); }

    // Why the blocks of a clip cannot land with the clip's top-left at
    // (x0, y0), or null if they can. A part's core needs empty board that no
    // other part's terminal or kept-bare edge claims (unless the core is
    // empty right there); its own edge needs bare board wherever it says
    // bare, and no mux body on a terminal; and no mux body of it may touch
    // mux body outside it. `grow`: cells off the board are fine (the sandbox
    // grows to take them).
    function clipBlockFits(c, lid, x0, y0, grow) {
        const core = coreInClip(c, lid, x0, y0);
        for (let y = core.y0; y <= core.y1; y++)
            for (let x = core.x0; x <= core.x1; x++) {
                const k = (y - y0) * c.w + (x - x0);
                if (!c.bmap[k] || !clipUnder(c, c.bmap[k], lid)) continue;
                if (!inBounds(x, y)) { if (grow) continue; return 'No room for it here'; }
                const i = idx(x, y);
                if (blockAt[i]) return 'It would sit on another part';
                if (anyLocked && locked[i] === 1) return 'It would sit on a pad';
                if (!isInsulatorId(cells[i])) return 'It needs empty board to sit on';
                if ((ringMask[i] & RING_T) || ((ringMask[i] & RING_R) && !isInsulatorId(c.data[k])))
                    return 'It would sit on another part’s edge';
                if (isGrayId(c.data[k]))
                    for (const [dx, dy] of DIRS) {
                        const nx = x + dx, ny = y + dy, nk = (ny - y0) * c.w + (nx - x0);
                        const mine = nx >= core.x0 && nx <= core.x1 && ny >= core.y0 && ny <= core.y1 && c.bmap[nk] && clipUnder(c, c.bmap[nk], lid);
                        if (!mine && inBounds(nx, ny) && isGrayId(cells[idx(nx, ny)])) return 'Two muxes cannot touch — leave a gap';
                    }
            }
        // Edges may overlap wherever both allow it — bare on bare, anything on
        // free — but a terminal (which a wire will go on) never on a cell
        // another part keeps bare, nor the other way round. Two terminals on
        // one cell are one wire joining both pins, which is fine.
        for (const r of clipRingOf(c, lid, x0, y0).values()) {
            if (!inBounds(r.x, r.y)) continue;
            const i = idx(r.x, r.y);
            if (r.cls === 'R' && !isInsulatorId(cells[i])) return 'Something is in the way of its edge';
            if (r.cls === 'R' && (ringMask[i] & RING_T)) return 'Its edge would cover another part’s terminal';
            if (r.cls === 'T' && (isGrayId(cells[i]) || blockAt[i])) return 'Something is in the way of its terminals';
            if (r.cls === 'T' && (ringMask[i] & RING_R)) return 'Its terminal would be on another part’s edge';
        }
        return null;
    }
    function blockFits(clip, x0, y0, opts) {
        if (!clip.bmap) return null;
        for (const lid of clipTops(clip)) {
            const why = clipBlockFits(clip, lid, x0, y0, !!(opts && opts.grow));
            if (why) return why;
        }
        return null;
    }

    // The fallback, for a level whose wiring cannot be fitted to a tight edge
    // (see fitPart): a part made from everything joined to the given pads —
    // and nothing else, so a doodle in a corner stays behind — trimmed to
    // what that is, with a one-cell margin round it, and each pad turned into
    // wire with a lead run straight out to the margin's edge, where it
    // becomes a pin. It is as big as the board's pads are far apart. `pads`: [{name, dir: 'in'|'out', x, y}], each a single
    // cell (a level's switch or lamp). `rect`, if given, bounds what may be
    // taken. Blocks already on the board come along whole, nested inside
    // the new one. Returns {clip} or {error}.
    //
    // A lead leaves from the pad itself if it can — to the west for an
    // input, the east for an output, the way the pads face — and otherwise
    // from any wire on the pad's net that has a clear run to the edge: a
    // circuit is free to wall its own switch in, running wire round the
    // outside of it, and the pin then comes out of that wire instead.
    function captureBlock(name, source, pads, rect) {
        if (!pads.length) return { error: 'A part needs at least one pin' };
        const within = (x, y) => inBounds(x, y) && (!rect || (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1));
        const padSet = new Set();
        for (const p of pads) {
            if (!within(p.x, p.y)) return { error: 'A pin is outside the part' };
            padSet.add(idx(p.x, p.y));
        }
        const incl = new Set(padSet), stack = [...padSet], takenTops = new Set();
        while (stack.length) {
            const i = stack.pop();
            const x = i % GRID_W, y = (i - x) / GRID_W;
            if (blockAt[i]) {
                const top = topBlockOf(blockAt[i]);
                if (!takenTops.has(top)) {
                    takenTops.add(top);
                    for (const j of blockCellIdxs(top)) {
                        const jx = j % GRID_W, jy = (j - jx) / GRID_W;
                        if (!within(jx, jy)) return { error: 'A part it uses is not wholly inside' };
                        if (!incl.has(j)) { incl.add(j); stack.push(j); }
                    }
                }
                // A block leads anywhere else only through its own pins.
                if (!(pinAt[i] && blockAt[i] === top)) continue;
            }
            for (const [dx, dy] of DIRS) {
                const nx = x + dx, ny = y + dy;
                if (!within(nx, ny)) continue;
                const ni = idx(nx, ny);
                if (incl.has(ni)) continue;
                if (blockAt[ni]) {
                    if (!(pinAt[ni] && blockAt[ni] === topBlockOf(blockAt[ni]))) continue;
                } else if (isInsulatorId(cells[ni])) continue;
                incl.add(ni);
                stack.push(ni);
            }
        }
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const i of incl) {
            const x = i % GRID_W, y = (i - x) / GRID_W;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
        x0--; y0--; x1++; y1++;   // the margin
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const has = (x, y) => incl.has(inBounds(x, y) ? idx(x, y) : -1);
        const onEdge = (x, y, d) => (d === 0 ? y === y0 : d === 1 ? x === x1 : d === 2 ? y === y1 : x === x0);
        // Each pad's way out: straight to the margin's edge, through cells
        // the part does not use, with nothing of the part flush beside it.
        // Where it starts from must be left with at most three wires: with
        // a fourth it would be a crossing, not a junction.
        const leadCells = new Set(), leads = [];
        const clearRun = (sx, sy, d) => {
            const [dx, dy] = DIRS[d], path = [];
            let x = sx, y = sy;
            while (!onEdge(x, y, d)) {
                x += dx; y += dy;
                if (has(x, y) || leadCells.has(x + ',' + y)) return null;
                const side = d % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
                if (side.some(([ex, ey]) => has(x + ex, y + ey) || leadCells.has((x + ex) + ',' + (y + ey)))) return null;
                path.push([x, y]);
            }
            return path.length ? path : null;
        };
        const armsAt = (x, y) => {
            let n = 0;
            for (const [dx, dy] of DIRS) if (has(x + dx, y + dy) && cellConnects(x + dx, y + dy, [-dx, -dy])) n++;
            return n;
        };
        for (let k = 0; k < pads.length; k++) {
            const p = pads[k];
            const order = p.dir === 'out' ? [1, 0, 2, 3] : [3, 0, 2, 1];
            const padIdx = idx(p.x, p.y);
            // The pad first, then the rest of its wire.
            const starts = [padIdx, ...[...netCellsOf(padIdx)].filter((i) =>
                i !== padIdx && incl.has(i) && isConductorId(cells[i]) && !blockAt[i]
                && !isCrossoverAt(i % GRID_W, (i - i % GRID_W) / GRID_W))];
            let found = null;
            for (const d of order) {
                let best = null;
                for (const si of starts) {
                    const sx = si % GRID_W, sy = (si - sx) / GRID_W;
                    if (armsAt(sx, sy) >= 3) continue;
                    const path = clearRun(sx, sy, d);
                    if (path && (!best || path.length < best.path.length)) best = { path, d };
                    if (best && si === padIdx) break;   // the pad itself wins
                }
                if (best) { found = best; break; }
            }
            if (!found) return { error: `Nothing clear around ${p.name} to bring its pin out` };
            for (const [x, y] of found.path) leadCells.add(x + ',' + y);
            leads.push(found);
        }
        const data = new Uint8Array(w * h);
        const bmap = new Int32Array(w * h).fill(1);
        const pmap = new Int16Array(w * h);
        const lidOf = new Map();
        let nextLid = 2;
        for (const i of incl) {
            const x = i % GRID_W, y = (i - x) / GRID_W;
            const k = (y - y0) * w + (x - x0);
            data[k] = padSet.has(i) ? makeConductor(OFF) : stripId(cells[i]);
            if (!blockAt[i]) continue;
            for (let b = blockAt[i]; b; b = blockParent(b)) if (!lidOf.has(b)) lidOf.set(b, nextLid++);
            bmap[k] = lidOf.get(blockAt[i]);
            pmap[k] = pinAt[i];
        }
        const recs = [{ lid: 1, name, source: source || '', parent: 0, open: false, pins: pads.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in' })) }];
        for (const [b, lid] of lidOf) {
            const r = blocks.get(b);
            recs.push({ lid, name: r.name, source: r.source, parent: r.parent ? lidOf.get(r.parent) : 1, open: false, pins: r.pins.map((p) => ({ ...p })) });
        }
        leads.forEach(({ path, d }, k) => {
            for (const [x, y] of path) data[(y - y0) * w + (x - x0)] = makeConductor(OFF);
            const [px, py] = path[path.length - 1];
            pmap[(py - y0) * w + (px - x0)] = pinCode(k, d);
        });
        return { clip: { w, h, data, blocks: recs, bmap, pmap } };
    }

    // ===== Fitting a part =====
    //
    // A part is its core and nothing more: the smallest rectangle holding
    // its muxes, sources and parts, and the wires that only join them to
    // each other. Everything round it is edge (see classifyRing), and the
    // edge is where the terminals are — the wires, switches or lamps that
    // meet the circuit from outside. An inverter is its 3x2 mux and the row
    // of sources under it: 3x3, its input and output wires just outside.
    //
    // `fitPart` finds that rectangle round a circuit on the board. It starts
    // from everything that has to be inside and grows an edge wherever the
    // ring round it holds something it may not: a wire that joins the
    // circuit somewhere that cannot be a pin (a source, the middle of a
    // wire run inside, a part nested in it), one terminal meeting the
    // circuit twice (the meeting nearest where the wire leads is kept), or
    // anything on a cell the edge must keep bare. What lies on the edge's
    // free cells — a wire running past, a test switch — is left outside. One
    // edge at a time, the one with the most trouble, then look again.
    //
    // `region` bounds the core (the board, or a selection — which says where
    // the part may reach, so a selection of just the core is enough); the
    // ring round it may sit a cell outside, off the board included (off the
    // board is bare). `pads`, in a level, are its switches and lamps: each must
    // meet exactly one terminal, which takes its name. Without pads — the
    // sandbox — a terminal is anything on the ring that meets the circuit.
    // Returns {core, ring, pins: [{x, y, hx, hy, d, side, dir, name?}],
    // edge: [{x, y, cls, pin}]}, or {error, cells}.
    const SIDE_OF_FACE = ['n', 'e', 's', 'w'];
    function fitPart(region, pads) {
        const r0 = normalizeRect(region.x0, region.y0, region.x1, region.y1);
        const inRegion = (x, y) => x >= r0.x0 && x <= r0.x1 && y >= r0.y0 && y <= r0.y1;
        const fail = (error, list) => ({ error, cells: list || [] });
        const padAt = new Map();
        if (pads) for (const p of pads) padAt.set(idx(p.x, p.y), p);
        const isFixture = (i) => !blockAt[i] && (isToggle(cells[i]) || isSwitch(cells[i]) || isLed(cells[i]));
        const xy = (i) => [i % GRID_W, (i - i % GRID_W) / GRID_W];
        const connectsWay = (x, y, dx, dy) => inBounds(x, y) && inBounds(x + dx, y + dy)
            && cellConnects(x, y, [dx, dy]) && cellConnects(x + dx, y + dy, [-dx, -dy]);

        // What has to be inside: muxes, sources, parts.
        const core = new Set(), tops = new Set();
        for (let y = r0.y0; y <= r0.y1; y++)
            for (let x = r0.x0; x <= r0.x1; x++) {
                const i = idx(x, y), id = cells[i];
                if (blockAt[i]) { core.add(i); tops.add(topBlockOf(blockAt[i])); continue; }
                if (isGrayId(id) || id === ID_POS || id === ID_NEG) core.add(i);
                else if (pads && isFixture(i) && !padAt.has(i))
                    return fail('Only the level’s own switches and lamps can be on the board', [[x, y]]);
            }
        for (const t of tops)
            for (const j of blockCellIdxs(t)) {
                const [jx, jy] = xy(j);
                if (!inRegion(jx, jy)) return fail('A part it uses is not wholly inside', [[jx, jy]]);
            }
        if (!core.size) return fail('There is nothing here to make a part of: a part needs a mux or a part inside it');

        // Every wire net: what it touches, where it leads. (Wires on the
        // ring just outside the region count: that is where terminals are.)
        const netOf = new Map(), nets = [];
        for (let y = r0.y0 - 1; y <= r0.y1 + 1; y++)
            for (let x = r0.x0 - 1; x <= r0.x1 + 1; x++) {
                if (!inBounds(x, y)) continue;
                const i = idx(x, y);
                if (netOf.has(i) || !isWireId(cells[i]) || blockAt[i]) continue;
                const net = { id: nets.length, cells: [i], core: false, out: false, ext: [], leaves: false };
                nets.push(net);
                netOf.set(i, net.id);
                walkNet(i, (ci, through) => {
                    if (through) {
                        if (!netOf.has(ci)) netOf.set(ci, net.id);
                        net.cells.push(ci);
                        const [cx, cy] = xy(ci);
                        if (!inRegion(cx, cy)) net.leaves = true;
                        return false;
                    }
                    if (core.has(ci)) {
                        net.core = true;
                        const r = roles[ci];
                        if (r && r.macro && r.kind === 'comMiddle' && idx(r.macro.comCell[0], r.macro.comCell[1]) === ci) net.out = true;
                        if (blockAt[ci] && pinAt[ci]) {
                            const rec = blocks.get(blockAt[ci]);
                            const pin = rec && rec.pins[pinIndex(pinAt[ci])];
                            if (pin && pin.dir === 'out') net.out = true;
                        }
                    } else if (padAt.has(ci) || (!pads && isFixture(ci))) {
                        net.ext.push(ci);
                        if (isLed(cells[ci])) net.out = true;
                    }
                    return false;
                });
            }
        // A pad the core cannot help taking in — a switch whose wire forks
        // right at it, one way up the board and one across, so the fork has
        // to be inside the part — becomes a plain wire junction in the part,
        // with its terminal the cell beyond it on the board's edge side.
        // (Before, that failed the fit, and the level's part fell back to the
        // whole board.) Only where it stays a junction: a switch with at most
        // two wires leaving it, so that wiring its terminal makes a tee and
        // not a crossing; a lamp with one, so no two wires are joined that
        // were not.
        const outwardFace = (p) => (p.face !== undefined ? p.face
            : p.x <= 1 ? 3 : p.x >= GRID_W - 2 ? 1 : p.y <= 1 ? 0 : p.y >= GRID_H - 2 ? 2 : -1);
        const deadEnd = (i) => {
            const [x, y] = xy(i);
            let n = 0;
            for (const [dx, dy] of DIRS) if (connectsWay(x, y, dx, dy)) n++;
            return n <= 1;
        };
        for (const net of nets) {
            net.pin = net.core && (net.ext.length > 0 || net.leaves || (!pads && net.cells.some(deadEnd)));
            if (pads && net.ext.length > 1) {
                const names = net.ext.map((i) => padAt.get(i).name);
                return fail(`${names.join(' and ')} are wired together`, net.ext.map(xy));
            }
        }
        // How far each wire of a terminal is from where it leads — to pick,
        // when a terminal meets the circuit twice, the meeting that is really
        // its way in.
        const dist = new Map();
        for (const net of nets) {
            if (!net.pin) continue;
            const inNet = new Set(net.cells), queue = [];
            for (const ci of net.cells) {
                const [cx, cy] = xy(ci);
                const ends = !inRegion(cx, cy) || (!pads && deadEnd(ci))
                    || DIRS.some(([dx, dy]) => inBounds(cx + dx, cy + dy) && net.ext.includes(idx(cx + dx, cy + dy)));
                if (ends) { dist.set(ci, 0); queue.push(ci); }
            }
            for (let q = 0; q < queue.length; q++) {
                const ci = queue[q], [cx, cy] = xy(ci);
                for (const [dx, dy] of DIRS) {
                    const nx = cx + dx, ny = cy + dy;
                    if (!inBounds(nx, ny)) continue;
                    const ni = idx(nx, ny);
                    if (!inNet.has(ni) || dist.has(ni)) continue;
                    dist.set(ni, dist.get(ci) + 1);
                    queue.push(ni);
                }
            }
        }

        // Start from everything that must be inside.
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        const take = (i) => {
            const [x, y] = xy(i);
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
            if (y < by0) by0 = y;
            if (y > by1) by1 = y;
        };
        for (const i of core) take(i);
        for (const net of nets) if (net.core && !net.pin) for (const ci of net.cells) take(ci);
        const C = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
        const bound = { n: 'y0', s: 'y1', w: 'x0', e: 'x1' };
        const roomy = () => C.x0 >= r0.x0 && C.y0 >= r0.y0 && C.x1 <= r0.x1 && C.y1 <= r0.y1;

        for (let iter = 0; iter < 4 * (GRID_W + GRID_H); iter++) {
            const grow = { n: 0, e: 0, s: 0, w: 0 }, bad = [];
            const inC = (x, y) => x >= C.x0 && x <= C.x1 && y >= C.y0 && y <= C.y1;
            const junction = new Map();     // pad cell taken in -> the face its terminal is on
            for (let y = C.y0; y <= C.y1; y++)
                for (let x = C.x0; x <= C.x1; x++) {
                    if (!inBounds(x, y)) continue;
                    const i = idx(x, y);
                    if (padAt.has(i)) {
                        const p = padAt.get(i), f = outwardFace(p);
                        const inner = DIRS.filter(([dx, dy], d) => d !== f && connectsWay(x, y, dx, dy)).length;
                        if (f >= 0 && !inC(x + DIRS[f][0], y + DIRS[f][1]) && inner <= (p.dir === 'out' ? 1 : 2)) {
                            junction.set(i, f);
                            continue;
                        }
                    }
                    if (padAt.has(i) || isFixture(i)) return fail('A switch or lamp is in the way of the part', [[x, y]]);
                }
            const ring = [];
            for (let x = C.x0 - 1; x <= C.x1 + 1; x++) { ring.push([x, C.y0 - 1]); ring.push([x, C.y1 + 1]); }
            for (let y = C.y0; y <= C.y1; y++) { ring.push([C.x0 - 1, y]); ring.push([C.x1 + 1, y]); }
            const sideOf = (x, y) => (y < C.y0 ? 'n' : y > C.y1 ? 's' : x < C.x0 ? 'w' : 'e');
            const flag = (x, y, why) => { grow[sideOf(x, y)] += 1; bad.push([x, y, why]); };
            const terms = [], others = [];
            for (const [x, y] of ring) {
                const corner = (x < C.x0 || x > C.x1) && (y < C.y0 || y > C.y1);
                // The core cell it faces, and the face.
                const hx = Math.min(Math.max(x, C.x0), C.x1), hy = Math.min(Math.max(y, C.y0), C.y1);
                const d = DIRS.findIndex(([dx, dy]) => hx + dx === x && hy + dy === y);
                const hi = !corner && inBounds(hx, hy) ? idx(hx, hy) : -1;
                // A pad taken in has its terminal here, wired or not — off
                // the board, for a pad on its very edge.
                const jt = hi >= 0 && junction.get(hi) === d;
                if (!inBounds(x, y)) {
                    if (jt) {
                        const pad = padAt.get(hi);
                        terms.push({ x, y, hx, hy, d, side: SIDE_OF_FACE[d], key: 'p' + hi, pad, out: pad.dir === 'out', i: -1, jt });
                    }
                    continue;
                }
                const i = idx(x, y);
                const blank = isInsulatorId(cells[i]) && !blockAt[i];
                if (corner) { if (!blank) others.push([x, y]); continue; }
                const hid = cells[hi];
                // So does a wire of a terminal's that ends at the core's
                // edge pointing straight out: in the sandbox a wire end is a
                // terminal, and when the core has had to grow over the
                // stub drawn to mark one — past a crossing right behind it,
                // which cannot be a pin (unwired, it would turn into a tee
                // and join its two wires) — the terminal is the cell beyond
                // the stub's end, still to be wired.
                const st = !pads && blank && !jt && isWireId(hid) && !isCrossoverAt(hx, hy) && !blockAt[hi]
                    && netOf.has(hi) && nets[netOf.get(hi)].pin
                    && DIRS.every(([dx, dy], k) => connectsWay(hx, hy, dx, dy) === (k === (d + 2) % 4));
                if (blank && !jt && !st) continue;
                if (!jt && !st && !connectsWay(hx, hy, DIRS[d][0], DIRS[d][1])) { others.push([x, y]); continue; }
                if (blockAt[hi] || blockAt[i]) { flag(x, y, 'part'); continue; }
                const wireHost = (isWireId(hid) && !isCrossoverAt(hx, hy)) || junction.has(hi);
                if (!wireHost && !isGrayId(hid)) { flag(x, y, 'solid'); continue; }
                // What it leads to: in a level, one of the pads.
                let key, pad = null, out = false;
                if (jt) { pad = padAt.get(hi); key = 'p' + hi; }
                else if (st) { const net = nets[netOf.get(hi)]; key = 'n' + net.id; out = net.out; }
                else if (padAt.has(i)) { pad = padAt.get(i); key = 'p' + i; }
                else if (isWireId(cells[i])) {
                    const net = nets[netOf.get(i)];
                    if (!net) { flag(x, y, 'stray'); continue; }
                    if (pads) {
                        if (!net.ext.length) { flag(x, y, 'not a terminal'); continue; }
                        pad = padAt.get(net.ext[0]);
                        key = 'p' + net.ext[0];
                    } else key = 'n' + net.id;
                    out = net.out;
                } else if (!pads && isFixture(i)) { key = 'f' + i; out = isLed(cells[i]); }
                else { flag(x, y, 'solid'); continue; }
                if (isGrayId(hid)) {
                    const r = roles[hi];
                    if (r && r.macro && r.macro.comCell[0] === hx && r.macro.comCell[1] === hy) out = true;
                }
                terms.push({ x, y, hx, hy, d, side: SIDE_OF_FACE[d], key, pad, out, i, jt, st });
            }
            // One meeting per terminal: the one nearest where its wire leads
            // (a pad taken in is where it leads). A stub's end is only the
            // terminal when its wire meets the ring nowhere else, and a
            // second stub end is just a stub.
            const byKey = new Map();
            for (const t of terms) { if (!byKey.has(t.key)) byKey.set(t.key, []); byKey.get(t.key).push(t); }
            const pins = [];
            const far = (t) => (t.jt ? -1 : dist.has(t.i) ? dist.get(t.i) : 1e9);
            for (const all of byKey.values()) {
                const met = all.filter((t) => !t.st), list = met.length ? met : all.slice(0, 1);
                list.sort((a, b) => far(a) - far(b));
                pins.push(list[0]);
                for (const t of list.slice(1)) flag(t.x, t.y, 'twice');
            }
            let edge = null;
            if (!bad.length) {
                // Whatever else is on the ring must be on cells nothing
                // inside cares about.
                edge = classifyRing(coreOnBoard(C, 0, pins.map((p, k) => ({
                    hx: p.hx, hy: p.hy, d: p.d, k, dir: p.pad ? p.pad.dir : (p.out ? 'out' : 'in'),
                })), new Set(junction.keys())));
                for (const [x, y] of others) {
                    const e = edge.get(x + ',' + y);
                    if (e && e.cls !== 'X') flag(x, y, 'kept bare');
                }
            }
            if (!bad.length) {
                if (pads) {
                    for (const p of pads)
                        if (!pins.some((q) => q.pad === p)) return fail(`${p.name} never meets the part`, [[p.x, p.y]]);
                    pins.sort((a, b) => pads.indexOf(a.pad) - pads.indexOf(b.pad));
                }
                if (!pins.length) return fail('Nothing meets it from outside: a part needs at least one terminal', []);
                return {
                    core: { x0: C.x0, y0: C.y0, x1: C.x1, y1: C.y1 },
                    ring: { x0: C.x0 - 1, y0: C.y0 - 1, x1: C.x1 + 1, y1: C.y1 + 1 },
                    pins: pins.map((p) => ({
                        x: p.x, y: p.y, hx: p.hx, hy: p.hy, d: p.d, side: p.side,
                        dir: p.pad ? p.pad.dir : (p.out ? 'out' : 'in'),
                        name: p.pad ? p.pad.name : undefined, pad: p.pad || undefined,
                    })),
                    edge: [...edge.values()].map((e) => ({ x: e.x, y: e.y, cls: e.cls, pin: e.pin })),
                    // Pads taken in, which the part has as plain wire.
                    junctions: [...junction.keys()].map(xy),
                };
            }
            // One edge at a time — the one with the most trouble — and look
            // again: growing one edge often clears another's trouble too.
            const order = ['n', 'e', 's', 'w'].filter((s) => grow[s] > 0).sort((a, b) => grow[b] - grow[a]);
            let grew = false;
            for (const s of order) {
                C[bound[s]] += s === 'n' || s === 'w' ? -1 : 1;
                if (roomy()) { grew = true; break; }
                C[bound[s]] -= s === 'n' || s === 'w' ? -1 : 1;
            }
            if (!grew) return fail('Something against it could not be taken inside — there is no room left', bad.map(([x, y]) => [x, y]));
        }
        return fail('Could not find an edge for it');
    }

    // Make a fitted core a part right where it is: its cells become the
    // part's, parts already inside it nest in it, and its pins are
    // recorded ([{hx, hy, d, name, dir}]). What is round it stays as it was —
    // the fit has already made sure that suits the new part's edge. Returns
    // the new block's id.
    function capPart(r, pins, name, source) {
        const id = nextBlockId++;
        blocks.set(id, {
            id, name, source: source || '', parent: 0, open: false,
            pins: pins.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in' })),
        });
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++) {
                if (!inBounds(x, y)) continue;
                const i = idx(x, y);
                if (!blockAt[i]) { blockAt[i] = id; pinAt[i] = 0; continue; }
                const t = topBlockOf(blockAt[i]);
                if (t !== id) blocks.get(t).parent = id;
            }
        pins.forEach((p, k) => { pinAt[idx(p.hx, p.hy)] = pinCode(k, p.d); });
        recomputeRoles();
        return id;
    }

    // The part a fitted core makes: every cell of it, parts nested inside
    // coming along whole, and `pins` ([{hx, hy, d, name, dir}]) as its pins,
    // in order — each a core cell and the face it meets the outside by.
    // `junctions` ([[x, y]], from the fit) are pads it took in, which the
    // part has as plain wire.
    function captureRect(r, pins, name, source, junctions) {
        const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
        const data = new Uint8Array(w * h), bmap = new Int32Array(w * h).fill(1), pmap = new Int16Array(w * h);
        const lidOf = new Map();
        let nextLid = 2;
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++) {
                if (!inBounds(x, y)) continue;
                const i = idx(x, y), k = (y - r.y0) * w + (x - r.x0);
                data[k] = stripId(cells[i]);
                if (!blockAt[i]) continue;
                for (let b = blockAt[i]; b; b = blockParent(b)) if (!lidOf.has(b)) lidOf.set(b, nextLid++);
                bmap[k] = lidOf.get(blockAt[i]);
                pmap[k] = pinAt[i];
            }
        const recs = [{
            lid: 1, name, source: source || '', parent: 0, open: false,
            pins: pins.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in' })),
        }];
        for (const [b, lid] of lidOf) {
            const rec = blocks.get(b);
            recs.push({
                lid, name: rec.name, source: rec.source, open: false,
                parent: rec.parent && lidOf.has(rec.parent) ? lidOf.get(rec.parent) : 1,
                pins: rec.pins.map((p) => ({ ...p })),
            });
        }
        for (const [x, y] of junctions || [])
            if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) data[(y - r.y0) * w + (x - r.x0)] = ID_CONDUCTOR_BASE;
        pins.forEach((p, k) => { pmap[(p.hy - r.y0) * w + (p.hx - r.x0)] = pinCode(k, p.d); });
        return { w, h, data, blocks: recs, bmap, pmap };
    }

    // A wire pixel whose four orthogonal neighbors are all wires is a
    // crossover: the two axes pass over each other without connecting. Purely
    // geometric, so both the simulation and the renderer agree the instant the
    // fourth arm is drawn (before any step converts the id to an xover form).
    function isCrossoverAt(x, y) {
        if (!isWireId(getCell(x, y))) return false;
        return isWireId(getCell(x, y - 1)) && isWireId(getCell(x + 1, y)) &&
               isWireId(getCell(x, y + 1)) && isWireId(getCell(x - 1, y));
    }

    // Whether the cell at (x,y) is something a wire visually/electrically
    // joins onto — used to decide which of a wire pixel's four sides should
    // actually be drawn reaching toward that neighbor (see view.js's thin-
    // wire rendering) rather than filling the whole cell regardless of what,
    // if anything, is actually there. Mirrors contribCharge's notion of "does
    // this cell conduct" but direction-agnostic and boolean: a crossover's
    // two axes are kept separate for charge, but both still read as "wire is
    // here" for this shape/connectivity purpose.
    // `out`, when given, is the direction from (x,y) toward whoever is
    // asking. Only a box mux cares: its cells connect on one face and are
    // package everywhere else, so a neighbor that asks direction-agnostically
    // gets "yes" from a pin it is merely sitting beside. That is what turned
    // a wire elbowing past a pin into a tee with an arm buried in the
    // plastic. Everything else here is per-cell and ignores `out`.
    function cellConnects(x, y, out) {
        if (!inBounds(x, y)) return false;
        const id = cells[idx(x, y)];
        if (isInsulatorId(id)) return false;
        if (isConductorId(id) || isXover(id)) return true;
        if (id === ID_POS || id === ID_NEG) return true;
        if (isLed(id) || isSwitch(id) || isToggle(id)) return true;
        if (isGrayId(id)) {
            const role = roles[idx(x, y)];
            if (!role) return false;
            // A mux cell connects only where it actually has a lead — its
            // four live faces are the four the view draws leads on, and the
            // rest of the outline is package. Mux material that is not a
            // solid 3x2 has no leads at all: it is inert until it is a part.
            if (!role.lead) return false;
            return !out || (role.lead[0] === out[0] && role.lead[1] === out[1]);
        }
        return false;
    }

    // ===== Painting =====
    // Colors: 'insulator', 'conductor', 'gray', 'pos', 'neg', 'led',
    // 'switch', 'toggle'
    function idForColor(color) {
        switch (color) {
            case 'conductor': return makeConductor(OFF);
            case 'gray': return makeGray(OFF, false);
            case 'pos': return ID_POS;
            case 'neg': return ID_NEG;
            case 'led': return makeLed(OFF);
            case 'switch': return ID_SWITCH_OFF;
            case 'toggle': return ID_TOGGLE_OFF;
            default: return ID_INSULATOR_PLAIN;
        }
    }
    function paintCell(x, y, color) { paintCells([[x, y]], color); }
    // Several cells in one go, re-reading the board once at the end — a
    // stroke joined up across a fast drag can be dozens of cells.
    //
    // Nothing is painted over mux body. A mux is a solid 3x2 and nothing
    // else is: a wire drawn into one leaves five cells of material that is
    // no part at all. If a wire has to go where a mux is, the mux is erased
    // (the eraser takes it whole) or moved first. Erasing — painting bare
    // substrate — is the one paint that may touch it.
    function paintCells(list, color) {
        const id = idForColor(color);
        let any = false;
        for (const [x, y] of list) {
            if (!inBounds(x, y) || isProtected(x, y)) continue;
            if (isGrayId(id) && isTerminalCell(x, y)) continue;
            if (!isInsulatorId(id) && !isGrayId(id) && isGrayId(cells[idx(x, y)])) continue;
            cells[idx(x, y)] = id;
            any = true;
        }
        if (any) recomputeRoles();
    }

    function colorOfCell(id) {
        if (isGrayId(id)) return 'gray';
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
            cells[idx(cx, cy)] = target;
            for (const [dx, dy] of NEIGHBORS_8) {
                const nx = cx + dx, ny = cy + dy;
                if (!inBounds(nx, ny) || seen.has(idx(nx, ny)) || !memberFn(cells[idx(nx, ny)])) continue;
                seen.add(idx(nx, ny));
                stack.push([nx, ny]);
            }
        }
    }

    // Momentary switch: press/release the whole pad. Toggle: flip the whole pad.
    // Both are interaction (not structural edits, so not recorded for undo).
    // Each returns true only if the touched cell was that kind.
    function setSwitch(x, y, pressed) {
        if (!inBounds(x, y) || !isSwitch(cells[idx(x, y)])) return false;
        floodPad(x, y, isSwitch, pressed ? ID_SWITCH_ON : ID_SWITCH_OFF);
        return true;
    }
    function toggleAt(x, y) {
        if (!inBounds(x, y) || !isToggle(cells[idx(x, y)])) return false;
        floodPad(x, y, isToggle, toggleIsOn(cells[idx(x, y)]) ? ID_TOGGLE_OFF : ID_TOGGLE_ON);
        return true;
    }
    // Absolute form of toggleAt, for driving a level's input pads to a test
    // vector: a flip would depend on where the previous case left the pad.
    function setToggle(x, y, on) {
        if (!inBounds(x, y) || !isToggle(cells[idx(x, y)])) return false;
        floodPad(x, y, isToggle, on ? ID_TOGGLE_ON : ID_TOGGLE_OFF);
        return true;
    }

    // ===== Mux macro detection =====
    //
    // One shape: a solid 3x2 of body (gray) pixels, at any of the 4
    // orientations, wired into a mux by what touches its faces (see
    // buildBoxMux). Gray that isn't a 3x2 is inert: a part not finished yet.
    //
    // Detection runs on the whole grid after every edit (grids here are
    // small enough - tens of columns - that a full rescan is cheap).

    const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N, E, S, W
    function axisOf(dx, dy) { return dx !== 0 ? AXIS_H : AXIS_V; }
    function neighborSpec(x, y, dx, dy) { return [x + dx, y + dy, axisOf(dx, dy)]; }

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

    function recomputeRoles() {
        computeBlockGeom();
        roles.fill(null);
        const grayVisited = new Set();
        for (let y = 0; y < GRID_H; y++) {
            for (let x = 0; x < GRID_W; x++) {
                const i = idx(x, y);
                if (grayVisited.has(i)) continue;
                if (!isGrayId(cells[i])) continue;
                const blob = floodFill(x, y, (nx, ny) => isGrayId(cells[idx(nx, ny)]), grayVisited);
                // A solid 3x2 is a mux; any other gray blob is mux material
                // that is not a part yet. It connects to nothing, drives
                // nothing and reads nothing — it used to act as a -V source,
                // which let a mux you were half-way through drawing pull
                // down whatever wire it touched.
                if (buildBoxMux(blob)) continue;
                for (const [bx, by] of blob) roles[idx(bx, by)] = { kind: 'isolatedGray' };
            }
        }
        computeRingMask();
        prunePendingLinks();
    }

    // ===== Pending links (the ratsnest) =====
    //
    // A connection a rearrange could not keep. Rather than refuse the whole
    // drag — which used to leave you nudging a part around wondering which
    // of its wires was the problem — the move goes through and what it owes
    // is drawn as a straight dashed line, the way a PCB tool shows an
    // unrouted airwire. Draw the wire yourself and the line goes away.
    //
    // Transient by design: this is the one thing here NOT derivable from the
    // pixels, so it is session state rather than something serialized. A
    // link survives until it is satisfied or one of its ends stops being
    // connectable at all.
    var pendingLinks = [];

    // May the walk continue from `a` into `b`, or does `b` end the net? Wire
    // always continues. So does another cell of the same multi-cell NODE — a
    // pad is one terminal however many cells it spans, and so is a mux's COM
    // row. Everything else is where a net stops: two pins of the same mux are
    // separate nodes and must never read as joined.
    function passesThrough(a, b) {
        if (isWireId(cells[b])) return true;
        const ia = cells[a], ib = cells[b];
        if (isLed(ia) && isLed(ib)) return true;
        if (isSwitch(ia) && isSwitch(ib)) return true;
        if (isToggle(ia) && isToggle(ib)) return true;
        const ra = roles[a], rb = roles[b];
        return !!(ra && rb && ra.macro && ra.macro === rb.macro &&
            ra.kind === 'comMiddle' && rb.kind === 'comMiddle');
    }

    // Is `to` in the same electrical net as `from`? Walks wire and whole
    // multi-cell nodes, and enters a cell only through a face that actually
    // connects — a mux is reachable through its leads and nowhere else.
    // A crossing passes STRAIGHT through. A 4-way junction of wire is not a
    // junction in this world, it is two runs going over each other, so the
    // walk carries the direction it arrived by and may only leave a crossover
    // the way it came in. Turning a corner there had the whole machinery
    // believe two nets that merely cross were joined: a drag that cut a
    // connection and laid a route across the remains reported nothing owed,
    // and the circuit quietly stopped working. `hit(cell, through)` is called
    // for every cell reached — `through` says whether the walk continues past
    // it — and returning true stops the walk.
    //
    // A block's edge is where a walk stops, unless it is `electrical`: seen
    // from outside, a block's pins are terminals like a mux's leads — what
    // is inside is the block's business, and a re-route or a pruning pass
    // that followed its wires in would rewire a part it cannot see. A walk
    // that starts ON a pin stands outside the block, facing out. The coach
    // asks electrically (reaches), since for "does A get to Q" the wire
    // through a part is as good as any other.
    function walkNet(fromIdx, hit, electrical) {
        const fx = fromIdx % GRID_W, fy = (fromIdx - fx) / GRID_W;
        const ctx = electrical ? -1 : (pinAt[fromIdx] ? blockParent(blockAt[fromIdx]) : blockAt[fromIdx]);
        const seen = new Set(), stack = [];
        for (let d = 0; d < 4; d++) stack.push([fx, fy, d]);
        while (stack.length) {
            const [x, y, d] = stack.pop();
            const [dx, dy] = DIRS[d];
            const nx = x + dx, ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            const ci = idx(x, y), ni = idx(nx, ny);
            if (!cellConnects(x, y, [dx, dy]) || !cellConnects(nx, ny, [-dx, -dy])) continue;
            const cross = isCrossoverAt(nx, ny);
            const key = cross ? ni + (dx !== 0 ? 'h' : 'v') : ni;
            if (seen.has(key)) continue;
            seen.add(key);
            const through = passesThrough(ci, ni) && (ctx < 0 || blockAt[ni] === ctx);
            if (hit(ni, through)) return true;
            if (!through) continue;
            if (cross) { stack.push([nx, ny, d]); continue; }
            for (let nd = 0; nd < 4; nd++) stack.push([nx, ny, nd]);
        }
        return false;
    }

    function netReaches(fromIdx, toIdx) {
        if (fromIdx === toIdx) return true;
        return walkNet(fromIdx, (ci) => ci === toIdx);
    }

    // Coordinate form of netReaches, for callers outside the model (the
    // campaign's step-by-step coach): is (x1,y1) on the net (x0,y0) drives?
    function reaches(x0, y0, x1, y1) {
        if (!inBounds(x0, y0) || !inBounds(x1, y1)) return false;
        const a = idx(x0, y0), b = idx(x1, y1);
        return a === b || walkNet(a, (ci) => ci === b, true);
    }

    // How many muxes are on the board, those inside parts included — what a
    // level that asks for no more than so many counts.
    function muxCount() {
        const seen = new Set();
        for (let i = 0; i < roles.length; i++) {
            const r = roles[i];
            if (r && (r.macro || r.frame)) seen.add(r.macro || r.frame);
        }
        return seen.size;
    }

    // Every 3x2 part on the board and how far along it is: 'idle' (nothing
    // wired yet), 'frame' (COM side known, no SELECT — `com` given) or 'mux'
    // (working), with a working part's terminal cells. Each terminal is the mux's own
    // cell whose lead faces out, so reaches() from it walks out through the
    // lead.
    function parts() {
        const out = [], seen = new Set();
        for (let i = 0; i < roles.length; i++) {
            const r = roles[i];
            if (!r || blockAt[i]) continue;
            if (r.macro) {
                const m = r.macro;
                if (seen.has(m)) continue;
                seen.add(m);
                const no = m.selIsFirst ? m.pinFirst : m.pinLast;
                const nc = m.selIsFirst ? m.pinLast : m.pinFirst;
                out.push({ state: 'mux', sel: m.selCorner.slice(), com: m.comCell.slice(), no: no.slice(), nc: nc.slice() });
            } else if (r.frame) {
                const f = r.frame;
                if (seen.has(f)) continue;
                seen.add(f);
                // Once the COM side is known, so is COM.
                if (r.kind === 'boxIdle') out.push({ state: 'idle' });
                else out.push({ state: 'frame', com: [f.rowStart[0] + f.along[0], f.rowStart[1] + f.along[1]] });
            }
        }
        return out;
    }

    // Every cell electrically joined to `from`, itself included — the same
    // walk netReaches does, run to completion instead of stopping at a target.
    //
    // Only cells the walk PASSES THROUGH are in it. A cell it merely arrives
    // at is where the net ends, and that cell belongs to whatever is on the
    // other side: an LED does not conduct, so two runs meeting the same lamp
    // are two nets, and counting the lamp in both had them read as touching.
    // The ratsnest drew the resulting link as a dot.
    function netCellsOf(fromIdx) {
        const out = new Set([fromIdx]);
        walkNet(fromIdx, (ci, through) => { if (through) out.add(ci); return false; });
        return out;
    }

    // A name for the thing an endpoint sits on, the same from either end: the
    // lowest cell of the WIRE it is attached to, or the cell itself when it
    // has no wire. Naming it by the whole net instead does not commute — a
    // mux pin's net takes in the run soldered to its lead, while that run's
    // net stops short of the pin — so the same owed connection got two
    // different names depending on which end it was filed under, and came out
    // as two dashed lines lying on top of each other.
    function wireNetKey(ci) {
        let m = -1;
        for (const c of netCellsOf(ci)) if (isWireId(cells[c]) && (m < 0 || c < m)) m = c;
        return m < 0 ? ci : m;
    }

    // Does this net end on anything — a pad, a pin, a source?
    function netHasTerminal(net) {
        for (const ci of net) {
            if (!isWireId(cells[ci])) return true;
            const cx = ci % GRID_W, cy = (ci - cx) / GRID_W;
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx, ny = cy + dy;
                if (!inBounds(nx, ny)) continue;
                const ni = idx(nx, ny);
                if (isWireId(cells[ni]) && blockAt[ni] === blockAt[ci]) continue;
                if (cellConnects(cx, cy, [dx, dy]) && cellConnects(nx, ny, [-dx, -dy])) return true;
            }
        }
        return false;
    }

    // Wire that reaches no terminal at all — a run joined to nothing at
    // either end. Not the same as a dangling stub, which still has a pad or a
    // pin on one end and is a perfectly ordinary thing to have drawn; this is
    // the piece a move can cut adrift when it absorbs the middle of a run or
    // gives up half way through re-routing one, and it is pure litter.
    function orphanWire() {
        const out = new Set(), seen = new Set();
        for (let i = 0; i < cells.length; i++) {
            // A block's wiring is its own business: never litter.
            if (!isWireId(cells[i]) || seen.has(i) || blockAt[i]) continue;
            const net = netCellsOf(i);
            for (const ci of net) seen.add(ci);
            if (!netHasTerminal(net)) for (const ci of net) out.add(ci);
        }
        return out;
    }

    function prunePendingLinks() {
        if (!pendingLinks.length) return;
        const live = ([a, b]) => {
            const ax = a % GRID_W, ay = (a - ax) / GRID_W;
            const bx = b % GRID_W, by = (b - bx) / GRID_W;
            if (!cellConnects(ax, ay) || !cellConnects(bx, by)) return false; // an end was erased
            return !netReaches(a, b);                                         // or it got joined
        };
        // One line per pair of NETS. Links are owed by one move at a time but
        // outlive it, and editing the board rearranges what is joined to
        // what, so two links laid down separately can end up saying the same
        // thing — a net drawn out to meet a second pin now owes that pin and
        // its neighbour the same single connection.
        const seen = new Set();
        const single = ([a, b]) => {
            const ka = wireNetKey(a), kb = wireNetKey(b);
            if (ka === kb) return false;
            const k = Math.min(ka, kb) + ':' + Math.max(ka, kb);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        };
        pendingLinks = pendingLinks.filter((l) => live(l) && single(l));
    }

    // Endpoint form for the view, in fractional cells.
    //
    // A link is stored between two TERMINALS — the mux lead and the pad or
    // pin at the far end — because those are the two things that are still
    // the same thing after an edit. What it is DRAWN between is the closest
    // approach of the two NETS those terminals sit on: the connection is owed
    // to the net, not to the pad at the end of it, so the line should land on
    // the wire you have already run rather than fly past it to the pad. That
    // also makes the ratsnest live while you draw — each cell of wire you add
    // toward the part shortens the line, until it touches and the link goes.
    //
    // A mux terminal reports at its lead's FACE rather than its cell centre,
    // so the line starts where the connection would actually land instead of
    // floating inside the package.
    function pendingLinkList() {
        const face = (i) => {
            const x = i % GRID_W, y = (i - i % GRID_W) / GRID_W;
            const role = roles[i];
            if (role && role.lead) return [x + role.lead[0] / 2, y + role.lead[1] / 2];
            return [x, y];
        };
        return pendingLinks.map(([a, b]) => {
            // Copper both sides share is nobody's closest approach. Two runs
            // that meet the same lamp are two nets — a lamp does not conduct —
            // but the lamp's own cells sit on both of them, and letting either
            // side anchor there drew the line as a dot on top of the lamp.
            const A = netCellsOf(a), B = netCellsOf(b);
            const as = [...A].filter((i) => !B.has(i) || i === a);
            const bs = [...B].filter((i) => !A.has(i) || i === b);
            let best = null, bestD = Infinity;
            for (const p of as) {
                const px = p % GRID_W, py = (p - px) / GRID_W;
                for (const q of bs) {
                    const qx = q % GRID_W, qy = (q - qx) / GRID_W;
                    const d = (px - qx) ** 2 + (py - qy) ** 2;
                    if (d < bestD) { bestD = d; best = [p, q]; }
                }
            }
            return best ? [face(best[0]), face(best[1])] : [face(a), face(b)];
        });
    }

    // ===== The mux =====
    //
    // Six gray pixels in a solid 3x2 rectangle, all of it body. It is an
    // unprogrammed part until ONE wire lands on a corner: that single wire is
    // SELECT, and placing it fixes the whole frame, its own role included.
    //
    //          SEL                         SEL
    //           |                           |
    //         +-------------+           +-------------+
    //         | S | COM | . |    or     | . | COM | S |     ...and the same
    //         +-------------+           +-------------+     two with the rows
    //         | O |  .  | C |           | C |  .  | O |     swapped: four
    //         +-------------+           +-------------+     corners, four
    //           |       |                 |       |         frames.
    //          NO      NC                NC      NO
    //
    // A corner's SHORT-side face is the only face that can say everything at
    // once, which is why it is the one that decides:
    //   - the corner's own row is the COM row (COM exits its middle cell),
    //   - the far row holds the two switched pins, at its ends,
    //   - and the corner's end is NO, so select ON bridges the pin below it
    //     and OFF bridges the far one.
    // Four corners, four frames, no defaults and no tie-breaks: with nothing
    // wired the part simply has no orientation yet ('boxIdle'), and is inert
    // until it gets one. If more than one corner is wired the first in scan
    // order wins, and the others are inert package like every other face.
    //
    // That leaves exactly four live faces — SEL, COM, NO, NC — which is what
    // the view draws leads on. Every other face is package.
    //
    // The pin row's middle cell is an inert spacer that holds the sensed
    // select charge — with no cell of its own to keep it in, the select would
    // otherwise have no state, and it is that stored bit that gives the
    // control the same one-tick delay every other signal here has.
    //
    // Roles: the COM row's three cells are 'comMiddle' (they relax as one
    // node), the two pins are 'end', and the spacer is 'boxSel'. rowStart,
    // along and toward frame the part with d=0 the COM row and d=1 the pin
    // row, which is all macroFootprint and objectAt need.
    function buildBoxMux(blob) {
        if (blob.length !== 6) return false;
        const xs = blob.map((c) => c[0]), ys = blob.map((c) => c[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = maxX - minX + 1, h = maxY - minY + 1;
        if (w * h !== 6) return false; // 6 cells filling a 6-cell bbox = solid 3x2
        const along = w === 3 ? [1, 0] : [0, 1];
        const perp = w === 3 ? [0, 1] : [1, 0];
        const neg = ([dx, dy]) => [-dx, -dy];
        const wiredAt = ([x, y], [dx, dy]) => {
            const nx = x + dx, ny = y + dy;
            return inBounds(nx, ny) && cells[idx(nx, ny)] !== ID_INSULATOR_PLAIN;
        };
        const reading = readBox(minX, minY, w, (x, y) => inBounds(x, y) && cells[idx(x, y)] !== ID_INSULATOR_PLAIN);
        const gridAt = (i, d) => [minX + along[0] * i + perp[0] * d, minY + along[1] * i + perp[1] * d];

        const rect = { x: minX, y: minY, w, h };
        const perpOut = (d) => (d === 0 ? neg(perp) : perp); // outward from row d

        // ---- Which row is COM ----
        // A wire at the MIDDLE of a long side is unambiguous — that is the
        // only thing that face can ever be — so it is asked first and settles
        // the axis outright. That ordering matters for more than tidiness: a
        // wire routing past the far row's corner on its way somewhere else
        // also sits on a face that could be read as SELECT, and letting a
        // corner answer first let such a wire spin the whole part around.
        // With COM known, the pin row's corners are simply package.
        //
        // Failing that, a corner's short-side face is the only other face
        // that can say everything at once, so it decides next: its own row is
        // COM. Failing that, a wire at a long side's END says that side holds
        // a pin, so COM is the far side — the axis, with no select.
        // (readBox does the reading, in exactly this order.)
        const comD = reading.comD;
        if (comD === null) {
            // Nothing wired at all: a blank part with no orientation yet,
            // drawn as a plain package and electrically inert. The footprint
            // travels with the role so the view can draw it without an
            // orientation to hang it on.
            const frame = { key: `box:idle:${minX},${minY}`, rect, along, rowStart: null, toward: null, leads: [] };
            for (const [bx, by] of blob) roles[idx(bx, by)] = { kind: 'boxIdle', frame, lead: null };
            return true;
        }

        const towardOf = (d) => (d === 0 ? perp : neg(perp)); // COM row -> pin row

        // ---- Which end is SELECT ----
        // A short-side face of the COM row, and only of the COM row: the pin
        // row's own corners are package, so a wire elbowing past one is just
        // a wire. If both COM-row ends are wired the first wins and the other
        // is an ordinary connection to that end's pin.
        const sel = reading.sel === null ? null
            : { i: reading.sel, d: comD, out: reading.sel === 0 ? neg(along) : along };

        if (!sel) {
            // Oriented but not yet commissioned: COM and both pins are known
            // — enough for the trapezoid and three of its leads — but with no
            // select there is no NO/NC and nothing to switch, so the part
            // stays inert until a corner is wired.
            const t = towardOf(comD), cOut = neg(t);
            const start = gridAt(0, comD);
            const cellAt = (i, d) => [start[0] + along[0] * i + t[0] * d, start[1] + along[1] * i + t[1] * d];
            const frame = {
                key: `box:frame:${start[0]},${start[1]},${t[0]},${t[1]}`,
                rect, along, rowStart: start, toward: t,
                leads: [[cellAt(1, 0), cOut], [cellAt(0, 1), t], [cellAt(2, 1), t]],
            };
            for (let i = 0; i < 3; i++) {
                roles[idx(...cellAt(i, 0))] = { kind: 'boxFrame', frame, lead: i === 1 ? cOut : null };
                roles[idx(...cellAt(i, 1))] = { kind: 'boxFrame', frame, lead: i === 1 ? null : t };
            }
            return true;
        }

        const toward = towardOf(sel.d);                // COM row -> pin row
        const comOut = neg(toward);                    // COM's outward face
        const pinOut = toward;                         // the pins' outward face
        const rowStart = gridAt(0, sel.d);
        const at = (i, d) => [rowStart[0] + along[0] * i + toward[0] * d,
                              rowStart[1] + along[1] * i + toward[1] * d];
        const selIsFirst = sel.i === 0;

        const macro = {
            key:`box:${rowStart[0]},${rowStart[1]},${along[0]},${along[1]},${toward[0]},${toward[1]}`,
            rowStart, along, toward, selIsFirst,
            selCell: at(1, 1),
            selCorner: at(sel.i, 0),
            selOut: sel.out,
            comCell: at(1, 0),
            pinFirst: at(0, 1), pinLast: at(2, 1),
            comOut, pinOut, rect,
            // The four live faces, which are exactly the leads the view draws.
            leads: [[at(sel.i, 0), sel.out], [at(1, 0), comOut],
                    [at(0, 1), pinOut], [at(2, 1), pinOut]],
            nodes: {
                first: { cells: [], ext: [] },
                com: { cells: [], ext: [] },
                last: { cells: [], ext: [] },
            },
        };
        // Every lead faces across the long axis (COM out one long side, the
        // pins out the other), so that is the only axis a box cell ever
        // reports its charge on — and only the cells that actually have one
        // report at all. See contribCharge.
        const reportAxis = axisOf(toward[0], toward[1]);

        for (let i = 0; i < 3; i++) {
            const [cx, cy] = at(i, 0);
            // COM has ONE lead, at the middle of its side; the row's two end
            // cells are package, not extra taps, so the live faces and the
            // drawn leads are the same four things.
            const ext = i === 1 ? [neighborSpec(cx, cy, comOut[0], comOut[1])] : [];
            macro.nodes.com.cells.push([cx, cy]);
            macro.nodes.com.ext.push(...ext);
            const sibs = [];
            if (i > 0) sibs.push(at(i - 1, 0));
            if (i < 2) sibs.push(at(i + 1, 0));
            roles[idx(cx, cy)] = {
                kind: 'comMiddle', macro, external: ext, sibs,
                // Only COM's own middle cell speaks to the outside; the row's
                // ends are package, select corner included (an input).
                reportAxis: i === 1 ? reportAxis : null,
                // COM's gate to a pin is the cell straight across from it;
                // the middle of the COM row faces the inert select spacer
                // and so has no gate at all.
                gates: i === 1 ? [] : [{ pos: at(i, 1), endIsFirst: i === 0 }],
                // Which of this cell's own faces carries a lead, for the view
                // and for cellConnects: the COM lead on the middle, the SEL
                // lead on the chosen corner, nothing on the other end.
                lead: i === 1 ? comOut : (i === sel.i ? sel.out : null),
            };
        }
        for (const i of [0, 2]) {
            const [px, py] = at(i, 1);
            const ext = [neighborSpec(px, py, pinOut[0], pinOut[1])];
            const node = i === 0 ? macro.nodes.first : macro.nodes.last;
            node.cells.push([px, py]);
            node.ext.push(...ext);
            roles[idx(px, py)] = {
                kind: 'end', macro, isFirst: i === 0, external: ext, sibs: [], reportAxis,
                gates: [{ pos: at(i, 0), endIsFirst: i === 0 }],
                lead: pinOut,
            };
        }
        roles[idx(macro.selCell[0], macro.selCell[1])] = { kind: 'boxSel', macro, lead: null };
        return true;
    }

    // ===== Per-tick macro control cache =====
    var macroControlCache = new Map();
    var macroControlCacheTick = -1;

    // liveIsFirst: which end the select wire points at — the NO end, so
    // control ON bridges it and OFF bridges the other (NC). controlOn: the
    // select's own stored charge, one tick behind its input wire like every
    // signal here, kept on the select spacer. activeIsFirst folds the two
    // together into the single fact the body update needs: which end is
    // bridged to COM this tick.
    function getMacroControl(macro) {
        if (macroControlCacheTick !== tickCount) { macroControlCache.clear(); macroControlCacheTick = tickCount; }
        let v = macroControlCache.get(macro.key);
        if (v) return v;
        // Which end is live isn't re-derived from wiring here: the select
        // corner IS the frame (see buildBoxMux), so it's already decided.
        const liveIsFirst = macro.selIsFirst;
        const selId = cells[idx(macro.selCell[0], macro.selCell[1])];
        const controlOn = isGrayId(selId) && grayCharge(selId) === ON;
        v = { liveIsFirst, controlOn, activeIsFirst: controlOn ? liveIsFirst : !liveIsFirst };
        macroControlCache.set(macro.key, v);
        return v;
    }

    // ===== Generic charge contribution (what a cell reports to a neighbor) =====
    function contribCharge(x, y, axis) {
        if (!inBounds(x, y)) return OFF;
        const id = cells[idx(x, y)];
        if (isConductorId(id)) return conductorCharge(id);
        // A crossover reports its vertical charge to N/S queries and its
        // horizontal charge to E/W queries, keeping the two axes separate.
        if (isXover(id)) return axis === AXIS_V ? xoverV(id) : xoverH(id);
        if (id === ID_POS) return ON;
        if (id === ID_NEG) return FALLING;
        // Switch (momentary) and toggle (latching) both drive +V when on and
        // pull down (-V) when off.
        if (isSwitch(id)) return switchIsPressed(id) ? ON : FALLING;
        if (isToggle(id)) return toggleIsOn(id) ? ON : FALLING;
        if (isLed(id)) return OFF; // output sink, never drives
        if (isGrayId(id)) {
            const role = roles[idx(x, y)];
            if (!role) return OFF;
            switch (role.kind) {
                case 'end': case 'comMiddle':
                    // A mux cell reports only on the axis its own lead faces,
                    // and a cell with no lead reports nothing at all: the
                    // four leads are the only way in or out. Without this a
                    // wire laid against the package's plain side would read
                    // COM's charge straight through the plastic, and the
                    // select corner — an input — would drive its own select
                    // line.
                    return role.reportAxis === axis ? grayCharge(id) : OFF;
                default: return OFF; // boxSel, boxIdle/boxFrame, unfinished material
            }
        }
        return OFF;
    }

    // ===== Per-cell-kind next-state =====
    // Handles both plain conductors and crossovers, since which one a wire cell
    // is depends only on its neighbors (isCrossoverAt) and can flip when the
    // user edits an adjacent cell. A crossover keeps N<->S and E<->W separate;
    // a plain conductor is one node taking charge from all four sides.
    function nextConductor(x, y, id) {
        const n = contribCharge(x, y - 1, AXIS_V);
        const e = contribCharge(x + 1, y, AXIS_H);
        const s = contribCharge(x, y + 1, AXIS_V);
        const w = contribCharge(x - 1, y, AXIS_H);
        if (isCrossoverAt(x, y)) {
            const vOld = isXover(id) ? xoverV(id) : isConductorId(id) ? conductorCharge(id) : OFF;
            const hOld = isXover(id) ? xoverH(id) : isConductorId(id) ? conductorCharge(id) : OFF;
            return makeXover(nextCharge(vOld, n, OFF, s, OFF), nextCharge(hOld, OFF, e, OFF, w));
        }
        const cOld = isXover(id) ? combineCharge(xoverV(id), xoverH(id)) : conductorCharge(id);
        return makeConductor(nextCharge(cOld, n, e, s, w));
    }

    // ===== Body node charges (the proven tile-mux algorithm) =====
    //
    // The body's charge TRUTH lives at the level of its three electrical
    // nodes — first end, COM, last end — computed each tick with single
    // nextCharge steps exactly like simulation/pixelogic's mux2 (which stores
    // westCharge/eastCharge/comCharge on its anchor): the active end reads
    // its externals + COM (isolated for one break-before-make tick after a
    // switch), the inactive end reads only its externals, and COM reads the
    // active end + its externals, with a FALLING injected when switching away
    // from a charged end so COM drains instead of latching. Cells then merely
    // ANIMATE toward their node's value (fill spreads as a wavefront, drain
    // fades), so the visible flow is kept but cells cannot sustain dynamics
    // of their own — no circulating electrons, no sticky half-drained nodes.
    var macroBodyCache = new Map();
    var macroBodyCacheTick = -1;

    // A node's current charge, derived from its cells (ON if any cell is ON,
    // else FALLING if any is falling). Derived rather than stored so it
    // survives serialize/undo/paste for free.
    function nodeCharge(node) {
        let v = OFF;
        for (const [cx, cy] of node.cells) {
            const c = grayCharge(cells[idx(cx, cy)]);
            if (c === ON) return ON;
            if (c === FALLING) v = FALLING;
        }
        return v;
    }

    function getMacroBody(macro) {
        if (macroBodyCacheTick !== tickCount) { macroBodyCache.clear(); macroBodyCacheTick = tickCount; }
        let v = macroBodyCache.get(macro.key);
        if (v) return v;
        const { activeIsFirst } = getMacroControl(macro);
        const first = macro.nodes.first, last = macro.nodes.last, com = macro.nodes.com;
        // wasActive is tracked on COM, whose middle cell keeps activeIsFirst
        // in its otherwise-unused wasActive bit (see nextComMiddle).
        const wasCell = com.cells[0];
        const wasFirstActive = grayWasActive(cells[idx(wasCell[0], wasCell[1])]);
        const justSwitched = wasFirstActive !== activeIsFirst;
        const extIn = (node) => node.ext.map(([nx, ny, axis]) => contribCharge(nx, ny, axis));
        const firstCur = nodeCharge(first), lastCur = nodeCharge(last), comCur = nodeCharge(com);
        const aCur = activeIsFirst ? firstCur : lastCur;
        const iCur = activeIsFirst ? lastCur : firstCur;
        // Active end: externals + COM through the open gate (closed on the
        // switching tick). Inactive end: externals only.
        const aNext = nextChargeN(aCur, extIn(activeIsFirst ? first : last).concat(justSwitched ? [] : [comCur]));
        const iNext = nextChargeN(iCur, extIn(activeIsFirst ? last : first));
        // COM: the active end's charge, with the break-before-make falling
        // injection when switching away from a charged end.
        let pinVal = aCur;
        if (justSwitched && iCur === ON && pinVal !== ON) pinVal = FALLING;
        const comNext = nextChargeN(comCur, [pinVal].concat(extIn(com)));
        v = {
            activeIsFirst,
            firstNext: activeIsFirst ? aNext : iNext,
            lastNext: activeIsFirst ? iNext : aNext,
            comNext,
        };
        macroBodyCache.set(macro.key, v);
        return v;
    }

    // Animate one body cell toward its node's next value. Filling spreads as
    // a wave: an OFF cell lights only when adjacent to something already ON
    // (a same-node cell, an external contact, or the cell across an open
    // gate), so charge visibly flows in from where it actually enters.
    // Draining is a fade: ON -> FALLING -> OFF.
    function relaxBodyCell(id, role, target, gateOpen) {
        const cur = grayCharge(id);
        if (target !== ON) return cur === ON ? FALLING : OFF;
        if (cur === ON) return ON;
        if (cur === FALLING) return OFF;
        const seedOn = ([nx, ny, axis]) => contribCharge(nx, ny, axis) === ON;
        if (role.external.some(seedOn)) return ON;
        // Same-node neighbors — COM is a row of three cells. Read directly
        // rather than through contribCharge, which deliberately reports
        // nothing along a box cell's select axis, and that axis is exactly
        // the one the COM row's own cells sit on.
        if (role.sibs && role.sibs.some(([nx, ny]) => grayCharge(cells[idx(nx, ny)]) === ON)) return ON;
        for (const g of role.gates) {
            if (!gateOpen(g)) continue;
            // Read across directly rather than through contribCharge: both
            // sides of a gate are always plain body, and a box cell
            // deliberately reports nothing to the outside except through a
            // lead — including along the very axis these gates sit on.
            if (grayCharge(cells[idx(g.pos[0], g.pos[1])]) === ON) return ON;
        }
        return OFF;
    }

    function nextEnd(x, y, id, role) {
        const body = getMacroBody(role.macro);
        const isActive = role.isFirst === body.activeIsFirst;
        const target = role.isFirst ? body.firstNext : body.lastNext;
        // This end's gate to COM is open only while the end is active.
        const charge = relaxBodyCell(id, role, target, () => isActive);
        return makeGray(charge, isActive);
    }

    function nextComMiddle(x, y, id, role) {
        const body = getMacroBody(role.macro);
        // A COM cell's gate to an end is open only toward the active end.
        const charge = relaxBodyCell(id, role, body.comNext, (g) => g.endIsFirst === body.activeIsFirst);
        // COM's own wasActive bit doesn't mean anything to COM itself, but
        // getMacroBody reads it (off the first COM cell) as the macro-wide
        // "was first active" memory: one place for the whole part to keep it.
        return makeGray(charge, body.activeIsFirst);
    }

    // The select-sense spacer, which is where the select's state lives.
    // It drives nothing (contribCharge reports OFF for it)
    // and only ever reads the LIVE end's select contact, so wiring both ends
    // leaves the dead one ignored rather than ORed in.
    function nextBoxSel(id, role) {
        const m = role.macro;
        const [nx, ny] = [m.selCorner[0] + m.selOut[0], m.selCorner[1] + m.selOut[1]];
        return makeGray(nextCharge(grayCharge(id),
            contribCharge(nx, ny, axisOf(m.selOut[0], m.selOut[1])), OFF, OFF, OFF), false);
    }

    function nextGray(x, y, id) {
        const role = roles[idx(x, y)];
        if (!role) return id;
        // Inert: not a part yet, no orientation yet, or no select yet.
        if (role.kind === 'isolatedGray' || role.kind === 'boxIdle' || role.kind === 'boxFrame')
            return makeGray(OFF, false);
        if (role.kind === 'end') return nextEnd(x, y, id, role);
        if (role.kind === 'comMiddle') return nextComMiddle(x, y, id, role);
        if (role.kind === 'boxSel') return nextBoxSel(id, role);
        return id;
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
        if (!isLed(n)) inputs.push(contribCharge(x, y - 1, AXIS_V));
        if (!isLed(e)) inputs.push(contribCharge(x + 1, y, AXIS_H));
        if (!isLed(s)) inputs.push(contribCharge(x, y + 1, AXIS_V));
        if (!isLed(w)) inputs.push(contribCharge(x - 1, y, AXIS_H));
        return makeLed(nextChargeN(ledCharge(id), inputs));
    }

    function nextState(x, y) {
        const id = cells[idx(x, y)];
        if (isConductorId(id) || isXover(id)) return nextConductor(x, y, id);
        if (id === ID_POS || id === ID_NEG || isSwitch(id) || isToggle(id)) return id; // fixed / set by interaction
        if (isLed(id)) return nextLed(x, y, id);
        if (isGrayId(id)) return nextGray(x, y, id);
        return id; // insulator (inert)
    }

    function stepSimulation() {
        for (let y = 0; y < GRID_H; y++)
            for (let x = 0; x < GRID_W; x++)
                nextCells[idx(x, y)] = nextState(x, y);
        const tmp = cells; cells = nextCells; nextCells = tmp;
        tickCount++;
    }

    // The per-tick mux caches are keyed on tickCount, which starts over at 0
    // on a reset, a clear or a load. Restarting the count without forgetting
    // them let the first tick afterwards reuse whatever the LAST tick 0 had
    // worked out — for a different board, or the same board with different
    // inputs — so one board could step two ways depending on its history.
    // The verifier resets before every test vector, which is exactly the
    // pattern that hits it.
    function restartTicks() {
        tickCount = 0;
        macroControlCacheTick = -1;
        macroBodyCacheTick = -1;
    }

    // A flat cell index re-addressed for a grid whose width changed and whose
    // content moved by (offX, offY). The ratsnest stores flat indices, so it
    // is the one thing that has to be carried across a resize by hand.
    function remapIdx(i, oldW, newW, offX, offY) {
        const x = i % oldW, y = (i - x) / oldW;
        return (y + offY) * newW + (x + offX);
    }

    // Reallocate the cell arrays at a new size, copying existing content offset
    // by (offX, offY). Used both by auto-expansion and by load/undo restoring a
    // different size.
    function resizeGrid(newW, newH, offX, offY, keepContent) {
        const oldW = GRID_W, oldH = GRID_H, old = cells, oldLocked = locked;
        const oldBlockAt = blockAt, oldPinAt = pinAt;
        const newCells = new Uint8Array(newW * newH); // 0 = insulator
        const newLocked = new Uint8Array(newW * newH);
        const newBlockAt = new Int32Array(newW * newH), newPinAt = new Int16Array(newW * newH);
        if (keepContent) {
            for (let y = 0; y < oldH; y++)
                for (let x = 0; x < oldW; x++) {
                    const ni = (y + offY) * newW + (x + offX), oi = y * oldW + x;
                    newCells[ni] = old[oi];
                    newLocked[ni] = oldLocked[oi];
                    newBlockAt[ni] = oldBlockAt[oi];
                    newPinAt[ni] = oldPinAt[oi];
                }
            // Left alone, every owed connection would point at the wrong
            // cells once the width changes, and the next prune would drop it
            // as erased: drawing up against the top or left edge used to make
            // the ratsnest silently vanish.
            pendingLinks = pendingLinks.map((l) => l.map((i) => remapIdx(i, oldW, newW, offX, offY)));
        } else {
            anyLocked = false;  // a wholesale reload brings its own locks, if any
            pendingLinks = [];  // ...and its own ratsnest (a snapshot restores one after)
            blocks = new Map(); // ...and its own blocks
            blockGeom = new Map();
        }
        cells = newCells;
        locked = newLocked;
        blockAt = newBlockAt;
        pinAt = newPinAt;
        ringMask = new Uint8Array(newW * newH);
        nextCells = new Uint8Array(newW * newH);
        roles = new Array(newW * newH).fill(null);
        GRID_W = newW; GRID_H = newH;
    }

    // Auto-grow the grid so drawn content always keeps a 1-cell empty border.
    // Returns how much was added on each side; {left, top} is how far existing
    // content shifted, which the view uses to compensate pan so the drawing
    // doesn't appear to move.
    function expandForBorder() {
        let left = 0, top = 0, right = 0, bottom = 0;
        // A block's margin is empty substrate, but it is the block's.
        const used = (x, y) => cells[idx(x, y)] !== ID_INSULATOR_PLAIN || blockAt[idx(x, y)] !== 0;
        for (let y = 0; y < GRID_H; y++) {
            if (used(0, y)) left = 1;
            if (used(GRID_W - 1, y)) right = 1;
        }
        for (let x = 0; x < GRID_W; x++) {
            if (used(x, 0)) top = 1;
            if (used(x, GRID_H - 1)) bottom = 1;
        }
        if (left || top || right || bottom) {
            resizeGrid(GRID_W + left + right, GRID_H + top + bottom, left, top, true);
            recomputeRoles();
        }
        return { left, top, right, bottom };
    }

    // Grow (never shrink) to at least w x h, adding only on the right and the
    // bottom so no existing cell moves. For an edit that needs more room than
    // the one-cell border provides, such as a region rotated off the edge.
    function growTo(w, h) {
        if (w <= GRID_W && h <= GRID_H) return false;
        resizeGrid(Math.max(w, GRID_W), Math.max(h, GRID_H), 0, 0, true);
        recomputeRoles();
        return true;
    }

    // Grow on any side, never shrinking — for putting a part down that
    // reaches past the sandbox's edge. Returns how much was added where;
    // {left, top} is how far everything moved.
    function growBy(left, top, right, bottom) {
        const g = { left: Math.max(0, left | 0), top: Math.max(0, top | 0), right: Math.max(0, right | 0), bottom: Math.max(0, bottom | 0) };
        if (!g.left && !g.top && !g.right && !g.bottom) return g;
        resizeGrid(GRID_W + g.left + g.right, GRID_H + g.top + g.bottom, g.left, g.top, true);
        recomputeRoles();
        return g;
    }

    // A structural snapshot grown the way expandForBorder just grew the grid
    // (`g` is its return value), for a caller holding a snapshot across an
    // expansion — the floating paste's base. The ratsnest is re-addressed
    // along with the cells, or restoring the base would drop it.
    function growSnapshot(snap, g) {
        const newW = snap.w + g.left + g.right, newH = snap.h + g.top + g.bottom;
        const data = new Uint8Array(newW * newH);
        const b = snap.blocks, at = new Int32Array(newW * newH), pin = new Int16Array(newW * newH);
        for (let y = 0; y < snap.h; y++)
            for (let x = 0; x < snap.w; x++) {
                const ni = (y + g.top) * newW + (x + g.left), oi = y * snap.w + x;
                data[ni] = snap.data[oi];
                if (b) { at[ni] = b.at[oi]; pin[ni] = b.pin[oi]; }
            }
        const links = (snap.links || []).map((l) => l.map((i) => remapIdx(i, snap.w, newW, g.left, g.top)));
        const blocksOut = b ? { at, pin, recs: b.recs.map(copyBlockRec), next: b.next } : null;
        return { w: newW, h: newH, data, links, blocks: blocksOut };
    }

    // With locks in play (a campaign level) "clear" means "clear what the
    // player drew": the board keeps its size and its fixed I/O pads, so
    // starting over doesn't destroy the level's terminals. In the sandbox
    // there are no locks and this is the original full reset.
    function clearGrid() {
        pendingLinks = [];
        if (anyLocked) {
            for (let i = 0; i < cells.length; i++)
                if (locked[i] !== 1) cells[i] = ID_INSULATOR_PLAIN;
            blockAt.fill(0);
            pinAt.fill(0);
            blocks = new Map();
        } else {
            resizeGrid(DEFAULT_W, DEFAULT_H, 0, 0, false);
        }
        restartTicks();
        recomputeRoles();
    }

    function resetCharges() {
        for (let i = 0; i < cells.length; i++) {
            const id = cells[i];
            // Crossovers collapse to a plain conductor; the next tick re-derives
            // the crossover form from geometry.
            if (isConductorId(id) || isXover(id)) cells[i] = makeConductor(OFF);
            else if (isGrayId(id)) cells[i] = makeGray(OFF, false);
            else if (isLed(id)) cells[i] = makeLed(OFF);
            else if (isSwitch(id)) cells[i] = ID_SWITCH_OFF;
            else if (isToggle(id)) cells[i] = ID_TOGGLE_OFF;
        }
        restartTicks();
        recomputeRoles();
    }

    // The board exactly as it stands — live charge, locks and ratsnest
    // included — for running the simulation somewhere and then putting
    // everything back (the campaign verifier). A structural snapshot strips
    // the charge and a serialize leaves out the ratsnest, so neither will do:
    // verifying used to go through serialize, and so quietly depended on a
    // load NOT clearing the owed connections of the board it replaced.
    function getLiveSnapshot() {
        return {
            w: GRID_W, h: GRID_H, cells: cells.slice(), locked: locked.slice(), anyLocked,
            links: pendingLinks.map((l) => l.slice()), tick: tickCount, blocks: blockState(),
        };
    }
    function restoreLiveSnapshot(s) {
        if (s.w !== GRID_W || s.h !== GRID_H) resizeGrid(s.w, s.h, 0, 0, false);
        cells.set(s.cells);
        locked.set(s.locked);
        anyLocked = s.anyLocked;
        restoreBlockState(s.blocks);
        pendingLinks = s.links.map((l) => l.slice());
        restartTicks();
        tickCount = s.tick;
        recomputeRoles();
    }

    // ===== Region editing (selection / clipboard / undo support) =====
    //
    // Structural form = the cell with simulation-computed charge stripped.
    // Crossovers strip to a plain OFF conductor: their crossover-ness is
    // emergent from neighbors (also captured in the snapshot), so it's
    // re-derived on the next tick. Undo snapshots and clipboard clips both use
    // this, so stepping never creates bogus undo steps and pasting duplicates
    // the drawing, not a frozen instant of mid-flight charge.
    function stripId(id) {
        if (isConductorId(id) || isXover(id)) return makeConductor(OFF);
        if (isGrayId(id)) return makeGray(OFF, false);
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
            (id >= ID_GRAY_BASE && id <= ID_TOGGLE_ON);
    }

    // Pending links ride along. They are the one thing here not derivable
    // from the pixels, so a restore that put back only cells left them
    // behind — and a drag restamps on every pointer move (restore the base,
    // re-apply the whole offset), which prunes the links the board already
    // owed as their mux end moves out from under them. Escape, undo and
    // starting a second drag all come through here, and all three want the
    // ratsnest the board had at that moment.
    function getStructuralSnapshot() {
        const data = new Uint8Array(cells.length);
        for (let i = 0; i < cells.length; i++) data[i] = stripId(cells[i]);
        return {
            w: GRID_W, h: GRID_H, data, links: pendingLinks.map((l) => l.slice()),
            blocks: blocks.size ? blockState() : null,
        };
    }

    // When the grid size is unchanged, only touch cells whose structure differs,
    // so unchanged cells keep their live charge instead of flashing back to
    // charge-OFF. When the size differs (undo/redo across an auto-expand),
    // reallocate to the snapshot's size and restore it wholesale.
    function restoreStructuralSnapshot(snap) {
        if (snap.w === GRID_W && snap.h === GRID_H) {
            for (let i = 0; i < cells.length; i++) {
                if (stripId(cells[i]) !== snap.data[i]) cells[i] = snap.data[i];
            }
        } else {
            resizeGrid(snap.w, snap.h, 0, 0, false);
            cells.set(snap.data);
        }
        // A lid is a way of looking, not an edit: a block that is still
        // here after the restore keeps the lid it has now.
        const lids = new Map([...blocks].map(([id, r]) => [id, r.open]));
        restoreBlockState(snap.blocks);
        for (const [id, r] of blocks) if (lids.has(id)) r.open = lids.get(id);
        pendingLinks = (snap.links || []).map((l) => l.slice());
        recomputeRoles();   // prunes anything the restored grid already satisfies
    }

    function normalizeRect(x0, y0, x1, y1) {
        if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
        if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
        return {
            x0: Math.max(0, Math.min(GRID_W - 1, x0)),
            y0: Math.max(0, Math.min(GRID_H - 1, y0)),
            x1: Math.max(0, Math.min(GRID_W - 1, x1)),
            y1: Math.max(0, Math.min(GRID_H - 1, y1)),
        };
    }

    // A block wholly inside the rectangle travels with the clip. One the
    // rectangle cuts through does not: its cells inside come along loose.
    function copyRegion(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
                data[y * w + x] = stripId(cells[idx(r.x0 + x, r.y0 + y)]);
        const clip = { w, h, data };
        const inside = blocksInside(r);
        if (!inside.size) return clip;
        const lid = new Map();
        for (const id of inside) lid.set(id, lid.size + 1);
        const up = (b) => { while (b && !inside.has(b)) b = blockParent(b); return b; };
        clip.blocks = [...inside].map((id) => {
            const rec = blocks.get(id);
            return {
                lid: lid.get(id), name: rec.name, source: rec.source, open: rec.open,
                parent: lid.get(up(rec.parent)) || 0, pins: rec.pins.map((p) => ({ ...p })),
            };
        });
        clip.bmap = new Int32Array(w * h);
        clip.pmap = new Int16Array(w * h);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const i = idx(r.x0 + x, r.y0 + y), b = up(blockAt[i]);
                if (!b) continue;
                clip.bmap[y * w + x] = lid.get(b);
                if (b === blockAt[i]) clip.pmap[y * w + x] = pinAt[i];
            }
        return clip;
    }

    // Blocks wholly inside go with the rectangle. One it only cuts through
    // stays, whole — a part is one thing, and half of one is litter.
    function clearRegion(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        const inside = blocksInside(r);
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++) {
                const i = idx(x, y);
                if (isLocked(x, y)) continue;
                if (blockAt[i] && !inside.has(topBlockOf(blockAt[i]))) continue;
                cells[i] = ID_INSULATOR_PLAIN;
                blockAt[i] = 0;
                pinAt[i] = 0;
            }
        recomputeRoles();
    }

    // Every cell of the mux material blob (4-connected) that (x,y) is part
    // of, or [] if it is not mux material. What an eraser takes when it
    // touches a mux: a part is one thing, and five-sixths of one is litter.
    function grayBlob(x, y) {
        if (!inBounds(x, y) || !isGrayId(cells[idx(x, y)])) return [];
        return floodFill(x, y, (nx, ny) => isGrayId(cells[idx(nx, ny)]), new Set());
    }

    // Erase an arbitrary cell list ([[x,y],...]) — a Rearrange selection,
    // which is a set of objects rather than a rectangle.
    // A block goes only if every cell of it is in the list.
    function clearCells(list) {
        const set = new Set();
        for (const [x, y] of list) if (inBounds(x, y)) set.add(idx(x, y));
        const whole = new Set();
        for (const i of set) {
            if (!blockAt[i]) continue;
            const t = topBlockOf(blockAt[i]);
            if (!whole.has(t) && blockCellIdxs(t).every((j) => set.has(j))) whole.add(t);
        }
        for (const i of set) {
            if (anyLocked && locked[i] === 1) continue;
            if (blockAt[i] && !whole.has(topBlockOf(blockAt[i]))) continue;
            cells[i] = ID_INSULATOR_PLAIN;
            blockAt[i] = 0;
            pinAt[i] = 0;
        }
        recomputeRoles();
    }

    // Writes a clip (from copyRegion, or a stored component) with its
    // top-left corner at (x0, y0), silently clipping whatever falls outside
    // the grid. Data is re-stripped on the way in since components come
    // back from localStorage as untrusted plain arrays.
    //
    // A block in the clip lands whole or not at all: if any cell of it would
    // fall off the board or onto something protected, none of it is written
    // (the count comes back as `skipped`). Pasted blocks get fresh ids.
    function pasteRegion(clip, x0, y0) {
        const recs = clip.blocks && clip.bmap ? clip.blocks : [];
        const parentOf = new Map(recs.map((b) => [b.lid, b.parent]));
        const topOf = (l) => { let n = 0; while (parentOf.get(l) && n++ < recs.length) l = parentOf.get(l); return l; };
        const skip = new Set();
        for (const b of recs) if (!b.parent && clipBlockFits(clip, b.lid, x0, y0, false)) skip.add(b.lid);
        const newId = new Map();
        for (const b of recs) if (!skip.has(topOf(b.lid))) newId.set(b.lid, nextBlockId++);
        for (const b of recs) {
            if (!newId.has(b.lid)) continue;
            blocks.set(newId.get(b.lid), {
                id: newId.get(b.lid), name: b.name, source: b.source || '', open: !!b.open,
                parent: b.parent && newId.has(b.parent) ? newId.get(b.parent) : 0,
                pins: b.pins.map((p) => ({ name: p.name, dir: p.dir })),
            });
        }
        for (let y = 0; y < clip.h; y++) {
            const gy = y0 + y;
            if (gy < 0 || gy >= GRID_H) continue;
            for (let x = 0; x < clip.w; x++) {
                const gx = x0 + x, k = y * clip.w + x;
                const l = recs.length ? clip.bmap[k] : 0;
                if (l && !newId.has(l)) continue;
                if (gx < 0 || gx >= GRID_W || isProtected(gx, gy)) continue;
                const i = idx(gx, gy);
                if (!l && isGrayId(clip.data[k]) && isTerminalCell(gx, gy)) continue;
                cells[i] = stripId(clip.data[k] & 0xff);
                blockAt[i] = l ? newId.get(l) : 0;
                pinAt[i] = l && clip.pmap ? clip.pmap[k] : 0;
            }
        }
        recomputeRoles();
        return { skipped: skip.size };
    }

    // Region rotate/mirror are pure pixel moves — cells here have no stored
    // orientation (mux orientation is an emergent property of the pixel
    // pattern), so unlike simulation/pixelogic there is no per-cell
    // reorientation step. Rotation keeps the region's top-left anchor and
    // swaps its w/h; the new bounds (clipped to the grid) are returned so
    // the caller can update its selection, or null when it was refused.
    // A region holding any locked cell can't be rotated or mirrored: the
    // transform would slide a fixed I/O pad off its coordinates. Refusing the
    // whole operation is the honest answer — silently transforming everything
    // *except* the pad would scramble the circuit around it.
    // A block counts as locked unless the whole of it is inside, in which
    // case it simply turns with everything else.
    function regionHasLocked(r) {
        const inside = blocksInside(r);
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++) {
                const i = idx(x, y);
                if (anyLocked && locked[i] === 1) return true;
                if (blockAt[i] && !inside.has(topBlockOf(blockAt[i]))) return true;
            }
        return false;
    }

    // Turned, a w x h region is h wide and w tall from the same corner, so a
    // non-square one reaches past its own rectangle — and everything it turns
    // INTO has to be free: on the board, unlocked, and empty. Rotating used to
    // write the clip straight over whatever was there, blank cells and all,
    // which erased circuitry outside the selection (in a level, a locked pad
    // too) and dropped whatever turned off the edge of the grid.
    function rotateFits(r) {
        const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
        for (let y = r.y0; y < r.y0 + w; y++)
            for (let x = r.x0; x < r.x0 + h; x++) {
                if (x <= r.x1 && y <= r.y1) continue; // inside the source: it moves anyway
                if (!inBounds(x, y) || isProtected(x, y) || !isInsulatorId(cells[idx(x, y)])) return false;
            }
        return true;
    }

    function rotateRegionCW(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        if (regionHasLocked(r) || !rotateFits(r)) return null;
        const before = getStructuralSnapshot();
        const clip = copyRegion(r.x0, r.y0, r.x1, r.y1);
        for (let y = r.y0; y <= r.y1; y++)
            for (let x = r.x0; x <= r.x1; x++) {
                const i = idx(x, y);
                cells[i] = ID_INSULATOR_PLAIN;
                blockAt[i] = 0;
                pinAt[i] = 0;
            }
        recomputeRoles();   // the edges of what was lifted go with it
        pasteRegion(rotateClipCW(clip), r.x0, r.y0);
        // Turned, something may now sit where a part's edge keeps bare.
        if (ringViolations().length) { restoreStructuralSnapshot(before); return null; }
        return { x0: r.x0, y0: r.y0, x1: r.x0 + clip.h - 1, y1: r.y0 + clip.w - 1 };
    }

    // Returns false when refused (the region holds a locked pad).
    function mirrorRegionH(x0, y0, x1, y1) {
        const r = normalizeRect(x0, y0, x1, y1);
        if (regionHasLocked(r)) return false;
        const before = getStructuralSnapshot();
        for (let y = r.y0; y <= r.y1; y++) {
            for (let lo = r.x0, hi = r.x1; lo <= hi; lo++, hi--) {
                const li = idx(lo, y), hi2 = idx(hi, y);
                const a = stripId(cells[li]), b = stripId(cells[hi2]);
                cells[li] = b;
                cells[hi2] = a;
                const ba = blockAt[li], pa = pinAt[li];
                blockAt[li] = blockAt[hi2]; pinAt[li] = mirrorPinCode(pinAt[hi2]);
                blockAt[hi2] = ba; pinAt[hi2] = mirrorPinCode(pa);
            }
        }
        recomputeRoles();
        if (ringViolations().length) { restoreStructuralSnapshot(before); return false; }
        return true;
    }

    // ===== Rearrange: whole-object move/rotate that keeps connectivity =====
    //
    // objectAt identifies the movable "object" under a cell at the
    // granularity a user actually thinks in: a whole commissioned mux (with
    // the contact soldered to each lead, see macroFootprint), a gray blob
    // that is not a working part (an unwired package, or unfinished
    // material), an LED/switch/toggle pad (8-connected,
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
                if (!inBounds(nx, ny) || seen.has(idx(nx, ny)) || !memberFn(cells[idx(nx, ny)])) continue;
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
    // This is not a convenience. A mux has no stored orientation: which side
    // is COM, which end is SELECT, which pin is NO — all of it is read back
    // off what touches its faces. Leave those contacts behind and a dragged
    // part arrives having forgotten what it was, or worse, re-reads itself
    // from whatever the re-router happened to lay nearby. Carrying one cell
    // per lead means the frame travels WITH the part by construction, and
    // only the long haul back to the rest of each net is left to re-route —
    // which is exactly what a pending link is for when it cannot.
    //
    // A contact shared with a second mux stays put: taking it along would
    // silently unhook the other part, which is a worse surprise.
    function macroFootprint(macro) {
        const out = [];
        for (let i = 0; i < 3; i++) {
            const gx = macro.rowStart[0] + macro.along[0] * i, gy = macro.rowStart[1] + macro.along[1] * i;
            out.push([gx, gy], [gx + macro.toward[0], gy + macro.toward[1]]);
        }
        for (const [[cx, cy], [ox, oy]] of macro.leads) {
            const sx = cx + ox, sy = cy + oy;
            if (!inBounds(sx, sy)) continue;
            const id = cells[idx(sx, sy)];
            const takeable = id === ID_POS || id === ID_NEG ||
                (isConductorId(id) && !isCrossoverAt(sx, sy));
            if (!takeable || leadsFacing(sx, sy) > 1 || blockAt[idx(sx, sy)]) continue;

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
            if (!inBounds(nx, ny) || !isGrayId(cells[idx(nx, ny)])) continue;
            const role = roles[idx(nx, ny)];
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
            while (isWireId(getCell(cx, cy)) && !blockAt[idx(cx, cy)]) {
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
        if (blockAt[idx(x, y)]) {
            const t = topBlockOf(blockAt[idx(x, y)]);
            return { kind: 'block', id: t, cells: blockCellIdxs(t).map((i) => [i % GRID_W, (i - i % GRID_W) / GRID_W]) };
        }
        const id = cells[idx(x, y)];
        if (isInsulatorId(id)) return null;
        const role = roles[idx(x, y)];
        if (role && role.macro) return { kind: 'mux', cells: macroFootprint(role.macro) };
        if (id === ID_POS || id === ID_NEG) return { kind: 'source', cells: [[x, y]] };
        if (isWireId(id)) return { kind: 'wire', cells: wireSegmentAt(x, y) };
        if (isGrayId(id)) return { kind: 'blob', cells: floodFill(x, y, (nx, ny) => isGrayId(cells[idx(nx, ny)]), new Set()) };
        if (isLed(id)) return { kind: 'pad', cells: flood8(x, y, isLed) };
        if (isSwitch(id)) return { kind: 'pad', cells: flood8(x, y, isSwitch) };
        if (isToggle(id)) return { kind: 'pad', cells: flood8(x, y, isToggle) };
        return null;
    }

    // Rigid transform for a move gesture: rotate quarterTurns times 90° CW
    // about the object's bounding-box center (the bbox's w/h swap and the
    // center is kept put, rounded on half-cell ties), then translate. Cells
    // here carry no orientation of their own — a mux's orientation is
    // emergent from the pixel pattern — so moving the pixels IS the whole
    // transform.
    function transformObjectCells(objCells, dx, dy, quarterTurns) {
        let pts = objCells.map(([x, y]) => [x, y]);
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

    // The electrical net reachable from a wire cell, walked over the CURRENT
    // grid (call after lifting the object, so the walk sees only the
    // stationary world): plain conductors spread all four ways, a crossover
    // only passes straight through (its two axes are separate nets), and
    // every non-wire connecting neighbor is recorded as a terminal
    // (pin/pad/source) rather than entered. Crossover cells are
    // pass-throughs, not members — you can't attach to one axis of a
    // crossover by adjacency anyway. (entryDx/entryDy: the direction the
    // walk enters the first cell with, in case that cell is itself a
    // crossover.)
    // `xo` says which cells are crossings (default: the board's own test); a
    // move passes one that remembers the crossings it started with.
    function floodNet(ax, ay, entryDx, entryDy, xo) {
        const crossing = xo || isCrossoverAt;
        const cellsOut = new Set(), terminals = new Set(), seen = new Set();
        const stack = [[ax, ay, entryDx, entryDy]];
        while (stack.length) {
            const [x, y, dx2, dy2] = stack.pop();
            if (!inBounds(x, y)) continue;
            const i = idx(x, y);
            // A block's pin is a terminal from out here (see walkNet).
            if (!isWireId(cells[i]) || blockAt[i]) {
                // Reached from (dx2,dy2), so this cell must connect on the
                // face pointing back that way — a wire lying against a mux's
                // package is not attached to it.
                if (cellConnects(x, y, [-dx2, -dy2])) terminals.add(i);
                continue;
            }
            if (crossing(x, y)) {
                const k = i + (dx2 !== 0 ? ':h' : ':v');
                if (seen.has(k)) continue;
                seen.add(k);
                stack.push([x + dx2, y + dy2, dx2, dy2]);
                continue;
            }
            if (seen.has(i)) continue;
            seen.add(i);
            cellsOut.add(i);
            for (const [ddx, ddy] of DIRS) stack.push([x + ddx, y + ddy, ddx, ddy]);
        }
        let min = Infinity;
        for (const i of cellsOut) if (i < min) min = i;
        if (min === Infinity) for (const i of terminals) if (i < min) min = i;
        return {
            key: 'w' + (min === Infinity ? idx(ax, ay) : min), cells: cellsOut, terminals,
            isNet: true, preTouch: new Set(), routed: new Set(), failed: false,
        };
    }

    // Every terminal on the board — anything that connects and is not wire:
    // a mux's leads, a pad (as a whole), a source, a part's pin — with the
    // group it is wired into: Map terminal id -> group id. Terminals join
    // through a wire net they both touch (on a face that connects), or by
    // touching each other directly. Ids go through `mapIdx`, so a board
    // after a move can be compared cell for cell with the board before.
    function terminalGroups(mapIdx) {
        const parent = new Map();
        const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
        const padKey = new Map();
        const termId = (i) => {
            const id = cells[i];
            if (!(isLed(id) || isSwitch(id) || isToggle(id))) return 'c' + mapIdx(i);
            if (!padKey.has(i)) {
                const x = i % GRID_W, y = (i - x) / GRID_W, n = anchorNode(x, y);
                let min = Infinity;
                for (const c of n.cells) min = Math.min(min, mapIdx(c));
                for (const c of n.cells) padKey.set(c, 'p' + min);
            }
            return padKey.get(i);
        };
        const add = (t) => { if (!parent.has(t)) parent.set(t, t); return t; };
        const isTerm = (i) => !isInsulatorId(cells[i]) && (!isWireId(cells[i]) || blockAt[i]);
        const seenWire = new Set();
        for (let i = 0; i < cells.length; i++) {
            const x = i % GRID_W, y = (i - x) / GRID_W;
            if (isTerm(i)) {
                if (!cellConnects(x, y)) continue;
                const t = add(termId(i));
                // Terminals touching one another directly: a source on a pin.
                for (const [dx, dy] of [[1, 0], [0, 1]]) {
                    const nx = x + dx, ny = y + dy;
                    if (!inBounds(nx, ny) || !isTerm(idx(nx, ny))) continue;
                    if (cellConnects(x, y, [dx, dy]) && cellConnects(nx, ny, [-dx, -dy])) union(t, add(termId(idx(nx, ny))));
                }
                continue;
            }
            if (seenWire.has(i) || !isWireId(cells[i]) || isCrossoverAt(x, y)) continue;
            const net = floodNet(x, y, 0, 0);
            for (const c of net.cells) seenWire.add(c);
            let first = null;
            for (const ti of net.terminals) {
                const t = add(termId(ti));
                if (first === null) first = t; else union(first, t);
            }
        }
        const out = new Map();
        for (const t of parent.keys()) out.set(t, find(t));
        return out;
    }

    // The stationary electrical node a non-wire contact belongs to: a pad
    // (LED/switch/toggle) is its whole 8-connected clump, anything else —
    // a mux pin, a source — is its own single cell.
    function anchorNode(ax, ay) {
        const id = cells[idx(ax, ay)];
        const pad = isLed(id) ? isLed : isSwitch(id) ? isSwitch : isToggle(id) ? isToggle : null;
        // isNet:false — these carry no wire of their own, so the shrink pass
        // has nothing to prune here.
        const extra = { isNet: false, preTouch: new Set(), routed: new Set(), failed: false };
        if (!pad) return Object.assign({ key: 'n' + idx(ax, ay), cells: new Set([idx(ax, ay)]), terminals: new Set() }, extra);
        const set = new Set(flood8(ax, ay, pad).map(([x, y]) => idx(x, y)));
        let min = Infinity;
        for (const i of set) if (i < min) min = i;
        return Object.assign({ key: 'p' + min, cells: set, terminals: new Set() }, extra);
    }

    // Which cells of a net are surplus to requirement: everything whose
    // removal still leaves every anchor it has to tie together mutually
    // connected. That covers dead ends (a tail's removal disconnects
    // nothing) AND redundant loops — a doubled-back run where each cell has
    // two neighbours, so pure leaf-pruning can never unpick it, which is
    // what a drag alongside a net's own wire used to leave behind.
    //
    // Removal is farthest-anchor-first so that when a loop is broken it's
    // the long way round that goes and the direct connection that stays.
    // The result is irreducible rather than provably minimal — good enough,
    // and it can't disconnect anything by construction. Cells in `keep` are
    // never removed and must stay reachable, so a stub the user drew (or a
    // loop they drew) survives with its connection to the net intact.
    // Pure analysis — the caller decides what to actually erase.
    function reduceNet(netSet, requiredSet, keep, nodeId) {
        const live = new Set(netSet);
        const held = new Set([...(keep || [])].filter((ci) => live.has(ci)));
        const removed = new Set();
        const neighborsIn = (ci, set) => {
            const x = ci % GRID_W, y = (ci - x) / GRID_W, out = [];
            for (const [dx2, dy2] of DIRS) {
                const nx = x + dx2, ny = y + dy2;
                if (!inBounds(nx, ny)) continue;
                // Touching a mux is not joining it: it meets wire only
                // through a lead, so a run lying against its package on a
                // dead face holds nothing on — read as attached, it was kept
                // as a stub hugging the part. (Only a mux: anything else
                // here is joined all round, or is an object cell lifted for
                // the move, which reads as empty board.)
                if (set.has(idx(nx, ny))) {
                    const deadA = isGrayId(cells[ci]) && !cellConnects(x, y, [dx2, dy2]);
                    const deadB = isGrayId(cells[idx(nx, ny)]) && !cellConnects(nx, ny, [-dx2, -dy2]);
                    if (!deadA && !deadB) out.push(idx(nx, ny));
                    continue;
                }
                // A crossover belonging to some OTHER net is a pass-through:
                // the cell straight beyond it continues this same axis of
                // this net. Without this a route that crosses something reads
                // as two disconnected halves and gets reduced away as joining
                // nothing to nothing. Restricted to cells outside this net,
                // since a 4-way junction of the net's own wire is an ordinary
                // member here, not a bridge to jump over.
                if (!netSet.has(idx(nx, ny)) && isCrossoverAt(nx, ny)) {
                    const fx = nx + dx2, fy = ny + dy2;
                    if (inBounds(fx, fy) && set.has(idx(fx, fy))) out.push(idx(fx, fy));
                }
            }
            return out;
        };
        // Anchors are the things whose interconnection must survive: the
        // required cells the net touches, plus the protected cells
        // themselves — wire the user drew has to keep whatever attachment it
        // had, or the pass could strand it by cutting the run that feeds it.
        const anchors = [...requiredSet].filter((ri) => neighborsIn(ri, live).length > 0)
            .concat([...held]);
        const idOf = (ci) => (held.has(ci) ? 'h' + ci : nodeId(ci));
        // Which anchors can currently reach which, as a canonical string. The
        // rule is to PRESERVE this, not to require one connected whole: a net
        // whose middle the object just absorbed arrives here in two pieces,
        // and reduction still has useful work to do within each.
        // What must be preserved is which electrical NODE reaches which —
        // not which cell. Anchor cells are grouped by node (every cell of a
        // dragged wire is one node; each mux pin its own; a pad's cells one
        // between them), because a run reconnecting two cells the object
        // already joins internally is exactly the redundant doubling this
        // pass exists to remove. And what a node must keep reaching is the
        // OTHER nodes: one that ties to nothing else needs no wire at all,
        // so "reaches none" and "detached" are the same state — treating
        // them as different left an orphan cell clinging to every pin.
        const groupsOf = (set) => {
            const reach = new Map();
            for (const a of anchors) {
                const na = idOf(a);
                if (!reach.has(na)) reach.set(na, new Set());
                const ns = neighborsIn(a, set);
                if (!ns.length) continue;
                const seen = new Set(ns), stack = [...ns];
                while (stack.length) {
                    const c = stack.pop();
                    for (const n of neighborsIn(c, set)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
                }
                for (const b of anchors) {
                    const nb = idOf(b);
                    if (nb !== na && neighborsIn(b, seen).length) reach.get(na).add(nb);
                }
            }
            return [...reach.entries()].map(([k, v]) => k + ':' + [...v].sort().join(','))
                .sort().join('|');
        };
        const baseline = groupsOf(live);
        const holds = (set) => groupsOf(set) === baseline;
        for (;;) {
            const dist = new Map(), queue = [];
            for (const a of anchors) for (const n of neighborsIn(a, live)) if (!dist.has(n)) { dist.set(n, 1); queue.push(n); }
            if (!anchors.length) for (const h of held) if (!dist.has(h)) { dist.set(h, 0); queue.push(h); }
            for (let qi = 0; qi < queue.length; qi++) {
                const c = queue[qi];
                for (const n of neighborsIn(c, live)) if (!dist.has(n)) { dist.set(n, dist.get(c) + 1); queue.push(n); }
            }
            // A cell next to a crossover is load-bearing: take it away and
            // the crossing drops from four neighbours to three, which is no
            // longer two independent axes but a tee welding them together.
            const nearCrossing = (ci) => {
                const x = ci % GRID_W, y = (ci - x) / GRID_W;
                return DIRS.some(([dx2, dy2]) => isCrossoverAt(x + dx2, y + dy2));
            };
            // ...unless its partner across the crossing goes too: the
            // crossing's other run then passes a plain wire. A dead branch
            // that ran through a crossing used to be left standing, a stub
            // on each side, because neither arm could go alone.
            const across = (ci) => {
                const x = ci % GRID_W, y = (ci - x) / GRID_W;
                for (const [dx2, dy2] of DIRS) {
                    if (!isCrossoverAt(x + dx2, y + dy2)) continue;
                    const o = idx(x + 2 * dx2, y + 2 * dy2);
                    return inBounds(x + 2 * dx2, y + 2 * dy2) && live.has(o) && !held.has(o) ? o : -1;
                }
                return -1;
            };
            const cand = [...live].filter((ci) => !held.has(ci) && (!nearCrossing(ci) || across(ci) >= 0))
                .sort((a, b) => (dist.has(b) ? dist.get(b) : Infinity) - (dist.has(a) ? dist.get(a) : Infinity));
            let did = false;
            for (const ci of cand) {
                const pair = nearCrossing(ci) ? across(ci) : -1;
                if (nearCrossing(ci) && pair < 0) continue;
                live.delete(ci);
                if (pair >= 0) live.delete(pair);
                if (holds(live)) { removed.add(ci); if (pair >= 0) removed.add(pair); did = true; break; }
                live.add(ci);
                if (pair >= 0) live.add(pair);
            }
            if (!did) break;
        }
        return removed;
    }

    // Shortest free path from ANY of a net's cells to ANY cell of the target
    // node, preferring straight runs (a turn costs a fraction of a step).
    //
    // The search runs over (cell, travel direction) states and validates
    // EDGES rather than cells: at each step, the two neighbors the path
    // neither arrives from nor leaves by must not touch anything conductive.
    // That single rule buys both of the things this router needs:
    //
    //  - It cannot tee into anything it passes — including its OWN net. An
    //    earlier version allowed hugging the net it came from, which let it
    //    lay a second path right alongside the existing run: that reads as a
    //    loop, and it also strands the old run (now two-connected everywhere)
    //    where the shrink pass can no longer prune it.
    //  - It CAN cross an existing wire head-on, because the crossed cell
    //    sits in the excluded "came from"/"going to" slots. A straight run
    //    crossed at right angles picks up the path's cells as its other pair
    //    of neighbors and becomes a 4-way crossover, which this world
    //    already keeps electrically separate per axis (isCrossoverAt) — so
    //    the crossing costs the circuit nothing and opens up routes that
    //    would otherwise dead-end and report as unroutable.
    //
    // Touching the net's own TERMINALS (its pads, pins and sources) stays
    // legal throughout: a pad is one node however many of its cells the path
    // brushes, so that can't fork the net the way running beside its wire
    // can — and forbidding it would wall a route in against the very pad it
    // is leaving. The path's first cell may additionally touch the net's
    // wire, since that is the connection being made.
    // Returns the list of cells to fill with conductor, or null.
    const ROUTE_STEP_COST = 16;  // turn penalty is 1, so length dominates
    const ROUTE_CROSS_COST = 64; // a crossing is legal, but prefer a short detour
    const OPP = (d) => (d + 2) % 4;
    // How far a route actually had to span, measured on its OWN two ends —
    // not on the closest pair of cells in the two nets it joins. Those nets
    // can be long: a seed may sit one cell from a target and still be the
    // wrong end to start from, and judging the route against THAT distance
    // condemns every legitimate long haul. What matters is whether this path
    // wandered between the points it actually connects.
    function pathSpan(path) {
        if (!path || !path.length) return 0;
        const [ax, ay] = path[0], [bx, by] = path[path.length - 1];
        return Math.abs(ax - bx) + Math.abs(ay - by);
    }
    // Tuned so an ordinary detour around one obstacle still routes, while a
    // lap of the board does not. Held fairly tight on purpose: a route much
    // longer than the gap it bridges is not a connection the user would
    // recognise as theirs, it is decoration, and a dashed line they can draw
    // where they actually want it is the better answer. On the move sweep,
    // 1.6 let 29 moves add 21 or more cells of wire; 1.25 lets 22, and costs
    // four of 1351 moves their automatic re-route.
    const ROUTE_SLACK = 3, ROUTE_STRETCH = 1.25;
    function routeNet(seedIdxs, targetSet, netCells, terminalCells, volatileCells) {
        const free = (x, y) => inBounds(x, y) && isInsulatorId(cells[idx(x, y)]) && !blockAt[idx(x, y)]
            && !(ringMask[idx(x, y)] & RING_R);
        // A mux gets a one-cell berth on EVERY face. All of them say what the
        // part is: a wire at a long side's middle declares that side COM, at
        // its end declares a pin, and one on a short side declares SELECT —
        // which is the end that decides NO from NC. A route grazing any of
        // them on its way past can spin the part around or swap its pins,
        // and the short sides are not the harmless case they look like.
        //
        // Routes may still END on a terminal: that is the `dOut` direction,
        // which is never side-checked. Hand-drawing alongside a package stays
        // legal; this only constrains what the re-router lays down unasked.
        //
        // All mux material gets the berth, not only working parts. An unwired
        // package is read by exactly this — a route past the middle of its
        // long side would orient it — and unfinished material becomes a part
        // the moment it is completed, reading whatever was laid beside it.
        const bumpsPackage = (x, y) => isGrayId(cells[idx(x, y)]);
        const sidesClear = (x, y, dIn, dOut, allowed) => {
            for (let d = 0; d < 4; d++) {
                if (d === OPP(dIn) || d === dOut) continue; // where the path came from / goes
                const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
                if (!inBounds(nx, ny)) continue;
                if (bumpsPackage(nx, ny) && !allowed.has(idx(nx, ny))) return false;
                // Deliberately direction-agnostic: a route must not run
                // flush along ANY terminal it isn't ending on, whichever
                // face that terminal happens to present.
                if (!cellConnects(nx, ny)) continue;
                if (!allowed.has(idx(nx, ny))) return false;
            }
            return true;
        };
        // Note targetSet is deliberately NOT blanket-allowed: the step that
        // reaches the target already excludes the direction it steps in, so
        // the path meets its node at exactly one cell instead of being free
        // to run the length of it (which, for a multi-cell object like a
        // dragged wire, laid a parallel run right beside it — a loop).
        const openAllowed = new Set(terminalCells);
        const firstAllowed = new Set([...openAllowed, ...netCells]);
        // Dijkstra over (cell, incoming direction) with a bucket queue —
        // costs are small bounded integers, so buckets beat a real heap.
        const skey = (i, d) => i * 4 + d;
        const dist = new Map(), prev = new Map();
        const buckets = [];
        const push = (cost, i, d, from_) => {
            const k = skey(i, d);
            if (dist.get(k) !== undefined && dist.get(k) <= cost) return;
            dist.set(k, cost);
            prev.set(k, from_);
            (buckets[cost] || (buckets[cost] = [])).push([i, d]);
        };
        const rebuild = (k) => {
            const out = [];
            for (let cur = k; cur !== -1; cur = prev.get(cur)) out.push(Math.floor(cur / 4));
            return out.reverse().map((ci) => [ci % GRID_W, Math.floor(ci / GRID_W)]);
        };
        for (const si of seedIdxs) {
            const sx = si % GRID_W, sy = (si - sx) / GRID_W;
            for (let d = 0; d < 4; d++) {
                const nx = sx + DIRS[d][0], ny = sy + DIRS[d][1];
                if (free(nx, ny)) push(ROUTE_STEP_COST, idx(nx, ny), d, -1);
            }
        }
        for (let cost = 0; cost < buckets.length; cost++) {
            const bucket = buckets[cost];
            if (!bucket) continue;
            for (const [i, d] of bucket) {
                const k = skey(i, d);
                if (dist.get(k) !== cost) continue; // superseded by a cheaper entry
                const x = i % GRID_W, y = (i - x) / GRID_W;
                // Only the path's own first cell may touch the net it leaves.
                const allowed = prev.get(k) === -1 ? firstAllowed : openAllowed;
                for (let nd = 0; nd < 4; nd++) {
                    if (nd === OPP(d)) continue; // no doubling back
                    if (!sidesClear(x, y, d, nd, allowed)) continue;
                    const turn = nd === d ? 0 : 1;
                    const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
                    if (!inBounds(nx, ny)) continue;
                    if (targetSet.has(idx(nx, ny))) return rebuild(k);
                    if (free(nx, ny)) { push(cost + ROUTE_STEP_COST + turn, idx(nx, ny), nd, k); continue; }
                    // Cross straight through a perpendicular run (-> 4-way
                    // crossover). Both of the crossed cell's side neighbors
                    // must already be wires, so the crossing really is a
                    // crossing and not a tee onto some wire's dead end.
                    if (!isWireId(cells[idx(nx, ny)])) continue;
                    // Only ever cross a net that is standing still. Crossing
                    // one this same move is re-contracting means the cell
                    // relied on can be reduced away underneath the crossing,
                    // quietly severing it.
                    if (volatileCells.has(idx(nx, ny))) continue;
                    const perp = nd % 2 === 0 ? [1, 3] : [0, 2];
                    if (!perp.every((q) => isWireId(getCell(nx + DIRS[q][0], ny + DIRS[q][1])))) continue;
                    const bx = nx + DIRS[nd][0], by = ny + DIRS[nd][1];
                    if (!free(bx, by)) continue; // must land clear on the far side
                    push(cost + 2 * ROUTE_STEP_COST + ROUTE_CROSS_COST + turn, idx(bx, by), nd, k);
                }
            }
        }
        return null;
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
    function moveObject(objCells, dx, dy, quarterTurns) {
        const res = moveObjects([{ cells: objCells }], dx, dy, quarterTurns);
        return res.ok ? { ok: true, cells: res.objects[0].cells, unrouted: res.unrouted, pending: res.pending } : res;
    }

    // Move a GROUP as one rigid piece. Everything below is driven by a
    // per-cell node key rather than a single "is this a mux" flag: within a
    // mux each cell is its own electrical node (its pins must not be welded
    // to each other), while any other object is one node however many cells
    // it has — and in a group each object contributes its own. That one map
    // is what lets a mixed selection of muxes, wires and pads move together
    // without their contracts getting confused.
    // Returns {ok, objects:[{cells}] in input order, unrouted}.
    function moveObjects(objectList, dx, dy, quarterTurns) {
        // Within a mux each cell is its own node. A box mux's COM row shares
        // the 'comMiddle' KIND across all three of its cells — the row relaxes
        // as one for charge — but they are not one terminal: the middle is
        // COM, one corner is SELECT, and SELECT is an input that must never
        // read as joined to the output. Keying them together merged the two
        // contracts, so a re-route for COM was free to land on SELECT's wire
        // (and then get pruned again, taking COM's connection with it).
        // Which cell is which comes off the macro, not the kind.
        //
        // A carried contact cell (see macroFootprint) belongs to the node of
        // the lead it is soldered to, not to one of its own. Give it its own
        // and COM plus COM's own stub read as two nodes touching, which is a
        // weld — the object would refuse to move at all.
        const muxNodeKey = (x, y) => {
            for (const [dx2, dy2] of DIRS) {
                const bx = x + dx2, by = y + dy2;
                if (!inBounds(bx, by) || !isGrayId(cells[idx(bx, by)])) continue;
                const br = roles[idx(bx, by)];
                if (br && br.macro && br.lead && br.lead[0] === -dx2 && br.lead[1] === -dy2)
                    return muxNodeKey(bx, by);
            }
            const r = roles[idx(x, y)];
            const m = r && r.macro;
            if (m && r.kind === 'comMiddle' && m.comCell[0] === x && m.comCell[1] === y)
                return 'm' + m.key + '|com';
            return 'm' + idx(x, y);
        };
        // A mux carries its contact cells (see macroFootprint), so selecting a
        // mux AND the wire running off it legitimately names the same cell
        // twice. The first claim wins — grabbing a mux and its own feed should
        // move both, not report an overlap — and only a cell claimed twice by
        // objects that both really want it is a genuine conflict, which cannot
        // happen once duplicates collapse.
        const objCells = [], nodeKeys = [], objSet = new Set();
        objectList.forEach((o, oi) => {
            const isMux = o.cells.some(([x, y]) => { const r = roles[idx(x, y)]; return r && r.macro; });
            for (const [x, y] of o.cells) {
                if (objSet.has(idx(x, y))) continue;
                objSet.add(idx(x, y));
                objCells.push([x, y]);
                nodeKeys.push(isMux ? muxNodeKey(x, y) : 'o' + oi);
            }
        });
        // A level's fixed I/O pad is not draggable, and nothing may be dropped
        // onto one. (Re-routing can't hit a locked cell on its own: the router
        // only lays wire through insulator, and a locked cell always holds a
        // pad.) Checked before anything is written, so there's nothing to undo.
        if (anyLocked) {
            const dest = transformObjectCells(objCells, dx, dy, quarterTurns);
            for (let i = 0; i < objCells.length; i++) {
                if (isLocked(objCells[i][0], objCells[i][1]) || isLocked(dest[i][0], dest[i][1]))
                    return { ok: false, reason: 'locked' };
            }
        }
        // A block moves whole or not at all.
        {
            const tops = new Set();
            for (const i of objSet) if (blockAt[i]) tops.add(topBlockOf(blockAt[i]));
            for (const t of tops) for (const i of blockCellIdxs(t)) if (!objSet.has(i)) return { ok: false, reason: 'block' };
        }
        const rawIds = objCells.map(([x, y]) => cells[idx(x, y)]);
        const ids = rawIds.map(stripId);
        // Every rejection path restores wholesale from this: the checks that
        // can only be made after the object is placed (see the new-contact
        // scan below) would otherwise have to unpick absorbed and trimmed
        // cells by hand. The grid is small, so a copy is cheaper than the
        // bookkeeping.
        const savedCells = cells.slice();
        const savedBlocks = blockState();
        // Who is wired to whom, to hold the finished board to (see the end).
        const joinedAtStart = terminalGroups((i) => i);
        const reject = (why) => {
            cells.set(savedCells);
            restoreBlockState(savedBlocks);
            recomputeRoles();
            return { ok: false, reason: why || 'blocked' };
        };
        // What every mux cell on the board currently is. A mux's connections
        // are integral to its identity — a wire against the middle of a long
        // side declares that side COM (see buildBoxMux) — so a drag that
        // parks a part where something re-reads it is refused rather than
        // silently spinning it around. Checked after the move lands, since
        // that is the only point the new reading exists. Covers stationary
        // muxes too: sliding one part past another must not re-read either.
        // Kind alone is not identity. A mux's six cells keep the same kinds
        // when the frame flips end-for-end — three comMiddle, two end, one
        // boxSel, whichever end SELECT is on — so which FACE each cell
        // connects through has to be part of the snapshot too. That is what
        // catches a move that hands SELECT to the opposite corner and quietly
        // swaps NO for NC.
        const muxRoleBefore = new Map();
        for (let i = 0; i < cells.length; i++) {
            const r = roles[i];
            if (r && r.macro) muxRoleBefore.set(i, { kind: r.kind, lead: r.lead || null });
        }
        // The object itself may be turning, so a lead is expected to turn with
        // it. 90° CW in screen coordinates (y down) is (dx,dy) -> (-dy,dx).
        const turnLead = (lead, turns) => {
            let [dx, dy] = lead;
            for (let t = ((turns % 4) + 4) % 4; t > 0; t--) { const nx = -dy; dy = dx; dx = nx; }
            return [dx, dy];
        };

        // Crossings the object runs through (see wireSegmentAt): shared
        // with the run going the other way, which keeps the cell.
        const sharedX = new Set();
        for (const [cx, cy] of objCells) if (isCrossoverAt(cx, cy)) sharedX.add(idx(cx, cy));
        // A mux's stub that is more than an end — a junction (the run going
        // on past the pin as well as into it, a T) or one arm of a crossing
        // — is carried, so the part keeps its leads and reads as itself
        // where it lands, and ALSO left where it was, so the junction or
        // the crossing stays whole. Carried off alone, it took the junction
        // with it, or left the crossing a T welding its two runs, and on a
        // tight board the pieces could not be joined up again.
        const keptBehind = new Set();
        objCells.forEach(([cx, cy], k) => {
            if (!String(nodeKeys[k]).startsWith('m') || !isConductorId(cells[idx(cx, cy)])) return;
            let others = 0, crossing = false;
            for (const [ax, ay] of DIRS) {
                const nx = cx + ax, ny = cy + ay;
                if (!inBounds(nx, ny) || objSet.has(idx(nx, ny))) continue;
                if (isCrossoverAt(nx, ny)) crossing = true;
                if (cellConnects(nx, ny, [-ax, -ay])) others++;
            }
            if (crossing || others > 1) keptBehind.add(idx(cx, cy));
        });

        // Raw contacts, collected against the pre-move grid.
        const contacts = [];
        for (const [cx, cy] of objCells) {
            if (!cellConnects(cx, cy)) continue;
            for (const [ddx, ddy] of DIRS) {
                const ax = cx + ddx, ay = cy + ddy;
                // Both ends are asked about the face they actually meet on,
                // so a wire merely sitting beside a box mux's package is not
                // recorded as a contact and then dragged along by it.
                if (!inBounds(ax, ay) || objSet.has(idx(ax, ay))) continue;
                if (!cellConnects(cx, cy, [ddx, ddy]) || !cellConnects(ax, ay, [-ddx, -ddy])) continue;
                // A crossing the object runs through: the run going the
                // other way only passes it, and is no contact of the object.
                if (sharedX.has(idx(cx, cy)) && !objSet.has(idx(cx - ddx, cy - ddy))) continue;
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
        const contactTerminals = contacts.map((c) => {
            const net = floodNet(c.anchor[0], c.anchor[1], c.entry[0], c.entry[1]);
            const ts = [...net.terminals].filter((t) => !objSet.has(t));
            return { objCell: idx(c.objCell[0], c.objCell[1]), terminals: ts, netKey: net.key };
        });

        const moved = transformObjectCells(objCells, dx, dy, quarterTurns);
        const movedSet = new Set(moved.map(([x, y]) => idx(x, y)));
        const newIdxOf = new Map();
        objCells.forEach(([x, y], i) => newIdxOf.set(idx(x, y), idx(moved[i][0], moved[i][1])));
        // Moved cells that can carry a connection (for a mux, everything but
        // its inert select-sense spacer) — the trim step's notion of "flush
        // against a node". Uses pre-move roles, captured before the lift below.
        const capableMoved = new Set();
        objCells.forEach(([x, y], i) => {
            const r = roles[idx(x, y)];
            if (!r || r.kind !== 'boxSel') capableMoved.add(idx(moved[i][0], moved[i][1]));
        });
        // Which pairs of the object's own cells already touch, captured on the
        // pre-move grid. A rigid move preserves them, so a pair that touches
        // afterwards and is in here is not a new connection — it is the same
        // one, carried along. Only a pair NOT in here is a weld.
        const joinedBefore = new Set();
        for (const [cx, cy] of objCells) {
            for (const [ddx, ddy] of DIRS) {
                const nx = cx + ddx, ny = cy + ddy;
                if (!inBounds(nx, ny) || !objSet.has(idx(nx, ny))) continue;
                if (!cellConnects(cx, cy, [ddx, ddy]) || !cellConnects(nx, ny, [-ddx, -ddy])) continue;
                const a = idx(cx, cy), b = idx(nx, ny);
                joinedBefore.add(Math.min(a, b) + ':' + Math.max(a, b));
            }
        }
        const origOfMoved = new Map();
        objCells.forEach(([x, y], i) => origOfMoved.set(idx(moved[i][0], moved[i][1]), idx(x, y)));

        // Cells belonging to one electrical node share an id, so the shrink
        // pass can tell "these two are already joined" from "these two need
        // a wire between them" (see reduceNet).
        const nodeOfOrig = new Map(), nodeOfMoved = new Map(), cellsOfNode = new Map();
        objCells.forEach(([x, y], i) => {
            const mi = idx(moved[i][0], moved[i][1]);
            nodeOfOrig.set(idx(x, y), nodeKeys[i]);
            nodeOfMoved.set(mi, nodeKeys[i]);
            if (!cellsOfNode.has(nodeKeys[i])) cellsOfNode.set(nodeKeys[i], new Set());
            cellsOfNode.get(nodeKeys[i]).add(mi);
        });
        const nodeIdFor = (map) => (ci) => {
            if (map.has(ci)) return map.get(ci);
            const nx = ci % GRID_W, ny = (ci - nx) / GRID_W;
            return anchorNode(nx, ny).key;
        };

        // Bounds/solidity validation; wire overlaps noted for later.
        const overlaps = [];
        for (let i = 0; i < moved.length; i++) {
            const [mx, my] = moved[i];
            if (!inBounds(mx, my)) return { ok: false };
            const di = idx(mx, my);
            if (!objSet.has(di) && blockAt[di]) return { ok: false }; // nothing lands on a block
            if (objSet.has(di) || isInsulatorId(cells[di])) continue;
            if (isWireId(cells[di])) { overlaps.push({ di, movedIsWire: isWireId(ids[i]) }); continue; }
            return { ok: false }; // something solid in the way
        }

        // Wire that already led nowhere before the move. A run with no
        // terminal on it at either end is the user's business — they may be
        // half-way through drawing it — so the litter sweep at the end has to
        // know which orphans it inherited and which ones it made.
        const preOrphans = orphanWire();

        // Crossings as they stand before anything moves. A mux carries the
        // stub on each of its leads, so lifting it can take away one arm of
        // a crossing right beside it — which then reads as a T, joining its
        // two axes, and the floods below would make two nets one: the move
        // then "kept" a connection between them, shorting them for good. So
        // everything the move traces treats a cell that was a crossing as
        // one still. (If it ends up a T after all, the check for joins at
        // the end refuses the move.)
        const preXover = new Set();
        for (let i = 0; i < cells.length; i++)
            if (isWireId(cells[i]) && isCrossoverAt(i % GRID_W, (i - i % GRID_W) / GRID_W)) preXover.add(i);
        const xo = (x, y) => isWireId(cells[idx(x, y)]) && (preXover.has(idx(x, y)) || isCrossoverAt(x, y));

        // Lift the object so the net floods see only the stationary world.
        // A block's record rides along in the side arrays.
        const sideOf = objCells.map(([x, y]) => [blockAt[idx(x, y)], pinAt[idx(x, y)]]);
        for (const [x, y] of objCells) {
            const i = idx(x, y);
            if (sharedX.has(i) || keptBehind.has(i)) { cells[i] = makeConductor(OFF); continue; }   // stays, see above
            cells[i] = ID_INSULATOR_PLAIN;
            blockAt[i] = 0;
            pinAt[i] = 0;
        }

        const components = new Map(); // key -> {cells:Set, terminals:Set}
        const contracts = new Map();  // key|node -> {compKey, targets:Set of moved idx}
        for (const ct of contacts) {
            const ai = idx(ct.anchor[0], ct.anchor[1]);
            let comp = isWireId(cells[ai]) && !blockAt[ai]
                ? floodNet(ct.anchor[0], ct.anchor[1], ct.entry[0], ct.entry[1], xo)
                : anchorNode(ct.anchor[0], ct.anchor[1]);
            if (components.has(comp.key)) comp = components.get(comp.key);
            else components.set(comp.key, comp);
            comp.preTouch.add(idx(ct.objCell[0], ct.objCell[1]));
            // The object-side node this contact is against — its whole node
            // is the re-route target, so a wire that met a pad anywhere along
            // its edge may come back to any part of that pad.
            const gk = nodeOfOrig.get(idx(ct.objCell[0], ct.objCell[1]));
            const ck = comp.key + '|' + gk;
            if (!contracts.has(ck)) contracts.set(ck, { compKey: comp.key, targets: new Set() });
            for (const mi of cellsOfNode.get(gk)) contracts.get(ck).targets.add(mi);
        }

        // Dangles that already existed BEFORE the move (a stub the user drew
        // on purpose, going nowhere). They're protected from the shrink pass
        // below, which is only meant to clean up tails this move orphaned —
        // never to quietly delete wire that was already like that.
        for (const comp of components.values()) {
            if (!comp.isNet) continue;
            comp.preDangling = reduceNet(comp.cells, new Set([...comp.terminals, ...comp.preTouch]), null, nodeIdFor(nodeOfOrig));
        }

        // A part lands on wire by overwriting it — wire of its own nets,
        // which it absorbs, or anyone else's, which it cuts. Refusing used to
        // mean erasing a stub by hand before every drag on a tight board; a
        // cut is owed instead (a dashed line, see the end), never silent. A
        // moved WIRE landing on wire is a join, not a cut, and the check for
        // joins at the end refuses that.
        const contractedWire = new Set();
        for (const comp of components.values()) for (const ci of comp.cells) contractedWire.add(ci);

        // Place the object (overwriting overlapped wire cells) and drop the
        // absorbed cells from their nets' bookkeeping.
        for (const comp of components.values())
            for (const ci of [...comp.cells]) if (movedSet.has(ci)) comp.cells.delete(ci);
        moved.forEach(([x, y], i) => {
            const mi = idx(x, y);
            cells[mi] = ids[i];
            blockAt[mi] = sideOf[i][0];
            pinAt[mi] = turnPinCode(sideOf[i][1], quarterTurns);
        });
        recomputeRoles();

        // Trim: a surviving net cell flush against a node it is NOT
        // contracted to would silently connect to the wrong pin — delete it;
        // the re-route below reconnects the net properly. (A single-node
        // object trims nothing, since every target cell is then allowed.)
        {
            const allowed = new Map(); // compKey -> Set of moved idx it may touch
            for (const c of contracts.values()) {
                const s = allowed.get(c.compKey) || new Set();
                for (const t of c.targets) s.add(t);
                allowed.set(c.compKey, s);
            }
            for (const [key, comp] of components) {
                const ok = allowed.get(key) || new Set();
                for (const ci of [...comp.cells]) {
                    if (!isWireId(cells[ci])) continue;
                    const cx2 = ci % GRID_W, cy2 = (ci - cx2) / GRID_W;
                    // Flush on a face that CONNECTS: a wire running past a
                    // part's package on a dead face is not on any of its
                    // pins, and trimming it cut nets for nothing — on a
                    // tight board even a move by nothing broke the circuit.
                    const bad = DIRS.some(([bdx, bdy]) => {
                        const nx = cx2 + bdx, ny = cy2 + bdy;
                        if (!inBounds(nx, ny)) return false;
                        const ni = idx(nx, ny);
                        return capableMoved.has(ni) && !ok.has(ni) && cellConnects(nx, ny, [-bdx, -bdy]);
                    });
                    if (bad) { cells[ci] = ID_INSULATOR_PLAIN; comp.cells.delete(ci); }
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
            if (isWireId(cells[idx(nx, ny)]) && !blockAt[idx(nx, ny)]) {
                let cx = nx, cy = ny;
                while (xo(cx, cy) && inBounds(cx + ddx, cy + ddy)) { cx += ddx; cy += ddy; }
                for (const [key, comp] of components)
                    if (comp.cells.has(idx(cx, cy)) || comp.routed.has(idx(cx, cy))) return key;
                return 'new:' + idx(nx, ny);
            }
            return anchorNode(nx, ny).key; // stationary, so its key is stable across the move
        };
        for (const mi of movedSet) {
            if (!capableMoved.has(mi)) continue;
            const mx = mi % GRID_W, my = (mi - mx) / GRID_W;
            if (!cellConnects(mx, my)) continue;
            for (const [ddx, ddy] of DIRS) {
                const nx = mx + ddx, ny = my + ddy;
                if (!inBounds(nx, ny)) continue;
                if (!cellConnects(mx, my, [ddx, ddy]) || !cellConnects(nx, ny, [-ddx, -ddy])) continue;
                // A moved run that lands across a stationary one makes a
                // crossing: that run only passes through.
                if (isCrossoverAt(mx, my) && !movedSet.has(idx(nx, ny)) && !movedSet.has(idx(mx - ddx, my - ddy))) continue;
                // The copy of a stub the move left behind (see keptBehind) is
                // the part's own connection, not someone else's wire to cut.
                if (keptBehind.has(idx(nx, ny)) && !movedSet.has(idx(nx, ny))) continue;
                // Two cells that both moved: fine if they are the same node
                // (a pad's own cells, a mux's COM row), a weld if they are
                // not. A mux carries a contact stub per lead now, and a turn
                // can bring two of them together — which would short SELECT
                // to COM without either ever touching anything stationary,
                // the one way past the check below.
                if (movedSet.has(idx(nx, ny))) {
                    if (nodeOfMoved.get(mi) === nodeOfMoved.get(idx(nx, ny))) continue;
                    const a = origOfMoved.get(mi), b = origOfMoved.get(idx(nx, ny));
                    if (a !== undefined && b !== undefined &&
                        joinedBefore.has(Math.min(a, b) + ':' + Math.max(a, b))) continue;
                    return reject('welded');
                }
                if (components.has(nodeKeyAt(nx, ny, ddx, ddy))) continue;
                // Someone else's wire against a part's lead: cut it back
                // rather than refuse the drag — as with wire it lands on, the
                // cut is owed. Not for a dragged WIRE, though: meeting another
                // wire end-on is a join, and cutting it chopped the other run
                // in two. Nor anything else it would meet (a pad, a source,
                // another part's lead), which cannot be cut.
                const partCell = !isWireId(cells[mi]) || String(nodeOfMoved.get(mi)).startsWith('m');
                if (partCell && isWireId(cells[idx(nx, ny)]) && !blockAt[idx(nx, ny)]) { cells[idx(nx, ny)] = ID_INSULATOR_PLAIN; continue; }
                return reject();
            }
        }
        recomputeRoles();

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
        let unrouted = 0;
        const volatileCells = new Set();
        for (const comp of components.values()) for (const ci of comp.cells) volatileCells.add(ci);
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
                const sx = si % GRID_W, sy = (si - sx) / GRID_W;
                for (const [dx2, dy2] of DIRS)
                    if (cellConnects(sx, sy, [dx2, dy2])) stack.push([sx + dx2, sy + dy2, dx2, dy2]);
            }
            while (stack.length) {
                const [x, y, dx2, dy2] = stack.pop();
                if (!inBounds(x, y)) continue;
                const i = idx(x, y);
                if (!isWireId(cells[i]) || blockAt[i]) { if (cellConnects(x, y, [-dx2, -dy2])) touched.add(i); continue; }
                if (xo(x, y)) {
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
            const comp = components.get(c.compKey);
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
                    : [...comp.cells].filter((ci) => !isWireId(cells[ci]));
                if (!mustJoin.length && comp.cells.size) mustJoin.push([...comp.cells][0]);
                // By NODE, not by cell. A pad is one terminal however many
                // cells it spans, so reaching any one of them settles all of
                // them — asking cell by cell had a 3x3 switch demand four
                // separate routes, three of which were laid around the back
                // of it and then left dangling because nothing needed them.
                const keyOf = (ci) => anchorNode(ci % GRID_W, Math.floor(ci / GRID_W)).key;
                const had = new Set([...at.touched].map(keyOf));
                const want = mustJoin.filter((t) =>
                    !at.touched.has(t) && !at.wires.has(t) && !had.has(keyOf(t)));
                if (!want.length) break;
                const from = want[0];
                const island = floodFrom([from]);
                const seeds = [...island.wires, from].filter((ci) => !xo(ci % GRID_W, Math.floor(ci / GRID_W)));
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
                    cells[idx(px, py)] = makeConductor(OFF);
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
            const comp = components.get(c.compKey);
            const spared = new Set([...comp.terminals, ...(comp.preDangling || []), ...movedSet]);
            const rip = [...comp.cells].filter((ci) => isWireId(cells[ci]) && !spared.has(ci));
            if (!rip.length) return null;
            const before = cells.slice();
            const beforeCells = new Set(comp.cells), beforeRouted = new Set(comp.routed);
            // Deliberately no recomputeRoles here: the roles belong to the
            // object as PLACED, and re-reading the board mid-rip would show
            // the router a mux whose own commissioning wire has just been
            // lifted. Only `cells` changes, which is all routeNet reads for
            // free space.
            for (const ci of rip) { cells[ci] = ID_INSULATOR_PLAIN; comp.cells.delete(ci); }
            const failed = attemptContract(c);
            if (!failed) return null;
            cells.set(before);
            comp.cells = beforeCells;
            comp.routed = beforeRouted;
            return failed;
        };

        // Before routing to the part, clear what of the net now leads
        // nowhere — the run that went to where the part WAS, past whatever
        // still needs it. Left standing, it got in its own net's way (a
        // route may not run alongside its own wire), the route went the
        // long way round it, and it was then left as a stub with the detour
        // beside it.
        const clearDeadRuns = (c) => {
            const comp = components.get(c.compKey);
            if (!comp.isNet) return false;
            const wire = [...comp.cells].filter((ci) => isWireId(cells[ci]) && !movedSet.has(ci));
            if (!wire.length) return false;
            const keep = new Set([...(comp.preDangling || []), ...keptBehind]);
            const dead = [...reduceNet(new Set(wire), new Set(comp.terminals), keep, nodeIdFor(nodeOfMoved))]
                .filter((ci) => isWireId(cells[ci]));
            if (!dead.length) return false;
            for (const ci of dead) { cells[ci] = ID_INSULATOR_PLAIN; comp.cells.delete(ci); }
            return true;
        };
        // Both ways are tried — from what of the net is left, as always, and
        // with its dead runs cleared first — and the one that lays less new
        // wire is kept (the usual one on a tie, so the player's own wire is
        // kept wherever it serves).
        const runContract = (c) => {
            const comp = components.get(c.compKey);
            const snap = () => ({ cells: cells.slice(), compCells: new Set(comp.cells), routed: new Set(comp.routed) });
            const back = (s0) => { cells.set(s0.cells); comp.cells = new Set(s0.compCells); comp.routed = new Set(s0.routed); };
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
            if (failed) { unrouted++; comp.failed = true; owedPairs.push(failed); }
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
                const tx = ti % GRID_W, ty = (ti - tx) / GRID_W;
                for (const [ax, ay] of DIRS) if (inBounds(tx + ax, ty + ay) && isInsulatorId(cells[idx(tx + ax, ty + ay)])) n++;
            }
            return n;
        };
        const owedPairs = [];
        const contractList = [...contracts.values()];
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
            const net = new Set(), required = new Set(capableMoved), keep = new Set(movedSet);
            for (const comp of components.values()) {
                if (comp.failed) continue;
                for (const ci of comp.cells) (isWireId(cells[ci]) ? net : required).add(ci);
                for (const ci of comp.routed) net.add(ci);
                for (const t of comp.terminals) required.add(t);
                for (const ci of comp.preDangling || []) keep.add(ci);
            }
            // The stubs left behind as copies (keptBehind) are wire of these
            // nets too: without them a run reaching the part through one
            // read as going nowhere, and was pruned.
            for (const ci of keptBehind) if (isWireId(cells[ci])) net.add(ci);
            for (const ci of reduceNet(net, required, keep, nodeIdFor(nodeOfMoved))) {
                if (!isWireId(cells[ci])) continue;
                cells[ci] = ID_INSULATOR_PLAIN;
                // Keep the bookkeeping honest: a cell that is gone must not
                // come back as a "required" anchor on a later pass.
                for (const comp of components.values()) { comp.cells.delete(ci); comp.routed.delete(ci); }
            }
        };
        const preRoute = cells.slice();
        const preCompCells = new Map([...components].map(([k, c]) => [k, new Set(c.cells)]));
        for (const order of orders) {
            cells.set(preRoute);
            for (const [k, comp] of components) {
                comp.routed.clear(); comp.failed = false; comp.cells = new Set(preCompCells.get(k));
            }
            unrouted = 0;
            owedPairs.length = 0;
            for (const c of order) runContract(c);
            if (unrouted) {
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
                    const comp = components.get(c.compKey);
                    if (!comp.failed) continue;
                    comp.failed = false;
                    retry.push(c);
                }
                unrouted = 0;
                owedPairs.length = 0;
                for (const c of retry) runContract(c);
            }
            if (!unrouted) break;
        }
        shrinkNets();
        recomputeRoles();

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
                if (!preOrphans.has(ci) && !movedSet.has(ci) && !blockAt[ci]) gone.push(ci);
            if (gone.length) {
                for (const ci of gone) cells[ci] = ID_INSULATOR_PLAIN;
                recomputeRoles();
            }
        }

        // Nothing here may have reached inside a block that stood still. The
        // walks stop at their pins and the router keeps out, so this should
        // never fire — it is the backstop that keeps a missed case a refused
        // drag instead of a quietly rewired part.
        for (let i = 0; i < cells.length; i++)
            if (blockAt[i] && !movedSet.has(i) && stripId(cells[i]) !== stripId(savedCells[i])) return reject('block');
        // Nor may anything end up on a part's kept-bare edge — the part that
        // moved, or one it moved up against.
        if (ringViolations().length) return reject('edge');

        // Identity is not negotiable the way routing is: a part that ends up
        // reading as something else is not the part you dragged, so that one
        // still refuses outright.
        for (const [before, was] of muxRoleBefore) {
            const moved = newIdxOf.has(before);
            const r = roles[moved ? newIdxOf.get(before) : before];
            if (!r || r.kind !== was.kind) return reject('reread');
            // A stationary mux keeps its leads pointing where they were; a
            // moved one turns them with the object.
            const want = was.lead && moved ? turnLead(was.lead, quarterTurns) : was.lead;
            const got = r.lead || null;
            if (!want !== !got) return reject('reread');
            if (want && (want[0] !== got[0] || want[1] !== got[1])) return reject('reread');
        }

        // And nothing joined that was apart. Each step above is meant to
        // keep to that — the trim, the routes, the rip-and-relay, the
        // shrink — but a mistake in any of them is a short the player cannot
        // see until the circuit stops working, so the finished board is held
        // to it directly: every terminal on it (the moved ones by where they
        // came from) with everything it is wired to, against the board
        // before. Connections may be owed (dashed); never invented.
        const groupsAfter = terminalGroups((i) => (origOfMoved.has(i) ? origOfMoved.get(i) : i));
        {
            const after = groupsAfter;
            const wasOf = new Map();
            for (const [t, g] of after) {
                const was = joinedAtStart.has(t) ? joinedAtStart.get(t) : 'alone:' + t;
                if (!wasOf.has(g)) wasOf.set(g, was);
                else if (wasOf.get(g) !== was) return reject('short');
            }
        }

        // Every connection the object had, re-checked against the finished
        // board rather than taken on trust from the router's own count. That
        // count only knows about routes it was asked for and failed; it says
        // nothing about a connection lost to the shrink pass or to a contact
        // that looked already-satisfied. Whatever did not survive is owed,
        // and becomes a dashed line instead of vanishing silently.
        const owed = new Map();
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
            const a2 = !placed && newIdxOf.has(a) ? newIdxOf.get(a) : a;
            const b2 = !placed && newIdxOf.has(b) ? newIdxOf.get(b) : b;
            if (a2 === b2 || netReaches(a2, b2)) return false;
            const ax = a2 % GRID_W, ay = (a2 - ax) / GRID_W;
            const bx = b2 % GRID_W, by = (b2 - bx) / GRID_W;
            if (!cellConnects(ax, ay) || !cellConnects(bx, by)) return false; // an end was erased
            const ka = netKey(a2), kb = netKey(b2);
            if (ka === kb) return false;                                      // one net, already joined
            const k = Math.min(ka, kb) + ':' + Math.max(ka, kb);
            if (keep && owed.has(k)) return true;
            owed.set(k, [a2, b2]);
            return true;
        };
        // What the router itself reported it could not join, re-checked in
        // case another contract's path happened to satisfy it anyway.
        for (const [a, b] of owedPairs) oweLink(a, b, false, true);
        // ...and every terminal each contact was attached to, once per
        // (pre-move net, terminal). Several contacts on one net are one
        // connection however the move pulled its ends apart.
        const claimed = new Set();
        for (const ct of contactTerminals) {
            if (!newIdxOf.has(ct.objCell)) continue;
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
            for (const t of groupsAfter.keys()) {
                const c = termCell(t);
                termAt.set(newIdxOf.has(c) ? newIdxOf.get(c) : c, t);
            }
            // The group an owed link's end is in: its own, for a terminal;
            // for a wire, that of a terminal on its net.
            const groupOfCell = (i) => {
                if (termAt.has(i)) return groupsAfter.get(termAt.get(i));
                const x = i % GRID_W, y = (i - x) / GRID_W, id = cells[i];
                // Any cell of a pad stands for the pad, which is filed under
                // its lowest cell (see terminalGroups).
                if (isLed(id) || isSwitch(id) || isToggle(id)) {
                    let min = Infinity;
                    for (const c of anchorNode(x, y).cells) min = Math.min(min, origOfMoved.has(c) ? origOfMoved.get(c) : c);
                    return groupsAfter.has('p' + min) ? groupsAfter.get('p' + min) : null;
                }
                if (!isWireId(id)) return null;
                for (const ti of floodNet(x, y, 0, 0).terminals)
                    if (termAt.has(ti)) return groupsAfter.get(termAt.get(ti));
                return null;
            };
            const linked = new Map();
            const find = (a) => { while (linked.has(a) && linked.get(a) !== a) a = linked.get(a); return a; };
            const join = (a, b) => { if (a !== null && b !== null) linked.set(find(a), find(b)); };
            for (const [a, b] of owed.values()) join(groupOfCell(a), groupOfCell(b));
            const pieces = new Map();
            for (const [t, g] of groupsAfter) {
                const was = joinedAtStart.get(t);
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
        for (const link of owed.values()) pendingLinks.push(link);

        const out = [];
        let at = 0;
        for (const o of objectList) { out.push({ cells: moved.slice(at, at + o.cells.length) }); at += o.cells.length; }
        return { ok: true, objects: out, cells: moved, unrouted, pending: [...owed.values()].length };
    }

    // Blocks, when there are any, as their records plus the two cell arrays.
    function serialize() {
        const o = { w: GRID_W, h: GRID_H, cells: Array.from(cells) };
        if (blocks.size) {
            o.blocks = {
                pv: 2, recs: [...blocks.values()].map(copyBlockRec),
                at: Array.from(blockAt), pin: Array.from(pinAt),
            };
        }
        return JSON.stringify(o);
    }

    // Far past any board anyone draws (2048x2048), but small enough that a
    // mangled or hostile import is refused instead of allocating gigabytes.
    const MAX_CELLS = 1 << 22;

    // Replaces the board wholesale, so the old board's ratsnest goes with it
    // (resizeGrid drops it): its flat indices would otherwise be read as
    // cells of the new board, and could come back as a dashed line between
    // two unrelated things there.
    // Saved blocks, checked the way sanitizeClip checks a clip's.
    function loadBlocks(b) {
        blocks = new Map();
        blockAt.fill(0);
        pinAt.fill(0);
        if (!b || !Array.isArray(b.recs) || !Array.isArray(b.at) || b.at.length !== blockAt.length) return;
        for (const r of b.recs) {
            if (!r || !Number.isInteger(r.id) || r.id <= 0 || blocks.has(r.id)) continue;
            blocks.set(r.id, {
                id: r.id, name: String(r.name || 'Part').slice(0, 40), source: r.source ? String(r.source) : '',
                parent: Number.isInteger(r.parent) ? r.parent : 0, open: !!r.open,
                pins: (Array.isArray(r.pins) ? r.pins : []).slice(0, 256).map((p) => ({
                    name: String((p && p.name) || '?').slice(0, 12), dir: p && p.dir === 'out' ? 'out' : 'in',
                })),
            });
        }
        for (const r of blocks.values()) {
            let p = r.parent, steps = 0;
            while (p && blocks.has(p) && p !== r.id && steps++ < blocks.size) p = blocks.get(p).parent;
            if (!blocks.has(r.parent) || p === r.id || steps >= blocks.size) r.parent = 0;
        }
        for (let i = 0; i < blockAt.length; i++) {
            const id = b.at[i] | 0;
            if (blocks.has(id)) blockAt[i] = id;
        }
        // Saved before pins recorded their face: every pin was on its
        // block's edge, facing out.
        const box = b.pv ? null : lidBoxes(blockAt, GRID_W, GRID_H);
        for (let i = 0; i < blockAt.length; i++) {
            const id = blockAt[i];
            let p = id && Array.isArray(b.pin) ? b.pin[i] | 0 : 0;
            if (p <= 0) continue;
            if (box) p = pinCode(p - 1, outwardFace(box.get(id), i % GRID_W, Math.floor(i / GRID_W)));
            if (pinIndex(p) < blocks.get(id).pins.length) pinAt[i] = p;
        }
        for (const id of blocks.keys()) if (id >= nextBlockId) nextBlockId = id + 1;
    }

    function deserialize(text) {
        try {
            const data = JSON.parse(text);
            if (!data || !Array.isArray(data.cells)) return false;
            // Restore the saved size (grids grow, so it may differ from now).
            const w = Number.isInteger(data.w) && data.w > 0 ? data.w : GRID_W;
            const h = Number.isInteger(data.h) && data.h > 0 ? data.h : GRID_H;
            if (w * h > MAX_CELLS) return false;
            resizeGrid(w, h, 0, 0, false);
            const n = Math.min(data.cells.length, cells.length);
            for (let i = 0; i < n; i++) {
                const v = data.cells[i] & 0xff;
                cells[i] = isValidId(v) ? v : ID_INSULATOR_PLAIN;
            }
            loadBlocks(data.blocks);
            restartTicks();
            recomputeRoles();
            return true;
        } catch (e) {
            return false;
        }
    }

    recomputeRoles();

    window.PixelogicModel = {
        CELL_SIZE,
        get GRID_W() { return GRID_W; },
        get GRID_H() { return GRID_H; },
        OFF, ON, FALLING,
        idx, inBounds, getCell, paintCell, paintCells, colorOfCell, setSwitch, toggleAt, setToggle,
        expandForBorder, growTo, growBy, growSnapshot,
        isLocked, setLockedCells, lockedCells,
        getLiveSnapshot, restoreLiveSnapshot,
        // Raw cell array copy — the campaign verifier compares consecutive
        // ticks to decide a circuit has settled, which needs every bit of
        // live charge, not the structural (charge-stripped) snapshot.
        copyCells() { return cells.slice(); },
        isInsulatorId,
        isConductorId, conductorCharge,
        isXover, xoverV, xoverH, isCrossoverAt, cellConnects, reaches, parts, muxCount,
        pendingLinks: pendingLinkList,
        isGrayId, isWireId, grayCharge,
        isLed, ledIsOn, isSwitch, switchIsPressed, isToggle, toggleIsOn,
        ID_POS, ID_NEG,
        get roles() { return roles; },
        stepSimulation, clearGrid, resetCharges,
        getStructuralSnapshot, restoreStructuralSnapshot,
        copyRegion, clearRegion, clearCells, grayBlob, pasteRegion,
        rotateRegionCW, mirrorRegionH,
        isProtected, isTerminalCell, blockAtCell, visibleBlockAt, topBlockOf, blockList, blockInfo, edgeAt,
        clipRing, clipPins, decapClip, ringViolations,
        setBlockOpen, removeBlock, decapBlock, captureBlock, fitPart, captureRect, capPart, blockFits,
        sanitizeClip, clipToJSON, rotateClipCW, mirrorClipH,
        objectAt, moveObject, moveObjects,
        serialize, deserialize,
        get tickCount() { return tickCount; },
        recomputeRoles,
    };
})(window);
