(function (window) {
    const M = window.PixelogicModel;
    const V = window.PixelogicView;
    const G = window.PixelogicGame;

    // The active campaign level, or null in the sandbox. Almost everything
    // about the editor is unchanged inside a level; what differs is where the
    // circuit is saved, that the board is a fixed size with locked I/O pads,
    // and that there is something to verify against.
    let gameLevel = null;
    let gameProgress = G.loadProgress();

    // drawMode is a material ('conductor', 'insulator' — Erase — 'gray' —
    // MUX — 'pos', 'neg', 'led', 'toggle', 'switch'), 'part' (Parts: puts
    // down a whole part from the shelf) or a mode ('interact', 'select',
    // 'rearrange', 'paste'). The paint tools are the materials a stroke lays
    // cell by cell; MUX and Parts are not among them, since each places a
    // whole thing per click.
    const PAINT_TOOLS = ['conductor', 'insulator', 'pos', 'neg', 'led', 'toggle', 'switch'];
    const MATERIALS = PAINT_TOOLS.concat(['gray']);
    // A level may allow only some materials (`tools` in game.js); the rest
    // are disabled while it is open. Modes (Select, Rearrange...) are never
    // restricted.
    const toolAllowed = (tool) => !gameLevel || !gameLevel.tools
        || !MATERIALS.includes(tool) || gameLevel.tools.includes(tool);
    // How far (in screen px) a press-and-hold in Interact must move before
    // it's read as "pan the view" instead of "hold this switch/toggle".
    const INTERACT_PAN_THRESHOLD = 8;
    let drawMode = 'conductor';
    let painting = false;
    let strokeColor = null; // color for the in-progress paint stroke (right-drag = insulator)
    let selecting = false;
    let selectStart = null;
    let pressedSwitch = null; // {x,y} of a momentary switch held down in Interact mode
    let interactPending = null; // {x,y,sx,sy,wasSwitch,wasToggle,panning} - see beginStroke's interact branch
    let selection = null;   // {x0,y0,x1,y1} normalized, or null
    let clipboard = null;   // {w,h,data:Uint8Array} or null
    // A pasted clip floats (draggable, not yet a permanent edit) from the
    // moment Paste is selected until it's committed - see enterPasteFloat.
    let floatBase = null;   // structural snapshot from just before the float started, or null when not floating
    let floatPos = null;    // {x,y} - the floating clip's current top-left
    let floatDragging = false;
    let floatDragStart = null; // {cellX,cellY,origX,origY}
    // Rearrange tool: `arrangeSel` is the selected object list (a
    // multi-select drags them as one rigid piece), `arrange` the in-progress
    // grab/drag, `band` an in-progress rubber-band selection.
    let arrange = null;         // {objs,base,grabX,grabY,dx,dy,rot,last,cur,unrouted,moved}
    let arrangeSel = [];        // [{cells:[[x,y],...]}]
    let band = null;            // {x0,y0,x1,y1} while rubber-band selecting
    let longPressTimer = null;  // touch: hold to add/remove one object
    const LONG_PRESS_MS = 450;
    let lastHoveredCell = null;
    // The part the Parts tool puts down: {key, name, clip, pins}, the clip
    // turned and flipped however R and M have left it.
    let placingPart = null;
    let running = false;
    // Exponential so the slider gives fine control at the slow end and still
    // reaches a genuinely fast rate at the top (was capped at 20 steps/s).
    // The default is fast enough that a circuit visibly *runs* on first
    // contact rather than creeping; the slider is there to slow it down when
    // you want to watch a signal propagate.
    const MIN_TPS = 1, MAX_TPS = 200, DEFAULT_TPS = 60;
    let tickIntervalMs = 1000 / DEFAULT_TPS;
    let lastTick = 0;
    let panning = false;
    let lastPanPos = null;

    const playPauseBtn = document.getElementById('playPauseBtn');
    const zoomValueEl = document.getElementById('zoomValue');
    const intervalSlider = document.getElementById('intervalSlider');
    const intervalValueEl = document.getElementById('intervalValue');
    const statusEl = document.getElementById('saveStatus');
    const pasteBtn = document.getElementById('pasteBtn');
    const copyBtn = document.getElementById('copyBtn');
    const cutBtn = document.getElementById('cutBtn');
    const rotateBtn = document.getElementById('rotateBtn');
    const mirrorBtn = document.getElementById('mirrorBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    const saveComponentBtn = document.getElementById('saveComponentBtn');
    const componentsBtn = document.getElementById('componentsBtn');
    const componentsPanel = document.getElementById('componentsPanel');
    const componentsBackdrop = document.getElementById('componentsBackdrop');
    const componentsCloseBtn = document.getElementById('componentsCloseBtn');
    const componentsListEl = document.getElementById('componentsList');
    const componentsEmptyEl = document.getElementById('componentsEmpty');
    const lidBtn = document.getElementById('lidBtn');
    const decapBtn = document.getElementById('decapBtn');
    const makePartPanel = document.getElementById('makePartPanel');
    const makePartBackdrop = document.getElementById('makePartBackdrop');
    const makePartNameEl = document.getElementById('makePartName');
    const makePartPinsEl = document.getElementById('makePartPins');
    const makePartErrorEl = document.getElementById('makePartError');
    const selectionActionsEl = document.getElementById('selectionActions');
    const menuBtn = document.getElementById('menuBtn');
    const menuPanel = document.getElementById('menuPanel');
    const menuBackdrop = document.getElementById('menuBackdrop');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const gridToggleBtn = document.getElementById('gridToggleBtn');
    const pinLabelsBtn = document.getElementById('pinLabelsBtn');
    const straightBtn = document.getElementById('straightBtn');
    const campaignBtn = document.getElementById('campaignBtn');
    const levelsPanel = document.getElementById('levelsPanel');
    const levelsBackdrop = document.getElementById('levelsBackdrop');
    const levelsCloseBtn = document.getElementById('levelsCloseBtn');
    const levelsListEl = document.getElementById('levelsList');
    const sandboxBtn = document.getElementById('sandboxBtn');
    const resetProgressBtn = document.getElementById('resetProgressBtn');
    const levelBar = document.getElementById('levelBar');
    const levelTitleEl = document.getElementById('levelTitle');
    const levelBriefEl = document.getElementById('levelBrief');
    const levelHintEl = document.getElementById('levelHint');
    const levelStatusEl = document.getElementById('levelStatus');
    const levelTableEl = document.getElementById('levelTable');
    const levelTableBodyEl = document.getElementById('levelTableBody');
    const hintBtn = document.getElementById('hintBtn');
    const verifyBtn = document.getElementById('verifyBtn');
    const levelsBtn = document.getElementById('levelsBtn');
    const levelCollapseBtn = document.getElementById('levelCollapseBtn');
    const sandboxToggleBtn = document.getElementById('sandboxToggleBtn');

    const LEVEL_BAR_KEY = 'pixelogic-pcb.levelBar.v1';
    let levelBarCollapsed = false;
    try { levelBarCollapsed = JSON.parse(localStorage.getItem(LEVEL_BAR_KEY) || 'false') === true; } catch (e) { }

    // Grid-line visibility remembers separate on/off preferences for build
    // tools vs. Interact (the anticipated default: on while drawing, off
    // while interacting), rather than one flag shared across both.
    let gridVisibleBuild = true, gridVisibleInteract = false;

    // ---- Compact export encoding (gzip + base64) ----
    async function gzipToBase64(str) {
        const cs = new CompressionStream('gzip');
        const w = cs.writable.getWriter();
        w.write(new TextEncoder().encode(str)); w.close();
        const bytes = new Uint8Array(await new Response(cs.readable).arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    async function base64ToGunzip(b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const ds = new DecompressionStream('gzip');
        const w = ds.writable.getWriter();
        w.write(bytes); w.close();
        return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
    }

    const CIRCUIT_KEY = 'pixelogic-pcb-circuit';
    const VIEW_KEY = 'pixelogic-pcb.view.v1';
    const COMPONENTS_KEY = 'pixelogic-pcb.components.v1';
    const GRID_VISIBLE_KEY = 'pixelogic-pcb.gridVisible.v1';

    function loadGridVisiblePrefs() {
        try {
            const raw = JSON.parse(localStorage.getItem(GRID_VISIBLE_KEY) || 'null');
            if (raw && typeof raw.build === 'boolean' && typeof raw.interact === 'boolean') {
                gridVisibleBuild = raw.build;
                gridVisibleInteract = raw.interact;
            }
        } catch (e) { }
    }
    function saveGridVisiblePrefs() {
        try { localStorage.setItem(GRID_VISIBLE_KEY, JSON.stringify({ build: gridVisibleBuild, interact: gridVisibleInteract })); } catch (e) { }
    }
    // Applies (and reflects in the toggle button) whichever preference
    // matches the given tool mode - called on every tool switch so entering
    // Interact / leaving it always shows the right grid state.
    //
    // A campaign level overrides all of it and keeps the grid on. The boards
    // there are small, deliberately tight, and read as graph paper you are
    // solving a puzzle on; every cell counts, and counting them is easier with
    // the lines drawn. The toggle is disabled rather than silently ignored.
    function applyGridVisibleForMode(mode) {
        const visible = gameLevel ? true : (mode === 'interact' ? gridVisibleInteract : gridVisibleBuild);
        V.setGridVisible(visible);
        gridToggleBtn.setAttribute('aria-pressed', String(visible));
        gridToggleBtn.disabled = !!gameLevel;
        gridToggleBtn.title = gameLevel
            ? 'Always on while you are solving a level'
            : 'Remembered separately for build vs. Interact';
    }

    // ---- Pin labels ----
    // SEL/COM/NO/NC printed on every mux. They teach the part, and on a
    // board full of muxes they are clutter, so by default ('auto') they are
    // on only in a level that asks for them — the mux tutorial — and off
    // everywhere else. The menu item switches them on or off for good.
    const PIN_LABELS_KEY = 'pixelogic-pcb.pinLabels.v1';
    let pinLabelsPref = 'auto';   // 'auto' | 'on' | 'off'
    try {
        const v = localStorage.getItem(PIN_LABELS_KEY);
        if (v === 'on' || v === 'off') pinLabelsPref = v;
    } catch (e) { }
    const pinLabelsShown = () => pinLabelsPref === 'on'
        || (pinLabelsPref === 'auto' && !!(gameLevel && gameLevel.pinLabels));
    function applyPinLabels() {
        const on = pinLabelsShown();
        V.setPinLabels(on);
        pinLabelsBtn.setAttribute('aria-pressed', String(on));
    }

    // ---- Autosave (debounced) ----
    // Every edit schedules a save, so the circuit survives reloads without a
    // manual Save button; Export/Import remain for sharing between browsers.
    let saveTimer = null;
    // The sandbox circuit and each level's attempt are stored separately, so
    // switching between them never overwrites the other. Writes go wherever
    // the board currently belongs.
    function persistCircuit() {
        if (gameLevel) G.saveCircuit(gameLevel.id, M.serialize());
        else { try { localStorage.setItem(CIRCUIT_KEY, M.serialize()); } catch (e) { } }
    }
    // Every structural edit comes through here, so it is also where the
    // level's status line hears that the board changed (see boardChanged).
    // `quiet` saves without that: lifting a part's lid changes how the
    // board looks, not what it is, and must not retire a verdict.
    function scheduleSave(quiet) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { persistCircuit(); saveTimer = null; }, 300);
        if (!quiet) boardChanged();
    }
    // Anything that swaps the board out has to land the pending write first,
    // or a debounced save fires after the swap and writes the new board into
    // the old board's slot.
    function flushSave() {
        if (!saveTimer) return;
        clearTimeout(saveTimer);
        saveTimer = null;
        persistCircuit();
    }

    // ---- View (zoom/pan) persistence ----
    let viewSaveTimer = null;
    function scheduleViewSave() {
        if (viewSaveTimer) clearTimeout(viewSaveTimer);
        viewSaveTimer = setTimeout(() => {
            try { localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: V.zoom, panX: V.panX, panY: V.panY })); } catch (e) { }
            viewSaveTimer = null;
        }, 300);
    }
    function loadView() {
        try {
            const raw = localStorage.getItem(VIEW_KEY);
            if (!raw) return false;
            const v = JSON.parse(raw);
            if (typeof v.zoom !== 'number' || typeof v.panX !== 'number' || typeof v.panY !== 'number') return false;
            V.setZoom(v.zoom);
            V.pan(v.panX - V.panX, v.panY - V.panY);
            return true;
        } catch (e) { return false; }
    }

    // ---- Undo / redo ----
    // Snapshots hold only circuit structure (charge stripped), so running
    // the simulation between edits never adds undo steps. A "batch" groups
    // one continuous gesture (a whole drag-paint stroke, one paste, one
    // delete) into a single step: the pre-edit snapshot is pushed when the
    // batch first opens and the batch closes at the gesture's end.
    const undoStack = [];
    const redoStack = [];
    const UNDO_LIMIT = 100;
    let undoBatchOpen = false;

    // How many columns/rows the grid has grown off its left and top edges
    // since the app started. Cell coordinates shift by this whenever
    // expandForBorder() adds space, so it's what lets an undo tell "the grid
    // moved under the drawing" apart from "the user panned".
    const gridOrigin = { x: 0, y: 0 };

    // Each entry snapshots the circuit and that origin — NOT the pan or zoom.
    // Undo used to restore the pan outright, which meant any panning or
    // zooming you did after an edit was thrown away the moment you undid it:
    // the view jumped, which is jarring and never what undo was asked to do.
    // Recording the origin instead is enough to keep the drawing visually
    // still across an undo that shrinks the grid, while leaving the view
    // exactly where you put it.
    function snapshotEntry() {
        return { snap: M.getStructuralSnapshot(), originX: gridOrigin.x, originY: gridOrigin.y };
    }
    function beginUndoBatch() {
        if (undoBatchOpen) return;
        undoBatchOpen = true;
        undoStack.push(snapshotEntry());
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
        updateActionButtons();
    }
    function endUndoBatch() { undoBatchOpen = false; }

    function restoreEntry(e) {
        M.restoreStructuralSnapshot(e.snap);
        // Restoring a differently-sized grid re-lays the cells at the
        // snapshot's coordinates, so shift the pan by exactly the difference
        // in origin — the drawing stays put on screen and the zoom, and any
        // panning done since, are left alone.
        const cs = M.CELL_SIZE * V.zoom;
        const dx = (gridOrigin.x - e.originX) * cs, dy = (gridOrigin.y - e.originY) * cs;
        if (dx || dy) V.pan(dx, dy);
        gridOrigin.x = e.originX;
        gridOrigin.y = e.originY;
    }
    // Mid-gesture, undo means "not that": roll back the drag or the floating
    // paste in progress, and stop there. Popping history out from under one
    // used to leave the gesture still editing the board with no undo step of
    // its own — and a drag that then ended where it began popped someone
    // else's step off the stack as its "no-op".
    function cancelGesture() {
        if (arrange) { abortArrange(); return true; }
        if (floatBase) { cancelPasteFloat(); return true; }
        return false;
    }
    function undo() {
        if (cancelGesture()) return;
        if (!undoStack.length) return;
        redoStack.push(snapshotEntry());
        restoreEntry(undoStack.pop());
        endUndoBatch();
        setArrangeSel([]); // the highlighted objects may not be there anymore
        afterEdit();
    }
    function redo() {
        if (cancelGesture()) return;
        if (!redoStack.length) return;
        undoStack.push(snapshotEntry());
        restoreEntry(redoStack.pop());
        endUndoBatch();
        setArrangeSel([]);
        afterEdit();
    }

    function afterEdit() {
        updateActionButtons();
        refreshStampPreview();
        V.drawGrid();
        scheduleSave();
    }

    function updateActionButtons() {
        copyBtn.disabled = !selection;
        cutBtn.disabled = !selection;
        // In Rearrange, Rotate acts on the grabbed object, not the region
        // selection (which has no highlight in that mode anyway).
        rotateBtn.disabled = drawMode === 'rearrange' ? !arrangeSel.length : !selection;
        mirrorBtn.disabled = !selection;
        pasteBtn.disabled = !clipboard;
        // Make part… works on the region you can see, in a level or not.
        saveComponentBtn.disabled = !(drawMode === 'select' && selection);
        const part = selectedPart();
        lidBtn.style.display = part ? '' : 'none';
        decapBtn.style.display = part ? '' : 'none';
        if (part) {
            const info = M.blockInfo(part);
            lidBtn.textContent = info && info.open ? 'Close lid' : 'Open lid';
        }
        undoBtn.disabled = !undoStack.length;
        redoBtn.disabled = !redoStack.length;

        // The selection actions live on a bar that floats over the canvas
        // only while there is something for them to act on, rather than
        // sitting permanently greyed out in the chrome. The condition mirrors
        // what the canvas itself highlights (see setDrawMode), so the buttons
        // appear exactly when their target is visible. Make part… rides along
        // with them, since it acts on the selection too, and a part picked
        // out with Rearrange gets its lid and Decap here — the touchscreen's
        // way to them.
        const hasTarget = (drawMode === 'select' && !!selection)
            || (drawMode === 'paste' && !!floatBase)
            || (drawMode === 'rearrange' && arrangeSel.length > 0);
        selectionActionsEl.classList.toggle('open', hasTarget);
        // The keyboard's Delete, for a touchscreen — which had no way at all
        // to delete a Rearrange selection or to take back a paste.
        deleteBtn.disabled = !hasTarget;
        deleteBtn.textContent = drawMode === 'paste' ? 'Discard' : 'Delete';
    }

    // ---- Selection / clipboard ----
    function setSelection(sel) {
        selection = sel;
        V.setSelection((drawMode === 'select' || drawMode === 'paste') ? selection : null);
        updateActionButtons();
    }

    function doCopy() {
        if (!selection) return;
        clipboard = M.copyRegion(selection.x0, selection.y0, selection.x1, selection.y1);
        updateActionButtons();
        flashStatus('Copied');
    }
    function deleteSelectionCells() {
        if (!selection) return;
        beginUndoBatch();
        M.clearRegion(selection.x0, selection.y0, selection.x1, selection.y1);
        endUndoBatch();
        afterEdit();
    }
    // Deletes whatever the current tool shows as selected: the region in
    // Select, the picked objects in Rearrange, the floating clip in Paste
    // (which is simply discarded). Returns false when nothing is.
    //
    // A region left over from Select is deliberately NOT deleted from any
    // other tool. Its highlight is hidden there, and Delete used to erase it
    // anyway — while in Rearrange, with objects plainly selected, it offered
    // to clear the whole grid instead.
    function deleteSelected() {
        if (drawMode === 'paste' && floatBase) { cancelPasteFloat(); return true; }
        if (drawMode === 'rearrange' && arrangeSel.length) {
            if (arrange) abortArrange();
            const flat = [];
            for (const o of arrangeSel) for (const c of o.cells) flat.push(c);
            beginUndoBatch();
            M.clearCells(flat);
            endUndoBatch();
            setArrangeSel([]);
            afterEdit();
            return true;
        }
        if (drawMode === 'select' && selection) { deleteSelectionCells(); return true; }
        return false;
    }
    function doCut() {
        if (!selection) return;
        doCopy();
        deleteSelectionCells();
    }
    // ---- Floating paste ----
    // Selecting Paste stamps the clip right away, at the viewport center (or
    // under the cursor, if it's already hovering the grid), and leaves it
    // "floating": draggable, and not yet a permanent edit. Each drag redraws
    // it at the new spot by restoring the pre-float snapshot and re-pasting,
    // rather than mutating the grid incrementally, so the whole float —
    // however many times it gets dragged — collapses into the single undo
    // step opened by beginUndoBatch here. It becomes permanent (and the grid
    // auto-expands if it landed on an edge) when the tool changes or the user
    // taps outside it on the canvas.
    function viewportCenterAnchor() {
        const c = V.screenToCell(V.width / 2, V.height / 2);
        return {
            x: Math.max(0, Math.min(Math.max(0, M.GRID_W - clipboard.w), c.x - Math.floor(clipboard.w / 2))),
            y: Math.max(0, Math.min(Math.max(0, M.GRID_H - clipboard.h), c.y - Math.floor(clipboard.h / 2))),
        };
    }
    // If dragging the float grew the grid (applyExpansion), floatBase — the
    // pre-float snapshot the next stampFloat will restore — has to grow and
    // shift the same way, or the next restore would shrink the grid back
    // down and undo the expansion. The model does the copy, so the ratsnest
    // in the snapshot is re-addressed too rather than dropped.
    function expandFloatBase(g) {
        if (!g.left && !g.top && !g.right && !g.bottom) return;
        floatBase = M.growSnapshot(floatBase, g);
        floatPos = { x: floatPos.x + g.left, y: floatPos.y + g.top };
    }
    function stampFloat() {
        M.restoreStructuralSnapshot(floatBase);
        M.pasteRegion(clipboard, floatPos.x, floatPos.y); // may clip against the not-yet-grown grid
        // Grow the grid immediately if the float reaches the border — waiting
        // until commit is too late, the grid would already be back to this
        // size by the next stampFloat. Then re-paste: growing just now may
        // have made room for the part the first paste above had to clip off.
        expandFloatBase(applyExpansion());
        M.pasteRegion(clipboard, floatPos.x, floatPos.y);
        setSelection({
            x0: floatPos.x, y0: floatPos.y,
            x1: Math.min(M.GRID_W - 1, floatPos.x + clipboard.w - 1),
            y1: Math.min(M.GRID_H - 1, floatPos.y + clipboard.h - 1),
        });
        V.drawGrid();
    }
    function enterPasteFloat() {
        if (!clipboard) return;
        beginUndoBatch();
        floatBase = undoStack[undoStack.length - 1].snap;
        floatPos = (lastHoveredCell && M.inBounds(lastHoveredCell.x, lastHoveredCell.y))
            ? { x: lastHoveredCell.x, y: lastHoveredCell.y } : viewportCenterAnchor();
        stampFloat();
    }
    // stampFloat already keeps the grid size, floatBase, and selection in
    // sync on every move (including the last one before this runs), so
    // there's nothing left to reconcile here.
    function commitPasteFloat() {
        if (!floatBase) return;
        endUndoBatch();
        floatBase = null;
        afterEdit();
    }
    // Discard the floating clip instead (Escape, Delete, or undo mid-float):
    // put the board back as it was and drop the undo step the float opened.
    // The clipboard is kept, so V brings it straight back.
    function cancelPasteFloat() {
        if (!floatBase) return;
        M.restoreStructuralSnapshot(floatBase);
        endUndoBatch();
        undoStack.pop();
        floatBase = null;
        floatDragging = false;
        setSelection(null);
        setDrawMode('select');
        afterEdit();
    }

    // Quarter turn / left-right flip of a clip's own data, for transforming a
    // paste while it is still floating.
    // (The model does it, so any parts in the clip turn with it.)
    const rotateClip = (c) => M.rotateClipCW(c);
    const mirrorClip = (c) => M.mirrorClipH(c);

    function doRotate() {
        if (drawMode === 'rearrange') { rotateArrangeSelected(); return; }
        // With the MUX tool out, R turns the part the next click places.
        if (drawMode === 'gray') { turnStamp(); return; }
        if (drawMode === 'part') { turnPart(false); return; }
        // A floating paste turns the CLIP. Turning the stamped cells, as this
        // used to, lasted only until the next drag restamped the clip as it
        // was.
        if (drawMode === 'paste' && floatBase) { clipboard = rotateClip(clipboard); stampFloat(); return; }
        // Only a region you can see: from any other tool the Select region is
        // hidden, and R used to turn it anyway.
        if (drawMode !== 'select' || !selection) return;
        beginUndoBatch();
        // Turned, a region reaches h across and w down from its corner. The
        // sandbox grows to make room, as it does for any edit at its edge;
        // a level's board is a fixed size.
        const s = selection, w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1;
        if (!gameLevel) M.growTo(s.x0 + h + 1, s.y0 + w + 1);
        const r = M.rotateRegionCW(s.x0, s.y0, s.x1, s.y1);
        endUndoBatch();
        if (!r) {
            restoreEntry(undoStack.pop()); // takes back any growth, too
            updateActionButtons();
            V.drawGrid();
            flashStatus('No room to rotate — it would turn onto something');
            return;
        }
        applyExpansion();
        setSelection(r);
        afterEdit();
    }

    // ---- Rearrange (whole-object drag / rotate, single or multi) ----
    // Pressing on a mux/wire/pad/source in Rearrange grabs the whole object
    // (M.objectAt); dragging restamps it live by restoring the pre-grab
    // snapshot and re-applying the cumulative move (the floating-paste
    // pattern), so however long the drag wanders it collapses into one undo
    // step and one final set of rerouted wires. Release commits; the
    // selection survives so R can keep rotating it in place.
    //
    // Selecting more than one: drag from empty space for a rubber band
    // (mouse or one finger — the gesture that works everywhere), Ctrl/Cmd-
    // click to add or remove one, or press and hold on touch to do the same.
    // Dragging any member then moves the whole group rigidly.
    const objKey = (o) => Math.min(...o.cells.map(([x, y]) => M.idx(x, y)));
    function setArrangeSel(objs) {
        arrangeSel = objs || [];
        const flat = [];
        for (const o of arrangeSel) for (const c of o.cells) flat.push(c);
        V.setObjectHighlight(flat.length ? flat : null);
        updateActionButtons();
    }
    function selHasCell(x, y) {
        const i = M.idx(x, y);
        return arrangeSel.some((o) => o.cells.some(([cx, cy]) => M.idx(cx, cy) === i));
    }
    function toggleInSel(obj) {
        const k = objKey(obj);
        const rest = arrangeSel.filter((o) => objKey(o) !== k);
        setArrangeSel(rest.length === arrangeSel.length ? arrangeSel.concat([obj]) : rest);
        V.drawGrid();
    }
    // Everything the band touches, deduped — intersecting rather than fully
    // enclosing, which is much easier to hit on a phone.
    //
    // A cell already inside something found is skipped: every cell of a part
    // answers with the whole part, and asking again for each of them made a
    // band over a big part crawl.
    function selectInBand(r) {
        const seen = new Map(), covered = new Set();
        for (let y = r.y0; y <= r.y1; y++) {
            for (let x = r.x0; x <= r.x1; x++) {
                if (covered.has(M.idx(x, y))) continue;
                const o = M.objectAt(x, y);
                if (!o || seen.has(objKey(o))) continue;
                seen.set(objKey(o), o);
                if (o.kind === 'block') for (const [cx, cy] of o.cells) covered.add(M.idx(cx, cy));
            }
        }
        setArrangeSel([...seen.values()]);
    }
    // Re-derive the selection from where the cells actually ended up, so a
    // dropped group stays selected (and stays rotatable) at its new spot.
    function selFromMoved(objs, g) {
        return objs.map((o) => ({
            cells: (g && (g.left || g.top)) ? o.cells.map(([x, y]) => [x + g.left, y + g.top]) : o.cells,
        }));
    }

    // Rotation usually needs a little room: once turned, the pins face new
    // directions and the wires have to come in differently, so the turn often
    // does not fit exactly where the object stands even though it fits a cell
    // or two over. Rather than refuse outright, try the nearest positions
    // too — nudging is far less disruptive than making the user clear space
    // by hand. Nearest-first, and among equals the one with the smaller total
    // shift.
    function nudgeOffsets(radius) {
        const out = [];
        for (let dx = -radius; dx <= radius; dx++)
            for (let dy = -radius; dy <= radius; dy++) out.push([dx, dy]);
        return out.sort((a, b) =>
            (Math.max(Math.abs(a[0]), Math.abs(a[1])) - Math.max(Math.abs(b[0]), Math.abs(b[1]))) ||
            (Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1]))));
    }
    // Try a move, falling back to nearby offsets when it won't fit. Reports
    // where it actually landed, so a drag can remember that rather than the
    // spot the pointer asked for and did not get.
    function moveWithNudge(objs, dx, dy, rot, radius) {
        for (const [ox, oy] of nudgeOffsets(radius)) {
            const res = M.moveObjects(objs, dx + ox, dy + oy, rot);
            if (res.ok) return { res, nudged: ox !== 0 || oy !== 0, at: { dx: dx + ox, dy: dy + oy, rot } };
        }
        return { res: { ok: false }, nudged: false, at: null };
    }

    function clearLongPress() {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }

    // A connection the move could not keep is not lost — it is drawn as a
    // dashed line to whatever it should still reach, so say that rather than
    // just reporting a number.
    function flashUnrouted(n) {
        if (n) flashStatus(n === 1 ? '1 connection left dashed — draw it to finish'
            : `${n} connections left dashed — draw them to finish`);
    }

    function restampArrange() {
        const a = arrange;
        M.restoreStructuralSnapshot(a.base);
        // The batch opens only once a real move happens (a plain click
        // shouldn't leave a no-op undo step), and only right after the base
        // restore, so the snapshot it captures is exactly the pre-drag grid.
        if (!a.moved) { beginUndoBatch(); a.moved = true; }
        // When the exact spot won't take it, look outward for the nearest one
        // that will. `nudgeOffsets` is ordered by ring, so the first hit IS
        // the nearest, which is where the object should sit — following the
        // pointer as closely as the board allows. Snapping back to where the
        // drag last happened to fit (or worse, to where it started) threw away
        // everything the user had dragged past.
        let res = M.moveObjects(a.objs, a.dx, a.dy, a.rot);
        let nudge = null;
        if (!res.ok) {
            // Only somewhere that gets the part nearer the pointer than where
            // it already is — or as near, but on the way there. A spot that
            // fits but lies the other way (left, on a drag to the right) is
            // a jump nobody asked for; then it stays where it is.
            const from = a.last || { dx: 0, dy: 0, rot: a.rot };
            const far = (dx, dy) => Math.max(Math.abs(dx - a.dx), Math.abs(dy - a.dy));
            const onward = ([ox, oy]) => {
                const dx = a.dx + ox, dy = a.dy + oy, f = far(dx, dy), f0 = far(from.dx, from.dy);
                const dot = (dx - from.dx) * (a.dx - from.dx) + (dy - from.dy) * (a.dy - from.dy);
                return f < f0 || (f === f0 && dot > 0);
            };
            nudge = { res: { ok: false }, at: null };
            for (const [ox, oy] of nudgeOffsets(3).filter(onward)) {
                const r = M.moveObjects(a.objs, a.dx + ox, a.dy + oy, a.rot);
                if (r.ok) { nudge = { res: r, at: { dx: a.dx + ox, dy: a.dy + oy, rot: a.rot } }; break; }
            }
            res = nudge.res;
        }
        if (res.ok) a.last = nudge && nudge.at ? nudge.at : { dx: a.dx, dy: a.dy, rot: a.rot };
        else if (a.last) res = M.moveObjects(a.objs, a.last.dx, a.last.dy, a.last.rot); // nothing nearer fits
        // Nothing has fit yet — the drag just hasn't found a legal spot. The
        // grid is already back at its pre-drag state from the restore above,
        // so leave the selection where it was rather than reading cells off a
        // refusal.
        if (res.ok) {
            a.cur = res.objects;
            a.unrouted = res.unrouted || 0;
            a.pending = res.pending || 0;
            setArrangeSel(a.cur);
        }
        V.drawGrid();
    }

    function commitArrange() {
        if (!arrange) return;
        const a = arrange;
        arrange = null;
        if (!a.moved) return; // plain click: the object just stays selected
        // a.last is unset when no offset the drag tried would fit: the grid is
        // already back where it started, so this is a no-op like any other.
        const noop = !a.last || (a.last.dx === 0 && a.last.dy === 0 && a.last.rot % 4 === 0);
        endUndoBatch();
        if (noop) { undoStack.pop(); updateActionButtons(); return; } // drag ended back where it started
        const g = applyExpansion(); // dropped on the border: grow to keep the 1-cell margin
        setArrangeSel(selFromMoved(a.cur, g));
        flashUnrouted(a.pending || a.unrouted);
        afterEdit();
    }

    // Roll a drag back entirely (Escape, or a second finger landing turned
    // the gesture into pan/zoom): restore the pre-grab grid and drop the
    // undo step the drag had opened.
    function abortArrange() {
        if (!arrange) return;
        const a = arrange;
        arrange = null;
        if (a.moved) {
            M.restoreStructuralSnapshot(a.base);
            endUndoBatch();
            undoStack.pop();
            updateActionButtons();
            scheduleSave();
        }
        setArrangeSel(a.objs);
        V.drawGrid();
    }

    function rotateArrangeSelected() {
        if (arrange) { // mid-drag: fold the turn into the live drag
            arrange.rot = (arrange.rot + 1) % 4;
            restampArrange();
            return;
        }
        if (!arrangeSel.length) return;
        beginUndoBatch();
        const { res, nudged } = moveWithNudge(arrangeSel, 0, 0, 1, 3);
        endUndoBatch();
        if (!res.ok) {
            undoStack.pop(); // nothing changed — drop the no-op undo step
            updateActionButtons();
            flashStatus('No room to rotate — move things apart');
            return;
        }
        const g = applyExpansion();
        setArrangeSel(selFromMoved(res.objects, g));
        if (nudged) flashStatus('Rotated (nudged to fit)');
        afterEdit();
    }
    function doMirror() {
        if (drawMode === 'paste' && floatBase) { clipboard = mirrorClip(clipboard); stampFloat(); return; }
        if (drawMode === 'part') { turnPart(true); return; }
        if (drawMode !== 'select' || !selection) return;   // only a region you can see
        beginUndoBatch();
        const ok = M.mirrorRegionH(selection.x0, selection.y0, selection.x1, selection.y1);
        endUndoBatch();
        if (!ok) {
            undoStack.pop();
            updateActionButtons();
            flashStatus('Can’t mirror across a fixed pad');
            return;
        }
        afterEdit();
    }

    // ---- Parts ----
    // The shelf of parts (game.js): what the Parts tool puts down. In a level
    // it holds the parts made by the levels before it; in the sandbox,
    // every part, the player's own included. The old "saved components" —
    // plain clips of loose cells, from before there were parts — are still
    // listed in the sandbox, to paste as they always were.
    const availableParts = () => G.partsFor(gameLevel);
    const placingPartValid = () => !!placingPart && availableParts().some((q) => q.key === placingPart.key);

    // A clip's own pins, where they are in it (the outermost block's).
    const pinsOfClip = (clip) => M.clipPins(clip);
    function choosePart(part, loose) {
        placingPart = {
            key: part.key, name: part.name, clip: part.clip, pins: pinsOfClip(part.clip), ring: M.clipRing(part.clip),
            loose: !!loose,
        };
        closeComponents();
        setDrawMode('part');
        if (loose) flashStatus(`Put down a copy of ${part.name} to change — it goes down with its lid off for good`);
    }
    // R and M, with a part in hand: turn or flip the one about to go down.
    function turnPart(mirror) {
        if (!placingPart) return;
        placingPart.clip = mirror ? M.mirrorClipH(placingPart.clip) : M.rotateClipCW(placingPart.clip);
        placingPart.pins = pinsOfClip(placingPart.clip);
        placingPart.ring = M.clipRing(placingPart.clip);
        refreshStampPreview();
        V.drawGrid();
    }

    function loadComponentList() {
        try {
            const list = JSON.parse(localStorage.getItem(COMPONENTS_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }
    function saveComponentList(list) {
        try { localStorage.setItem(COMPONENTS_KEY, JSON.stringify(list)); } catch (e) { }
    }
    // ---- Make part (sandbox) ----
    // The selected circuit becomes a part of your own. Select roughly round
    // it — generously is fine — and the part is fitted to the smallest edge
    // it allows (M.fitPart): nothing on that edge but empty board and the
    // wires that cross it, which are its terminals. The fitted edge and the
    // terminals are drawn on the board while the panel is open, and each
    // terminal is named and set as an input or an output there. The board
    // is left as it was; the part goes on the shelf, for putting down
    // elsewhere.
    let makePartFit = null;
    const PIN_LETTERS_IN = 'ABCDEFGHIJKLMNOP', PIN_LETTERS_OUT = 'QRSTUVWXYZ';
    const SIDE_WORD = { n: 'top', s: 'bottom', w: 'left', e: 'right' };
    // The fitted edge replaces the selection's outline while the panel is
    // open: two dashed rectangles, one inside the other, read as one muddle.
    function showMakePartOutline() {
        if (!makePartFit) {
            V.setPartOutline(null);
            V.setSelection(drawMode === 'select' ? selection : null);
            V.drawGrid();
            return;
        }
        V.setSelection(null);
        V.setPartOutline({ core: makePartFit.core, edge: makePartFit.edge, pins: makePartFit.pins });
        V.drawGrid();
    }
    let outlineTimer = null;
    // Save as: a new part of your own, or an existing part — a level's,
    // which must then pass that level's tests, or one of your own. Either
    // way the circuit becomes the part where it stands.
    const makePartAsEl = document.getElementById('makePartAs');
    // Terminal names for saving as `part`: where a terminal is where one of
    // the remembered part's was, it keeps that name; the rest take the
    // part's remaining names of the same direction, in order.
    function namesFor(part) {
        const byPos = (a, b) => a.y - b.y || a.x - b.x;
        const pins = makePartFit.pins;
        const left = { in: part.pins.filter((q) => q.dir === 'in').map((q) => q.name), out: part.pins.filter((q) => q.dir === 'out').map((q) => q.name) };
        const taken = new Set();
        const mem = makePartMemory && makePartMemory.key === part.key ? makePartMemory
            : editMemories.filter((m) => m.key === part.key).pop();
        if (mem) {
            for (const q of pins) {
                const was = mem.pins.find((m) => m.at && m.at[0] === q.x && m.at[1] === q.y);
                if (was && !taken.has(was.name)) { q.name = was.name; q.dir = was.dir; taken.add(was.name); } else q.name = '';
            }
        } else for (const q of pins) q.name = '';
        for (const dir of ['in', 'out']) {
            const free = left[dir].filter((n) => !taken.has(n));
            for (const q of pins.filter((p) => !p.name && p.dir === dir).sort(byPos)) q.name = free.shift() || '';
        }
    }
    function defaultNames() {
        const byPos = (a, b) => a.y - b.y || a.x - b.x;
        const ins = makePartFit.pins.filter((q) => q.dir === 'in').sort(byPos);
        const outs = makePartFit.pins.filter((q) => q.dir === 'out').sort(byPos);
        ins.forEach((q, i) => { q.name = PIN_LETTERS_IN[i] || 'I' + i; });
        outs.forEach((q, i) => { q.name = outs.length === 1 ? 'Q' : PIN_LETTERS_OUT[i] || 'O' + i; });
    }
    // The part as it will be, drawn: the package with its name, its edge
    // round it (kept-bare cells hatched, free ones dotted), and each
    // terminal as a lead on the side it is really on — an arrow pointing in
    // for an input, out for an output (tap it to turn it round) — with the
    // terminal's name on a tag at the end, to type into. Saving as a part
    // already on the shelf, each tag is a choice of that part's own names
    // instead, and the arrows follow them.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
        const e = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        return e;
    };
    function renderMakePartPins() {
        const fit = makePartFit, core = fit.core;
        const target = makePartAsEl.value ? G.getPart(makePartAsEl.value) : null;
        const w = core.x1 - core.x0 + 1, h = core.y1 - core.y0 + 1;
        // Room round the core for the edge, the leads and the name tags.
        const tagW = 56, tagH = 22, gap = 4;
        const cs = Math.max(12, Math.min(34, Math.floor(Math.min((300 - 2 * (tagW + gap)) / (w + 2), (240 - 2 * (tagH + gap)) / (h + 2)))));
        const padX = cs + tagW + gap * 2, padY = cs + tagH + gap * 2;
        const W = w * cs + 2 * padX, H = h * cs + 2 * padY;
        const px = (x) => padX + (x - core.x0) * cs, py = (y) => padY + (y - core.y0) * cs;

        makePartPinsEl.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'part-preview';
        box.style.width = W + 'px';
        box.style.height = H + 'px';
        const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
        box.appendChild(svg);
        makePartPinsEl.appendChild(box);

        // The edge.
        for (const e of fit.edge || []) {
            if (e.cls === 'T') continue;
            const x = px(e.x), y = py(e.y);
            if (e.cls === 'R') {
                const d = `M${x},${y + cs / 2} L${x + cs / 2},${y} M${x},${y + cs} L${x + cs},${y} M${x + cs / 2},${y + cs} L${x + cs},${y + cs / 2}`;
                svg.appendChild(svgEl('path', { d, class: 'pp-bare' }));
            } else svg.appendChild(svgEl('circle', { cx: x + cs / 2, cy: y + cs / 2, r: Math.max(1.5, cs * 0.07), class: 'pp-free' }));
        }
        // The package, named.
        const inset = cs * 0.25;
        svg.appendChild(svgEl('rect', {
            x: px(core.x0) + inset, y: py(core.y0) + inset, width: w * cs - 2 * inset, height: h * cs - 2 * inset,
            rx: cs * 0.3, class: 'pp-body',
        }));
        const label = svgEl('text', {
            x: px(core.x0) + w * cs / 2, y: py(core.y0) + h * cs / 2, class: 'pp-name',
            'font-size': Math.max(10, Math.min(cs * 0.8, (w * cs - 2 * inset) / 4)),
        });
        label.textContent = target ? target.name : (makePartNameEl.value.trim() || 'NEW');
        svg.appendChild(label);
        makePartNameEl.oninput = () => { label.textContent = makePartNameEl.value.trim() || 'NEW'; };

        for (const q of fit.pins) {
            const [dx, dy] = [q.x - q.hx, q.y - q.hy];
            // The lead: from the core's edge out through the terminal cell.
            const cx = px(q.x) + cs / 2, cy = py(q.y) + cs / 2;
            const ex = cx - dx * cs / 2, ey = cy - dy * cs / 2;          // the core's edge
            const ox = cx + dx * cs / 2, oy = cy + dy * cs / 2;          // the terminal's far side
            const tone = q.dir === 'in' ? 'in' : 'out';
            svg.appendChild(svgEl('line', { x1: ex - dx * inset, y1: ey - dy * inset, x2: ox, y2: oy, class: 'pp-lead' }));
            // The arrow, pointing in or out along the lead.
            const s = q.dir === 'in' ? -1 : 1, a = cs * 0.32;
            const tipX = cx + s * dx * a, tipY = cy + s * dy * a;
            const bx = cx - s * dx * a, by = cy - s * dy * a;
            const arrow = svgEl('polygon', {
                points: `${tipX},${tipY} ${bx - dy * a},${by + dx * a} ${bx + dy * a},${by - dx * a}`,
                class: `pp-arrow ${tone}${target ? '' : ' flip'}`,
            });
            if (!target) {
                const t = svgEl('title', {});
                t.textContent = q.dir === 'in' ? 'An input — tap to make it an output' : 'An output — tap to make it an input';
                arrow.appendChild(t);
                arrow.addEventListener('click', () => { q.dir = q.dir === 'in' ? 'out' : 'in'; renderMakePartPins(); });
            }
            svg.appendChild(arrow);
            // Its name, on a tag past the terminal.
            const tag = document.createElement('div');
            tag.className = `part-chip ${tone}`;
            const field = target ? document.createElement('select') : document.createElement('input');
            field.setAttribute('aria-label', `Name of the ${q.dir === 'in' ? 'input' : 'output'} on the ${SIDE_WORD[q.side]}`);
            if (target) {
                const none = document.createElement('option');
                none.value = ''; none.textContent = '?';
                field.appendChild(none);
                for (const tp of target.pins) {
                    const o = document.createElement('option');
                    o.value = tp.name;
                    o.textContent = `${tp.name}${tp.dir === 'out' ? ' ↑' : ''}`;
                    field.appendChild(o);
                }
                field.value = q.name || '';
                field.addEventListener('change', () => {
                    q.name = field.value;
                    const tp = target.pins.find((p) => p.name === q.name);
                    if (tp) q.dir = tp.dir;
                    renderMakePartPins();
                });
            } else {
                field.type = 'text';
                field.maxLength = 8;
                field.value = q.name;
                field.addEventListener('input', () => { q.name = field.value.trim(); showMakePartOutline(); });
                field.addEventListener('keydown', (e) => { if (e.key === 'Enter') finishMakePart(); });
            }
            tag.appendChild(field);
            const tx = dx < 0 ? px(q.x) - gap - tagW : dx > 0 ? px(q.x) + cs + gap : cx - tagW / 2;
            const ty = dy < 0 ? py(q.y) - gap - tagH : dy > 0 ? py(q.y) + cs + gap : cy - tagH / 2;
            tag.style.left = tx + 'px';
            tag.style.top = ty + 'px';
            tag.style.width = tagW + 'px';
            tag.style.height = tagH + 'px';
            box.appendChild(tag);
        }
        showMakePartOutline();
    }
    function makePartAsChanged() {
        const part = makePartAsEl.value ? G.getPart(makePartAsEl.value) : null;
        makePartNameEl.disabled = !!part;
        makePartNameEl.parentElement.style.display = part ? 'none' : '';
        if (part) namesFor(part); else defaultNames();
        makePartErrorEl.textContent = '';
        renderMakePartPins();
    }
    function doSaveComponent() {
        if (!selection) return;
        const fit = M.fitPart(selection, null);
        if (fit.error) {
            // Show where the trouble is for a moment.
            flashStatus(fit.error);
            V.setPartOutline({ bad: fit.cells });
            V.drawGrid();
            clearTimeout(outlineTimer);
            outlineTimer = setTimeout(() => { if (!makePartFit) { V.setPartOutline(null); V.drawGrid(); } }, 2500);
            return;
        }
        const byPos = (a, b) => a.y - b.y || a.x - b.x;
        fit.pins = fit.pins.filter((q) => q.dir === 'in').sort(byPos).concat(fit.pins.filter((q) => q.dir === 'out').sort(byPos));
        makePartFit = fit;
        const w = fit.core.x1 - fit.core.x0 + 1, h = fit.core.y1 - fit.core.y0 + 1;
        document.getElementById('makePartSize').textContent =
            `${w}×${h} · ${fit.pins.length} terminal${fit.pins.length === 1 ? '' : 's'} · tap an arrow to turn a terminal in or out`;
        // Save as: a new part, or any part on the shelf. The one being edited
        // — decapped here, or put down loose from the shelf — is the choice
        // already made, if this is where its terminals were.
        makePartAsEl.innerHTML = '';
        const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; makePartAsEl.appendChild(o); };
        opt('', 'A new part of your own');
        for (const part of G.allParts()) opt(part.key, `${part.name}${part.source ? ' (level part: must pass its level)' : ''}`);
        makePartMemory = editFor(fit);
        const editing = !!makePartMemory;
        makePartAsEl.value = editing ? makePartMemory.key : '';
        makePartNameEl.value = '';
        makePartPanel.classList.add('open');
        makePartBackdrop.classList.add('open');
        makePartAsChanged();
        if (!editing) makePartNameEl.focus();
    }
    function closeMakePart() {
        makePartPanel.classList.remove('open');
        makePartBackdrop.classList.remove('open');
        makePartFit = null;
        makePartMemory = null;
        showMakePartOutline();
    }
    function finishMakePart() {
        if (!makePartFit) return;
        const target = makePartAsEl.value ? G.getPart(makePartAsEl.value) : null;
        const name = target ? target.name : makePartNameEl.value.trim();
        const names = makePartFit.pins.map((q) => q.name);
        let error = '';
        if (!name) error = 'Give the part a name';
        else if (names.some((n) => !n)) error = 'Every terminal needs a name';
        else if (new Set(names).size !== names.length) error = 'Two terminals have the same name';
        if (error) { makePartErrorEl.textContent = error; return; }
        // The pins in the part's own order when it is replacing one (so the
        // shelf's pin list reads the same), else inputs first, then outputs.
        let pins = makePartFit.pins.filter((q) => q.dir === 'in').concat(makePartFit.pins.filter((q) => q.dir === 'out'));
        if (target) {
            const order = target.pins.map((q) => q.name);
            pins = pins.slice().sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99));
        }
        const source = target ? target.source : '';
        const clip = M.captureRect(makePartFit.core, pins, name, source);
        if (target && source) {
            // A level's part: it has to do the level's job.
            const res = G.replaceLevelPart(G.getLevel(source), clip);
            if (!res.ok) {
                if (res.error) makePartErrorEl.textContent = res.error;
                else {
                    const f = res.failure, bits = (o) => Object.entries(o).map(([k, v]) => `${k}=${v & 1}`).join(' ');
                    const wrong = Object.keys(f.expected).filter((k) => (f.expected[k] & 1) !== (f.actual[k] & 1));
                    makePartErrorEl.textContent = !f.settled ? `It never settles at ${bits(f.inputs)}`
                        : `Not the ${name} part: at ${bits(f.inputs)}, ${wrong.map((k) => `${k} should be ${f.expected[k] & 1}`).join(', ')}`;
                }
                return;
            }
        } else {
            if (!target && G.getPart('user:' + name) && !window.confirm(`There is already a part called "${name}". Replace it?`)) return;
            G.saveCustomPart(name, clip);
        }
        // The circuit becomes the part where it stands, lid shut.
        const core = makePartFit.core;
        beginUndoBatch();
        M.capPart(core, pins, name, source);
        endUndoBatch();
        closeMakePart();
        // What was decapped here has been saved back, one way or another.
        editMemories = editMemories.filter((m) => !overlaps(m.rect, core));
        setSelection(null);
        applyToolAvailability();
        afterEdit();
        flashStatus(target ? `Saved as the ${name} part — on the shelf and here` : `Made the part “${name}” — here, and on the shelf for Parts (9)`);
    }
    function loadComponentIntoClipboard(comp) {
        clipboard = { w: comp.w, h: comp.h, data: Uint8Array.from(comp.data) };
        updateActionButtons();
        closeComponents();
        setDrawMode('paste');
    }
    function deleteComponent(name) {
        if (!window.confirm(`Delete component "${name}"?`)) return;
        saveComponentList(loadComponentList().filter((c) => c.name !== name));
        renderComponentsList();
    }
    function renderComponentsList() {
        const parts = availableParts();
        const list = gameLevel ? [] : loadComponentList();
        componentsListEl.innerHTML = '';
        componentsEmptyEl.style.display = parts.length || list.length ? 'none' : 'block';
        componentsEmptyEl.textContent = gameLevel
            ? 'No parts for this level yet — every level you solve becomes one for the levels after it.'
            : 'No parts yet. Solve a level and it becomes one; or build a circuit, select round it, and Make part…';
        for (const part of parts) {
            const row = document.createElement('div');
            row.className = 'component-row part-row';
            const label = document.createElement('span');
            label.className = 'component-label';
            const ins = part.pins.filter((q) => q.dir === 'in').map((q) => q.name).join(' ');
            const outs = part.pins.filter((q) => q.dir === 'out').map((q) => q.name).join(' ');
            label.innerHTML = '';
            const nameEl = document.createElement('b');
            nameEl.textContent = part.name;
            const meta = document.createElement('span');
            meta.className = 'part-meta';
            meta.textContent = ` ${ins} → ${outs} · ${part.w}×${part.h}`;
            label.append(nameEl, meta);
            label.title = `${part.name}: ${ins} → ${outs}, ${part.w}×${part.h} cells`;
            const placeBtn = document.createElement('button');
            placeBtn.className = 'tool-btn primary';
            placeBtn.textContent = 'Place';
            placeBtn.addEventListener('click', () => choosePart(part));
            const editBtn = document.createElement('button');
            editBtn.className = 'tool-btn';
            editBtn.textContent = 'Edit';
            editBtn.title = `Put down a loose copy of ${part.name} to change; Make part… saves it back`;
            editBtn.addEventListener('click', () => choosePart(part, true));
            row.append(label, placeBtn, editBtn);
            if (part.key.startsWith('user:')) {
                const del = document.createElement('button');
                del.className = 'tool-btn danger';
                del.textContent = 'Delete';
                del.addEventListener('click', () => {
                    if (!window.confirm(`Delete the part "${part.name}"? Copies already on a board stay.`)) return;
                    G.deletePart(part.key);
                    if (placingPart && placingPart.key === part.key) placingPart = null;
                    renderComponentsList();
                    applyToolAvailability();
                });
                row.append(del);
            }
            componentsListEl.appendChild(row);
        }
        if (list.length) {
            const head = document.createElement('div');
            head.className = 'components-subhead';
            head.textContent = 'Saved clips (loose cells, from before parts)';
            componentsListEl.appendChild(head);
        }
        for (const comp of list) {
            const row = document.createElement('div');
            row.className = 'component-row';
            const label = document.createElement('span');
            label.className = 'component-label';
            label.textContent = `${comp.name} (${comp.w}×${comp.h})`;
            label.title = label.textContent;
            const loadRowBtn = document.createElement('button');
            loadRowBtn.className = 'tool-btn';
            loadRowBtn.textContent = 'Load';
            loadRowBtn.addEventListener('click', () => loadComponentIntoClipboard(comp));
            const delRowBtn = document.createElement('button');
            delRowBtn.className = 'tool-btn danger';
            delRowBtn.textContent = 'Delete';
            delRowBtn.addEventListener('click', () => deleteComponent(comp.name));
            row.append(label, loadRowBtn, delRowBtn);
            componentsListEl.appendChild(row);
        }
    }
    function openComponents() {
        setMenuOpen(false);
        renderComponentsList();
        componentsPanel.classList.add('open');
        componentsBackdrop.classList.add('open');
    }
    function closeComponents() {
        componentsPanel.classList.remove('open');
        componentsBackdrop.classList.remove('open');
    }

    // ---- Overflow menu ----
    function setMenuOpen(open) {
        menuPanel.classList.toggle('open', open);
        menuBackdrop.classList.toggle('open', open);
        menuBtn.setAttribute('aria-expanded', String(open));
    }

    // ---- Tools / painting ----
    function setRunning(v) {
        running = v;
        playPauseBtn.textContent = running ? '⏸' : '▶';
        playPauseBtn.setAttribute('aria-pressed', String(running));
    }

    // A tool button or its key. Picking MUX when it is already out turns the
    // next part — R's job, for a screen with no keyboard, and the same on
    // the 3 key so the key does what the button does.
    //
    // Parts is the same idea: picking it with a part already in hand puts
    // that part down again; picking it while it is out — or with nothing in
    // hand — opens the shelf to choose one.
    function pickTool(mode) {
        if (mode === 'gray' && drawMode === 'gray') turnStamp();
        else if (mode === 'part' && (drawMode === 'part' || !placingPartValid())) openComponents();
        else setDrawMode(mode);
    }

    function setDrawMode(mode) {
        if (!toolAllowed(mode)) { flashStatus('Not needed in this level'); return; }
        // Leaving Paste while a clip is still floating commits it in place.
        if (floatBase && mode !== 'paste') commitPasteFloat();
        // A tool switch mid-drag (keyboard) drops the grabbed object where
        // it is; leaving Rearrange also clears its highlight.
        if (arrange) commitArrange();
        if (mode !== 'rearrange' && arrangeSel.length) setArrangeSel([]);
        drawMode = mode;
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            const on = btn.dataset.tool === mode;
            btn.classList.toggle('selected', on);
            // The rail scrolls (sideways on a phone, vertically in the wide
            // rail on a short screen), so a tool picked by keyboard could
            // otherwise become the active one while sitting off-screen.
            if (on) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
        // The overlay only shows state relevant to the active tool: the
        // selection highlight in Select and Paste (the floating clip). The
        // selection itself survives tool switches (Ctrl+C still works),
        // only its highlight goes away.
        if (mode === 'paste' && clipboard) {
            enterPasteFloat(); // pastes immediately and selects/highlights it
        } else {
            V.setSelection(mode === 'select' ? selection : null);
        }
        // In the sandbox, build modes pause the simulation and Interact
        // resumes it. In a level the simulation just runs, whatever tool is
        // held: you want to see charge move into the piece you have only half
        // finished, and having a tool change quietly stop the board was the
        // single most confusing thing about building in one. Play/pause still
        // works by hand, for when you want to freeze a state and look at it.
        if (!gameLevel) setRunning(mode === 'interact');
        applyGridVisibleForMode(mode);
        refreshStampPreview();
        // Rotate's target and the floating action bar both depend on the
        // mode, not just on the selection, so they have to be re-evaluated
        // on every tool switch.
        updateActionButtons();
        V.drawGrid();
    }

    // Every cell on a straight path between two cells, stepping one axis at
    // a time: diagonal neighbours don't connect here, so a staircase is the
    // only line that is also a wire.
    function cellPath(x0, y0, x1, y1) {
        const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0);
        const out = [[x0, y0]];
        let x = x0, y = y0;
        for (let ix = 0, iy = 0; ix < dx || iy < dy;) {
            if ((0.5 + ix) / dx < (0.5 + iy) / dy) { x += sx; ix++; } else { y += sy; iy++; }
            out.push([x, y]);
        }
        return out;
    }

    // The previous cell of the stroke in progress, or null between strokes.
    let lastPaintCell = null;

    // A straight stroke — Shift held, or the Straight toggle (L) on — is
    // {x0, y0, base, end, opened, painted}: it runs from where it began along
    // whichever axis the pointer has moved furthest on, and is redrawn from
    // the pre-stroke board (`base`) on every move, so pulling back shortens
    // it rather than leaving the overshoot behind.
    let straightStroke = null;
    let straightLock = false;
    // The Straight toggle (L): the latched form of holding Shift, for a
    // touchscreen, which has no Shift to hold.
    function setStraightLock(v) {
        straightLock = v;
        straightBtn.setAttribute('aria-pressed', String(v));
    }

    // What a stroke of `color` actually changes along `path`. Cells already
    // that color are skipped, so a stroke over existing wires neither resets
    // their charge nor opens a pointless undo step, and so are locked pads,
    // which no stroke may change.
    //
    // An eraser that touches a mux takes the whole part. A mux is one thing,
    // and what a stroke through one leaves behind is not a smaller mux — it
    // is inert material that looks like a part.
    //
    // A part is never painted into (its cells are protected, like the pads);
    // see strokeParts for what a stroke over one does instead.
    //
    // Nothing but the eraser goes over a mux: a wire drawn into one leaves
    // five cells of material that is no part at all (the model refuses it
    // too). If a wire has to go there, the mux is erased or moved first —
    // see strokeParts for the word that says so.
    function strokeCells(path, color) {
        const todo = path.filter(([x, y]) =>
            M.inBounds(x, y) && !M.isProtected(x, y) && M.colorOfCell(M.getCell(x, y)) !== color
            && (color === 'insulator' || !M.isGrayId(M.getCell(x, y))));
        if (color !== 'insulator') return todo;
        const seen = new Set(todo.map(([x, y]) => x + ',' + y));
        for (const [x, y] of todo.slice()) {
            if (!M.isGrayId(M.getCell(x, y))) continue;
            for (const [bx, by] of M.grayBlob(x, y)) {
                if (seen.has(bx + ',' + by) || M.isProtected(bx, by)) continue;
                seen.add(bx + ',' + by);
                todo.push([bx, by]);
            }
        }
        return todo;
    }

    // The parts a stroke passes over. The eraser takes one whole, as it
    // takes a mux; any other tool leaves it alone and says how to get in.
    // Returns whether anything was erased.
    let partStrokeWarned = false;
    function strokeParts(path, color) {
        const hit = new Set();
        let edgeName = null, overMux = false;
        for (const [x, y] of path) {
            const b = M.blockAtCell(x, y);
            if (!b && color !== 'insulator' && M.isGrayId(M.getCell(x, y))) overMux = true;
            if (b) hit.add(M.topBlockOf(b));
            else if (color !== 'insulator' && M.isProtected(x, y) && !M.isLocked(x, y) && !edgeName) {
                const e = M.edgeAt(x, y).find((q) => q.cls === 'R');
                const info = e && M.blockInfo(e.id);
                edgeName = info ? info.name : 'a part';
            }
        }
        if (edgeName && !hit.size) {
            if (!partStrokeWarned) flashStatus(`${edgeName} keeps that cell bare — anything there would join its circuit`);
            partStrokeWarned = true;
            return false;
        }
        if (overMux && !hit.size) {
            if (!partStrokeWarned) flashStatus('That is a mux — erase it (2) or move it (Rearrange) to put something there');
            partStrokeWarned = true;
            return false;
        }
        if (!hit.size) return false;
        if (color !== 'insulator') {
            if (!partStrokeWarned) flashStatus('That is a part — double-click it to look inside, or Decap it (Rearrange) to change it');
            partStrokeWarned = true;
            return false;
        }
        if (!undoBatchOpen) beginUndoBatch();
        for (const b of hit) M.removeBlock(b);
        return true;
    }

    function paintStraight(c, color) {
        const s = straightStroke;
        const horizontal = Math.abs(c.x - s.x0) >= Math.abs(c.y - s.y0);
        const end = horizontal ? [c.x, s.y0] : [s.x0, c.y];
        if (s.end && s.end[0] === end[0] && s.end[1] === end[1]) return;
        s.end = end;
        M.restoreStructuralSnapshot(s.base);
        const path = cellPath(s.x0, s.y0, end[0], end[1]);
        const opening = !undoBatchOpen;
        const erased = strokeParts(path, color);
        if (erased && opening) s.opened = true;
        const todo = strokeCells(path, color);
        if (todo.length) {
            if (!undoBatchOpen) { beginUndoBatch(); s.opened = true; }
            M.paintCells(todo, color);
        }
        s.painted = todo.length > 0 || erased;
        V.drawGrid();
    }

    // Paints the whole way from the stroke's previous cell to this one.
    // Pointer events are samples, and a quick drag — or any drag on a
    // zoomed-out board — covers several cells between two of them. Painting
    // only the sampled cells left a dotted line of separate pixels, which in
    // an adjacency world is not a wire at all.
    function paintAt(sx, sy, color) {
        const c = V.screenToCell(sx, sy);
        if (straightStroke) { paintStraight(c, color); return; }
        const from = lastPaintCell || c;
        lastPaintCell = c;
        const path = cellPath(from.x, from.y, c.x, c.y);
        const erased = strokeParts(path, color);
        const todo = strokeCells(path, color);
        if (!todo.length) {
            if (erased) { V.drawGrid(); scheduleSave(); }
            return;
        }
        beginUndoBatch();
        M.paintCells(todo, color);
        const g = applyExpansion();
        // Growing on the left or top shifts every cell, this stroke's
        // previous one included.
        lastPaintCell = { x: c.x + g.left, y: c.y + g.top };
        V.drawGrid();
        scheduleSave();
    }

    // ---- The MUX tool: a whole part per click ----
    // A mux is a solid 3x2 and nothing else is, so the tool places all six
    // cells at once — a lone cell of mux material is never any use. It lies
    // down (3 wide) or stands up (3 tall), and the MUX button's swatch shows
    // which. R turns the next one, and so does picking MUX again — tapping
    // its button, for a touchscreen, or pressing 3 once more; clicking a
    // blank part already on the board turns that one. A tutorial's ghost
    // outline does NOT snap the part into place: a part placed the wrong way
    // round is how you find out it can be turned.
    //
    // The part is centred on the pointer, not hung off the cell under it:
    // along its 3-cell side the middle cell is the one under the pointer,
    // and along its 2-cell side the seam between its halves is the grid line
    // nearest the pointer. So the outline sits where the hand is, and moves
    // over by a cell as the pointer crosses a cell's middle.
    let stampVertical = false;
    // Where the mouse is over the board, in canvas pixels; null once it has
    // left. Kept whatever the tool, so picking MUX shows the part at once,
    // under a mouse that has not moved.
    let mousePos = null;
    let stampShown = '';     // the preview last shown, to redraw only when it changes

    // A canvas position in fractional cells: 3.5 is the middle of column 3.
    function cellPoint(sx, sy) {
        const cs = M.CELL_SIZE * V.zoom;
        return { fx: (sx - V.panX) / cs, fy: (sy - V.panY) / cs };
    }

    function setStampVertical(v) {
        stampVertical = v;
        document.querySelector('.tool-btn[data-tool="gray"]').classList.toggle('stands', v);
        refreshStampPreview();
        V.drawGrid();
    }

    function turnStamp() {
        setStampVertical(!stampVertical);
        flashStatus(stampVertical ? 'Mux: standing up' : 'Mux: lying down');
    }

    // The tutorial's ghost part, if one is showing: its cells, and whether it
    // stands up.
    function ghostPart() {
        const g = V.guide;
        if (!g || g.color !== 'gray') return null;
        const xs = g.cells.map((c) => c[0]), ys = g.cells.map((c) => c[1]);
        return { cells: g.cells, stands: Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs) };
    }

    // The six cells a part centred on `p` (fractional cells) covers. The
    // cell under the pointer is always one of them.
    function stampCells(p) {
        // Turned to match a ghost and clicked anywhere on it: exactly the
        // ghost. Turned the other way it lands as it is — how else would
        // anyone learn it turns?
        const cx = Math.floor(p.fx), cy = Math.floor(p.fy);
        const ghost = ghostPart();
        if (ghost && ghost.stands === stampVertical && ghost.cells.some(([x, y]) => x === cx && y === cy)) return ghost.cells;
        const w = stampVertical ? 2 : 3, h = stampVertical ? 3 : 2;
        const x0 = Math.round(p.fx - w / 2), y0 = Math.round(p.fy - h / 2);
        const cells = [];
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) cells.push([x, y]);
        return cells;
    }

    // Why a part cannot go here, or null if it can. Touching another part's
    // material would merge the two into one blob that is neither.
    function stampBlocked(list) {
        const set = new Set(list.map(([x, y]) => x + ',' + y));
        for (const [x, y] of list) {
            if (!M.inBounds(x, y)) return 'No room for a mux here';
            if (M.blockAtCell(x, y)) return 'That is a part — a mux cannot go on it';
            if (M.isTerminalCell(x, y)) return 'That is a part’s terminal — a mux cannot go on it';
            if (M.isProtected(x, y) && !M.isLocked(x, y)) return 'A part keeps that clear';
            // Wire is overwritten: a mux goes where it is put, and the wire
            // under it goes. Anything else is in the way.
            const id = M.getCell(x, y);
            if (M.isLocked(x, y) || !(M.isInsulatorId(id) || M.isWireId(id))) return 'A mux needs six cells of empty board or wire';
        }
        for (const [x, y] of list) {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, ny = y + dy;
                if (set.has(nx + ',' + ny) || !M.inBounds(nx, ny)) continue;
                if (M.isGrayId(M.getCell(nx, ny))) return 'Two muxes cannot touch — leave a gap';
            }
        }
        return null;
    }

    // Shows where the MUX tool would put its part, from the mouse's last
    // position and the view as it is now — so it follows a pan or a zoom
    // under a still mouse, too. Nothing over a part already on the board
    // (a click there turns it) or off it. True if the preview changed.
    //
    // The Parts tool previews the same way: a ghost of the part's lid,
    // centred on the pointer, red where it cannot go.
    function refreshStampPreview() {
        const p = drawMode === 'gray' && mousePos ? cellPoint(mousePos.sx, mousePos.sy) : null;
        const c = p && { x: Math.floor(p.fx), y: Math.floor(p.fy) };
        let preview = null;
        if (c && M.inBounds(c.x, c.y) && !M.isGrayId(M.getCell(c.x, c.y))) {
            const list = stampCells(p);
            preview = { cells: list, ok: !stampBlocked(list) };
        }
        V.setStampPreview(preview);
        let partPreview = null;
        const pt = mousePos && cellPoint(mousePos.sx, mousePos.sy);
        // Off the board, nothing: there is nowhere there to put it.
        if (drawMode === 'part' && placingPart && pt && M.inBounds(Math.floor(pt.fx), Math.floor(pt.fy))) {
            const at = partAnchor(pt);
            const pc = placingPart.clip;
            const off = (c) => c && [at.x + c[0], at.y + c[1]];
            partPreview = {
                x0: at.x, y0: at.y, x1: at.x + pc.w - 1, y1: at.y + pc.h - 1, name: placingPart.name,
                pins: placingPart.pins.map((q) => ({ name: q.name, dir: q.dir, host: off(q.host), face: q.face, at: off(q.at) })),
                ring: placingPart.ring.map((e) => ({ x: at.x + e.x, y: at.y + e.y, cls: e.cls })),
                ok: !partBlocked(at),
            };
        }
        V.setPartPreview(partPreview);
        const key = (preview ? JSON.stringify(preview) : '') + '|' + (partPreview ? JSON.stringify(partPreview) : '');
        const changed = key !== stampShown;
        stampShown = key;
        return changed;
    }

    // Places a part centred on `p`, fractional cells (see stampCells).
    function stampAt(p) {
        const c = { x: Math.floor(p.fx), y: Math.floor(p.fy) };
        if (!M.inBounds(c.x, c.y)) return;
        if (M.isGrayId(M.getCell(c.x, c.y))) {
            const role = M.roles[M.idx(c.x, c.y)];
            if (role && role.kind === 'boxIdle') turnBlankPart(c);
            else flashStatus('Already wired — Rearrange moves it, Erase removes it');
            return;
        }
        const list = stampCells(p);
        const why = stampBlocked(list);
        if (why) { flashStatus(why); return; }
        beginUndoBatch();
        M.paintCells(list, 'gray');
        endUndoBatch();
        applyExpansion();
        refreshStampPreview();
        afterEdit();
    }

    // ---- The Parts tool: a whole part per click ----
    // Centred on the pointer like the mux. It needs empty board under every
    // cell; in the sandbox, a part reaching past the edge grows the board to
    // take it, as drawing there would.
    function partAnchor(p) {
        const c = placingPart.clip;
        return { x: Math.round(p.fx - c.w / 2), y: Math.round(p.fy - c.h / 2) };
    }
    // The model says where a part may go — its core on empty board, its edge
    // agreeing with what is round it (see M.blockFits). The sandbox grows to
    // take one that reaches past its edge.
    const partBlocked = (at) => M.blockFits(placingPart.clip, at.x, at.y, { grow: !gameLevel });
    function placePartAt(p) {
        if (!placingPartValid()) { openComponents(); return; }
        // A press on a part already there is the first half of a double-
        // click to lift its lid, not a try at stacking another on it.
        if (M.blockAtCell(Math.floor(p.fx), Math.floor(p.fy))) return;
        let at = partAnchor(p);
        const why = partBlocked(at);
        if (why) { flashStatus(why); return; }
        beginUndoBatch();
        if (!gameLevel) {
            const c = placingPart.clip;
            // Room for it plus the one-cell border the sandbox keeps.
            const g = M.growBy(1 - at.x, 1 - at.y, at.x + c.w + 1 - M.GRID_W, at.y + c.h + 1 - M.GRID_H);
            if (g.left || g.top) {
                V.compensateExpansion(g.left, g.top);
                gridOrigin.x += g.left;
                gridOrigin.y += g.top;
                at = { x: at.x + g.left, y: at.y + g.top };
            }
        }
        if (placingPart.loose) {
            // A copy to work on: its circuit loose, remembered as the part it
            // came from, and the tool put down — one copy is what editing
            // wants.
            M.pasteRegion(M.decapClip(placingPart.clip), at.x, at.y);
            rememberEdit(placingPart.key, placingPart.pins.map((q) => ({ ...q, at: q.at && [at.x + q.at[0], at.y + q.at[1]] })),
                { x0: at.x, y0: at.y, x1: at.x + placingPart.clip.w - 1, y1: at.y + placingPart.clip.h - 1 });
            endUndoBatch();
            applyExpansion();
            flashStatus(`A loose ${placingPart.name} to change — then select round it and Make part… to save it back`);
            placingPart = null;
            setDrawMode('select');
            afterEdit();
            return;
        }
        M.pasteRegion(placingPart.clip, at.x, at.y);
        endUndoBatch();
        applyExpansion();
        afterEdit();
    }

    // A part's lid: shut, it is one package; open, its circuit shows where
    // it sits. Not an edit, so no undo step and no retired verdict.
    function toggleLid(id) {
        const info = M.blockInfo(id);
        if (!info) return;
        M.setBlockOpen(id, !info.open);
        updateActionButtons();
        V.drawGrid();
        scheduleSave(true);
    }
    // The one part picked out with Rearrange, if that is what is selected.
    function selectedPart() {
        if (drawMode !== 'rearrange' || arrangeSel.length !== 1) return 0;
        const [x, y] = arrangeSel[0].cells[0];
        const b = M.blockAtCell(x, y);
        return b ? M.topBlockOf(b) : 0;
    }
    // Take the lid off for good: the part's circuit is loose parts from
    // here, to change as you like. Parts nested in it stay parts. What it
    // was is remembered, so that Make part… can save it back as that part —
    // decap, refine, make part is how a part is edited where it is used.
    function decapSelected() {
        const id = selectedPart();
        if (!id) return;
        const info = M.blockInfo(id);
        beginUndoBatch();
        M.decapBlock(id);
        endUndoBatch();
        setArrangeSel([]);
        if (info) rememberEdit(info.source ? info.source : 'user:' + info.name, info.pins, { x0: info.x0, y0: info.y0, x1: info.x1, y1: info.y1 });
        afterEdit();
        flashStatus(`${info ? info.name : 'The part'} is decapped — change it, then select round it and Make part… to save it back`);
    }
    // The parts being changed: each the part, where it stood (`rect`) and
    // where its terminals were ([{name, dir, at}]). All of them, not just the
    // last — decapping a half adder and then the XOR and AND inside it is
    // one edit of the half adder, and Make part… round the lot should offer
    // to save it back as that.
    let editMemories = [];
    let makePartMemory = null;      // the one Make part… is saving back, if any
    const overlaps = (r, c) => r.x0 <= c.x1 && r.x1 >= c.x0 && r.y0 <= c.y1 && r.y1 >= c.y0;
    function rememberEdit(key, pins, rect) {
        const part = G.getPart(key);
        if (!part) return;
        editMemories = editMemories.filter((m) => !(m.key === key && overlaps(m.rect, rect)));
        editMemories.push({ key, name: part.name, rect: { ...rect }, pins: pins.map((p) => ({ name: p.name, dir: p.dir, at: p.at && [...p.at] })) });
        if (editMemories.length > 8) editMemories.shift();
    }
    // Which of them a fit is: one where it stood, with the same number of
    // inputs and outputs, or else with terminals where its were — the most
    // of those, then the biggest (the outermost of a nest).
    function editFor(fit) {
        const ins = fit.pins.filter((q) => q.dir === 'in').length, outs = fit.pins.length - ins;
        let best = null, bestScore = null;
        for (const m of editMemories) {
            const part = G.getPart(m.key);
            if (!part) continue;
            const at = fit.pins.filter((q) => m.pins.some((p) => p.at && p.at[0] === q.x && p.at[1] === q.y)).length;
            const here = overlaps(m.rect, fit.core);
            const pIns = part.pins.filter((q) => q.dir === 'in').length;
            const same = here && pIns === ins && part.pins.length - pIns === outs;
            if (!same && !at) continue;
            const score = [same ? 1 : 0, at, (m.rect.x1 - m.rect.x0 + 1) * (m.rect.y1 - m.rect.y0 + 1)];
            const k = bestScore ? score.findIndex((v, j) => v !== bestScore[j]) : 0;
            if (!bestScore || (k >= 0 && score[k] > bestScore[k])) {
                best = m;
                bestScore = score;
            }
        }
        return best;
    }

    // A blank part turns a quarter in place — only a blank one, since a wired
    // part's orientation is what its wires say it is.
    function turnBlankPart(c) {
        beginUndoBatch();
        const res = M.moveObjects([{ cells: M.grayBlob(c.x, c.y) }], 0, 0, 1);
        // Turned to match a ghost it overlaps, it settles onto the ghost: a
        // quarter turn about its middle can leave it a cell off.
        const ghost = ghostPart();
        if (res.ok && ghost) {
            const turned = res.objects[0].cells;
            const key = ([x, y]) => x + ',' + y, mine = new Set(turned.map(key));
            const ys = turned.map((t) => t[1]), xs = turned.map((t) => t[0]);
            const stands = Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs);
            const free = ghost.cells.every((g) => mine.has(key(g)) || M.isInsulatorId(M.getCell(g[0], g[1])));
            if (stands === ghost.stands && free && ghost.cells.some((g) => mine.has(key(g)))) {
                M.clearCells(turned);
                M.paintCells(ghost.cells, 'gray');
            }
        }
        endUndoBatch();
        if (!res.ok) {
            undoStack.pop();
            updateActionButtons();
            flashStatus('No room to turn it here');
            return;
        }
        applyExpansion();
        afterEdit();
    }

    // Grow the grid if the edit touched the border, and shift the view the
    // opposite way so the existing drawing stays put on screen. Returns the
    // {left, top, right, bottom} added.
    function applyExpansion() {
        // A campaign board is a fixed size. Growing it would slide every cell
        // — including the locked I/O pads the verifier addresses by
        // coordinate — and the bounded workspace is part of the puzzle anyway.
        if (gameLevel) return { left: 0, top: 0, right: 0, bottom: 0 };
        const g = M.expandForBorder();
        if (g.left || g.top) {
            V.compensateExpansion(g.left, g.top);
            gridOrigin.x += g.left;
            gridOrigin.y += g.top;
            for (const m of editMemories) {
                m.rect = { x0: m.rect.x0 + g.left, y0: m.rect.y0 + g.top, x1: m.rect.x1 + g.left, y1: m.rect.y1 + g.top };
                for (const p of m.pins) if (p.at) p.at = [p.at[0] + g.left, p.at[1] + g.top];
            }
        }
        return g;
    }

    function setupCanvasEvents() {
        const canvas = V.canvas;

        // Pointer Events unify mouse, pen and touch. Touch adds two things
        // the mouse path can't do on a phone: a single finger draws/selects/
        // pastes (there's no hover, so paste is a direct tap), and two
        // fingers pan + pinch-zoom. Once a second finger lands we abandon any
        // in-progress single-finger stroke and stay in gesture mode until
        // every finger lifts, so a pinch never leaves a stray drawn line.
        const activeTouches = new Map(); // pointerId -> {x, y}, touch pointers only
        let touchGesture = false;
        let lastMid = null, lastDist = 0;

        function pointerPos(e) {
            const rect = canvas.getBoundingClientRect();
            return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
        }

        function beginStroke(sx, sy, erase, opts) {
            const c = V.screenToCell(sx, sy);
            const o = opts || {};
            // Touching the board ends any verification replay: it is driving
            // the inputs, and two things fighting over them helps nobody.
            abortReplay();
            // A level's I/O pads are locked, so no tool can paint them —
            // which frees the press to mean the only thing left that it could
            // usefully mean. Flipping an input to watch what the circuit does
            // is half of building one, and reaching for the Interact tool
            // every time to do it was pure ceremony.
            if (gameLevel && !erase && M.isLocked(c.x, c.y) && drawMode !== 'interact') {
                if (M.setSwitch(c.x, c.y, true)) {
                    pressedSwitch = { x: c.x, y: c.y };
                    interactPending = { x: c.x, y: c.y, sx, sy, panning: false, wasSwitch: true };
                    V.drawGrid();
                    return;
                }
                if (M.toggleAt(c.x, c.y)) { V.drawGrid(); return; }
            }
            partStrokeWarned = false;
            if (drawMode === 'interact') {
                // Not an edit, so no undo batch. A momentary switch presses and
                // holds (released on pointer-up); a toggle flips and stays.
                // Either can still turn into a pan if the pointer moves before
                // release (see the interactPending check in pointermove).
                // Nothing under a shut lid can be pressed: it cannot be seen.
                const shut = M.visibleBlockAt(c.x, c.y);
                const hidden = shut && !(M.blockInfo(shut) || {}).open;
                if (M.inBounds(c.x, c.y) && !hidden) {
                    interactPending = { x: c.x, y: c.y, sx, sy, panning: false };
                    if (M.setSwitch(c.x, c.y, true)) { pressedSwitch = { x: c.x, y: c.y }; interactPending.wasSwitch = true; V.drawGrid(); }
                    else if (M.toggleAt(c.x, c.y)) { interactPending.wasToggle = true; V.drawGrid(); }
                }
            } else if (drawMode === 'select') {
                if (!M.inBounds(c.x, c.y)) return;
                selecting = true;
                selectStart = c;
                setSelection({ x0: c.x, y0: c.y, x1: c.x, y1: c.y });
                V.drawGrid();
            } else if (drawMode === 'rearrange') {
                const obj = M.inBounds(c.x, c.y) ? M.objectAt(c.x, c.y) : null;
                // Empty space starts a rubber band. It doubles as "clear the
                // selection": a tap that never moves ends with an empty band.
                if (!obj) {
                    if (!M.inBounds(c.x, c.y)) { setArrangeSel([]); V.drawGrid(); return; }
                    band = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
                    V.setSelection(band);
                    V.drawGrid();
                    return;
                }
                if (o.toggle) { toggleInSel(obj); return; } // Ctrl/Cmd-click
                // Pressing something already selected drags the whole group;
                // pressing anything else selects just it first.
                if (!selHasCell(c.x, c.y)) setArrangeSel([obj]);
                arrange = {
                    objs: arrangeSel, base: M.getStructuralSnapshot(),
                    grabX: c.x, grabY: c.y, dx: 0, dy: 0, rot: 0,
                    last: { dx: 0, dy: 0, rot: 0 }, cur: arrangeSel, unrouted: 0, moved: false,
                };
                // Touch has no modifier key, so a press-and-hold adds or
                // removes this one object instead of dragging.
                if (o.isTouch) {
                    longPressTimer = setTimeout(() => {
                        longPressTimer = null;
                        arrange = null;   // nothing moved yet, so nothing to roll back
                        toggleInSel(obj);
                    }, LONG_PRESS_MS);
                }
                V.drawGrid();
            } else if (drawMode === 'paste') {
                if (!floatBase) return;
                const inFloat = c.x >= floatPos.x && c.x <= floatPos.x + clipboard.w - 1 &&
                    c.y >= floatPos.y && c.y <= floatPos.y + clipboard.h - 1;
                if (inFloat) {
                    floatDragging = true;
                    floatDragStart = { cellX: c.x, cellY: c.y, origX: floatPos.x, origY: floatPos.y };
                } else {
                    // Tapping elsewhere on the canvas drops the float in place.
                    commitPasteFloat();
                    setDrawMode('select');
                }
            } else if (drawMode === 'gray' && !erase) {
                stampAt(cellPoint(sx, sy));
            } else if (drawMode === 'part' && !erase) {
                placePartAt(cellPoint(sx, sy));
            } else if (drawMode === 'part') {
                // Right-click with a part in hand: erase, as right-drag does
                // with any tool.
                painting = true;
                strokeColor = 'insulator';
                lastPaintCell = null;
                straightStroke = null;
                paintAt(sx, sy, strokeColor);
            } else {
                // Paint mode. Right button (mouse) always erases.
                painting = true;
                strokeColor = erase ? 'insulator' : drawMode;
                lastPaintCell = null;
                straightStroke = (o.shift || straightLock) && M.inBounds(c.x, c.y)
                    ? { x0: c.x, y0: c.y, base: M.getStructuralSnapshot(), end: null, opened: false, painted: false }
                    : null;
                paintAt(sx, sy, strokeColor);
            }
        }

        // A straight stroke is only a preview until it ends: grow the grid and
        // save once, on release — or, if it ended back where it began with
        // nothing drawn, drop the undo step it opened.
        function endStraightStroke() {
            const s = straightStroke;
            straightStroke = null;
            if (!s) return;
            if (s.painted) { applyExpansion(); scheduleSave(); }
            else if (s.opened) { endUndoBatch(); undoStack.pop(); updateActionButtons(); }
            V.drawGrid();
        }

        function endStroke() {
            clearLongPress();
            if (band) {
                const r = band;
                band = null;
                V.setSelection(null);
                // A band that never grew is a tap on empty space: deselect.
                if (r.x1 === r.x0 && r.y1 === r.y0 && !M.objectAt(r.x0, r.y0)) setArrangeSel([]);
                else selectInBand(r);
                V.drawGrid();
            }
            if (arrange) commitArrange();
            endStraightStroke();
            painting = false;
            lastPaintCell = null;
            selecting = false;
            panning = false;
            lastPanPos = null;
            floatDragging = false;
            interactPending = null;
            strokeColor = null;
            if (pressedSwitch) { M.setSwitch(pressedSwitch.x, pressedSwitch.y, false); pressedSwitch = null; V.drawGrid(); }
            endUndoBatch();
        }

        // A second finger landing means the user wanted a two-finger gesture,
        // not to draw — so undo the dot the first finger's touchdown just
        // painted (its pre-stroke snapshot is still the open undo batch's top)
        // rather than leaving a stray mark. Nothing to roll back for select/
        // paste, which aren't mid-paint here.
        function abortStroke() {
            clearLongPress();
            if (band) { band = null; V.setSelection(null); }
            abortArrange();
            if (painting && undoBatchOpen && undoStack.length) {
                restoreEntry(undoStack.pop());
                straightStroke = null;   // rolled back with everything else
                V.drawGrid();
                scheduleSave();
                updateActionButtons();
            }
            endStroke();
        }

        function beginGesture() {
            const pts = [...activeTouches.values()];
            lastMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        }

        // Incremental: each move applies the change since the last one — pan
        // by the midpoint's shift, zoom about that midpoint by the ratio the
        // fingers spread. No absolute anchor bookkeeping needed.
        function updateGesture() {
            const pts = [...activeTouches.values()];
            const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
            const rect = canvas.getBoundingClientRect();
            V.pan(midX - lastMid.x, midY - lastMid.y);
            zoomAt(midX - rect.left, midY - rect.top, dist / lastDist);
            lastMid = { x: midX, y: midY };
            lastDist = dist;
            scheduleViewSave();
            V.drawGrid();
        }

        canvas.addEventListener('pointerdown', (e) => {
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
            if (e.pointerType === 'touch') {
                e.preventDefault();
                activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (activeTouches.size >= 2) {
                    abortStroke();        // abandon + roll back any single-finger draw
                    touchGesture = true;
                    beginGesture();
                    return;
                }
                if (touchGesture) return; // still settling from a prior gesture
                const { sx, sy } = pointerPos(e);
                beginStroke(sx, sy, false, { isTouch: true });
                return;
            }
            // mouse / pen. Shift-drag pans, except with a paint tool, where it
            // draws a straight line — the convention every paint program has.
            const shiftPans = e.shiftKey && !PAINT_TOOLS.includes(drawMode)
                && !(drawMode === 'rearrange' && (e.ctrlKey || e.metaKey));
            if (e.button === 1 || shiftPans) {
                panning = true;
                lastPanPos = { x: e.clientX, y: e.clientY };
                return;
            }
            if ((drawMode === 'select' || drawMode === 'paste' || drawMode === 'rearrange') && e.button !== 0) return;
            const { sx, sy } = pointerPos(e);
            beginStroke(sx, sy, e.button === 2, { toggle: e.ctrlKey || e.metaKey, shift: e.shiftKey });
        });

        canvas.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'touch') {
                if (activeTouches.has(e.pointerId)) activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (touchGesture) { if (activeTouches.size >= 2) updateGesture(); return; }
            }
            const { sx, sy } = pointerPos(e);
            // A press-and-hold in Interact turns into a pan once the pointer
            // has moved far enough — cancels whatever switch/toggle the
            // touchdown triggered (a toggle flip is undone by flipping it
            // back) so a drag-to-pan gesture doesn't also leave an interaction
            // behind.
            if (interactPending && !interactPending.panning) {
                const dist = Math.hypot(sx - interactPending.sx, sy - interactPending.sy);
                if (dist > INTERACT_PAN_THRESHOLD) {
                    if (interactPending.wasSwitch) { M.setSwitch(interactPending.x, interactPending.y, false); pressedSwitch = null; }
                    if (interactPending.wasToggle) M.toggleAt(interactPending.x, interactPending.y);
                    interactPending.panning = true;
                    panning = true;
                    lastPanPos = { x: e.clientX, y: e.clientY };
                    V.drawGrid();
                }
            }
            if (panning && lastPanPos) {
                V.pan(e.clientX - lastPanPos.x, e.clientY - lastPanPos.y);
                lastPanPos = { x: e.clientX, y: e.clientY };
                scheduleViewSave();
                V.drawGrid();
                return;
            }
            if (e.pointerType !== 'touch') {
                updateCellInfo(sx, sy);
                // Show where the MUX tool would put its part.
                mousePos = { sx, sy };
                if (refreshStampPreview()) V.drawGrid();
            }
            if (band) {
                const c = V.screenToCell(sx, sy);
                band.x1 = Math.max(0, Math.min(M.GRID_W - 1, c.x));
                band.y1 = Math.max(0, Math.min(M.GRID_H - 1, c.y));
                V.setSelection({
                    x0: Math.min(band.x0, band.x1), y0: Math.min(band.y0, band.y1),
                    x1: Math.max(band.x0, band.x1), y1: Math.max(band.y0, band.y1),
                });
                V.drawGrid();
                return;
            }
            if (arrange) {
                const c = V.screenToCell(sx, sy);
                if (c.x - arrange.grabX !== arrange.dx || c.y - arrange.grabY !== arrange.dy) {
                    clearLongPress(); // it's a drag, not a hold
                    arrange.dx = c.x - arrange.grabX;
                    arrange.dy = c.y - arrange.grabY;
                    restampArrange();
                }
                return;
            }
            if (selecting && selectStart) {
                const c = V.screenToCell(sx, sy);
                const cx = Math.max(0, Math.min(M.GRID_W - 1, c.x));
                const cy = Math.max(0, Math.min(M.GRID_H - 1, c.y));
                setSelection({
                    x0: Math.min(selectStart.x, cx), y0: Math.min(selectStart.y, cy),
                    x1: Math.max(selectStart.x, cx), y1: Math.max(selectStart.y, cy),
                });
                V.drawGrid();
                return;
            }
            if (painting) {
                paintAt(sx, sy, strokeColor);
                return;
            }
            if (floatDragging) {
                const c = V.screenToCell(sx, sy);
                const nx = floatDragStart.origX + (c.x - floatDragStart.cellX);
                const ny = floatDragStart.origY + (c.y - floatDragStart.cellY);
                if (nx !== floatPos.x || ny !== floatPos.y) {
                    floatPos = { x: nx, y: ny };
                    stampFloat();
                }
                return;
            }
        });

        function onPointerEnd(e) {
            if (e.pointerType === 'touch') {
                activeTouches.delete(e.pointerId);
                if (activeTouches.size >= 2) { beginGesture(); return; } // e.g. 3->2 fingers
                if (activeTouches.size === 0) touchGesture = false;
                // One finger still down after a gesture stays inert until all
                // lift, so it can't start a stray stroke.
            }
            endStroke();
        }
        canvas.addEventListener('pointerup', onPointerEnd);
        canvas.addEventListener('pointercancel', onPointerEnd);
        window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') endStroke(); });

        canvas.addEventListener('pointerleave', (e) => {
            if (e.pointerType !== 'mouse') return;
            document.getElementById('cellInfo').textContent = '';
            lastHoveredCell = null;
            mousePos = null;
            if (refreshStampPreview()) V.drawGrid();
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Double-click a part to lift its lid, and again to put it back. The
        // part it means is the one you can see there: the outermost with its
        // lid shut, or else the innermost.
        canvas.addEventListener('dblclick', (e) => {
            const { sx, sy } = pointerPos(e);
            const c = V.screenToCell(sx, sy);
            const b = M.visibleBlockAt(c.x, c.y);
            if (!b) return;
            e.preventDefault();
            toggleLid(b);
            updateCellInfo(sx, sy);
        });

        // Scroll pans (so two-finger trackpad scrolling just works);
        // Ctrl+scroll — which is also what a trackpad pinch reports — zooms
        // about the cursor. Zoom is proportional to the scroll delta, so a
        // trackpad's stream of small deltas gives a smooth glide instead of
        // compounding a flat 10% per event.
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const rect = canvas.getBoundingClientRect();
                zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.004, -e.deltaY));
            } else {
                V.pan(-e.deltaX, -e.deltaY);
            }
            scheduleViewSave();
            refreshStampPreview();
            V.drawGrid();
        }, { passive: false });
    }

    // Zoom about a fixed screen point, keeping whatever is under it exactly
    // in place. Uses fractional cell coordinates — anchoring on the floored
    // cell (screenToCell) would make each zoom step also jump by up to a
    // cell.
    function zoomAt(sx, sy, factor) {
        const cs0 = M.CELL_SIZE * V.zoom;
        const fx = (sx - V.panX) / cs0, fy = (sy - V.panY) / cs0;
        V.setZoom(V.zoom * factor);
        const cs1 = M.CELL_SIZE * V.zoom;
        V.pan(sx - fx * cs1 - V.panX, sy - fy * cs1 - V.panY);
        updateZoomLabel();
    }

    function zoomAtCenter(factor) {
        zoomAt(V.width / 2, V.height / 2, factor);
        scheduleViewSave();
        V.drawGrid();
    }

    // What a cell IS, in the terms the tools and the level text use. The
    // readout used to print the model's internals — "gray (comMiddle)",
    // "gray (boxSel)" — which named nothing a player could act on. For a mux
    // it says which terminal the cell is, and for a part that is not wired up
    // yet, what to wire next.
    function describeCell(x, y) {
        const vb = M.visibleBlockAt(x, y);
        const part = vb ? M.blockInfo(vb) : null;
        if (part && !part.open) {
            const pin = part.pins.find((q) => q.host && q.host[0] === x && q.host[1] === y);
            return pin ? `${part.name}, pin ${pin.name} (${pin.dir === 'in' ? 'input' : 'output'})`
                : `${part.name} — a part; double-click to look inside`;
        }
        const plain = describeLooseCell(x, y);
        if (part) return `${plain} (inside ${part.name})`;
        // On a part's edge: a terminal, or a cell it keeps bare.
        for (const e of M.edgeAt(x, y)) {
            const info = M.blockInfo(e.id);
            if (!info) continue;
            if (e.cls === 'T') {
                const pin = info.pins[e.pin];
                return `${plain} — ${info.name}’s terminal ${pin ? pin.name : ''}${M.isInsulatorId(M.getCell(x, y)) ? ': wire it here' : ''}`;
            }
            if (e.cls === 'R') return `${plain} — kept bare by ${info.name}`;
        }
        return plain;
    }
    function describeLooseCell(x, y) {
        const id = M.getCell(x, y);
        if (M.isInsulatorId(id)) return 'empty';
        if (M.isConductorId(id) || M.isXover(id)) return M.isCrossoverAt(x, y) ? 'wire crossing' : 'wire';
        if (id === M.ID_POS) return '+V source';
        if (id === M.ID_NEG) return '−V source';
        if (M.isLed(id)) return M.ledIsOn(id) ? 'LED, lit' : 'LED';
        if (M.isSwitch(id)) return M.switchIsPressed(id) ? 'switch, held' : 'switch';
        if (M.isToggle(id)) return M.toggleIsOn(id) ? 'toggle, on' : 'toggle, off';
        const role = M.roles[M.idx(x, y)];
        if (!role || role.kind === 'isolatedGray') return 'mux, unfinished — inert until it is a solid 3×2';
        const m = role.macro;
        const at = (p) => p && p[0] === x && p[1] === y;
        switch (role.kind) {
            case 'boxIdle': return 'mux, unwired — wire the middle of a long side for COM';
            case 'boxFrame': return 'mux, no SELECT yet — wire a corner of the COM side';
            case 'end': return role.isFirst === m.selIsFirst
                ? 'mux NO pin — joined to COM while SELECT is on'
                : 'mux NC pin — joined to COM while SELECT is off';
            case 'comMiddle':
                if (at(m.comCell)) return 'mux COM';
                if (at(m.selCorner)) return 'mux SELECT';
                return 'mux';
            default: return 'mux';
        }
    }

    function updateCellInfo(sx, sy) {
        const { x, y } = V.screenToCell(sx, sy);
        const cellInfo = document.getElementById('cellInfo');
        if (!M.inBounds(x, y)) { cellInfo.textContent = ''; lastHoveredCell = null; return; }
        lastHoveredCell = { x, y };
        let label = describeCell(x, y);
        // A level's pads carry the name the brief and the truth table use.
        const pad = V.labels.find((l) => l.x === x && l.y === y);
        if (pad) label = `${pad.text}: ${label} (fixed)`;
        cellInfo.textContent = `(${x},${y}) ${label}`;
    }

    function updateZoomLabel() {
        zoomValueEl.textContent = Math.round(V.zoom * 100) + '%';
    }

    function setupToolbar() {
        loadGridVisiblePrefs();
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => pickTool(btn.dataset.tool));
        });
        setDrawMode('conductor');

        gridToggleBtn.addEventListener('click', () => {
            if (drawMode === 'interact') gridVisibleInteract = !gridVisibleInteract;
            else gridVisibleBuild = !gridVisibleBuild;
            applyGridVisibleForMode(drawMode);
            saveGridVisiblePrefs();
            V.drawGrid();
        });

        pinLabelsBtn.addEventListener('click', () => {
            pinLabelsPref = pinLabelsShown() ? 'off' : 'on';
            try { localStorage.setItem(PIN_LABELS_KEY, pinLabelsPref); } catch (e) { }
            applyPinLabels();
            V.drawGrid();
        });

        straightBtn.addEventListener('click', () => setStraightLock(!straightLock));

        // Overflow menu: everything you reach for occasionally (components,
        // import/export, clear/reset, fullscreen) lives here instead of in a
        // permanent row of buttons, which is what let the top bar become a
        // single line that never wraps at any width.
        menuBtn.addEventListener('click', () => setMenuOpen(!menuPanel.classList.contains('open')));
        menuBackdrop.addEventListener('click', () => setMenuOpen(false));
        // Every item does its thing and dismisses, the way a menu should.
        menuPanel.querySelectorAll('.menu-item').forEach((item) => {
            item.addEventListener('click', () => setMenuOpen(false));
        });

        // Fullscreen: an explicit toggle. Auto-fullscreen on first tap used to
        // fire here too and was more nuisance than help — installed, the app
        // is already chrome-free via the manifest's standalone display, so
        // this is only for a plain browser tab, and only when asked for.
        const FS = window.PixelogicFullscreen;
        if (FS && FS.supported) {
            fullscreenBtn.addEventListener('click', () => FS.toggle());
            const syncFullscreenBtn = () => {
                const on = FS.isActive();
                fullscreenBtn.setAttribute('aria-pressed', String(on));
                fullscreenBtn.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
            };
            document.addEventListener('fullscreenchange', syncFullscreenBtn);
            document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
            syncFullscreenBtn();
        } else {
            fullscreenBtn.style.display = 'none';
        }

        playPauseBtn.addEventListener('click', () => setRunning(!running));
        document.getElementById('stepBtn').addEventListener('click', () => {
            M.stepSimulation();
            V.drawGrid();
        });
        document.getElementById('clearBtn').addEventListener('click', () => {
            if (!window.confirm('Clear the entire grid?')) return;
            beginUndoBatch();
            M.clearGrid();
            endUndoBatch();
            setSelection(null);
            afterEdit();
        });
        document.getElementById('resetChargesBtn').addEventListener('click', () => {
            M.resetCharges();
            V.drawGrid();
            scheduleSave();
        });
        document.getElementById('zoomInBtn').addEventListener('click', () => zoomAtCenter(1.2));
        document.getElementById('zoomOutBtn').addEventListener('click', () => zoomAtCenter(1 / 1.2));
        document.getElementById('fitBtn').addEventListener('click', () => { V.fitToWindow(); updateZoomLabel(); scheduleViewSave(); V.drawGrid(); });

        copyBtn.addEventListener('click', doCopy);
        cutBtn.addEventListener('click', doCut);
        rotateBtn.addEventListener('click', doRotate);
        mirrorBtn.addEventListener('click', doMirror);
        deleteBtn.addEventListener('click', deleteSelected);
        undoBtn.addEventListener('click', undo);
        redoBtn.addEventListener('click', redo);
        saveComponentBtn.addEventListener('click', doSaveComponent);
        componentsBtn.addEventListener('click', openComponents);
        document.getElementById('newPartBtn').addEventListener('click', () => {
            closeComponents();
            setDrawMode('select');
            flashStatus('Select round a circuit — its muxes and sources, and the wires that meet it — then Make part…');
        });
        makePartAsEl.addEventListener('change', makePartAsChanged);
        lidBtn.addEventListener('click', () => { const id = selectedPart(); if (id) toggleLid(id); });
        decapBtn.addEventListener('click', decapSelected);
        document.getElementById('makePartOkBtn').addEventListener('click', finishMakePart);
        document.getElementById('makePartCloseBtn').addEventListener('click', closeMakePart);
        makePartBackdrop.addEventListener('click', closeMakePart);
        makePartNameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') finishMakePart(); });
        componentsCloseBtn.addEventListener('click', closeComponents);
        componentsBackdrop.addEventListener('click', closeComponents);

        intervalSlider.value = String(sliderPosForTps(DEFAULT_TPS));
        intervalSlider.addEventListener('input', updateIntervalFromSlider);
        updateIntervalFromSlider();

        document.getElementById('exportBtn').addEventListener('click', async () => {
            // The raw JSON is mostly zeros; gzip+base64 shrinks it to a short
            // token (prefixed PXLZ1: so import can tell the two apart). Falls
            // back to raw JSON if the browser lacks CompressionStream.
            const json = M.serialize();
            let text = json;
            try { if (window.CompressionStream) text = 'PXLZ1:' + await gzipToBase64(json); } catch (e) { text = json; }
            // navigator.clipboard only exists in a secure context — on a phone
            // hitting a LAN IP over plain HTTP it's undefined, so fall back to a
            // prompt the user can select-and-copy from.
            const fallback = () => window.prompt('Circuit text — select all and copy:', text);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => flashStatus('Copied to clipboard'), fallback);
            } else {
                fallback();
            }
        });
        document.getElementById('importBtn').addEventListener('click', async () => {
            let text = window.prompt('Paste exported circuit text:');
            if (!text) return;
            text = text.trim();
            if (text.startsWith('PXLZ1:')) {
                try { text = await base64ToGunzip(text.slice(6)); } catch (e) { flashStatus('Invalid data'); return; }
            }
            beginUndoBatch();
            const ok = M.deserialize(text);
            endUndoBatch();
            if (ok) {
                // An imported grid brings its own coordinate frame, and the
                // view is refit to it, so the origin starts over from here.
                gridOrigin.x = 0;
                gridOrigin.y = 0;
                V.fitToWindow(); updateZoomLabel();
                afterEdit();
                flashStatus('Imported');
            } else {
                // The failed attempt pushed a snapshot identical to the
                // current grid — drop it rather than leave a no-op undo step.
                undoStack.pop();
                updateActionButtons();
                flashStatus('Invalid data');
            }
        });
    }

    let statusTimer = null;
    function flashStatus(msg) {
        statusEl.textContent = msg;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
    }

    // The slider's own max is the resolution: it's fine-grained (1000 steps)
    // so that a whole-number target rate like DEFAULT_TPS lands on it exactly
    // instead of a step either side of it.
    function updateIntervalFromSlider() {
        const v = Number(intervalSlider.value);
        const tps = MIN_TPS * Math.pow(MAX_TPS / MIN_TPS, v / Number(intervalSlider.max));
        tickIntervalMs = 1000 / tps;
        intervalValueEl.textContent = `${Math.round(tps)} tps`;
    }
    // The scale is exponential, so the position for a given rate is derived
    // rather than hard-coded — changing DEFAULT_TPS is enough.
    function sliderPosForTps(tps) {
        return Math.round(Number(intervalSlider.max) * Math.log(tps / MIN_TPS) / Math.log(MAX_TPS / MIN_TPS));
    }

    // A tick interval faster than one frame (~16ms at 60Hz) can't be reached by
    // stepping at most once per requestAnimationFrame callback, so this steps
    // in a catch-up loop, running as many ticks as the elapsed time calls for.
    //
    // Bounded by TIME, not by a step count. A cap of 1000 steps a frame let a
    // big board, or a tab coming back from the background, spiral: each frame
    // took longer than the ticks it was catching up on, so every frame ran
    // the full thousand and the page froze. Past the budget the backlog is
    // simply dropped — the board runs slower than asked, and stays usable.
    const FRAME_BUDGET_MS = 12;
    function tickLoop(now) {
        // A Verify replay drives the board itself, one tick at a time. Letting
        // this loop step it as well ran it at two rates at once, and could
        // make an oscillating board look settled to the replay's check.
        if (running && !replayTimer) {
            const deadline = performance.now() + FRAME_BUDGET_MS;
            let steps = 0;
            while (now - lastTick >= tickIntervalMs) {
                lastTick += tickIntervalMs;
                M.stepSimulation();
                steps++;
                if (performance.now() > deadline) { lastTick = now; break; }
            }
            if (steps > 0) V.drawGrid();
            if (steps > 0 && probe) updateProbe();
        } else {
            lastTick = now;
        }
        // Some coach steps are about what the circuit DOES (the lamp lights),
        // not what is drawn, so the coach is re-checked as the board runs,
        // not only after edits.
        if (gameLevel && !verifyStatus && now - lastCoachCheck > 250) {
            lastCoachCheck = now;
            renderStatus();
        }
        requestAnimationFrame(tickLoop);
    }

    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.key === 'Escape') {
            // Dismissing an open overlay is all Escape does — deselecting
            // under it would be a second, unasked-for action.
            if (menuPanel.classList.contains('open')) { setMenuOpen(false); return; }
            if (levelsPanel.classList.contains('open')) { closeLevels(); return; }
            if (componentsPanel.classList.contains('open')) { closeComponents(); return; }
            if (makePartPanel.classList.contains('open')) { closeMakePart(); return; }
            if (floatBase) { cancelPasteFloat(); return; } // a paste not yet placed: never mind
            if (arrange) abortArrange();          // mid-drag: put the object back
            else if (arrangeSel.length) { setArrangeSel([]); V.drawGrid(); }
            if (selection) { setSelection(null); V.drawGrid(); }
            return;
        }
        // An open panel owns the keyboard. Keys used to go straight through
        // to the board behind it — a digit switched tools, Space stepped the
        // simulation, Delete offered to clear the grid.
        if (menuPanel.classList.contains('open') || levelsPanel.classList.contains('open') ||
            componentsPanel.classList.contains('open') || makePartPanel.classList.contains('open')) return;

        const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
        if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
        if (mod && key === 'c') { e.preventDefault(); doCopy(); return; }
        if (mod && key === 'x') { e.preventDefault(); doCut(); return; }
        if (mod && key === 'v') {
            e.preventDefault();
            if (clipboard) setDrawMode('paste'); // pastes immediately, floating and draggable
            return;
        }
        // Everything below is a bare key. With Ctrl/Cmd/Alt held it belongs
        // to the browser: Ctrl+S used to switch to Select as the save dialog
        // opened, Ctrl+P paused the board behind the print dialog, Ctrl+R
        // rotated the selection on the way to a reload.
        if (mod || e.altKey) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            // With nothing selected, Delete is the Clear grid shortcut (it
            // asks first).
            if (!deleteSelected()) document.getElementById('clearBtn').click();
            return;
        }

        if (e.key.startsWith('Arrow')) {
            e.preventDefault();
            const step = 80;
            if (e.key === 'ArrowLeft') V.pan(step, 0);
            else if (e.key === 'ArrowRight') V.pan(-step, 0);
            else if (e.key === 'ArrowUp') V.pan(0, step);
            else V.pan(0, -step);
            scheduleViewSave();
            refreshStampPreview();
            V.drawGrid();
            return;
        }
        if (e.key === '+' || e.key === '=') { zoomAtCenter(1.2); return; }
        if (e.key === '-') { zoomAtCenter(1 / 1.2); return; }

        if (e.key === ' ') { e.preventDefault(); document.getElementById('stepBtn').click(); }
        else if (e.key === 'p' || e.key === 'P') setRunning(!running);
        // Digits follow the rail's order top-to-bottom. Erase sits second,
        // next to Conductor, because reaching for it is as constant as
        // reaching for wire.
        else if (e.key === '1') pickTool('conductor');
        else if (e.key === '2') pickTool('insulator');
        else if (e.key === '3') { if (!e.repeat) pickTool('gray'); }   // held down, it would spin the part
        else if (e.key === '4') pickTool('pos');
        else if (e.key === '5') pickTool('neg');
        else if (e.key === '6') pickTool('led');
        else if (e.key === '7') pickTool('toggle');
        else if (e.key === '8') pickTool('switch');
        else if (e.key === '9') { if (!e.repeat) pickTool('part'); }
        else if (e.key === 'i' || e.key === 'I') setDrawMode('interact');
        else if (e.key === 's' || e.key === 'S') setDrawMode('select');
        else if (e.key === 'a' || e.key === 'A') setDrawMode('rearrange');
        else if ((e.key === 'v' || e.key === 'V') && clipboard) setDrawMode('paste');
        else if (e.key === 'r' || e.key === 'R') doRotate();
        else if (e.key === 'm' || e.key === 'M') doMirror();
        else if (e.key === 'f' || e.key === 'F') { V.fitToWindow(); updateZoomLabel(); scheduleViewSave(); V.drawGrid(); }
        else if (e.key === 'g' || e.key === 'G') { if (!gridToggleBtn.disabled) gridToggleBtn.click(); }
        else if ((e.key === 'h' || e.key === 'H') && gameLevel) setCollapsed(!levelBarCollapsed);
        else if (e.key === 'l' || e.key === 'L') setStraightLock(!straightLock);
    });

    // ---- Campaign ----------------------------------------------------------
    //
    // Entering a level swaps the whole board: the sandbox circuit is written
    // back to its own key, the level's board (a saved attempt, or a fresh one)
    // is loaded with its pads locked, and the editing history starts over —
    // an undo across a board swap would restore the previous level's circuit
    // into this one's grid.
    function resetHistory() {
        undoStack.length = 0;
        redoStack.length = 0;
        endUndoBatch();
        setSelection(null);
        setArrangeSel([]);
        gridOrigin.x = 0;
        gridOrigin.y = 0;
        updateActionButtons();
    }

    // The level bar floats over the canvas, so the view has to know how much
    // of the foot it hides. Called whenever the bar appears, collapses, or
    // opens its hint. The truth table popover sits on top of the bar and
    // follows it.
    function syncViewInset() {
        const open = gameLevel && levelBar.classList.contains('open');
        V.setViewInset(open ? levelBar.offsetHeight + 16 : 0);
        if (open) levelTableEl.style.bottom = (levelBar.offsetHeight + 16) + 'px';
    }

    // The level bar's height moves when the player collapses it or opens the
    // hint, and each move changes how much of the canvas is actually visible.
    // (Nothing automatic moves it: the status line has a fixed height, so
    // building and verifying never shift the board.) Re-frame afterwards, but only for a view
    // that was already framed: if the player has zoomed in on some corner,
    // yanking them back out to the whole board every time the bar twitches is
    // worse than a bit of the board sitting behind it.
    function reframeAfter(change) {
        const wasFramed = Math.abs(V.zoom - V.minZoom) < 1e-6;
        change();
        syncViewInset();
        if (wasFramed) V.fitToWindow(); else V.clampView();
        updateZoomLabel();
        V.drawGrid();
    }

    function showBoard() {
        syncViewInset();
        V.fitToWindow();
        updateZoomLabel();
        scheduleViewSave();
        V.drawGrid();
    }

    function enterLevel(id) {
        const level = G.getLevel(id);
        if (!level || !G.isUnlocked(id, gameProgress)) return;
        abortReplay();
        flushSave();
        gameLevel = level;
        G.loadBoard(level, G.loadCircuit(id));
        V.setLabels(G.padLabels(level));
        showTargetRect(level);
        gameProgress.current = id;
        gameProgress.mode = 'campaign';
        G.saveProgress(gameProgress);
        resetHistory();
        verifyStatus = null;
        probe = null;
        tableFor = null;
        closeTable();
        setHintOpen(false);
        updateLevelBar();
        closeLevels();
        // Build tools, not Interact: you arrive at a level to draw in it.
        setDrawMode('conductor');
        // A level always runs. Only a fresh page load used to start it:
        // arriving from the sandbox, where a build tool had paused the board,
        // left it paused, and the tutorial's "click A and watch the charge
        // run" did nothing at all.
        setRunning(true);
        showBoard();
    }

    // A level in stages shows its square once the first stage is done.
    const packStage = (level) => !!level.pack
        && (gameProgress.reached[level.id] === 'pack' || !!gameProgress.completed[level.id]);
    function showTargetRect(level) {
        V.setTargetRect(level && packStage(level) ? level.pack.rect : null);
    }

    function exitToSandbox() {
        abortReplay();
        flushSave();
        gameLevel = null;
        verifyStatus = null;
        M.setLockedCells([]);
        V.setLabels([]);
        V.setTargetRect(null);
        // `current` is kept, not cleared: it is where the Sandbox toggle
        // brings you back to.
        gameProgress.mode = 'sandbox';
        G.saveProgress(gameProgress);
        const saved = localStorage.getItem(CIRCUIT_KEY);
        if (saved) M.deserialize(saved); else M.clearGrid();
        resetHistory();
        updateLevelBar();
        closeLevels();
        setDrawMode('conductor');
        showBoard();
    }

    // Grey out the materials this level does not use (its `tools`), and put
    // down whichever one was in hand if it is one of them.
    function applyToolAvailability() {
        document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
            if (!MATERIALS.includes(btn.dataset.tool)) return;
            if (btn.dataset.title === undefined) btn.dataset.title = btn.title;
            const ok = toolAllowed(btn.dataset.tool);
            btn.disabled = !ok;
            btn.title = ok ? btn.dataset.title : 'Not needed in this level';
        });
        // Parts, only when there are some to put down.
        const partsBtn = document.querySelector('.tool-btn[data-tool="part"]');
        if (partsBtn) {
            if (partsBtn.dataset.title === undefined) partsBtn.dataset.title = partsBtn.title;
            const any = availableParts().length > 0;
            partsBtn.disabled = !any;
            partsBtn.title = any ? partsBtn.dataset.title
                : (gameLevel ? 'No parts yet — every level you solve becomes one for the levels after it' : 'No parts yet');
            if (!placingPartValid()) placingPart = null;
        }
        if (!toolAllowed(drawMode) || (drawMode === 'part' && !placingPart)) setDrawMode('conductor');
    }

    function updateLevelBar() {
        levelBar.classList.toggle('open', !!gameLevel);
        document.getElementById('app').classList.toggle('in-level', !!gameLevel);
        applyPinLabels();
        applyToolAvailability();
        if (!gameLevel) { closeTable(); setGuide(null); syncViewInset(); return; }
        levelTitleEl.textContent = gameLevel.subtitle
            ? `${gameLevel.title} — ${gameLevel.subtitle}` : gameLevel.title;
        levelBriefEl.textContent = gameLevel.brief;
        levelHintEl.textContent = gameLevel.hint || '';
        hintBtn.style.display = gameLevel.hint ? '' : 'none';
        renderStatus();
        applyCollapsed();
    }

    // Collapsing leaves the title row, the buttons and the status line, and
    // hides the brief and the hint. The brief is worth reading once and then
    // in the way — the board underneath is the thing — so the preference
    // sticks across levels and reloads.
    function applyCollapsed() {
        levelBar.classList.toggle('collapsed', levelBarCollapsed);
        levelCollapseBtn.setAttribute('aria-expanded', String(!levelBarCollapsed));
        levelCollapseBtn.innerHTML = levelBarCollapsed ? '&#x25B4;' : '&#x25BE;';
        levelCollapseBtn.title = levelBarCollapsed ? 'Show the level text (H)' : 'Minimize the level text (H)';
        syncViewInset();
    }

    function setCollapsed(v) {
        reframeAfter(() => {
            levelBarCollapsed = v;
            try { localStorage.setItem(LEVEL_BAR_KEY, JSON.stringify(v)); } catch (e) { }
            applyCollapsed();
        });
    }

    function setHintOpen(open) {
        reframeAfter(() => {
            levelHintEl.classList.toggle('open', open);
            hintBtn.setAttribute('aria-pressed', String(open));
        });
    }

    // ---- The status line ----------------------------------------------------
    //
    // One fixed-height line under the brief says what to do now: the next
    // step of the level's coach (see game.js), or — once Verify has run — how
    // it went, with a thin bar marking each test case off as the replay plays
    // it. It replaced a numbered list of every step plus a truth table that
    // grew under it, which buried the board in text and, because the bar
    // changed height, re-framed the board several times per Verify.
    //
    // `verifyStatus` is the last Verify while it is still current, or null.
    // Editing the board makes a verdict stale, and the line goes back to the
    // coach.
    let verifyStatus = null;   // {level, result, marks:[], index, done, shelved}
    let lastStatusHtml = '';
    let lastCoachCheck = 0;

    const bits = (names, vals) => `<span class="bits">${names.map((n) => `${n}=${vals[n] & 1}`).join(' ')}</span>`;

    // Segments for the bar: 'done'/'ok', 'bad', 'active' or '' (not reached).
    const caseBar = (marks) => `<div class="case-bar">${marks.map((m) => `<span class="${m}"></span>`).join('')}</div>`;

    function nextLevelButton(level) {
        const next = G.nextLevel(level.id);
        return next ? `<button class="tool-btn primary" data-act="next" data-level="${next.id}">Next: ${next.title} →</button>` : '';
    }

    // `c` is the level's coachState, or null for a level without a coach.
    // The truth table is always a click away — before a Verify too, when
    // it is the level's spec, with any row there to try by hand.
    const TABLE_BTN = '<button class="tool-btn" data-act="table">Table</button>';

    function coachHtml(level, c) {
        if (c && c.index < c.total) {
            const marks = [];
            for (let i = 0; i < c.total; i++) marks.push(i < c.index ? 'done' : i === c.index ? 'active' : '');
            return `<div class="status-row"><span class="status-step">Step ${c.index + 1} of ${c.total}</span>`
                + `<span class="status-text">${c.text}</span>`
                + `<span class="status-actions">${TABLE_BTN}</span></div>${caseBar(marks)}`;
        }
        if (gameProgress.completed[level.id]) {
            const next = G.nextLevel(level.id);
            return `<div class="status-row"><span class="level-done">✓ Solved</span>`
                + `<span class="status-text">${next ? 'On to the next one when you are ready.'
                    : 'That is the last level built so far.'}</span>`
                + `<span class="status-actions">${nextLevelButton(level)}${TABLE_BTN}</span></div>`;
        }
        const idle = packStage(level) ? level.pack.text : 'Build it, then press <b>Verify</b> to test it.';
        return `<div class="status-row"><span class="status-text">${c ? c.text : idle}</span>`
            + `<span class="status-actions">${TABLE_BTN}</span></div>`;
    }

    function verifyHtml(s) {
        const level = s.level, result = s.result, n = result.cases.length;
        const unit = level.sequential ? 'step' : 'case';
        const tableBtn = TABLE_BTN;
        let row;
        if (!s.done) {
            // While a case runs, its inputs; once it has settled, what came
            // out — so a case whose answer is "nothing lights" still visibly
            // happens, instead of flashing past looking like no case at all.
            const c = result.cases[Math.max(0, s.index)];
            const shown = s.shown && s.shown.index === s.index ? s.shown : null;
            const outcome = shown
                ? ' → ' + level.outputs.map((o) => `<b>${o}=${shown.got[o]}</b>`).join(' ')
                    + (shown.ok ? ' <span class="mark-ok">✓</span>' : ' <span class="mark-bad">✗</span>')
                : '…';
            row = `<span class="status-text">${level.sequential ? 'Step' : 'Case'} ${s.index + 1} of ${n}: `
                + `${bits(level.inputs, c.inputs)}${outcome}</span>`
                + `<span class="status-actions">${tableBtn}</span>`;
        } else if (result.passed && s.verdict && !s.verdict.solved) {
            // Right answers, and something still wanted: fewer muxes, or
            // the circuit packed into its square.
            row = `<span class="result-partial">✓ It works</span>`
                + `<span class="status-text">${s.firstPack ? level.pack.text.replace(/^It works\. /, '') : s.verdict.why}</span>`
                + `<span class="status-actions">${tableBtn}</span>`;
        } else if (result.passed) {
            // A packed level says how it came out — stacked, how often it
            // repeats — and the record.
            const core = s.verdict && s.verdict.core, per = s.verdict && s.verdict.period;
            const rec = level.pack && level.pack.record;
            const packed = !core ? '' : (() => {
                const w = core.x1 - core.x0 + 1, h = core.y1 - core.y0 + 1;
                const size = ` Packed into ${w}×${h}${per ? `, it repeats every ${per} rows stacked` : ''}`;
                if (!rec || !per) return size + '.';
                return per <= rec ? `${size} — as good as the best known.` : `${size}; the best known repeats every ${rec}.`;
            })();
            row = `<span class="result-pass">✓ Solved</span>`
                + `<span class="status-text">All ${n} ${unit}s pass${!s.shelved ? ''
                    : s.shelved.compact ? `; it is the <b>${s.shelved.name}</b> part now`
                        : `; it is the <b>${s.shelved.name}</b> part now, a large one — `
                        + `${s.shelved.why.charAt(0).toLowerCase() + s.shelved.why.slice(1)}`}.${packed}</span>`
                + `<span class="status-actions">${nextLevelButton(level)}${tableBtn}</span>`;
        } else {
            const f = result.failure;
            // In a storage level the inputs alone say nothing — the same
            // vector legitimately gives different answers at different points
            // in the run — so the step number is what locates the fault.
            const where = f.step === undefined
                ? bits(level.inputs, f.inputs)
                : `step ${f.step + 1} of ${n} (${bits(level.inputs, f.inputs)})`;
            const wrong = level.outputs.filter((o) => (f.expected[o] & 1) !== (f.actual[o] & 1))
                .map((o) => `<b>${o}</b> should be ${f.expected[o] & 1}, got ${f.actual[o] & 1}`).join('; ');
            const why = f.settled ? wrong : 'it never settles — something keeps changing';
            row = `<span class="result-fail">✗ Not yet</span>`
                + `<span class="status-text">At ${where}: ${why}.</span>`
                + `<span class="status-actions">${tableBtn}</span>`;
        }
        return `<div class="status-row">${row}</div>${caseBar(s.marks)}`;
    }

    function renderStatus() {
        if (!gameLevel) { setGuide(null); return; }
        const c = verifyStatus ? null : G.coachState(gameLevel);
        // The coach's colour-by-number ghost for this step, if it has one.
        setGuide(c && c.guide);
        const html = verifyStatus ? verifyHtml(verifyStatus) : coachHtml(gameLevel, c);
        if (html === lastStatusHtml) return;   // the coach is re-checked often; don't churn the DOM
        lastStatusHtml = html;
        levelStatusEl.innerHTML = html;
    }

    let lastGuideKey = '';
    function setGuide(g) {
        const key = g ? JSON.stringify(g) : '';
        if (key === lastGuideKey) return;
        lastGuideKey = key;
        V.setGuide(g || null);
        V.drawGrid();
    }

    // The pads' names on the board, and while Verify plays, their values:
    // inputs as set, outputs once the case has settled — green if right, red
    // if not. The board shows what the table says, where you are looking.
    // With `expected` null the outputs are shown unjudged: still settling, or
    // in a storage level, where one row's expected value depends on the rows
    // before it.
    function labelPads(level, inputs, got, expected) {
        const COLOR_OK = '#7dffb3', COLOR_BAD = '#ff8a8a', COLOR_VALUE = '#e8e8e8';
        V.setLabels(G.padLabels(level).map((l) => {
            if (inputs && level.inputs.includes(l.text)) return Object.assign(l, { text: `${l.text}=${inputs[l.text] & 1}`, color: COLOR_VALUE });
            if (got && level.outputs.includes(l.text)) {
                if (!expected) return Object.assign(l, { text: `${l.text}=${got[l.text]}`, color: COLOR_VALUE });
                const ok = got[l.text] === (expected[l.text] & 1);
                return Object.assign(l, { text: `${l.text}=${got[l.text]} ${ok ? '✓' : '✗'}`, color: ok ? COLOR_OK : COLOR_BAD });
            }
            return l;
        }));
        V.drawGrid();
    }

    // ---- Trying a row by hand ----
    // Clicking a row of the truth table sets the switches to that row and
    // lets the board run toward it — from wherever it is now, so you watch
    // the charge move rather than a reset. The pads show the outputs as they
    // go, and once the board has stopped changing, whether they match the
    // row.
    let probe = null;   // {level, inputs, expected, prev, quiet}

    function probeRow(i) {
        const level = gameLevel;
        if (!level || tableFor !== level || !tableRows[i]) return;
        abortReplay();
        const c = tableRows[i];
        for (const p of G.layout(level).inputs) M.setToggle(p.x, p.y, !!c.inputs[p.name]);
        probe = { level, row: i, inputs: c.inputs, expected: level.sequential ? null : c.expected, prev: null, quiet: 0 };
        levelTableBodyEl.querySelectorAll('tr.picked').forEach((tr) => tr.classList.remove('picked'));
        const tr = levelTableBodyEl.querySelector(`tr[data-row="${i}"]`);
        if (tr) tr.classList.add('picked');
        labelPads(level, c.inputs, readOutputs(level), null);
    }

    function readOutputs(level) {
        const got = {};
        for (const p of G.layout(level).outputs) got[p.name] = M.ledIsOn(M.getCell(p.x, p.y)) ? 1 : 0;
        return got;
    }

    // Called after each batch of simulation steps while a probe is live.
    function updateProbe() {
        const cur = M.copyCells(), prev = probe.prev;
        let same = !!prev;
        if (same) for (let i = 0; i < cur.length; i++) if (cur[i] !== prev[i]) { same = false; break; }
        probe.prev = cur;
        probe.quiet = same ? probe.quiet + 1 : 0;
        const settled = probe.quiet >= 2;
        const got = readOutputs(probe.level);
        labelPads(probe.level, probe.inputs, got, settled ? probe.expected : null);
        if (!settled) return;
        // Mark the row too, so a table tried row by row fills itself in.
        if (probe.expected) {
            const ok = probe.level.outputs.every((o) => got[o] === (probe.expected[o] & 1));
            const tr = levelTableBodyEl.querySelector(`tr[data-row="${probe.row}"]`);
            if (tr) {
                tr.classList.remove('ok', 'bad');
                tr.classList.add(ok ? 'ok' : 'bad');
                const mark = tr.querySelector('.mark');
                if (mark) mark.textContent = ok ? '✓' : '✗';
            }
        }
        probe = null;
    }

    // Any structural edit. A verdict describes the board it was run on, so an
    // edit retires it and the line goes back to what to do next.
    function boardChanged() {
        if (!gameLevel) return;
        if (replayTimer) abortReplay();
        probe = null;
        if (verifyStatus) {
            verifyStatus = null;
            labelPads(gameLevel);
            // The table stays open — it is a thing to work from — but its
            // marks belonged to the board the verdict was run on.
            fillTable(gameLevel, G.tableCases(gameLevel));
        }
        renderStatus();
    }

    // ---- The truth table, on demand ----
    // It floats above the level bar instead of growing it, so opening it
    // covers part of the board without moving any of it.
    // What the table currently shows: which level, and its rows (inputs and
    // expected outputs, from the last Verify or from the level itself).
    let tableFor = null, tableRows = [];
    function fillTable(level, rows) {
        tableFor = level;
        tableRows = rows;
        levelTableBodyEl.innerHTML = tableHtml(level, rows);
    }

    function openTable() {
        if (tableFor !== gameLevel) fillTable(gameLevel, G.tableCases(gameLevel));
        levelTableEl.style.bottom = (levelBar.offsetHeight + 16) + 'px';
        levelTableEl.classList.add('open');
        const active = levelTableBodyEl.querySelector('tr.active, tr.bad, tr.picked');
        if (active) scrollRowIntoView(active);
    }
    function closeTable() { levelTableEl.classList.remove('open'); }

    // Scrolls only the table's own box. The browser's scrollIntoView walks
    // every scrollable ancestor, and the ones here are overflow:hidden
    // containers of the whole app.
    function scrollRowIntoView(tr) {
        const body = levelTableBodyEl, b = body.getBoundingClientRect(), r = tr.getBoundingClientRect();
        const head = body.querySelector('th');
        const top = b.top + (head ? head.getBoundingClientRect().height : 0);
        if (r.top < top) body.scrollTop -= top - r.top;
        else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom;
    }

    // Solving a level makes its circuit that level's part (G.makeLevelPart),
    // which is how the next level gets built from it rather than by drawing
    // it all again. Returns the part's name, or null.
    function shelveSolution(level) {
        if (!level.part) return null;
        const res = G.makeLevelPart(level);
        return res.ok ? { name: level.part, compact: res.compact, why: res.why } : null;
    }

    // ---- Verify: the verdict, then the demonstration ------------------------
    //
    // Two passes, and the split is the point. `G.verify` decides in a few
    // milliseconds; announcing that and stopping is what made this
    // anticlimactic — you build a circuit and a word appears. So the verdict
    // comes first (instant, and correct even if the run is interrupted), and
    // then the SAME vectors are driven through the board again slowly,
    // letting charge actually travel, with the status line's bar marking each
    // case off as it goes.
    //
    // A failing run stops at the offending case and leaves the board standing
    // in that state, inputs and all. That is the most useful thing it can do:
    // the circuit is sitting there getting the wrong answer, and you can look
    // at where the charge went.
    let replayTimer = null;
    // What to show if the replay is cut short (see startReplay).
    let replayOnAbort = null;

    function stopReplay() {
        cancelAnimationFrame(replayTimer);
        replayTimer = null;
        replayOnAbort = null;
        levelTableEl.classList.remove('running');
    }
    // Interrupting the performance must not interrupt the result: a touch on
    // the board mid-replay jumps straight to how it ends.
    function abortReplay() {
        if (!replayTimer) return;
        const finish = replayOnAbort;
        stopReplay();
        if (finish) finish();
    }

    // The truth table, all rows up front: inputs, what is wanted, and a slot
    // for what the board actually does, filled as the replay reaches each row.
    function tableHtml(level, cases) {
        const head = level.inputs.map((n) => `<th>${n}</th>`).join('')
            + '<th class="sep">→</th>'
            + level.outputs.map((n) => `<th>${n}</th>`).join('')
            + '<th></th>';
        const rows = cases.map((c, i) => {
            const ins = level.inputs.map((n) => `<td class="bits">${c.inputs[n] & 1}</td>`).join('');
            const outs = level.outputs.map((n) => `<td class="bits">${c.expected[n] & 1}</td>`).join('');
            return `<tr data-row="${i}"><td class="idx">${level.sequential ? i + 1 : ''}</td>`
                + `${ins}<td class="sep"></td>${outs}<td class="mark"></td></tr>`;
        }).join('');
        return `<table class="result-table truth"><tr><th class="idx"></th>${head}</tr>${rows}</table>`;
    }

    // One case reaches a new state: its segment in the bar, its row in the
    // table, and the "checking case N" text.
    function markRow(i, state) {
        if (!verifyStatus) return;
        verifyStatus.marks[i] = state;
        if (state === 'active') verifyStatus.index = i;
        const tr = levelTableBodyEl.querySelector(`tr[data-row="${i}"]`);
        if (tr) {
            tr.className = state;                   // 'active' | 'ok' | 'bad'
            const mark = tr.querySelector('.mark');
            if (mark) mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : '';
            if (state !== 'ok' && levelTableEl.classList.contains('open')) scrollRowIntoView(tr);
        }
        renderStatus();
    }

    // How many simulation ticks to run per animation frame. Small vector sets
    // get the slow, watchable version; a fifty-row table would take a minute
    // at that rate, so bigger ones speed up rather than being cut short.
    const replayRate = (n) => (n <= 8 ? 1 : n <= 20 ? 3 : 8);

    // How long a settled case stays on screen before the next one, in frames.
    // A case whose answer is "nothing lights" changes nothing on the board, so
    // this pause — with the pads showing their values — is all there is to
    // see; at a sixth of a second it was not visibly a case at all.
    const replayHold = (n) => (n <= 8 ? 50 : n <= 20 ? 24 : 5);

    // A case the verdict already knows never settles plays for this many
    // frames — long enough to see the flicker — and then stops. Playing out
    // the whole settle budget, at one tick a frame, made Verify look hung.
    const UNSETTLED_FRAMES = 80;

    function startReplay(level, result, onDone) {
        const r = G.replay(level);
        const rate = replayRate(result.cases.length);
        const holdFrames = replayHold(result.cases.length);
        let hold = 0, started = false, pending = null, caseFrames = 0;
        r.start();
        levelTableEl.classList.add('running');
        replayOnAbort = () => onDone(result.passed);

        const frame = () => {
            replayTimer = requestAnimationFrame(frame);
            if (hold > 0) { hold--; return; }
            const begin = (i) => {
                r.begin(i);
                caseFrames = 0;
                labelPads(level, r.vectorAt(i));
                markRow(i, 'active');
            };
            if (!started) { started = true; begin(0); }
            else if (pending !== null) {
                // The pause after a case is over: on to the next, or done.
                const i = pending;
                pending = null;
                if (i >= result.cases.length) { stopReplay(); onDone(true); return; }
                begin(i);
            }
            let settled = false;
            for (let i = 0; i < rate && !settled; i++) settled = r.tick();
            V.drawGrid();
            const known = result.cases[r.index];
            if (!settled && known && !known.settled && ++caseFrames >= UNSETTLED_FRAMES) settled = true;
            if (!settled) return;

            const c = result.cases[r.index];
            const got = r.outputs();
            verifyStatus.shown = { index: r.index, got, ok: !!(c && c.ok) };
            labelPads(level, r.vectorAt(r.index), got, c.expected);
            markRow(r.index, c && c.ok ? 'ok' : 'bad');
            // Stop where it went wrong, board and all — see above.
            if (c && !c.ok) { stopReplay(); onDone(false); return; }
            pending = r.index + 1;
            hold = holdFrames;
        };
        replayTimer = requestAnimationFrame(frame);
    }

    function doVerify() {
        if (!gameLevel) return;
        abortReplay();
        const level = gameLevel;

        // The verdict, off-screen and instant. The board is restored exactly,
        // so the replay below starts from the circuit as the player left it.
        const result = G.verify(level);

        // A pass is final the moment the verdict is in, so it is recorded
        // now rather than when the replay finishes. It used to wait for the
        // end of the show, and touching the board, leaving the level or
        // reloading while a long table was still playing threw the pass
        // away and left the next level locked. Shelving it now also takes
        // the circuit exactly as verified, before anything else is drawn.
        // Right answers may not be all the level asks (see G.judge).
        const verdict = G.judge(level, result);
        let shelved = null, firstPack = false;
        if (result.passed && verdict.solved) {
            gameProgress.completed[level.id] = true;
            delete gameProgress.reached[level.id];
            G.saveProgress(gameProgress);
            shelved = shelveSolution(level);
        } else if (result.passed && verdict.stage === 'pack') {
            // The first stage is done: the square appears, for good.
            firstPack = gameProgress.reached[level.id] !== 'pack';
            gameProgress.reached[level.id] = 'pack';
            G.saveProgress(gameProgress);
            showTargetRect(level);
            V.drawGrid();
        }

        verifyStatus = {
            level, result, shelved, verdict, firstPack, done: false, index: 0,
            marks: result.cases.map(() => ''),
        };
        fillTable(level, result.cases);
        levelTableBodyEl.scrollTop = 0;
        renderStatus();

        startReplay(level, result, (passed) => {
            // The board may have moved on by the time an interrupted replay
            // reports in; its status line is not ours to write.
            if (gameLevel !== level || !verifyStatus || verifyStatus.result !== result) return;
            // Whether it ran to the end or was cut short, mark every case up
            // to the verdict: all of them for a pass, up to the failing one
            // for a fail.
            const upTo = passed ? result.cases.length : result.cases.indexOf(result.failure) + 1;
            for (let i = 0; i < upTo; i++) markRow(i, result.cases[i].ok ? 'ok' : 'bad');
            verifyStatus.done = true;
            renderStatus();
        });
    }

    // ---- Level browser ----
    function renderLevels() {
        levelsListEl.innerHTML = '';
        for (const chapter of G.CHAPTERS) {
            const section = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'chapter-title';
            title.textContent = chapter.title;
            const blurb = document.createElement('div');
            blurb.className = 'chapter-blurb';
            blurb.textContent = chapter.blurb;
            section.append(title, blurb);

            const levels = G.levelsIn(chapter.id);
            if (levels.length) {
                const list = document.createElement('div');
                list.className = 'chapter-levels';
                for (const level of levels) {
                    const done = !!gameProgress.completed[level.id];
                    const open = G.isUnlocked(level.id, gameProgress);
                    const row = document.createElement('button');
                    row.className = 'level-row' + (gameLevel && gameLevel.id === level.id ? ' current' : '');
                    row.disabled = !open;
                    row.title = open ? level.brief : 'Solve the level before it to unlock this one';
                    const status = document.createElement('span');
                    status.className = 'level-status' + (done ? ' done' : '');
                    status.textContent = done ? '✓' : (open ? '·' : '🔒');
                    const name = document.createElement('span');
                    name.className = 'level-row-title';
                    name.textContent = level.title;
                    const sub = document.createElement('span');
                    sub.className = 'level-row-sub';
                    sub.textContent = level.subtitle || '';
                    row.append(status, name, sub);
                    row.addEventListener('click', () => enterLevel(level.id));
                    list.appendChild(row);
                }
                section.appendChild(list);
            }
            if (chapter.roadmap) {
                const strip = document.createElement('div');
                strip.className = 'roadmap';
                for (const item of chapter.roadmap) {
                    const chip = document.createElement('span');
                    chip.textContent = item;
                    strip.appendChild(chip);
                }
                section.appendChild(strip);
            }
            levelsListEl.appendChild(section);
        }
        sandboxBtn.disabled = !gameLevel;
    }

    function openLevels() {
        renderLevels();
        levelsPanel.classList.add('open');
        levelsBackdrop.classList.add('open');
    }
    function closeLevels() {
        levelsPanel.classList.remove('open');
        levelsBackdrop.classList.remove('open');
    }

    // The campaign is the app; the sandbox is the side door. This flips
    // between them and remembers which one you were in.
    function toggleSandbox() {
        setMenuOpen(false);
        if (gameLevel) { exitToSandbox(); return; }
        const resume = gameProgress.current && G.getLevel(gameProgress.current);
        if (resume && G.isUnlocked(resume.id, gameProgress)) enterLevel(resume.id);
        else openLevels();
    }

    function setupCampaign() {
        campaignBtn.addEventListener('click', () => { setMenuOpen(false); openLevels(); });
        levelsCloseBtn.addEventListener('click', closeLevels);
        levelsBackdrop.addEventListener('click', closeLevels);
        levelsBtn.addEventListener('click', openLevels);
        sandboxBtn.addEventListener('click', exitToSandbox);
        sandboxToggleBtn.addEventListener('click', toggleSandbox);
        verifyBtn.addEventListener('click', doVerify);
        // The status line's buttons are re-rendered with it, so they are
        // handled here rather than bound one by one.
        levelStatusEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            if (btn.dataset.act === 'next') enterLevel(btn.dataset.level);
            else if (btn.dataset.act === 'table') {
                if (levelTableEl.classList.contains('open')) closeTable(); else openTable();
            }
        });
        document.getElementById('levelTableCloseBtn').addEventListener('click', closeTable);
        levelTableBodyEl.addEventListener('click', (e) => {
            const tr = e.target.closest('tr[data-row]');
            if (tr) probeRow(Number(tr.dataset.row));
        });
        levelCollapseBtn.addEventListener('click', () => setCollapsed(!levelBarCollapsed));
        hintBtn.addEventListener('click', () => setHintOpen(!levelHintEl.classList.contains('open')));
        resetProgressBtn.addEventListener('click', () => {
            if (!window.confirm('Forget which levels are solved, and discard every level circuit and '
                + 'the parts they made? Your sandbox and your own parts are untouched.')) return;
            for (const level of G.LEVELS) G.clearCircuit(level.id);
            G.clearLevelParts();
            placingPart = null;
            gameProgress = { completed: {}, current: null, reached: {} };
            G.saveProgress(gameProgress);
            if (gameLevel) exitToSandbox(); else renderLevels();
        });
    }

    window.addEventListener('resize', () => {
        syncViewInset();
        V.clampView();          // the old zoom/pan may no longer be legal
        updateZoomLabel();
        V.drawGrid();
    });

    function init() {
        // Levels solved before parts existed get theirs now, from their saved
        // boards, before anything is loaded on top of them.
        G.backfillParts(gameProgress);
        setupToolbar();
        setupCanvasEvents();
        setupCampaign();
        // The campaign is the app's front door. A first-time visitor lands in
        // the tutorial level rather than on an empty board with a rail of
        // tools and no indication of what any of it is for; a returning one
        // lands wherever they left off, sandbox included.
        let resume = gameProgress.mode === 'sandbox' ? null
            : G.getLevel(gameProgress.current) || G.LEVELS[0];
        // The level you were on can be locked now, when a new one has been
        // added in front of it: go to the first open level still unsolved,
        // rather than dropping out to the sandbox.
        if (resume && !G.isUnlocked(resume.id, gameProgress)) {
            resume = G.LEVELS.find((l) => G.isUnlocked(l.id, gameProgress) && !gameProgress.completed[l.id]) || null;
        }
        if (resume && G.isUnlocked(resume.id, gameProgress)) {
            gameLevel = resume;
            gameProgress.current = resume.id;
            G.loadBoard(resume, G.loadCircuit(resume.id));
            V.setLabels(G.padLabels(resume));
            showTargetRect(resume);
            updateLevelBar();
            setRunning(true);
        } else {
            const saved = localStorage.getItem(CIRCUIT_KEY);
            if (saved) M.deserialize(saved);
        }
        applyGridVisibleForMode(drawMode);
        applyPinLabels();
        V.resizeCanvas();
        // A restored viewport belongs to whichever board was on screen; after
        // resuming into a level, fit that level's board instead.
        syncViewInset();
        if (gameLevel || !loadView()) V.fitToWindow();
        else V.clampView();     // a saved sandbox view predates these limits
        updateZoomLabel();
        updateActionButtons();
        V.drawGrid();
        requestAnimationFrame(tickLoop);
    }

    document.addEventListener('DOMContentLoaded', init);

    // Minimal read-only hook for e2e tests: a floating paste's rectangle
    // isn't otherwise observable from outside (its landing spot depends on
    // cursor hover / viewport size), so tests need this to find where to
    // grab it and drag it into place.
    window.PixelogicUI = {
        getFloatRect() { return floatBase ? { x0: floatPos.x, y0: floatPos.y, w: clipboard.w, h: clipboard.h } : null; },
        // Rearrange's selection isn't observable from the DOM, so tests need
        // this to assert what a band/modifier-click actually picked up.
        getArrangeSelection() { return arrangeSel.map((o) => o.cells.map(([x, y]) => [x, y])); },
        // The part the Parts tool has in hand, by key.
        getPlacingPart() { return placingPart ? placingPart.key : null; },
        // What Make part… fitted, while its panel is open.
        getMakePartFit() { return makePartFit ? { core: { ...makePartFit.core }, pins: makePartFit.pins.map((q) => ({ ...q })), edge: makePartFit.edge } : null; },
    };
})(window);
