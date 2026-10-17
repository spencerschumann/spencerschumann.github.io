// The scope: probes clipped to the board (the Probe tool, O), and a strip
// under it showing what each one reads, tick by tick, like a logic
// analyzer on the bench — run or stopped, a trigger on any probe's edge to
// catch a moment, a marker to measure from. And a clocked level's timing
// report (timing.js), measured off the page's thread after a passing
// Verify or on asking, shown in the same strip: the pads and the probes
// through a clean edge, a change inside the keep-out, the fastest clock.
// Each of those is a stimulus — a board to start from, and when each input
// changes — and an input's edges can be dragged: the board plays it again
// with the edge moved, there and then (T.play), to see what it does.
//
// Scrolling is the board's: scroll pans — sideways along time, up and
// down the rows — and only Ctrl/⌘ with it (or a pinch, which arrives so)
// zooms. Fit shows it all.

import {
    scopeCanvas, scopeClearBtn, scopeCollapseBtn, scopeEl, scopeFitBtn, scopeLiveBtn, scopeLiveCtl, scopeNamesEl,
    scopePadsBtn, scopeReadEl, scopeReportCtl, scopeResetBtn, scopeRunBtn, scopeScenariosEl, scopeSingleBtn,
    scopeSummaryEl, scopeTimingBtn, scopeTitleEl, scopeTrigEdgeEl, scopeTrigProbeEl, scopeZoomInBtn, scopeZoomOutBtn,
} from './page.js';
import {
    flashStatus,
} from './page.js';
import {
    gameLevel, reframeAfter,
} from './campaign.js';
import {
    renderStatus,
} from './verdict.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const S = window.PixelogicStorage;
const T = window.PixelogicTiming;

const COLORS = ['#ffd166', '#4cc9f0', '#f72585', '#7dffb3', '#ff9f43', '#b388ff', '#ff6b6b', '#e9ff70'];
const PAD_COLOR = '#c9ced4';
const ROW_H = 18, AXIS_H = 14;
const CAP = 8192;               // ticks kept, per probe
const MIN_PPT = 0.25, MAX_PPT = 24;

