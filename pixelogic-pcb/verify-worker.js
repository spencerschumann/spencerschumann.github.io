// verify-worker.js - a level's tests, off the page's thread. It loads the
// same model, levels and game code the page does and runs them on a board
// sent as a save (game.js: runSaved), while the page goes on drawing and
// answering clicks. A job is {id, level, board, g, budget}; the answer is
// {id, result}, or {id, failed} for one the page should run itself. A job
// of kind 'timing' ({..., probes}) measures the board's timing instead
// (timing.js). See game.js, "Off the page's thread".
import './worker-env.js';
import './model/index.js';
import './storage.js';
import './levels.js';
import './game.js';
import './timing.js';

const G = self.PixelogicGame;
const T = self.PixelogicTiming;

self.onmessage = (e) => {
    const { id, kind, level, board, g, budget, probes } = e.data;
    try {
        const result = kind === 'timing'
            ? T.measureSaved(G.getLevel(level), board, g, probes)
            : G.runSaved(G.getLevel(level), board, g, budget);
        self.postMessage({ id, result });
    } catch (err) {
        self.postMessage({ id, failed: String((err && err.message) || err) });
    }
};
