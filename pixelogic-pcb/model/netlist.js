// The board as a netlist: the wires it is, and the switches between them —
// what the tick works on (sim.js). Compiled from the cells once per
// structural edit (B.rev), never per tick; what changes tick to tick (the
// charge, the switches' positions, the input pads) stays in the cells.
//
// A site is a place on the board that carries one value: a wire cell, a
// source (+V or −V), a toggle's or a switch's cell, a mux's COM or one of
// its pins — and a crossing twice, its north–south way (axis 0) and its
// east–west (axis 1). Sites that touch and connect, each toward the other
// (cellConnects: a mux cell through its lead only, a source where it is
// soldered), are one net. A mux is
// then four nets and a contact: SEL (the net its control's lead reads),
// COM, NO and NC. Lamps only read: a lamp pad lights from the nets round
// it and joins none of them.
//
// Flat typed arrays throughout, so the tick is plain loops over numbers —
// and so moving it to WebAssembly some day is a copy, not a redesign.

import {
    DIRS, MK_NC, MK_NO, MK_O, NEIGHBORS_8, isConductorId, isLed, isMuxId, isPosSource, isSource, isSwitch,
    isToggle, isXover, muxKindOf,
} from './cells.js';
import {
    B,
} from './board.js';
import {
    cellConnects,
} from './blocks.js';

// What a cell is to the netlist: not there (0), wire (1), a driver — a
// source or an input pad, whose own value is fixed or set by hand (2) —
// or a mux's lead cell, COM or a pin (3). A mux cell that is no part of a
// whole mux is not there: inert plastic.
const S_NONE = 0, S_WIRE = 1, S_DRIVER = 2, S_LEAD = 3;
function siteKind(i) {
    const id = B.cells[i];
    if (isConductorId(id) || isXover(id)) return S_WIRE;
    if (isSource(id) || isToggle(id) || isSwitch(id)) return S_DRIVER;
    if (isMuxId(id)) {
        const k = muxKindOf[id], role = B.roles[i];
        if ((k === MK_O || k === MK_NO || k === MK_NC) && role && role.macro) return S_LEAD;
    }
    return S_NONE;
}
// The site of cell i its way d meets: a crossing's way d's axis.
const axisFor = (id, d) => (isXover(id) ? d & 1 : 0);

