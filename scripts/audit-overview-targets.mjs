import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const overviewPath = path.resolve("dist", "data", "system_overview-lineage.json");

const expectedTargets = [
  "input_layer__eligibility",
  "input_layer__medical_claim",
  "input_layer__pharmacy_claim",
  "input_layer__provider_attribution",
  "input_layer__patient",
  "normalized_eligibility",
  "normalized_medical_claim",
  "normalized_pharmacy_claim",
  "normalized_attribution",
  "claims_enrollment",
  "encounters",
  "claims_member_month",
  "service_categories",
  "provider_attribution",
  "eligibility",
  "medical_claim",
  "member_month",
  "cost",
  "utilization"
];

if (!fs.existsSync(overviewPath)) {
  console.error("Missing dist/data/system_overview-lineage.json; run npm run build:local first.");
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(overviewPath, "utf8"));
const overviewTargetKeys = new Set((payload.targets || []).map((target) => target?.key).filter(Boolean));

const missingTargets = expectedTargets.filter((targetKey) => !overviewTargetKeys.has(targetKey));

if (missingTargets.length > 0) {
  console.error("The overview is missing expected DAG targets:");
  for (const targetKey of missingTargets) {
    console.error(`- ${targetKey}`);
  }
  process.exit(1);
}

console.log(`Audited system overview; found ${expectedTargets.length} expected DAG target(s).`);
