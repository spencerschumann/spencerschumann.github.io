(function (window) {
    // levels.js - the campaign's levels, as data: what each one asks for, its
    // tests, its board, its coach and its hint, and the chapters they sit in.
    // game.js does everything with them — lays the board out, runs the tests,
    // makes the parts — so adding a level is adding an entry here, not
    // writing code. Nothing here reads the board; a coach step is handed one
    // (game.js's coachBoard) to look at.
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

    // A clocked level's clock counts at its edge: the step where it goes from
    // off to on. Its scripts never change anything else on that step — data
    // and clock changing at once is a race, here as in any logic — though
    // they do on the step where it goes off, which a circuit that acts on
    // the rising edge has to take in its stride.
    const rose = (v, was) => !!v.CLK && !was.CLK;

    // The walk an edge-triggered flip-flop has to survive, a value at a time:
    // the clock falls, D changes while it is low, the clock rises (Q takes
    // D), D changes while it is high. Q must hold through all but the edge.
    // A latch open while the clock is high fails on the change while it is
    // high; one open while it is low, on the change while it is low. The
    // first step is an edge, the switches all off before it, storing a 0:
    // until something is stored, Q could be anything.
    function edgeScript(values) {
        const out = [{ D: 0, CLK: 1 }];
        let d = 0;
        for (const v of values) {
            out.push({ D: d, CLK: 0 }, { D: v, CLK: 0 }, { D: v, CLK: 1 });
            d = v ^ 1;
            out.push({ D: d, CLK: 1 });
        }
        return out;
    }
    // A counter has nothing but its clock. It starts from wherever it woke
    // up (see `wakes`) and is clocked round past 15 and back.
    function countScript(edges) {
        const out = [{ CLK: 0 }];
        for (let i = 0; i < edges; i++) out.push({ CLK: 1 }, { CLK: 0 });
        return out;
    }
    // Words sent down one wire, least significant bit first, a bit a clock:
    // each bit set with the clock low, the clock raised, then the line moved
    // while it is high, which must not get in.
    function serialInScript(words) {
        const out = [{ SI: 0, CLK: 0 }];
        for (const w of words)
            for (let i = 0; i < 4; i++) {
                const b = (w >> i) & 1;
                out.push({ SI: b, CLK: 0 }, { SI: b, CLK: 1 }, { SI: b ^ 1, CLK: 1 });
            }
        return out;
    }
    // A word loaded on one edge, LOAD on, then shifted out a bit an edge,
    // LOAD off — with the D switches moved meanwhile, the clock still high
    // from the load and on through the shifts, which must not get in. The
    // fourth shift empties it: zeros come in at the top.
    function serialOutScript(words) {
        const out = [{ ...busBits('D', 4, 0), LOAD: 0, CLK: 0 }];
        for (const w of words) {
            const d = busBits('D', 4, w), junk = busBits('D', 4, ~w & 15);
            out.push({ ...d, LOAD: 1, CLK: 0 }, { ...d, LOAD: 1, CLK: 1 }, { ...junk, LOAD: 1, CLK: 1 });
            for (let i = 0; i < 4; i++) out.push({ ...junk, LOAD: 0, CLK: 0 }, { ...junk, LOAD: 0, CLK: 1 });
        }
        return out;
    }
    // Pairs of numbers down two wires, least significant bit first, a bit a
    // clock: four bits each and a fifth of zeros, which brings the carry out
    // as the sum's top bit and leaves none behind. Each bit is moved while
    // the clock is high, after the carry is taken, which must not get in. It
    // starts with a clock on zeros, which settles a carry the circuit woke up
    // holding.
    function serialAddScript(pairs) {
        const out = [{ A: 0, B: 0, CLK: 0 }, { A: 0, B: 0, CLK: 1 }];
        for (const [a, b] of pairs)
            for (let i = 0; i < 5; i++) {
                const A = (a >> i) & 1, B = (b >> i) & 1;
                out.push({ A, B, CLK: 0 }, { A, B, CLK: 1 }, { A: A ^ 1, B: B ^ 1, CLK: 1 });
            }
        return out;
    }

    // The mux tutorial's circuit, as the ghosts it draws — paint by numbers.
    // The part stands on end in the middle of the board (pads at SEL (1,1),
    // A (1,3), B (1,5) and Q (9,4) — see the level's padRows), so COM faces
    // Q, SEL faces up toward its switch's row, and each pin faces its own
    // switch. The MUX tool lays a part down by default, with COM out the top,
    // so matching the outline means turning one a quarter — which is the
    // point: it is the moment to learn R. Once the part is in place, every
    // wire is ghosted at once, to be traced in any order. tests/game.test.js
    // traces them and verifies the result.
    const MUX_GHOST = [[5, 3], [6, 3], [5, 4], [6, 4], [5, 5], [6, 5]];
    const MUX_COM = [6, 4], MUX_SEL = [6, 3];
    // Its leads, as the ghost draws them: d is 0 up, 1 right, 2 down, 3 left.
    const MUX_LEADS = [{ x: 6, y: 3, d: 0, name: 'SEL' }, { x: 6, y: 4, d: 1, name: 'COM' },
        { x: 5, y: 3, d: 3, name: 'NO' }, { x: 5, y: 5, d: 3, name: 'NC' }];
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
        if (!b.is(MUX_GHOST, 'mux')) return null;
        // The part on the outline: its COM is one of the outline's two
        // long-side middles.
        const part = b.parts().find((p) => p.com && (b.same(p.com, MUX_COM) || b.same(p.com, [5, 4])));
        if (part && !b.same(part.com, MUX_COM)) return null;
        const wires = [MUX_WIRES.com];
        if (!part || part.state !== 'mux' || b.same(part.sel, MUX_SEL)) wires.push(MUX_WIRES.sel, MUX_WIRES.a, MUX_WIRES.b);
        return { cells: [].concat(...wires), color: 'conductor' };
    }
    // Is the mux on the outline, the outline's way round?
    const muxOnGhost = (b) => b.muxes().some((m) => b.same(m.com, MUX_COM) && b.same(m.sel, MUX_SEL));

    // ===== Levels =====
    //
    // Each level: {id, chapter, title, subtitle, brief, coach, hint, inputs,
    // outputs, truth, w, h, settle}. `truth` maps an object of input bits to an
    // object of output bits; every declared output must be assigned.
    //
    // A storage level instead sets `sequential: true` and carries `script`
    // (ordered input vectors) and `step(inputs, prev, was, mem)`: `prev` is
    // the outputs after the previous step (not known — null — before the
    // first: nothing has been stored yet, and the board may wake up holding
    // anything; the script is run from rest and from a charged start), `was`
    // the inputs of the previous step (all off before the first), so a
    // clocked level can see an edge, and `mem` an object of the level's own
    // for the run, for state no lamp shows (a shift register's inner bits).
    // An output the step returns as null is not judged there — a state the
    // circuit has not been told yet.
    // `clock` names a clocked level's clock input, and `wakes` leaves its
    // first step unjudged: whatever the circuit woke up as. The two forms
    // (truth, step) are exclusive.
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
    // the board (see coachBoard in game.js), and the bar shows the first step not yet
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
    // while it is open (ui/campaign.js). The first levels need only a couple, and a
    // rail of parts nobody has met yet is noise.
    //
    // `pinLabels: true` prints SEL/COM/NO/NC on every mux while the level is
    // open, unless the player has switched labels off in the menu (ui/prefs.js).
    //
    // `part` names the part a solution becomes (see Parts in game.js): from the
    // next level on it can be put down whole instead of built again. `uses`
    // is what a level is meant to be built from — part keys and how many —
    // and sizes its board to fit the player's own parts (see neededSize in game.js).
    // `alt`, the same way, is another way its hint offers (the incrementer's
    // 4-bit adder): the board has room for that too, once those are made.
    // `row: true` (a level of copies of one part) gives it room for them in
    // a straight row as well, with lanes for their wiring.
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
                        ? 'The two wires are joined. Where they meet must be a crossing — click the '
                            + '<b>+</b> there with the Conductor to make it one — and they must not touch '
                            + 'anywhere else.'
                        : 'Now <b>B</b> straight down to <b>QB</b>, across A’s wire. A wire drawn '
                            + 'straight across another crosses it: the two pass over each other.'),
                    done: (b) => b.reaches('B', 'QB') && !b.reaches('A', 'B'),
                },
            ],
            coachDone: 'Flip <b>A</b> and <b>B</b>: each lamp follows its own switch. '
                + 'Then press <b>Verify</b>.',
            hint: 'Draw A’s wire straight across, then B’s straight down across it: drawn '
                + 'straight across, it crosses. A plus that joins them instead is made a crossing '
                + 'by clicking it with the Conductor. The two wires must not touch anywhere else.',
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
            tools: ['conductor', 'insulator', 'mux'],
            // The part is placed on a ghost outline, standing up, its leads
            // drawn. The MUX tool lays parts down, so matching the outline
            // means turning one — and a part that landed any other way is
            // answered with how to turn it, not waved through.
            coach: [
                {
                    text: (b) => (b.parts().length && !muxOnGhost(b)
                        ? 'Not quite the outline’s way round. Click the part to turn it (or erase '
                            + 'it with <b>2</b> and place it again), until its leads match the outline’s.'
                        : 'A mux is a 3&times;2 part with four leads: <b>SEL</b>, <b>COM</b>, '
                            + '<b>NO</b> and <b>NC</b>. Pick <b>MUX</b> (<b>3</b>); this one stands up, '
                            + 'COM toward Q, so press <b>R</b> (or tap MUX again) to turn it until '
                            + 'its leads match the outline’s, then click the outline. (<b>M</b> flips it.)'),
                    guide: () => ({ cells: MUX_GHOST, color: 'mux', leads: MUX_LEADS }),
                    // On the outline the right way round — or COM wired to Q
                    // wherever it is, for a player who knows what they are doing.
                    done: (b) => muxOnGhost(b) || b.muxes().some((m) => b.reaches(m.com, 'Q')),
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
                    text: '<b>SEL</b>, on the end of the COM side, chooses. It comes from the '
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
            hint: 'A mux has four leads. COM, the middle of a long side, is the output; SEL, '
                + 'on the end of that side, chooses. The far side’s two ends are the pins: NO, '
                + 'on SEL’s end, reaches COM while SEL is on, and NC while it is off. R turns '
                + 'the MUX tool’s next part, and M flips it.',
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
        // search found (DESIGN.md). (It began as
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
                + 'is tied to −V. Take one from the Parts shelf and press Array… to stack them.',
            inputs: [...busNames('A', 4), ...busNames('B', 4)],
            outputs: [...busNames('S', 4), 'Cout'],
            w: 56, h: 32, part: 'ADD4', uses: { 'full-adder-tight': 4 },
            stack: { part: 'full-adder-tight', bits: 4, each: { A: 'w', B: 'w', S: 'e' }, up: ['Cout', 'Cin'], ends: { Cout: 'n' } },
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
            // The carry out of the top bit at the top, above S3: a stack of
            // slices carries up and puts it out there. (Listed last, it was
            // at the bottom, under S0.)
            outputOrder: ['Cout', ...busNames('S', 4)],
            w: 44, h: 26, part: 'INC4', uses: { 'half-adder': 4 }, alt: { adder4: 1 },
            truth: (v) => {
                const n = busVal(v, 'A', 4) + 1;
                return { ...busBits('S', 4, n & 15), Cout: n > 15 ? 1 : 0 };
            },
        },

        // A slice with a pin that runs through it — SEL in at the bottom and
        // out again at the top, as SELo, which the tests hold to copying
        // SEL — so that slices stacked share one SEL with no wire laid for
        // it. The first level that needs one gets this level of its own to
        // make it in, as the 4-bit adder has the tight full adder; after
        // this, a player who wants a slice makes it in the level that wants
        // it (a part made in a level is on its shelf, see partsFor).
        {
            id: 'select-slice', chapter: 'control', title: 'Selector slice', subtitle: 'one bit, SEL through',
            brief: 'One bit of a selector: Q is A when SEL is ON, B when it is OFF. And SELo is SEL again, out '
                + 'at the top, so that the next slice up can take its SEL from this one. First make it work; '
                + 'then pack it into the outline that appears, so that it makes a slice.',
            hint: 'One mux: SEL on its control, A and B on its pins, Q from COM. SELo is SEL’s own wire, carried '
                + 'on past the mux and out of the top — straight up, so stacked slices meet. To get it past a '
                + 'wire running across, cross them: four wires meeting are a crossing, not a junction.',
            inputs: ['SEL', 'A', 'B'], outputs: ['Q', 'SELo'],
            w: 22, h: 17,
            padAt: { B: ['w', 7], A: ['w', 9], Q: ['e', 8], SEL: ['s', 12], SELo: ['n', 12] },
            pack: {
                rect: { x0: 5, y0: 4, x1: 16, y1: 12 },
                sides: { A: 'w', B: 'w', Q: 'e', SEL: 's', SELo: 'n' },
                text: 'It works. Now pack it into the dashed outline — everything but the wires running in from '
                    + 'the switches and out to the lamps — with <b>A</b> and <b>B</b> coming in on its left, '
                    + '<b>Q</b> going out on its right, <b>SEL</b> in at the bottom and <b>SELo</b> out at the '
                    + 'top. With <b>SEL</b> straight under <b>SELo</b>, stacked slices meet head on.',
            },
            part: 'SEL1',
            truth: (v) => ({ Q: v.SEL ? v.A : v.B, SELo: v.SEL }),
        },
        {
            id: 'select4', chapter: 'control', title: '4-bit selector', subtitle: 'SEL ? A : B',
            brief: 'Pass A through when SEL is ON, B when it is OFF.',
            hint: 'Four selector slices stacked, bit 0 at the bottom, each one’s SELo running straight up into '
                + 'the next one’s SEL: one control for all four. Take one from the Parts shelf and press Array… to stack them.',
            inputs: ['SEL', ...busNames('A', 4), ...busNames('B', 4)],
            outputs: busNames('Q', 4), w: 48, h: 30, part: 'SEL4', uses: { 'select-slice': 4 },
            stack: { part: 'select-slice', bits: 4, each: { A: 'w', B: 'w', Q: 'e' }, up: ['SELo', 'SEL'], ends: { SEL: 's' } },
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
        // started once and then walked through the script in order — each
        // script storing something before anything held is judged.
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
            hint: 'Four D latch parts, with E run to all of them. Or, as with the selector: make one slice — '
                + 'a latch with E carried on out of the top, an E output — make it a part here, and Array four '
                + 'of it, the enable running up through them. The board is then laid out for your slice: '
                + 'D in on the left and Q out on the right of each, E at the bottom.',
            sequential: true,
            inputs: [...busNames('D', 4), 'E'], outputs: busNames('Q', 4), w: 54, h: 34,
            part: 'REG4', uses: { 'd-latch': 4 }, row: true,
            // Laid out as a stack of the player's own slice, once there is
            // one (see stackLayout): `up`'s out is theirs to name.
            stack: { slice: true, bits: 4, each: { D: 'w', Q: 'e' }, up: [null, 'E'], ends: { E: 's' }, top: 2 },
            script: loadHoldScript('D', 4, 'E'),
            step: (v, prev) => (v.E ? busBits('Q', 4, busVal(v, 'D', 4)) : { ...prev }),
        },
        // Clocked. A latch is open for as long as its enable is on, so two in
        // a row are one long wire while it is; a flip-flop takes its input at
        // one instant — the clock going on — and holds it till the next. That
        // is what lets one feed the next in a chain, and a counter feed back
        // on itself, without the value running straight through.
        {
            id: 'dff', chapter: 'memory', title: 'D flip-flop', subtitle: 'on the edge',
            brief: 'Q takes D at the moment CLK goes ON, and holds it until the next time — '
                + 'whatever D does in between, with CLK on or off.',
            hint: 'Two D latches in a row: the first open while CLK is off, the second while it is '
                + 'on. They are never open at once, so D gets in one step per clock: the first '
                + 'latch’s enable is NOT CLK, the second’s CLK itself.',
            sequential: true, clock: 'CLK',
            inputs: ['D', 'CLK'], outputs: ['Q'], w: 24, h: 14, part: 'DFF', uses: { 'd-latch': 2, not: 1 },
            script: edgeScript([1, 1, 0, 0, 1, 0]),
            step: (v, prev, was) => ({ Q: rose(v, was) ? v.D : prev.Q }),
        },
        {
            id: 'counter4', chapter: 'memory', title: '4-bit counter', subtitle: 'count the clock',
            brief: 'Each time CLK goes ON, Q goes up by one, and from 15 back round to 0. It may '
                + 'wake up at any number: it only has to count from there.',
            hint: 'A flip-flop fed its own inverse flips on every clock: that is bit 0. Bit 1 flips '
                + 'each time bit 0 falls back to 0, so clock it from bit 0’s inverse — and so on up. '
                + '(Or a register of flip-flops fed through your incrementer.)',
            sequential: true, clock: 'CLK', wakes: true,
            inputs: ['CLK'], outputs: busNames('Q', 4), w: 72, h: 36, part: 'COUNT4', uses: { dff: 4, not: 4 }, alt: { dff: 4, inc4: 1 },
            script: countScript(17),
            step: (v, prev, was) => busBits('Q', 4, busVal(prev, 'Q', 4) + (rose(v, was) ? 1 : 0)),
        },

        // Serial. A signal crosses the board a cell a tick and a wire carries
        // one bit, so a wide bus is costly and a narrow one cheap. These send
        // a number down one wire, a bit a clock, least significant first, and
        // turn it back into a bus. The order is the adder's: a carry goes up.
        {
            id: 'sipo4', chapter: 'serial', title: 'Serial in', subtitle: 'one wire to four',
            brief: 'Bits arrive on SI, least significant first, one per clock. Each time CLK goes ON, '
                + 'every bit moves one place down — Q3 to Q2, Q2 to Q1, Q1 to Q0 — and SI comes in '
                + 'at Q3. Four clocks, and the four bits sent are on Q3..Q0.',
            hint: 'Four flip-flops in a chain on one clock: SI into the first, whose Q is Q3 and the '
                + 'next one’s D. Each takes what the one before it held, at the same instant. If a '
                + 'bit runs two places on one clock, the clock is reaching that flip-flop too late: '
                + 'run CLK to the far end of the chain first.',
            sequential: true, clock: 'CLK', wakes: true,
            inputs: ['SI', 'CLK'], outputs: busNames('Q', 4), w: 56, h: 28, part: 'SIPO4', uses: { dff: 4 },
            script: serialInScript([0b1011, 0b0110, 0b1001]),
            step: (v, prev, was) => (rose(v, was) ? { Q3: v.SI, Q2: prev.Q3, Q1: prev.Q2, Q0: prev.Q1 } : { ...prev }),
        },
        {
            id: 'piso4', chapter: 'serial', title: 'Serial out', subtitle: 'four wires to one',
            brief: 'When CLK goes ON with LOAD on, take the number on D3..D0. With LOAD off, each '
                + 'clock moves it one place down, a 0 coming in at the top. SO is the bottom bit, so '
                + 'the number goes out least significant first.',
            hint: 'Four flip-flops, and in front of each a mux under LOAD: on, it takes its D bit; '
                + 'off, the bit above it (−V for the top one). SO is the bottom flip-flop’s Q.',
            sequential: true, clock: 'CLK',
            inputs: [...busNames('D', 4), 'LOAD', 'CLK'], outputs: ['SO'], w: 70, h: 38, part: 'PISO4',
            uses: { dff: 4, select4: 1 },
            script: serialOutScript([0b1011, 0b0110, 0b1101]),
            // The register's four bits are its own business; only SO shows.
            step: (v, prev, was, mem) => {
                if (rose(v, was)) mem.reg = v.LOAD ? busVal(v, 'D', 4) : mem.reg === undefined ? undefined : mem.reg >> 1;
                return { SO: mem.reg === undefined ? null : mem.reg & 1 };
            },
        },
        {
            id: 'serial-add', chapter: 'serial', title: 'Serial adder', subtitle: 'a bit a clock',
            brief: 'Two numbers arrive on A and B, least significant bit first, one per clock. While '
                + 'CLK is off, S is this place of their sum: A + B + the carry from the place before. '
                + 'Each time CLK goes ON, keep the carry for the next.',
            hint: 'One full adder and one flip-flop: the flip-flop holds the carry, into the adder’s '
                + 'Cin, and takes its Cout on each clock. If the carry goes missing when A and B change '
                + 'together, the adder is draining it back up the wire: feed Cin from a mux with the '
                + 'flip-flop’s Q on SEL and +V and −V on its pins — a copy that is driven.',
            sequential: true, clock: 'CLK',
            inputs: ['A', 'B', 'CLK'], outputs: ['S'], w: 48, h: 28, part: 'SERADD',
            uses: { 'full-adder-tight': 1, dff: 1 },
            script: serialAddScript([[11, 6], [15, 15], [5, 3]]),
            // The carry is the circuit's own; it is known once A and B have
            // agreed on an edge (then the carry is what they agree on). S is
            // read while the clock is off.
            step: (v, prev, was, mem) => {
                if (rose(v, was) && (v.A === v.B || mem.c !== undefined)) mem.c = v.A === v.B ? v.A : mem.c;
                return { S: v.CLK || mem.c === undefined ? null : v.A ^ v.B ^ mem.c };
            },
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
            id: 'serial', title: 'Serial',
            blurb: 'A signal crosses the board a cell a tick, and a wire carries one bit. So send a '
                + 'number down one wire, a bit per clock, and turn it back into a bus at the far end.',
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

    window.PixelogicLevels = {
        LEVELS, CHAPTERS, getLevel, levelIndex, levelsIn,
        busNames, busVal, busBits, loadHoldScript,
    };
})(window);
