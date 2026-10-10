(function (window) {
    const M = window.PixelogicModel;

    const canvas = document.getElementById('grid');
    const ctx = canvas.getContext('2d');

    // ===== PCB palette =====
    const COLOR_INSULATOR = '#065300';
    const COLOR_CONDUCTOR = '#0a9000';   // single conductor color; charge shown by the grey box
    // Mux material that is not a solid 3x2 yet: plain dark body.
    const COLOR_GRAY_BODY = '#2b1b0b';
    // Sources are a filled disc: +V gold plating, -V black.
    const COLOR_POS_PAD = '#e6b800';
    // Output LED: red, dark when off, bright when on.
    const COLOR_LED_OFF = '#4a0d0d', COLOR_LED_ON = '#ff2a2a';
    // Momentary switch: a round "solder" pad; brighter when pressed.
    const COLOR_SWITCH = '#9aa0a6', COLOR_SWITCH_PRESSED = '#e8ebee';
    // Latching toggle: same solder family, drawn as a square pad — dark when
    // off, bright when latched on.
    const COLOR_TOGGLE_OFF = '#565b60', COLOR_TOGGLE_ON = '#e8ebee';
    // Source disc rings: a green darker than the substrate itself for the
    // gold (+) disc (reads as a groove cut into the board, rather than
    // blending into or brightening the background), a dimmer silver gray for
    // the black (-) disc.
    const COLOR_POS_RING = '#032900', COLOR_NEG_RING = '#8c949c';
    // Charge is shown uniformly across conductors, mux pixels and crossovers
    // as a faint (25% opacity) light-grey box: full-size for ON, slightly
    // smaller for FALLING, nothing for OFF.
    const COLOR_CHARGE = 'rgba(216, 216, 216, 0.25)';

    var zoom = 1;
    var panX = 0, panY = 0;
    // Whether the faint cell-grid overlay is drawn; ui.js drives this
    // per-mode (build vs. interact remember separate on/off preferences).
    var gridVisible = true;

    // Overlay rectangle drawn on top of the cells by drawGrid: the active
    // selection (also used to highlight a floating paste). {x0,y0,x1,y1} in
    // grid coords, or null.
    var selectionRect = null;

    // Non-rectangular overlay for the Rearrange tool: the grabbed/selected
    // object's cells ([[x,y],...] or null). Drawn in a different hue from
    // the selection rectangle so "an object is grabbed" doesn't read as "a
    // region is selected".
    var objectHighlight = null;

    // Campaign pad labels: [{x, y, text, side:'left'|'right'|'top'|'bottom', color?}], drawn
    // just outside the cell so a level's terminals are named on the board
    // itself rather than only in the brief. Empty in the sandbox. Verify
    // rewrites them while it plays (A=1, Q=0 ✓) and gives them a colour.
    var labels = [];

    // Colour by number: {cells:[[x,y]...], color} drawn as dashed ghosts on
    // every cell that is not that material yet, or null. A tutorial step's
    // "your piece goes here".
    var guide = null;

    // A rectangle the level asks the circuit to fit, {x0, y0, x1, y1}, or
    // null: drawn as a dashed square with its size, under the parts.
    var targetRect = null;

    // Where the MUX tool would put a part: {cells, ok}, or null.
    var stampPreview = null;

    function cellSize() { return M.CELL_SIZE * zoom; }

    // The viewport in CSS pixels, which is the unit everything else here —
    // pan, zoom, hit-testing, the pointer — works in.
    var viewW = 0, viewH = 0, dpr = 1, sized = false;

    // The backing store is sized in DEVICE pixels and every draw goes through
    // a devicePixelRatio transform (see drawGrid), so the board is sharp on a
    // phone or a HiDPI monitor. It used to be sized in CSS pixels and then
    // stretched 1.5-3x by the browser, which softened every wire edge, lead
    // and label on exactly the screens this PWA is built for. Skips the
    // reallocation when nothing changed: assigning canvas.width clears it.
    function resizeCanvas() {
        const viewport = document.getElementById('viewport');
        const w = viewport.clientWidth, h = viewport.clientHeight;
        const r = window.devicePixelRatio || 1;
        if (sized && w === viewW && h === viewH && r === dpr) return;
        sized = true;
        viewW = w; viewH = h; dpr = r;
        canvas.width = Math.round(w * r);
        canvas.height = Math.round(h * r);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
    }

    function screenToCell(sx, sy) {
        const cs = cellSize();
        return {
            x: Math.floor((sx - panX) / cs),
            y: Math.floor((sy - panY) / cs),
        };
    }

    // Charge on a wire cell, collapsed to a single value for the normal
    // (non-crossover) rendering. A crossover holds two; each axis is drawn on
    // its own (see drawCell).
    function wireCharge(id) {
        if (M.isXover(id)) return M.xoverV(id) === M.ON || M.xoverH(id) === M.ON ? M.ON
            : M.xoverV(id) === M.FALLING || M.xoverH(id) === M.FALLING ? M.FALLING : M.OFF;
        return M.conductorCharge(id);
    }

    // ===== Thin-wire rendering =====
    //
    // Rather than filling the whole cell, a conductor draws a hub at the
    // cell's center plus a bar reaching toward each side that's actually
    // connected to another wire/component (M.cellConnects) — so it reads as
    // a dot (0 neighbors), a dead-end stub (1), a straight line (2 opposite),
    // an elbow (2 adjacent, chamfered — see addElbowShape), a tee (3), or a
    // plus (4), all from the same hub-plus-arms shape with no case-by-case
    // special drawing needed beyond the elbow's chamfer.
    //
    // Every wire cell's geometry (and the charge overlay's) is accumulated
    // into one shared Path2D per layer and filled ONCE at the end of
    // drawGrid, rather than each cell calling fillRect independently: two
    // adjacent fillRect calls of the same color, even when their edges are
    // meant to touch exactly, can leave a faint antialiased seam wherever
    // floating-point cell math doesn't land the shared edge on a whole pixel.
    // A single fill() over the union of all rects in one path has no such
    // internal seams — only the outer silhouette against the substrate is
    // antialiased.
    //
    // A crossover is the one shape still drawn specially (addCrossoverWire):
    // it's a self-contained "pipe fitting" over/under within its own cell —
    // the vertical run breaks well clear of the horizontal one, a deliberately
    // large gap (not just clearing the horizontal bar's own width) so the
    // break reads clearly rather than blending into the wire's normal
    // thickness. Neighbors don't need to know or care it's there — they just
    // see a normally-connected cell and draw their own arm toward it.
    const WIRE_THICKNESS = 0.44;
    // The charge highlight reuses the exact same hub-plus-arms shape, only
    // smaller, so it reads as the wire's own core lighting up rather than a
    // shape unrelated to the (now much thinner) wire body. This shape math is
    // also what a future flowing-charge animation would move fluid along.
    const CHARGE_THICKNESS_ON = WIRE_THICKNESS * 0.55, CHARGE_THICKNESS_FALLING = WIRE_THICKNESS * 0.38;
    // How far from the cell's centre an elbow's 45° bevel starts, along each
    // arm, as a fraction of the cell — the 45°-routing PCB look. The bevel's
    // WIDTH is not a choice: it is always exactly the wire's (see
    // addElbowShape).
    const ELBOW_BEVEL = 0.25;
    // The crossover's vertical break, as a fraction of the cell — deliberately
    // large (matching the old two-cell gap-cutting look) so it reads as an
    // obvious interruption rather than just "as wide as the wire."
    const CROSSOVER_GAP_FRAC = 0.8;

    // Each side is asked with the direction pointing back at this cell, so a
    // neighbor that only connects on one face (a mux lead) answers for
    // the face we are actually reaching toward rather than for itself as a
    // whole — otherwise a wire routing past a pin grows an arm into the
    // package and draws as a tee where it should be an elbow.
    function wireArms(x, y) {
        return {
            n: M.cellConnects(x, y - 1, [0, 1]),
            e: M.cellConnects(x + 1, y, [-1, 0]),
            s: M.cellConnects(x, y + 1, [0, -1]),
            w: M.cellConnects(x - 1, y, [1, 0]),
        };
    }

    // Exactly two ADJACENT (perpendicular) arms — a bend, as opposed to a
    // straight run (2 opposite) or a tee/plus (3/4).
    function isElbow(arms) {
        const count = (arms.n ? 1 : 0) + (arms.e ? 1 : 0) + (arms.s ? 1 : 0) + (arms.w ? 1 : 0);
        return count === 2 && !(arms.n && arms.s) && !(arms.e && arms.w);
    }

    // ---- Elbows, and staircases of them ----
    //
    // An elbow's arms, in clockwise order: `first`, and `second` a quarter
    // turn clockwise from it. Every elbow is the canonical north-then-east one
    // turned `k` quarters.
    const ARM_ORDER = ['n', 'e', 's', 'w'];
    const ARM_DIR = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
    const OPP_ARM = { n: 's', e: 'w', s: 'n', w: 'e' };

    // How each of an elbow's two arms meets its neighbour: 'diag' where the
    // neighbour is an elbow turning back the other way — arms {opposite of
    // first, opposite of second} — so the two are one step of a staircase and
    // the track crosses their shared edge on the diagonal; 'wire' where the
    // neighbour is any other wire; 'edge' where it is a pad, a source or a
    // mux lead. Both cells of a stair step answer 'diag' for the edge they
    // share, so their two halves of the diagonal meet exactly.
    function elbowPorts(x, y, arms) {
        let k = 0;
        while (!(arms[ARM_ORDER[k]] && arms[ARM_ORDER[(k + 1) % 4]])) k++;
        const a = ARM_ORDER[k], b = ARM_ORDER[(k + 1) % 4];
        const kind = (arm) => {
            const [dx, dy] = ARM_DIR[arm], nx = x + dx, ny = y + dy;
            const id = M.getCell(nx, ny);
            if (!M.isConductorId(id) && !M.isXover(id)) return 'edge';
            if (M.isCrossoverAt(nx, ny)) return 'wire';
            const na = wireArms(nx, ny);
            return isElbow(na) && na[OPP_ARM[a]] && na[OPP_ARM[b]] ? 'diag' : 'wire';
        };
        return { k, first: kind(a), second: kind(b) };
    }

    // The elbow's outline, in cell-centred coordinates for the canonical
    // north (first) / east (second) elbow; s is half a cell, h half the
    // track's width, bevel as ELBOW_BEVEL. All of them wind clockwise, like
    // Path2D.rect, so they merge with the rest of the wire in one fill.
    //
    // Both arms straight: a 45° bevel between them. The two edges of the
    // bevel are offset from its centre-line by h, measured square to it, so
    // along each arm they sit h·(√2−1) either side of where the centre-line
    // turns — that is what keeps the diagonal exactly one track wide. (The
    // old outline filled the inside corner to h·√2 and came out √2 too fat.)
    //
    // Both arms diagonal: a straight 45° band from the north edge's midpoint
    // to the east edge's, crossing each edge h·√2 wide — the same crossing
    // the next step's band makes from its side, so a staircase reads as one
    // diagonal line, a track wide.
    //
    // One of each: the track turns 45° right at the straight arm's edge. The
    // inside of that turn falls h·(√2−1) into the NEIGHBOUR's cell, so when
    // the neighbour is wire it is drawn from here (it is one fill); against a
    // pad or a lead it stops at the edge instead.
    function elbowOutline(first, second, s, h, bevel) {
        const k = h * (Math.SQRT2 - 1), r = h * Math.SQRT2;
        if (first !== 'diag' && second !== 'diag') {
            return [[-h, -s], [h, -s], [h, -bevel - k], [bevel + k, -h],
                [s, -h], [s, h], [bevel - k, h], [-h, -bevel + k]];
        }
        if (first === 'diag' && second === 'diag') return [[-r, -s], [r, -s], [s, -r], [s, r]];
        // Written for a straight north and a diagonal east; the other way
        // round is its mirror image across the bend, order reversed to keep
        // the winding.
        const straightNorth = (spill) => (spill
            ? [[-h, -s], [h, -s], [h, -s - k], [s, -r], [s, r], [-h, -s + k]]
            : [[-h, -s], [r, -s], [s, -r], [s, r], [-h, -s + k]]);
        if (second === 'diag') return straightNorth(first === 'wire');
        return straightNorth(second === 'wire').map(([x, y]) => [-y, -x]).reverse();
    }

    function addElbowShape(path, px, py, cs, half, ports) {
        const cx = px + cs / 2, cy = py + cs / 2;
        const pts = elbowOutline(ports.first, ports.second, cs / 2, half, cs * ELBOW_BEVEL).map(([x, y]) => {
            for (let i = 0; i < ports.k; i++) [x, y] = [-y, x];   // a quarter turn clockwise
            return [cx + x, cy + y];
        });
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
        path.closePath();
    }

    // Adds a hub-plus-arms wire shape to a shared path: a square hub at the
    // cell's center plus a rectangle extended to each active arm's edge (all
    // one thickness, seaming together with no gap or overlap at the hub) — or,
    // for an elbow specifically, the beveled outline above (`ports` from
    // elbowPorts).
    function addWireShape(path, px, py, cs, arms, thicknessFrac, ports) {
        const t = cs * thicknessFrac, half = t / 2;
        if (ports) {
            addElbowShape(path, px, py, cs, half, ports);
            return;
        }
        const cx = px + cs / 2, cy = py + cs / 2;
        path.rect(cx - half, cy - half, t, t);
        if (arms.n) path.rect(cx - half, py, t, cy - half - py);
        if (arms.s) path.rect(cx - half, cy + half, t, py + cs - (cy + half));
        if (arms.e) path.rect(cx + half, cy - half, px + cs - (cx + half), t);
        if (arms.w) path.rect(px, cy - half, cx - half - px, t);
    }

    function addChargeShape(path, px, py, cs, arms, charge, ports) {
        if (charge !== M.ON && charge !== M.FALLING) return;
        addWireShape(path, px, py, cs, arms, charge === M.ON ? CHARGE_THICKNESS_ON : CHARGE_THICKNESS_FALLING, ports);
    }

    // Crossover: the horizontal run is solid across the full cell width; the
    // vertical run breaks well clear of it on both sides (CROSSOVER_GAP_FRAC,
    // not just the horizontal bar's own width) so it visually passes under —
    // the standard schematic crossing convention, self-contained in one cell.
    function addCrossoverWire(path, px, py, cs) {
        const t = cs * WIRE_THICKNESS, half = t / 2, gap = cs * CROSSOVER_GAP_FRAC / 2;
        const cx = px + cs / 2, cy = py + cs / 2;
        path.rect(cx - half, py, t, (cy - gap) - py);
        path.rect(cx - half, cy + gap, t, (py + cs) - (cy + gap));
        path.rect(px, cy - half, cs, t);
    }

    function chargeThicknessFrac(charge) {
        if (charge === M.ON) return CHARGE_THICKNESS_ON;
        if (charge === M.FALLING) return CHARGE_THICKNESS_FALLING;
        return 0;
    }

    // Same split-bar shape as addCrossoverWire, but for the charge overlay —
    // each axis highlighted independently, since a crossover keeps two.
    function addCrossoverCharge(path, px, py, cs, vCharge, hCharge) {
        const cx = px + cs / 2, cy = py + cs / 2, gap = cs * CROSSOVER_GAP_FRAC / 2;
        const vf = chargeThicknessFrac(vCharge);
        if (vf) {
            const t = cs * vf, half = t / 2;
            path.rect(cx - half, py, t, (cy - gap) - py);
            path.rect(cx - half, cy + gap, t, (py + cs) - (cy + gap));
        }
        const hf = chargeThicknessFrac(hCharge);
        if (hf) {
            const t = cs * hf, half = t / 2;
            path.rect(px, cy - half, cs, t);
        }
    }

    // `layers` bundles every shared Path2D (plus the mux-indicator list/set)
    // accumulated across the current drawGrid pass, all filled once after
    // the per-cell loop rather than per-cell — see the comment above
    // addWireShape for why (per-cell fillRect calls leave antialiased
    // seams). The same reasoning applies to gray body fills and to LED
    // cells, which is why those route into shared paths here too instead of
    // calling ctx.fillRect directly.
    function drawCell(x, y, layers) {
        const cs = cellSize();
        const px = panX + x * cs, py = panY + y * cs;
        if (px + cs < 0 || py + cs < 0 || px > viewW || py > viewH) return;

        const id = M.getCell(x, y);

        if (M.isInsulatorId(id)) return; // substrate is already the base fill (see drawGrid)

        if (M.isConductorId(id) || M.isXover(id)) {
            // The wire no longer fills the cell; the substrate base fill (see
            // drawGrid) already shows through the gaps around it.
            if (M.isCrossoverAt(x, y)) {
                addCrossoverWire(layers.wirePath, px, py, cs);
                const vCharge = M.isXover(id) ? M.xoverV(id) : M.conductorCharge(id);
                const hCharge = M.isXover(id) ? M.xoverH(id) : M.conductorCharge(id);
                addCrossoverCharge(layers.chargePath, px, py, cs, vCharge, hCharge);
            } else {
                const arms = wireArms(x, y);
                const ports = isElbow(arms) ? elbowPorts(x, y, arms) : null;
                addWireShape(layers.wirePath, px, py, cs, arms, WIRE_THICKNESS, ports);
                addChargeShape(layers.chargePath, px, py, cs, arms, wireCharge(id), ports);
            }
            return;
        }

        if (id === M.ID_POS || id === M.ID_NEG) {
            // One drawing for one thing — arm stubs and all — whether it sits
            // out on its own or flush against an LED or a mux lead, where the
            // stub is what makes the connection read.
            drawSourceCell(x, y, px, py, cs, id === M.ID_POS);
            return;
        }

        if (M.isLed(id)) {
            addLedShape(M.ledIsOn(id) ? layers.ledOnPath : layers.ledOffPath, x, y, px, py, cs);
            return;
        }
        if (M.isSwitch(id)) { drawSwitch(px, py, cs, M.switchIsPressed(id)); return; }
        if (M.isToggle(id)) { drawToggle(px, py, cs, M.toggleIsOn(id)); return; }

        if (M.isGrayId(id)) {
            drawMuxPixel(x, y, id, px, py, cs, layers);
            return;
        }
    }

    // Explicit source: +V is white with a black +, -V is black with a white -,
    // each ringed in the opposite color so it stands out on any background.
    // A rect with 0-4 of its corners chamfered — used to bevel only an LED
    // blob's outer (silhouette) corners, so a lone LED reads as a rounded
    // chip and a cluster reads as one pad with just its outer edge cut,
    // rather than every cell looking identically notched.
    function addChamferedRect(path, px, py, cs, cut, bevel) {
        const x0 = px, y0 = py, x1 = px + cs, y1 = py + cs;
        const pts = [];
        if (cut.nw) { pts.push([x0, y0 + bevel]); pts.push([x0 + bevel, y0]); } else pts.push([x0, y0]);
        if (cut.ne) { pts.push([x1 - bevel, y0]); pts.push([x1, y0 + bevel]); } else pts.push([x1, y0]);
        if (cut.se) { pts.push([x1, y1 - bevel]); pts.push([x1 - bevel, y1]); } else pts.push([x1, y1]);
        if (cut.sw) { pts.push([x0 + bevel, y1]); pts.push([x0, y1 - bevel]); } else pts.push([x0, y1]);
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
        path.closePath();
    }

    function isLedAt(x, y) { return M.inBounds(x, y) && M.isLed(M.getCell(x, y)); }

    // Output LED: a red cell, dark when off, bright when on — added to a
    // shared per-color path (see drawCell) rather than filled immediately,
    // both to avoid the antialiased-seam issue addWireShape's own batching
    // avoids, and to let a corner's bevel decision look past this one cell.
    // A corner is chamfered only when NEITHER of its two orthogonal
    // neighbors is also an LED — i.e. only true outer/convex corners of the
    // blob, never a concave inner corner of an L-shaped cluster or an edge
    // shared with a same-blob neighbor.
    const LED_BEVEL_FRAC = 0.3;
    function addLedShape(path, x, y, px, py, cs) {
        const cut = {
            nw: !isLedAt(x - 1, y) && !isLedAt(x, y - 1),
            ne: !isLedAt(x + 1, y) && !isLedAt(x, y - 1),
            se: !isLedAt(x + 1, y) && !isLedAt(x, y + 1),
            sw: !isLedAt(x - 1, y) && !isLedAt(x, y + 1),
        };
        if (!cut.nw && !cut.ne && !cut.se && !cut.sw) { path.rect(px, py, cs, cs); return; }
        addChamferedRect(path, px, py, cs, cut, cs * LED_BEVEL_FRAC);
    }

    // Momentary switch: a round solder pad, dark when released, bright while
    // held.
    function drawSwitch(px, py, cs, pressed) {
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(px, py, cs, cs);
        const cx = px + cs / 2, cy = py + cs / 2;
        ctx.fillStyle = pressed ? COLOR_SWITCH_PRESSED : COLOR_SWITCH;
        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(1, cs * 0.06);
        ctx.stroke();
    }

    // Latching toggle: a square solder pad, dark when off, bright/inset when
    // latched on.
    function drawToggle(px, py, cs, on) {
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(px, py, cs, cs);
        const m = on ? cs * 0.12 : cs * 0.06;
        ctx.fillStyle = on ? COLOR_TOGGLE_ON : COLOR_TOGGLE_OFF;
        ctx.fillRect(px + m, py + m, cs - 2 * m, cs - 2 * m);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(1, cs * 0.05);
        ctx.strokeRect(px + m, py + m, cs - 2 * m, cs - 2 * m);
    }

    // The source glyph itself — a filled circle, gold ringed in dark green
    // for +, black ringed in dimmer silver gray for - — drawn for the
    // explicit +V/-V cells.
    function drawSourceCircleGlyph(cx, cy, cs, positive) {
        ctx.fillStyle = positive ? COLOR_POS_PAD : '#000000';
        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.36, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = positive ? COLOR_POS_RING : COLOR_NEG_RING;
        ctx.lineWidth = Math.max(1, cs * 0.08);
        ctx.stroke();
    }

    // Bridges the gap between a wire body (which stops at this cell's edge,
    // same as any other neighbor) and a source glyph's circle: a stub in one
    // direction reaching to the cell's center, which the opaque circle drawn
    // after naturally clips flush with its own edge. The charge highlight
    // rides along at the source's own constant drive state so it, too, reads
    // as continuing onto the circle rather than stopping short of it.
    function addSourceArmStub(px, py, cs, cx, cy, dx, dy, positive) {
        const t = cs * WIRE_THICKNESS, half = t / 2;
        ctx.fillStyle = COLOR_CONDUCTOR;
        if (dy === -1) ctx.fillRect(cx - half, py, t, cy - py);
        else if (dy === 1) ctx.fillRect(cx - half, cy, t, py + cs - cy);
        else if (dx === 1) ctx.fillRect(cx, cy - half, px + cs - cx, t);
        else ctx.fillRect(px, cy - half, cx - px, t);
        const chargeFrac = positive ? CHARGE_THICKNESS_ON : CHARGE_THICKNESS_FALLING;
        const ct = cs * chargeFrac, chalf = ct / 2;
        ctx.fillStyle = COLOR_CHARGE;
        if (dy === -1) ctx.fillRect(cx - chalf, py, ct, cy - py);
        else if (dy === 1) ctx.fillRect(cx - chalf, cy, ct, py + cs - cy);
        else if (dx === 1) ctx.fillRect(cx, cy - chalf, px + cs - cx, ct);
        else ctx.fillRect(px, cy - chalf, cx - px, ct);
    }

    // An explicit +V/-V cell. Substrate background, a stub toward every
    // neighbor it actually connects to, and the circle glyph on top — the
    // stub is what makes it read as plugged into a wire, an LED or a mux
    // edge rather than merely abutting it.
    function drawSourceCell(x, y, px, py, cs, positive) {
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(px, py, cs, cs);
        const cx = px + cs / 2, cy = py + cs / 2;
        const arms = wireArms(x, y);
        if (arms.n) addSourceArmStub(px, py, cs, cx, cy, 0, -1, positive);
        if (arms.s) addSourceArmStub(px, py, cs, cx, cy, 0, 1, positive);
        if (arms.e) addSourceArmStub(px, py, cs, cx, cy, 1, 0, positive);
        if (arms.w) addSourceArmStub(px, py, cs, cx, cy, -1, 0, positive);
        drawSourceCircleGlyph(cx, cy, cs, positive);
    }

    // ---- The mux: drawn as a surface-mount part ----
    // Rather than a square per cell, the whole macro is one part: a package
    // sitting on the board, with silvery SOIC leads at exactly the faces that
    // carry a connection.
    //
    // The outline follows the model's three states (see buildBoxMux). Fresh
    // out of the tool it is a plain rounded rectangle — six gray pixels with
    // no orientation yet (`boxIdle`), so no leads and nothing printed on it.
    // A wire on a long side settles which way round it goes (`boxFrame`):
    // the package becomes the mux's trapezoid and grows the three leads that
    // are now known — COM and both pins. The first wire to land on a corner
    // is SELECT and fixes the rest, adding the fourth lead and the
    // silkscreen.
    const BOX_PKG_INSET = 0.15;   // package edge, in from the footprint
    const BOX_PKG_RADIUS = 0.24;
    // Once the axis is known the package tapers toward COM — the mux's own
    // trapezoid, but softened into something that still reads as a part:
    // a shallow taper, rounded corners, and a shallow notch in the middle of
    // the wide side, where nothing connects.
    const BOX_TAPER = 0.2;
    const BOX_NOTCH_HALF = 0.34, BOX_NOTCH_DEPTH = 0.16, BOX_NOTCH_RADIUS = 0.16;
    const BOX_LEAD_HALF = WIRE_THICKNESS / 2;  // a lead is a wire wide, so they line up
    const BOX_LEAD_TUCK = 0.2;    // how far the lead runs under the package
    const COLOR_BOX_BODY = '#343434', COLOR_BOX_OUTLINE = '#8e8e8e';
    const COLOR_BOX_LEAD = '#c3c8ce';
    const COLOR_BOX_SILK = 'rgba(235, 235, 235, 0.42)';
    const BOX_OUTLINE_FRAC = 0.04;
    const BOX_PIN1_R = 0.13, BOX_PIN1_U = 0.58;

    // Queues one mux part, deduped by key: every cell of the macro hands over
    // the same frame. An unwired package carries only a footprint (no
    // orientation, hence no leads or silkscreen).
    function queueBoxPart(layers, key, part) {
        if (layers.queuedBoxKeys.has(key)) return;
        layers.queuedBoxKeys.add(key);
        layers.boxParts.push(part);
    }

    // A closed polygon with every corner rounded: start mid-edge, then arc
    // through each vertex. Each radius is clamped to half the shorter of its
    // two edges, so a tight corner rounds as much as it can and no more.
    function roundedPoly(pts, radii) {
        const n = pts.length, p = new Path2D();
        const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
        p.moveTo(...mid(pts[n - 1], pts[0]));
        for (let i = 0; i < n; i++) {
            const cur = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
            const r = Math.min(radii[i], dist(prev, cur) / 2, dist(cur, next) / 2);
            p.arcTo(cur[0], cur[1], ...mid(cur, next), r);
        }
        p.closePath();
        return p;
    }

    // The package body. With no orientation yet it's a plain rounded
    // rectangle over the footprint, inset so the leads have somewhere to
    // emerge from; once the axis is known it tapers toward COM and picks up
    // the notch (see BOX_TAPER).
    function boxPackagePath(frame, cs) {
        const I = BOX_PKG_INSET, rect = frame.rect;
        if (!frame.toward) {
            const p = new Path2D();
            const w = rect.w * cs - 2 * I * cs, h = rect.h * cs - 2 * I * cs;
            p.roundRect(panX + rect.x * cs + I * cs, panY + rect.y * cs + I * cs,
                w, h, Math.min(BOX_PKG_RADIUS * cs, w / 2, h / 2));
            return p;
        }
        // (u, v) cell frame: u along the long axis from the first end, v
        // across from the COM side. The COM edge is pulled in at both ends.
        const along = frame.along, toward = frame.toward;
        const ox = panX + (frame.rowStart[0] + 0.5) * cs - (along[0] + toward[0]) * cs / 2;
        const oy = panY + (frame.rowStart[1] + 0.5) * cs - (along[1] + toward[1]) * cs / 2;
        const P = (u, v) => [ox + (along[0] * u + toward[0] * v) * cs,
        oy + (along[1] * u + toward[1] * v) * cs];
        const near = I, far = 2 - I, lo = I + BOX_TAPER, hi = 3 - I - BOX_TAPER;
        const pts = [
            [lo, near], [hi, near],                          // COM (narrow) edge
            [3 - I, far],                                    // pin side, last end
            [1.5 + BOX_NOTCH_HALF, far],
            [1.5, far - BOX_NOTCH_DEPTH],                    // notch apex
            [1.5 - BOX_NOTCH_HALF, far],
            [I, far],                                        // pin side, first end
        ].map(([u, v]) => P(u, v));
        const R = BOX_PKG_RADIUS * cs, N = BOX_NOTCH_RADIUS * cs;
        return roundedPoly(pts, [R, R, R, N, N, N, R]);
    }

    // One lead: a silver tab on `cell`'s `dir` face, from the cell boundary
    // in under the package edge. Drawn before the package, so the body
    // trims its inner end and it reads as emerging from underneath.
    function addBoxLead(path, [cx, cy], [dx, dy], cs) {
        const ccx = panX + cx * cs + cs / 2, ccy = panY + cy * cs + cs / 2;
        const outer = 0.5, inner = 0.5 - BOX_PKG_INSET - BOX_LEAD_TUCK;
        const ax = ccx + dx * inner * cs, ay = ccy + dy * inner * cs;
        const bx = ccx + dx * outer * cs, by = ccy + dy * outer * cs;
        const hx = -dy * BOX_LEAD_HALF * cs, hy = dx * BOX_LEAD_HALF * cs;
        path.moveTo(ax + hx, ay + hy); path.lineTo(bx + hx, by + hy);
        path.lineTo(bx - hx, by - hy); path.lineTo(ax - hx, ay - hy);
        path.closePath();
    }

    // Silkscreen: just the pin-1 dot, by the select corner — the one
    // asymmetry on the package, and the same corner the frame is measured
    // from. The package outline is already the mux's trapezoid, so there is
    // nothing else worth printing. Sits on the COM row's centerline, in line
    // with the SELECT lead and clear of the tapered corner.
    function drawBoxSilk(macro, cs) {
        const along = macro.along, toward = macro.toward;
        const ox = panX + (macro.rowStart[0] + 0.5) * cs - (along[0] + toward[0]) * cs / 2;
        const oy = panY + (macro.rowStart[1] + 0.5) * cs - (along[1] + toward[1]) * cs / 2;
        const u = macro.selIsFirst ? BOX_PIN1_U : 3 - BOX_PIN1_U;
        const dx = ox + (along[0] * u + toward[0] * 0.5) * cs;
        const dy = oy + (along[1] * u + toward[1] * 0.5) * cs;
        ctx.beginPath();
        ctx.arc(dx, dy, BOX_PIN1_R * cs, 0, Math.PI * 2);
        ctx.fillStyle = COLOR_BOX_SILK;
        ctx.fill();
    }

    // ---- Pin labels ----
    // The mux is the one thing in this world that has to be learned, so a
    // working part can say which lead is which, in silkscreen — SEL, COM, NO,
    // NC — the way a real board prints its pin names. A teaching aid, so
    // `pinLabels` is on in the mux tutorial and elsewhere only when the menu
    // asks: on a board full of parts it is clutter.
    const COLOR_BOX_LABEL = 'rgba(235, 235, 235, 0.78)';
    // Label size: a quarter of a cell on a big part, growing to a third of
    // one — about as wide as "COM" can get inside a cell — to stay readable
    // when zoomed out. Legibility is judged in DEVICE pixels, since a phone's
    // screen shows text far smaller than a monitor's at the same CSS size;
    // below that the pin-1 dot stands in.
    const PIN_LABEL_FRAC = 0.24, PIN_LABEL_MAX_FRAC = 0.33, PIN_LABEL_PREF_PX = 7;
    const PIN_LABEL_MIN_DEVICE_PX = 9;
    const pinLabelPx = (cs) => Math.max(cs * PIN_LABEL_FRAC, Math.min(cs * PIN_LABEL_MAX_FRAC, PIN_LABEL_PREF_PX));
    var pinLabels = true;

    // Labels sit on the terminal cells' centres, upright whichever way the
    // part is turned. SELECT's is nudged in off the tapered corner.
    function drawPinLabels(frame, macro, cs) {
        const along = frame.along, toward = frame.toward;
        const ox = panX + (frame.rowStart[0] + 0.5) * cs - (along[0] + toward[0]) * cs / 2;
        const oy = panY + (frame.rowStart[1] + 0.5) * cs - (along[1] + toward[1]) * cs / 2;
        const put = (u, v, text) => ctx.fillText(text,
            ox + (along[0] * u + toward[0] * v) * cs, oy + (along[1] * u + toward[1] * v) * cs);
        ctx.font = `700 ${pinLabelPx(cs)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = COLOR_BOX_LABEL;
        put(1.5, 0.5, 'COM');
        if (macro) {
            const selFirst = macro.selIsFirst;
            put(selFirst ? 0.6 : 2.4, 0.5, 'SEL');
            put(selFirst ? 0.5 : 2.5, 1.5, 'NO');
            put(selFirst ? 2.5 : 0.5, 1.5, 'NC');
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function drawBoxPart(part, cs) {
        const frame = part.frame;
        const leads = frame.leads;
        if (leads.length) {
            const leadPath = new Path2D();
            for (const [cell, dir] of leads) addBoxLead(leadPath, cell, dir, cs);
            ctx.fillStyle = COLOR_BOX_LEAD;
            ctx.fill(leadPath);
        }
        const body = boxPackagePath(frame, cs);
        ctx.fillStyle = COLOR_BOX_BODY;
        ctx.fill(body);
        ctx.strokeStyle = COLOR_BOX_OUTLINE;
        ctx.lineWidth = Math.max(1, cs * BOX_OUTLINE_FRAC);
        ctx.stroke(body);
        const labelled = pinLabels && frame.toward && pinLabelPx(cs) * dpr >= PIN_LABEL_MIN_DEVICE_PX;
        if (labelled) drawPinLabels(frame, part.macro, cs);
        else if (part.macro) drawBoxSilk(part.macro, cs);
    }

    function drawMuxPixel(x, y, id, px, py, cs, layers) {
        const role = M.roles[M.idx(x, y)];

        // Mux material that isn't a 3x2 (yet) is plain dark body, whatever
        // its size: inert, and drawn as the part it is not yet.
        if (!role || role.kind === 'isolatedGray') {
            layers.muxBodyPath.rect(px, py, cs, cs);
            return;
        }

        // The whole macro draws as one surface-mount part rather than
        // per-cell squares, so its cells contribute nothing here — each just
        // hands over the frame it belongs to. See drawBoxPart. Uncommissioned
        // states carry a frame but no macro: a blank package with no
        // orientation, or a trapezoid with three of its leads once a long
        // side has said which way round it goes.
        if (role.kind === 'boxIdle' || role.kind === 'boxFrame') {
            queueBoxPart(layers, role.frame.key, { frame: role.frame, macro: null });
            return;
        }
        const m = role.macro;
        queueBoxPart(layers, m.key, { frame: m, macro: m });
    }

    // ---- Blocks: a part placed whole ----
    // A block with its lid shut is drawn as one integrated circuit over its
    // whole footprint: a package, its name, a lead at each pin with the pin's
    // name beside it on the package. The cells under the lid are not drawn
    // at all (see drawGrid), which also makes a board full of parts cheap.
    // With the lid off, the circuit shows where it sits, ringed by a dashed
    // outline with the part's name on it — and blocks nested inside keep
    // their own lids. A part's leads are on its pins' faces; the terminal a
    // wire goes on is the cell just outside. Round every part, its edge:
    // cells it keeps bare are faintly hatched, and a terminal nothing is
    // wired to yet is marked, so it is plain where to connect.
    const LID_INSET = 0.3;          // package edge, in from the core
    const LID_RADIUS = 0.3;
    const LID_LEAD_TUCK = 0.15;     // how far a lead runs in under the package
    const COLOR_LID = '#1b1b1d', COLOR_LID_EDGE = '#77777d';
    const COLOR_LID_NAME = 'rgba(238, 238, 238, 0.92)', COLOR_LID_PIN = 'rgba(238, 238, 238, 0.66)';
    const COLOR_LID_LEAD_ON = '#f4f7fa';
    const COLOR_OPEN_EDGE = 'rgba(214, 222, 230, 0.6)';
    const LID_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    // Whether a pin is carrying charge: the wire on its terminal, or else the
    // pin's own cell.
    function pinLit(p) {
        const t = M.getCell(p.at[0], p.at[1]);
        if (M.isConductorId(t)) return M.conductorCharge(t) === M.ON;
        const h = M.getCell(p.host[0], p.host[1]);
        if (M.isConductorId(h)) return M.conductorCharge(h) === M.ON;
        if (M.isGrayId(h)) return M.grayCharge(h) === M.ON;
        return false;
    }

    // A part's edge: kept-bare cells hatched, unwired terminals marked.
    // `strong` (Make part…, and a part about to be put down) also dots the
    // free cells and uses the outline's colours.
    function drawEdge(ring, cs, strong, bad) {
        if (cs < 5) return;
        ctx.save();
        const hatch = new Path2D(), dots = new Path2D();
        for (const e of ring) {
            const px = panX + e.x * cs, py = panY + e.y * cs;
            if (px > viewW || py > viewH || px + cs < 0 || py + cs < 0) continue;
            if (e.cls === 'R') {
                for (const t of [0.5, 1, 1.5]) {
                    if (t <= 1) { hatch.moveTo(px, py + t * cs); hatch.lineTo(px + t * cs, py); }
                    else { hatch.moveTo(px + (t - 1) * cs, py + cs); hatch.lineTo(px + cs, py + (t - 1) * cs); }
                }
            } else if (e.cls === 'T') {
                if (!strong && M.inBounds(e.x, e.y) && !M.isInsulatorId(M.getCell(e.x, e.y))) continue;
                ctx.strokeStyle = strong ? (bad ? '#ff8a8a' : COLOR_OUTLINE) : 'rgba(195, 200, 206, 0.7)';
                ctx.lineWidth = Math.max(1, cs * 0.05);
                ctx.setLineDash([Math.max(2, cs * 0.12), Math.max(2, cs * 0.1)]);
                ctx.strokeRect(px + cs * 0.22, py + cs * 0.22, cs * 0.56, cs * 0.56);
                ctx.setLineDash([]);
            } else if (strong) {
                dots.moveTo(px + cs / 2 + cs * 0.06, py + cs / 2);
                dots.arc(px + cs / 2, py + cs / 2, cs * 0.06, 0, Math.PI * 2);
            }
        }
        ctx.strokeStyle = strong ? (bad ? 'rgba(255, 138, 138, 0.8)' : 'rgba(255, 150, 120, 0.75)') : 'rgba(0, 0, 0, 0.32)';
        ctx.lineWidth = Math.max(1, cs * 0.05);
        ctx.stroke(hatch);
        ctx.fillStyle = 'rgba(214, 222, 230, 0.55)';
        ctx.fill(dots);
        ctx.restore();
    }

    // The package's own rectangle, in canvas pixels.
    function lidRect(b, cs, inset) {
        const I = inset * cs;
        return {
            x: panX + b.x0 * cs + I, y: panY + b.y0 * cs + I,
            w: (b.x1 - b.x0 + 1) * cs - 2 * I, h: (b.y1 - b.y0 + 1) * cs - 2 * I,
        };
    }

    // A lead: from the footprint's edge in to just under the package.
    function addLidLead(path, [cx, cy], [dx, dy], cs, halfFrac) {
        const ccx = panX + (cx + 0.5) * cs, ccy = panY + (cy + 0.5) * cs;
        const outer = 0.5, inner = 0.5 - LID_INSET - LID_LEAD_TUCK;
        const ax = ccx + dx * inner * cs, ay = ccy + dy * inner * cs;
        const bx = ccx + dx * outer * cs, by = ccy + dy * outer * cs;
        const hx = -dy * halfFrac * cs, hy = dx * halfFrac * cs;
        path.moveTo(ax + hx, ay + hy); path.lineTo(bx + hx, by + hy);
        path.lineTo(bx - hx, by - hy); path.lineTo(ax - hx, ay - hy);
        path.closePath();
    }


    function drawLid(b, cs, ghost) {
        const full = lidRect(b, cs, 0);
        if (full.x > viewW || full.y > viewH || full.x + full.w < 0 || full.y + full.h < 0) return;
        ctx.save();
        if (ghost) ctx.globalAlpha = 0.72;
        const leads = new Path2D(), lit = new Path2D();
        for (const p of b.pins) {
            if (!p.host) continue;
            addLidLead(leads, p.host, p.face, cs, BOX_LEAD_HALF);
            // A pin carrying charge shows it, so signals can be followed
            // through a shut part without opening it.
            if (!ghost && pinLit(p)) addLidLead(lit, p.host, p.face, cs, BOX_LEAD_HALF * 0.55);
        }
        ctx.fillStyle = COLOR_BOX_LEAD;
        ctx.fill(leads);
        ctx.fillStyle = COLOR_LID_LEAD_ON;
        ctx.fill(lit);

        const r = lidRect(b, cs, LID_INSET);
        const body = new Path2D();
        body.roundRect(r.x, r.y, r.w, r.h, Math.min(LID_RADIUS * cs, r.w / 2, r.h / 2));
        ctx.fillStyle = ghost && ghost.bad ? '#3a1414' : COLOR_LID;
        ctx.fill(body);
        ctx.strokeStyle = ghost ? (ghost.bad ? '#ff8a8a' : '#e8e8e8') : COLOR_LID_EDGE;
        ctx.lineWidth = Math.max(1, cs * (ghost ? 0.07 : BOX_OUTLINE_FRAC));
        ctx.stroke(body);
        // (No pin-1 dot: on a part as small as a gate, the corner it would
        // sit in is where a pin's name goes.)

        // Pin names on the package, beside their leads, when there is room
        // to read them; the part's name in the middle. On a shut part the
        // pin names are how you know what to wire where, so they hold a
        // readable size for as long as the cells are big enough to carry it.
        const pinPx = Math.max(PIN_LABEL_MIN_DEVICE_PX / dpr, Math.min(cs * 0.46, 14));
        let pinBand = 0;
        if (cs * dpr >= 14) {
            ctx.font = `600 ${pinPx}px ${LID_FONT}`;
            ctx.fillStyle = COLOR_LID_PIN;
            ctx.textBaseline = 'middle';
            const pad = Math.max(3, cs * 0.14);
            for (const p of b.pins) {
                if (!p.host) continue;
                const [dx, dy] = p.face;
                const cx = panX + (p.host[0] + 0.5) * cs, cy = panY + (p.host[1] + 0.5) * cs;
                if (dx) {
                    ctx.textAlign = dx < 0 ? 'left' : 'right';
                    ctx.fillText(p.name, dx < 0 ? r.x + pad : r.x + r.w - pad, cy);
                    pinBand = Math.max(pinBand, ctx.measureText(p.name).width + pad * 2);
                } else {
                    ctx.textAlign = 'center';
                    ctx.fillText(p.name, cx, dy < 0 ? r.y + pad + pinPx / 2 : r.y + r.h - pad - pinPx / 2);
                }
            }
        }
        const room = Math.max(0, r.w - 2 * pinBand);
        const namePx = Math.min(cs * 0.9, r.h * 0.42, room / Math.max(2, b.name.length * 0.62));
        if (namePx * dpr >= 8) {
            ctx.font = `700 ${namePx}px ${LID_FONT}`;
            ctx.fillStyle = COLOR_LID_NAME;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(b.name, r.x + r.w / 2, r.y + r.h / 2);
        }
        ctx.restore();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // Lid off: the circuit is on show, so all that is drawn is where the
    // part begins and ends, what it is called, and which wire is which pin.
    function drawOpenBlock(b, cs) {
        const r = lidRect(b, cs, 0.12);
        if (r.x > viewW || r.y > viewH || r.x + r.w < 0 || r.y + r.h < 0) return;
        ctx.save();
        ctx.strokeStyle = COLOR_OPEN_EDGE;
        ctx.lineWidth = Math.max(1, cs * 0.05);
        ctx.setLineDash([Math.max(3, cs * 0.22), Math.max(2, cs * 0.14)]);
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(LID_RADIUS * cs, r.w / 2, r.h / 2));
        ctx.stroke();
        ctx.setLineDash([]);
        // The name on a tab across the outline's top-left corner.
        const namePx = Math.min(cs * 0.55, 14);
        if (namePx * dpr >= 8) {
            ctx.font = `700 ${namePx}px ${LID_FONT}`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const tx = r.x + cs * 0.35, ty = r.y;
            const tw = ctx.measureText(b.name).width;
            ctx.fillStyle = 'rgba(6, 40, 0, 0.85)';
            ctx.fillRect(tx - cs * 0.12, ty - namePx * 0.7, tw + cs * 0.24, namePx * 1.4);
            ctx.fillStyle = COLOR_LID_NAME;
            ctx.fillText(b.name, tx, ty);
        }
        const pinPx = Math.min(cs * 0.3, 11);
        if (pinPx * dpr >= PIN_LABEL_MIN_DEVICE_PX) {
            ctx.font = `600 ${pinPx}px ${LID_FONT}`;
            ctx.fillStyle = COLOR_LID_PIN;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (const p of b.pins) {
                if (!p.at) continue;
                ctx.fillText(p.name, panX + (p.at[0] + 0.5) * cs, panY + p.at[1] * cs + cs * 0.04);
            }
        }
        ctx.restore();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // Where the Parts tool would put a part: a ghost of its shut lid and its
    // edge, red if it cannot go there.
    // {x0, y0, x1, y1, name, pins: [{name, host, face, at}], ring, ok}
    var partPreview = null;

    // Make part…: the core it fitted, its edge, and the terminals named —
    // {core, edge: [{x, y, cls}], pins: [{x, y, side, name, dir}]} — or
    // {bad: [[x, y]]}, the cells that kept it from fitting.
    var partOutline = null;
    const COLOR_OUTLINE = '#7dffb3';
    function drawPartOutline(cs) {
        const o = partOutline;
        ctx.save();
        if (o.bad) {
            ctx.fillStyle = 'rgba(255, 90, 90, 0.35)';
            ctx.strokeStyle = '#ff8a8a';
            ctx.lineWidth = Math.max(1.5, cs * 0.06);
            for (const [x, y] of o.bad) {
                ctx.fillRect(panX + x * cs, panY + y * cs, cs, cs);
                ctx.strokeRect(panX + x * cs, panY + y * cs, cs, cs);
            }
        }
        if (o.core) {
            const r = o.core;
            ctx.strokeStyle = COLOR_OUTLINE;
            ctx.lineWidth = Math.max(1.5, cs * 0.07);
            ctx.setLineDash([Math.max(3, cs * 0.25), Math.max(2, cs * 0.15)]);
            ctx.strokeRect(panX + r.x0 * cs, panY + r.y0 * cs, (r.x1 - r.x0 + 1) * cs, (r.y1 - r.y0 + 1) * cs);
            ctx.setLineDash([]);
            if (o.edge) drawEdge(o.edge.filter((e) => e.cls !== 'T'), cs, true, false);
            // Each terminal: its cell ringed, its name just outside the edge.
            const size = Math.max(9, Math.min(15, cs * 0.55));
            ctx.font = `700 ${size}px ${LID_FONT}`;
            for (const p of o.pins || []) {
                const px = panX + p.x * cs, py = panY + p.y * cs;
                ctx.strokeStyle = p.dir === 'out' ? '#ffd166' : COLOR_OUTLINE;
                ctx.lineWidth = Math.max(1.5, cs * 0.08);
                ctx.strokeRect(px + cs * 0.08, py + cs * 0.08, cs * 0.84, cs * 0.84);
                const [dx, dy] = EDGE_DIR[p.side];
                const tx = px + cs / 2 + dx * cs * 0.95, ty = py + cs / 2 + dy * cs * 0.95;
                ctx.textAlign = dx < 0 ? 'right' : dx > 0 ? 'left' : 'center';
                ctx.textBaseline = dy < 0 ? 'bottom' : dy > 0 ? 'top' : 'middle';
                const label = (p.name || '?') + (p.dir === 'out' ? ' →' : '');
                const w = ctx.measureText(label).width;
                const bx = ctx.textAlign === 'right' ? tx - w : ctx.textAlign === 'center' ? tx - w / 2 : tx;
                const by = ctx.textBaseline === 'bottom' ? ty - size : ctx.textBaseline === 'top' ? ty : ty - size / 2;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
                ctx.fillRect(bx - 3, by - 2, w + 6, size + 4);
                ctx.fillStyle = p.dir === 'out' ? '#ffd166' : COLOR_OUTLINE;
                ctx.fillText(label, tx, ty);
            }
        }
        ctx.restore();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }
    const EDGE_DIR = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };

    // ---- The ratsnest ----
    // A connection a rearrange could not keep is drawn as a straight dashed
    // line between the two ends that should be joined — a PCB tool's unrouted
    // airwire. It deliberately ignores the grid: it is a statement about what
    // the circuit owes, not a route, and looking nothing like a trace is what
    // keeps the two from being confused. Draw the wire and it disappears.
    const COLOR_PENDING = '#ffb020';
    const PENDING_WIDTH = 0.06, PENDING_DASH = [0.34, 0.26], PENDING_DOT = 0.11;

    function drawPendingLinks(cs) {
        const links = M.pendingLinks();
        if (!links.length) return;
        ctx.save();
        ctx.strokeStyle = COLOR_PENDING;
        ctx.fillStyle = COLOR_PENDING;
        ctx.lineWidth = Math.max(1, cs * PENDING_WIDTH);
        ctx.setLineDash(PENDING_DASH.map((d) => Math.max(2, d * cs)));
        ctx.lineCap = 'butt';
        for (const [[ax, ay], [bx, by]] of links) {
            const x0 = panX + ax * cs + cs / 2, y0 = panY + ay * cs + cs / 2;
            const x1 = panX + bx * cs + cs / 2, y1 = panY + by * cs + cs / 2;
            ctx.beginPath();
            ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
            ctx.stroke();
            // A dot at each end, so a short link still reads as a link even
            // when the dashes have nowhere to fall.
            ctx.setLineDash([]);
            for (const [px, py] of [[x0, y0], [x1, y1]]) {
                ctx.beginPath();
                ctx.arc(px, py, Math.max(1, cs * PENDING_DOT), 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.setLineDash(PENDING_DASH.map((d) => Math.max(2, d * cs)));
        }
        ctx.restore();
    }

    function drawGrid() {
        // Reset per frame rather than once: resizing the canvas resets its
        // whole context state, transform included.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, viewW, viewH);

        const cs = cellSize();
        const x0 = Math.max(0, Math.floor(-panX / cs));
        const y0 = Math.max(0, Math.floor(-panY / cs));
        const x1 = Math.min(M.GRID_W - 1, Math.ceil((viewW - panX) / cs));
        const y1 = Math.min(M.GRID_H - 1, Math.ceil((viewH - panY) / cs));

        // One combined fill for the whole visible substrate, rather than each
        // insulator/conductor cell filling its own square — adjacent
        // same-color fillRect calls leave antialiased seams between them at
        // non-integer zoom (same issue addWireShape's batching avoids below).
        ctx.fillStyle = COLOR_INSULATOR;
        ctx.fillRect(panX + x0 * cs, panY + y0 * cs, (x1 - x0 + 1) * cs, (y1 - y0 + 1) * cs);

        // Every wire/charge/mux-body/LED shape in the redraw accumulates into
        // one path per layer, filled once each below — see the comment above
        // addWireShape for why (per-cell fillRect calls leave antialiased
        // seams). Mux parts are collected too, one per macro (see
        // queueBoxPart), since each is drawn whole rather than per cell.
        const layers = {
            wirePath: new Path2D(),
            chargePath: new Path2D(),
            muxBodyPath: new Path2D(),
            ledOnPath: new Path2D(),
            ledOffPath: new Path2D(),
            boxParts: [],
            queuedBoxKeys: new Set(),
        };
        // Nothing under a shut lid is drawn: the lid covers it.
        const blockList = M.blockList();
        const shut = new Set(blockList.filter((b) => !b.open).map((b) => b.id));
        const parentOf = new Map(blockList.map((b) => [b.id, b.parent]));
        const underLid = (x, y) => {
            for (let b = M.blockAtCell(x, y); b; b = parentOf.get(b)) if (shut.has(b)) return true;
            return false;
        };
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++)
                if (!shut.size || !underLid(x, y)) drawCell(x, y, layers);
        ctx.fillStyle = COLOR_GRAY_BODY;
        ctx.fill(layers.muxBodyPath);
        // Mux parts go in with the rest of the mux bodies — under the
        // wires, so a wire meeting a lead draws over the shared boundary.
        for (const part of layers.boxParts) drawBoxPart(part, cs);
        ctx.fillStyle = COLOR_LED_OFF;
        ctx.fill(layers.ledOffPath);
        ctx.fillStyle = COLOR_LED_ON;
        ctx.fill(layers.ledOnPath);
        ctx.fillStyle = COLOR_CONDUCTOR;
        ctx.fill(layers.wirePath);
        ctx.fillStyle = COLOR_CHARGE;
        ctx.fill(layers.chargePath);
        drawPendingLinks(cs);

        if (gridVisible && cs > 6) {
            // Fade the grid lines out as cells get small, so a zoomed-out board
            // reads as solid color instead of a busy mesh.
            const gridAlpha = Math.min(0.25, cs / 180);
            ctx.strokeStyle = `rgba(0,0,0,${gridAlpha})`;
            // A whole number of DEVICE pixels wide, centred on a device pixel
            // boundary, so the lines stay crisp at fractional ratios too.
            const lw = Math.max(1, Math.round(dpr));
            const snap = (v) => (Math.round(v * dpr) + (lw % 2) / 2) / dpr;
            ctx.lineWidth = lw / dpr;
            ctx.beginPath();
            for (let x = x0; x <= x1 + 1; x++) {
                const px = snap(panX + x * cs);
                ctx.moveTo(px, panY + y0 * cs);
                ctx.lineTo(px, panY + (y1 + 1) * cs);
            }
            for (let y = y0; y <= y1 + 1; y++) {
                const py = snap(panY + y * cs);
                ctx.moveTo(panX + x0 * cs, py);
                ctx.lineTo(panX + (x1 + 1) * cs, py);
            }
            ctx.stroke();
        }

        // Parts go over the grid lines, outermost first, so a lid reads as a
        // package sitting on the board and a part nested in an open one
        // shows its own lid on top.
        for (const b of blockList) if (!b.parent && b.ring) drawEdge(b.ring, cs, false, false);
        for (const b of blockList) {
            if (b.hidden) continue;
            if (b.open) drawOpenBlock(b, cs);
            else drawLid(b, cs, null);
        }

        if (targetRect) drawTargetRect(cs);
        if (guide) drawGuide(cs);
        if (partPreview) {
            if (partPreview.ring) drawEdge(partPreview.ring, cs, true, !partPreview.ok);
            drawLid(partPreview, cs, { bad: !partPreview.ok });
        }
        if (partOutline) drawPartOutline(cs);
        if (stampPreview) drawCellsOutline(stampPreview.cells, cs,
            stampPreview.ok ? 'rgba(52, 52, 52, 0.55)' : 'rgba(255, 90, 90, 0.18)',
            stampPreview.ok ? 'rgba(235, 235, 235, 0.9)' : '#ff8a8a', false);
        if (labels.length) drawLabels(cs);
        if (selectionRect) drawOverlayRect(selectionRect, '#7dffb3', 'rgba(125, 255, 179, 0.12)');
        if (objectHighlight) drawObjectHighlight(objectHighlight);
    }

    // Pad names, in the black margin beyond the board's edge rather than over
    // the build area. The text scales with the zoom but is floored and capped,
    // so the labels stay legible on a zoomed-out board without swelling into
    // the circuit on a zoomed-in one.
    function drawLabels(cs) {
        const size = Math.max(9, Math.min(16, cs * 0.6));
        ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.textBaseline = 'middle';
        const gap = Math.max(4, cs * 0.25);
        for (const l of labels) {
            const vertical = l.side === 'top' || l.side === 'bottom';
            const cy = !vertical ? panY + (l.y + 0.5) * cs
                : l.side === 'top' ? panY + l.y * cs - gap - size / 2 : panY + (l.y + 1) * cs + gap + size / 2;
            if (cy < -size || cy > viewH + size) continue;
            ctx.textAlign = vertical ? 'center' : l.side === 'left' ? 'right' : 'left';
            ctx.fillStyle = l.color || '#9a9a9a';
            const cx = vertical ? panX + (l.x + 0.5) * cs : l.side === 'left' ? panX + l.x * cs - gap : panX + (l.x + 1) * cs + gap;
            ctx.fillText(l.text, cx, cy);
        }
        ctx.textAlign = 'left';
    }

    // A set of cells as one shape: a wash over each, and a dashed outline
    // round the silhouette only (edges with no neighbour in the set), so a
    // 3x2 reads as one part and a run of wire as one run.
    function drawCellsOutline(cellsList, cs, fill, stroke, dashed) {
        const set = new Set(cellsList.map(([x, y]) => x + ',' + y));
        ctx.save();
        ctx.fillStyle = fill;
        for (const [x, y] of cellsList) ctx.fillRect(panX + x * cs, panY + y * cs, cs, cs);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(1.5, cs * 0.05);
        ctx.setLineDash(dashed ? [Math.max(3, cs * 0.16), Math.max(2, cs * 0.12)] : []);
        ctx.beginPath();
        for (const [x, y] of cellsList) {
            const px = panX + x * cs, py = panY + y * cs;
            if (!set.has(x + ',' + (y - 1))) { ctx.moveTo(px, py); ctx.lineTo(px + cs, py); }
            if (!set.has(x + ',' + (y + 1))) { ctx.moveTo(px, py + cs); ctx.lineTo(px + cs, py + cs); }
            if (!set.has((x - 1) + ',' + y)) { ctx.moveTo(px, py); ctx.lineTo(px, py + cs); }
            if (!set.has((x + 1) + ',' + y)) { ctx.moveTo(px + cs, py); ctx.lineTo(px + cs, py + cs); }
        }
        ctx.stroke();
        ctx.restore();
    }

    function drawTargetRect(cs) {
        const r = targetRect;
        const x = panX + r.x0 * cs, y = panY + r.y0 * cs;
        const w = (r.x1 - r.x0 + 1) * cs, h = (r.y1 - r.y0 + 1) * cs;
        ctx.save();
        ctx.fillStyle = 'rgba(255, 209, 102, 0.07)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
        ctx.lineWidth = Math.max(2, cs * 0.08);
        ctx.setLineDash([Math.max(4, cs * 0.3), Math.max(3, cs * 0.2)]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        const size = Math.max(9, Math.min(14, cs * 0.45));
        ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fillStyle = 'rgba(255, 209, 102, 0.95)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${r.x1 - r.x0 + 1}×${r.y1 - r.y0 + 1}`, x + 2, y - 2);
        ctx.restore();
    }

    // The guide's cells that are not the right material yet, each group
    // outlined as one shape: a dashed 3x2 for a part, a dashed channel for a
    // wire. Cells already filled in drop out, so the ghost shrinks as you
    // trace it.
    const GUIDE_FILL = { gray: 'rgba(52, 52, 52, 0.5)', conductor: 'rgba(10, 144, 0, 0.45)' };
    function drawGuide(cs) {
        const todo = guide.cells.filter(([x, y]) => M.colorOfCell(M.getCell(x, y)) !== guide.color);
        if (!todo.length) return;
        drawCellsOutline(todo, cs, GUIDE_FILL[guide.color] || 'rgba(255,255,255,0.1)',
            'rgba(235, 235, 235, 0.85)', true);
    }

    // Translucent wash over each cell of the grabbed object, outlined only
    // along its silhouette (edges with no same-object neighbor) so a mux or
    // a winding wire run reads as one grabbed shape, not a pile of squares.
    function drawObjectHighlight(cellsList) {
        const cs = cellSize();
        const set = new Set(cellsList.map(([x, y]) => x + ',' + y));
        ctx.fillStyle = 'rgba(125, 184, 255, 0.18)';
        for (const [x, y] of cellsList) ctx.fillRect(panX + x * cs, panY + y * cs, cs, cs);
        ctx.strokeStyle = '#7db8ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const [x, y] of cellsList) {
            const px = panX + x * cs, py = panY + y * cs;
            if (!set.has(x + ',' + (y - 1))) { ctx.moveTo(px, py); ctx.lineTo(px + cs, py); }
            if (!set.has(x + ',' + (y + 1))) { ctx.moveTo(px, py + cs); ctx.lineTo(px + cs, py + cs); }
            if (!set.has((x - 1) + ',' + y)) { ctx.moveTo(px, py); ctx.lineTo(px, py + cs); }
            if (!set.has((x + 1) + ',' + y)) { ctx.moveTo(px + cs, py); ctx.lineTo(px + cs, py + cs); }
        }
        ctx.stroke();
    }

    function drawOverlayRect(r, stroke, fill) {
        const cs = cellSize();
        const px = panX + r.x0 * cs, py = panY + r.y0 * cs;
        const w = (r.x1 - r.x0 + 1) * cs, h = (r.y1 - r.y0 + 1) * cs;
        ctx.fillStyle = fill;
        ctx.fillRect(px, py, w, h);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(px + 1, py + 1, w - 2, h - 2);
        ctx.setLineDash([]);
    }

    // The board is the whole world, so the view never strays far from it: at
    // most ONE cell of empty space is allowed beyond any edge. Panning past
    // that is not a feature — there is nothing out there, and being able to
    // fling the board half off-screen only ever loses it. When an axis has
    // room to spare the board is centred on it outright, so a small board
    // sits in the middle instead of drifting into a corner.
    const MARGIN_CELLS = 1;

    // Height at the foot of the canvas covered by an overlay drawn on top of
    // it (the campaign's level bar). Fitting and clamping both work against
    // the part that is actually visible, so a board is never tucked behind it.
    var insetBottom = 0;
    const usableHeight = () => Math.max(80, viewH - insetBottom);

    function clampPan() {
        const cs = cellSize(), m = cs * MARGIN_CELLS;
        const gw = M.GRID_W * cs, gh = M.GRID_H * cs;
        const vw = viewW, vh = usableHeight();
        panX = gw + 2 * m <= vw ? (vw - gw) / 2 : Math.max(vw - gw - m, Math.min(m, panX));
        panY = gh + 2 * m <= vh ? (vh - gh) / 2 : Math.max(vh - gh - m, Math.min(m, panY));
    }

    // The zoom at which the board plus its one-cell margin exactly fills the
    // viewport — and therefore the furthest out anyone can go. Zooming past
    // "the whole board, framed" would only add black.
    function minZoom() {
        const cs = Math.min(viewW / (M.GRID_W + 2 * MARGIN_CELLS),
            usableHeight() / (M.GRID_H + 2 * MARGIN_CELLS));
        return Math.max(0.05, cs / M.CELL_SIZE);
    }

    function fitToWindow() {
        resizeCanvas();
        zoom = Math.min(4, minZoom());
        clampPan();
    }

    window.PixelogicView = {
        canvas, drawGrid, resizeCanvas, screenToCell, fitToWindow,
        // The viewport in CSS pixels. canvas.width/height are DEVICE pixels
        // now, and only equal these at a ratio of 1.
        get width() { return viewW; },
        get height() { return viewH; },
        get zoom() { return zoom; },
        setZoom(z) { zoom = Math.max(minZoom(), Math.min(4, z)); clampPan(); },
        get minZoom() { return minZoom(); },
        // Re-apply both limits — after a resize, a board swap, or the level
        // bar changing height, the current zoom/pan may no longer be legal.
        clampView() { resizeCanvas(); if (zoom < minZoom()) zoom = Math.min(4, minZoom()); clampPan(); },
        setViewInset(bottom) { insetBottom = bottom || 0; },
        pan(dx, dy) { panX += dx; panY += dy; clampPan(); },
        get panX() { return panX; }, get panY() { return panY; },
        // Set an exact pan without clamping — used to restore a saved pan on
        // undo/redo so the drawing lands back in the same place.
        setPan(x, y) { panX = x; panY = y; },
        // When the grid auto-grows on the left/top, existing content shifts by
        // (leftCells, topCells); move the view the opposite way so nothing on
        // screen appears to move. No clamp — exactness matters here.
        compensateExpansion(leftCells, topCells) {
            panX -= leftCells * cellSize();
            panY -= topCells * cellSize();
        },
        get labels() { return labels; },
        setLabels(list) { labels = list || []; },
        get guide() { return guide; },
        get targetRect() { return targetRect; },
        setTargetRect(r) { targetRect = r || null; },
        setGuide(g) { guide = g && g.cells && g.cells.length ? g : null; },
        get stampPreview() { return stampPreview; },
        get partPreview() { return partPreview; },
        setPartPreview(p) { partPreview = p || null; },
        get partOutline() { return partOutline; },
        setPartOutline(o) { partOutline = o || null; },
        setStampPreview(p) { stampPreview = p || null; },
        setSelection(r) { selectionRect = r; },
        setObjectHighlight(cellsList) { objectHighlight = cellsList; },
        get gridVisible() { return gridVisible; },
        setGridVisible(v) { gridVisible = v; },
        // Silkscreen pin names on each mux. On by default; the icon
        // generator turns them off, since text is noise at icon size.
        setPinLabels(v) { pinLabels = !!v; },
    };
})(window);
