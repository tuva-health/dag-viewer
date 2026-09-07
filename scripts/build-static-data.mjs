import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dagViewerRoot = path.resolve(scriptDir, "..");
const publicRoot = path.join(dagViewerRoot, "public");
const distRoot = path.join(dagViewerRoot, "dist");
const cacheRoot = path.join(dagViewerRoot, ".cache");
const manifestPath = path.join(cacheRoot, "manifest.json");
const lineageCacheRoot = path.join(cacheRoot, "lineage");
const defaultSourceSetPath = path.join(dagViewerRoot, "dag-sources.json");
const staticSeedPreviewRowLimit = Number(process.env.TUVA_DAG_SEED_PREVIEW_ROW_LIMIT || 1000) || 1000;
const assetManifestCache = new Map();
const assetManifestProvenance = new Map();

async function main() {
  const sourceSet = await resolveSourceSet();
  const coreSource = sourceSet.sources.find((source) => source.role === "core" && source.state === "resolved");

  if (!coreSource) {
    throw new Error("The DAG source set must resolve exactly one Core source.");
  }

  await prepareDist();
  const manifest = await createLiteManifest(sourceSet);
  await writeLiteManifest(manifest);
  await exportLineage({ sourceSet, coreSource, manifest });
  await writeSourceProvenance(manifest);
  for (const script of ["audit-source-set.mjs", "audit-overview-targets.mjs", "audit-lineage-edges.mjs"]) {
    const result = spawnSync(process.execPath, [path.join(scriptDir, script)], { cwd: dagViewerRoot, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${script} failed.`);
  }
}

export async function resolveSourceSet({ sourceSetPath = process.env.TUVA_DAG_SOURCE_SET_PATH || defaultSourceSetPath } = {}) {
  const absoluteSourceSetPath = path.resolve(sourceSetPath);
  const contract = JSON.parse(await readFile(absoluteSourceSetPath, "utf8"));
  const configuredSources = Array.isArray(contract.sources) ? contract.sources : [];

  if (!configuredSources.length) {
    throw new Error(`DAG source set has no sources: ${absoluteSourceSetPath}`);
  }

  validateSourceContract(contract, absoluteSourceSetPath);

  const pathOverrides = parseJsonObjectEnvironmentVariable("TUVA_DAG_SOURCE_PATHS");
  const refOverrides = parseJsonObjectEnvironmentVariable("TUVA_DAG_SOURCE_REFS");
  const sources = [];

  for (const configuredSource of configuredSources) {
    if (configuredSource.status !== "active") {
      sources.push({
        ...configuredSource,
        state: configuredSource.status || "unavailable",
        root: null,
        files: [],
        provenance: buildUnavailableProvenance(configuredSource)
      });
      continue;
    }

    sources.push(
      await resolveActiveSource({
        configuredSource,
        pathOverrides,
        refOverrides
      })
    );
  }

  return {
    contractVersion: contract.contractVersion,
    name: contract.name,
    sourceSetPath: absoluteSourceSetPath,
    sources
  };
}

export function validateSourceContract(contract, sourceSetPath) {
  const ids = new Set();
  const packageNames = new Set();
  let coreCount = 0;

  for (const source of contract.sources) {
    if (!source?.id || !source?.packageName || !source?.repositoryUrl || !source?.ref) {
      throw new Error(`Every DAG source needs id, packageName, repositoryUrl, and ref: ${sourceSetPath}`);
    }

    if (ids.has(source.id)) {
      throw new Error(`Duplicate DAG source id: ${source.id}`);
    }

    if (packageNames.has(source.packageName)) {
      throw new Error(`Duplicate dbt package name in DAG source set: ${source.packageName}`);
    }

    ids.add(source.id);
    packageNames.add(source.packageName);
    coreCount += source.role === "core" ? 1 : 0;
    if (source.required && source.status !== "active") {
      throw new Error(`Required DAG source ${source.id} must be active.`);
    }
  }

  if (coreCount !== 1) {
    throw new Error(`DAG source set must declare exactly one Core source; found ${coreCount}.`);
  }
}

async function resolveActiveSource({ configuredSource, pathOverrides, refOverrides }) {
  const configuredRef = String(
    refOverrides[configuredSource.id] ||
      refOverrides[configuredSource.packageName] ||
      (configuredSource.role === "core" ? process.env.TUVA_DAG_GITHUB_REF : "") ||
      configuredSource.ref
  );
  const explicitPath =
    pathOverrides[configuredSource.id] ||
    pathOverrides[configuredSource.packageName] ||
    (configuredSource.pathEnv ? process.env[configuredSource.pathEnv] : "") ||
    (configuredSource.role === "core" ? process.env.TUVA_DAG_SOURCE_ROOT : "");
  let root = explicitPath ? path.resolve(explicitPath) : null;
  let sourceMode = explicitPath ? "configured_path" : null;

  if (root && !looksLikeDbtProject(root)) {
    throw new Error(`Configured source path for ${configuredSource.id} is not a dbt project: ${root}`);
  }

  const allowLocalCandidates = process.env.TUVA_DAG_USE_LOCAL_CANDIDATES === "true";

  if (!root && allowLocalCandidates) {
    for (const candidate of configuredSource.localCandidates || []) {
      const candidateRoot = path.resolve(dagViewerRoot, candidate);

      if (looksLikeDbtProject(candidateRoot)) {
        root = candidateRoot;
        sourceMode = "local_candidate";
        break;
      }
    }
  }

  if (!root) {
    root = path.join(cacheRoot, "sources", configuredSource.id);
    sourceMode = "git_clone";
    await cloneSource({ configuredSource, configuredRef, root });
  }

  const dbtProject = parseYaml(await readFile(path.join(root, "dbt_project.yml"), "utf8")) || {};

  if (dbtProject.name !== configuredSource.packageName) {
    throw new Error(
      `Source ${configuredSource.id} expected dbt package ${configuredSource.packageName}, but ${root}/dbt_project.yml declares ${dbtProject.name || "no name"}.`
    );
  }

  const modelPaths = normalizePathList(dbtProject["model-paths"], ["models"]);
  const seedPaths = normalizePathList(dbtProject["seed-paths"], ["seeds"]);
  const macroPaths = normalizePathList(dbtProject["macro-paths"], ["macros"]);
  const seedProjectConfigs = collectProjectResourceConfigs(dbtProject.seeds || {});
  const files = await walkSelectedSourceFiles({ sourceRoot: root, modelPaths: [...modelPaths, ...macroPaths], seedPaths });
  const revision = readGitValue(root, ["rev-parse", "HEAD"]);
  const configuredRefRevision =
    sourceMode === "git_clone" ? revision : resolveLocalConfiguredRefRevision(root, configuredRef);
  const repositoryUrl = readGitValue(root, ["remote", "get-url", "origin"]) || configuredSource.repositoryUrl;
  const dirty = Boolean(readGitValue(root, ["status", "--porcelain", "--untracked-files=all"]));
  const contentSha256 = await fingerprintFiles(root, ["dbt_project.yml", ...files]);
  const assetBaseUrls = parseJsonObjectEnvironmentVariable("TUVA_DAG_ASSET_BASE_URLS");
  const assetBaseUrl = assetBaseUrls[configuredSource.id] || null;
  if (assetBaseUrl && !/^https?:\/\//.test(assetBaseUrl)) throw new Error(`Asset preview base for ${configuredSource.id} must be an HTTP(S) URL.`);

  return {
    ...configuredSource,
    ref: configuredRef,
    state: "resolved",
    root,
    files,
    modelPaths,
    seedPaths,
    seedProjectConfigs,
    dbtProject,
    provenance: {
      id: configuredSource.id,
      packageName: configuredSource.packageName,
      role: configuredSource.role,
      status: "resolved",
      repositoryUrl,
      configuredRef,
      revision,
      configuredRefRevision: configuredRefRevision || null,
      refMatchesRevision: configuredRefRevision ? configuredRefRevision === revision : null,
      dirty,
      contentSha256,
      sourceMode,
      packageVersion: String(dbtProject.version),
      assetVersion: configuredSource.assetVersionVar ? dbtProject.vars?.[configuredSource.assetVersionVar] : null,
      assetBaseUrl
    }
  };
}

function looksLikeDbtProject(sourceRoot) {
  return Boolean(sourceRoot && existsSync(path.join(sourceRoot, "dbt_project.yml")));
}

async function cloneSource({ configuredSource, configuredRef, root }) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  runGitOrThrow(["init", root], dagViewerRoot, `Unable to initialize source cache for ${configuredSource.id}`);
  runGitOrThrow(
    ["-C", root, "remote", "add", "origin", configuredSource.repositoryUrl],
    dagViewerRoot,
    `Unable to configure ${configuredSource.repositoryUrl}`
  );
  runGitOrThrow(
    ["-C", root, "fetch", "--depth=1", "origin", configuredRef],
    dagViewerRoot,
    `Unable to fetch ${configuredSource.repositoryUrl}#${configuredRef}`
  );
  runGitOrThrow(
    ["-C", root, "checkout", "--detach", "FETCH_HEAD"],
    dagViewerRoot,
    `Unable to check out ${configuredSource.repositoryUrl}#${configuredRef}`
  );
}

function runGitOrThrow(args, cwd, fallbackMessage) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || fallbackMessage);
  }
}

