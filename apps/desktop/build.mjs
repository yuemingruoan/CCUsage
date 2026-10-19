#!/usr/bin/env node
// Build the Electron desktop app.
//
//   node apps/desktop/build.mjs            # one-shot build into apps/desktop/dist
//   node apps/desktop/build.mjs --watch    # esbuild watch + copy static files on change
//
// Bundles:
//   src/main/index.ts      -> dist/main.cjs          (cjs, node, electron external)
//   src/main/scanner-worker.ts -> dist/scanner-worker.cjs
//   src/preload/index.ts   -> dist/preload.cjs       (cjs, node, electron external)
//   src/renderer/main.tsx  -> dist/renderer.js       (iife, browser, jsx automatic)
//   src/renderer/tray.tsx  -> dist/tray.js           (iife, browser, jsx automatic)
// Copies src/renderer/** static files (html/css/assets/...) and apps/desktop/assets/**
// into dist/ so the main process can load them with loadFile()/nativeImage.
//
// esbuild is a repo-root devDependency; never install anything here.
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(fileURLToPath(import.meta.url));
const srcDir = join(appRoot, "src");
const distDir = join(appRoot, "dist");
const rendererDir = join(srcDir, "renderer");
const assetsDir = join(appRoot, "assets");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");
const logLevel = process.argv.includes("--silent") ? "warning" : "info";

const nodeBuild = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel,
  define: {
    "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
  },
};

const coreDistDir = resolve(appRoot, "..", "..", "packages", "core", "dist");

/**
 * The renderer imports pure helpers from @ccusage/core (Pricing, Format, buckets, modelTotals, …).
 * The package's ESM index also re-exports node-only modules (scanner / quota / sync-client), which
 * cannot be bundled for the browser. Alias the package in browser builds to a virtual entry with
 * only the pure modules — the type checker still sees the full package.
 */
const coreBrowserEntryPlugin = {
  name: "ccusage-core-browser-entry",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@ccusage\/core$/ }, () => ({ path: "ccusage-core-browser", namespace: "ccusage-core" }));
    buildApi.onLoad({ filter: /.*/, namespace: "ccusage-core" }, () => {
      const exportAll = (file) => "export * from " + JSON.stringify(join(coreDistDir, file)) + ";";
      return {
        contents: [exportAll("types.js"), exportAll("pricing.js"), exportAll("format.js"), exportAll("aggregation.js")].join("\n"),
        loader: "js",
        resolveDir: coreDistDir,
      };
    });
  },
};

const browserBuild = {
  bundle: true,
  plugins: [coreBrowserEntryPlugin],
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".png": "file", ".svg": "file", ".jpg": "file", ".jpeg": "file", ".webp": "file" },
  // The renderer imports pure helpers from @ccusage/core (Format, Pricing, buckets, ...). The
  // package's ESM index also re-exports node-only modules (scanner/quota/sync-client); mark node
  // builtins external so tree-shaken code resolves — the renderer must never call node APIs.
  external: ["node:*"],
  sourcemap: true,
  logLevel,
  define: {
    "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
  },
};

const targets = [
  { name: "main", entry: join(srcDir, "main", "index.ts"), outfile: join(distDir, "main.cjs"), options: nodeBuild },
  { name: "scanner-worker", entry: join(srcDir, "main", "scanner-worker.ts"), outfile: join(distDir, "scanner-worker.cjs"), options: nodeBuild },
  { name: "preload", entry: join(srcDir, "preload", "index.ts"), outfile: join(distDir, "preload.cjs"), options: nodeBuild },
  { name: "renderer", entry: join(rendererDir, "main.tsx"), outfile: join(distDir, "renderer.js"), options: browserBuild },
  { name: "tray", entry: join(rendererDir, "tray.tsx"), outfile: join(distDir, "tray.js"), options: browserBuild },
];

const rendererStaticExtensions = new Set([".html", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".woff", ".woff2", ".ttf", ".json"]);

function copyRendererStatic() {
  if (!existsSync(rendererDir)) return;
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        visit(full);
      } else if (rendererStaticExtensions.has(extname(full).toLowerCase())) {
        const rel = relative(rendererDir, full);
        const out = join(distDir, rel);
        mkdirSync(dirname(out), { recursive: true });
        cpSync(full, out);
      }
    }
  };
  visit(rendererDir);
}

function copyAppAssets() {
  if (!existsSync(assetsDir)) return;
  cpSync(assetsDir, join(distDir, "assets"), { recursive: true });
}

function copyStatic() {
  mkdirSync(distDir, { recursive: true });
  copyAppAssets();
  copyRendererStatic();
}

async function buildTarget(target) {
  if (!existsSync(target.entry)) {
    console.warn("[build] missing entry, skipped:", relative(appRoot, target.entry));
    return null;
  }
  return build({ ...target.options, entryPoints: [target.entry], outfile: target.outfile });
}

async function buildAll() {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  const results = await Promise.allSettled(targets.map(buildTarget));
  // Copy HTML/CSS/assets even when one entry fails so a partially broken renderer still runs.
  copyStatic();
  const built = results.filter((result) => result.status === "fulfilled" && result.value).length;
  console.log(`[build] ${built}/${targets.length} entries, static assets copied -> ${relative(process.cwd(), distDir) || "dist"}`);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    for (const failure of failures) {
      if (failure.status === "rejected") console.error("[build] entry failed:", failure.reason?.message ?? failure.reason);
    }
    process.exitCode = 1;
  }
}

async function watchAll() {
  mkdirSync(distDir, { recursive: true });
  copyStatic();
  const contexts = [];
  for (const target of targets) {
    if (!existsSync(target.entry)) {
      console.warn("[build] missing entry, not watching:", relative(appRoot, target.entry));
      continue;
    }
    const copyStaticPlugin = {
      name: "ccusage-copy-static",
      setup(b) {
        b.onEnd((result) => {
          if (result.errors.length === 0) copyStatic();
        });
      },
    };
    const ctx = await context({
      ...target.options,
      entryPoints: [target.entry],
      outfile: target.outfile,
      plugins: [...(target.options.plugins ?? []), copyStaticPlugin],
    });
    await ctx.watch();
    contexts.push(ctx);
    console.log("[build] watching", relative(appRoot, target.entry));
  }
  if (contexts.length === 0) {
    console.warn("[build] nothing to watch");
    return;
  }
  const shutdown = async () => {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (watch) {
  await watchAll();
} else {
  await buildAll();
}
