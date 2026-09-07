import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const distDataDir = path.resolve("dist", "data");

if (!fs.existsSync(distDataDir)) {
  console.error("No dist/data directory found; run npm run build before auditing edges.");
  process.exit(1);
}

const lineageFiles = fs.readdirSync(distDataDir)
  .filter((file) => file.endsWith("-lineage.json"))
  .sort();

const failures = [];
let totalNodes = 0;
let totalEdges = 0;

if (!lineageFiles.length) {
  console.error("No lineage files found; run npm run build before auditing edges.");
  process.exit(1);
}

for (const file of lineageFiles) {
  const filePath = path.join(distDataDir, file);
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const payload = document.payload || document;
  const nodeIds = new Set((payload.nodes || []).map((node) => node.id));
  const edges = payload.edges || [];

  totalNodes += nodeIds.size;
  totalEdges += edges.length;

  if (!nodeIds.size) {
    failures.push(`${file}: contains no visible nodes`);
  }

  if (payload.target?.categoryKey !== "input_layer" && edges.length === 0) {
    failures.push(`${file}: non-Input-Layer graph contains no lineage edges`);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      failures.push(`${file}: edge ${edge.id || "(unnamed)"} references missing source ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      failures.push(`${file}: edge ${edge.id || "(unnamed)"} references missing target ${edge.target}`);
    }
  }
}

if (totalEdges === 0) {
  failures.push("all generated lineage graphs contain zero edges");
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} invalid lineage edge reference(s):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Audited ${lineageFiles.length} lineage file(s), ${totalNodes} visible nodes, and ${totalEdges} edges; all endpoints resolve.`
);
