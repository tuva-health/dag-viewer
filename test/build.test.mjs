import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createLiteManifest, readCsvPreviewFromUrl, resolveLogicalCatalogRefs, resolveResourceConfig, validateSourceContract } from "../scripts/build-static-data.mjs";
import { buildSeedViewer, isVisibleSupportingSeed } from "../scripts/build-lineage.mjs";

test("required sources cannot silently become planned or share a dbt namespace", () => {
  const core = { id: "core", packageName: "core", repositoryUrl: "https://example.com/core.git", ref: "abc", role: "core", required: true, status: "active" };
  assert.throws(() => validateSourceContract({ sources: [{ ...core, status: "planned" }] }, "test"), /must be active/);
  assert.throws(() => validateSourceContract({ sources: [core, { ...core, id: "other", role: "mart" }] }, "test"), /Duplicate dbt package/);
});

test("project-level model materialization follows nested package folders", () => {
  const source = {
    packageName: "semantic_layer", modelPaths: ["models"],
    dbtProject: { models: { semantic_layer: { "+schema": "semantic_layer", semantic_layer: { staging: { "+materialized": "ephemeral" }, final: { "+materialized": "table" } } } } }
  };
  assert.deepEqual(resolveResourceConfig(source, "models/semantic_layer/final/fact.sql", "model"), { schema: "semantic_layer", materialized: "table" });
  assert.equal(resolveResourceConfig(source, "models/semantic_layer/staging/stage.sql", "model").materialized, "ephemeral");
});

test("missing model refs and undeclared connector typos fail the manifest build", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dag-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "models/input_layer"), { recursive: true });
  const file = "models/input_layer/input_layer__patient.sql";
  const source = {
    id: "tuva-core", packageName: "the_tuva_project", role: "core", state: "resolved", root,
    connectorRefs: ["patient"], files: [file], modelPaths: ["models"], seedPaths: ["seeds"],
    dbtProject: {}, provenance: { id: "tuva-core", status: "resolved" }
  };
  await writeFile(path.join(root, file), "select * from {{ ref('patinet') }}");
  await assert.rejects(createLiteManifest({ sources: [source] }), /patinet/);
  await writeFile(path.join(root, file), "select * from {{ ref('patient') }}");
  const manifest = await createLiteManifest({ sources: [source] });
  assert.deepEqual(manifest.nodes["model.the_tuva_project.input_layer__patient"].depends_on.nodes, ["source.the_tuva_project.patient"]);
  assert.equal(manifest.metadata.tuva_dag.externalRefs[0].kind, "connector_input");
  await mkdir(path.join(root, "seeds"));
  await writeFile(path.join(root, "seeds/map.csv"), "id\n");
  source.files.push("seeds/map.csv");
  const withSeed = await createLiteManifest({ sources: [source] });
  assert.equal(withSeed.nodes["seed.the_tuva_project.map"].schema, "target.schema");
});

test("package seed previews follow independent asset versions and actual loader paths", () => {
  const node = { unique_id: "seed.ccsr.map", resource_type: "seed", config: { post_hook: "{{ the_tuva_project.load_package_seed('data-marts/ccsr', var('ccsr_data_asset_version'), 'map.csv.gz') }}" }, tuva_source: { assetPrefix: "data-marts/ccsr", assetVersion: "1.0.0", packageVersion: "0.1.0" } };
  assert.equal(buildSeedViewer(node).downloadUrl, "https://tuva-public-resources.s3.amazonaws.com/data-marts/ccsr/1.0.0/map.csv.gz");
  assert.throws(() => buildSeedViewer({ ...node, tuva_source: { ...node.tuva_source, assetPrefix: "wrong" } }), /differs from loader/);
  const semantic = { ...node, config: { post_hook: "{{ semantic_layer.load_semantic_layer_seed('keys.csv.gz') }}" }, tuva_source: { assetPrefix: "data-marts/semantic-layer", assetVersion: "2.0.0" } };
  assert.match(buildSeedViewer(semantic).downloadUrl, /data-marts\/semantic-layer\/2.0.0\/keys.csv.gz$/);
  assert.equal(isVisibleSupportingSeed({ ...node, name: "map", original_file_path: "seeds/map.csv" }), true);
});

test("streamed gzip previews count CSV records and hash raw objects with Content-Encoding", async (t) => {
  const payload = gzipSync('id,description\n1,"first\nsecond"\n2,"quoted ""word"", comma"\n');
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/csv", "Content-Encoding": "gzip" });
    response.end(request.url === "/broken.gz" ? Buffer.from("not gzip") : payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const preview = await readCsvPreviewFromUrl(`${base}/seed.gz`, 1, ["id", "description"]);
  assert.deepEqual(preview.rows, [["1", "first\nsecond"]]);
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.truncated, true);
  assert.equal(preview.contentSha256, createHash("sha256").update(payload).digest("hex"));
  await assert.rejects(readCsvPreviewFromUrl(`${base}/seed.gz`, 1, ["wrong"]), /header mismatch/);
  await assert.rejects(readCsvPreviewFromUrl(`${base}/broken.gz`, 1), /header check/);
});

test("logical catalog unions preserve chunk ordering across enabled domains", () => {
  const flagManifest = `{% set grouped_definitions = [
    {'source_model_name': 'eligibility_flags', 'input_model_name': 'eligibility', 'test_names': ['a', 'b']},
    {'source_model_name': 'claim_flags', 'input_model_name': 'claim', 'test_names': ['c']},
    {'source_model_name': 'provider_flags', 'input_model_name': 'provider', 'test_names': ['d']},
    {'source_model_name': 'patient_flags', 'input_model_name': 'patient', 'test_names': ['e', 'f', 'g']}
  ] %}`;
  const domainManifest = `{'name': 'clinical', 'model_names': ['patient']}
    {% set claims_model_names = ['eligibility', 'claim'] %}
    {% do claims_model_names.append('provider') %}`;
  const resolve = (name, index) => resolveLogicalCatalogRefs({
    sql: `${name}(${index})`, flagManifest, domainManifest, chunkCount: 2
  });
  assert.deepEqual(resolve('dq_enabled_logical_test_manifest_chunk_by_model', 0), ['eligibility_flags', 'patient_flags', 'provider_flags']);
  assert.deepEqual(resolve('dq_enabled_logical_test_manifest_chunk_by_model', 1), ['claim_flags', 'patient_flags']);
  assert.deepEqual(resolve('dq_enabled_logical_test_manifest_chunk', 1), ['eligibility_flags', 'patient_flags', 'provider_flags']);
  assert.throws(() => resolveLogicalCatalogRefs({ sql: '', flagManifest, domainManifest, chunkCount: 2 }), /catalog\/chunk contract/);
});