// ---- Probes ----------------------------------------------------------------
//
// Each board has its own — each level's and the sandbox's — kept with the
// app's other things (S.KEYS.probes): [{x, y, name, c}], `c` its colour.
let probes = [];
const boardKey = () => (gameLevel ? 'level:' + gameLevel.id : 'sandbox');
function keepProbes() {
    const all = S.getJSON(S.KEYS.probes, {}) || {};
    if (probes.length) all[boardKey()] = probes.map(({ x, y, name, c }) => ({ x, y, name, c }));
    else delete all[boardKey()];
    S.setJSON(S.KEYS.probes, all);
}
// This board's, on opening it (or the page).
function loadProbes() {
    const mine = (S.getJSON(S.KEYS.probes, {}) || {})[boardKey()];
    probes = Array.isArray(mine) ? mine.filter((p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && typeof p.name === 'string') : [];
    forgetTiming();
    showing = 'live';
    resetCapture();
    probesChanged(false);
}
// The board grown at its top or left: they move with it.
function shiftProbes(dx, dy) {
    if (!probes.length || (!dx && !dy)) return;
    for (const p of probes) { p.x += dx; p.y += dy; }
    keepProbes();
    V.setProbes(probeMarks());
}
const probeMarks = () => probes.map((p) => ({ x: p.x, y: p.y, name: p.name, color: COLORS[p.c % COLORS.length] }));
const probeAt = (x, y) => probes.findIndex((p) => p.x === x && p.y === y);
// The Probe tool's press: a probe there comes off, or one goes on — named
// for the pad it is on, else the first P1, P2… free, in the first colour
// free.
function toggleProbeAt(x, y) {
    if (!M.inBounds(x, y)) return;
    const at = probeAt(x, y);
    if (at >= 0) { removeProbe(at); return; }
    addProbe(x, y, null);
}
function addProbe(x, y, name) {
    if (probeAt(x, y) >= 0) return;
    const pad = V.labels.find((l) => l.x === x && l.y === y);
    const names = new Set(probes.map((p) => p.name));
    let n = name || (pad && pad.text.replace(/=.*$/, ''));
    if (!n || names.has(n)) { let k = 1; while (names.has('P' + k)) k++; n = 'P' + k; }
    const used = new Set(probes.map((p) => p.c));
    let c = 0;
    while (used.has(c) && c < COLORS.length) c++;
    probes.push({ x, y, name: n, c: c % COLORS.length });
    rings.push(new Int8Array(CAP).fill(-1));
    probesChanged(true);
}
function removeProbe(i) {
    probes.splice(i, 1);
    rings.splice(i, 1);
    if (trigger.probe === i) trigger.probe = -1;
    else if (trigger.probe > i) trigger.probe--;
    probesChanged(true);
}
function renameProbe(i, name) {
    const n = name.trim().slice(0, 12);
    if (!n || probes.some((p, k) => k !== i && p.name === n)) return false;
    probes[i].name = n;
    probesChanged(true);
    return true;
}
// Every pad of the level, probed.
function probePads() {
    for (const l of V.labels) addProbe(l.x, l.y, l.text.replace(/=.*$/, ''));
}
function probesChanged(keep) {
    if (keep) keepProbes();
    V.setProbes(probeMarks());
    V.drawGrid();
    renderNames();
    renderTriggerChoices();
    syncShown();
    dirty();
}

// ---- Capture ---------------------------------------------------------------
//
// Every tick of the board being worked on (M.watchTicks: running, Step, a
// Verify replay), each probe's reading goes into its ring: 1 charged, 0
// not, 2 draining, -1 nothing there to read. `total` counts ticks since
// the capture began. Stopped, nothing is taken. Single waits for the
// trigger — a probe's edge — and stops once the strip holds as much after
// it as fits, the trigger a third of the way in.
let rings = [];
let total = 0;
let capturing = true;
const trigger = { probe: -1, edge: 'rise' };
let armed = false, trigAt = null, stopAt = null;
function resetCapture() {
    rings = probes.map(() => new Int8Array(CAP).fill(-1));
    total = 0;
    trigAt = null;
    stopAt = null;
    marker = null;
    right = null;
    dirty();
}
function onTick() {
    if (!capturing || !probes.length) return;
    const slot = total % CAP;
    for (let k = 0; k < probes.length; k++) {
        const v = M.chargeAt(probes[k].x, probes[k].y);
        rings[k][slot] = v === null ? -1 : v;
    }
    if (armed && trigAt === null && trigger.probe >= 0 && total > 0) {
        const ring = rings[trigger.probe], was = ring[(total - 1) % CAP], now = ring[slot];
        const rose = now === 1 && was !== 1, fell = was === 1 && now !== 1;
        if ((trigger.edge !== 'fall' && rose) || (trigger.edge !== 'rise' && fell)) {
            trigAt = total;
            stopAt = total + Math.round(0.66 * plotWidth() / pxPerTick);
        }
    }
    total++;
    if (armed && stopAt !== null && total >= stopAt) {
        armed = false;
        capturing = false;
        right = total - 1;
        renderControls();
    }
    dirty();
}
const sampleAt = (k, t) => (t < 0 || t >= total || t < total - CAP ? null : rings[k][t % CAP]);

// ---- The strip -------------------------------------------------------------
//
// Live, the strip shows the rings, the newest tick at the right edge
// unless it has been scrolled back (`right`). Showing a timing report, it
// shows the report's waveforms instead. Either way a drag scrolls (live,
// it stops the capture first: what is being looked at should hold still),
// the wheel or − + zooms, a click sets the marker (A) — or takes it away —
// and hovering reads every row at that tick, and how far it is from the
// marker.
let showing = 'live';           // or 'report'
let scenario = null;            // the report's waveform shown
let pxPerTick = 4;
let right = null;               // the tick at the right edge; null: the newest
let marker = null, hover = null;
let collapsed = false;

const plotWidth = () => Math.max(40, scopeCanvas.clientWidth || 300);
const trace = () => (timing && timing.result && timing.result.traces || []).find((t) => t.id === scenario) || null;
// What the strip shows: rows of {name, color, at(t)}, the ticks there are,
// and where time 0 is (the trigger, a report's clock edge).
function shown() {
    if (showing === 'report') {
        const tr = trace();
        if (!tr) return { rows: [], first: 0, last: 0, zero: 0 };
        // A row in the colour of the probe on it — a pad's own probe
        // included — else the pads' grey.
        const colorOf = (ch) => {
            const p = probes.find((q) => q.x === ch.x && q.y === ch.y) || (ch.kind === 'probe' && probes.find((q) => q.name === ch.name));
            return p ? COLORS[p.c % COLORS.length] : ch.kind === 'probe' ? COLORS[0] : PAD_COLOR;
        };
        const rises = T.risesOf(tr.stim, timing.result.clock);
        return {
            rows: tr.channels.map((ch) => ({
                name: ch.name, color: colorOf(ch), kind: ch.kind,
                at: (t) => { const c = ch.data[t]; return c === undefined || c === '-' ? null : +c; },
            })),
            first: 0, last: tr.ticks - 1, zero: rises.length ? rises[0] : 0, rises,
        };
    }
    return {
        rows: probes.map((p, k) => ({ name: p.name, color: COLORS[p.c % COLORS.length], at: (t) => sampleAt(k, t) })),
        first: Math.max(0, total - CAP), last: total - 1, zero: trigAt !== null ? trigAt : 0,
    };
}

let frame = 0;
function dirty() {
    if (frame || scopeEl.hidden || collapsed) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
}

function draw() {
    const s = shown(), w = plotWidth(), h = s.rows.length * ROW_H + AXIS_H;
    const dpr = window.devicePixelRatio || 1;
    if (scopeCanvas.width !== Math.round(w * dpr) || scopeCanvas.height !== Math.round(h * dpr)) {
        scopeCanvas.width = Math.round(w * dpr);
        scopeCanvas.height = Math.round(h * dpr);
        scopeCanvas.style.height = h + 'px';
    }
    const ctx = scopeCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const r = right === null ? s.last : right;
    const x = (t) => w - (r - t + 1) * pxPerTick;
    const t0 = Math.max(s.first, Math.floor(r - w / pxPerTick));
    // A report's keep-out, shaded; its clock edges, dashed.
    // A report's keep-out, shaded round each rise of the clock; the rises,
    // dashed — wherever the clock's edges have been dragged to.
    if (showing === 'report' && trace()) {
        const keep = trace().keep;
        ctx.fillStyle = 'rgba(237, 161, 0, 0.18)';
        if (keep) for (const e of s.rises) ctx.fillRect(x(e + keep.from), 0, (keep.to - keep.from + 1) * pxPerTick, h - AXIS_H);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.setLineDash([3, 3]);
        for (const e of s.rises) { ctx.beginPath(); ctx.moveTo(x(e) + 0.5, 0); ctx.lineTo(x(e) + 0.5, h - AXIS_H); ctx.stroke(); }
        ctx.setLineDash([]);
    }
    s.rows.forEach((row, k) => {
        const top = k * ROW_H, hi = top + 3, lo = top + ROW_H - 4, mid = (hi + lo) / 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath(); ctx.moveTo(0, top + ROW_H - 0.5); ctx.lineTo(w, top + ROW_H - 0.5); ctx.stroke();
        ctx.strokeStyle = row.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let pen = false, py = 0;
        const drains = [];
        for (let t = t0; t <= r; t++) {
            const v = row.at(t);
            if (v === null || v < 0) { pen = false; continue; }
            const y = v === 1 ? hi : v === 2 ? mid : lo;
            if (v === 2) drains.push(t);
            if (!pen) { ctx.moveTo(x(t), y); pen = true; } else if (y !== py) ctx.lineTo(x(t), y);
            ctx.lineTo(x(t + 1), y);
            py = y;
        }
        ctx.stroke();
        // Draining, a tick at a time: marked in red, as on the board.
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 3;
        for (const t of drains) { ctx.beginPath(); ctx.moveTo(x(t), mid); ctx.lineTo(x(t + 1), mid); ctx.stroke(); }
        ctx.lineWidth = 1;
    });
    // An input's edges, in a report, are handles to drag.
    if (showing === 'report' && trace()) {
        const tr = trace();
        s.rows.forEach((row, k) => {
            if (row.kind !== 'in') return;
            for (const ev of tr.stim.events) {
                if (ev.name !== row.name || ev.t < t0 || ev.t > r) continue;
                const big = held ? held.ev === ev : grip && grip.ev === ev;
                ctx.fillStyle = row.color;
                ctx.strokeStyle = '#101010';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x(ev.t), k * ROW_H + ROW_H / 2, big ? 5 : 3.5, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
            }
        });
        ctx.lineWidth = 1;
    }
    // The time axis: ticks from time 0, every so many.
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((d) => d * pxPerTick >= 40) || 1000;
    ctx.fillStyle = '#7d8288';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let t = Math.ceil((t0 - s.zero) / step) * step + s.zero; t <= r; t += step) {
        if (x(t) < 8 || x(t) > w - 8) continue;
        ctx.fillRect(x(t), h - AXIS_H, 1, 3);
        ctx.fillText(String(t - s.zero), x(t), h - AXIS_H + 3);
    }
    const vline = (t, color, label) => {
        if (t === null || t < t0 || t > r) return;
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(x(t) + 0.5, 0); ctx.lineTo(x(t) + 0.5, h - AXIS_H); ctx.stroke();
        if (label) { ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(label, x(t) + 3, 1); ctx.textAlign = 'center'; }
    };
    if (showing === 'live') vline(trigAt, '#ffd166', 'T');
    vline(marker, '#7dffb3', 'A');
    vline(hover, 'rgba(255, 255, 255, 0.5)', null);
    renderRead(s);
}

