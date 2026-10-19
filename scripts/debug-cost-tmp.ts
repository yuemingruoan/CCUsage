import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const projects = join(homedir(), ".claude/projects");
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
let lastCost = 0;
let modelCost = 0;
let records = 0;
const samples = [];
for (const file of walk(projects)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("cost-state")) continue;
    try {
      const d = JSON.parse(line);
      const cs = d["cost-state"] ?? d.costState ?? d.cost_state;
      if (!cs) continue;
      records++;
      const total = cs.totalCostUSD ?? cs.total_cost_usd ?? cs.totalCost;
      if (typeof total === "number") lastCost += total;
      const usage = cs.modelUsage ?? cs.model_usage ?? {};
      let sum = 0;
      for (const v of Object.values(usage)) if (v && typeof v === "object" && typeof v.costUSD === "number") sum += v.costUSD;
      modelCost += sum;
      if (samples.length < 3) samples.push({ file: file.split("/").pop(), total, keys: Object.keys(cs), models: Object.keys(usage).slice(0, 4) });
    } catch {}
  }
}
console.log("cost-state records:", records, "| sum totalCostUSD:", lastCost.toFixed(2), "| sum modelUsage costUSD:", modelCost.toFixed(2));
console.log("samples:", JSON.stringify(samples, null, 1));
