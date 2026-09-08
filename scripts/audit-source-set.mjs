import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const provenancePath = path.resolve("dist", "data", "source-provenance.json");
const manifestPath = path.resolve(".cache", "manifest.json");
const expectedResolvedIds = [
  "tuva-core",
  "ahrq_quality_indicators",
  "ccsr",
  "cms_chronic_conditions",
  "cms_hcc",
  "fhir_preprocessing",
  "nyu_ed_classification",
  "quality_measures",
  "semantic-layer"
];
const expectedPackageTargets = expectedResolvedIds.filter((id) => id !== "tuva-core").map((id) => id === "semantic-layer" ? "semantic_layer" : id);
const acceptedIds = new Set(expectedResolvedIds);
const retiredTargetKeys = ["ahrq_measures", "chronic_conditions", "ed_classification", "key_metrics", "pharmacy", "readmissions"];
const failures = [];

if (!fs.existsSync(provenancePath) || !fs.existsSync(manifestPath)) {
  console.error("Missing generated source provenance or manifest; run npm run build first.");
  process.exit(1);
}

const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const sourcesById = new Map((provenance.sources || []).map((source) => [source.id, source]));

for (const sourceId of expectedResolvedIds) {
  const source = sourcesById.get(sourceId);

  if (!source || source.status !== "resolved") {
    failures.push(`${sourceId} is not resolved`);
    continue;
  }

  if (!/^[0-9a-f]{40}$/i.test(source.revision || "")) {
    failures.push(`${sourceId} does not expose an exact Git revision`);
  }

  if (!/^[0-9a-f]{64}$/i.test(source.contentSha256 || "")) {
    failures.push(`${sourceId} does not expose an exact scanned-content fingerprint`);
  }
}

for (const source of provenance.sources || []) {
  if (!acceptedIds.has(source.id)) {
    failures.push(`unexpected source ${source.id}`);
  }
}

const semanticLayer = sourcesById.get("semantic-layer");
if (semanticLayer?.packageName !== "semantic_layer" || !semanticLayer.repositoryUrl?.includes("/semantic-layer")) {
  failures.push("Semantic Layer repository and dbt package identities must remain distinct");
}

if (sourcesById.get("ccsr")?.packageName !== "ccsr") {
  failures.push("ccsr repository provenance must preserve its ccsr dbt package identity");
}

for (const [nodeId, node] of Object.entries(manifest.nodes || {})) {
  const expectedPrefix = `${node.resource_type}.${node.package_name}.`;

  if (!nodeId.startsWith(expectedPrefix)) {
    failures.push(`${nodeId} is not namespaced by its dbt package`);
  }
}

for (const [nodeId, node] of Object.entries(manifest.sources || {})) {
  const expectedPrefix = `source.${node.package_name}.`;

  if (!nodeId.startsWith(expectedPrefix)) {
    failures.push(`${nodeId} external input is not namespaced by its dbt package`);
  }
}

if ((provenance.unresolvedRefs || []).length) {
  failures.push(`${provenance.unresolvedRefs.length} literal ref(s) remain unresolved`);
}

if (provenance.assetManifests?.length !== 8 || provenance.assetManifests.some((manifest) => !/^[a-f0-9]{64}$/.test(manifest.sha256))) {
  failures.push("all eight asset-bearing sources must record their exact preview manifest hashes");
}

if (!(provenance.externalRefs || []).some((reference) => reference.kind === "connector_input")) {
  failures.push("Core connector-root refs are not represented as external inputs");
}

if (!(provenance.externalRefs || []).some((reference) => reference.kind === "optional_override")) {
  failures.push("optional package override refs are not represented as external inputs");
}

const seedPreviewRoot = path.resolve("dist", "data", "seed-previews");
const displayedSeeds = new Set();
const displayedExternalInputs = new Set();
for (const fileName of fs.readdirSync(path.resolve("dist", "data")).filter((name) => name.endsWith("-lineage.json"))) {
  const lineage = JSON.parse(fs.readFileSync(path.resolve("dist", "data", fileName), "utf8"));
  for (const node of lineage.payload?.nodes || []) {
    if (node.resourceType === "seed") displayedSeeds.add(node.id);
    if (node.resourceType === "source") displayedExternalInputs.add(node.id);
  }
}
for (const reference of provenance.externalRefs || []) {
  if (!displayedExternalInputs.has(reference.externalNodeId)) failures.push(`${reference.externalNodeId} is absent from every displayed graph`);
}
for (const nodeId of displayedSeeds) {
  if (!fs.existsSync(path.join(seedPreviewRoot, `${nodeId}.json`))) {
    failures.push(`${nodeId} is displayed without a generated seed preview`);
  }
}

if (fs.existsSync(seedPreviewRoot)) {
  for (const fileName of fs.readdirSync(seedPreviewRoot).filter((name) => name.endsWith(".json"))) {
    const preview = JSON.parse(fs.readFileSync(path.join(seedPreviewRoot, fileName), "utf8"));

    if (preview.sourceUrl?.includes("/latest/")) {
      failures.push(`${preview.name} uses a mutable latest seed-preview URL`);
    }

    if (preview.sourceUnavailableReason) {
      failures.push(`${preview.name} has no immutable seed-preview source: ${preview.sourceUnavailableReason}`);
    }

    if (preview.sourceUrl && preview.sourceError) {
      failures.push(`${preview.name} seed preview failed: ${preview.sourceError}`);
    }

    if (preview.sourceUrl && !/^[0-9a-f]{64}$/i.test(preview.contentSha256 || "")) {
      failures.push(`${preview.name} downloaded seed preview has no content fingerprint`);
    }
  }
}

const overview = JSON.parse(
  fs.readFileSync(path.resolve("dist", "data", "system_overview-lineage.json"), "utf8")
);
const targetKeys = new Set((overview.targets || []).map((target) => target.key));
const targetsByKey = new Map((overview.targets || []).map((target) => [target.key, target]));

for (const targetKey of expectedPackageTargets) {
  if (!targetKeys.has(targetKey)) {
    failures.push(`missing standalone-package target ${targetKey}`);
  }
}

if (targetsByKey.get("fhir_preprocessing")?.categoryLabel !== "Extensions") {
  failures.push("fhir_preprocessing must be published as an Extension, not a Data Mart");
}

for (const targetKey of retiredTargetKeys) {
  if (targetKeys.has(targetKey)) {
    failures.push(`retired target ${targetKey} is still published`);
  }
}


if (failures.length) {
  console.error(`Found ${failures.length} source-set problem(s):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

for (const source of provenance.sources || []) {
  if (source.status === "resolved" && source.dirty) {
    console.warn(
      `Warning: ${source.id} was built from a dirty ${source.sourceMode}; exact scanned content is ${source.contentSha256}.`
    );
  }

  if (
    source.status === "resolved" &&
    source.sourceMode !== "git_clone" &&
    source.refMatchesRevision === false
  ) {
    console.warn(
      `Warning: ${source.id} local revision ${source.revision} differs from configured ${source.configuredRef} at ${source.configuredRefRevision}.`
    );
  }
}

console.log(
  `Audited ${expectedResolvedIds.length} resolved repositories, ${Object.keys(manifest.nodes || {}).length} namespaced resources, ${(provenance.externalRefs || []).length} external refs, including Semantic Layer.`
);

if ((provenance.dynamicRefs || []).length) {
  console.error(`${provenance.dynamicRefs.length} dynamic ref expression(s) remain unresolved.`);
  process.exit(1);
}
