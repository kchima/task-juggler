// Suppresses main.js's real-browser auto-boot (which reads window.cowork,
// not present in jsdom) before any test file imports it.
window.__JUGGLER_TEST__ = true;