// The readout: at the hovered tick, every row's reading, and the time
// from the marker.
function renderRead(s) {
    const tr = showing === 'report' && trace();
    const rest = tr ? (tr.rests ? ' · it comes to rest' : ' · it never comes to rest') : '';
    const h = held || grip;
    if (tr && h) {
        // An edge, from the nearest rise of the clock.
        const near = s.rises.reduce((b, e) => (b === null || Math.abs(h.ev.t - e) < Math.abs(h.ev.t - b) ? e : b), null);
        const d = near === null ? null : h.ev.t - near;
        const when = d === null ? `at ${h.ev.t}` : d === 0 ? 'as the clock rises' : `${Math.abs(d)} ticks ${d < 0 ? 'before' : 'after'} the clock rises`;
        scopeReadEl.textContent = `${h.ev.name} ${h.ev.v ? 'rises' : 'falls'} ${when}${rest}`;
        return;
    }
    if (hover === null) {
        scopeReadEl.textContent = showing === 'live'
            ? (capturing ? (armed ? 'Waiting for the trigger…' : `${total} ticks`) : 'Stopped — drag to look back, click to mark')
            : `Drag an input’s edge to move it${rest}`;
        return;
    }
    const vals = s.rows.map((row) => { const v = row.at(hover); return `${row.name} ${v === null || v < 0 ? '–' : v === 2 ? '↓' : v}`; });
    const dt = marker === null ? '' : ` · from A ${hover - marker >= 0 ? '+' : ''}${hover - marker}`;
    scopeReadEl.textContent = `t ${hover - s.zero}${dt} · ${vals.join(' · ')}`;
}

