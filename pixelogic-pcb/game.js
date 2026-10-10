(function (window) {
    // game.js - the campaign: a nandgame-style ladder of levels that starts at
    // a single inverter and climbs toward a machine that can run Tetris.
    //
    // Everything here is layered *on top of* the sandbox editor rather than
    // wired into it. A level is:
    //
    //   - a board of a fixed size, carrying input pads (toggles) down its left
    //     edge and output pads (LEDs) down its right edge. Those pads are
    //     LOCKED (model.js's lock mask), so no paint stroke, paste, clear or
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
    // to LEVELS, not writing code. That matters because the ladder above the
    // shipped chapters (ALU, RAM, CPU, Tetris) is long.
    const M = window.PixelogicModel;

    // ===== Bit helpers used by the truth functions =====
    // A bus is just named bits, MSB first: 'A3','A2','A1','A0'. A width-1 bus
    // is the bare name ('D', not 'D0'), so a one-bit level and a four-bit one
    // can share the same generators.
    const busNames = (name, width) => {
        if (width === 1) return [name];
        const out = [];
        for (let i = width - 1; i >= 0; i--) out.push(name + i);
        return out;
    };
    // Read a bus out of a bit-valued object as a number.
    const busVal = (v, name, width) => {
        if (width === 1) return v[name] & 1;
        let n = 0;
        for (let i = width - 1; i >= 0; i--) n = (n << 1) | (v[name + i] & 1);
        return n;
    };
    // Spread a number back across a bus's named bits.
    const busBits = (name, width, n) => {
        if (width === 1) return { [name]: n & 1 };
        const out = {};
        for (let i = 0; i < width; i++) out[name + i] = (n >> i) & 1;
        return out;
    };

    // ===== Sequential test scripts =====
    //
    // A storage level is not a truth table — the answer depends on what came
    // before — so it carries an ordered script of input vectors instead, and
    // its `step` says what the outputs must be after each one, given what they
    // were before.
    //
    // This walk is what a latch has to survive: load a value with the enable
    // high, drop the enable, then CHANGE THE DATA while disabled. The last of
    // those three is the whole property being tested — a circuit that merely
    // passes its input through gets the first two right every time.
    function loadHoldScript(dataName, width, enableName) {
        const mask = (1 << width) - 1;
        const values = width === 1 ? [1, 0, 1, 1, 0] : [0b1010, 0b0101, 0b1111, 0b0000, 0b1001];
        const out = [];
        for (const v of values) {
            out.push({ ...busBits(dataName, width, v), [enableName]: 1 });
            out.push({ ...busBits(dataName, width, v), [enableName]: 0 });
            out.push({ ...busBits(dataName, width, ~v & mask), [enableName]: 0 });
        }
        return out;
    }

    // The mux tutorial's circuit, as the ghosts it draws — paint by numbers.
    // The part stands on end in the middle of the board (pads at SEL (1,1),
    // A (1,3), B (1,5) and Q (9,4) — see the level's padRows), so COM faces
    // Q and each pin faces its own switch. The MUX tool lays a part down by
    // default, so matching the outline means turning one — which is the
    // point: it is the moment to learn R. Once the part is in place, every
    // wire is ghosted at once, to be traced in any order. tests/game.test.js
    // traces them and verifies the result.
    const MUX_GHOST = [[5, 3], [6, 3], [5, 4], [6, 4], [5, 5], [6, 5]];
    const MUX_COM = [6, 4], MUX_SEL = [6, 3];
    const MUX_WIRES = {
        com: [[7, 4], [8, 4]],
        sel: [[6, 2], [6, 1], [5, 1], [4, 1], [3, 1], [2, 1]],
        a: [[4, 3], [3, 3], [2, 3]],       // to NO, the top pin
        b: [[4, 5], [3, 5], [2, 5]],       // to NC, the bottom pin
    };

    // The wires still to trace, while the part is on its outline. A ghost that
    // stopped making sense goes: all of them if COM went on the other long
    // side, and SEL's, A's and B's if SEL went on the other corner (which
    // swaps NO and NC). Cells already drawn drop out in the view.
    function muxWireGhosts(b) {
        if (!b.is(MUX_GHOST, 'gray')) return null;
        // The part on the outline, once its COM side is known: its COM is
        // one of the outline's two long-side middles.
        const part = b.parts().find((p) => p.com && (b.same(p.com, MUX_COM) || b.same(p.com, [5, 4])));
        if (part && !b.same(part.com, MUX_COM)) return null;
        const wires = [MUX_WIRES.com];
        if (!part || part.state !== 'mux' || b.same(part.sel, MUX_SEL)) wires.push(MUX_WIRES.sel, MUX_WIRES.a, MUX_WIRES.b);
        return { cells: [].concat(...wires), color: 'conductor' };
    }

    // ===== Levels =====
    //
    // Each level: {id, chapter, title, subtitle, brief, coach, hint, inputs,
    // outputs, truth, w, h, settle}. `truth` maps an object of input bits to an
    // object of output bits; every declared output must be assigned.
    //
    // A storage level instead sets `sequential: true` and carries `script`
    // (ordered input vectors) and `step(inputs, prev)`, where `prev` is the
    // outputs after the previous step. The two forms are exclusive.
    //
    // `w`/`h` are the board, and they are deliberately TIGHT. Room to sprawl is
    // not neutral: it turns "find the arrangement that fits" — most of the
    // actual puzzle, and the thing a real board makes you care about — into
    // "drop the parts anywhere and join the dots". Each board here is sized so
    // a known solution fits with a little slack and not much more; the
    // reference solutions in tests/game.test.js are what keeps that honest, and
    // they fail loudly if a board is shrunk past what can be built in it.
    //
    // The Basics boards are the exception: they are sized for someone who has
    // never drawn a wire, so the distance between pads is short and the part
    // count is one or two — a first level is about the tools, not the fit.
    //
    // `coach` is a walk-through shown ONE step at a time, in the level bar's
    // status line: each step is a line of text and a `done(b)` test against
    // the board (see coachBoard), and the bar shows the first step not yet
    // done — so it moves on by itself as you build, and back if you undo.
    // A step's `text` may be a function of the board, to answer what the
    // player just did. A step may also carry a `guide(b)`: cells drawn as a
    // dashed ghost on the board, paint-by-numbers, showing where a piece
    // goes — the mux tutorial's part, and then all of its wires at once, so
    // they can be traced in any order.
    // `coachDone` is what the line says once every step is done. The three
    // tutorials have a coach — a wire, a crossing, the mux. It is
    // scaffolding for someone who has never seen this world; once every part
    // has been met, working out how to use them is the game. The exceptions
    // are the first levels built from parts (XOR, the half adder), whose
    // coach is about the parts — where they are, what the lid is — and
    // leaves the gate to the player.
    //
    // `tools` lists the materials a level allows; the others are disabled
    // while it is open (ui.js). The first levels need only a couple, and a
    // rail of parts nobody has met yet is noise.
    //
    // `pinLabels: true` prints SEL/COM/NO/NC on every mux while the level is
    // open, unless the player has switched labels off in the menu (ui.js).
    //
    // `part` names the part a solution becomes (see Parts, below): from the
    // next level on it can be put down whole instead of built again. `uses`
    // is what a level is meant to be built from — part keys and how many —
    // and sizes its board to fit the player's own parts (see neededSize).
    const LEVELS = [
        {
            id: 'first-light', chapter: 'basics', title: 'First light', subtitle: 'a wire',
            brief: 'Light the lamp when the switch is ON. One wire is all this takes — '
                + 'the point is to meet the tools.',
            coach: [
                {
                    text: 'Pick <b>Conductor</b> (<b>1</b>) and drag a wire from the <b>A</b> '
                        + 'switch to the <b>Q</b> lamp. Touching cells connect.',
                    done: (b) => b.reaches('A', 'Q'),
                },
                {
                    text: 'Click <b>A</b> to switch it on, and watch the charge run down the '
                        + 'wire to <b>Q</b>.',
                    done: (b) => b.lit('Q'),
                },
            ],
            hint: 'A straight run of conductor from the switch to the lamp. If nothing '
                + 'lights, look for a one-cell gap: cells connect only edge to edge, '
                + 'never diagonally. Made a mess? Erase (2) or right-drag removes wire, '
                + 'and the switch and lamp are fixed, so nothing can damage them.',
            tools: ['conductor', 'insulator'],
            inputs: ['A'], outputs: ['Q'], w: 8, h: 5,
            truth: (v) => ({ Q: v.A }),
        },
        {
            // Nobody would guess that wires can cross, and everything later
            // depends on it. One pair runs left to right and the other top to
            // bottom, each lamp straight across from its switch, so the two
            // straight wires meet in the middle and have to cross there: one
            // + at the centre of the board. There is no way round — a wire
            // that touches a switch or lamp joins it. (With both pairs on the
            // sides, the lamps swapped, the two had to be routed round each
            // other, and the shape that made came out uncomfortably close to
            // a swastika.)
            id: 'cross', chapter: 'basics', title: 'Crossing', subtitle: 'wires that pass',
            brief: 'QA should follow A, and QB follow B. The two wires have to cross — and '
                + 'crossing wires do not connect.',
            coach: [
                {
                    text: 'Wire <b>A</b> straight across to <b>QA</b>. Holding <b>Shift</b> '
                        + '(or turning on Straight) keeps a wire straight.',
                    done: (b) => b.reaches('A', 'QA'),
                },
                {
                    text: (b) => (b.reaches('A', 'B')
                        ? 'The two wires touch, so A and B are joined. They may only meet in '
                            + 'a clean <b>+</b>: four wire cells around the crossing.'
                        : 'Now <b>B</b> straight down to <b>QB</b>, through A’s wire. Where '
                            + 'four wires meet in a <b>+</b>, they pass over each other.'),
                    done: (b) => b.reaches('B', 'QB') && !b.reaches('A', 'B'),
                },
            ],
            coachDone: 'Flip <b>A</b> and <b>B</b>: each lamp follows its own switch. '
                + 'Then press <b>Verify</b>.',
            hint: 'Draw A’s wire straight across, then B’s straight down through it. The '
                + 'crossing cell needs wire on all four sides — a plus — and the two wires must '
                + 'not touch anywhere else.',
            tools: ['conductor', 'insulator'],
            padAt: { A: ['w', 4], QA: ['e', 4], B: ['n', 4], QB: ['s', 4] },
            inputs: ['A', 'B'], outputs: ['QA', 'QB'], w: 9, h: 9,
            truth: (v) => ({ QA: v.A, QB: v.B }),
        },
        {
            id: 'mux', chapter: 'basics', title: 'The mux', subtitle: 'SEL ? A : B',
            brief: 'Everything from here on is built from one part: the mux, a switch that '
                + 'picks one of two inputs. Make Q follow A while SEL is on, and B while it is off.',
            pinLabels: true,
            tools: ['conductor', 'insulator', 'gray'],
            // The part is placed on a ghost outline, standing up. The MUX
            // tool lays parts down, so matching the outline means turning
            // one — and a blank part that landed any other way is answered
            // with how to turn it, not waved through.
            coach: [
                {
                    text: (b) => (b.parts().length && !b.is(MUX_GHOST, 'gray')
                        ? 'Not quite on the outline. Click the part to turn it, or erase it '
                            + '(<b>2</b>) and place it again.'
                        : 'A solid <b>3&times;2</b> of MUX is a mux. Pick <b>MUX</b> (<b>3</b>); '
                            + 'this one stands up, so press <b>R</b> (or tap MUX again) to turn it, '
                            + 'then click the outline.'),
                    guide: () => ({ cells: MUX_GHOST, color: 'gray' }),
                    // On the outline — or wired up wherever it is, for a
                    // player who knows what they are doing.
                    done: (b) => b.is(MUX_GHOST, 'gray') || b.parts().some((p) => p.state !== 'idle'),
                },
                // From here the dashes show every wire, to trace in any order;
                // each step says what one of them is for, and ticks off when
                // that one is in.
                {
                    text: 'Trace the dashed wires, in any order. <b>COM</b>, the middle of a '
                        + 'long side, is the output: it goes to <b>Q</b>.',
                    guide: muxWireGhosts,
                    done: (b) => b.parts().some((p) => p.com && b.reaches(p.com, 'Q')),
                },
                {
                    text: '<b>SEL</b>, a corner of the COM side, chooses. It comes from the '
                        + '<b>SEL</b> switch.',
                    guide: muxWireGhosts,
                    done: (b) => b.muxes().some((m) => b.reaches('SEL', m.sel)),
                },
                {
                    text: '<b>NO</b>, the pin on SEL’s end, joins COM while SEL is on. '
                        + 'It takes <b>A</b>.',
                    guide: muxWireGhosts,
                    done: (b) => b.muxes().some((m) => b.reaches('A', m.no)),
                },
                {
                    text: '<b>NC</b>, the other pin, joins COM while SEL is off. '
                        + 'It takes <b>B</b>.',
                    guide: muxWireGhosts,
                    done: (b) => b.muxes().some((m) => b.reaches('B', m.nc)),
                },
            ],
            coachDone: 'Now flip <b>SEL</b>, <b>A</b> and <b>B</b> and watch <b>Q</b> '
                + 'follow. Then press <b>Verify</b>.',
            hint: 'A mux is a solid 3×2 of MUX, either way round. A wire on the middle of '
                + 'a long side makes that side COM, the output; a wire on one of its corners '
                + 'is SEL. The far side’s two ends are the pins: NO, on SEL’s end, reaches '
                + 'COM while SEL is on, and NC while it is off.',
            // A and B level with the pins they feed and Q level with COM, so
            // three of the four wires are straight runs.
            padRows: { SEL: 1, A: 3, B: 5, Q: 4 },
            inputs: ['SEL', 'A', 'B'], outputs: ['Q'], w: 11, h: 7,
            truth: (v) => ({ Q: v.SEL ? v.A : v.B }),
        },
        {
            // The first level with no coach. The tutorials have shown every
            // part; from here the player works out how to use them, and the
            // Hint is there for anyone who asks.
            id: 'not', chapter: 'basics', title: 'Inverter', subtitle: 'NOT',
            brief: 'Light the lamp when the switch is OFF, and only then. Every tool is '
                + 'yours from here, the +V and −V sources included.',
            hint: 'SEL is the input. −V goes on the NO pin (the one on SEL’s end) and +V '
                + 'on NC, so SEL on pulls COM down and SEL off drives it high.',
            inputs: ['A'], outputs: ['Q'], w: 11, h: 7, part: 'NOT',
            truth: (v) => ({ Q: v.A ? 0 : 1 }),
        },
        {
            id: 'and', chapter: 'basics', title: 'And', subtitle: 'A · B',
            brief: 'Light the lamp only when both switches are ON.',
            hint: 'A mux is a switch: let A choose between B and −V. When A is off '
                + 'the output is pulled down; when A is on it follows B.',
            inputs: ['A', 'B'], outputs: ['Q'], w: 12, h: 8, part: 'AND',
            truth: (v) => ({ Q: v.A & v.B }),
        },
        {
            id: 'or', chapter: 'basics', title: 'Or', subtitle: 'A + B',
            brief: 'Light the lamp when either switch is ON.',
            hint: 'The mirror of And: let A choose between +V and B.',
            inputs: ['A', 'B'], outputs: ['Q'], w: 12, h: 8, part: 'OR',
            truth: (v) => ({ Q: v.A | v.B }),
        },
        {
            // The first level with parts to use, so it has a coach again —
            // for the parts, not the gate: where they are, what the lid is,
            // and that a pin is wired like anything else. The gate itself
            // is still the player's to work out.
            id: 'xor', chapter: 'basics', title: 'Exclusive or', subtitle: 'A ⊕ B',
            brief: 'Light the lamp when the switches disagree. Every level you solve '
                + 'becomes a part, and this is the first that can use one.',
            coach: [
                {
                    text: 'Your inverter is a <b>part</b> now. Pick <b>Parts</b> (<b>9</b>) and '
                        + 'put a <b>NOT</b> on the board.',
                    done: (b) => !!b.block('not') || !b.hasPart('not'),
                },
                {
                    text: 'That is your inverter under a lid — double-click it to look inside. '
                        + 'Its pins are <b>A</b> in and <b>Q</b> out: wire a switch to its A.',
                    done: (b) => !b.block('not') || b.reaches('A', b.pinOf(b.block('not'), 'A'))
                        || b.reaches('B', b.pinOf(b.block('not'), 'A')),
                },
            ],
            coachDone: 'Now one more mux, choosing between B and NOT B. <b>Verify</b> when it is built.',
            hint: 'A chooses between B and NOT B: B into your NOT part, then one mux with '
                + 'A on SEL, B on one pin and the NOT’s Q on the other.',
            inputs: ['A', 'B'], outputs: ['Q'], w: 20, h: 12, part: 'XOR',
            truth: (v) => ({ Q: v.A ^ v.B }),
        },

        {
            id: 'half-adder', chapter: 'arith', title: 'Half adder', subtitle: 'S, C',
            brief: 'Add two bits. S is the sum bit, C the carry out.',
            coach: [
                {
                    text: 'This one is two parts. From <b>Parts</b> (<b>9</b>), put down an '
                        + '<b>XOR</b> and an <b>AND</b>.',
                    done: (b) => (!!b.block('xor') || !b.hasPart('xor')) && (!!b.block('and') || !b.hasPart('and')),
                },
            ],
            coachDone: 'Now wire them: A and B to both parts, and each Q to its lamp. <b>Verify</b> when it is built.',
            hint: 'S is A ⊕ B and C is A · B — and both are parts: an XOR and an AND, '
                + 'each fed by both switches.',
            inputs: ['A', 'B'], outputs: ['S', 'C'], w: 40, h: 26, part: 'HALF ADD', uses: { xor: 1, and: 1 },
            truth: (v) => ({ S: v.A ^ v.B, C: v.A & v.B }),
        },
        {
            id: 'full-adder', chapter: 'arith', title: 'Full adder', subtitle: 'A + B + Cin',
            brief: 'Add three bits: two operands and a carry in.',
            hint: 'Two half adders and an Or. The first adds A and B, the second '
                + 'adds Cin to that sum; either carry out sets Cout.',
            inputs: ['A', 'B', 'Cin'], outputs: ['S', 'Cout'], w: 42, h: 26,
            part: 'FULL ADD', uses: { 'half-adder': 2, or: 1 },
            truth: (v) => {
                const n = v.A + v.B + v.Cin;
                return { S: n & 1, Cout: n > 1 ? 1 : 0 };
            },
        },
        // The full adder again, for building with, in two stages on one
        // board. First make it work with five muxes (A ⊕ B worked out once
        // and used twice), with all the room in the world. Then pack it: an
        // outline appears, and the circuit has to fit in it — everything but
        // the wires running in from the switches and out to the lamps — with
        // A and B coming in on its left, S going out on its right, the carry
        // in at the bottom and out at the top. That makes a slice, which
        // stands on the next with the carry running up through them.
        //
        // What counts is how often slices repeat stacked (slicePeriod), not
        // the area: height is what a stack of them costs, and the outline is
        // wide so a flat slice has room. It asks for a period of 13 — a
        // 12x12 that stacks directly, the player's first, does it — and the
        // best known is 8, the player's flat 17x7, which beat the 18x8 a
        // search found (PLAN.md). (It began as
        // an 11x11 square, the search's smallest, and that was more than a
        // puzzle should ask.)
        {
            id: 'full-adder-tight', chapter: 'arith', title: 'Tight full adder', subtitle: 'five muxes, packed',
            brief: 'The full adder again, from five muxes — then packed tight. First make it work, with '
                + 'all the room you like. Then pack it into the outline that appears, so that it makes a '
                + 'slice: one stands on the next, the carry running up through them.',
            hint: 'Work out A ⊕ B once and use it twice. S is (A ⊕ B) ⊕ Cin. And when A ⊕ B is 1, '
                + 'the carry out is just Cin; when it is 0, A and B are the same, and the carry out is A. '
                + 'Two XORs and one more mux — five muxes in all.',
            inputs: ['A', 'B', 'Cin'], outputs: ['S', 'Cout'],
            w: 28, h: 21,
            padAt: { A: ['w', 8], B: ['w', 12], Cin: ['s', 10], S: ['e', 14], Cout: ['n', 10] },
            maxMuxes: 5,
            pack: {
                rect: { x0: 4, y0: 5, x1: 23, y1: 16 },
                sides: { A: 'w', B: 'w', S: 'e', Cin: 's', Cout: 'n' },
                maxPeriod: 13,
                record: 8,
                text: 'It works. Now pack it into the dashed outline — everything but the wires running in from '
                    + 'the switches and out to the lamps — with <b>A</b> and <b>B</b> coming in on its left, '
                    + '<b>S</b> going out on its right, <b>Cin</b> in at the bottom and <b>Cout</b> out at the '
                    + 'top. Height is what counts: stacked, it must repeat every 13 rows or fewer — its height '
                    + 'and one row shared with the next, when <b>Cin</b> is straight under <b>Cout</b>. '
                    + '<b>Rearrange</b> (A) moves things whole.',
            },
            part: 'FA',
            truth: (v) => {
                const n = v.A + v.B + v.Cin;
                return { S: n & 1, Cout: n > 1 ? 1 : 0 };
            },
        },
        {
            id: 'adder4', chapter: 'arith', title: '4-bit adder', subtitle: 'A + B',
            brief: 'Add two 4-bit numbers. Bit 3 is the most significant; Cout is '
                + 'the carry out of the top bit.',
            hint: 'Four full adders stacked, bit 0 at the bottom, each one’s Cout '
                + 'running straight up into the next one’s Cin. The bottom one’s Cin '
                + 'is tied to −V.',
            inputs: [...busNames('A', 4), ...busNames('B', 4)],
            outputs: [...busNames('S', 4), 'Cout'],
            w: 56, h: 32, part: 'ADD4', uses: { 'full-adder-tight': 4 },
            stack: { part: 'full-adder-tight', bits: 4 },
            truth: (v) => {
                const n = busVal(v, 'A', 4) + busVal(v, 'B', 4);
                return { ...busBits('S', 4, n & 15), Cout: n > 15 ? 1 : 0 };
            },
        },
        {
            id: 'inc4', chapter: 'arith', title: '4-bit incrementer', subtitle: 'A + 1',
            brief: 'Add one to a 4-bit number. The top carry out wraps to Cout.',
            hint: 'You could use the 4-bit adder with B tied to 1 — but a chain of '
                + 'half adders is far smaller, since one operand is a constant.',
            inputs: busNames('A', 4), outputs: [...busNames('S', 4), 'Cout'],
            w: 44, h: 26, part: 'INC4', uses: { 'half-adder': 4 },
            truth: (v) => {
                const n = busVal(v, 'A', 4) + 1;
                return { ...busBits('S', 4, n & 15), Cout: n > 15 ? 1 : 0 };
            },
        },

        {
            id: 'select4', chapter: 'control', title: '4-bit selector', subtitle: 'SEL ? A : B',
            brief: 'Pass A through when SEL is ON, B when it is OFF.',
            hint: 'One mux per bit, all four sharing the same control signal. '
                + 'This is the mux you have been using, widened to a bus.',
            inputs: ['SEL', ...busNames('A', 4), ...busNames('B', 4)],
            outputs: busNames('Q', 4), w: 48, h: 30, part: 'SEL4',
            truth: (v) => busBits('Q', 4, v.SEL ? busVal(v, 'A', 4) : busVal(v, 'B', 4)),
        },
        {
            id: 'zero4', chapter: 'control', title: 'Zero detector', subtitle: 'A = 0',
            brief: 'Light the lamp when every input bit is OFF. This is the flag a '
                + 'processor branches on.',
            hint: 'Or the four bits together, then invert. A tree of Ors is shallower '
                + 'than a chain, though either passes.',
            inputs: busNames('A', 4), outputs: ['Z'], w: 36, h: 22, part: 'ZERO4', uses: { or: 3, not: 1 },
            truth: (v) => ({ Z: busVal(v, 'A', 4) === 0 ? 1 : 0 }),
        },
        {
            id: 'negate4', chapter: 'control', title: 'Two’s complement', subtitle: '−A',
            brief: 'Negate a 4-bit number: invert every bit, then add one.',
            hint: 'Four inverters feeding the incrementer you already built.',
            inputs: busNames('A', 4), outputs: busNames('Q', 4), w: 46, h: 26, part: 'NEG4', uses: { not: 4, inc4: 1 },
            truth: (v) => busBits('Q', 4, (-busVal(v, 'A', 4)) & 15),
        },

        // Storage. These levels carry a `script` and a `step` instead of a
        // `truth`: the answer depends on what came before, so the board is
        // reset once and then walked through the script in order.
        {
            id: 'd-latch', chapter: 'memory', title: 'D latch', subtitle: 'follow, then hold',
            brief: 'While E is ON, Q follows D. When E goes OFF, Q keeps whatever it '
                + 'was holding — even if D changes afterwards.',
            hint: 'Feed Q back in. A mux picks between the new D and the latch’s own '
                + 'output, under the control of E: enabled it takes D, disabled it '
                + 'takes itself, which is what makes it remember. You will want an '
                + 'inverter in the loop.',
            sequential: true,
            inputs: ['D', 'E'], outputs: ['Q'], w: 28, h: 20, part: 'D LATCH',
            script: loadHoldScript('D', 1, 'E'),
            step: (v, prev) => ({ Q: v.E ? v.D : prev.Q }),
        },
        {
            id: 'register4', chapter: 'memory', title: '4-bit register', subtitle: 'store a number',
            brief: 'Four latches sharing one enable: load D into Q while E is ON, hold '
                + 'the stored number when E goes OFF.',
            hint: 'Four D latch parts, with E run to all of them. This is the first '
                + 'thing in the campaign that is genuinely just copies.',
            sequential: true,
            inputs: [...busNames('D', 4), 'E'], outputs: busNames('Q', 4), w: 54, h: 34,
            part: 'REG4', uses: { 'd-latch': 4 },
            script: loadHoldScript('D', 4, 'E'),
            step: (v, prev) => (v.E ? busBits('Q', 4, busVal(v, 'D', 4)) : { ...prev }),
        },
    ];

    // Chapters group the ladder in the level browser. `roadmap` chapters have
    // no levels yet - they are the stated destination (a CPU that runs Tetris),
    // shown so the shipped chapters read as the first rungs of a ladder rather
    // than as the whole thing.
    const CHAPTERS = [
        {
            id: 'basics', title: 'Basics',
            blurb: 'Everything is built from one part: a mux, wired as a relay. '
                + 'Start by meeting the tools, then make that one part behave '
                + 'like the gates you already know.',
        },
        {
            id: 'arith', title: 'Arithmetic',
            blurb: 'Gates become adders. From here on, each level is mostly a '
                + 'matter of putting down the parts you already built.',
        },
        {
            id: 'control', title: 'Selection & flags',
            blurb: 'Choosing between buses and testing them — the pieces an '
                + 'instruction decoder and an ALU are assembled from.',
        },
        {
            id: 'memory', title: 'Memory',
            blurb: 'A circuit that feeds its own output back can remember. From here '
                + 'the answer depends on what came before, so these levels are '
                + 'checked as a sequence rather than a truth table.',
        },
        {
            id: 'machine', title: 'The machine', roadmap: [
                'Register file', 'Arithmetic logic unit', 'Random-access memory',
                'Program counter', 'Instruction decoder', 'Processor',
                'Video output', 'Tetris',
            ],
            blurb: 'Where this is going.',
        },
    ];

    const levelById = new Map(LEVELS.map((l) => [l.id, l]));
    const getLevel = (id) => levelById.get(id) || null;
    const levelIndex = (id) => LEVELS.findIndex((l) => l.id === id);
    const levelsIn = (chapterId) => LEVELS.filter((l) => l.chapter === chapterId);

    // ===== Parts =====
    //
    // A part is a circuit dropped onto a board whole, at full size, under a
    // lid that names it and its pins (model.js's blocks). Solving a level
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
    const PARTS_KEY = 'pixelogic-pcb.parts.v1';
    // Which way level parts were cut. Parts made before fitting existed are
    // remade once from their levels' saved boards (see backfillParts). 5:
    // a pad the part has to take in becomes a junction in it, where it used
    // to fail the fit and make the part the whole board.
    const FIT_VERSION = 5;
    // Parts fitted this far back are cut the way parts are now (a core and
    // its edge), and one of them that is smaller than a refit — refined by
    // hand, most likely — is kept.
    const FIT_KEEP = 4;
    let partsCache = null;
    function partStore() {
        if (partsCache) return partsCache;
        partsCache = {};
        try {
            const raw = JSON.parse(localStorage.getItem(PARTS_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                for (const [k, p] of Object.entries(raw)) {
                    const clip = p && M.sanitizeClip(p.clip);
                    if (!clip || !clip.blocks) continue;
                    partsCache[k] = {
                        key: k, name: String(p.name || k), source: p.source || '', clip,
                        fit: p.fit | 0, fitTried: p.fitTried | 0,
                    };
                }
            }
        } catch (e) { }
        return partsCache;
    }
    function writeParts() {
        const out = {};
        for (const [k, p] of Object.entries(partStore()))
            out[k] = { name: p.name, source: p.source, clip: M.clipToJSON(p.clip), fit: p.fit | 0, fitTried: p.fitTried | 0 };
        try { localStorage.setItem(PARTS_KEY, JSON.stringify(out)); } catch (e) { }
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
    function partsFor(level) {
        if (!level) return allParts();
        const i = levelIndex(level.id);
        return allParts().filter((p) => {
            const src = levelIndex(p.key);
            return src >= 0 && src < i;
        });
    }
    // The board as it stands, as this level's part. The board must be this
    // level's, loaded; call it on a pass.
    // Returns {ok, compact, why, kept}: `why` says what kept a part from being
    // compact; `kept`, that the shelf already had a smaller one — refined by
    // hand, perhaps — which a solution that makes a bigger part does not
    // replace. A `refit` (the shelf being brought up to a new FIT_VERSION,
    // not a new solution) keeps one the same size, too.
    function makeLevelPart(level, refit) {
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
        if (had && had.fit >= FIT_KEEP && (area(had.clip) < area(clip) || (refit && area(had.clip) === area(clip)))) {
            had.fitTried = FIT_VERSION;
            writeParts();
            return { ok: true, kept: true, compact: true, why: null };
        }
        partStore()[level.id] = {
            key: level.id, name: level.part, source: level.id, clip,
            fit: fit.core ? FIT_VERSION : 0, fitTried: FIT_VERSION,
        };
        writeParts();
        return { ok: true, compact: !!fit.core, why: fit.core ? null : fit.error };
    }
    // A level's part, replaced by one made by hand — which must pass the
    // level's tests first (testPart). Its pins are put in the level's order.
    // Returns {ok} or {error, failure}.
    function replaceLevelPart(level, clip) {
        const t = testPart(level, clip);
        if (t.error) return { ok: false, error: t.error };
        if (!t.passed) return { ok: false, failure: t.failure };
        partStore()[level.id] = {
            key: level.id, name: level.part, source: level.id, clip,
            fit: FIT_VERSION, fitTried: FIT_VERSION,
        };
        writeParts();
        return { ok: true };
    }
    // A part of the player's own, from the sandbox. Returns its key.
    function saveCustomPart(name, clip) {
        const key = 'user:' + name;
        partStore()[key] = { key, name, source: '', clip };
        writeParts();
        return key;
    }
    function deletePart(key) {
        delete partStore()[key];
        writeParts();
    }
    // Resetting progress takes the level parts with it — they are earned by
    // solving — and leaves the player's own.
    function clearLevelParts() {
        const store = partStore();
        for (const k of Object.keys(store)) if (!k.startsWith('user:')) delete store[k];
        writeParts();
    }

    // Levels solved before parts existed have a solution saved but no part,
    // and parts made before fitting are the size of their whole board.
    // Where the saved board still passes, make its part now, so the shelf is
    // what the progress says it should be; where it does not, what is on the
    // shelf stays, and is not tried again. The board in the model is put
    // back exactly as it was.
    function backfillParts(progress) {
        const store = partStore();
        const todo = LEVELS.filter((l) => l.part && progress.completed[l.id]
            && (!store[l.id] || store[l.id].fitTried !== FIT_VERSION));
        if (!todo.length) return 0;
        const saved = M.getLiveSnapshot();
        const locks = M.lockedCells();
        let made = 0;
        try {
            for (const level of todo) {
                const text = loadCircuit(level.id);
                if (text) {
                    loadBoard(level, text);
                    if (verify(level).passed && makeLevelPart(level, true).ok) { made++; continue; }
                }
                if (store[level.id]) store[level.id].fitTried = FIT_VERSION;
            }
            writeParts();
        } finally {
            M.setLockedCells([]);
            M.restoreLiveSnapshot(saved);
            M.setLockedCells(locks);
        }
        return made;
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
    function neededSize(level) {
        let w = level.w || 40, h = level.h || 0;
        const sl = stackLayout(level);
        if (sl) return { w: sl.w, h: sl.h };
        if (!level.uses) return { w, h };
        const dims = [];
        let all = true;
        for (const [key, count] of Object.entries(level.uses)) {
            const p = partStore()[key];
            if (!p) { all = false; continue; }
            for (let k = 0; k < count; k++) dims.push({ w: p.clip.w, h: p.clip.h });
        }
        if (!dims.length) return { w, h };
        const pads = Math.max((level.inputs || []).length, (level.outputs || []).length);
        const rw = PART_ROUTE_W + 2 * Math.max(0, pads - 3), rh = PART_ROUTE_H;
        const layouts = (ds) => ds.map((d, k) => stackSize(ds, k + 1));
        const upright = layouts(dims), turned = layouts(dims.map((d) => ({ w: d.h, h: d.w })));
        const cost = (s) => Math.pow(Math.max(s.w, s.h), 1.5) * Math.sqrt(Math.min(s.w, s.h));
        let best = null;
        for (const u of upright)
            for (const t of turned) {
                const s = { w: Math.max(u.w, t.w) + rw, h: Math.max(u.h, t.h) + rh };
                if (!best || cost(s) < cost(best) || (cost(s) === cost(best) && s.w > best.w)) best = s;
            }
        return all ? best : { w: Math.max(w, best.w), h: Math.max(h, best.h) };
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
        if (max && sp && sp.period > max) {
            const why = !sp.aligned
                ? 'Cin is not straight under Cout, so stacked slices need a row between them for the carry to step across'
                : 'stacked on one another, its top edge clashes with its bottom one — a terminal against a cell the other keeps bare — so they need a row between them';
            return { ok: false, core: c, period: sp.period, why: `It fits, but ${why}: one every ${sp.period} rows, where the outline asks for ${max}.` };
        }
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
    // How often a slice repeats, stacked on itself ({period, aligned,
    // direct}, or null for a part with no carry in and out). What matters
    // is the period, not the height: a slice whose carry in is straight
    // under its carry out, and whose top edge sits on its bottom edge
    // without a terminal landing on a cell the other keeps bare, shares that
    // row with the next — the carry is one cell, both terminals at once —
    // and repeats every height + 1 rows. Edges that clash need a row
    // between them (height + 2, the carry two cells); a carry that has to
    // step across needs a row of its own to do it in (height + 3).
    function slicePeriod(clip) {
        const pins = M.clipPins(clip), pin = (n) => pins.find((q) => q.name === n && q.at);
        const ci = pin('Cin'), co = pin('Cout'), H = clip.h;
        if (!ci || !co) return null;
        if (!(ci.at[1] === H && co.at[1] === -1 && ci.at[0] === co.at[0])) return { period: H + 3, aligned: false, direct: false };
        const top = new Map(), bottom = new Map();
        for (const e of M.clipRing(clip)) {
            if (e.y === -1) top.set(e.x, e.cls);
            if (e.y === H) bottom.set(e.x, e.cls);
        }
        // The rule placing a part keeps (blockFits): a terminal on a cell
        // the other keeps bare clashes; terminal on terminal does not — the
        // shared row is bare but for the carry, so two wires that would
        // each take a wire there just have a bare cell between them. (This
        // once counted terminal on terminal as a clash too, and so put a
        // row between slices that stack fine without one.)
        let direct = true;
        for (let x = -1; x <= clip.w; x++) {
            if (x === co.at[0]) continue;             // the carry: Cout on Cin
            const a = top.get(x) || 'X', b = bottom.get(x) || 'X';
            if ((a === 'T' && b === 'R') || (a === 'R' && b === 'T')) direct = false;
        }
        return { period: H + (direct ? 1 : 2), aligned: true, direct };
    }
    function stackLayout(level) {
        const st = level.stack, p = st && partStore()[st.part];
        if (!p) return null;
        const pins = M.clipPins(p.clip), pin = (n) => pins.find((q) => q.name === n && q.at);
        const a = pin('A'), b = pin('B'), s = pin('S'), ci = pin('Cin'), co = pin('Cout');
        const W = p.clip.w, H = p.clip.h;
        if (!a || !b || !s || !ci || !co) return null;
        if (a.at[0] !== -1 || b.at[0] !== -1 || s.at[0] !== W || co.at[1] !== -1 || ci.at[1] !== H) return null;
        if (Math.abs(a.at[1] - b.at[1]) < 2) return null;     // their switches would touch
        // As often as the slice repeats (slicePeriod).
        const n = st.bits, pitch = slicePeriod(p.clip).period;
        const padAt = { Cout: ['n', STACK_X0 + co.at[0]] };
        for (let k = 0; k < n; k++) {
            const y = STACK_TOP + (n - 1 - k) * pitch;
            padAt['A' + k] = ['w', y + a.at[1]];
            padAt['B' + k] = ['w', y + b.at[1]];
            padAt['S' + k] = ['e', y + s.at[1]];
        }
        return {
            w: STACK_X0 + W + 4, h: STACK_TOP + (n - 1) * pitch + H + 3, padAt,
            // Where slice k's core goes, for whoever wants to show or build it.
            slice: (k) => ({ x: STACK_X0, y: STACK_TOP + (n - 1 - k) * pitch }),
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
    // then taken as given.
    //
    // Or it can put each pad on any edge (`padAt`, name -> [edge, at]: 'w' or
    // 'e' with a row, 'n' or 's' with a column): the stackable adder takes
    // its carry in at the bottom and puts its carry out at the top, so that
    // one stands on another. Its w and h are then taken as given. Pads sit
    // one cell in from the edge like the rest, or on it (`padInset: 0`) for a
    // board whose every cell is meant to count. Every pad says which edge it
    // is on (`edge`).
    function layout(level) {
        const inL = rowsFor(level.inputs), outL = rowsFor(level.outputs);
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
    function applyBoard(level) {
        const g = layout(level);
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
        const padAt = new Set(g.pads.map((p) => p.x + ',' + p.y));
        const lanes = [[1, null], [g.w - 2, null]];
        for (const p of g.pads) lanes.push(p.edge === 'w' || p.edge === 'e' ? [p.x, null] : [null, p.y]);
        for (const [lx, ly] of lanes) {
            for (let k = 0; k < (lx !== null ? g.h : g.w); k++) {
                const x = lx !== null ? lx : k, y = lx !== null ? k : ly;
                const c = M.colorOfCell(M.getCell(x, y));
                if ((c === 'toggle' || c === 'led') && !padAt.has(x + ',' + y)) return applyBoard(level);
            }
        }
        for (const p of g.inputs) if (M.colorOfCell(M.getCell(p.x, p.y)) !== 'toggle') M.paintCell(p.x, p.y, 'toggle');
        for (const p of g.outputs) if (M.colorOfCell(M.getCell(p.x, p.y)) !== 'led') M.paintCell(p.x, p.y, 'led');
        M.setLockedCells(g.pads.map((p) => [p.x, p.y]));
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

    // Every row of a level's truth table — inputs and what the outputs must
    // be — without running anything, for showing the table before a Verify.
    // A storage level's rows follow its script, each expected value given
    // the ones before.
    function tableCases(level) {
        const vectors = vectorsFor(level);
        if (!level.sequential) return vectors.map((v) => ({ inputs: v, expected: level.truth(v) }));
        let prev = Object.fromEntries(level.outputs.map((n) => [n, 0]));
        return vectors.map((v, i) => {
            const expected = level.step(v, prev);
            prev = expected;
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

    const matches = (level, got, want) => level.outputs.every((name) => got[name] === (want[name] & 1));

    // Runs the level's vectors against whatever is currently on the board and
    // restores the board's exact prior state (charge, locks and any owed
    // rearrange connections included) afterwards, so verifying is never
    // destructive to a circuit the player is mid-way through debugging.
    // Returns the first failure plus a full case list, so the UI can show a
    // truth table with the wrong row marked.
    function verify(level, opts) {
        const g = layout(level);
        const budget = (opts && opts.settle) || settleBudget(level);
        const saved = M.getLiveSnapshot();
        try {
            return runVectors(level, g, budget);
        } finally {
            M.restoreLiveSnapshot(saved);
        }
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
                // ONE reset, at the start; the whole point is that what came
                // before is carried forward. A cold board has every lamp off,
                // which is the defined starting state the scripts assume.
                M.resetCharges();
                settle(budget);
                let prev = {};
                for (const name of level.outputs) prev[name] = 0;
                level.script.forEach((v, i) => {
                    const r = applyVector(g, level, v, budget);
                    const want = level.step(v, prev);
                    record({
                        step: i, inputs: v, expected: want, actual: r.got,
                        ok: r.settled && matches(level, r.got, want),
                        ticks: r.ticks, settled: r.settled,
                    });
                    // The next step is judged against what the circuit ACTUALLY
                    // did, not against what it should have done: once it has
                    // gone wrong, reporting every later step as a failure too
                    // buries the one that matters.
                    prev = r.got;
                });
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
            }
        }
        return { passed: !failure, cases, failure, level: level.id };
    }

    // Does a part do a level's job? It is put down on a scratch board of its
    // own, a switch on each input's terminal and a lamp on each output's, and
    // run through the level's own tests — the same vectors, the same
    // settling. The part's pins must be named for the level's inputs and
    // outputs, each once. Returns the verify result, or {error}. The board
    // in the model is put back exactly as it was.
    function testPart(level, clip) {
        const pins = M.clipPins(clip);
        const names = (dir) => pins.filter((q) => q.dir === dir).map((q) => q.name).sort().join(',');
        if (names('in') !== [...level.inputs].sort().join(',') || names('out') !== [...level.outputs].sort().join(','))
            return { error: `The ${level.part} part’s terminals are ${level.inputs.join(', ')} in and ${level.outputs.join(', ')} out` };
        const saved = M.getLiveSnapshot(), locks = M.lockedCells();
        try {
            M.setLockedCells([]);
            const m = 3, w = clip.w + 2 * m, h = clip.h + 2 * m;
            M.deserialize(JSON.stringify({ w, h, cells: new Array(w * h).fill(0) }));
            M.pasteRegion(clip, m, m);
            if (!M.blockList().length) return { error: 'It would not go down on a board of its own' };
            const g = { inputs: [], outputs: [] };
            for (const q of pins) {
                const x = m + q.at[0], y = m + q.at[1];
                M.paintCell(x, y, q.dir === 'in' ? 'toggle' : 'led');
                (q.dir === 'in' ? g.inputs : g.outputs).push({ name: q.name, x, y });
            }
            return runVectors(level, g, settleBudget(level));
        } finally {
            M.setLockedCells([]);
            M.restoreLiveSnapshot(saved);
            M.setLockedCells(locks);
        }
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
            // Cold start. Sequential levels reset here and only here; for
            // everything else each vector gets its own reset in begin().
            start() {
                M.resetCharges();
                prevCells = null; quietFor = 0; elapsed = 0; index = -1;
            },
            // Move to vector n and drive the input pads to it.
            begin(n) {
                index = n;
                if (!level.sequential) M.resetCharges();
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
    const PROGRESS_KEY = 'pixelogic-pcb.game.v1';
    const circuitKey = (id) => 'pixelogic-pcb.game.circuit.' + id;

    function loadProgress() {
        try {
            const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null');
            if (raw && typeof raw === 'object' && raw.completed && typeof raw.completed === 'object')
                return {
                    completed: raw.completed, current: raw.current || null, mode: raw.mode || 'campaign',
                    // Levels in stages: the stage reached ('pack') in one not yet solved.
                    reached: raw.reached && typeof raw.reached === 'object' ? raw.reached : {},
                };
        } catch (e) { }
        return { completed: {}, current: null, mode: 'campaign', reached: {} };
    }
    function saveProgress(p) {
        try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) { }
    }
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
        try {
            localStorage.setItem(circuitKey(id), serialized);
            localStorage.setItem(circuitKey(id) + '.layout', layoutKey(id));
        } catch (e) { }
    }
    // A save made on a board at least as big as the level now needs keeps
    // that board (see chosenSize), so a level built from parts does not
    // lose its save because a part it uses got smaller.
    function loadCircuit(id) {
        chosenSize.delete(id);
        try {
            const saved = localStorage.getItem(circuitKey(id) + '.layout');
            if (saved !== null) {
                const level = getLevel(id), m = /^(\d+)x(\d+):/.exec(saved);
                if (level && m) {
                    const need = neededSize(level), w = +m[1], h = +m[2];
                    if (w >= need.w && h >= need.h) chosenSize.set(id, { w, h });
                }
                if (saved !== layoutKey(id)) { chosenSize.delete(id); return null; }
            }
            return localStorage.getItem(circuitKey(id));
        } catch (e) { return null; }
    }
    function clearCircuit(id) {
        chosenSize.delete(id);
        try {
            localStorage.removeItem(circuitKey(id));
            localStorage.removeItem(circuitKey(id) + '.layout');
        } catch (e) { }
    }

    window.PixelogicGame = {
        LEVELS, CHAPTERS,
        getLevel, levelIndex, levelsIn, nextLevel,
        layout, applyBoard, loadBoard, padLabels, coachState,
        vectorsFor, tableCases, verify, replay, settle, settleBudget, loadHoldScript,
        allParts, partsFor, getPart, makeLevelPart, replaceLevelPart, testPart, saveCustomPart, deletePart, clearLevelParts,
        backfillParts, neededSize, stackLayout, slicePeriod, judge, packCheck,
        loadProgress, saveProgress, isUnlocked,
        saveCircuit, loadCircuit, clearCircuit,
        busNames, busVal, busBits,
    };
})(window);
