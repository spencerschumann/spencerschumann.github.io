// Display preferences: the grid's visibility (kept apart for building and
// for Interact) and the mux pin labels.

import {
    gridToggleBtn, pinLabelsBtn,
} from './page.js';
import {
    gameLevel,
} from './campaign.js';

const V = window.PixelogicView;
const S = window.PixelogicStorage;

// Grid-line visibility remembers separate on/off preferences for build
// tools vs. Interact (the anticipated default: on while drawing, off
// while interacting), rather than one flag shared across both.
let gridVisibleBuild = true, gridVisibleInteract = false;

function loadGridVisiblePrefs() {
    const raw = S.getJSON(S.KEYS.gridVisible, null);
    if (raw && typeof raw.build === 'boolean' && typeof raw.interact === 'boolean') {
        gridVisibleBuild = raw.build;
        gridVisibleInteract = raw.interact;
    }
}
function saveGridVisiblePrefs() {
    S.setJSON(S.KEYS.gridVisible, { build: gridVisibleBuild, interact: gridVisibleInteract });
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
// The grid toggle: for whichever kind of tool is in hand.
function toggleGridVisible(mode) {
    if (mode === 'interact') gridVisibleInteract = !gridVisibleInteract;
    else gridVisibleBuild = !gridVisibleBuild;
    applyGridVisibleForMode(mode);
    saveGridVisiblePrefs();
}

// ---- Pin labels ----
// SEL/COM/NO/NC printed on every mux. They teach the part, and on a
// board full of muxes they are clutter, so by default ('auto') they are
// on only in a level that asks for them — the mux tutorial — and off
// everywhere else. The menu item switches them on or off for good.
let pinLabelsPref = 'auto';   // 'auto' | 'on' | 'off'
{
    const v = S.getText(S.KEYS.pinLabels);
    if (v === 'on' || v === 'off') pinLabelsPref = v;
}
const pinLabelsShown = () => pinLabelsPref === 'on'
    || (pinLabelsPref === 'auto' && !!(gameLevel && gameLevel.pinLabels));
function applyPinLabels() {
    const on = pinLabelsShown();
    V.setPinLabels(on);
    pinLabelsBtn.setAttribute('aria-pressed', String(on));
}
// The menu item: whatever they are now, the other way, for good.
function togglePinLabels() {
    pinLabelsPref = pinLabelsShown() ? 'off' : 'on';
    S.setText(S.KEYS.pinLabels, pinLabelsPref);
    applyPinLabels();
}

export {
    gridVisibleBuild, gridVisibleInteract, loadGridVisiblePrefs, saveGridVisiblePrefs,
    applyGridVisibleForMode, toggleGridVisible, pinLabelsPref, pinLabelsShown, applyPinLabels,
    togglePinLabels,
};