function renderNames() {
    scopeNamesEl.innerHTML = '';
    const s = shown();
    // The strip's height is known now, not only once it is drawn: the
    // board is framed above it (a canvas not yet drawn is 150px tall).
    scopeCanvas.style.height = (s.rows.length * ROW_H + AXIS_H) + 'px';
    s.rows.forEach((row, k) => {
        const el = document.createElement('div');
        el.className = 'scope-name';
        el.style.setProperty('--probe', row.color);
        const label = document.createElement('button');
        label.className = 'scope-label';
        label.textContent = row.name;
        el.append(label);
        if (showing === 'live') {
            label.title = 'Rename';
            label.addEventListener('click', () => startRename(el, k));
            const x = document.createElement('button');
            x.className = 'scope-remove';
            x.title = 'Take this probe off';
            x.setAttribute('aria-label', `Take probe ${row.name} off`);
            x.textContent = '×';
            x.addEventListener('click', () => removeProbe(k));
            el.append(x);
        } else label.disabled = true;
        scopeNamesEl.append(el);
    });
    const axis = document.createElement('div');
    axis.className = 'scope-axis-name';
    axis.textContent = showing === 'report' ? 'ticks from the edge' : trigAt !== null ? 'ticks from T' : 'ticks';
    scopeNamesEl.append(axis);
}
function startRename(el, k) {
    const input = document.createElement('input');
    input.className = 'scope-rename';
    input.value = probes[k].name;
    input.maxLength = 12;
    el.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => { if (done) return; done = true; if (!(keep && renameProbe(k, input.value))) renderNames(); };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
}