function compileNetlist() {
    const w = B.w, h = B.h, n = w * h, cells = B.cells;
    // Sites: two slots a cell, the second a crossing's east–west way.
    const siteOf = new Int32Array(n * 2).fill(-1);
    const kindOf = new Uint8Array(n);
    let sites = 0;
    for (let i = 0; i < n; i++) {
        const k = siteKind(i);
        kindOf[i] = k;
        if (!k) continue;
        siteOf[i * 2] = sites++;
        if (isXover(cells[i])) siteOf[i * 2 + 1] = sites++;
    }
    const siteCell = new Int32Array(sites), siteAxis = new Uint8Array(sites);
    for (let i = 0; i < n; i++) for (let a = 0; a < 2; a++) {
        const s = siteOf[i * 2 + a];
        if (s >= 0) { siteCell[s] = i; siteAxis[s] = a; }
    }
    // Sites that touch and connect are one net (union-find). Two drivers
    // side by side are not joined: a source is a tap on its rail, and so is
    // a pad — what each drives, it drives on its own.
    const parent = new Int32Array(sites);
    for (let s = 0; s < sites; s++) parent[s] = s;
    const find = (s) => { while (parent[s] !== s) { parent[s] = parent[parent[s]]; s = parent[s]; } return s; };
    // Every touch kept too, as well as joined: the sites' own graph, for
    // which way current runs along a net (sim.js flowField).
    const edges = [];
    const union = (a, b) => { edges.push(a, b); a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    for (let i = 0; i < n; i++) {
        if (!kindOf[i]) continue;
        const x = i % w, y = (i - x) / w;
        for (const d of [1, 2]) {      // east and south: each pair once
            const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
            if (nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!kindOf[j] || (kindOf[i] === S_DRIVER && kindOf[j] === S_DRIVER)) continue;
            if (!cellConnects(x, y, DIRS[d]) || !cellConnects(nx, ny, DIRS[(d + 2) & 3])) continue;
            union(siteOf[i * 2 + axisFor(cells[i], d)], siteOf[j * 2 + axisFor(cells[j], (d + 2) & 3)]);
        }
    }
    // Number the nets.
    const netOfRoot = new Int32Array(sites).fill(-1), siteNet = new Int32Array(sites);
    let nets = 0;
    for (let s = 0; s < sites; s++) {
        const r = find(s);
        if (netOfRoot[r] < 0) netOfRoot[r] = nets++;
        siteNet[s] = netOfRoot[r];
    }
    // Each net's sites, for writing its value back (CSR: netSiteStart[k]
    // to netSiteStart[k+1] in netSites), and what drives it: a source
    // (netPos, netNeg) or an input pad — whose cell says, tick to tick,
    // which way it drives (netPads, CSR as well).
    const netPos = new Uint8Array(nets), netNeg = new Uint8Array(nets);
    const count = new Int32Array(nets + 1), padCount = new Int32Array(nets + 1);
    for (let s = 0; s < sites; s++) {
        const id = cells[siteCell[s]], k = siteNet[s];
        if (isSource(id)) { if (isPosSource(id)) netPos[k] = 1; else netNeg[k] = 1; }
        else if (isToggle(id) || isSwitch(id)) padCount[k + 1]++;
        count[k + 1]++;
    }
    for (let k = 0; k < nets; k++) { count[k + 1] += count[k]; padCount[k + 1] += padCount[k]; }
    const netSites = new Int32Array(sites), netPads = new Int32Array(padCount[nets]);
    const fill = count.slice(0, nets), padFill = padCount.slice(0, nets);
    // A site of each net to read its value off: one that is no driver, if
    // it has one (a driver's cell says what it drives, not what its net
    // came to).
    const netRep = new Int32Array(nets).fill(-1);
    for (let s = 0; s < sites; s++) {
        const k = siteNet[s], id = cells[siteCell[s]];
        netSites[fill[k]++] = s;
        if (isToggle(id) || isSwitch(id)) netPads[padFill[k]++] = siteCell[s];
        if (netRep[k] < 0 || (kindOf[siteCell[netRep[k]]] === S_DRIVER && kindOf[siteCell[s]] !== S_DRIVER)) netRep[k] = s;
    }
    // The muxes, from their roles (edit.js buildMuxRoles): the switch cell
    // (M), the control (C) and the net its lead reads (-1: nothing there,
    // floating), and the nets of COM, NO and NC.
    const muxList = [];
    for (let i = 0; i < n; i++) {
        const r = B.roles[i];
        if (!r || r.kind !== 'switch' || !r.macro) continue;
        const m = r.macro, at = ([x, y]) => y * w + x;
        const [cx, cy] = m.selCorner, [ox, oy] = m.selOut, sx = cx + ox, sy = cy + oy;
        let sel = -1;
        if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
            const j = sy * w + sx;
            if (kindOf[j] && cellConnects(sx, sy, [-ox, -oy])) sel = siteNet[siteOf[j * 2 + axisFor(cells[j], DIRS.findIndex(([dx, dy]) => dx === -ox && dy === -oy))]];
        }
        const netAt = (c) => { const s = siteOf[at(c) * 2]; return s >= 0 ? siteNet[s] : -1; };
        muxList.push([at(m.selCell), at(m.selCorner), at(m.noCell), sel, netAt(m.comCell), netAt(m.noCell), netAt(m.ncCell),
            siteOf[at(m.comCell) * 2], siteOf[at(m.noCell) * 2], siteOf[at(m.ncCell) * 2]]);
    }
    const muxes = muxList.length;
    const muxM = new Int32Array(muxes), muxC = new Int32Array(muxes), muxNoCell = new Int32Array(muxes), muxSel = new Int32Array(muxes);
    const muxCom = new Int32Array(muxes), muxNo = new Int32Array(muxes), muxNc = new Int32Array(muxes);
    const muxComSite = new Int32Array(muxes), muxNoSite = new Int32Array(muxes), muxNcSite = new Int32Array(muxes);
    muxList.forEach(([mm, c, nocell, s, o, no, nc, os, nos, ncs], k) => {
        muxM[k] = mm; muxC[k] = c; muxNoCell[k] = nocell; muxSel[k] = s; muxCom[k] = o; muxNo[k] = no; muxNc[k] = nc;
        muxComSite[k] = os; muxNoSite[k] = nos; muxNcSite[k] = ncs;
    });
    // Lamp pads: the lamp cells touching (8 ways), and the nets round them
    // that reach a lamp cell (a mux only through its lead).
    const ledOf = new Int32Array(n).fill(-1), ledCells = [], ledNets = [];
    for (let i = 0; i < n; i++) {
        if (!isLed(cells[i]) || ledOf[i] >= 0) continue;
        const k = ledCells.length, group = [i], reads = new Set();
        ledOf[i] = k;
        for (let g = 0; g < group.length; g++) {
            const c = group[g], x = c % w, y = (c - x) / w;
            for (const [dx, dy] of NEIGHBORS_8) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const j = ny * w + nx;
                if (isLed(cells[j]) && ledOf[j] < 0) { ledOf[j] = k; group.push(j); }
            }
            for (let d = 0; d < 4; d++) {
                const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const j = ny * w + nx;
                if (!kindOf[j] || !cellConnects(nx, ny, DIRS[(d + 2) & 3])) continue;
                reads.add(siteNet[siteOf[j * 2 + axisFor(cells[j], d)]]);
            }
        }
        ledCells.push(group);
        ledNets.push([...reads]);
    }
    const csr = (lists) => {
        const start = new Int32Array(lists.length + 1);
        lists.forEach((l, k) => { start[k + 1] = start[k] + l.length; });
        const flat = new Int32Array(start[lists.length]);
        lists.forEach((l, k) => flat.set(l, start[k]));
        return { start, flat };
    };
    const lc = csr(ledCells), ln = csr(ledNets);
    // Each site's neighbours on the board (CSR).
    const adj = Array.from({ length: sites }, () => []);
    for (let e = 0; e < edges.length; e += 2) { adj[edges[e]].push(edges[e + 1]); adj[edges[e + 1]].push(edges[e]); }
    const sa = csr(adj);
    return {
        rev: B.rev, w, h, sites, nets, siteOf, siteCell, siteAxis, siteNet, siteAdjStart: sa.start, siteAdj: sa.flat,
        netSiteStart: count, netSites, netRep, netPos, netNeg, netPadStart: padCount, netPads,
        muxes, muxM, muxC, muxNoCell, muxSel, muxCom, muxNo, muxNc, muxComSite, muxNoSite, muxNcSite,
        leds: ledCells.length, ledCellStart: lc.start, ledCellList: lc.flat, ledNetStart: ln.start, ledNetList: ln.flat,
        // Scratch for the tick, sized once.
        parent: new Int32Array(nets), pos: new Uint8Array(nets), neg: new Uint8Array(nets), value: new Uint8Array(nets),
        contact: new Uint8Array(muxes),
    };
}

// The netlist of the board as it is: compiled again after an edit (its
// rev moved on), or the first time it is asked for. A copy of a board
// shares its original's until either is edited: it is never changed in
// place.
// An edit resets the breaker too: wired so it no longer shorts, the board
// runs on; still shorted, the next tick trips it again.
function netlistOf() {
    if (!B.netlist || B.netlist.rev !== B.rev || B.netlist.w !== B.w || B.netlist.h !== B.h) {
        B.netlist = compileNetlist();
        B.trip = null;
    }
    return B.netlist;
}

export {
    compileNetlist, netlistOf,
};
