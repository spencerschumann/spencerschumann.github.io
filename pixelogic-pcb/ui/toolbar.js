// The controls: the toolbar and the menu, export and import, backup and
// restore, the keyboard, and which action buttons apply right now.

import {
    arrayEditBtn, componentsBackdrop, componentsBtn, componentsCloseBtn,
    componentsPanel, copyBtn, cutBtn, decapBtn, deleteBtn, flashStatus, fullscreenBtn, gridToggleBtn,
    intervalSlider, levelsPanel, lidBtn, partAsEl, partNameEl,
    menuBackdrop, menuBtn, menuPanel, mirrorBtn, pasteBtn, pinLabelsBtn, playPauseBtn, redoBtn, rotateBtn,
    saveComponentBtn, selectionActionsEl, straightBtn, undoBtn,
} from './page.js';
import {
    loadGridVisiblePrefs, toggleGridVisible, togglePinLabels,
} from './prefs.js';
import {
    afterEdit, beginUndoBatch, cancelSave, endUndoBatch, flushSave, gridOrigin, redo, redoStack,
    scheduleSave, scheduleViewSave, undo, undoStack,
} from './history.js';
import {
    drawMode, pickTool, setDrawMode,
} from './tools.js';
import {
    cancelPasteFloat, clipboard, deleteSelected, doCopy, doCut, doMirror, doRotate, floatBase, selection,
    setSelection,
} from './clipboard.js';
import {
    abortArrange, arrange, arrangeSel, setArrangeSel,
} from './arrange.js';
import {
    setStraightLock, straightLock,
} from './paint.js';
import {
    refreshStampPreview,
} from './stamp.js';
import {
    closeComponents, decapSelected, openComponents, placingPart, selectedPart, toggleLid,
} from './parts.js';
import {
    arrayEditState, arrayEditing, closeArray, countInHand, isArrayPart, openArrayInPlace, putDownArray, setArrayCount,
    setEditCount, setupArrayEdit, turnArray,
} from './arrayedit.js';
import {
    closeMakePart, doSaveComponent, finishMakePart, fitPartEdit, makePartAsChanged, partEditChose, partEditing,
} from './makepart.js';
import {
    ask, askText, asking,
} from './ask.js';
import {
    updateZoomLabel, zoomAtCenter,
} from './canvas.js';
import {
    DEFAULT_TPS, running, setRunning, sliderPosForTps, updateIntervalFromSlider,
} from './loop.js';
import {
    closeLevels, gameLevel, levelBarCollapsed, setCollapsed, syncViewInset,
} from './campaign.js';
import {
    exitSteps, stepBack, stepOn, steps,
} from './steps.js';

const M = window.PixelogicModel;
const V = window.PixelogicView;
const S = window.PixelogicStorage;

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

