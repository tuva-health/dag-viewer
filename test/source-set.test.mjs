import assert from "node:assert/strict";
import test from "node:test";

import { parseRefDependencies } from "../scripts/build-static-data.mjs";

function buildIndexes() {
  return {
    nodeIdByQualifiedName: new Map([
      ["package_a:shared", "model.package_a.shared"],
      ["package_b:shared", "model.package_b.shared"],
      ["package_b:external_only", "model.package_b.external_only"]
    ]),
    nodeIdsByName: new Map([
      ["shared", ["model.package_a.shared", "model.package_b.shared"]],
      ["external_only", ["model.package_b.external_only"]]
    ]),
    packageAliasToName: new Map([
      ["repo_a", "package_a"],
      ["package_a", "package_a"],
      ["repo_b", "package_b"],
      ["package_b", "package_b"]
    ])
  };
}

test("resolves local, unique external, and package-qualified refs without collapsing package identity", () => {
  const result = parseRefDependencies({
    sql: "select * from {{ ref('shared') }} union all select * from {{ ref('external_only') }} union all select * from {{ ref('repo_b', 'shared') }}",
    currentPackageName: "package_a",
    currentNodeId: "model.package_a.consumer",
    filePath: "models/consumer.sql",
    ...buildIndexes()
  });

  assert.deepEqual(result.dependencies, [
    "model.package_a.shared",
    "model.package_b.external_only",
    "model.package_b.shared"
  ]);
  assert.deepEqual(result.unresolvedRefs, []);
});

test("records ambiguous and missing refs instead of attaching a false edge", () => {
  const result = parseRefDependencies({
    sql: "select * from {{ ref('shared') }} union all select * from {{ ref('missing_package', 'missing') }}",
    currentPackageName: "consumer_package",
    currentNodeId: "model.consumer_package.consumer",
    filePath: "models/consumer.sql",
    ...buildIndexes()
  });

  assert.deepEqual(result.dependencies, []);
  assert.equal(result.unresolvedRefs.length, 2);
  assert.deepEqual(result.unresolvedRefs[0].candidates, ["model.package_a.shared", "model.package_b.shared"]);
  assert.equal(result.unresolvedRefs[1].qualifier, "missing_package");
});

test("records dynamic refs separately because raw-source resolution cannot infer their runtime target", () => {
  const result = parseRefDependencies({
    sql: "-- depends_on: {{ ref(model_name) }}\nselect * from {{ ref(definition['source_model_name']) }}",
    currentPackageName: "package_a",
    currentNodeId: "model.package_a.dynamic_consumer",
    filePath: "models/dynamic_consumer.sql",
    ...buildIndexes()
  });

  assert.deepEqual(result.dependencies, []);
  assert.deepEqual(result.unresolvedRefs, []);
  assert.deepEqual(
    result.dynamicRefs.map((reference) => reference.expression),
    ["model_name", "definition['source_model_name']"]
  );
});
