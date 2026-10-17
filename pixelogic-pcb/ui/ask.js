// Asking the player something: a dialog of the page's own, in place of
// the browser's confirm and prompt. A browser embedded in another app may
// never show those — it answers confirm with "no" at once — and Clear
// grid, Delete, Lay out and the rest did nothing there, without a word.

import {
    askCancelBtn, askDialogEl, askInputEl, askOkBtn, askTextEl,
} from './page.js';

let answer = null;      // resolves the question open, if there is one

// Yes or no: true for OK; false for Cancel, Esc or a click outside.
// `ok` names what OK does ('Clear', 'Delete'), `danger` if it destroys.
function ask(text, { ok = 'OK', danger = false } = {}) {
    return open(text, ok, danger, null).then((v) => v !== null);
}
// A line of text: what was typed, or null if not. `value` is in it to
// start with, selected; `readOnly`, to be copied, Close the only button.
function askText(text, { ok = 'OK', value = '', readOnly = false } = {}) {
    return open(text, ok, false, { value, readOnly });
}
const asking = () => !!answer;

function open(text, ok, danger, input) {
    if (answer) settle(null);
    askTextEl.textContent = text;
    askOkBtn.textContent = ok;
    askOkBtn.classList.toggle('danger', danger);
    askOkBtn.classList.toggle('primary', !danger);
    askInputEl.style.display = input ? '' : 'none';
    askCancelBtn.style.display = input && input.readOnly ? 'none' : '';
    if (input) {
        askInputEl.value = input.value;
        askInputEl.readOnly = input.readOnly;
    }
    askDialogEl.showModal();
    if (input) { askInputEl.focus(); askInputEl.select(); } else askOkBtn.focus();
    return new Promise((resolve) => { answer = resolve; });
}
function settle(value) {
    const resolve = answer;
    answer = null;
    if (askDialogEl.open) askDialogEl.close();
    if (resolve) resolve(value);
}

function setupAsk() {
    askOkBtn.addEventListener('click', () => settle(askInputEl.style.display === 'none' ? '' : askInputEl.value));
    askCancelBtn.addEventListener('click', () => settle(null));
    // Esc is the dialog's own cancel; a click on the dimmed page round it
    // lands on the dialog itself, outside its box.
    askDialogEl.addEventListener('cancel', (e) => { e.preventDefault(); settle(null); });
    askDialogEl.addEventListener('click', (e) => { if (e.target === askDialogEl) settle(null); });
    askInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askOkBtn.click(); }
    });
}

export {
    ask, askText, asking, setupAsk,
};
