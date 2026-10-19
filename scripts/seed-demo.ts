#!/usr/bin/env node
// Writes deterministic demo fixtures into demo-data/ for the app, screenshots and tests.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemoDir } from "./demo-fixtures.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.env.CCUSAGE_DEMO_DIR ? join(process.cwd(), process.env.CCUSAGE_DEMO_DIR) : join(root, "demo-data");
const data = seedDemoDir(target);
console.log("demo fixtures written to", target);
console.log("projects:", data.projectsDir, "| sessions:", data.sessions.length);
