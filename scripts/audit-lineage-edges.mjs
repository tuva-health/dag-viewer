import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const distDataDir = path.resolve("dist", "data");

if (!fs.existsSync(distDataDir)) {
  console.log("No dist/data directory found; run npm run build:local before auditing edges.");
  process.exit(0);
}

const lineageFiles = fs.readdirSync(distDataDir)
  .filter((file) => file.endsWith("-lineage.json"))
  .sort();

const failures = [];

for (const file of lineageFiles) {
  const filePath = path.join(distDataDir, file);
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const nodeIds = new Set((payload.nodes || []).map((node) => node.id));

  for (const edge of payload.edges || []) {
    if (!nodeIds.has(edge.source)) {
      failures.push(`${file}: edge ${edge.id || "(unnamed)"} references missing source ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      failures.push(`${file}: edge ${edge.id || "(unnamed)"} references missing target ${edge.target}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} invalid lineage edge reference(s):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Audited ${lineageFiles.length} lineage file(s); all edge endpoints resolve to visible nodes.`);