function renderTriggerChoices() {
    const was = trigger.probe;
    scopeTrigProbeEl.innerHTML = '';
    const none = document.createElement('option');
    none.value = '-1';
    none.textContent = '—';
    scopeTrigProbeEl.append(none);
    probes.forEach((p, k) => { const o = document.createElement('option'); o.value = String(k); o.textContent = p.name; scopeTrigProbeEl.append(o); });
    scopeTrigProbeEl.value = String(was);
}
function renderControls() {
    const report = showing === 'report';
    scopeTitleEl.textContent = report ? 'Timing' : 'Scope';
    scopeLiveCtl.hidden = report;
    scopeReportCtl.hidden = !report;
    scopeSummaryEl.hidden = !report;
    scopeRunBtn.textContent = capturing && !armed ? 'Stop' : 'Run';
    scopeRunBtn.setAttribute('aria-pressed', String(capturing && !armed));
    scopeSingleBtn.setAttribute('aria-pressed', String(armed));
    scopeSingleBtn.disabled = trigger.probe < 0;
    scopePadsBtn.hidden = !gameLevel;
    const clocked = !!(gameLevel && gameLevel.clock);
    scopeTimingBtn.hidden = !clocked || report;
    scopeTimingBtn.disabled = !!(timing && timing.pending);
    scopeTimingBtn.textContent = timing && timing.pending ? 'Timing…' : 'Timing';
    if (report && timing && timing.result) {
        scopeSummaryEl.textContent = T.summary(timing.result);
        scopeScenariosEl.innerHTML = '';
        for (const tr of timing.result.traces) {
            const b = document.createElement('button');
            b.className = 'tool-btn';
            b.dataset.scenario = tr.id;
            b.textContent = tr.title;
            b.setAttribute('aria-pressed', String(tr.id === scenario));
            b.addEventListener('click', () => showScenario(tr.id));
            scopeScenariosEl.append(b);
        }
    }
    scopeResetBtn.hidden = !(report && trace() && trace().moved);
    scopeCollapseBtn.innerHTML = collapsed ? '&#x25B4;' : '&#x25BE;';
    scopeCollapseBtn.title = collapsed ? 'Show the scope' : 'Minimize the scope';
}
// Shown while there are probes, or a report; the board re-framed above it.
function syncShown() {
    const want = probes.length > 0 || showing === 'report';
    if (scopeEl.hidden === want) reframeAfter(() => { scopeEl.hidden = !want; });
    scopeEl.classList.toggle('collapsed', collapsed);
    renderControls();
}
// The scope's height, for the view inset (0 when it is hidden).
const scopeHeight = () => (scopeEl.hidden ? 0 : scopeEl.offsetHeight);

