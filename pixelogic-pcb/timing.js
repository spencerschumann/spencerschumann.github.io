(function (window) {
    // timing.js - how a clocked board behaves in time, measured in the
    // simulator: when each data input may change around the clock edge and
    // when it must be left alone, how long the outputs take to follow, the
    // narrowest clock pulses that still work, the fastest clock — and
    // waveforms of the pads, and of any probes the player has clipped on,
    // to see it by.
    //
    // Nothing here knows a level's circuit. It reads the level's own script
    // (its storage steps) and its clock (`clock`), runs the script once to
    // see what the board does with every change given time to settle, then
    // replays the parts around rising edges with the changes moved closer
    // together, and compares. A tick is the simulator's step; the speed
    // slider only says how many run a second.
    //
    // The words: for a data input and a rising edge, a change of the input
    // `off` ticks after the edge (negative: before it) either still gets
    // in (the outcome the script itself gives), misses (the outcome of a
    // change long after), or neither — another answer, or a board that
    // does not settle, charge circling in a loop for good. The keep-out is
    // the stretch between the last offset from which every earlier change
    // gets in and the first from which every later one misses. `setup` is
    // how long before the edge the input must have changed (negative: it
    // may change that long after); `hold`, how long after the edge it must
    // be left alone.
    //
    // It has to be quick: it runs after every passing Verify of a clocked
    // level. So nothing is swept that can be searched — the keep-out's ends
    // are found by halving, only the stretch between them tick by tick —
    // and a settle compares the board's two buffers in place rather than
    // copying and hashing it every tick. And it is bounded: past DEADLINE_MS
    // it stops, and says what it had not got to.
    const M = window.PixelogicModel;
    const G = window.PixelogicGame;

    const DEADLINE_MS = 4000;

    // Step until a tick changes nothing — the tick before is the one
    // stepping swapped into nextCells — or `max` ticks: the ticks it took,
    // or -1. A board going round in circles is -1 as soon as it comes back
    // to a state it was in: it is compared with itself as it was at 16
    // ticks, 32, 64… (Brent's way), so a ring is caught within twice its
    // period rather than costing the whole `max`. Optionally `seen` hears
    // each tick.
    const same = (a, z) => { for (let k = 0; k < a.length; k++) if (a[k] !== z[k]) return false; return true; };
    function quiet(max, seen) {
        let snap = null, next = 16;
        for (let t = 1; t <= max; t++) {
            M.stepSimulation();
            if (seen) seen(t);
            const B = M.activeBoard();
            if (same(B.cells, B.nextCells)) return t;
            if (snap && same(B.cells, snap)) return -1;
            if (t === next) { snap = B.cells.slice(); next *= 2; }
        }
        return -1;
    }

    // ---- A stimulus, played ----
    //
    // Every waveform is a stimulus played: {start, pads, events, ticks,
    // rest} — the board to start from (a save, its charge and all), the
    // input pads, when each input changes ([{t, name, v}]), how many ticks
    // to watch, and how long after to wait for it to come to rest. The
    // report's own are played here, and the player's moves of their edges
    // in the scope are played the same way, on the page: what the scope
    // draws for a moved edge is what the board does. `channels` are what
    // to record: [{name, kind, x, y}]. Returns the recording, a character a
    // tick ('0' off, '1' charged, '2' draining, '-' nothing there), and
    // whether it comes to rest afterwards (`rests`).
    function play(stim, channels) {
        return M.withBoard(M.createBoard(1, 1), () => {
            if (!M.deserialize(stim.start)) return null;
            const pad = new Map(stim.pads.map((p) => [p.name, p]));
            const due = new Map();
            for (const e of stim.events) { if (!due.has(e.t)) due.set(e.t, []); due.get(e.t).push(e); }
            const data = channels.map(() => []);
            for (let t = 0; t < stim.ticks; t++) {
                for (const e of due.get(t) || []) { const p = pad.get(e.name); if (p) M.setToggle(p.x, p.y, !!e.v); }
                channels.forEach((c, k) => { const v = M.chargeAt(c.x, c.y); data[k].push(v === null ? '-' : String(v)); });
                M.stepSimulation();
            }
            return {
                ticks: stim.ticks, rests: quiet(stim.rest || 2000) > 0,
                channels: channels.map((c, k) => ({ name: c.name, kind: c.kind, x: c.x, y: c.y, data: data[k].join('') })),
            };
        });
    }
    // When a stimulus raises the clock.
    const risesOf = (stim, clock) => stim.events.filter((e) => e.name === clock && e.v).map((e) => e.t).sort((a, z) => a - z);
    // Edges per data input and direction of its change.
    const CASES_PER_WAY = 1;

    function measure(level, g, opts) {
        const clock = level.clock;
        if (!level.sequential || !clock) return { error: 'Only a clocked level has a timing to measure' };
        const started = Date.now();
        const over = () => Date.now() - started > ((opts && opts.deadline) || DEADLINE_MS);
        // A probe on a pad is that pad's row already.
        const onPad = (p) => g.inputs.concat(g.outputs).some((q) => q.x === p.x && q.y === p.y);
        const probes = ((opts && opts.probes) || []).filter((p) => !onPad(p));
        const data = level.inputs.filter((n) => n !== clock);
        const zeros = Object.fromEntries(level.inputs.map((n) => [n, 0]));
        const inPad = new Map(g.inputs.map((p) => [p.name, p]));
        const set = (name, v) => { const p = inPad.get(name); if (p) M.setToggle(p.x, p.y, !!v); };
        const apply = (v) => { for (const n of level.inputs) set(n, v[n]); };
        const outs = () => g.outputs.map((p) => (M.ledIsOn(M.getCell(p.x, p.y)) ? '1' : '0')).join('');
        const clone = () => M.cloneBoard(M.activeBoard());
        // The board at rest, as a key: its outputs and a hash of every cell.
        const state = () => {
            const a = M.activeBoard().cells;
            let h = 2166136261;
            for (let k = 0; k < a.length; k++) h = Math.imul(h ^ a[k], 16777619);
            return outs() + ':' + (h >>> 0).toString(36);
        };
        const from = (state, fn) => M.withBoard(M.cloneBoard(state), fn);
        const step = (n) => { for (let i = 0; i < n; i++) M.stepSimulation(); };
        const padList = g.inputs.map((p) => ({ name: p.name, x: p.x, y: p.y }));
        const channels = [
            ...g.inputs.map((p) => ({ name: p.name, x: p.x, y: p.y, kind: 'in' })),
            ...g.outputs.map((p) => ({ name: p.name, x: p.x, y: p.y, kind: 'out' })),
            ...probes.map((p) => ({ name: p.name, x: p.x, y: p.y, kind: 'probe' })),
        ];

        // ---- The script once, every step given time to settle: the board
        // before each step, what it shows after, and — at a rising edge —
        // the tick its outputs last changed (clock to outputs).
        const settleMax = G.settleBudget(level);
        const script = G.vectorsFor(level);
        M.resetCharges();
        const before = [], after = [];
        for (const v of script) {
            before.push(clone());
            apply(v);
            let last = outs(), changed = null;
            const t = quiet(settleMax, (k) => { const o = outs(); if (o !== last) { last = o; changed = k; } });
            after.push({ outs: last, settled: t > 0, changed });
        }
        const prev = (i) => (i > 0 ? script[i - 1] : zeros);
        const edges = [];
        for (let i = 0; i < script.length; i++) if (script[i][clock] && !prev(i)[clock]) edges.push(i);
        if (!edges.length) return { error: 'Its script never raises the clock' };
        const c2q = edges.map((i) => after[i].changed).filter((t) => t !== null);
        const clockToOut = c2q.length ? { min: Math.min(...c2q), max: Math.max(...c2q) } : null;
        const reach = clockToOut ? clockToOut.max : 20;
        // Long enough for anything that will settle to have settled.
        const runMax = 3 * reach + 60;
        // The slowest edge, where a pulse too short shows first.
        const slowest = edges.slice().sort((a, z) => (after[z].changed || 0) - (after[a].changed || 0)).slice(0, 1);

        // ---- The keep-out of each data input. A case: an edge, and an
        // input the script changes just before it (or with it).
        function caseFor(i, x) {
            const p = prev(i), pp = i > 1 ? script[i - 2] : zeros;
            if (i > 0 && p[x] !== pp[x]) return { i, x, old: pp[x], neu: p[x], base: i - 1 };
            if (script[i][x] !== p[x]) return { i, x, old: p[x], neu: script[i][x], base: i };
            return null;
        }
        // The board settled with everything but `x` as at the edge.
        function baseOf(c) {
            return from(before[c.base], () => {
                if (c.base === c.i - 1) { apply(script[c.i - 1]); set(c.x, c.old); quiet(settleMax); }
                return clone();
            });
        }
        // x changes `off` ticks after the clock rises (before it, if
        // negative): what the board comes to — or '~' if it does not
        // settle. What it comes to is the whole board at rest, not only its
        // outputs: a bit a register takes in may not reach an output for
        // clocks yet, and is still caught or missed.
        function runAt(c, base, off) {
            return from(base, () => {
                const rise = () => { for (const n of level.inputs) if (n !== c.x) set(n, script[c.i][n]); };
                if (off < 0) { set(c.x, c.neu); step(-off); rise(); } else { rise(); step(off); set(c.x, c.neu); }
                return quiet(runMax) > 0 ? state() : '~';
            });
        }
        function sweep(c) {
            const base = baseOf(c), W = Math.max(24, reach + 20);
            const memo = new Map(), at = (off) => { if (!memo.has(off)) memo.set(off, runAt(c, base, off)); return memo.get(off); };
            const early = at(-W), late = at(W);
            if (early === late || early === '~' || late === '~') return null;   // the change does not matter here
            // The first offset that does not get in, and the last that does
            // not miss, by halving; then the stretch between, tick by tick.
            let lo = -W, hi = W;
            while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (at(m) === early) lo = m; else hi = m; }
            let lastIn = lo;
            lo = -W; hi = W;
            while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (at(m) === late) hi = m; else lo = m; }
            let firstOut = hi;
            // Whether a change in there can leave it ringing: a few offsets
            // across it, not every one.
            const rings = [], a = Math.min(lastIn, firstOut) + 1, z = Math.max(lastIn, firstOut) - 1;
            const stride = Math.max(1, Math.ceil((z - a + 1) / 8));
            for (let off = a; off <= z && !over(); off += stride) if (at(off) === '~') rings.push(off);
            // Halving can land on a stray answer inside: keep the outer ends.
            while (lastIn > -W && at(lastIn) !== early) lastIn--;
            while (firstOut < W && at(firstOut) !== late) firstOut++;
            return { ...c, base, lastIn, firstOut, rings, W };
        }
        // Each input in turn, a way of its change at a time, so the time
        // there is goes round them all.
        const sweeps = [], casesOf = new Map(data.map((x) => [x, []]));
        for (let n = 0; n < CASES_PER_WAY; n++)
            for (const way of [1, 0])
                for (const x of data) {
                    if (over()) break;
                    const taken = casesOf.get(x);
                    for (const i of edges) {
                        const c = caseFor(i, x);
                        if (!c || (c.neu ? 1 : 0) !== way || taken.some((s) => s.i === i)) continue;
                        const s = sweep(c);
                        if (s) { taken.push(s); sweeps.push(s); break; }
                    }
                }
        const inputs = data.map((x) => {
            const cases = casesOf.get(x);
            if (!cases.length) return { name: x, cases: 0 };
            const lastIn = Math.min(...cases.map((s) => s.lastIn)), firstOut = Math.max(...cases.map((s) => s.firstOut));
            return {
                name: x, cases: cases.length, setup: -lastIn, hold: firstOut,
                from: lastIn + 1, to: firstOut - 1, rings: cases.some((s) => s.rings.length > 0),
            };
        });

        // ---- The narrowest clock pulses. High: the clock up for w ticks
        // and down again; it must leave what a full pulse leaves. Low: the
        // clock down for w ticks (the inputs changing as it falls), and up.
        // Searched upward — doubling, then halving back — on the slowest
        // edge.
        // A pass the next two widths do not share is a fluke, and looked
        // past — a few times, no more, and never past the time allowed. (It
        // once looked past them for ever: a board whose widths passed and
        // failed by turns kept a worker busy, and every Verify after it
        // waiting, until the page was closed.)
        function narrowest(run) {
            const want = run(Infinity), ok = (w) => run(w) === want;
            let lo = 0, hi = 1;
            for (let round = 0; round < 6 && !over(); round++) {
                while (!ok(hi)) { if (hi > 2 * runMax || over()) return null; lo = hi; hi *= 2; }
                while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (ok(m)) hi = m; else lo = m; }
                if (ok(hi + 1) && ok(hi + 2)) return hi;
                lo = hi + 2; hi = lo + 1;
                if (hi > 2 * runMax) return null;
            }
            return null;
        }
        const worstOf = (list) => list.reduce((w, v) => (v !== null && (w === null || v > w) ? v : w), null);
        const minHigh = worstOf(slowest.map((i) => narrowest((w) => from(before[i], () => {
            apply(script[i]);
            if (w === Infinity) quiet(settleMax); else step(w);
            apply(Object.assign({}, script[i], { [clock]: 0 }));
            return quiet(runMax) > 0 ? outs() : '~';
        }))));
        // The low half needs an edge with a fall before it: the slowest of
        // those.
        const fallBefore = (i) => { let j = i - 1; while (j > 0 && !(script[j - 1][clock] && !script[j][clock])) j--; return j; };
        const lowEdge = edges.filter((i) => fallBefore(i) > 0).sort((a, z) => (after[z].changed || 0) - (after[a].changed || 0))[0];
        const minLow = lowEdge === undefined ? null : narrowest((w) => from(before[fallBefore(lowEdge)], () => {
            apply(script[lowEdge - 1]);
            if (w === Infinity) quiet(settleMax); else step(w);
            apply(script[lowEdge]);
            return quiet(runMax) > 0 ? outs() : '~';
        }));

        // ---- The fastest clock: a square wave of period P through every
        // edge of the script, each edge's inputs set a little before it, in
        // the low half. One tick before each next edge the outputs must be
        // what the edge before left given all the time it needed, and the
        // board must settle when it stops. No period shorter than the
        // outputs take to follow can pass, so the search starts there.
        // With `log`, every input change it makes is logged ({t, name, v})
        // and `log.ticks` says how long it ran: a stimulus to play.
        function clocked(P, only, log) {
            const half = Math.floor(P / 2), lead = Math.max(1, Math.floor((P - half) / 2));
            const run = only ? edges.slice(0, only) : edges;
            return from(before[edges[0]], () => {
                let ok = true, t = 0;
                const tick = (n) => { step(n); t += n; };
                const put = (n, v) => { set(n, v); if (log) log.push({ t, name: n, v: v ? 1 : 0 }); };
                for (let k = 0; k < run.length && (ok || log); k++) {
                    const i = run[k];
                    for (const n of data) put(n, script[i][n]);
                    tick(lead - 1);
                    if (k > 0 && outs() !== after[run[k - 1]].outs) ok = false;
                    tick(1);
                    put(clock, 1);
                    tick(half);
                    put(clock, 0);
                    tick(P - half - lead);
                }
                tick(lead - 1);
                if (outs() !== after[run[run.length - 1]].outs) ok = false;
                if (log) log.ticks = t + 20;
                return ok && quiet(runMax) > 0;
            });
        }
        let minPeriod = null;
        let P = Math.max(4, reach + 1, (minHigh || 1) + (minLow || 1));
        P += P % 2;
        for (const stop = P + 4 * reach + 60; P <= stop && minPeriod === null && !over(); P += 2)
            if (clocked(P) && clocked(P + 2, 4)) minPeriod = P;

        // ---- Waveforms to see it by: stimuli, played (see play). Each
        // trace has its stimulus, to be moved about in the scope, and the
        // keep-out of the input it is about (`keep`), to shade round each
        // rise of the clock.
        const traces = [];
        const trace = (stim, extra) => Object.assign({ stim }, play(stim, channels), extra);
        // Ten quiet ticks, the clock rising, and x changing `off` ticks
        // after it (before it, if negative) — with any other input the
        // script changes at that edge changing as the clock rises.
        function caseStim(c, off) {
            const R = 10 + Math.max(0, -off);
            return from(c.base, () => {
                const now = (n) => { const p = inPad.get(n); return p && M.chargeAt(p.x, p.y) === 1 ? 1 : 0; };
                const events = [{ t: R + off, name: c.x, v: c.neu ? 1 : 0 }];
                for (const n of level.inputs) if (n !== c.x && (script[c.i][n] ? 1 : 0) !== now(n)) events.push({ t: R, name: n, v: script[c.i][n] ? 1 : 0 });
                return { start: M.serialize(), pads: padList, events: events.sort((a, z) => a.t - z.t), ticks: R + Math.max(0, off) + reach + 80, rest: runMax };
            });
        }
        const keepOf = (x) => { const d = inputs.find((i) => i.name === x); return d && d.cases ? { name: x, from: d.from, to: d.to } : null; };
        const show = sweeps[0];
        if (show) {
            // A change in good time: well before the keep-out.
            traces.push(trace(caseStim(show, Math.max(-show.W, show.lastIn - 10)), { id: 'edge', title: `${show.x} in good time`, keep: keepOf(show.x) }));
            // A change inside it: one that leaves it ringing, if any does.
            const bad = sweeps.find((x) => x.rings.length) || show;
            const at = bad.rings.length ? bad.rings[0] : Math.round((bad.lastIn + bad.firstOut) / 2);
            traces.push(trace(caseStim(bad, at), {
                id: 'keepout', title: `${bad.x} changing ${at < 0 ? `${-at} ticks before` : `${at} ticks after`} the edge`, keep: keepOf(bad.x),
            }));
        }
        if (minPeriod) {
            const log = [];
            clocked(minPeriod, 4, log);
            const start = from(before[edges[0]], () => M.serialize());
            traces.push(trace({ start, pads: padList, events: log, ticks: log.ticks, rest: runMax },
                { id: 'fastest', title: `Clocked every ${minPeriod} ticks`, keep: data.length ? keepOf(data[0]) : null }));
        }

        return { clock, inputs, clockToOut, minHigh, minLow, minPeriod, traces, truncated: over(), ms: Date.now() - started };
    }

    // measure, on a board sent as a save (the verify worker's way in).
    function measureSaved(level, board, g, probes) {
        return M.withBoard(M.createBoard(1, 1), () => {
            if (!M.deserialize(board)) throw new Error('the board to measure would not load');
            return measure(level, g, { probes });
        });
    }
    // measure, off the page's thread: the board as it is now.
    // A job that has not answered a while after its own deadline is stuck:
    // the worker is replaced, and the answer is that it took too long.
    function measureOff(level, probes) {
        const g = G.layout(level), pads = (list) => list.map((p) => ({ name: p.name, x: p.x, y: p.y }));
        const job = { kind: 'timing', level: level.id, board: M.serialize(), g: { inputs: pads(g.inputs), outputs: pads(g.outputs) }, probes: probes || [] };
        return G.offThread(level, job, () => measureSaved(level, job.board, job.g, job.probes),
            { limit: DEADLINE_MS + 6000, late: { error: 'Measuring its timing took too long, and was stopped' } });
    }

    // In words: the summary line a report is shown with.
    function summary(r) {
        if (r.error) return r.error;
        const parts = [];
        // A stretch of ticks around the edge, in words.
        const span = (a, z) => (a >= 0 ? `from ${a} to ${z} ticks after`
            : z < 0 ? `from ${-a} to ${-z} ticks before` : `from ${-a} ticks before to ${z} after`);
        for (const d of r.inputs) {
            if (!d.cases) continue;
            parts.push(d.from <= d.to
                ? `keep ${d.name} steady ${span(d.from, d.to)} the clock edge${d.rings ? ' — a change in there can leave it ringing for good' : ''}`
                : `${d.name} is caught if it changes by ${d.from - 1 < 0 ? `${1 - d.from} ticks before` : `${d.from - 1} ticks after`} the edge, missed after that`);
        }
        if (r.clockToOut) parts.push(`outputs follow ${r.clockToOut.max === r.clockToOut.min ? r.clockToOut.max : `${r.clockToOut.min}–${r.clockToOut.max}`} ticks after it`);
        if (r.minHigh && r.minLow) parts.push(`the clock high for ${r.minHigh} ticks at least and low for ${r.minLow}`);
        else if (r.minHigh) parts.push(`the clock high for ${r.minHigh} ticks at least`);
        if (r.minPeriod) parts.push(`fastest clock every ${r.minPeriod} ticks`);
        const s = parts.join('; ');
        return s.charAt(0).toUpperCase() + s.slice(1) + '.' + (r.truncated ? ' (It ran out of time before measuring everything.)' : '');
    }

    window.PixelogicTiming = { measure, measureSaved, measureOff, summary, play, risesOf };
})(window);
