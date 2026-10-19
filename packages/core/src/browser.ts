// Browser-safe entry point for the React renderer.
//
// Identical surface to "./pure.js" (the Electron build aliases @ccusage/core to the pure
// modules too), but exposed as the explicit "@ccusage/core/browser" subpath requested by the
// renderer. Everything reachable from here is pure — no node:fs / node:crypto / node:http:
// data model, pricing, formatting and aggregation helpers only.
//
// Renderer value imports: import { Format, ... } from "@ccusage/core/browser";
// Type-only imports may keep using "@ccusage/core" (erased at build time).
export * from "./pure.js";
