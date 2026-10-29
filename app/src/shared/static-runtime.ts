import URLPolyfill from "core-js-pure/actual/url/index.js";

// Bare JavaScriptCore has ECMAScript built-ins, but no WHATWG URL. Keep the
// shared resolver unchanged and install the standard implementation only there.
if (typeof globalThis.URL === "undefined") Object.defineProperty(globalThis, "URL", { value: URLPolyfill, configurable: true, writable: true });
