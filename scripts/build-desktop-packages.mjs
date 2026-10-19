#!/usr/bin/env node
// Packages the Electron app for macOS (.app + zip) and Windows (.exe portable + zip).
//
//   node scripts/build-desktop-packages.mjs --platform=darwin --arch=arm64
//   node scripts/build-desktop-packages.mjs --platform=win32  --arch=x64
//   node scripts/build-desktop-packages.mjs --platform=all
//
// Requires apps/desktop/dist from "npm run build:desktop" (the npm scripts run that first).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { packager } from "@electron/packager";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const appBuild = join(root, "apps/desktop/dist");
if (!existsSync(join(appBuild, "main.cjs"))) {
  console.error("missing apps/desktop/dist/main.cjs — run npm run build:desktop first");
  process.exit(1);
}

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value ?? "true"];
}));
const platform = args.platform ?? "all";
const outRoot = join(root, "dist/packages");
const stageRoot = join(root, "dist/stage");
mkdirSync(outRoot, { recursive: true });
mkdirSync(stageRoot, { recursive: true });

const MAC_ICON = join(root, "apps/desktop/assets/CCUsage.icns");
const WIN_ICON = join(root, "apps/desktop/assets/CCUsage.ico");

function stageApp() {
  const stage = join(stageRoot, "app");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(appBuild, join(stage, "dist"), { recursive: true });
  writeFileSync(join(stage, "package.json"), JSON.stringify({
    name: "ccusage",
    productName: "CCUsage",
    version,
    description: "CCUsage — Claude Code usage, cost and subscription window tracker",
    main: "dist/main.cjs",
    author: "CCUsage",
    license: "MIT",
  }, null, 2) + "\n");
  return stage;
}

function zip(source, destination, keepParent) {
  const zipArgs = ["-c", "-k", "--norsrc"];
  if (keepParent) zipArgs.push("--keepParent");
  zipArgs.push(source, destination);
  const result = spawnSync("ditto", zipArgs, { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ditto failed for " + destination);
}

async function buildDarwin(arch) {
  const stage = stageApp();
  const result = await packager({
    dir: stage,
    out: outRoot,
    name: "CCUsage",
    platform: "darwin",
    arch,
    overwrite: true,
    asar: true,
    prune: true,
    appBundleId: "local.ccusage",
    appCategoryType: "public.app-category.developer-tools",
    appVersion: version,
    buildVersion: version,
    icon: MAC_ICON,
    quiet: true,
    appCopyright: "CCUsage",
  });
  const output = result[0];
  if (!output) throw new Error("darwin package failed");
  // @electron/packager may answer the created output directory or the .app bundle itself.
  const appPath = output.endsWith(".app") ? output : join(output, "CCUsage.app");
  if (!existsSync(appPath)) throw new Error("missing app bundle: " + appPath);
  // Ad-hoc sign so the app launches locally without a developer certificate. Give the
  // packager a moment to flush the bundle, then retry a few times (signing can race the
  // final write of the app's helpers on some filesystems).
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  let signed = { status: 1 };
  for (let attempt = 0; attempt < 3 && signed.status !== 0; attempt++) {
    signed = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
    if (signed.status !== 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  if (signed.status !== 0) {
    console.warn("warning: ad-hoc codesign failed (app still usable locally)");
  } else {
    const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "ignore" });
    console.log("[mac] ad-hoc signed" + (verify.status === 0 ? " (verified)" : " (verify failed)"));
  }
  const target = join(outRoot, "CCUsage-" + version + "-mac-" + arch + ".zip");
  rmSync(target, { force: true });
  zip(appPath, target, true);
  return { appPath, target };
}

async function buildWin32(arch) {
  const stage = stageApp();
  const result = await packager({
    dir: stage,
    out: outRoot,
    name: "CCUsage",
    platform: "win32",
    arch,
    overwrite: true,
    asar: true,
    prune: true,
    icon: WIN_ICON,
    appVersion: version,
    buildVersion: version,
    win32metadata: {
      CompanyName: "CCUsage",
      FileDescription: "CCUsage — Claude Code usage and subscription window tracker",
      ProductName: "CCUsage",
      InternalName: "CCUsage",
      OriginalFilename: "CCUsage.exe",
    },
    quiet: true,
  });
  const outDir = result[0];
  if (!outDir) throw new Error("win32 package failed");
  const exe = join(outDir, "CCUsage.exe");
  if (!existsSync(exe)) throw new Error("missing " + exe);
  const target = join(outRoot, "CCUsage-" + version + "-win-" + arch + ".zip");
  rmSync(target, { force: true });
  zip(outDir, target, true);
  return { appPath: exe, target };
}

const artifacts = [];
if (platform === "all" || platform === "darwin") artifacts.push(await buildDarwin(args.arch ?? "arm64"));
if (platform === "all" || platform === "win32") artifacts.push(await buildWin32(args.arch ?? "x64"));

console.log("");
console.log("desktop packages:");
for (const artifact of artifacts) {
  const size = statSync(artifact.target).size;
  console.log("  " + artifact.target + "  " + (size / 1024 / 1024).toFixed(1) + " MB");
  console.log("    unpacked: " + artifact.appPath);
}