// ---- Timing ------------------------------------------------------------------
//
// {level, rev, pending, result}: the last report asked for, and the board
// it was asked of (its rev). An edit makes it stale (forgetTiming).
let timing = null;
function startTiming(level, open) {
    if (!level || !level.clock) return;
    const rev = M.activeBoard().rev;
    if (timing && timing.level === level && timing.rev === rev && (timing.pending || timing.result)) {
        if (open && timing.result) openReport();
        if (open && timing.pending) timing.open = true;
        return;
    }
    const mine = { level, rev, pending: true, result: null, open: !!open };
    timing = mine;
    renderControls();
    renderStatus();
    T.measureOff(level, probes.map(({ x, y, name }) => ({ x, y, name }))).then((r) => {
        if (timing !== mine) return;
        mine.pending = false;
        mine.result = r;
        renderControls();
        renderStatus();
        if (mine.open && !r.error) openReport();
        else if (mine.open) flashStatus(r.error);
    }, () => { if (timing === mine) { timing = null; renderControls(); renderStatus(); } });
}
function forgetTiming() {
    if (!timing) return;
    timing = null;
    if (showing === 'report') showLive();
    renderControls();
}
// What a clocked level's status line offers: the report, or that it is
// being measured. Empty for any other level.
function timingButton(level) {
    if (!level || !level.clock || !timing || timing.level !== level) return '';
    if (timing.pending) return '<button class="tool-btn" data-act="timing" disabled>Timing…</button>';
    if (!timing.result || timing.result.error) return '';
    return `<button class="tool-btn" data-act="timing" title="${T.summary(timing.result).replace(/"/g, '&quot;')}">Timing</button>`;
}
function openReport() {
    if (!timing || !timing.result || timing.result.error) return;
    showing = 'report';
    collapsed = false;
    showScenario(scenario && timing.result.traces.some((t) => t.id === scenario) ? scenario : (timing.result.traces[0] || {}).id || null);
    syncShown();
}
function showScenario(id) {
    scenario = id;
    const tr = trace();
    if (tr && !tr.measured) { tr.measured = tr.stim.events.map((e) => ({ ...e })); tr.measuredTicks = tr.stim.ticks; }
    // The whole waveform across the strip to start with.
    if (tr) fit();
    marker = null;
    hover = null;
    renderNames();
    renderControls();
    dirty();
}
function showLive() {
    showing = 'live';
    right = null;
    pxPerTick = 4;
    marker = null;
    renderNames();
    syncShown();
    dirty();
}

// ---- Gestures on the strip ------------------------------------------------
function tickAtX(px) {
    const s = shown(), r = right === null ? s.last : right;
    return Math.floor(r + 1 - (plotWidth() - px) / pxPerTick);
}
function clampRight(r) {
    const s = shown();
    return Math.max(Math.min(s.first + Math.floor(plotWidth() / pxPerTick), s.last), Math.min(s.last, r));
}
// The whole of it across the strip: a report's waveform, or all that has
// been captured (live, following on if it is running).
function fit() {
    const s = shown(), n = Math.max(1, s.last - s.first + 1);
    pxPerTick = Math.max(MIN_PPT, Math.min(MAX_PPT, plotWidth() / n));
    right = showing === 'live' && capturing ? null : s.last;
    dirty();
}
// Scrolled by dx screen pixels: later in time for positive. Looking back
// over a live capture stops it, as dragging does.
function pan(dx) {
    const s = shown();
    if (showing === 'live' && capturing && dx < 0) { capturing = false; armed = false; renderControls(); }
    if (showing === 'live' && capturing) return;
    right = clampRight(Math.round((right === null ? s.last : right) + dx / pxPerTick));
    dirty();
}