function updateActionButtons() {
    copyBtn.disabled = !selection;
    cutBtn.disabled = !selection;
    // In Rearrange, Rotate acts on the grabbed object, not the region
    // selection (which has no highlight in that mode anyway).
    rotateBtn.disabled = drawMode === 'rearrange' ? !arrangeSel.length : !selection;
    mirrorBtn.disabled = drawMode === 'rearrange' ? !arrangeSel.length : !selection;
    pasteBtn.disabled = !clipboard;
    // Make part… works on the region you can see, in a level or not.
    saveComponentBtn.disabled = !(drawMode === 'select' && selection);
    const part = selectedPart();
    lidBtn.style.display = part ? '' : 'none';
    decapBtn.style.display = part ? '' : 'none';
    // An array picked out can be set out again, to change.
    arrayEditBtn.style.display = part && isArrayPart(part) ? '' : 'none';
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

// ---- Overflow menu ----
function setMenuOpen(open) {
    menuPanel.classList.toggle('open', open);
    menuBackdrop.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
}

function setupToolbar() {
    loadGridVisiblePrefs();
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => pickTool(btn.dataset.tool));
    });
    setDrawMode('conductor');

    gridToggleBtn.addEventListener('click', () => { toggleGridVisible(drawMode); V.drawGrid(); });
    pinLabelsBtn.addEventListener('click', () => { togglePinLabels(); V.drawGrid(); });

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
    document.getElementById('clearBtn').addEventListener('click', async () => {
        if (!await ask('Clear the entire grid?', { ok: 'Clear', danger: true })) return;
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
        flashStatus('Select the part’s bounds — the rectangle that will be its edge — then Make part…');
    });
    partAsEl.addEventListener('change', () => { partEditChose(); makePartAsChanged(); });
    lidBtn.addEventListener('click', () => { const id = selectedPart(); if (id) toggleLid(id); });
    decapBtn.addEventListener('click', decapSelected);
    arrayEditBtn.addEventListener('click', () => { const id = selectedPart(); if (id) openArrayInPlace(id); });
    document.getElementById('partOkBtn').addEventListener('click', finishMakePart);
    document.getElementById('partCancelBtn').addEventListener('click', () => closeMakePart(true));
    document.getElementById('partFitBtn').addEventListener('click', fitPartEdit);
    partNameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finishMakePart();
        if (e.key === 'Escape') closeMakePart(true);
    });
    componentsCloseBtn.addEventListener('click', closeComponents);
    componentsBackdrop.addEventListener('click', closeComponents);
    setupArrayEdit();

    intervalSlider.value = String(sliderPosForTps(DEFAULT_TPS));
    intervalSlider.addEventListener('input', updateIntervalFromSlider);
    updateIntervalFromSlider();

    document.getElementById('exportBtn').addEventListener('click', async () => {
        // The board's JSON saves its cells as runs, so a sparse board is
        // short already; a busy one gzips (+base64) shorter still, as a
        // token prefixed PXLZ1: so import can tell the two apart. Which
        // ever is shorter is what is copied — raw JSON, too, if the
        // browser lacks CompressionStream.
        const json = M.serialize();
        let text = json;
        try {
            if (window.CompressionStream) {
                const token = 'PXLZ1:' + await gzipToBase64(json);
                if (token.length < json.length) text = token;
            }
        } catch (e) { text = json; }
        // navigator.clipboard only exists in a secure context — on a phone
        // hitting a LAN IP over plain HTTP it's undefined, so fall back to a
        // box the user can select-and-copy from.
        const fallback = () => askText('Circuit text — select all and copy:', { value: text, readOnly: true, ok: 'Close' });
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => flashStatus('Copied to clipboard'), fallback);
        } else {
            fallback();
        }
    });
    // Everything the app keeps — progress, every level's board, the
    // parts shelf, the sandbox, preferences — as one file, and back.
    document.getElementById('backupBtn').addEventListener('click', () => {
        setMenuOpen(false);
        flushSave();
        const url = URL.createObjectURL(new Blob([S.backup()], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `pixelogic-pcb-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const restoreFile = document.getElementById('restoreFile');
    document.getElementById('restoreBtn').addEventListener('click', () => { setMenuOpen(false); restoreFile.click(); });
    restoreFile.addEventListener('change', async () => {
        const file = restoreFile.files && restoreFile.files[0];
        restoreFile.value = '';
        if (!file) return;
        if (!await ask('Replace everything here — progress, every level, your parts and the sandbox — with this backup?', { ok: 'Replace', danger: true })) return;
        cancelSave();   // nothing of the board here may land after
        const res = S.restore(await file.text());
        if (res.error) { flashStatus(res.error); return; }
        window.location.reload();
    });
    document.getElementById('importBtn').addEventListener('click', async () => {
        let text = await askText('Paste exported circuit text:', { ok: 'Import' });
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

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (asking()) return;       // the question's own keys: Enter, Esc, Tab

    if (e.key === 'Escape') {
        // Dismissing an open overlay is all Escape does — deselecting
        // under it would be a second, unasked-for action.
        if (menuPanel.classList.contains('open')) { setMenuOpen(false); return; }
        if (levelsPanel.classList.contains('open')) { closeLevels(); return; }
        if (componentsPanel.classList.contains('open')) { closeComponents(); return; }
        if (partEditing()) { closeMakePart(true); return; }
        if (arrayEditing()) { closeArray(); return; }
        if (floatBase) { cancelPasteFloat(); return; } // a paste not yet placed: never mind
        // Stepping through a run, with nothing picked up or picked out.
        if (steps && !arrange && !arrangeSel.length && !selection) { exitSteps(); return; }
        if (arrange) abortArrange();          // mid-drag: put the object back
        else if (arrangeSel.length) { setArrangeSel([]); V.drawGrid(); }
        if (selection) { setSelection(null); V.drawGrid(); }
        return;
    }
    // An open panel owns the keyboard. Keys used to go straight through
    // to the board behind it — a digit switched tools, Space stepped the
    // simulation, Delete offered to clear the grid.
    if (menuPanel.classList.contains('open') || levelsPanel.classList.contains('open') ||
        componentsPanel.classList.contains('open')) return;
    // Making a part owns the keyboard too: Enter makes it, and nothing
    // else changes the board under it.
    if (partEditing()) { if (e.key === 'Enter') finishMakePart(); return; }
    // So does setting out a part's copies: Enter puts them down, [ and ]
    // are one fewer or more, R and M turn and flip them.
    if (arrayEditing()) {
        const k = e.key.toLowerCase();
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // (Not also a press of whatever button has the focus.)
        if (k === 'enter' || k === '[' || k === ']' || k === 'r' || k === 'm') e.preventDefault();
        if (k === 'enter') putDownArray();
        else if (k === '[' || k === ']') setEditCount(arrayEditState().count + (k === ']' ? 1 : -1));
        else if (k === 'r' || k === 'm') turnArray(k === 'm');
        return;
    }
    // [ and ], with a part in hand: one copy fewer or more.
    if ((e.key === '[' || e.key === ']') && drawMode === 'part' && placingPart) {
        setArrayCount(countInHand() + (e.key === ']' ? 1 : -1));
        return;
    }

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

    // Stepping through a run, ← and → go back and on a step; ↑ and ↓
    // still pan.
    if (steps && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') stepBack(); else stepOn();
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
    // reaching for wire. −V before +V, low before high, as 0 before 1:
    // the other way round, the player kept reaching for the wrong one.
    else if (e.key === '1') pickTool('conductor');
    else if (e.key === '2') pickTool('insulator');
    else if (e.key === '3') { if (!e.repeat) pickTool('mux'); }   // held down, it would spin the part
    else if (e.key === '4') pickTool('neg');
    else if (e.key === '5') pickTool('pos');
    else if (e.key === '6') pickTool('led');
    else if (e.key === '7') pickTool('toggle');
    else if (e.key === '8') pickTool('switch');
    else if (e.key === '9') { if (!e.repeat) pickTool('part'); }
    else if (e.key === 'i' || e.key === 'I') setDrawMode('interact');
    else if (e.key === 's' || e.key === 'S') setDrawMode('select');
    else if (e.key === 'a' || e.key === 'A') setDrawMode('rearrange');
    else if (e.key === 'o' || e.key === 'O') setDrawMode('probe');
    else if ((e.key === 'v' || e.key === 'V') && clipboard) setDrawMode('paste');
    else if (e.key === 'r' || e.key === 'R') doRotate();
    else if (e.key === 'm' || e.key === 'M') doMirror();
    else if (e.key === 'f' || e.key === 'F') { V.fitToWindow(); updateZoomLabel(); scheduleViewSave(); V.drawGrid(); }
    else if (e.key === 'g' || e.key === 'G') { if (!gridToggleBtn.disabled) gridToggleBtn.click(); }
    else if ((e.key === 'h' || e.key === 'H') && gameLevel) setCollapsed(!levelBarCollapsed);
    else if (e.key === 'l' || e.key === 'L') setStraightLock(!straightLock);
});

window.addEventListener('resize', () => {
    syncViewInset();
    V.clampView();          // the old zoom/pan may no longer be legal
    updateZoomLabel();
    V.drawGrid();
});

export {
    gzipToBase64, base64ToGunzip, updateActionButtons, setMenuOpen, setupToolbar,
};
