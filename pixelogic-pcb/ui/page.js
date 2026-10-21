// The page: its elements, looked up once (module scripts run after the
// document is parsed), and the status line's passing messages.

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
const arrayEditBtn = document.getElementById('arrayEditBtn');
// Make part…, on the board: the bar over it while a part is being drawn.
const partBarEl = document.getElementById('partBar');
const partNameEl = document.getElementById('partName');
const partMsgEl = document.getElementById('partMsg');
const partOkBtn = document.getElementById('partOkBtn');
// A part's copies set out on the board: the bar over it while they are.
const arrayBarEl = document.getElementById('arrayBar');
const arrayMsgEl = document.getElementById('arrayMsg');
const arrayOkBtn = document.getElementById('arrayOkBtn');
const arrayCountEl = document.getElementById('arrayCountInput');
const handBarEl = document.getElementById('handBar');
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
const levelTableHintEl = document.getElementById('levelTableHint');
const hintBtn = document.getElementById('hintBtn');
const verifyBtn = document.getElementById('verifyBtn');
const levelsBtn = document.getElementById('levelsBtn');
const levelCollapseBtn = document.getElementById('levelCollapseBtn');
const sandboxToggleBtn = document.getElementById('sandboxToggleBtn');
// Save as: a new part of your own, or an existing part — a level's,
// which must then pass that level's tests, or one of your own. Either
// way the circuit becomes the part where it stands.
const partAsEl = document.getElementById('partAs');

// The scope (scope.js).
const scopeEl = document.getElementById('scope');
const scopeTitleEl = document.getElementById('scopeTitle');
const scopeCollapseBtn = document.getElementById('scopeCollapseBtn');
const scopeLiveCtl = document.getElementById('scopeLiveCtl');
const scopeReportCtl = document.getElementById('scopeReportCtl');
const scopeRunBtn = document.getElementById('scopeRunBtn');
const scopeSingleBtn = document.getElementById('scopeSingleBtn');
const scopeClearBtn = document.getElementById('scopeClearBtn');
const scopePadsBtn = document.getElementById('scopePadsBtn');
const scopeTimingBtn = document.getElementById('scopeTimingBtn');
const scopeLiveBtn = document.getElementById('scopeLiveBtn');
const scopeScenariosEl = document.getElementById('scopeScenarios');
const scopeTrigProbeEl = document.getElementById('scopeTrigProbe');
const scopeTrigEdgeEl = document.getElementById('scopeTrigEdge');
const scopeZoomInBtn = document.getElementById('scopeZoomInBtn');
const scopeZoomOutBtn = document.getElementById('scopeZoomOutBtn');
const scopeFitBtn = document.getElementById('scopeFitBtn');
const scopeResetBtn = document.getElementById('scopeResetBtn');
const scopeReadEl = document.getElementById('scopeRead');
const scopeSummaryEl = document.getElementById('scopeSummary');
const scopeNamesEl = document.getElementById('scopeNames');
const scopeCanvas = document.getElementById('scopeCanvas');
// Asking the player something (ask.js).
const askDialogEl = document.getElementById('askDialog');
const askTextEl = document.getElementById('askText');
const askInputEl = document.getElementById('askInput');
const askOkBtn = document.getElementById('askOkBtn');
const askCancelBtn = document.getElementById('askCancelBtn');

let statusTimer = null;
function flashStatus(msg) {
    statusEl.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
}

export {
    playPauseBtn, zoomValueEl, intervalSlider, intervalValueEl, statusEl, pasteBtn, copyBtn, cutBtn,
    rotateBtn, mirrorBtn, deleteBtn, undoBtn, redoBtn, saveComponentBtn, componentsBtn, componentsPanel,
    componentsBackdrop, componentsCloseBtn, componentsListEl, componentsEmptyEl, lidBtn, decapBtn, arrayEditBtn,
    partBarEl, partNameEl, partMsgEl, partOkBtn, arrayBarEl, arrayMsgEl, arrayOkBtn,
    arrayCountEl, handBarEl, selectionActionsEl, menuBtn, menuPanel, menuBackdrop,
    fullscreenBtn, gridToggleBtn, pinLabelsBtn, straightBtn, campaignBtn, levelsPanel, levelsBackdrop,
    levelsCloseBtn, levelsListEl, sandboxBtn, resetProgressBtn, levelBar, levelTitleEl, levelBriefEl,
    levelHintEl, levelStatusEl, levelTableEl, levelTableBodyEl, levelTableHintEl, hintBtn, verifyBtn, levelsBtn,
    levelCollapseBtn, sandboxToggleBtn, partAsEl, askDialogEl, askTextEl, askInputEl, askOkBtn, askCancelBtn,
    scopeEl, scopeTitleEl, scopeCollapseBtn, scopeLiveCtl, scopeReportCtl, scopeRunBtn, scopeSingleBtn, scopeClearBtn,
    scopePadsBtn, scopeTimingBtn, scopeLiveBtn, scopeScenariosEl, scopeTrigProbeEl, scopeTrigEdgeEl, scopeZoomInBtn,
    scopeZoomOutBtn, scopeFitBtn, scopeResetBtn, scopeReadEl, scopeSummaryEl, scopeNamesEl, scopeCanvas,
    statusTimer, flashStatus,
};