function parseJsonObjectEnvironmentVariable(name) {
  const value = process.env[name];

  if (!value) {
    return {};
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must contain a JSON object: ${error.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${name} must contain a JSON object.`);
  }

  return parsed;
}

function normalizePathList(value, fallback) {
  const values = Array.isArray(value) ? value : fallback;
  return values.map((entry) => normalizePath(entry)).filter(Boolean);
}

function collectProjectResourceConfigs(root) {
  const configs = {};

  function visit(value, key = null) {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return;
    }

    const localConfig = Object.fromEntries(
      Object.entries(value)
        .filter(([entryKey]) => entryKey.startsWith("+"))
        .map(([entryKey, entryValue]) => [entryKey.slice(1).replace(/-/g, "_"), entryValue])
    );

    if (key && Object.keys(localConfig).length) {
      configs[key] = {
        ...(configs[key] || {}),
        ...localConfig
      };
    }

    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (!entryKey.startsWith("+")) {
        visit(entryValue, entryKey);
      }
    }
  }

  visit(root);
  return configs;
}

function readGitValue(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function resolveLocalConfiguredRefRevision(root, configuredRef) {
  return (
    readGitValue(root, ["rev-parse", configuredRef]) ||
    readGitValue(root, ["rev-parse", `refs/remotes/origin/${configuredRef}`])
  );
}

async function fingerprintFiles(sourceRoot, files) {
  const digest = createHash("sha256");

  for (const filePath of files) {
    digest.update(filePath);
    digest.update("\0");
    digest.update(await readFile(path.join(sourceRoot, filePath)));
    digest.update("\0");
  }

  return digest.digest("hex");
}

function buildUnavailableProvenance(source) {
  return {
    id: source.id,
    packageName: source.packageName,
    role: source.role,
    status: source.status || "unavailable",
    repositoryUrl: source.repositoryUrl,
    configuredRef: source.ref,
    revision: null,
    configuredRefRevision: null,
    refMatchesRevision: null,
    dirty: null,
    contentSha256: null,
    sourceMode: null,
    reason: source.missingReason || "Source is not active in this source contract."
  };
}

async function prepareDist() {
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  await cp(publicRoot, distRoot, { recursive: true });
  await mkdir(path.join(distRoot, "data"), { recursive: true });
}

export async function createLiteManifest(sourceSet) {
  const resolvedSources = sourceSet.sources.filter((source) => source.state === "resolved");
  const resources = [];
  const nodeIdByQualifiedName = new Map();
  const nodeIdsByName = new Map();
  const packageAliasToName = new Map();

  for (const source of resolvedSources) {
    packageAliasToName.set(source.id, source.packageName);
    packageAliasToName.set(source.packageName, source.packageName);
    const modelDocsByName = await collectYamlDocs({ source, collectionKey: "models" });
    const seedDocsByName = await collectYamlDocs({ source, collectionKey: "seeds" });

    for (const filePath of source.files) {
      const resourceType = classifySourceFile(source, filePath);

      if (!resourceType) {
        continue;
      }

      const extension = resourceType === "model" ? ".sql" : ".csv";
      const name = path.basename(filePath, extension);
      const uniqueId = `${resourceType}.${source.packageName}.${name}`;
      const qualifiedName = `${source.packageName}:${name}`;

      if (nodeIdByQualifiedName.has(qualifiedName)) {
        throw new Error(
          `Duplicate dbt resource ${name} in package ${source.packageName}: ${filePath} and ${nodeIdByQualifiedName.get(qualifiedName)}`
        );
      }

      nodeIdByQualifiedName.set(qualifiedName, uniqueId);

      if (!nodeIdsByName.has(name)) {
        nodeIdsByName.set(name, []);
      }

      nodeIdsByName.get(name).push(uniqueId);
      resources.push({
        source,
        filePath,
        resourceType,
        name,
        uniqueId,
        doc: (resourceType === "model" ? modelDocsByName : seedDocsByName).get(name) || null
      });
    }
  }

  const nodes = {};
  const externalSources = {};
  const externalRefs = [];
  const dynamicRefs = [];
  const unresolvedRefs = [];
  const resolvedDynamicRefs = [];
  const core = resolvedSources.find((source) => source.role === "core");
  const flagManifestPath = core && path.join(core.root, "macros/data_quality/dq_logical_flag_manifest.sql");
  const flagManifest = flagManifestPath && existsSync(flagManifestPath) ? await readFile(flagManifestPath, "utf8") : "";
  const domainManifestPath = core && path.join(core.root, "macros/data_quality/dq_summary_helpers.sql");
  const domainManifest = domainManifestPath && existsSync(domainManifestPath) ? await readFile(domainManifestPath, "utf8") : "";
  const logicalHelpersPath = core && path.join(core.root, "macros/data_quality/dq_logical_helpers.sql");
  const logicalHelpers = logicalHelpersPath && existsSync(logicalHelpersPath) ? await readFile(logicalHelpersPath, "utf8") : "";
  const chunkCount = Number(core?.dbtProject?.vars?.dq_logical_chunk_count ?? logicalHelpers.match(/var\(['"]dq_logical_chunk_count['"],\s*(\d+)\)/)?.[1]);

  for (const resource of resources) {
    const sql =
      resource.resourceType === "model"
        ? await readFile(path.join(resource.source.root, resource.filePath), "utf8")
        : "";
    const dependencyResult =
      resource.resourceType === "model"
        ? parseRefDependencies({
            sql: expandSqlWithReferencedProjectVars(sql, resource.source.dbtProject?.vars || {}),
            currentPackageName: resource.source.packageName,
            currentNodeId: resource.uniqueId,
            filePath: resource.filePath,
            nodeIdByQualifiedName,
            nodeIdsByName,
            packageAliasToName
          })
        : { dependencies: [], unresolvedRefs: [], dynamicRefs: [] };

    const declaredExternalRefs = dependencyResult.unresolvedRefs.filter((reference) =>
      isDeclaredExternalRef(resource.source, reference)
    );
    const remainingUnresolvedRefs = dependencyResult.unresolvedRefs.filter(
      (reference) => !isDeclaredExternalRef(resource.source, reference)
    );
    const externalDependencyIds = declaredExternalRefs.map((reference) => {
      const externalNodeId = `source.${resource.source.packageName}.${reference.referencedName}`;

      if (!externalSources[externalNodeId]) {
        externalSources[externalNodeId] = buildExternalSourceNode(resource.source, reference, externalNodeId);
      }

      externalRefs.push({
        ...reference,
        externalNodeId,
        kind: resolveExternalRefKind(resource.source, reference)
      });
      return externalNodeId;
    });

    const catalogDependencies = [];
    for (const reference of dependencyResult.dynamicRefs) {
      let names = [];
      if (resource.source.role === "core" && resource.filePath.startsWith("models/data_quality/")) {
        if (reference.expression === "model_name" && /dq_enabled_input_layer_model_names\s*\(/.test(sql)) {
          names = resources.filter((entry) => entry.source === core && entry.filePath.startsWith("models/input_layer/")).map((entry) => entry.name);
        } else if (["source_model_name", "definition['source_model_name']"].includes(reference.expression) && /dq_enabled_logical_test_manifest_chunk/.test(sql)) {
          names = resolveLogicalCatalogRefs({ sql, flagManifest, domainManifest, chunkCount });
        }
      }
      if (!names.length) {
        dynamicRefs.push(reference);
        continue;
      }
      const dependencies = names.map((name) => {
        const id = nodeIdByQualifiedName.get(`${resource.source.packageName}:${name}`);
        if (!id) throw new Error(`Dynamic catalog dependency ${name} is missing for ${resource.uniqueId}.`);
        return id;
      });
      catalogDependencies.push(...dependencies);
      resolvedDynamicRefs.push({ ...reference, resolution: "catalog_union", dependencies, ...(reference.expression === "model_name" ? {} : { chunkCount }) });
    }
    unresolvedRefs.push(...remainingUnresolvedRefs);
    nodes[resource.uniqueId] = buildNode({
      source: resource.source,
      name: resource.name,
      uniqueId: resource.uniqueId,
      filePath: resource.filePath,
      resourceType: resource.resourceType,
      doc: resource.doc,
      dependsOn: Array.from(new Set([...dependencyResult.dependencies, ...externalDependencyIds, ...catalogDependencies])).sort(),
      materialized:
        resource.resourceType === "model" ? inferMaterialized(sql, resource.doc?.entry, resolveResourceConfig(resource.source, resource.filePath, resource.resourceType)) : "seed"
    });
  }

  const coreSource = resolvedSources.find((source) => source.role === "core");
  if (unresolvedRefs.length || dynamicRefs.length) {
    throw new Error(`Unresolved DAG dependencies: ${JSON.stringify({ unresolvedRefs, dynamicRefs }, null, 2)}`);
  }

  return {
    metadata: {
      adapter_type: "static",
      project_name: coreSource?.packageName || null,
      generated_at: new Date().toISOString(),
      tuva_dag: {
        contractVersion: sourceSet.contractVersion,
        sourceSetName: sourceSet.name,
        corePackageName: coreSource?.packageName || null,
        sources: sourceSet.sources.map((source) => ({
          ...source.provenance,
          viewer: source.viewer || null
        })),
        externalRefs,
        dynamicRefs,
        resolvedDynamicRefs,
        unresolvedRefs
      }
    },
    nodes,
    sources: externalSources
  };
}

export function resolveLogicalCatalogRefs({ sql, flagManifest, domainManifest, chunkCount }) {
  const chunk = sql.match(/dq_enabled_logical_test_manifest_chunk(_by_model)?\(\s*(\d+)\s*\)/);
  const grouped = flagManifest.match(/set grouped_definitions\s*=\s*([\s\S]*?)%}/);
  const clinical = domainManifest.match(/['"]name['"]:\s*['"]clinical['"][\s\S]*?['"]model_names['"]:\s*(\[[\s\S]*?\])/);
  const claims = domainManifest.match(/set claims_model_names\s*=\s*(\[[\s\S]*?\])/);
  const provider = domainManifest.match(/claims_model_names\.append\(['"]([^'"]+)['"]\)/);
  if (!chunk || !grouped || !clinical || !claims || !provider || !Number.isInteger(chunkCount) || chunkCount < 1) {
    throw new Error("Cannot resolve the Core logical Data Quality catalog/chunk contract.");
  }
  const groups = parseYaml(grouped[1].trim());
  const clinicalInputs = parseYaml(clinical[1]);
  const claimsInputs = parseYaml(claims[1]);
  const union = new Set();
  // Core enables clinical as one domain; provider attribution requires claims.
  // Slice each enabled registry before taking the across-configuration union.
  for (const clinicalEnabled of [false, true]) {
    for (const claimsEnabled of [false, true]) {
      for (const providerEnabled of [false, true]) {
        const enabled = new Set([
          ...(clinicalEnabled ? clinicalInputs : []),
          ...(claimsEnabled ? claimsInputs : []),
          ...(claimsEnabled && providerEnabled ? [provider[1]] : [])
        ]);
        const filtered = groups.filter((group) => enabled.has(group.input_model_name));
        const names = chunk[1]
          ? [...new Set(filtered.map((group) => group.source_model_name))]
          : filtered.flatMap((group) => group.test_names.map(() => group.source_model_name));
        names.forEach((name, index) => {
          if (index % chunkCount === Number(chunk[2])) union.add(name);
        });
      }
    }
  }
  return [...union].sort();
}

function isDeclaredExternalRef(source, reference) {
  if (reference.qualifier) {
    return false;
  }

  if (source.role === "core" && reference.filePath.startsWith("models/input_layer/")) {
    return (source.connectorRefs || []).includes(reference.referencedName);
  }

  return (source.externalRefs || []).includes(reference.referencedName);
}

function resolveExternalRefKind(source, reference) {
  return source.role === "core" && reference.filePath.startsWith("models/input_layer/")
    ? "connector_input"
    : "optional_override";
}

function buildExternalSourceNode(source, reference, uniqueId) {
  const kind = resolveExternalRefKind(source, reference);

  return {
    unique_id: uniqueId,
    resource_type: "source",
    package_name: source.packageName,
    name: reference.referencedName,
    source_name: kind,
    alias: reference.referencedName,
    schema: "external",
    path: null,
    original_file_path: null,
    patch_path: null,
    description:
      kind === "connector_input"
        ? "External connector model supplied by the installing dbt project."
        : "Optional override model supplied by the installing dbt project.",
    columns: {},
    depends_on: { nodes: [] },
    config: { materialized: "external", meta: {} },
    meta: {},
    tags: [kind],
    tuva_source: {
      id: source.id,
      repositoryUrl: source.provenance.repositoryUrl,
      configuredRef: source.provenance.configuredRef,
      revision: source.provenance.revision,
      contentSha256: source.provenance.contentSha256,
      dirty: source.provenance.dirty,
      role: source.role
    }
  };
}

function expandSqlWithReferencedProjectVars(sql, projectVars) {
  const fragments = [sql];
  const seen = new Set();
  const pending = [sql];
  const varPattern = /var\s*\(\s*(["'])([^"']+)\1/g;

  while (pending.length) {
    const fragment = pending.pop();
    varPattern.lastIndex = 0;
    let match;

    while ((match = varPattern.exec(fragment)) !== null) {
      const variableName = match[2];

      if (seen.has(variableName) || typeof projectVars[variableName] !== "string") {
        continue;
      }

      seen.add(variableName);
      fragments.push(projectVars[variableName]);
      pending.push(projectVars[variableName]);
    }
  }

  return fragments.join("\n");
}

async function writeLiteManifest(manifest) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function classifySourceFile(source, filePath) {
  if (filePath.endsWith(".sql") && source.modelPaths.some((root) => isWithinConfiguredPath(filePath, root))) {
    return "model";
  }

  if (filePath.endsWith(".csv") && source.seedPaths.some((root) => isWithinConfiguredPath(filePath, root))) {
    return "seed";
  }

  return null;
}

function isWithinConfiguredPath(filePath, configuredPath) {
  return filePath === configuredPath || filePath.startsWith(`${configuredPath}/`);
}

function buildNode({ source, name, uniqueId, filePath, resourceType, doc, dependsOn, materialized }) {
  const entry = doc?.entry || {};
  const config = {
    ...resolveResourceConfig(source, filePath, resourceType),
    ...(resourceType === "seed" ? source.seedProjectConfigs?.[name] || {} : {}),
    ...(entry.config || {})
  };
  const meta = {
    ...(entry.meta || {}),
    ...(config.meta || {})
  };

  return {
    unique_id: uniqueId,
    resource_type: resourceType,
    package_name: source.packageName,
    name,
    alias: config.alias || name,
    schema: typeof config.schema === "string" && !config.schema.includes("{")
      ? config.schema.trim()
      : inferSchema(filePath, resourceType, source),
    path: filePath,
    original_file_path: filePath,
    patch_path: doc ? `${source.packageName}://${doc.filePath}` : null,
    description: entry.description || "",
    columns: buildManifestColumns(entry.columns || []),
    depends_on: {
      nodes: dependsOn
    },
    config: {
      ...config,
      materialized,
      meta
    },
    meta,
    tags: Array.isArray(entry.tags)
      ? entry.tags
      : Array.isArray(config.tags)
        ? config.tags
        : [],
    tuva_source: {
      id: source.id,
      repositoryUrl: source.provenance.repositoryUrl,
      configuredRef: source.provenance.configuredRef,
      revision: source.provenance.revision,
      contentSha256: source.provenance.contentSha256,
      dirty: source.provenance.dirty,
      role: source.role,
      assetPrefix: source.assetPrefix,
      assetVersion: source.provenance.assetVersion,
      assetBaseUrl: source.provenance.assetBaseUrl,
      seedVersions: source.dbtProject?.vars?.tuva_seed_versions || {},
      seedBuckets: source.dbtProject?.vars?.tuva_seed_buckets || {},
      customBucketName: source.dbtProject?.vars?.custom_bucket_name || "tuva-public-resources",
      seedVersionOverrides: Object.fromEntries(
        Object.entries(source.dbtProject?.vars || {}).filter(([variableName]) => variableName.endsWith("_seed_version"))
      )
    }
  };
}

function buildManifestColumns(columns) {
  return Object.fromEntries(
    columns
      .filter((column) => column?.name)
      .map((column) => [
        column.name,
        {
          name: column.name,
          description: column.description || "",
          data_type: column.data_type || column.config?.meta?.data_type || column.meta?.data_type || null,
          meta: column.meta || {},
          config: column.config || {}
        }
      ])
  );
}

export function parseRefDependencies({
  sql,
  currentPackageName,
  currentNodeId,
  filePath,
  nodeIdByQualifiedName,
  nodeIdsByName,
  packageAliasToName
}) {
  const dependencies = new Set();
  const unresolvedRefs = [];
  const dynamicRefs = [];
  const refPattern = /ref\s*\(\s*(["'])([^"']+)\1\s*(?:,\s*(["'])([^"']+)\3\s*)?\)/g;
  let match;

  while ((match = refPattern.exec(sql)) !== null) {
    const qualifier = match[4] ? match[2] : null;
    const referencedName = match[4] || match[2];
    let dependencyId = null;
    let candidates = [];

    if (qualifier) {
      const qualifiedPackageName = packageAliasToName.get(qualifier) || qualifier;
      dependencyId = nodeIdByQualifiedName.get(`${qualifiedPackageName}:${referencedName}`) || null;
    } else {
      dependencyId = nodeIdByQualifiedName.get(`${currentPackageName}:${referencedName}`) || null;

      if (!dependencyId) {
        candidates = nodeIdsByName.get(referencedName) || [];
        dependencyId = candidates.length === 1 ? candidates[0] : null;
      }
    }

    if (dependencyId) {
      dependencies.add(dependencyId);
      continue;
    }

    unresolvedRefs.push({
      nodeId: currentNodeId,
      filePath,
      packageName: currentPackageName,
      qualifier,
      referencedName,
      candidates
    });
  }

  const dynamicRefPattern = /ref\s*\(\s*([^'"\s][^)]*)\)/g;

  while ((match = dynamicRefPattern.exec(sql)) !== null) {
    dynamicRefs.push({
      nodeId: currentNodeId,
      filePath,
      packageName: currentPackageName,
      expression: match[1].trim()
    });
  }

  return {
    dependencies: Array.from(dependencies).sort(),
    unresolvedRefs,
    dynamicRefs
  };
}

export function resolveResourceConfig(source, filePath, resourceType) {
  const tree = source.dbtProject?.[resourceType === "seed" ? "seeds" : "models"] || {};
  const roots = resourceType === "seed" ? source.seedPaths : source.modelPaths;
  const root = roots.find((candidate) => isWithinConfiguredPath(filePath, candidate));
  if (!root) return {};
  const parts = filePath.slice(root.length + 1).replace(/\.(sql|csv)$/, "").split("/");
  let current = tree;
  const result = {};
  for (const key of [null, source.packageName, ...parts]) {
    if (key !== null) current = current?.[key];
    if (!current || typeof current !== "object") break;
    for (const [name, value] of Object.entries(current)) {
      if (name.startsWith("+")) result[name.slice(1).replaceAll("-", "_")] = value;
    }
  }
  return result;
}

function inferMaterialized(sql, entry = {}, projectConfig = {}) {
  const match = sql.match(/materialized\s*=\s*["']([^"']+)["']/i);
  if (match) return match[1];
  const configured = entry.config?.materialized || entry.materialized;

  if (configured) {
    return configured;
  }

  return projectConfig.materialized || "view";
}

function inferSchema(filePath, resourceType, source) {
  const parts = filePath.split("/");

  if (resourceType === "seed") {
    return parts.length > 2 ? parts[1] : "target.schema";
  }

  if (source.role !== "core") {
    return source.viewer?.key || source.id;
  }

  if (filePath.startsWith("models/input_layer/")) {
    return "input_layer";
  }

  if (filePath.startsWith("models/core/")) {
    return "core";
  }

  if (filePath.startsWith("models/data_marts/")) {
    return parts[2] || "data_marts";
  }

  if (filePath.startsWith("models/claims_preprocessing/")) {
    return "claims_preprocessing";
  }

  if (filePath.startsWith("models/normalized_layer/")) {
    return "normalized_layer";
  }

  return parts[1] || "model";
}

async function collectYamlDocs({ source, collectionKey }) {
  const docsByName = new Map();
  const yamlFiles = source.files.filter((filePath) => /\.(ya?ml)$/i.test(filePath));

  for (const filePath of yamlFiles) {
    let document;

    try {
      document = parseYaml(await readFile(path.join(source.root, filePath), "utf8")) || {};
    } catch (error) {
      throw new Error(`Invalid YAML in ${source.id}/${filePath}: ${error.message}`);
    }

    const entries = Array.isArray(document[collectionKey]) ? document[collectionKey] : [];

    for (const entry of entries) {
      if (!entry?.name || docsByName.has(entry.name)) {
        continue;
      }

      docsByName.set(entry.name, { filePath, entry });
    }
  }

  return docsByName;
}

async function exportLineage({ sourceSet, coreSource, manifest }) {
  process.env.DAG_REPO_ROOT = coreSource.root;
  process.env.DAG_MANIFEST_PATH = manifestPath;
  process.env.DAG_CACHE_DIR = lineageCacheRoot;
  process.env.DAG_CORE_PACKAGE_NAME = coreSource.packageName;
  process.env.DAG_PACKAGE_ROOTS_JSON = JSON.stringify(
    Object.fromEntries(
      sourceSet.sources
        .filter((source) => source.state === "resolved")
        .map((source) => [source.packageName, source.root])
    )
  );

  const lineageModule = await import(pathToFileURL(path.join(scriptDir, "build-lineage.mjs")).href);
  const targets = await lineageModule.listTargetConfigs();
  for (const source of sourceSet.sources.filter((entry) => entry.required && entry.viewer)) {
    if (!targets.some((target) => target.key === source.viewer.key)) {
      throw new Error(`Missing required package DAG target ${source.viewer.key}.`);
    }
  }
  const seedPreviewNodes = new Map();

  for (const target of targets) {
    const payload = await lineageModule.buildLineagePayload({ targetKey: target.key });
    const staticResponse = buildStaticResponse({ payload, targets });
    const outputPath = path.join(distRoot, "data", `${target.key}-lineage.json`);

    await writeFile(outputPath, `${JSON.stringify(staticResponse, null, 2)}\n`, "utf8");
    collectSeedPreviewNodes(seedPreviewNodes, payload);
  }

  await exportStaticSeedPreviews(seedPreviewNodes);
}

async function writeSourceProvenance(manifest) {
  const provenance = manifest.metadata?.tuva_dag || {};
  const outputPath = path.join(distRoot, "data", "source-provenance.json");

  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: manifest.metadata?.generated_at || new Date().toISOString(),
        contractVersion: provenance.contractVersion || null,
        sourceSetName: provenance.sourceSetName || null,
        sources: provenance.sources || [],
        assetManifests: Array.from(assetManifestProvenance.values()),
        externalRefs: provenance.externalRefs || [],
        dynamicRefs: provenance.dynamicRefs || [],
        resolvedDynamicRefs: provenance.resolvedDynamicRefs || [],
        unresolvedRefs: provenance.unresolvedRefs || []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const rows = provenance.sources.map((source) => `<tr><th>${escape(source.id)}<small>${escape(source.packageName)}</small></th><td>${escape(source.packageVersion)}</td><td>${escape(source.assetVersion || "No assets")}${source.assetBaseUrl ? `<strong>Preview snapshot override</strong><small>${escape(source.assetBaseUrl)}</small>` : ""}</td><td><a href="${escape(source.repositoryUrl.replace(/\.git$/, ""))}/commit/${escape(source.revision)}">${escape(source.revision)}</a><small>Scanned content: ${escape(source.contentSha256)}</small>${source.dirty ? "<strong>Local changes included</strong>" : ""}</td></tr>`).join("");
  await writeFile(path.join(distRoot, "sources.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sources | Tuva DAG Viewer</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#242424;background:#fafafa;max-width:1200px;margin:48px auto;padding:0 24px}a{color:#43329e}h1{font-size:32px}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;padding:16px;border-bottom:1px solid #ddd;vertical-align:top}small{display:block;color:#555;font-size:12px;overflow-wrap:anywhere}td:last-child{max-width:420px;overflow-wrap:anywhere}strong{display:block;color:#853c00}.scroll{overflow:auto}</style><a href="./?target=system_overview">← DAG Viewer</a><h1>Sources</h1><p>Core and eight standalone packages, built ${escape(manifest.metadata.generated_at)}.</p><p>This catalog shows possible lineage across configurations. Connector inputs and optional overrides remain external. Data Quality catalog loops include their possible sources across enabled domains, preserving the default chunk count; an individual dbt run can enable a subset.</p><div class="scroll"><table><thead><tr><th>Repository / dbt package</th><th>Code version</th><th>Asset version</th><th>Exact source</th></tr></thead><tbody>${rows}</tbody></table></div><p><a href="./data/source-provenance.json">Download provenance, asset manifest hashes, and reference resolutions</a></p></html>\n`);
}

function buildStaticResponse({ payload, targets }) {
  const generatedAt = payload.generatedAt || new Date().toISOString();

  return {
    payload,
    targets,
    capabilities: {
      canEdit: false
    },
    refresh: {
      status: "ready",
      payloadVersion: 1,
      activeTargetKey: payload.target?.key || "system_overview",
      activeTrigger: "static_export",
      lastAttemptAt: generatedAt,
      lastSuccessAt: generatedAt,
      lastError: null,
      hasPayload: true,
      mode: "static"
    }
  };
}

function collectSeedPreviewNodes(seedPreviewNodes, payload) {
  for (const node of payload.nodes || []) {
    if (node?.resourceType !== "seed" || seedPreviewNodes.has(node.id)) {
      continue;
    }

    seedPreviewNodes.set(node.id, {
      nodeId: node.id,
      name: node.name,
      csvPath: node.paths?.sql || null,
      seedViewer: node.seedViewer || null,
      columns: node.columns || []
    });
  }
}

async function exportStaticSeedPreviews(seedPreviewNodes) {
  const outputRoot = path.join(distRoot, "data", "seed-previews");
  await mkdir(outputRoot, { recursive: true });

  for (const seedNode of seedPreviewNodes.values()) {
    const snapshot = await buildStaticSeedPreviewSnapshot(seedNode);
    const outputPath = path.join(outputRoot, `${seedNode.nodeId}.json`);
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

async function buildStaticSeedPreviewSnapshot(seedNode) {
  // The checked-in CSV is the loader contract. YAML may document only a
  // subset of those columns (for example calendar.year_month_int).
  const fallbackHeaders = seedNode.csvPath && existsSync(seedNode.csvPath)
    ? parseCsvLine((await readFile(seedNode.csvPath, "utf8")).split(/\r?\n/, 1)[0].replace(/^\uFEFF/, ""))
    : seedNode.columns.map((column) => column.name).filter(Boolean);
  let preview = null;
  let sourceError = null;
  let expectedAsset = null;
  let cachedPath = null;

  if (seedNode.seedViewer?.manifestUrl) {
    const manifestUrl = seedNode.seedViewer.manifestUrl;
    if (!assetManifestCache.has(manifestUrl)) {
      const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Asset manifest ${manifestUrl} returned ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const assetManifest = JSON.parse(bytes.toString("utf8"));
      assetManifestCache.set(manifestUrl, assetManifest);
      assetManifestProvenance.set(manifestUrl, {
        url: manifestUrl,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        assetCount: assetManifest.assets?.length || 0
      });
    }
    expectedAsset = assetManifestCache.get(manifestUrl).assets?.find((asset) => asset.path === seedNode.seedViewer.fileName);
    if (!expectedAsset || !/^[a-f0-9]{64}$/.test(expectedAsset.sha256)) {
      throw new Error(`Missing asset inventory/hash for ${seedNode.nodeId}.`);
    }
    cachedPath = path.join(cacheRoot, "seed-previews", `${expectedAsset.sha256}-${staticSeedPreviewRowLimit}.json`);
    if (existsSync(cachedPath)) {
      const cached = JSON.parse(await readFile(cachedPath, "utf8"));
      if (
        cached.contentSha256 === expectedAsset.sha256 &&
        cached.totalRows === expectedAsset.rows &&
        cached.nodeId === seedNode.nodeId &&
        cached.sourceUrl === seedNode.seedViewer.downloadUrl &&
        doCsvHeadersMatch(cached.headers || [], fallbackHeaders)
      ) return cached;
    }
  }

  if (seedNode.seedViewer?.downloadUrl) {
    try {
      preview = await readCsvPreviewFromUrl(seedNode.seedViewer.downloadUrl, staticSeedPreviewRowLimit, fallbackHeaders);
    } catch (error) {
      sourceError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!preview && seedNode.csvPath && existsSync(seedNode.csvPath)) {
    try {
      preview = await readCsvPreviewFromFile(seedNode.csvPath, staticSeedPreviewRowLimit, fallbackHeaders);
    } catch (error) {
      sourceError = sourceError || (error instanceof Error ? error.message : String(error));
    }
  }

  if (sourceError || seedNode.seedViewer?.unavailableReason || !preview) {
    throw new Error(`Seed preview unavailable for ${seedNode.nodeId}: ${sourceError || seedNode.seedViewer?.unavailableReason || "no readable source"}`);
  }
  if (expectedAsset && (preview.contentSha256 !== expectedAsset.sha256 || preview.totalRows !== expectedAsset.rows)) {
    throw new Error(`Seed preview payload does not match the published manifest for ${seedNode.nodeId}.`);
  }
  if (!seedNode.seedViewer?.downloadUrl && preview.totalRows === 0) {
    throw new Error(`Header-only seed ${seedNode.nodeId} has no resolved public payload.`);
  }
  const snapshot = {
    nodeId: seedNode.nodeId,
    name: seedNode.name,
    generatedAt: new Date().toISOString(),
    sourceUrl: seedNode.seedViewer?.downloadUrl || null,
    sourceUnavailableReason: seedNode.seedViewer?.unavailableReason || null,
    sourceError,
    contentSha256: preview?.contentSha256 || null,
    headers: preview?.headers?.length ? preview.headers : fallbackHeaders,
    rows: preview?.rows || [],
    cachedRows: preview?.rows?.length || 0,
    totalRows: preview?.totalRows ?? null,
    rowLimit: staticSeedPreviewRowLimit,
    truncated: Boolean(preview?.truncated)
  };
  if (cachedPath) {
    await mkdir(path.dirname(cachedPath), { recursive: true });
    await writeFile(cachedPath, `${JSON.stringify(snapshot)}\n`);
  }
  return snapshot;
}

export async function readCsvPreviewFromUrl(url, rowLimit, preferredHeaders = []) {
  // Unlike fetch(), the native response stream preserves gzip bytes even when
  // S3 sets Content-Encoding, so the digest can verify the published object.
  const input = await new Promise((resolve, reject) => {
    const request = (url.startsWith("https:") ? httpsGet : httpGet)(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`CSV source ${url} returned ${response.statusCode}`));
      } else resolve(response);
    });
    request.setTimeout(60000, () => request.destroy(new Error(`CSV source timed out: ${url}`)));
    request.on("error", reject);
  });
  const digest = createHash("sha256");
  const tap = new Transform({ transform(chunk, encoding, callback) { digest.update(chunk); callback(null, chunk); } });
  const decoded = url.endsWith(".gz") ? createGunzip() : new PassThrough();
  decoded.setEncoding("utf8");
  const completed = pipeline(input, tap, decoded);
  completed.catch(() => {}); // Await below; the iterator also receives errors.
  const rows = [];
  let headers = null;
  let totalRows = 0;
  let record = "";
  let inQuotes = false;
  let pendingLine = "";
  function consumeLine(line) {
    record += (record ? "\n" : "") + line;
    for (const character of line) if (character === '"') inQuotes = !inQuotes;
    if (inQuotes || !record) return;
    const cells = parseCsvLine(record.replace(/^\uFEFF/, ""));
    record = "";
    if (!headers) {
      headers = cells;
      if (preferredHeaders.length && !doCsvHeadersMatch(headers, preferredHeaders)) {
        throw new Error(`CSV header mismatch for ${url}: expected ${preferredHeaders.join(",")}; got ${headers.join(",")}`);
      }
      return;
    }
    if (cells.length !== headers.length) throw new Error(`CSV row ${totalRows + 1} has the wrong width in ${url}.`);
    totalRows += 1;
    if (rows.length < rowLimit) rows.push(cells);
  }
  try {
    for await (const chunk of decoded) {
      const lines = (pendingLine + chunk).split(/\r?\n/);
      pendingLine = lines.pop();
      for (const line of lines) consumeLine(line);
    }
    if (pendingLine) consumeLine(pendingLine);
    if (inQuotes) throw new Error(`Unterminated quoted CSV record in ${url}.`);
    await completed;
  } finally {
    decoded.destroy();
    input.destroy();
  }
  return { headers: headers || [], rows, totalRows, truncated: totalRows > rowLimit, contentSha256: digest.digest("hex") };
}

async function readCsvPreviewFromFile(filePath, rowLimit, preferredHeaders = []) {
  const sourceBuffer = await readFile(filePath);
  return {
    ...readCsvPreviewFromText(sourceBuffer.toString("utf8"), rowLimit, preferredHeaders),
    contentSha256: createHash("sha256").update(sourceBuffer).digest("hex")
  };
}

function readCsvPreviewFromText(csvText, rowLimit, preferredHeaders = []) {
  const lines = csvText.split(/\r?\n/);
  const firstLine = lines.length ? parseCsvLine(lines[0].replace(/^\uFEFF/, "")) : [];
  const hasPreferredHeaders = preferredHeaders.length > 0;
  const headers = hasPreferredHeaders ? preferredHeaders : firstLine;
  const firstLineIsHeader = hasPreferredHeaders
    ? doCsvHeadersMatch(firstLine, preferredHeaders)
    : firstLine.length > 0;
  const dataLines = lines.slice(firstLineIsHeader ? 1 : 0).filter((line) => line.length);
  const rows = dataLines.slice(0, rowLimit).map(parseCsvLine);

  return {
    headers,
    rows,
    totalRows: dataLines.length,
    truncated: dataLines.length > rowLimit
  };
}

function doCsvHeadersMatch(csvHeaders, preferredHeaders) {
  if (csvHeaders.length !== preferredHeaders.length) {
    return false;
  }

  return csvHeaders.every((header, index) => normalizeCsvHeader(header) === normalizeCsvHeader(preferredHeaders[index]));
}

function normalizeCsvHeader(header) {
  return String(header || "").trim().toLowerCase();
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      cells.push(cell);
      cell = "";
      continue;
    }

    cell += character;
  }

  cells.push(cell);
  return cells;
}

async function walkSelectedSourceFiles({ sourceRoot, modelPaths, seedPaths }) {
  const roots = Array.from(new Set([...modelPaths, ...seedPaths]));
  const files = [];

  for (const root of roots) {
    const absoluteRoot = path.join(sourceRoot, root);

    if (!existsSync(absoluteRoot)) {
      continue;
    }

    files.push(...await walk(absoluteRoot, sourceRoot));
  }

  return files.sort();
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

async function walk(currentPath, sourceRoot) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...await walk(absolutePath, sourceRoot));
      continue;
    }

    if (entry.isFile()) {
      files.push(path.relative(sourceRoot, absolutePath).replace(/\\/g, "/"));
    }
  }

  return files;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