// ---- Moving an input's edge -------------------------------------------------
//
// In a report, an input row's edges are handles: one held (`held`) moves
// with the pointer, kept between that input's edges either side of it,
// and the stimulus is played again — at most once a frame — with it there.
// Dragged past either end, the waveform grows to take it: before, more
// quiet ticks (every stimulus starts from a board at rest, so they change
// nothing), every edge later by as many; after, more ticks to watch.
// `grip` is the handle under the pointer, for the cursor and the readout.
let held = null, grip = null, replaying = 0;
function handleAt(px, py) {
    if (showing !== 'report' || !trace()) return null;
    const s = shown(), row = s.rows[Math.floor(py / ROW_H)];
    if (!row || row.kind !== 'in') return null;
    const r = right === null ? s.last : right, x = (t) => plotWidth() - (r - t + 1) * pxPerTick;
    let best = null;
    for (const ev of trace().stim.events) {
        if (ev.name !== row.name) continue;
        const d = Math.abs(x(ev.t) - px);
        if (d <= 7 && (!best || d < best.d)) best = { ev, d };
    }
    return best && { ev: best.ev };
}
function moveHeld(px) {
    const tr = trace(), ev = held.ev;
    const mine = tr.stim.events.filter((e) => e.name === ev.name).sort((a, z) => a.t - z.t), k = mine.indexOf(ev);
    const lo = k > 0 ? mine[k - 1].t + 1 : -Infinity, hi = k < mine.length - 1 ? mine[k + 1].t - 1 : Infinity;
    let t = Math.max(lo, Math.min(hi, tickAtX(px)));
    if (t === ev.t) return;
    if (t < 0) {
        // Room before: everything later by as much, the view with it.
        const by = -t;
        for (const e of tr.stim.events) e.t += by;
        tr.stim.ticks += by;
        tr.ticks = tr.stim.ticks;
        if (right !== null) right += by;
        t = 0;
    }
    if (t > tr.stim.ticks - 20) { tr.stim.ticks = t + 20; tr.ticks = tr.stim.ticks; }
    ev.t = t;
    tr.moved = true;
    replay();
}
function replay() {
    if (replaying) return;
    replaying = requestAnimationFrame(() => {
        replaying = 0;
        const tr = trace();
        if (!tr) return;
        const res = T.play(tr.stim, tr.channels.map(({ name, kind, x, y }) => ({ name, kind, x, y })));
        if (!res) return;
        tr.channels = res.channels;
        tr.rests = res.rests;
        renderControls();
        dirty();
    });
}
function resetMoves() {
    const tr = trace();
    if (!tr || !tr.measured) return;
    tr.stim.events = tr.measured.map((e) => ({ ...e }));
    tr.stim.ticks = tr.ticks = tr.measuredTicks;
    tr.moved = false;
    held = grip = null;
    fit();
    replay();
}

function zoom(f, px) {
    const s = shown(), r = right === null ? s.last : right;
    const anchor = px === undefined ? r : tickAtX(px);
    const was = pxPerTick;
    pxPerTick = Math.max(MIN_PPT, Math.min(MAX_PPT, pxPerTick * f));
    if (pxPerTick === was) return;
    // The tick under the pointer stays under it.
    const fromRight = (r - anchor + 1) * was / pxPerTick;
    if (right !== null || px !== undefined) right = clampRight(Math.round(anchor - 1 + fromRight));
    if (showing === 'live' && capturing && right !== null && right >= total - 1) right = null;
    dirty();
}

