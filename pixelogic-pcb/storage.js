(function (window) {
    // storage.js - everything the app keeps, in one place: which key holds
    // what, reading and writing them (a full, blocked or private-mode store
    // never throws past here), and a backup of all of it to save as a file
    // and load back.
    //
    // Every key starts with PREFIX. The game owns progress, the level
    // circuits, the parts shelf and how parts repeat; the UI owns the
    // sandbox board and the display preferences. A key's name ends in its
    // format's version where the format has had more than one.
    const PREFIX = 'pixelogic-pcb';
    const KEYS = {
        sandbox: 'pixelogic-pcb-circuit',          // the sandbox board (serialize's JSON)
        view: 'pixelogic-pcb.view.v1',             // zoom and pan
        gridVisible: 'pixelogic-pcb.gridVisible.v1',
        pinLabels: 'pixelogic-pcb.pinLabels.v1',
        levelBar: 'pixelogic-pcb.levelBar.v1',     // the level text collapsed
        progress: 'pixelogic-pcb.game.v1',         // solved levels, the current one, the mode
        parts: 'pixelogic-pcb.parts.v1',           // the parts shelf, as clips
        arrays: 'pixelogic-pcb.arrays.v1',         // how each part repeats
        probes: 'pixelogic-pcb.probes.v1',         // the scope's probes, each board's
    };
    // Each level's board, and the layout it was made on.
    const circuitKey = (id) => 'pixelogic-pcb.game.circuit.' + id;
    const circuitLayoutKey = (id) => circuitKey(id) + '.layout';

    function getText(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    // False if it could not be kept (the store full or blocked).
    function setText(key, text) {
        try { localStorage.setItem(key, text); return true; } catch (e) { return false; }
    }
    function remove(key) {
        try { localStorage.removeItem(key); } catch (e) { }
    }
    function getJSON(key, fallback) {
        const t = getText(key);
        if (t === null) return fallback;
        try { return JSON.parse(t); } catch (e) { return fallback; }
    }
    function setJSON(key, value) { return setText(key, JSON.stringify(value)); }

    // Every key the app has, by name.
    function ownKeys() {
        const out = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(PREFIX)) out.push(k);
            }
        } catch (e) { }
        return out;
    }
    // A backup: every key the app has, as it is stored, in one JSON text.
    const BACKUP_FORMAT = 'pixelogic-pcb-backup';
    function backup() {
        const entries = {};
        for (const k of ownKeys()) entries[k] = getText(k);
        return JSON.stringify({ format: BACKUP_FORMAT, version: 1, saved: new Date().toISOString(), entries });
    }
    // Everything the app has, replaced by a backup's. Returns {ok, keys} or
    // {error}; nothing is touched unless the text really is a backup. The
    // page should be reloaded after, so everything is read again.
    function restore(text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) { }
        if (!data || data.format !== BACKUP_FORMAT || !data.entries || typeof data.entries !== 'object')
            return { error: 'That is not a Pixelogic backup' };
        const keys = Object.keys(data.entries).filter((k) => k.startsWith(PREFIX) && typeof data.entries[k] === 'string');
        for (const k of ownKeys()) remove(k);
        let written = 0;
        for (const k of keys) if (setText(k, data.entries[k])) written++;
        return written === keys.length ? { ok: true, keys: written } : { error: `Only ${written} of ${keys.length} could be kept: the store is full` };
    }

    window.PixelogicStorage = {
        PREFIX, KEYS, circuitKey, circuitLayoutKey,
        getText, setText, remove, getJSON, setJSON, ownKeys, backup, restore,
    };
})(window);
