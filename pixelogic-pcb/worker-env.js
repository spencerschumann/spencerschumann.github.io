// worker-env.js - the app's scripts publish their namespaces on `window`
// (window.PixelogicModel, …). A worker has no window; its global object is
// `self`, so `window` is made to name it before anything else loads.
// verify-worker.js imports this first: imports run in order, and all of
// them before the importing file's own code, so it could not be done there.
globalThis.window = globalThis;
