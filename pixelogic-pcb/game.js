(function (window) {
    // game.js - the campaign: a nandgame-style ladder of levels that starts at
    // a single inverter and climbs toward a machine that can run Tetris.
    //
    // Everything here is layered *on top of* the sandbox editor rather than
    // wired into it. A level is:
    //
    //   - a board of a fixed size, carrying input pads (toggles) down its left
    //     edge and output pads (LEDs) down its right edge. Those pads are
    //     LOCKED (the model's lock mask), so no paint stroke, paste, clear or
    //     Rearrange drag can move them - which is what lets the verifier keep
    //     addressing them by coordinate for the life of the level;
    //   - a truth function over named bits, from which the test vectors are
    //     generated (exhaustively when the input space is small, sampled with
    //     the corner cases pinned when it isn't) - or, for a storage level, an
    //     ordered script plus a step function, since the answer there depends
    //     on what came before;
    //   - a verifier that drives the input pads, runs the simulation until the
    //     board stops changing, and reads the LEDs back.
    //
    // The campaign is deliberately data-only: adding a level is adding an entry
    // to LEVELS in levels.js, not writing code. That matters because the
    // ladder above the shipped chapters (ALU, RAM, CPU, Tetris) is long.
    const M = window.PixelogicModel;
    const S = window.PixelogicStorage;
    const {
        LEVELS, CHAPTERS, getLevel, levelIndex, levelsIn,
        busNames, busVal, busBits, loadHoldScript,
    } = window.PixelogicLevels;


    // ===== Parts =====
    //
    // A part is a circuit dropped onto a board whole, at full size, under a
    // lid that names it and its pins (the model's blocks). Solving a level
    // that makes one (`part: 'XOR'`) captures the board as that part — its
    // switches and lamps become the part's pins, named as the level named
    // them — and from the next level on it is on the Parts shelf, so the
    // half adder is two parts and four wires rather than three muxes drawn
    // again from nothing. The latest solution is the part: solve a level
    // again, better, and the shelf gets the better one. Parts already placed
    // on a board are copies and keep what they were.
    //
    // A part is as small as its circuit allows: its core, the smallest
    // rectangle holding its muxes and sources and the wiring between them
    // (M.fitPart), its terminals just outside, named for the switches and
    // lamps they lead to. A layout that cannot be fitted that way — wiring
    // that winds right up against a switch or lamp — still makes a part, the
    // old way: the whole circuit, pads turned into pins at the board's edge.
    // That one is large, and the player is told so.
    //
    // A level offers the parts made by levels before it, never after — the
    // full adder is not a way to solve the half adder. The sandbox offers
    // every part, the player's own included (`user:<name>`), which are made
    // from a selection there.
    // Each entry: its key, name and source level, its clip, and `fit`, 1 if
    // it was fitted to its core and edge (compact), 0 if it is the whole
    // board it was made on.
    let partsCache = null;
    function partStore() {
        if (partsCache) return partsCache;
        partsCache = {};
        const raw = S.getJSON(S.KEYS.parts, null);
        if (raw && typeof raw === 'object')
            for (const [k, p] of Object.entries(raw)) {
                const clip = p && M.sanitizeClip(p.clip);
                if (!clip || !clip.blocks) continue;
                partsCache[k] = {
                    key: k, name: String(p.name || k), source: p.source || '', clip, fit: p.fit ? 1 : 0,
                    made: typeof p.made === 'string' ? p.made : undefined,
                };
            }
        return partsCache;
    }
    function writeParts() {
        const out = {};
        for (const [k, p] of Object.entries(partStore()))
            out[k] = { name: p.name, source: p.source, clip: M.clipToJSON(p.clip), fit: p.fit ? 1 : 0, made: p.made };
        S.setJSON(S.KEYS.parts, out);
    }
    // A part as the UI wants it: name, size, and its pins in clip
    // coordinates (the outermost block's).
    function describePart(p) {
        return { key: p.key, name: p.name, source: p.source, w: p.clip.w, h: p.clip.h, pins: M.clipPins(p.clip), clip: p.clip };
    }
    function getPart(key) {
        const p = partStore()[key];
        return p ? describePart(p) : null;
    }
    // Level parts in the order of the ladder, then the player's own by name.
    function allParts() {
        const store = partStore();
        const lvl = LEVELS.filter((l) => l.part && store[l.id]).map((l) => describePart(store[l.id]));
        const own = Object.values(store).filter((p) => p.key.startsWith('user:'))
            .sort((a, b) => a.name.localeCompare(b.name)).map(describePart);
        return lvl.concat(own);
    }
    // In a level, the shelf holds what the levels before it made — and the
    // player's own parts made in it or a level before it (`made`): a slice
    // made here, to repeat with Array, as the 4-bit adder's full adders are
    // the tight level's. Parts made in the sandbox stay there.
    function partsFor(level) {
        if (!level) return allParts();
        const i = levelIndex(level.id), store = partStore();
        return allParts().filter((p) => {
            const src = levelIndex(p.key), made = store[p.key] && store[p.key].made;
            return (src >= 0 && src < i) || (!!made && levelIndex(made) >= 0 && levelIndex(made) <= i);
        });
    }
    // The board as it stands, as this level's part. The board must be this
    // level's, loaded; call it on a pass.
    // Returns {ok, compact, why, kept}: `why` says what kept a part from being
    // compact; `kept`, that the shelf already had a smaller one — refined by
    // hand, perhaps — which a solution that makes a bigger part does not
    // replace.
    function makeLevelPart(level) {
        if (!level.part) return { ok: false };
        const g = layout(level);
        const FACE = { n: 0, e: 1, s: 2, w: 3 };
        const pads = g.pads.map((p) => ({ name: p.name, dir: p.side === 'in' ? 'in' : 'out', x: p.x, y: p.y, face: FACE[p.edge] }));
        const fit = M.fitPart({ x0: 0, y0: 0, x1: g.w - 1, y1: g.h - 1 }, pads);
        let clip;
        if (fit.core) clip = M.captureRect(fit.core, fit.pins, level.part, level.id, fit.junctions);
        else {
            const res = M.captureBlock(level.part, level.id, pads);
            if (!res.clip) return { ok: false, error: fit.error };
            clip = res.clip;
        }
        const had = partStore()[level.id];
        const area = (c) => c.w * c.h;
        if (had && had.fit && area(had.clip) < area(clip)) return { ok: true, kept: true, compact: true, why: null };
        partStore()[level.id] = { key: level.id, name: level.part, source: level.id, clip, fit: fit.core ? 1 : 0 };
        writeParts();
        return { ok: true, compact: !!fit.core, why: fit.core ? null : fit.error };
    }
    // A level's part, replaced by one made by hand — which must pass the
    // level's tests first (testPart, or `tested`: its result, already run —
    // testPartOff). Its pins are put in the level's order.
    // Returns {ok} or {error, failure}.
    function replaceLevelPart(level, clip, tested) {
        const t = tested || testPart(level, clip);
        if (t.error) return { ok: false, error: t.error };
        if (!t.passed) return { ok: false, failure: t.failure };
        partStore()[level.id] = { key: level.id, name: level.part, source: level.id, clip, fit: 1 };
        writeParts();
        return { ok: true };
    }
    // A part of the player's own, from the sandbox. Returns its key.
    // `made`: the level it was made in, if any (see partsFor).
    function saveCustomPart(name, clip, made) {
        const key = 'user:' + name;
        partStore()[key] = { key, name, source: '', clip, made: made || undefined };
        writeParts();
        return key;
    }
    function deletePart(key) {
        delete partStore()[key];
        writeParts();
    }
    // One of the player's own parts, renamed. Its key is its name, so it
    // moves to the new one — in its place on the shelf — taking how it
    // repeats with it, and its lid says the new name wherever it is put
    // down from now on. (Copies already down are copies, and keep the name
    // they went down with.) A level's part is named by its level, and
    // solving the level again would name it so again. {ok, key} or {error}.
    function renamePart(key, name) {
        const store = partStore(), p = store[key];
        name = String(name || '').trim().slice(0, 24);
        if (!p || !key.startsWith('user:')) return { error: 'Only a part of your own can be renamed: a level’s part is named by its level' };
        if (!name) return { error: 'A part needs a name' };
        const to = 'user:' + name;
        if (to === key) return { ok: true, key };
        if (store[to]) return { error: `There is already a part called “${name}”` };
        const clip = { ...p.clip, blocks: p.clip.blocks.map((b) => (b.parent ? b : { ...b, name })) };
        const next = {};
        for (const [k, v] of Object.entries(store)) next[k === key ? to : k] = k === key ? { ...p, key: to, name, clip } : v;
        partsCache = next;
        writeParts();
        const arrays = arrayStore();
        if (arrays[key]) {
            arrays[to] = arrays[key];
            delete arrays[key];
            S.setJSON(S.KEYS.arrays, arrays);
        }
        return { ok: true, key: to };
    }
    // ---- Arrays: a part, repeated ----
    // How a part repeats — which way, how far apart, which pins are shared
    // or tapped, which end is bit 0 (model.arrayClip's spec) — is the
    // part's own, set once and kept by part key beside the shelf, so a level
    // part solved again keeps it for as long as it still repeats that way.
    // How many is not: that is chosen each time copies are put down. A part
    // repeated is a part like any other once it is down: a lid over its
    // copies, its pins named by bit. It can also repeat apart (`apartWay`:
    // {dir, pitch}, kept the same way): copies side by side, each its own
    // part, nothing joined — four latches for a register, to wire by hand —
    // which may want another way and spacing than its joined copies do.
    let arraysCache = null;
    function arrayStore() {
        if (arraysCache) return arraysCache;
        arraysCache = {};
        const raw = S.getJSON(S.KEYS.arrays, null);
        if (raw && typeof raw === 'object')
            for (const [k, v] of Object.entries(raw)) {
                if (!v || typeof v !== 'object') continue;
                arraysCache[k] = {
                    dir: v.dir & 3, pitch: v.pitch | 0, reverse: !!v.reverse,
                    shared: Array.isArray(v.shared) ? v.shared.map(String) : [],
                    taps: Array.isArray(v.taps) ? v.taps.map(String) : [],
                    tapSide: Number.isInteger(v.tapSide) ? v.tapSide & 3 : undefined,
                    apartWay: readApart(v.apartWay),
                };
            }
        return arraysCache;
    }
    const readApart = (a) => (a && typeof a === 'object' && Number.isInteger(a.dir) && Number.isInteger(a.pitch)
        ? { dir: a.dir & 3, pitch: a.pitch | 0 } : undefined);
    function arraySpec(key) {
        const s = arrayStore()[key];
        return s ? { ...s, shared: [...s.shared], taps: [...s.taps], apartWay: s.apartWay && { ...s.apartWay } } : null;
    }
    function saveArraySpec(key, spec) {
        arrayStore()[key] = {
            dir: spec.dir & 3, pitch: spec.pitch | 0, reverse: !!spec.reverse,
            shared: [...(spec.shared || [])], taps: [...(spec.taps || [])],
            tapSide: Number.isInteger(spec.tapSide) ? spec.tapSide & 3 : undefined,
            apartWay: readApart(spec.apartWay),
        };
        S.setJSON(S.KEYS.arrays, arrayStore());
    }
    // How the part `key` repeats apart ({dir, pitch, apart: true}, for
    // arrayPart): as it was set, or else the way its joined copies go (or
    // the first way that works), as close as they will sit. `spec` is the
    // part's spec as it stands, if not the one kept.
    function apartSpec(key, spec) {
        const s = spec || arraySpec(key);
        if (s && s.apartWay) return { ...s.apartWay, apart: true };
        const plan = planArray(key, { apart: true });
        if (!plan) return null;
        const way = (s && !plan.ways[s.dir].error && plan.ways[s.dir]) || plan.best;
        return way ? { dir: way.dir, pitch: way.pitch, apart: true } : null;
    }
    // The part no longer repeats.
    function clearArraySpec(key) {
        delete arrayStore()[key];
        S.setJSON(S.KEYS.arrays, arrayStore());
    }
    // The part `key` repeated n times as `spec` says (model.arrayClip), or
    // {error}. Joined up, the array's lid records how it repeats (`rep`),
    // so that once it is down it can be set out again as it was.
    function arrayPart(key, spec, n) {
        const p = partStore()[key];
        if (!p) return { error: 'No such part' };
        const r = M.arrayClip(p.clip, { ...spec, name: spec.name || p.name }, n);
        if (!r.error && !r.apart) {
            const rep = { key, dir: spec.dir, pitch: spec.pitch, reverse: !!spec.reverse, shared: [...(spec.shared || [])], taps: [...(spec.taps || [])] };
            if (Number.isInteger(spec.tapSide)) rep.tapSide = spec.tapSide;
            r.clip.blocks[0].rep = rep;
        }
        return r;
    }
    // Which ways the part `key` could repeat (model.arrayPlan).
    function planArray(key, opts) {
        const p = partStore()[key];
        return p ? M.arrayPlan(p.clip, opts || {}) : null;
    }

    // Resetting progress takes the level parts with it — they are earned by
    // solving — and leaves the player's own.
    function clearLevelParts() {
        const store = partStore();
        for (const k of Object.keys(store)) if (!k.startsWith('user:')) delete store[k];
        writeParts();
    }


    // ===== Board size, for levels built from parts =====
    //
    // A level that is meant to be built from parts (`uses`, part keys with
    // counts) needs a board big enough for the player's OWN parts, and those
    // are as big as the player made them. So the board is sized from the
    // shelf, with room round the parts for the wires.
    //
    // How the parts are laid out is the player's to choose, so the board is
    // not sized for one way only. It used to be the parts stacked in one
    // column — how a bit-slice stacks — but four tall full adders stacked
    // made a strip 27 wide and 131 tall, which a full adder turned on its
    // side (the natural way round for a slice whose carry runs down) did not
    // even fit across. Now the parts are laid out in one column, two, and so
    // on, either way up, and the board is the one that takes some layout of
    // them upright AND some layout of them turned a quarter, favouring the
    // squarer: it costs its long side^1.5 x its short side^0.5 — its area,
    // with a long thin board paying extra (a tie goes to the wider, since
    // the pads face each other across it). Four 15x29 full adders get 55x75:
    // two columns of two upright, or one column of four on their sides.
    //
    // The room for wires grows with the pads: past three a side, each wants
    // a lane of its own up or down the side of the board, and a lane is two
    // cells wide, since wires side by side join.
    //
    // With every part it names on the shelf, that is the board: no bigger
    // than the parts need. A board sized for building from scratch spreads
    // the pads so far apart that the wires between them run the width of it
    // — and they come along into the part the level makes. The level's own
    // w/h is for when the parts have not all been made (it is then built
    // from scratch, or partly so), and is the floor then.
    const PART_ROUTE_W = 12, PART_ROUTE_H = 6, PART_GAP = 3;
    // Parts ([{w, h}]) in `cols` columns, the biggest first, each into the
    // shortest column so far: the size of the lot.
    function stackSize(dims, cols) {
        const col = [];
        for (let c = 0; c < cols; c++) col.push({ w: 0, h: 0, n: 0 });
        for (const d of [...dims].sort((a, b) => b.h - a.h || b.w - a.w)) {
            const c = col.reduce((m, q) => (q.h < m.h ? q : m));
            c.h += (c.n ? PART_GAP : 0) + d.h;
            c.w = Math.max(c.w, d.w);
            c.n++;
        }
        const used = col.filter((q) => q.n);
        return { w: used.reduce((s, q) => s + q.w, 0) + PART_GAP * (used.length - 1), h: Math.max(...used.map((q) => q.h)) };
    }
    // Every board the level's parts could be laid out on — each layout of
    // them upright beside each layout turned, with room to route — and
    // whether they are all made (the level's own w/h is the floor if not).
    // Null for a board not built from parts.
    //
    // A level whose hint offers another way (`alt`, parts as `uses` has
    // them) — the incrementer's "you could use the 4-bit adder" — has room
    // for that too, once those parts are made: every board holds either.
    // (The incrementer's board held four half adders and not the 4-bit
    // adder its own hint suggested.)
    function partBoards(level) {
        if (stackLayout(level) || !level.uses) return null;
        const pads = Math.max((level.inputs || []).length, (level.outputs || []).length);
        const rw = PART_ROUTE_W + 2 * Math.max(0, pads - 3), rh = PART_ROUTE_H;
        const boardsFor = (uses) => {
            const dims = [];
            let all = true;
            for (const [key, count] of Object.entries(uses)) {
                const p = partStore()[key];
                if (!p) { all = false; continue; }
                for (let k = 0; k < count; k++) dims.push({ w: p.clip.w, h: p.clip.h });
            }
            if (!dims.length) return null;
            const layouts = (ds) => ds.map((d, k) => stackSize(ds, k + 1));
            const upright = layouts(dims), turned = layouts(dims.map((d) => ({ w: d.h, h: d.w })));
            const boards = [];
            for (const u of upright)
                for (const t of turned) boards.push({ w: Math.max(u.w, t.w) + rw, h: Math.max(u.h, t.h) + rh });
            return { boards, all };
        };
        const main = boardsFor(level.uses), alt = level.alt && boardsFor(level.alt);
        const row = rowBoard(level, rw, rh);
        const both = (bs, extra) => (extra ? bs.map((b) => ({ w: Math.max(b.w, extra.w), h: Math.max(b.h, extra.h) })) : bs);
        if (!alt || !alt.all) return main && { boards: both(main.boards, row), all: main.all };
        if (!main) return { boards: alt.boards, all: false };
        const boards = [];
        for (const m of main.boards)
            for (const a of alt.boards) boards.push({ w: Math.max(m.w, a.w), h: Math.max(m.h, a.h) });
        return { boards: both(boards, row), all: main.all };
    }
    // A level that asks for it (`row`: the register, built from four
    // copies of one part) has room for its copies in a straight row as
    // well, the way Array puts them down — with a lane above the row for
    // every pin of every copy facing up, and one below for every one facing
    // down, for the wires to them to run out to the side in — whichever way
    // round the part is turned. (The register's board held its four latches
    // two by two, and not in a row with their wiring.) Null if not, or the
    // part is not made.
    function rowBoard(level, rw, rh) {
        const uses = Object.entries(level.uses);
        if (!level.row || uses.length !== 1 || uses[0][1] < 2) return null;
        const p = partStore()[uses[0][0]], n = uses[0][1];
        if (!p) return null;
        const pins = M.clipPins(p.clip).filter((q) => q.face);
        const row = (w, h, across) => ({ w: n * w + (n - 1) * PART_GAP + rw, h: h + n * pins.filter(across).length + rh });
        const upright = row(p.clip.w, p.clip.h, (q) => q.face[1] !== 0), turned = row(p.clip.h, p.clip.w, (q) => q.face[0] !== 0);
        return { w: Math.max(upright.w, turned.w), h: Math.max(upright.h, turned.h) };
    }
    function neededSize(level) {
        let w = level.w || 40, h = level.h || 0;
        const sl = stackLayout(level);
        if (sl) return { w: sl.w, h: sl.h };
        const pb = partBoards(level);
        if (!pb) return { w, h };
        const cost = (s) => Math.pow(Math.max(s.w, s.h), 1.5) * Math.sqrt(Math.min(s.w, s.h));
        let best = null;
        for (const s of pb.boards)
            if (!best || cost(s) < cost(best) || (cost(s) === cost(best) && s.w > best.w)) best = s;
        return pb.all ? best : { w: Math.max(w, best.w), h: Math.max(h, best.h) };
    }
    // Whether a w x h board holds what the level needs: the board neededSize
    // picks, or any other layout of its parts — a part that shrinks can tip
    // the pick from wide to tall without the old board getting any smaller.
    function boardHolds(level, w, h) {
        const need = neededSize(level);
        if (w >= need.w && h >= need.h) return true;
        const pb = partBoards(level);
        if (!pb) return false;
        const fw = pb.all ? 0 : level.w || 40, fh = pb.all ? 0 : level.h || 0;
        return pb.boards.some((s) => w >= Math.max(fw, s.w) && h >= Math.max(fh, s.h));
    }
    // ===== More than the right answers =====
    //
    // A level can ask for more than its table (`maxMuxes`, and `pack`: the
    // circuit has to fit a rectangle on the board, `rect`, meeting the
    // outside on given sides, `sides` — fitted exactly as its part would
    // be, so the wires running in from the pads do not count). `judge` says
    // whether a pass of the table solves the level, and if not what is still
    // wanted: {solved} or {solved: false, stage: 'muxes' | 'pack', why}.
    // The board must be the level's, as verified (verify puts it back).
    const SIDE_WORD = { n: 'top', s: 'bottom', w: 'left', e: 'right' };
    function packCheck(level) {
        const g = layout(level), r = level.pack.rect;
        const FACE = { n: 0, e: 1, s: 2, w: 3 };
        const pads = g.pads.map((p) => ({ name: p.name, dir: p.side === 'in' ? 'in' : 'out', x: p.x, y: p.y, face: FACE[p.edge] }));
        const fit = M.fitPart({ x0: 0, y0: 0, x1: g.w - 1, y1: g.h - 1 }, pads);
        const rw = r.x1 - r.x0 + 1, rh = r.y1 - r.y0 + 1;
        if (!fit.core) return { ok: false, why: `It does not make a part yet: ${fit.error.charAt(0).toLowerCase() + fit.error.slice(1)}.` };
        const c = fit.core, w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
        if (w > rw || h > rh) return { ok: false, core: c, why: `It takes ${w}×${h} — pack it into the ${rw}×${rh} outline.` };
        if (c.x0 < r.x0 || c.y0 < r.y0 || c.x1 > r.x1 || c.y1 > r.y1)
            return { ok: false, core: c, why: `It is ${w}×${h}, small enough — now move it into the outline.` };
        for (const p of fit.pins) {
            const want = level.pack.sides[p.name];
            if (want && p.side !== want)
                return { ok: false, core: c, why: `<b>${p.name}</b> meets it on the ${SIDE_WORD[p.side]}; it belongs on the ${SIDE_WORD[want]}.` };
        }
        // What counts for a slice is how often it repeats stacked: the part
        // it would make, stacked on itself.
        const sp = slicePeriod(M.captureRect(c, fit.pins, level.part, level.id, fit.junctions));
        const max = level.pack.maxPeriod;
        if (max && sp && sp.period > max)
            return { ok: false, core: c, period: sp.period, why: `It fits, but Cin is not straight under Cout, so stacked slices need room between them for the carry to step across: one every ${sp.period} rows, where the outline asks for ${max}.` };
        return { ok: true, core: c, period: sp && sp.period };
    }
    function judge(level, result) {
        if (!result.passed) return { solved: false };
        const muxes = M.muxCount();
        if (level.maxMuxes && muxes > level.maxMuxes)
            return { solved: false, stage: 'muxes', why: `It works, with ${muxes} muxes — it can be done with ${level.maxMuxes}.` };
        if (level.pack) {
            const p = packCheck(level);
            if (!p.ok) return { solved: false, stage: 'pack', why: p.why, core: p.core };
            return { solved: true, core: p.core, period: p.period };
        }
        return { solved: true };
    }

    // ===== A stack of slices =====
    //
    // A level built from one part repeated bit by bit (`stack`: {part,
    // bits}), where the part is a slice: A and B in on its left, S out on its
    // right, its carry in at the bottom and its carry out at the top. Then
    // the board is a column of slices, bit 0 at the bottom, and every switch
    // and lamp sits level with the terminal it feeds: each wire is a straight
    // run across, and each slice's carry out runs straight up into the next
    // one's carry in. It is read off the player's OWN slice, so it is their
    // part the board is laid out for — a part that is not such a slice (its
    // A on top, say) gets the ordinary board. Slices sit one period apart
    // (slicePeriod): sharing an edge row where they can, the carry then one
    // cell of wire; there are two columns of wire on the left and one on
    // the right.
    const STACK_X0 = 4, STACK_TOP = 4;
    // How often a slice repeats, stacked on itself ({period, aligned}, or
    // null for a part with no carry in and out — `up`, the pins that run up
    // the stack, [out on top, in below]: the carry by default). What
    // matters is the period, not the height. A slice whose carry in is
    // straight under its carry out can sit flush on the next, every height
    // rows, the carry out's pin on the carry in's with no wire between — if nothing else
    // of one joins the other where it keeps bare (the arrays judge that,
    // arrayClip). If something would, the two share the row between
    // instead — the carry is one cell, both terminals at once — every
    // height + 1 rows: whatever else the two edges say about that row, it
    // is bare but for the carry, which is all either asks. (This once
    // wanted a row more where a terminal of one met a cell the other keeps
    // bare, as the arrays did; placing a part by hand never minded, and a
    // stack of the player's full adder built every 8 rows proved it.) A
    // carry that has to step across needs a row of its own to do it in
    // (height + 3).
    function slicePeriod(clip, up) {
        const [outName, inName] = up || ['Cout', 'Cin'];
        const pins = M.clipPins(clip), pin = (n) => pins.find((q) => q.name === n && q.at);
        const ci = pin(inName), co = pin(outName), H = clip.h;
        if (!ci || !co) return null;
        const aligned = ci.at[1] === H && co.at[1] === -1 && ci.at[0] === co.at[0];
        if (!aligned) return { period: H + 3, aligned };
        const flush = !M.arrayClip(clip, { dir: 0, pitch: H }, 2).error;
        return { period: H + (flush ? 0 : 1), aligned };
    }
    // `stack`: {part, bits, each, up, ends, top} — the slice's level part; how
    // many; its pins every slice has its own of, by the side their pads go
    // on (the adder's {A: 'w', B: 'w', S: 'e'}: A0..A3 down the left); the
    // pins that run up the stack, [out on top, in below] (its carry, or a
    // selector's SELo and SEL); and which of those the stack's ends have a
    // pad for, by the edge it is on (the adder's Cout at the top, the
    // selector's SEL at the bottom); and the rows above it, if not
    // STACK_TOP. A slice not laid out that way — a per-bit pin on the wrong
    // side, two of a side's pads touching — gets the ordinary board.
    //
    // Or the slice is the player's own (`slice` in place of `part`): the
    // register's, a latch carrying its enable up through it, made in the
    // level or before it — the newest on the level's shelf that is one,
    // turned and flipped whichever of the eight ways makes it one, its
    // carried-out enable called whatever the player called it (`up`'s out
    // left null: the one output left). Its pads then lie level with each
    // slice, as the adder's do. (The register's were bunched in the middle
    // of a board sized for a row of plain latches, and four of the player's
    // slices stood on end did not fit it.)
    //
    // Every part that is a slice, newest first, the first way round it is
    // one: {clip, up, name}.
    const WAYS_ROUND = [[], ['t'], ['t', 't'], ['t', 't', 't'], ['m'], ['m', 't'], ['m', 't', 't'], ['m', 't', 't', 't']];
    function stackSlices(level) {
        const st = level.stack;
        if (!st) return [];
        const store = partStore();
        const cands = st.part ? [store[st.part]].filter(Boolean)
            : partsFor(level).filter((q) => q.key.startsWith('user:')).map((q) => store[q.key]).filter(Boolean).reverse();
        const found = [];
        for (const p of cands)
            for (const ops of st.part ? [[]] : WAYS_ROUND) {
                let clip = p.clip;
                for (const op of ops) clip = op === 'm' ? M.mirrorClipH(clip) : M.rotateClipCW(clip);
                const up = sliceShape(clip, st);
                if (up) { found.push({ clip, up, name: p.name }); break; }
            }
        return found;
    }
    // Is a clip a slice the stack's way up — `each` pins on their sides,
    // `up`'s in at the bottom and its out at the top? Its [out, in], or null.
    function sliceShape(clip, st) {
        const pins = M.clipPins(clip), pin = (n) => pins.find((q) => q.name === n && q.at);
        const W = clip.w, H = clip.h, [outName, inName] = st.up;
        const into = pin(inName);
        if (!into || into.at[1] !== H) return null;
        const named = new Set([...Object.keys(st.each), inName]), rest = pins.filter((q) => q.dir === 'out' && q.at && !named.has(q.name));
        const out = outName ? pin(outName) : rest.length === 1 ? rest[0] : null;
        if (!out || out.at[1] !== -1) return null;
        for (const [name, side] of Object.entries(st.each)) {
            const q = pin(name);
            if (!q || q.at[0] !== (side === 'w' ? -1 : W)) return null;
        }
        return [out.name, inName];
    }
    // The stack a level's board is laid out for — kept while the board is
    // out (see chosenSize): a part made meanwhile must not move its pads.
    const chosenStack = new Map();
    function stackLayout(level) {
        return chosenStack.has(level.id) ? chosenStack.get(level.id) : stackFor(level);
    }
    // The stack a fresh board would be laid out for: the first slice that
    // makes one.
    function stackFor(level) {
        for (const s of stackSlices(level)) {
            const sl = stackFrom(level, s);
            if (sl) return sl;
        }
        return null;
    }
    // Every board a level built of the player's slices could have been
    // laid out for — each slice's, then the plain one (null) — for a save
    // to be matched to the one it was made on (see loadCircuit).
    function stackChoices(level) {
        if (!level.stack || !level.stack.slice) return [stackFor(level)];
        return [...stackSlices(level).map((s) => stackFrom(level, s)).filter(Boolean), null];
    }
    // A slice made since the board was laid: the slice the board would be
    // laid out for now, where the board that is out is not — so the level
    // can offer to lay it out afresh (see relayBoard). Null if none.
    function stackOffer(level) {
        if (!level.stack || !level.stack.slice || !chosenStack.has(level.id)) return null;
        const now = stackFor(level), out = chosenStack.get(level.id);
        if (!now || (out && JSON.stringify(out.padAt) === JSON.stringify(now.padAt) && out.w === now.w && out.h === now.h)) return null;
        return { name: now.name };
    }
    function stackFrom(level, s) {
        const st = level.stack;
        const pins = M.clipPins(s.clip), pin = (n) => pins.find((q) => q.name === n && q.at);
        const W = s.clip.w, H = s.clip.h, [upName, downName] = s.up;
        const out = pin(upName), into = pin(downName);
        const each = Object.entries(st.each).map(([name, side]) => ({ name, side, q: pin(name) }));
        // As often as the slice repeats (slicePeriod).
        const n = st.bits, pitch = slicePeriod(s.clip, s.up).period;
        // A side's switches and lamps two rows apart at least — in a
        // slice, and across to the next one up — or they would touch.
        for (const side of ['w', 'e']) {
            const rows = each.filter((e) => e.side === side).map((e) => e.q.at[1]).sort((u, v) => u - v);
            for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] < 2) return null;
            if (rows.length && rows[0] + pitch - rows[rows.length - 1] < 2) return null;
        }
        // The rows above the stack (`top`): room for a pad there, the
        // adder's Cout; the register's carried-out E goes nowhere, and
        // needs only the edge and its terminal's row.
        const top = st.top === undefined ? STACK_TOP : st.top;
        const padAt = {};
        for (const [name, side] of Object.entries(st.ends || {})) padAt[name] = [side, STACK_X0 + (name === upName ? out : into).at[0]];
        for (let k = 0; k < n; k++) {
            const y = top + (n - 1 - k) * pitch;
            for (const e of each) padAt[e.name + k] = [e.side, y + e.q.at[1]];
        }
        return {
            w: STACK_X0 + W + 4, h: top + (n - 1) * pitch + H + 3, padAt, name: s.name,
            // Where slice k's core goes, for whoever wants to show or build it.
            slice: (k) => ({ x: STACK_X0, y: top + (n - 1 - k) * pitch }),
        };
    }

    // The size of the board as loaded, once a save has been matched to it
    // (see loadCircuit): a board never shrinks out from under a save, and
    // grows only when the parts it is built from have outgrown it.
    const chosenSize = new Map();
    const sizeFor = (level) => chosenSize.get(level.id) || neededSize(level);

    // ===== Board layout =====
    //
    // Pads run down the two edges, one cell each, a blank row between them, and
    // an extra blank row wherever the bus name changes so A3..A0 reads as a
    // group distinct from B3..B0. Both columns are centered vertically, so a
    // level with 9 inputs and 5 outputs still looks balanced.
    const stem = (name) => name.replace(/\d+$/, '');

    function rowsFor(names) {
        const out = [];
        let row = 0;
        names.forEach((name, i) => {
            if (i > 0) row += stem(name) === stem(names[i - 1]) ? 2 : 3;
            out.push({ name, row });
        });
        return { rows: out, span: (out.length ? out[out.length - 1].row : 0) + 1 };
    }

    // The full geometry of a level's board: size, where each named pad sits,
    // and where the player's free build area is. Pure - it reads nothing from
    // the model - so the UI, the verifier and the tests all agree on it.
    // Boards are sized per level (see the note on LEVELS). The floor here is
    // only a backstop against a typo'd `h` that could not hold its own pads,
    // not a design opinion — the design opinion is that boards are tight.
    //
    // A level can pin its pads to rows of its own (`padRows`, name -> y) when
    // the automatic spacing is wrong for it: a tutorial whose wires should
    // run straight, or whose crossing should sit in the middle. Its `h` is
    // then taken as given. Or only say the order its outputs go down the
    // right in (`outputOrder`), where their own order is the wrong one.
    //
    // Or it can put each pad on any edge (`padAt`, name -> [edge, at]: 'w' or
    // 'e' with a row, 'n' or 's' with a column): the stackable adder takes
    // its carry in at the bottom and puts its carry out at the top, so that
    // one stands on another. Its w and h are then taken as given. Pads sit
    // one cell in from the edge like the rest, or on it (`padInset: 0`) for a
    // board whose every cell is meant to count. Every pad says which edge it
    // is on (`edge`).
    function layout(level) {
        // `outputOrder`: the order the output pads go down the right, where
        // it is not the outputs' own (the incrementer's carry out above S3,
        // where a stack carrying up puts it out).
        const inL = rowsFor(level.inputs), outL = rowsFor(level.outputOrder || level.outputs);
        const size = sizeFor(level);
        const w = size.w;
        const padAt = level.padAt || (stackLayout(level) || {}).padAt;
        if (padAt) {
            const h = size.h, k0 = level.padInset === undefined ? 1 : level.padInset;
            const at = (name, side) => {
                const [edge, k] = padAt[name];
                const [x, y] = edge === 'w' ? [k0, k] : edge === 'e' ? [w - 1 - k0, k] : edge === 'n' ? [k, k0] : [k, h - 1 - k0];
                return { name, side, edge, x, y };
            };
            const inputs = level.inputs.map((n) => at(n, 'in')), outputs = level.outputs.map((n) => at(n, 'out'));
            return { w, h, inputs, outputs, pads: [...inputs, ...outputs], build: { x0: 2, y0: 2, x1: w - 3, y1: h - 3 } };
        }
        const h = level.padRows ? level.h : Math.max(size.h || 0, Math.max(inL.span, outL.span) + 2);
        const place = (side, l, x) => l.rows.map(({ name, row }) => ({
            name, side, edge: side === 'in' ? 'w' : 'e', x,
            y: level.padRows && level.padRows[name] !== undefined
                ? level.padRows[name] : Math.floor((h - l.span) / 2) + row,
        }));
        const inputs = place('in', inL, 1);
        const outputs = place('out', outL, w - 2);
        return {
            w, h, inputs, outputs,
            pads: [...inputs, ...outputs],
            // Everything between the two pad columns.
            build: { x0: 2, y0: 0, x1: w - 3, y1: h - 1 },
        };
    }

    // Lay a level's board into the model: right size, empty, pads placed and
    // locked. Any existing circuit is replaced, so callers save first.
    // A fresh board is the size the level needs now, and keeps that size
    // while it is out (see chosenSize): a part made meanwhile may change what
    // the level would need, not the board already laid.
    function applyBoard(level) {
        chosenSize.delete(level.id);
        chosenStack.delete(level.id);
        const sl = stackLayout(level), g = layout(level);
        chosenSize.set(level.id, { w: g.w, h: g.h });
        chosenStack.set(level.id, sl);
        M.setLockedCells([]);          // paintCell refuses locked cells
        M.deserialize(JSON.stringify({ w: g.w, h: g.h, cells: new Array(g.w * g.h).fill(0) }));
        for (const p of g.inputs) M.paintCell(p.x, p.y, 'toggle');
        for (const p of g.outputs) M.paintCell(p.x, p.y, 'led');
        M.setLockedCells(g.pads.map((p) => [p.x, p.y]));
        return g;
    }

    // Restore a saved attempt. The pads are re-placed and re-locked from the
    // layout afterwards, so a save made by an older version of a level (or a
    // hand-edited one) can never leave the board without its terminals.
    //
    // A save from an older layout starts clean instead: its pads are
    // somewhere else, and re-placing them left the old ones lying on the
    // board as ordinary, unlocked switches and lamps. A different size gives
    // that away, and so does a switch or lamp in a pad column where the
    // layout has no pad. (Saves now carry their layout — see saveCircuit —
    // so this second check is only for ones made before they did.)
    function loadBoard(level, serialized) {
        const g = layout(level);
        M.setLockedCells([]);
        if (!serialized || !M.deserialize(serialized)) return applyBoard(level);
        if (M.GRID_W !== g.w || M.GRID_H !== g.h) return applyBoard(level);
        for (const p of g.inputs) if (M.colorOfCell(M.getCell(p.x, p.y)) !== 'toggle') M.paintCell(p.x, p.y, 'toggle');
        for (const p of g.outputs) if (M.colorOfCell(M.getCell(p.x, p.y)) !== 'led') M.paintCell(p.x, p.y, 'led');
        M.setLockedCells(g.pads.map((p) => [p.x, p.y]));
        chosenSize.set(level.id, { w: g.w, h: g.h });
        chosenStack.set(level.id, stackLayout(level));
        return g;
    }

    // Labels for view.js to draw beside each pad, outside the build area.
    function padLabels(level) {
        const g = layout(level);
        const SIDE = { w: 'left', e: 'right', n: 'top', s: 'bottom' };
        return g.pads.map((p) => ({ x: p.x, y: p.y, text: p.name, side: SIDE[p.edge] }));
    }

    // ===== The coach =====
    //
    // What a coach step's `done` test is handed: the board, in the terms the
    // step text uses. A place is a pad name ('A', 'Q') or a cell [x, y].
    function coachBoard(level) {
        const g = layout(level);
        const pads = new Map(g.pads.map((p) => [p.name, [p.x, p.y]]));
        const at = (p) => (typeof p === 'string' ? pads.get(p) : p);
        const parts = M.parts();
        const b = {
            reaches(p, q) { const a = at(p), c = at(q); return !!a && !!c && M.reaches(a[0], a[1], c[0], c[1]); },
            lit(name) { const p = at(name); return !!p && M.ledIsOn(M.getCell(p[0], p[1])); },
            parts: () => parts,
            muxes: () => parts.filter((p) => p.state === 'mux'),
            // Are all of these cells this color?
            is: (list, color) => list.every(([x, y]) => M.colorOfCell(M.getCell(x, y)) === color),
            same: (p, q) => !!p && !!q && p[0] === q[0] && p[1] === q[1],
            // Parts on the board (outermost ones), by the level they came
            // from, and where a named pin of one is.
            block: (source) => M.blockList().find((bk) => !bk.parent && bk.source === source) || null,
            pinOf(bk, name) { const pin = bk && bk.pins.find((q) => q.name === name); return pin ? pin.at : null; },
            hasPart: (key) => partsFor(level).some((p) => p.key === key),
        };
        return b;
    }

    const COACH_DONE = 'All set — press <b>Verify</b> to check it.';

    // The step to show: the first one not done yet, with its guide cells if it
    // has any. Null for a level with no coach; `index === total`, with the
    // level's closing line as `text`, once every step is done.
    function coachState(level) {
        if (!level.coach) return null;
        const b = coachBoard(level);
        const total = level.coach.length;
        let index = 0;
        while (index < total && level.coach[index].done(b)) index++;
        if (index === total) return { index, total, text: level.coachDone || COACH_DONE, guide: null };
        const step = level.coach[index];
        const text = typeof step.text === 'function' ? step.text(b) : step.text;
        return { index, total, text, guide: step.guide ? step.guide(b) : null };
    }

    // ===== Test vectors =====
    //
    // Exhaustive while the input space is small enough to be worth watching;
    // beyond that a fixed sample, with the cases that actually catch bugs
    // pinned in front: all-zero, all-one, one-hot and one-cold (which walk a
    // carry the length of a ripple chain). The sampler is a plain LCG so a
    // level's vectors are identical every run - a level that passes must not
    // then fail on a re-verify.
    const EXHAUSTIVE_LIMIT = 6; // 2^6 = 64 vectors
    const SAMPLE_COUNT = 40;

    function vectorsFor(level) {
        // A sequential level's vectors are its script, in order: they are a
        // history, not a set, and reordering or sampling them would destroy
        // the very thing being tested.
        if (level.sequential) return level.script;
        const names = level.inputs, n = names.length;
        const toObj = (mask) => {
            const v = {};
            names.forEach((name, i) => { v[name] = (mask >> i) & 1; });
            return v;
        };
        if (n <= EXHAUSTIVE_LIMIT) {
            const out = [];
            for (let mask = 0; mask < (1 << n); mask++) out.push(toObj(mask));
            return out;
        }
        const masks = [0, (1 << n) - 1];
        for (let i = 0; i < n; i++) { masks.push(1 << i); masks.push(((1 << n) - 1) ^ (1 << i)); }
        let seed = 0x9e3779b9;
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            masks.push(seed % (1 << n));
        }
        return [...new Set(masks)].map(toObj);
    }

    // ===== Verification =====
    //
    // Each vector is judged from a cold start: charges reset, inputs set, then
    // the board is stepped until it stops changing. Resetting between vectors
    // is what makes a pass mean "this circuit computes the function" rather
    // than "this circuit computes the function given the order I happened to
    // test it in" - a mux feedback loop can hold state whether or not the
    // player meant it to.
    //
    // "Stops changing" is compared over the raw cells, live charge included, so
    // a circuit still propagating is never read early. A circuit that never
    // settles (a ring oscillator) fails with that stated, rather than being
    // sampled at an arbitrary tick.
    const settleBudget = (level) => level.settle || Math.max(600, (layout(level).w + layout(level).h) * 14);

    //
    // A board that returns to a state it has already been in will cycle
    // through the same states forever — the simulation is deterministic — so
    // that is the end of it: "never settles", straight away, rather than
    // after the whole budget. A loop used to cost the full budget for every
    // single test case. States are remembered by a hash, and a hash match is
    // confirmed against the stored board before it counts.
    function boardHash(cells) {
        let h = 0x811c9dc5;
        for (let i = 0; i < cells.length; i++) h = Math.imul(h ^ cells[i], 0x01000193);
        return h >>> 0;
    }
    function settle(maxTicks) {
        let prev = M.copyCells();
        const seen = new Map([[boardHash(prev), [prev]]]);
        for (let t = 1; t <= maxTicks; t++) {
            M.stepSimulation();
            const cur = M.copyCells();
            let same = true;
            for (let i = 0; i < cur.length; i++) if (cur[i] !== prev[i]) { same = false; break; }
            if (same) return { settled: true, ticks: t };
            const h = boardHash(cur), bucket = seen.get(h);
            if (bucket && bucket.some((b) => b.every((v, i) => v === cur[i]))) return { settled: false, ticks: t, cycled: true };
            if (bucket) bucket.push(cur); else seen.set(h, [cur]);
            prev = cur;
        }
        return { settled: false, ticks: maxTicks };
    }

    // What a storage level wants at step i of its script: its `step`, given
    // the outputs before (`prev`), the inputs before (`was`, all off before
    // the first step — a cold board's switches) and the run's own `mem`. A
    // level that `wakes` leaves its first step unjudged: that is whatever the
    // circuit woke up as, and the steps after are judged from there.
    function stepWants(level, i, v, prev, was, mem) {
        if (level.wakes && i === 0) return Object.fromEntries(level.outputs.map((n) => [n, null]));
        return level.step(v, prev, was, mem);
    }
    const coldInputs = (level) => Object.fromEntries(level.inputs.map((n) => [n, 0]));

    // Every row of a level's truth table — inputs and what the outputs must
    // be — without running anything, for showing the table before a Verify.
    // A storage level's rows follow its script, each expected value given
    // the ones before; one not known (null: nothing stored there yet) is
    // carried on as not known.
    function tableCases(level) {
        const vectors = vectorsFor(level);
        if (!level.sequential) return vectors.map((v) => ({ inputs: v, expected: level.truth(v) }));
        let prev = Object.fromEntries(level.outputs.map((n) => [n, null]));
        let was = coldInputs(level);
        const mem = {};
        return vectors.map((v, i) => {
            const expected = stepWants(level, i, v, prev, was, mem);
            prev = Object.fromEntries(level.outputs.map((n) => [n, expected[n] == null ? null : expected[n]]));
            was = v;
            return { step: i, inputs: v, expected };
        });
    }

    // Drive the input pads to one vector and let the board come to rest.
    // Settling before reading is not just about correctness of the reading: a
    // storage circuit changed faster than it settles can be driven into
    // oscillation, exactly as real logic has a maximum clock rate, so "hold
    // each step until the board is quiet" is also the contract the levels are
    // written against.
    function applyVector(g, level, v, budget) {
        for (const p of g.inputs) M.setToggle(p.x, p.y, !!v[p.name]);
        const s = settle(budget);
        const got = {};
        for (const p of g.outputs) got[p.name] = M.ledIsOn(M.getCell(p.x, p.y)) ? 1 : 0;
        return { got, settled: s.settled, ticks: s.ticks };
    }

    // An output a step does not judge (null) matches whatever it is.
    const matches = (level, got, want) => level.outputs.every((name) => want[name] == null || got[name] === (want[name] & 1));

    // Runs the level's vectors against a copy of what is on the board —
    // charge, locks and any owed rearrange connections included — so
    // verifying never touches a circuit the player is mid-way through
    // debugging. Returns the first failure plus a full case list, so the UI
    // can show a truth table with the wrong row marked.
    function verify(level, opts) {
        const g = layout(level);
        const budget = (opts && opts.settle) || settleBudget(level);
        return M.withBoard(M.cloneBoard(M.activeBoard()), () => runVectors(level, g, budget));
    }

    // The level's tests on a board given as a save (serialize's JSON), its
    // pads at `g` — {inputs, outputs}: [{name, x, y}] — on a board of their
    // own. Every case resets the charge before it runs, so the save's
    // structure is all they need. What the verifier's worker runs, and what
    // is run here when there is none (see Off the page's thread).
    function runSaved(level, board, g, budget) {
        return M.withBoard(M.createBoard(1, 1), () => {
            if (!M.deserialize(board)) throw new Error('the board to verify would not load');
            return runVectors(level, g, budget);
        });
    }

    // The level's tests, run on whatever is in the model, its inputs and
    // outputs at `g`'s pads. The caller puts the board back.
    function runVectors(level, g, budget) {
        const cases = [];
        let failure = null;
        const record = (entry) => {
            cases.push(entry);
            if (!entry.ok && !failure) failure = entry;
        };
        {
            if (level.sequential) {
                // ONE start, and the whole script from it; the whole point is
                // that what came before is carried forward. What it holds
                // before anything is stored is not known — nothing has told
                // it — so the outputs start unknown (null) and a step that
                // only holds them is not judged until something has been
                // stored. It is run from rest, and then, if that passes, from
                // a charged start (see below), the run that fails taking the
                // place of the one that passed: from rest, a circuit whose
                // state was never stored reads 0, and one leaning on that
                // passed.
                const run = (primed) => {
                    const out = [];
                    let bad = null;
                    if (primed) M.primeCharges(); else M.resetCharges();
                    settle(budget);
                    let prev = Object.fromEntries(level.outputs.map((name) => [name, null]));
                    let was = coldInputs(level);
                    const mem = {};
                    level.script.forEach((v, i) => {
                        const r = applyVector(g, level, v, budget);
                        const want = stepWants(level, i, v, prev, was, mem);
                        const entry = {
                            step: i, inputs: v, expected: want, actual: r.got,
                            ok: r.settled && matches(level, r.got, want),
                            ticks: r.ticks, settled: r.settled,
                        };
                        if (primed) entry.primed = true;
                        out.push(entry);
                        if (!entry.ok && !bad) bad = entry;
                        // The next step is judged against what the circuit
                        // ACTUALLY did, not against what it should have done:
                        // once it has gone wrong, reporting every later step
                        // as a failure too buries the one that matters.
                        prev = r.got;
                        was = v;
                    });
                    return { out, bad };
                };
                let r = run(false);
                if (!r.bad) {
                    const charged = run(true);
                    if (charged.bad) r = charged;
                }
                for (const entry of r.out) record(entry);
                if (r.out.some((c) => c.primed)) return { passed: !failure, cases, failure, level: level.id, primed: true };
            } else {
                // Every vector from a cold start. A mux feedback loop can hold
                // state whether or not the player meant it to, so testing
                // without a reset would make a pass mean "computes this given
                // the order I happened to test in".
                for (const v of vectorsFor(level)) {
                    M.resetCharges();
                    const r = applyVector(g, level, v, budget);
                    const want = level.truth(v);
                    record({
                        inputs: v, expected: want, actual: r.got,
                        ok: r.settled && matches(level, r.got, want),
                        ticks: r.ticks, settled: r.settled,
                    });
                }
                // Then again, each from a charged start (M.primeCharges):
                // what is driven comes out the same, and what nothing
                // drives keeps its charge. A circuit that passes from rest
                // and not from there leans on a pin left unwired reading 0
                // — the player's 4-bit adder with its carry in left open —
                // which works until something charges it. The case it fails
                // is put in place of the one that passed (`primed`, so that
                // its replay starts charged too).
                if (!failure) {
                    const list = vectorsFor(level);
                    for (let i = 0; i < list.length && !failure; i++) {
                        M.primeCharges();
                        const r = applyVector(g, level, list[i], budget);
                        const want = level.truth(list[i]);
                        if (r.settled && matches(level, r.got, want)) continue;
                        cases[i] = { inputs: list[i], expected: want, actual: r.got, ok: false, ticks: r.ticks, settled: r.settled, primed: true };
                        failure = cases[i];
                    }
                }
            }
        }
        return { passed: !failure, cases, failure, level: level.id };
    }

    // Does a part do a level's job? It is put down on a scratch board of its
    // own, a switch on each input's terminal and a lamp on each output's, and
    // run through the level's own tests — the same vectors, the same
    // settling. The part's pins must be named for the level's inputs and
    // outputs, each once. Returns the verify result, or {error}. The board
    // being edited is never touched.
    function testPart(level, clip) {
        const bench = partBench(level, clip);
        return bench.error ? bench : runSaved(level, bench.board, bench.g, bench.budget);
    }
    // The scratch board testPart runs on, as a save, with its pads: {board,
    // g, budget}, or {error}.
    function partBench(level, clip) {
        const pins = M.clipPins(clip);
        const names = (dir) => pins.filter((q) => q.dir === dir).map((q) => q.name).sort().join(',');
        if (names('in') !== [...level.inputs].sort().join(',') || names('out') !== [...level.outputs].sort().join(','))
            return { error: `The ${level.part} part’s terminals are ${level.inputs.join(', ')} in and ${level.outputs.join(', ')} out` };
        const m = 3;
        return M.withBoard(M.createBoard(clip.w + 2 * m, clip.h + 2 * m), () => {
            M.pasteRegion(clip, m, m);
            if (!M.blockList().length) return { error: 'It would not go down on a board of its own' };
            const g = { inputs: [], outputs: [] };
            for (const q of pins) {
                const x = m + q.at[0], y = m + q.at[1];
                M.paintCell(x, y, q.dir === 'in' ? 'toggle' : 'led');
                (q.dir === 'in' ? g.inputs : g.outputs).push({ name: q.name, x, y });
            }
            return { board: M.serialize(), g, budget: settleBudget(level) };
        });
    }

    // ===== Off the page's thread =====
    //
    // A level's tests take as long as its board takes to settle, case after
    // case — near half a second for the parallel-to-serial register, and
    // longer for every rung above it — and while they run on the page it can
    // neither draw nor answer a click. So the editor runs them in a worker
    // (verify-worker.js), which loads the same model, levels and game code
    // and runs `runSaved` on a copy of the board sent as a save; the answer
    // comes back as a promise. Where there is no worker — in Node, or one
    // that fails to start — the same `runSaved` runs here, so the answer is
    // the same either way, only later or sooner. So does a level that is not
    // one of LEVELS (a test's own): the worker knows levels by their ids.
    //
    // The worker takes its jobs one at a time, in order. One that may run
    // away — a timing report — comes with a limit, counted from when it is
    // the one being worked on: past it, the worker is stuck. It is replaced,
    // that job answers with its `late` answer, and the jobs behind it go to
    // the new one. Nothing waits behind a stuck job for ever.
    let worker = null, workerFailed = false, jobSeq = 0;
    const jobs = new Map();     // id -> {resolve, reject, local, msg, limit, late, timer}: `local` runs the job here instead
    const runHere = (j) => { try { j.resolve(j.local()); } catch (err) { j.reject(err); } };
    // The job being worked on is the oldest not answered: its limit runs.
    function watchHead() {
        const head = jobs.entries().next().value;
        if (!head) return;
        const [id, j] = head;
        if (!j.limit || j.timer) return;
        j.timer = setTimeout(() => {
            if (jobs.get(id) !== j) return;
            jobs.delete(id);
            if (worker) worker.terminate();
            worker = null;
            j.resolve(j.late);
            const rest = [...jobs.values()];
            jobs.clear();
            const w = startVerifier();
            for (const r of rest) {
                if (!w) { runHere(r); continue; }
                clearTimeout(r.timer);
                r.timer = null;
                const rid = ++jobSeq;
                jobs.set(rid, r);
                w.postMessage({ ...r.msg, id: rid });
            }
            watchHead();
        }, j.limit);
    }
    function startVerifier() {
        if (worker || workerFailed || typeof Worker === 'undefined') return worker;
        // A worker that cannot start, or stops, hands what it had back.
        const fail = () => {
            workerFailed = true;
            if (worker) worker.terminate();
            worker = null;
            const pending = [...jobs.values()];
            jobs.clear();
            pending.forEach((j) => { clearTimeout(j.timer); runHere(j); });
        };
        try { worker = new Worker('verify-worker.js', { type: 'module' }); }
        catch (e) { fail(); return null; }
        worker.onmessage = (e) => {
            const j = jobs.get(e.data.id);
            if (!j) return;
            jobs.delete(e.data.id);
            clearTimeout(j.timer);
            if (e.data.failed) runHere(j); else j.resolve(e.data.result);
            watchHead();
        };
        worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fail(); };
        worker.onmessageerror = fail;
        return worker;
    }
    // A job for the worker — its `kind` says which (a level's tests by
    // default; 'timing', timing.js's measure) — or for `local`, here, where
    // there is none. Either way, a promise of the answer. `opts.limit`: how
    // long it may take, in ms, before it is taken to be stuck; `opts.late`,
    // its answer then.
    function offThread(level, job, local, opts) {
        return new Promise((resolve, reject) => {
            const j = { resolve, reject, local, msg: job, limit: opts && opts.limit, late: opts && opts.late, timer: null };
            const w = getLevel(level.id) === level && startVerifier();
            if (!w) { Promise.resolve().then(() => runHere(j)); return; }
            const id = ++jobSeq;
            jobs.set(id, j);
            w.postMessage({ id, ...job });
            watchHead();
        });
    }
    function runOff(level, board, g, budget) {
        const pads = (list) => list.map((p) => ({ name: p.name, x: p.x, y: p.y }));
        const job = { level: level.id, board, g: { inputs: pads(g.inputs), outputs: pads(g.outputs) }, budget };
        return offThread(level, job, () => runSaved(level, job.board, job.g, job.budget));
    }
    // verify, off the page's thread: the board as it is now.
    function verifyOff(level, opts) {
        const budget = (opts && opts.settle) || settleBudget(level);
        return runOff(level, M.serialize(), layout(level), budget);
    }
    // testPart, off the page's thread.
    function testPartOff(level, clip) {
        const bench = partBench(level, clip);
        return bench.error ? Promise.resolve(bench) : runOff(level, bench.board, bench.g, bench.budget);
    }

    // ===== Watching it run =====
    //
    // `verify` above answers the question in a few milliseconds, which is the
    // right thing for a test suite and the wrong thing for a person: passing a
    // level should look like the circuit doing its job, not like a word
    // appearing. This drives the same vectors through the same board, but one
    // simulation tick at a time under the caller's control, so the UI can let
    // the charge actually travel and fill in a truth table as it goes.
    //
    // Deliberately NOT a second implementation of the rules: it applies the
    // same vectors in the same order with the same settle condition. The
    // verdict still comes from `verify`; this is the performance of it.
    function replay(level) {
        const g = layout(level);
        const budget = settleBudget(level);
        const vectors = vectorsFor(level);
        let index = -1, quietFor = 0, elapsed = 0, prevCells = null;
        return {
            total: vectors.length,
            get index() { return index; },
            // Cold start — or charged, for a storage level whose verdict
            // came from there. Sequential levels reset here and only here;
            // for everything else each vector gets its own in begin().
            start(primed) {
                if (primed) M.primeCharges(); else M.resetCharges();
                prevCells = null; quietFor = 0; elapsed = 0; index = -1;
            },
            // Move to vector n and drive the input pads to it — from a
            // charged start (`primed`) for a case the verdict ran so.
            begin(n, primed) {
                index = n;
                if (!level.sequential) { if (primed) M.primeCharges(); else M.resetCharges(); }
                for (const p of g.inputs) M.setToggle(p.x, p.y, !!vectors[n][p.name]);
                prevCells = null; quietFor = 0; elapsed = 0;
            },
            // One simulation step. Returns true once the board has come to
            // rest (or the budget is spent), which is when the outputs mean
            // something and the caller may move on.
            tick() {
                M.stepSimulation();
                elapsed++;
                const cur = M.copyCells();
                let same = prevCells !== null;
                if (same) for (let i = 0; i < cur.length; i++) if (cur[i] !== prevCells[i]) { same = false; break; }
                prevCells = cur;
                quietFor = same ? quietFor + 1 : 0;
                return quietFor >= 1 || elapsed >= budget;
            },
            outputs() {
                const got = {};
                for (const p of g.outputs) got[p.name] = M.ledIsOn(M.getCell(p.x, p.y)) ? 1 : 0;
                return got;
            },
            vectorAt: (n) => vectors[n],
        };
    }

    // ===== Progress =====
    function loadProgress() {
        const raw = S.getJSON(S.KEYS.progress, null);
        if (raw && typeof raw === 'object' && raw.completed && typeof raw.completed === 'object')
            return {
                completed: raw.completed, current: raw.current || null, mode: raw.mode || 'campaign',
                // Levels in stages: the stage reached ('pack') in one not yet solved.
                reached: raw.reached && typeof raw.reached === 'object' ? raw.reached : {},
            };
        return { completed: {}, current: null, mode: 'campaign', reached: {} };
    }
    function saveProgress(p) { S.setJSON(S.KEYS.progress, p); }
    // The first level is always open, and solving a level opens the next one.
    // Nothing further back is ever re-locked, so a completed campaign stays
    // fully browsable — and a level you have solved stays open even if a new
    // one is added in front of it, which is how the ladder grows.
    function isUnlocked(id, progress) {
        const i = levelIndex(id);
        if (i < 0) return false;
        if (i === 0 || progress.completed[id]) return true;
        return !!progress.completed[LEVELS[i - 1].id];
    }
    function nextLevel(id) {
        const i = levelIndex(id);
        return i >= 0 && i + 1 < LEVELS.length ? LEVELS[i + 1] : null;
    }

    // A save remembers the layout it was made on — board size and where
    // every pad sits — so a level whose layout has changed since starts clean
    // rather than loading a board drawn around pads that have moved.
    const layoutKey = (id) => {
        const level = getLevel(id);
        if (!level) return '';
        const g = layout(level);
        return g.w + 'x' + g.h + ':' + g.pads.map((p) => p.name + '@' + p.x + ',' + p.y).join(' ');
    };
    function saveCircuit(id, serialized) {
        S.setText(S.circuitKey(id), serialized);
        S.setText(S.circuitLayoutKey(id), layoutKey(id));
    }
    // A save made on a board that still holds what the level needs keeps
    // that board (see chosenSize, boardHolds), so a level built from parts
    // does not lose its save because a part it uses got smaller.
    //
    // The size is the board's own, read off the save. (A record once took
    // the size the level would have had at the time, not its board's: a part
    // made in the level grew the one and not the other, and the board was
    // dropped on the next load. A record that is not its board's size is
    // not believed; the board is, if every pad of the level at that size is
    // on it and nothing else of theirs is.)
    //
    // A level built of the player's slices (stack.slice) could have been
    // laid out for any of them, or none: the save comes back on whichever
    // board it was made on. (A slice made since must not lose it — the
    // level offers the new board instead, see stackOffer.)
    function loadCircuit(id) {
        chosenSize.delete(id);
        chosenStack.delete(id);
        const saved = S.getText(S.circuitLayoutKey(id));
        if (saved === null) return null;
        const level = getLevel(id), text = S.getText(S.circuitKey(id)), m = /^(\d+)x(\d+):/.exec(saved);
        const said = m && { w: +m[1], h: +m[2] }, size = savedSize(text) || said;
        for (const sl of level ? stackChoices(level) : [null]) {
            if (level && level.stack) chosenStack.set(id, sl);
            if (level && size && boardHolds(level, size.w, size.h)) chosenSize.set(id, size);
            if (saved === layoutKey(id)) return text;
            if (level && said && (said.w !== size.w || said.h !== size.h) && padsOn(level, size, text)) return text;
            chosenSize.delete(id);
        }
        chosenStack.delete(id);
        return null;
    }
    function savedSize(text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) { return null; }
        return data && Number.isInteger(data.w) && Number.isInteger(data.h) ? { w: data.w, h: data.h } : null;
    }
    // Whether a saved board has the level's pads where its layout at the
    // board's size puts them, and no switch or lamp anywhere else.
    function padsOn(level, size, text) {
        const g = layout(level);
        if (g.w !== size.w || g.h !== size.h) return false;
        return M.withBoard(M.createBoard(1, 1), () => {
            if (!M.deserialize(text)) return false;
            const want = new Map(g.pads.map((p) => [p.x + ',' + p.y, p.side === 'in' ? 'toggle' : 'led']));
            let found = 0;
            for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
                const c = M.colorOfCell(M.getCell(x, y));
                if (c !== 'toggle' && c !== 'led') continue;
                if (want.get(x + ',' + y) !== c) return false;
                found++;
            }
            return found === want.size;
        });
    }
    function clearCircuit(id) {
        chosenSize.delete(id);
        chosenStack.delete(id);
        S.remove(S.circuitKey(id));
        S.remove(S.circuitLayoutKey(id));
    }

    window.PixelogicGame = {
        LEVELS, CHAPTERS,
        getLevel, levelIndex, levelsIn, nextLevel,
        layout, applyBoard, loadBoard, padLabels, coachState,
        vectorsFor, tableCases, verify, replay, settle, settleBudget, loadHoldScript,
        runVectors, runSaved, startVerifier, verifyOff, testPartOff, offThread,
        allParts, partsFor, getPart, makeLevelPart, replaceLevelPart, testPart, saveCustomPart, deletePart, renamePart, clearLevelParts,
        arraySpec, saveArraySpec, clearArraySpec, arrayPart, planArray, apartSpec,
        neededSize, boardHolds, stackLayout, stackOffer, slicePeriod, judge, packCheck,
        loadProgress, saveProgress, isUnlocked,
        saveCircuit, loadCircuit, clearCircuit,
        busNames, busVal, busBits,
    };
})(window);