function setupScope() {
    scopeEl.hidden = true;
    M.watchTicks(onTick);
    scopeCollapseBtn.addEventListener('click', () => {
        reframeAfter(() => { collapsed = !collapsed; scopeEl.classList.toggle('collapsed', collapsed); });
        renderControls();
        dirty();
    });
    scopeRunBtn.addEventListener('click', () => {
        if (capturing && !armed) { capturing = false; right = total - 1; }
        else { capturing = true; armed = false; right = null; }
        renderControls();
        dirty();
    });
    scopeSingleBtn.addEventListener('click', () => {
        if (trigger.probe < 0) return;
        armed = true;
        capturing = true;
        trigAt = null;
        stopAt = null;
        right = null;
        renderNames();
        renderControls();
        dirty();
    });
    scopeClearBtn.addEventListener('click', () => { resetCapture(); renderNames(); renderControls(); });
    scopePadsBtn.addEventListener('click', probePads);
    scopeTimingBtn.addEventListener('click', () => startTiming(gameLevel, true));
    scopeLiveBtn.addEventListener('click', showLive);
    scopeTrigProbeEl.addEventListener('change', () => { trigger.probe = Number(scopeTrigProbeEl.value); renderControls(); });
    scopeTrigEdgeEl.addEventListener('change', () => { trigger.edge = scopeTrigEdgeEl.value; });
    scopeZoomInBtn.addEventListener('click', () => zoom(1.5));
    scopeZoomOutBtn.addEventListener('click', () => zoom(1 / 1.5));
    scopeFitBtn.addEventListener('click', fit);
    scopeResetBtn.addEventListener('click', resetMoves);

    // A press on an input's edge (in a report) moves it; anywhere else a
    // drag scrolls and a click sets the marker.
    let drag = null;
    scopeCanvas.addEventListener('pointerdown', (e) => {
        scopeCanvas.setPointerCapture(e.pointerId);
        const h = handleAt(e.offsetX, e.offsetY);
        if (h) { held = h; dirty(); return; }
        const s = shown();
        drag = { x: e.offsetX, right: right === null ? s.last : right, moved: false };
    });
    scopeCanvas.addEventListener('pointermove', (e) => {
        hover = tickAtX(e.offsetX);
        if (held) { moveHeld(e.offsetX); dirty(); return; }
        grip = drag ? null : handleAt(e.offsetX, e.offsetY);
        scopeCanvas.style.cursor = grip ? 'ew-resize' : '';
        if (drag && (drag.moved || Math.abs(e.offsetX - drag.x) > 3)) {
            if (!drag.moved && showing === 'live' && capturing) { capturing = false; armed = false; renderControls(); }
            drag.moved = true;
            right = clampRight(Math.round(drag.right - (e.offsetX - drag.x) / pxPerTick));
        }
        dirty();
    });
    scopeCanvas.addEventListener('pointerup', (e) => {
        // Let go, the readout stays on the edge moved till the pointer does.
        if (held) { grip = held; held = null; dirty(); return; }
        if (drag && !drag.moved) {
            const t = tickAtX(e.offsetX);
            marker = marker !== null && Math.abs(t - marker) * pxPerTick < 6 ? null : t;
        }
        drag = null;
        dirty();
    });
    scopeCanvas.addEventListener('pointerleave', () => { hover = null; if (!held) grip = null; dirty(); });
    // Scroll pans, as on the board: sideways along time (or Shift with an
    // up-and-down wheel), up and down the rows — the page's own scrolling.
    // Ctrl/⌘ with it zooms, about the pointer; a pinch on a trackpad comes
    // as just that.
    scopeCanvas.addEventListener('wheel', (e) => {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? plotWidth() : 1;
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoom(Math.exp(-e.deltaY * unit * 0.01), e.offsetX);
            return;
        }
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        if (Math.abs(dx) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
            e.preventDefault();
            pan(dx * unit);
        }
    }, { passive: false });
    window.addEventListener('resize', dirty);
    // Whatever changes the strip's height — rows, the summary wrapping, a
    // narrower window — the board is framed again above it.
    if (typeof ResizeObserver !== 'undefined') {
        let was = -1;
        new ResizeObserver(() => {
            const h = scopeHeight();
            if (h !== was) { was = h; reframeAfter(() => {}); }
            dirty();
        }).observe(scopeEl);
    }
    renderControls();
}

// For the e2e tests: what the scope has and shows.
function scopeState() {
    return {
        probes: probes.map(({ x, y, name, c }) => ({ x, y, name, color: COLORS[c % COLORS.length] })),
        total, capturing, armed, trigAt, showing, scenario, marker, hidden: scopeEl.hidden, collapsed, pxPerTick, right,
        report: showing === 'report' && trace() ? {
            ticks: trace().ticks, rests: trace().rests, moved: !!trace().moved, events: trace().stim.events.map((e) => ({ ...e })),
            channels: trace().channels.map((c) => ({ name: c.name, kind: c.kind, data: c.data })), rises: shown().rises,
        } : null,
        latest: probes.map((p, k) => sampleAt(k, total - 1)),
        timing: timing && { pending: !!timing.pending, summary: timing.result ? T.summary(timing.result) : null, result: timing.result },
    };
}

export {
    loadProbes, shiftProbes, toggleProbeAt, probeAt, addProbe, removeProbe, renameProbe, probePads, scopeHeight,
    setupScope, startTiming, forgetTiming, timingButton, openReport, scopeState,
};
