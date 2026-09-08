import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dagRoot = path.resolve(scriptDir, "..");
const repoRoot = process.env.DAG_REPO_ROOT
  ? path.resolve(process.env.DAG_REPO_ROOT)
  : process.env.TUVA_CORE_PATH
    ? path.resolve(process.env.TUVA_CORE_PATH)
    : path.resolve(dagRoot, "..", "tuva-core");
const cacheRoot = process.env.DAG_CACHE_DIR
  ? path.resolve(process.env.DAG_CACHE_DIR)
  : path.join(dagRoot, "data");
const manifestPath = process.env.DAG_MANIFEST_PATH
  ? path.resolve(process.env.DAG_MANIFEST_PATH)
  : path.join(repoRoot, "integration_tests", "target", "manifest.json");
const corePackageName = process.env.DAG_CORE_PACKAGE_NAME || "the_tuva_project";

export const DEFAULT_TARGET_KEY = "appointment";
export const SYSTEM_OVERVIEW_TARGET_KEY = "system_overview";

const packageRoots = {
  integration_tests: path.join(repoRoot, "integration_tests"),
  [corePackageName]: repoRoot,
  ...parsePackageRoots(process.env.DAG_PACKAGE_ROOTS_JSON)
};

function parsePackageRoots(value) {
  if (!value) {
    return {};
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`DAG_PACKAGE_ROOTS_JSON must contain a JSON object: ${error.message}`);
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([packageName, packageRoot]) => [packageName, path.resolve(String(packageRoot))])
  );
}

const fixedClaimsTargets = [
  {
    key: "provider_attribution",
    label: "Provider Attribution",
    kind: "claims_preprocessing",
    categoryKey: "claims_preprocessing",
    categoryLabel: "Claims Preprocessing",
    title: "Provider Attribution DAG",
    subtitle:
      "Claims preprocessing models that attribute members to providers and prepare attribution outputs for downstream member-month logic.",
    folderLabel: "claims_preprocessing/provider_attribution",
    recurseWhenCollapsed: true,
    collapsedNodeType: "intermediate",
    matchesPath: (modelPath) => modelPath.startsWith("models/claims_preprocessing/provider_attribution/"),
    selectRootNodeIds: (nodes) => nodes.filter((node) => node.original_file_path.includes("/final/")).map((node) => node.unique_id)
  },
  {
    key: "service_categories",
    label: "Service Categories",
    kind: "claims_preprocessing",
    categoryKey: "claims_preprocessing",
    categoryLabel: "Claims Preprocessing",
    title: "Service Categories DAG",
    subtitle:
      "Claims preprocessing models that classify normalized medical claims into service categories before downstream encounters and claims-enrollment logic.",
    folderLabel: "claims_preprocessing/service_category",
    recurseWhenCollapsed: true,
    collapsedNodeType: "intermediate",
    matchesPath: (modelPath) => modelPath.startsWith("models/claims_preprocessing/service_category/"),
    selectRootNodeIds: (nodes) => nodes.filter((node) => node.original_file_path.includes("/final/")).map((node) => node.unique_id)
  },
  {
    key: "encounters",
    label: "Encounters",
    kind: "claims_preprocessing",
    categoryKey: "claims_preprocessing",
    categoryLabel: "Claims Preprocessing",
    title: "Encounters DAG",
    subtitle:
      "Claims preprocessing models that create encounter-grain outputs and the crosswalk/orphaned-claim assets consumed downstream in core medical claims.",
    folderLabel: "claims_preprocessing/encounters",
    recurseWhenCollapsed: true,
    collapsedNodeType: "intermediate",
    matchesPath: (modelPath) => modelPath.startsWith("models/claims_preprocessing/encounters/"),
    selectRootNodeIds: (nodes) => {
      const preferredNames = new Set(["encounters__combined_claim_line_crosswalk", "encounters__orphaned_claims"]);

      return nodes
        .filter((node) => node.original_file_path.includes("/final/") || preferredNames.has(node.name))
        .map((node) => node.unique_id);
    }
  },
  {
    key: "claims_member_month",
    label: "Member Month",
    kind: "claims_preprocessing",
    categoryKey: "claims_preprocessing",
    categoryLabel: "Claims Preprocessing",
    title: "Member Month DAG",
    subtitle:
      "Claims preprocessing models that build member-month grain enrollment context for claims enrollment and core outputs.",
    folderLabel: "claims_preprocessing/member_month",
    recurseWhenCollapsed: true,
    collapsedNodeType: "intermediate",
    matchesPath: (modelPath) => modelPath.startsWith("models/claims_preprocessing/member_month/"),
    selectRootNodeIds: (nodes) => nodes.filter((node) => node.name === "member_month__member_month").map((node) => node.unique_id)
  },
  {
    key: "claims_enrollment",
    label: "Claims Enrollment Flags",
    kind: "claims_preprocessing",
    categoryKey: "claims_preprocessing",
    categoryLabel: "Claims Preprocessing",
    title: "Claims Enrollment DAG",
    subtitle:
      "Claims preprocessing models that use member-month context to create enrollment flags for medical and pharmacy claims before core outputs.",
    folderLabel: "claims_preprocessing/claims_enrollment_flags",
    recurseWhenCollapsed: true,
    collapsedNodeType: "intermediate",
    matchesPath: (modelPath) => modelPath.startsWith("models/claims_preprocessing/claims_enrollment_flags/"),
    selectRootNodeIds: (nodes) => {
      const preferredNames = new Set([
        "claims_enrollment__flag_claims_with_enrollment",
        "claims_enrollment__flag_rx_claims_with_enrollment"
      ]);

      return nodes.filter((node) => preferredNames.has(node.name)).map((node) => node.unique_id);
    }
  }
];

const OVERVIEW_CATEGORY_ORDER = {
  input_layer: 0,
  normalized_layer: 1,
  claims_preprocessing: 2,
  core: 3,
  data_marts: 4,
  extensions: 5,
  semantic_layer: 6
};

const normalizedTargetKeyOverrides = {
  provider_attribution: "normalized_attribution"
};

const normalizedTargetBaseNames = new Set([
  "appointment",
  "condition",
  "eligibility",
  "encounter",
  "immunization",
  "lab_result",
  "location",
  "medical_claim",
  "medication",
  "observation",
  "patient",
  "pharmacy_claim",
  "practitioner",
  "procedure",
  "provider_attribution"
]);

const labelOverrides = {
  appointment: "Appointment",
  ahrq_quality_indicators: "AHRQ Quality Indicators",
  ccsr: "CCSR",
  claims_enrollment: "Claims Enrollment Flags",
  cms_hcc: "CMS HCC",
  ed_classification: "ED Classification",
  fhir_preprocessing: "FHIR Preprocessing",
  hcc_recapture: "HCC Recapture",
  hcc_suspecting: "HCC Suspecting",
  medical_claim: "Medical Claim",
  member_month: "Member Month",
  person_id_crosswalk: "Person ID Crosswalk",
  provider_attribution: "Provider Attribution",
  quality_measures: "Quality Measures",
  readmissions: "Readmissions",
  semantic_layer: "Semantic Layer",
  service_categories: "Service Categories"
};

export async function getTargetConfig(targetKey = DEFAULT_TARGET_KEY) {
  const manifest = await loadManifest();
  const catalog = discoverTargetCatalog(manifest);
  return getTargetConfigFromCatalog(catalog, targetKey);
}

export async function listTargetConfigs() {
  const manifest = await loadManifest();
  const catalog = discoverTargetCatalog(manifest);

  return catalog.targets.map((target) => ({
    key: target.key,
    label: target.label,
    title: target.title,
    categoryKey: target.categoryKey,
    categoryLabel: target.categoryLabel,
    kind: target.kind,
    rootCount: target.rootNodeIds.length,
    defaultSelectedNodeId: target.defaultSelectedNodeId
  }));
}

export function getOutputPathForTarget(targetKey = DEFAULT_TARGET_KEY) {
  return path.join(cacheRoot, `${targetKey}-lineage.json`);
}

export async function buildLineagePayload({ targetKey = DEFAULT_TARGET_KEY } = {}) {
  const manifest = await loadManifest();
  const catalog = discoverTargetCatalog(manifest);
  const target = getTargetConfigFromCatalog(catalog, targetKey);

  if (target.key === SYSTEM_OVERVIEW_TARGET_KEY) {
    return buildSystemOverviewPayload({ manifest, catalog, target });
  }

  const nodeMap = { ...(manifest.nodes || {}), ...(manifest.sources || {}) };
  const yamlCache = new Map();
  const graph = collectVisibleGraph({ manifest, catalog, target });
  const nodesById = new Map();
  const depthById = computeDisplayDepths(graph.edges);
  const orderedDisplayNodeIds = Array.from(graph.displayNodes.keys()).sort((leftId, rightId) => {
    const leftDepth = depthById.get(leftId) || 0;
    const rightDepth = depthById.get(rightId) || 0;

    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth;
    }

    const leftNode = graph.displayNodes.get(leftId);
    const rightNode = graph.displayNodes.get(rightId);
    const leftName = leftNode.kind === "collapsed" ? leftNode.target.label : nodeMap[leftNode.actualNodeId]?.name || leftId;
    const rightName =
      rightNode.kind === "collapsed" ? rightNode.target.label : nodeMap[rightNode.actualNodeId]?.name || rightId;

    return leftName.localeCompare(rightName);
  });
  const orderedModelNodeIds = orderedDisplayNodeIds.filter((displayNodeId) => {
    const displayNode = graph.displayNodes.get(displayNodeId);

    return displayNode.kind === "actual" && nodeMap[displayNode.actualNodeId]?.resource_type === "model";
  });
  const modelNodes = [];

  for (const displayNodeId of orderedModelNodeIds) {
    const displayNode = graph.displayNodes.get(displayNodeId);
    const manifestNode = nodeMap[displayNode.actualNodeId];
    const yamlEntry = await loadYamlEntry(manifestNode, yamlCache);
    const columns = buildColumns({
      manifestNode,
      yamlEntry,
      priorNodes: modelNodes
    });
    const baseNodeType = resolveBaseNodeType({
      manifestNode,
      nodeId: displayNode.actualNodeId,
      yamlEntry
    });

    modelNodes.push({
      id: displayNodeId,
      name: manifestNode.name,
      resourceType: manifestNode.resource_type,
      sourceStyle: isSourceDocumentationNode({
        manifestNode,
        nodeId: displayNode.actualNodeId
      }),
      layer: classifyLayer(manifestNode),
      depth: depthById.get(displayNodeId) || 0,
      folderLabel: deriveFolderLabel(manifestNode),
      description: cleanText(firstNonEmpty(yamlEntry?.description, manifestNode.description)),
      materialized: manifestNode.config?.materialized || manifestNode.resource_type || "model",
      technical: {
        alias: manifestNode.alias || manifestNode.name,
        schemaName: manifestNode.schema || null,
        packageName: manifestNode.package_name,
        repository: manifestNode.tuva_source?.id || null,
        repositoryUrl: manifestNode.tuva_source?.repositoryUrl || null,
        revision: manifestNode.tuva_source?.revision || null,
        sourceContentSha256: manifestNode.tuva_source?.contentSha256 || null,
        tags: manifestNode.tags || [],
        primaryKeyColumns: columns.filter((column) => column.isPrimaryKey).map((column) => column.name)
      },
      paths: {
        sql: loadSqlPath(manifestNode),
        yaml: loadYamlPath(manifestNode),
        yamlEntryName: loadYamlEntryName(manifestNode),
        yamlCollectionKey: loadYamlCollectionKey(manifestNode),
        manifestNodeId: displayNode.actualNodeId,
        targetKey: target.key
      },
      mainDependencies: [],
      supportingDependencies: [],
      curated: extractCuratedMetadata(yamlEntry),
      baseNodeType,
      nodeType: resolveDisplayNodeType({
        baseNodeType,
        target,
        nodeId: displayNode.actualNodeId,
        resourceType: manifestNode.resource_type
      }),
      dagBoundary: null,
      seedViewer: null,
      sql: await loadSql(manifestNode),
      columns
    });
  }

  const seedNodes = [];

  for (const displayNodeId of orderedDisplayNodeIds) {
    const displayNode = graph.displayNodes.get(displayNodeId);

    if (displayNode.kind !== "actual") {
      continue;
    }

    const manifestNode = nodeMap[displayNode.actualNodeId];

    if (!manifestNode || manifestNode.resource_type !== "seed") {
      continue;
    }

    const yamlEntry = await loadYamlEntry(manifestNode, yamlCache);
    const columns = buildColumns({
      manifestNode,
      yamlEntry,
      priorNodes: []
    });
    const baseNodeType = resolveBaseNodeType({
      manifestNode,
      nodeId: displayNode.actualNodeId,
      yamlEntry
    });

    seedNodes.push({
      id: displayNodeId,
      name: manifestNode.name,
      resourceType: manifestNode.resource_type,
      sourceStyle: false,
      layer: classifyLayer(manifestNode),
      depth: depthById.get(displayNodeId) || 0,
      folderLabel: deriveFolderLabel(manifestNode),
      description: cleanText(firstNonEmpty(yamlEntry?.description, manifestNode.description)),
      materialized: manifestNode.resource_type || "seed",
      technical: {
        alias: manifestNode.alias || manifestNode.name,
        schemaName: manifestNode.schema || null,
        packageName: manifestNode.package_name,
        repository: manifestNode.tuva_source?.id || null,
        repositoryUrl: manifestNode.tuva_source?.repositoryUrl || null,
        revision: manifestNode.tuva_source?.revision || null,
        sourceContentSha256: manifestNode.tuva_source?.contentSha256 || null,
        tags: manifestNode.tags || [],
        primaryKeyColumns: columns.filter((column) => column.isPrimaryKey).map((column) => column.name)
      },
      paths: {
        sql: loadSqlPath(manifestNode),
        yaml: loadYamlPath(manifestNode),
        yamlEntryName: loadYamlEntryName(manifestNode),
        yamlCollectionKey: loadYamlCollectionKey(manifestNode),
        manifestNodeId: displayNode.actualNodeId,
        targetKey: target.key
      },
      mainDependencies: [],
      supportingDependencies: [],
      curated: extractCuratedMetadata(yamlEntry),
      baseNodeType,
      nodeType: resolveDisplayNodeType({
        baseNodeType,
        target,
        nodeId: displayNode.actualNodeId,
        resourceType: manifestNode.resource_type
      }),
      dagBoundary: null,
      seedViewer: buildSeedViewer(manifestNode),
      sql: await loadSql(manifestNode),
      columns
    });
  }

  const collapsedNodes = [];

  for (const displayNodeId of orderedDisplayNodeIds.filter((candidateId) => graph.displayNodes.get(candidateId).kind === "collapsed")) {
    const displayNode = graph.displayNodes.get(displayNodeId);
    const boundaryTarget = displayNode.target;
    const representativeNodeId =
      boundaryTarget.defaultSelectedNodeId ||
      boundaryTarget.rootNodeIds[0] ||
      displayNode.representativeNodeIds?.[0] ||
      null;
    const representativeNode = representativeNodeId ? nodeMap[representativeNodeId] || null : null;
    const representativeYamlEntry = representativeNode ? await loadYamlEntry(representativeNode, yamlCache) : null;
    const representativeColumns = representativeNode
      ? buildColumns({
          manifestNode: representativeNode,
          yamlEntry: representativeYamlEntry,
          priorNodes: []
        })
      : [];
    const representativeCurated = representativeNode ? extractCuratedMetadata(representativeYamlEntry) : null;
    const collapsedDisplayName = boundaryTarget.collapsedDisplayName || representativeNode?.name || boundaryTarget.label;

    collapsedNodes.push({
      id: displayNodeId,
      name: collapsedDisplayName,
      resourceType: "dag",
      sourceStyle: false,
      layer: boundaryTarget.categoryLabel,
      depth: depthById.get(displayNodeId) || 0,
      folderLabel: boundaryTarget.folderLabel,
      description: cleanText(
        firstNonEmpty(representativeYamlEntry?.description, representativeNode?.description, boundaryTarget.subtitle)
      ),
      materialized: "dag",
      technical: {
        alias: representativeNode?.alias || boundaryTarget.key,
        schemaName: representativeNode?.schema || null,
        packageName: representativeNode?.package_name || corePackageName,
        repository: representativeNode?.tuva_source?.id || null,
        repositoryUrl: representativeNode?.tuva_source?.repositoryUrl || null,
        revision: representativeNode?.tuva_source?.revision || null,
        sourceContentSha256: representativeNode?.tuva_source?.contentSha256 || null,
        tags: representativeNode?.tags || [],
        primaryKeyColumns: representativeColumns.filter((column) => column.isPrimaryKey).map((column) => column.name)
      },
      paths: {
        sql: null,
        yaml: representativeNode ? loadYamlPath(representativeNode) : null,
        yamlEntryName: representativeNode ? loadYamlEntryName(representativeNode) : null,
        yamlCollectionKey: representativeNode ? loadYamlCollectionKey(representativeNode) : null,
        manifestNodeId: representativeNodeId,
        targetKey: boundaryTarget.key
      },
      mainDependencies: [],
      supportingDependencies: [],
      curated: {
        nodeType: representativeCurated?.nodeType || "intermediate",
        whatItRepresents: representativeCurated?.whatItRepresents || "",
        grain: representativeCurated?.grain || "",
        primaryKey: representativeCurated?.primaryKey || "",
        transformationSteps: representativeCurated?.transformationSteps || [
          `This canvas has collapsed the ${boundaryTarget.label} DAG into a single node.`,
          `Open ${boundaryTarget.label} from the selector to inspect its internal models.`
        ]
      },
      baseNodeType:
        representativeNode && representativeNodeId
          ? resolveBaseNodeType({
              manifestNode: representativeNode,
              nodeId: representativeNodeId,
              yamlEntry: representativeYamlEntry
            })
          : boundaryTarget.collapsedNodeType,
      nodeType: "intermediate",
      dagBoundary: {
        targetKey: boundaryTarget.key,
        targetLabel: boundaryTarget.label,
        categoryLabel: boundaryTarget.categoryLabel,
        memberCount: boundaryTarget.memberNodeIds.length,
        outputModels: boundaryTarget.rootNodeLabels,
        recurseWhenCollapsed: boundaryTarget.recurseWhenCollapsed,
        representativeNodeId
      },
      seedViewer: null,
      sql: "",
      columns: representativeColumns
    });
  }

  const externalNodes = orderedDisplayNodeIds.flatMap((id) => {
    const node = nodeMap[id];
    if (node?.resource_type !== "source") return [];
    return [{
      id, name: node.name, resourceType: "source", sourceStyle: true,
      layer: node.source_name === "connector_input" ? "Connector input" : "Optional override",
      depth: depthById.get(id) || 0, folderLabel: "Installing project",
      description: node.description, materialized: "external",
      technical: { alias: node.alias, schemaName: "external", packageName: node.package_name,
        repository: node.tuva_source?.id, revision: node.tuva_source?.revision, tags: node.tags || [], primaryKeyColumns: [] },
      paths: { sql: null, yaml: null, manifestNodeId: id, targetKey: target.key },
      mainDependencies: [], supportingDependencies: [], curated: {},
      baseNodeType: "input", nodeType: "input", dagBoundary: null, seedViewer: null, sql: "", columns: []
    }];
  });
  const preRoleNodes = [...modelNodes, ...seedNodes, ...collapsedNodes, ...externalNodes];
  applyContextualNodeTypes({
    nodes: preRoleNodes,
    edges: graph.edges
  });

  const nodes = preRoleNodes
    .sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }

      if (left.nodeType !== right.nodeType) {
        return sortNodeType(left.nodeType) - sortNodeType(right.nodeType);
      }

      return left.name.localeCompare(right.name);
    })
    .map((node, index) => ({
      ...node,
      runOrder: index + 1
    }));

  for (const node of nodes) {
    nodesById.set(node.id, node);
  }

  const edges = graph.edges
    .slice()
    .sort((left, right) => {
      const leftSourceDepth = depthById.get(left.source) || 0;
      const rightSourceDepth = depthById.get(right.source) || 0;

      if (leftSourceDepth !== rightSourceDepth) {
        return leftSourceDepth - rightSourceDepth;
      }

      if (left.target !== right.target) {
        return left.target.localeCompare(right.target);
      }

      return left.source.localeCompare(right.source);
    });

  const incomingByNodeId = new Map();

  for (const edge of edges) {
    if (!incomingByNodeId.has(edge.target)) {
      incomingByNodeId.set(edge.target, []);
    }

    incomingByNodeId.get(edge.target).push(edge.source);
  }

  for (const node of nodes) {
    const incomingIds = incomingByNodeId.get(node.id) || [];

    node.mainDependencies = incomingIds
      .map((dependencyId) => buildDependencyFromDisplayNode(nodesById.get(dependencyId)))
      .filter(Boolean);

    if (node.resourceType === "dag") {
      node.supportingDependencies = [];
      continue;
    }

    const displayNode = graph.displayNodes.get(node.id);
    const manifestNode = displayNode ? nodeMap[displayNode.actualNodeId] : null;

    node.supportingDependencies = buildSupportingDependencies({
      manifest,
      manifestNode,
      target,
      catalog,
      graph,
      visibleNodeIds: new Set(nodes.map((candidate) => candidate.id))
    });
  }

  const documentedColumns = nodes.reduce((count, node) => {
    return count + node.columns.filter((column) => column.description).length;
  }, 0);
  const hiddenSupportingDependencies = nodes.reduce((count, node) => count + node.supportingDependencies.length, 0);

  return {
    id: `${target.key}-focused-lineage`,
    generatedAt: new Date().toISOString(),
    target: {
      key: target.key,
      label: target.label,
      title: target.title,
      subtitle: target.subtitle,
      categoryKey: target.categoryKey,
      categoryLabel: target.categoryLabel,
      kind: target.kind,
      graphTitle: target.title,
      graphSubtitle: target.subtitle,
      heroNotes: [],
      defaultSelectedNodeId: target.defaultSelectedNodeId
    },
    summary: {
      hiddenSupportingDependencies,
      documentedColumns,
      generatedFrom: "manifest + YAML + SQL"
    },
    sourceArtifacts: buildSourceArtifacts(manifest, target),
    nodes,
    edges
  };
}

async function buildSystemOverviewPayload({ manifest, catalog, target }) {
  const nodeMap = { ...(manifest.nodes || {}), ...(manifest.sources || {}) };
  const yamlCache = new Map();
  const overviewTargets = catalog.targets
    .filter((candidate) => OVERVIEW_CATEGORY_ORDER[candidate.categoryKey] !== undefined)
    .slice()
    .sort((left, right) => {
      const categoryOrder = OVERVIEW_CATEGORY_ORDER[left.categoryKey] - OVERVIEW_CATEGORY_ORDER[right.categoryKey];

      if (categoryOrder !== 0) {
        return categoryOrder;
      }

      return left.label.localeCompare(right.label);
    });
  const edges = collectSystemOverviewEdges({ manifest, catalog });
  const nodes = [];
  const nodesById = new Map();

  for (const overviewTarget of overviewTargets) {
    const representativeNodeId = overviewTarget.defaultSelectedNodeId || overviewTarget.rootNodeIds[0] || null;
    const representativeNode = representativeNodeId ? nodeMap[representativeNodeId] || null : null;
    const representativeYamlEntry = representativeNode ? await loadYamlEntry(representativeNode, yamlCache) : null;
    const representativeColumns = representativeNode
      ? buildColumns({
          manifestNode: representativeNode,
          yamlEntry: representativeYamlEntry,
          priorNodes: []
        })
      : [];
    const description = cleanText(
      firstNonEmpty(representativeYamlEntry?.description, representativeNode?.description, overviewTarget.subtitle)
    );
    const node = {
      id: `dag:${overviewTarget.key}`,
      name: overviewTarget.label,
      resourceType: "dag",
      sourceStyle: false,
      layer: overviewTarget.categoryLabel,
      depth: OVERVIEW_CATEGORY_ORDER[overviewTarget.categoryKey],
      folderLabel: overviewTarget.folderLabel,
      description,
      materialized: "dag",
      technical: {
        alias: representativeNode?.alias || overviewTarget.key,
        schemaName: representativeNode?.schema || null,
        packageName: representativeNode?.package_name || corePackageName,
        repository: representativeNode?.tuva_source?.id || null,
        repositoryUrl: representativeNode?.tuva_source?.repositoryUrl || null,
        revision: representativeNode?.tuva_source?.revision || null,
        sourceContentSha256: representativeNode?.tuva_source?.contentSha256 || null,
        tags: representativeNode?.tags || [],
        primaryKeyColumns: representativeColumns.filter((column) => column.isPrimaryKey).map((column) => column.name)
      },
      paths: {
        sql: null,
        yaml: representativeNode ? loadYamlPath(representativeNode) : null,
        yamlEntryName: representativeNode ? loadYamlEntryName(representativeNode) : null,
        yamlCollectionKey: representativeNode ? loadYamlCollectionKey(representativeNode) : null,
        manifestNodeId: representativeNodeId,
        targetKey: overviewTarget.key
      },
      mainDependencies: [],
      supportingDependencies: [],
      curated: {
        nodeType: resolveOverviewNodeType(overviewTarget.categoryKey),
        whatItRepresents: "",
        grain: "",
        primaryKey: "",
        transformationSteps: [
          overviewTarget.subtitle,
          `Open ${overviewTarget.label} to inspect its internal models.`
        ].filter(Boolean)
      },
      baseNodeType: resolveOverviewNodeType(overviewTarget.categoryKey),
      nodeType: resolveOverviewNodeType(overviewTarget.categoryKey),
      dagBoundary: {
        targetKey: overviewTarget.key,
        targetLabel: overviewTarget.label,
        categoryLabel: overviewTarget.categoryLabel,
        memberCount: overviewTarget.memberNodeIds.length,
        outputModels: overviewTarget.rootNodeLabels,
        recurseWhenCollapsed: true,
        representativeNodeId
      },
      seedViewer: null,
      sql: "",
      columns: representativeColumns,
      runOrder: nodes.length + 1
    };

    nodes.push(node);
    nodesById.set(node.id, node);
  }

  const incomingByNodeId = new Map();

  for (const edge of edges) {
    if (!incomingByNodeId.has(edge.target)) {
      incomingByNodeId.set(edge.target, []);
    }

    incomingByNodeId.get(edge.target).push(edge.source);
  }

  for (const node of nodes) {
    node.mainDependencies = (incomingByNodeId.get(node.id) || [])
      .map((dependencyId) => buildDependencyFromDisplayNode(nodesById.get(dependencyId)))
      .filter(Boolean);
  }

  return {
    id: `${target.key}-overview-lineage`,
    generatedAt: new Date().toISOString(),
    target: {
      key: target.key,
      label: target.label,
      title: target.title,
      subtitle: target.subtitle,
      categoryKey: target.categoryKey,
      categoryLabel: target.categoryLabel,
      kind: target.kind,
      graphTitle: target.title,
      graphSubtitle: target.subtitle,
      heroNotes: [],
      defaultSelectedNodeId: null
    },
    summary: {
      hiddenSupportingDependencies: 0,
      documentedColumns: 0,
      generatedFrom: "manifest stage overview"
    },
    sourceArtifacts: buildSourceArtifacts(manifest, target),
    nodes,
    edges
  };
}

function buildSourceArtifacts(manifest, target) {
  return {
    manifest: manifestPath,
    persistedPayload: getOutputPathForTarget(target.key),
    sourceSetName: manifest.metadata?.tuva_dag?.sourceSetName || null,
    sources: manifest.metadata?.tuva_dag?.sources || [],
    externalRefs: manifest.metadata?.tuva_dag?.externalRefs || [],
    dynamicRefs: manifest.metadata?.tuva_dag?.dynamicRefs || [],
    resolvedDynamicRefs: manifest.metadata?.tuva_dag?.resolvedDynamicRefs || [],
    unresolvedRefs: manifest.metadata?.tuva_dag?.unresolvedRefs || []
  };
}

function collectSystemOverviewEdges({ manifest, catalog }) {
  const edgeSet = new Set();
  const nodeMap = manifest.nodes || {};
  const models = Object.values(nodeMap).filter((node) => node.resource_type === "model");

  for (const model of models) {
    const targetBucket = resolveOverviewTargetForManifestNode(model, catalog);

    if (!targetBucket) {
      continue;
    }

    for (const dependencyId of model.depends_on?.nodes || []) {
      const dependency = nodeMap[dependencyId] || null;

      if (!dependency || dependency.resource_type !== "model") {
        continue;
      }

      const sourceBucket = resolveOverviewTargetForManifestNode(dependency, catalog);

      if (!sourceBucket || sourceBucket.key === targetBucket.key) {
        continue;
      }

      edgeSet.add(`dag:${sourceBucket.key}|||dag:${targetBucket.key}`);
    }
  }

  return Array.from(edgeSet)
    .map((value) => {
      const [source, targetId] = value.split("|||");
      return { source, target: targetId };
    })
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source.localeCompare(right.source);
      }

      return left.target.localeCompare(right.target);
    });
}

function resolveOverviewTargetForManifestNode(manifestNode, catalog) {
  if (!manifestNode || manifestNode.resource_type !== "model") {
    return null;
  }

  const boundaryTarget = catalog.boundaryByNodeId.get(manifestNode.unique_id) || null;

  if (boundaryTarget) {
    return boundaryTarget;
  }

  if (manifestNode.package_name !== corePackageName) {
    return null;
  }

  const modelPath = normalizePath(manifestNode.original_file_path || manifestNode.path || "");

  if (modelPath.startsWith("models/input_layer/")) {
    const baseName = manifestNode.name.replace(/^input_layer__/, "");
    return catalog.targetByKey.get(`input_layer__${baseName}`) || null;
  }

  if (modelPath.startsWith("models/normalized_layer/final/")) {
    const targetKey = getNormalizedTargetKeyFromModelName(manifestNode.name);
    return targetKey ? catalog.targetByKey.get(targetKey) || null : null;
  }

  if (modelPath.startsWith("models/claims_preprocessing/service_category/")) {
    return catalog.targetByKey.get("service_categories") || null;
  }

  if (modelPath.startsWith("models/claims_preprocessing/provider_attribution/")) {
    return catalog.targetByKey.get("provider_attribution") || null;
  }

  if (modelPath.startsWith("models/claims_preprocessing/member_month/")) {
    return catalog.targetByKey.get("member_month") || null;
  }

  if (modelPath.startsWith("models/claims_preprocessing/encounters/")) {
    return catalog.targetByKey.get("encounters") || null;
  }

  if (modelPath.startsWith("models/claims_preprocessing/claims_enrollment_flags/")) {
    return catalog.targetByKey.get("claims_enrollment") || null;
  }

  if (modelPath.startsWith("models/core/final/")) {
    const baseName = manifestNode.name.replace(/^core__/, "");
    const targetKey = baseName;
    return catalog.targetByKey.get(targetKey) || null;
  }

  return null;
}

function resolveOverviewNodeType(categoryKey) {
  if (categoryKey === "input_layer") {
    return "input";
  }

  if (categoryKey === "core" || categoryKey === "data_marts" || categoryKey === "extensions") {
    return "output";
  }

  return "intermediate";
}

export async function persistLineagePayload(payload) {
  const outputPath = getOutputPathForTarget(payload.target?.key || DEFAULT_TARGET_KEY);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return outputPath;
}

export async function readPersistedLineagePayload({ targetKey = DEFAULT_TARGET_KEY } = {}) {
  const outputPath = getOutputPathForTarget(targetKey);
  const payload = JSON.parse(await readFile(outputPath, "utf8"));

  return payload;
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function discoverTargetCatalog(manifest) {
  const allModels = Object.values(manifest.nodes || {}).filter((node) => node.resource_type === "model");
  const models = allModels.filter((node) => node.package_name === corePackageName);
  const standaloneSources = (manifest.metadata?.tuva_dag?.sources || []).filter(
    (source) => source.status === "resolved" && source.packageName !== corePackageName && source.viewer
  );
  const targets = [];
  const boundaryByNodeId = new Map();
  const inputLayerTargets = models
    .filter((node) => normalizePath(node.original_file_path).startsWith("models/input_layer/"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((node) => buildInputLayerTarget(node));

  targets.push({
    key: SYSTEM_OVERVIEW_TARGET_KEY,
    label: "Tuva Overview",
    kind: "overview",
    categoryKey: "overview",
    categoryLabel: "Overview",
    title: "Tuva Overview",
    subtitle: "See how Tuva flows from the Input Layer through claims preprocessing, core, and data marts.",
    folderLabel: "",
    recurseWhenCollapsed: false,
    collapsedNodeType: "intermediate",
    rootNodeIds: [],
    rootNodeLabels: [],
    memberNodeIds: [],
    defaultSelectedNodeId: null
  });

  for (const target of inputLayerTargets) {
    targets.push(target);
  }

  const normalizedTargets = models
    .filter((node) => normalizePath(node.original_file_path).startsWith("models/normalized_layer/final/"))
    .map((node) => buildNormalizedTarget(node, models))
    .filter(Boolean)
    .sort((left, right) => left.label.localeCompare(right.label));

  for (const target of normalizedTargets) {
    targets.push(target);
    for (const nodeId of target.memberNodeIds) {
      boundaryByNodeId.set(nodeId, target);
    }
  }

  const coreTargets = models
    .filter((node) => normalizePath(node.original_file_path).startsWith("models/core/final/"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((node) => buildCoreTarget(node, models));

  for (const target of coreTargets) {
    targets.push(target);
    for (const nodeId of target.memberNodeIds) {
      boundaryByNodeId.set(nodeId, target);
    }
  }

  for (const definition of fixedClaimsTargets) {
    const familyNodes = models.filter((node) => definition.matchesPath(normalizePath(node.original_file_path)));

    if (!familyNodes.length) {
      continue;
    }

    const rootNodeIds = uniqueStrings(definition.selectRootNodeIds(familyNodes));

    if (!rootNodeIds.length) {
      continue;
    }

    const target = buildFamilyTarget({
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      categoryKey: definition.categoryKey,
      categoryLabel: definition.categoryLabel,
      title: definition.title,
      subtitle: definition.subtitle,
      folderLabel: definition.folderLabel,
      recurseWhenCollapsed: definition.recurseWhenCollapsed,
      collapseWhenReferenced: definition.collapseWhenReferenced !== false,
      collapsedNodeType: definition.collapsedNodeType,
      rootNodeIds,
      memberNodeIds: familyNodes.map((node) => node.unique_id),
      manifestNodesById: manifest.nodes || {}
    });

    targets.push(target);

    if (target.collapseWhenReferenced) {
      for (const node of familyNodes) {
        boundaryByNodeId.set(node.unique_id, target);
      }
    }
  }

  for (const source of standaloneSources) {
    const packageNodes = allModels.filter((node) => node.package_name === source.packageName);
    const rootNodeIds = selectStandalonePackageOutputs(packageNodes);

    if (!packageNodes.length || !rootNodeIds.length) {
      continue;
    }

    const targetKey = source.viewer.key || source.id;
    const label = source.viewer.label || formatLabel(targetKey);
    const categoryKey = source.viewer.categoryKey || "data_marts";
    const categoryLabel = source.viewer.categoryLabel || "Data Marts";
    const target = buildFamilyTarget({
      key: targetKey,
      label,
      kind: source.role || "standalone_package",
      categoryKey,
      categoryLabel,
      title: `${label} DAG`,
      subtitle: `Lineage for the ${label} standalone package rooted at its public output models.`,
      folderLabel: source.id,
      recurseWhenCollapsed: true,
      collapsedNodeType: "output",
      rootNodeIds,
      memberNodeIds: packageNodes.map((node) => node.unique_id),
      manifestNodesById: manifest.nodes || {}
    });

    targets.push(target);

    for (const node of packageNodes) {
      boundaryByNodeId.set(node.unique_id, target);
    }
  }

  const sortedTargets = targets.sort((left, right) => {
    const categoryOrder = sortTargetCategory(left.categoryKey) - sortTargetCategory(right.categoryKey);

    if (categoryOrder !== 0) {
      return categoryOrder;
    }

    return left.label.localeCompare(right.label);
  });
  const duplicateTargetKeys = sortedTargets
    .map((target) => target.key)
    .filter((key, index, keys) => keys.indexOf(key) !== index);

  if (duplicateTargetKeys.length) {
    throw new Error(`Duplicate DAG target keys: ${uniqueStrings(duplicateTargetKeys).join(", ")}`);
  }

  return {
    targets: sortedTargets,
    targetByKey: new Map(sortedTargets.map((target) => [target.key, target])),
    boundaryByNodeId
  };
}

function buildCoreTarget(node, models = []) {
  const baseName = node.name.replace(/^core__/, "");
  const targetKey = baseName;
  const label = formatLabel(targetKey);
  const memberNodeIds = [node.unique_id];

  if (baseName === "member_month") {
    const memberMonthModelNames = new Set([
      "core__int_member_months",
      "core__stg_claims_member_months",
      "core__stg_provider_attribution"
    ]);

    for (const model of models) {
      if (memberMonthModelNames.has(model.name)) {
        memberNodeIds.push(model.unique_id);
      }
    }
  }

  return {
    key: targetKey,
    label,
    kind: "core_model",
    categoryKey: "core",
    categoryLabel: "Core",
    title: `${label} DAG`,
    subtitle: `Trace ${node.name} from its upstream sources and transformations into the final core model.`,
    folderLabel: "core/final",
    collapsedDisplayName: baseName === "member_month" ? "member_month" : undefined,
    recurseWhenCollapsed: false,
    collapsedNodeType: "output",
    rootNodeIds: [node.unique_id],
    rootNodeLabels: [node.name],
    memberNodeIds: uniqueStrings(memberNodeIds),
    defaultSelectedNodeId: node.unique_id
  };
}

function buildNormalizedTarget(node, models = []) {
  const baseName = node.name.replace(/^normalized__/, "");

  if (!normalizedTargetBaseNames.has(baseName)) {
    return null;
  }

  const targetKey = getNormalizedTargetKeyFromBaseName(baseName);
  const label = formatLabel(baseName);
  const memberNodeIds = [node.unique_id];

  if (baseName === "medical_claim") {
    const medicalClaimDetailNames = new Set([
      "normalized__medical_claim_diagnoses",
      "normalized__medical_claim_procedures"
    ]);

    for (const model of models) {
      if (medicalClaimDetailNames.has(model.name)) {
        memberNodeIds.push(model.unique_id);
      }
    }
  }

  return {
    key: targetKey,
    label,
    kind: "normalized_model",
    categoryKey: "normalized_layer",
    categoryLabel: "Normalized Layer",
    title: `${label} Normalized Layer DAG`,
    subtitle: `Trace ${node.name} through Tuva normalization before downstream claims preprocessing and core outputs.`,
    folderLabel: "normalized_layer/final",
    collapsedDisplayName: node.name,
    recurseWhenCollapsed: false,
    collapsedNodeType: "intermediate",
    rootNodeIds: [node.unique_id],
    rootNodeLabels: [node.name],
    memberNodeIds: uniqueStrings(memberNodeIds),
    defaultSelectedNodeId: node.unique_id
	  };
	}

function getNormalizedTargetKeyFromModelName(modelName) {
  const baseName = modelName.replace(/^normalized__/, "");

  if (!normalizedTargetBaseNames.has(baseName)) {
    if (baseName === "medical_claim_diagnoses" || baseName === "medical_claim_procedures") {
      return "normalized_medical_claim";
    }

    return null;
  }

  return getNormalizedTargetKeyFromBaseName(baseName);
}

function getNormalizedTargetKeyFromBaseName(baseName) {
  return normalizedTargetKeyOverrides[baseName] || `normalized_${baseName}`;
}

function buildInputLayerTarget(node) {
  const baseName = node.name.replace(/^input_layer__/, "");
  const label = formatLabel(baseName);

  return {
    key: `input_layer__${baseName}`,
    label,
    kind: "input_layer_model",
    categoryKey: "input_layer",
    categoryLabel: "Input Layer",
    title: `${label} Input Layer DAG`,
    subtitle: `${node.name} is the Input Layer contract table consumed by downstream Tuva models.`,
    folderLabel: "input_layer",
    recurseWhenCollapsed: false,
    collapsedNodeType: "input",
    rootNodeIds: [node.unique_id],
    rootNodeLabels: [node.name],
    memberNodeIds: [node.unique_id],
    defaultSelectedNodeId: node.unique_id
  };
}

function buildFamilyTarget({
  key,
  label,
  kind,
  categoryKey,
  categoryLabel,
  title,
  subtitle,
  folderLabel,
  recurseWhenCollapsed,
  collapseWhenReferenced = true,
  collapsedNodeType,
  collapsedDisplayName,
  rootNodeIds,
  memberNodeIds,
  manifestNodesById
}) {
  const sortedRootNodeIds = uniqueStrings(rootNodeIds).sort((leftId, rightId) => {
    const leftName = manifestNodesById[leftId]?.name || leftId;
    const rightName = manifestNodesById[rightId]?.name || rightId;
    return leftName.localeCompare(rightName);
  });

  return {
    key,
    label,
    kind,
    categoryKey,
    categoryLabel,
    title,
    subtitle,
    folderLabel,
    collapsedDisplayName,
    recurseWhenCollapsed,
    collapseWhenReferenced,
    collapsedNodeType,
    rootNodeIds: sortedRootNodeIds,
    rootNodeLabels: sortedRootNodeIds.map((nodeId) => manifestNodesById[nodeId]?.name || nodeId),
    memberNodeIds: uniqueStrings(memberNodeIds),
    defaultSelectedNodeId: sortedRootNodeIds[0] || null
  };
}

function selectStandalonePackageOutputs(packageNodes) {
  const candidates = packageNodes.filter((node) => {
    const modelPath = normalizePath(node.original_file_path || node.path || "");
    const segments = modelPath.split("/").map((segment) => segment.toLowerCase());

    return !segments.includes("staging") && !segments.includes("intermediate");
  });

  if (candidates.length) {
    return candidates.map((node) => node.unique_id);
  }

  const dependedOnNodeIds = new Set(
    packageNodes.flatMap((node) =>
      (node.depends_on?.nodes || []).filter((nodeId) => packageNodes.some((candidate) => candidate.unique_id === nodeId))
    )
  );

  return packageNodes
    .filter((node) => !dependedOnNodeIds.has(node.unique_id))
    .map((node) => node.unique_id);
}

function getTargetConfigFromCatalog(catalog, targetKey) {
  const target = catalog.targetByKey.get(targetKey);

  if (!target) {
    throw new Error(`Unsupported DAG target: ${targetKey}`);
  }

  return target;
}

function collectVisibleGraph({ manifest, catalog, target }) {
  const nodeMap = { ...(manifest.nodes || {}), ...(manifest.sources || {}) };
  const displayNodes = new Map();
  const edgeSet = new Set();
  const visitedActualNodeIds = new Set();

  function addEdge(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) {
      return;
    }

    edgeSet.add(`${sourceId}|||${targetId}`);
  }

  function addDisplayNode(descriptor) {
    const existing = displayNodes.get(descriptor.id);

    if (!existing) {
      displayNodes.set(descriptor.id, descriptor);
      return descriptor;
    }

    if (descriptor.kind === "collapsed") {
      existing.representativeNodeIds = uniqueStrings([
        ...(existing.representativeNodeIds || []),
        ...(descriptor.representativeNodeIds || [])
      ]);
    }

    return existing;
  }

  function visit(nodeId) {
    const manifestNode = nodeMap[nodeId];

    if (!manifestNode) {
      return;
    }

    const descriptor = mapManifestNodeToDisplayDescriptor({
      manifestNode,
      target,
      catalog
    });

    if (!descriptor) {
      return;
    }

    addDisplayNode(descriptor);

    if (manifestNode.resource_type === "seed") {
      return;
    }

    if (shouldStopRecursingAtVisibleNode({ manifestNode, target })) {
      return;
    }

    if (visitedActualNodeIds.has(nodeId)) {
      return;
    }

    visitedActualNodeIds.add(nodeId);

    for (const dependencyId of manifestNode.depends_on?.nodes || []) {
      const dependency = nodeMap[dependencyId] || manifest.sources?.[dependencyId] || null;

      if (!dependency) {
        continue;
      }

      if (dependency.resource_type === "seed" && !isVisibleSupportingSeed(dependency, target)) {
        continue;
      }

      const dependencyDescriptor = mapManifestNodeToDisplayDescriptor({
        manifestNode: dependency,
        target,
        catalog
      });

      if (!dependencyDescriptor) {
        continue;
      }

      addDisplayNode(dependencyDescriptor);
      addEdge(dependencyDescriptor.id, descriptor.id);

      if (dependency.resource_type === "model") {
        if (dependencyDescriptor.kind === "collapsed") {
          if (dependencyDescriptor.target.recurseWhenCollapsed) {
            visit(dependencyId);
          }

          continue;
        }

        visit(dependencyId);
      }
    }
  }

  for (const rootNodeId of target.rootNodeIds) {
    visit(rootNodeId);
  }

  return {
    displayNodes,
    edges: Array.from(edgeSet).map((value) => {
      const [source, targetId] = value.split("|||");
      return { source, target: targetId };
    })
  };
}

function mapManifestNodeToDisplayDescriptor({ manifestNode, target, catalog }) {
  if (!manifestNode) {
    return null;
  }

  if (manifestNode.resource_type === "seed") {
    if (!isVisibleSupportingSeed(manifestNode, target)) {
      return null;
    }

    return {
      id: manifestNode.unique_id,
      kind: "actual",
      actualNodeId: manifestNode.unique_id
    };
  }

  if (manifestNode.resource_type === "source") {
    return { id: manifestNode.unique_id, kind: "actual", actualNodeId: manifestNode.unique_id };
  }

  if (manifestNode.resource_type !== "model") {
    return null;
  }

  const boundaryTarget = catalog.boundaryByNodeId.get(manifestNode.unique_id) || null;

  if (!boundaryTarget || boundaryTarget.key === target.key || shouldExpandBoundaryTarget(boundaryTarget, target)) {
    return {
      id: manifestNode.unique_id,
      kind: "actual",
      actualNodeId: manifestNode.unique_id
    };
  }

  return {
    id: `dag:${boundaryTarget.key}`,
    kind: "collapsed",
    target: boundaryTarget,
    representativeNodeIds: [manifestNode.unique_id]
  };
}

function shouldExpandBoundaryTarget(boundaryTarget, target) {
  return boundaryTarget?.key === "claims_member_month" && target?.key === "claims_enrollment";
}

function shouldStopRecursingAtVisibleNode({ manifestNode, target }) {
  if (!manifestNode || manifestNode.resource_type !== "model" || !target) {
    return false;
  }

  if (isInputLayerModel(manifestNode)) {
    return !(manifestNode.depends_on?.nodes || []).some((id) => id.startsWith("source."));
  }

  return false;
}

function computeDisplayDepths(edges) {
  const parentsByTarget = new Map();
  const nodeIds = new Set();
  const memo = new Map();

  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);

    if (!parentsByTarget.has(edge.target)) {
      parentsByTarget.set(edge.target, []);
    }

    parentsByTarget.get(edge.target).push(edge.source);
  }

  function compute(nodeId) {
    if (memo.has(nodeId)) {
      return memo.get(nodeId);
    }

    const parents = parentsByTarget.get(nodeId) || [];

    if (!parents.length) {
      memo.set(nodeId, 0);
      return 0;
    }

    const depth = Math.max(...parents.map((parentId) => compute(parentId))) + 1;
    memo.set(nodeId, depth);
    return depth;
  }

  for (const nodeId of nodeIds) {
    compute(nodeId);
  }

  return memo;
}

function buildSupportingDependencies({ manifest, manifestNode, target, catalog, graph, visibleNodeIds }) {
  if (!manifestNode) {
    return [];
  }

  if (isInputLayerModel(manifestNode)) {
    return [];
  }

  const supportingDependencies = [];
  const seen = new Set();

  for (const dependencyId of manifestNode.depends_on?.nodes || []) {
    const dependency = manifest.nodes?.[dependencyId] || manifest.sources?.[dependencyId] || null;

    if (!dependency) {
      continue;
    }

    if (dependency.resource_type === "seed" && isVisibleSupportingSeed(dependency, target) && visibleNodeIds.has(dependencyId)) {
      continue;
    }

    if (dependency.resource_type === "model") {
      const displayDescriptor = mapManifestNodeToDisplayDescriptor({
        manifestNode: dependency,
        target,
        catalog
      });

      if (displayDescriptor?.id && visibleNodeIds.has(displayDescriptor.id) && displayDescriptor.id !== manifestNode.unique_id) {
        continue;
      }
    }

    if (!seen.has(dependencyId)) {
      supportingDependencies.push(buildDependency(manifest, dependencyId));
      seen.add(dependencyId);
    }
  }

  return supportingDependencies;
}

function buildDependencyFromDisplayNode(node) {
  if (!node) {
    return null;
  }

  return {
    id: node.id,
    name: node.name,
    resourceType: node.resourceType,
    layer: node.layer,
    folderLabel: node.folderLabel || "",
    nodeType: node.nodeType,
    path: node.paths?.sql || node.paths?.yaml || null
  };
}

function buildColumns({ manifestNode, yamlEntry, priorNodes }) {
  const yamlColumnsByName = new Map(
    (yamlEntry?.columns || []).map((column) => [column.name, normalizeYamlColumn(column)])
  );
  const manifestColumnsByName = manifestNode.columns || {};
  const orderedColumnNames = [
    ...(yamlEntry?.columns || []).map((column) => column.name),
    ...Object.keys(manifestColumnsByName).filter((columnName) => !yamlColumnsByName.has(columnName))
  ];
  const priorColumnsByName = new Map();

  for (const priorNode of priorNodes) {
    for (const column of priorNode.columns) {
      if (!priorColumnsByName.has(column.name) && hasColumnDocumentation(column)) {
        priorColumnsByName.set(column.name, {
          ...column,
          inheritedFrom: priorNode.name
        });
      }
    }
  }

  return orderedColumnNames.map((columnName) => {
    const manifestColumn = manifestColumnsByName[columnName] || {};
    const yamlColumn = yamlColumnsByName.get(columnName) || {};
    const inheritedColumn = priorColumnsByName.get(columnName) || {};
    const description = firstNonEmpty(
      cleanText(yamlColumn.description),
      cleanText(manifestColumn.description),
      cleanText(inheritedColumn.description)
    );
    const dataType = firstNonEmpty(
      yamlColumn.dataType,
      manifestColumn.data_type,
      manifestColumn.config?.meta?.data_type,
      manifestColumn.meta?.data_type,
      inheritedColumn.dataType
    );
    const terminology = firstNonEmpty(
      yamlColumn.terminology,
      manifestColumn.config?.meta?.terminology,
      manifestColumn.meta?.terminology,
      inheritedColumn.terminology
    );
    const terminologyNote = firstNonEmpty(
      yamlColumn.terminologyNote,
      manifestColumn.config?.meta?.terminology_note,
      manifestColumn.meta?.terminology_note,
      inheritedColumn.terminologyNote
    );
    const hasExplicitColumnDefinition = yamlColumnsByName.has(columnName) || Boolean(manifestColumnsByName[columnName]);
    const isPrimaryKey = Boolean(
      yamlColumn.isPrimaryKey ||
        manifestColumn.config?.meta?.is_primary_key ||
        manifestColumn.meta?.is_primary_key ||
        (!hasExplicitColumnDefinition && inheritedColumn.isPrimaryKey)
    );
    const inheritedFrom =
      !cleanText(yamlColumn.description) && !cleanText(manifestColumn.description) && inheritedColumn.inheritedFrom
        ? inheritedColumn.inheritedFrom
        : null;

    return {
      name: columnName,
      description,
      dataType,
      terminology,
      terminologyNote,
      isPrimaryKey,
      inheritedFrom
    };
  });
}

function normalizeYamlColumn(column) {
  return {
    name: column.name,
    description: column.description,
    dataType: column.config?.meta?.data_type || column.meta?.data_type || null,
    terminology: column.config?.meta?.terminology || column.meta?.terminology || null,
    terminologyNote: column.config?.meta?.terminology_note || column.meta?.terminology_note || null,
    isPrimaryKey: Boolean(column.config?.meta?.is_primary_key || column.meta?.is_primary_key)
  };
}

function extractCuratedMetadata(yamlEntry) {
  const modelMeta = extractCandidateMeta(yamlEntry);

  return {
    nodeType: firstNonEmpty(
      cleanText(yamlEntry?.node_type),
      cleanText(modelMeta.node_type),
      cleanText(modelMeta.role)
    ),
    whatItRepresents: firstNonEmpty(
      cleanText(yamlEntry?.what_it_represents),
      cleanText(modelMeta.what_it_represents),
      cleanText(modelMeta.record_represents),
      cleanText(modelMeta.summary)
    ),
    grain: firstNonEmpty(
      cleanText(yamlEntry?.grain),
      cleanText(modelMeta.grain),
      cleanText(modelMeta.record_grain)
    ),
    primaryKey: yamlEntry?.primary_key || modelMeta.primary_key || "",
    hidePrimaryKeyInModelDescription: modelMeta.hide_primary_key_in_model_description === true,
    transformationSteps:
      yamlEntry?.transformation_steps ||
      modelMeta.transformation_steps ||
      modelMeta.steps ||
      []
  };
}

function extractCandidateMeta(yamlEntry) {
  return {
    ...(yamlEntry?.meta || {}),
    ...(yamlEntry?.config?.meta || {}),
    ...(yamlEntry?.meta?.dag || {}),
    ...(yamlEntry?.config?.meta?.dag || {})
  };
}

function hasColumnDocumentation(column) {
  return Boolean(
    cleanText(column.description) ||
      column.dataType ||
      column.terminology ||
      column.isPrimaryKey
  );
}

function buildDependency(manifest, dependencyId) {
  const dependency = manifest.nodes?.[dependencyId] || manifest.sources?.[dependencyId] || null;

  if (!dependency) {
    return {
      id: dependencyId,
      name: dependencyId.split(".").pop(),
      resourceType: dependencyId.split(".")[0],
      layer: "External",
      path: null
    };
  }

  return {
    id: dependencyId,
    name: dependency.name,
    resourceType: dependency.resource_type,
    layer: classifyLayer(dependency),
    folderLabel: deriveFolderLabel(dependency),
    nodeType: resolveNodeType({
      manifestNode: dependency,
      target: null,
      nodeId: dependencyId,
      yamlEntry: null,
      depth: 0
    }),
    path: dependency.path || dependency.original_file_path || null
  };
}

function classifyLayer(node) {
  if (!node) {
    return "Unknown";
  }

  const modelPath = normalizePath(node.original_file_path || node.path || "");

  if (node.package_name === "integration_tests") {
    return "Synthetic input";
  }

  if (node.resource_type === "model" && node.package_name !== corePackageName) {
    if (node.tuva_source?.role === "preprocessing_extension") {
      return "Preprocessing extension";
    }

    if (node.tuva_source?.role === "semantic_layer") {
      return "Semantic layer";
    }

    return "Data mart";
  }

  if (modelPath.includes("models/input_layer/")) {
    return "Input layer";
  }

  if (modelPath.includes("models/normalized_layer/staging/")) {
    return "Normalized layer staging";
  }

  if (modelPath.includes("models/normalized_layer/final/")) {
    return "Normalized layer final";
  }

  if (modelPath.includes("models/core/")) {
    return "Core";
  }

  if (modelPath.includes("models/claims_preprocessing/")) {
    return "Claims preprocessing";
  }

  if (modelPath.includes("models/data_marts/")) {
    return "Data mart";
  }

  if (node.resource_type === "seed") {
    return "Seed";
  }

  return "Model";
}

function isInputLayerModel(node) {
  if (!node || node.resource_type !== "model") {
    return false;
  }

  const modelPath = normalizePath(node.original_file_path || node.path || "");
  return node.package_name === corePackageName && modelPath.startsWith("models/input_layer/");
}

function deriveFolderLabel(node) {
  if (!node) {
    return "";
  }

  const sourcePath = normalizePath(node.original_file_path || node.path || "");

  if (!sourcePath) {
    return "";
  }

  if (node.package_name === "integration_tests" && sourcePath.startsWith("models/")) {
    const relativeDirectory = path.posix.dirname(sourcePath).replace(/^models\/?/, "");
    return relativeDirectory === "." ? "" : relativeDirectory;
  }

  if (sourcePath.startsWith("models/")) {
    const relativeDirectory = path.posix.dirname(sourcePath).replace(/^models\/?/, "");
    return relativeDirectory === "." ? "" : relativeDirectory;
  }

  if (sourcePath.startsWith("seeds/")) {
    const relativeDirectory = path.posix.dirname(sourcePath).replace(/^seeds\/?/, "");
    return relativeDirectory === "." ? "seeds" : `seeds/${relativeDirectory}`;
  }

  return path.posix.dirname(sourcePath) === "." ? "" : path.posix.dirname(sourcePath);
}

function resolveBaseNodeType({ manifestNode, nodeId, yamlEntry }) {
  const manifestNodeType = firstNonEmpty(
    cleanText(manifestNode?.config?.meta?.dag?.node_type),
    cleanText(manifestNode?.meta?.dag?.node_type)
  );
  const explicitNodeType = extractCuratedMetadata(yamlEntry).nodeType;

  if (manifestNode?.resource_type === "seed") {
    return "terminology";
  }

  if (isInputLayerModel(manifestNode)) {
    return "input";
  }

  if (manifestNodeType === "input" || explicitNodeType === "input") {
    return "input";
  }

  if (manifestNode?.package_name === "integration_tests") {
    return "input";
  }

  if (manifestNodeType === "terminology" || explicitNodeType === "terminology") {
    return "terminology";
  }

  if (manifestNodeType === "output" || explicitNodeType === "output") {
    return "output";
  }

  if (manifestNodeType === "intermediate" || explicitNodeType === "intermediate") {
    return "intermediate";
  }

  if (nodeId?.startsWith("source.")) {
    return "input";
  }

  return "intermediate";
}

function resolveDisplayNodeType({ baseNodeType, target, nodeId, resourceType }) {
  if (resourceType === "seed") {
    return "terminology";
  }

  if (baseNodeType === "input") {
    return "input";
  }

  if (target?.rootNodeIds?.includes(nodeId)) {
    return "output";
  }

  return "intermediate";
}

function applyContextualNodeTypes({ nodes, edges }) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByNodeId = new Map();
  const outgoingByNodeId = new Map();

  for (const node of nodes) {
    incomingByNodeId.set(node.id, 0);
    outgoingByNodeId.set(node.id, 0);
  }

  for (const edge of edges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);

    if (!sourceNode || !targetNode) {
      continue;
    }

    if (sourceNode.resourceType === "seed" || targetNode.resourceType === "seed") {
      continue;
    }

    outgoingByNodeId.set(edge.source, (outgoingByNodeId.get(edge.source) || 0) + 1);
    incomingByNodeId.set(edge.target, (incomingByNodeId.get(edge.target) || 0) + 1);
  }

  for (const node of nodes) {
    if (node.resourceType === "seed") {
      node.nodeType = "terminology";
      continue;
    }

    if (node.baseNodeType === "input") {
      node.nodeType = "input";
      continue;
    }

    const incomingCount = incomingByNodeId.get(node.id) || 0;
    const outgoingCount = outgoingByNodeId.get(node.id) || 0;

    if (outgoingCount === 0) {
      node.nodeType = "output";
      continue;
    }

    if (incomingCount === 0) {
      node.nodeType = "input";
      continue;
    }

    node.nodeType = "intermediate";
  }
}

function resolveNodeType({ manifestNode, target, nodeId, yamlEntry }) {
  return resolveDisplayNodeType({
    baseNodeType: resolveBaseNodeType({ manifestNode, nodeId, yamlEntry }),
    target,
    nodeId,
    resourceType: manifestNode?.resource_type
  });
}

export function buildSeedViewer(manifestNode) {
  if (!manifestNode || manifestNode.resource_type !== "seed") {
    return null;
  }

  const hook = normalizePostHook(manifestNode.config?.post_hook);

  if (!hook) {
    return null;
  }

  const version = manifestNode.tuva_source?.assetVersion;
  const prefix = manifestNode.tuva_source?.assetPrefix;
  const bucket = manifestNode.tuva_source?.customBucketName || "tuva-public-resources";
  let objectPath = null;
  const coreMatch = hook.match(/load_versioned_seed\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
  const packageMatch = hook.match(/load_package_seed\(\s*['"]([^'"]+)['"]\s*,\s*var\(\s*['"]([^'"]+)['"]\s*\)\s*,\s*['"]([^'"]+)['"]/);
  const semanticMatch = hook.match(/load_semantic_layer_seed\(\s*['"]([^'"]+)['"]/);
  if (coreMatch) objectPath = `${coreMatch[1].replaceAll("_", "-")}/${coreMatch[2]}`;
  if (packageMatch) {
    if (packageMatch[1] !== prefix) throw new Error(`Asset prefix differs from loader for ${manifestNode.unique_id}.`);
    objectPath = packageMatch[3];
  }
  if (semanticMatch) objectPath = semanticMatch[1];
  if (prefix && version && objectPath) {
    const base = manifestNode.tuva_source?.assetBaseUrl?.replace(/\/$/, "");
    return {
      sourceType: "seed_preview", version, folder: prefix, fileName: objectPath,
      provenance: "dbt_post_hook", unavailableReason: null,
      manifestUrl: base ? `${base}/_manifest.json` : buildS3DownloadUrl(bucket, `${prefix}/${version}/_manifest.json`),
      downloadUrl: base ? `${base}/${ensureGzip(objectPath)}` : buildS3DownloadUrl(bucket, `${prefix}/${version}/${ensureGzip(objectPath)}`),
      assetSource: base ? "configured_preview_snapshot" : "public_snapshot"
    };
  }
  return resolveVersionedCoreSeedPreview(manifestNode, hook) || resolveStandaloneSeedPreview(manifestNode, hook) || {
    sourceType: "seed_preview", downloadUrl: null,
    unavailableReason: `Unrecognized package asset loader for ${manifestNode.unique_id}.`
  };
}

function normalizePostHook(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "")).join("\n");
  }

  return typeof value === "string" ? value : "";
}

function resolveVersionedCoreSeedPreview(manifestNode, hook) {
  const match = hook.match(
    /load_versioned_seed\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/
  );

  if (!match) {
    return null;
  }

  const family = match[1].replace(/-/g, "_");
  const fileName = match[2];
  const explicitVersion = match[3] || null;
  const version = explicitVersion || manifestNode.tuva_source?.seedVersions?.[family] || null;
  const folderByFamily = {
    terminology: "terminology",
    value_sets: "value-sets",
    provider_data: "provider-data",
    synthetic_data: "synthetic-data"
  };
  const folder = folderByFamily[family] || null;
  const bucket =
    manifestNode.tuva_source?.seedBuckets?.[family] ||
    manifestNode.tuva_source?.seedBuckets?.[family.replace(/_/g, "-")] ||
    manifestNode.tuva_source?.customBucketName ||
    "tuva-public-resources";

  return {
    sourceType: "seed_preview",
    family,
    version,
    folder,
    fileName,
    provenance: "dbt_post_hook",
    unavailableReason: !folder || !version ? "The dbt post-hook does not resolve to a pinned Tuva seed asset." : null,
    downloadUrl: folder && version ? buildS3DownloadUrl(bucket, `${folder}/${version}/${ensureGzip(fileName)}`) : null
  };
}

function resolveStandaloneSeedPreview(manifestNode, hook) {
  if (!/load_seed\s*\(/.test(hook)) {
    return null;
  }

  const pathMatch = hook.match(/get_seed_bucket\([^)]*\)\s*~\s*['"]([^'"]+)['"]/);
  const versionMatch = hook.match(
    /var\(\s*['"]([^'"]*seed_version)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/
  );
  const csvMatches = Array.from(hook.matchAll(/['"]([^'"]+\.csv)['"]/g));
  const fileName = csvMatches.at(-1)?.[1] || null;
  const pathPrefix = pathMatch?.[1]?.replace(/^\/+|\/+$/g, "") || null;
  const variableName = versionMatch?.[1] || null;
  const defaultVersion = versionMatch?.[2] || null;
  const version =
    (variableName ? manifestNode.tuva_source?.seedVersionOverrides?.[variableName] : null) || defaultVersion;
  const bucket = manifestNode.tuva_source?.customBucketName || "tuva-public-resources";

  return {
    sourceType: "seed_preview",
    family: "standalone_package",
    version,
    folder: pathPrefix,
    fileName,
    provenance: "dbt_post_hook",
    unavailableReason:
      !pathPrefix || !version || !fileName
        ? "The package seed post-hook does not expose a complete immutable preview path."
        : null,
    downloadUrl:
      pathPrefix && version && fileName
        ? buildS3DownloadUrl(bucket, `${pathPrefix}/${version}/${ensureGzip(fileName)}`)
        : null
  };
}

function ensureGzip(fileName) {
  return fileName.endsWith(".gz") ? fileName : `${fileName}.gz`;
}

function buildS3DownloadUrl(bucket, objectPath) {
  const normalizedBucket = String(bucket || "tuva-public-resources")
    .replace(/^s3:\/\//, "")
    .replace(/^\/+|\/+$/g, "");
  const normalizedPath = String(objectPath || "").replace(/^\/+/, "");
  return `https://${normalizedBucket}.s3.amazonaws.com/${normalizedPath}`;
}

function sortNodeType(nodeType) {
  const priorities = {
    input: 1,
    terminology: 2,
    intermediate: 3,
    output: 4
  };

  return priorities[nodeType] || 99;
}

async function loadYamlEntry(manifestNode, yamlCache) {
  const documentationReference = resolveDocumentationReference(manifestNode);
  const yamlPath = documentationReference?.yamlPath;

  if (!yamlPath) {
    return null;
  }

  if (!yamlCache.has(yamlPath)) {
    yamlCache.set(yamlPath, parseYaml(await readFile(yamlPath, "utf8")) || {});
  }

  const yamlDocument = yamlCache.get(yamlPath);
  const entries =
    manifestNode.resource_type === "seed"
      ? Array.isArray(yamlDocument.seeds)
        ? yamlDocument.seeds
        : []
      : Array.isArray(yamlDocument.models)
        ? yamlDocument.models
        : [];

  return entries.find((entry) => entry.name === documentationReference.entryName) || null;
}

async function loadSql(manifestNode) {
  return readFile(loadSqlPath(manifestNode), "utf8");
}

function loadYamlPath(manifestNode) {
  return resolveDocumentationReference(manifestNode)?.yamlPath || null;
}

function loadYamlEntryName(manifestNode) {
  return resolveDocumentationReference(manifestNode)?.entryName || null;
}

function loadYamlCollectionKey(manifestNode) {
  return manifestNode?.resource_type === "seed" ? "seeds" : "models";
}

function resolveDocumentationReference(manifestNode) {
  const inputLayerEntryName = resolveInputLayerEntryName(manifestNode);

  if (inputLayerEntryName) {
    const inputLayerRoot = packageRoots[manifestNode.package_name] || repoRoot;
    const yamlPath = path.join(inputLayerRoot, "models", "input_layer", `${inputLayerEntryName}.yml`);

    if (existsSync(yamlPath)) {
      return {
        yamlPath,
        entryName: inputLayerEntryName
      };
    }
  }

  const yamlPath = patchPathToAbsolute(manifestNode.patch_path);

  if (!yamlPath) {
    return null;
  }

  return {
    yamlPath,
    entryName: manifestNode.name
  };
}

function resolveInputLayerEntryName(manifestNode) {
  if (!manifestNode || manifestNode.resource_type !== "model") {
    return null;
  }

  if (isInputLayerModel(manifestNode)) {
    return manifestNode.name;
  }

  const tags = uniqueStrings([...(manifestNode.tags || []), ...(manifestNode.config?.tags || [])]);
  const nodeType = firstNonEmpty(
    cleanText(manifestNode.config?.meta?.dag?.node_type),
    cleanText(manifestNode.meta?.dag?.node_type)
  );

  if (manifestNode.package_name === "integration_tests" && (nodeType === "input" || tags.includes("input_layer"))) {
    return `input_layer__${manifestNode.name}`;
  }

  return null;
}

function isSourceDocumentationNode({ manifestNode, nodeId }) {
  if (!manifestNode) {
    return false;
  }

  if (nodeId?.startsWith("source.")) {
    return true;
  }

  return manifestNode.package_name === "integration_tests";
}

function loadSqlPath(manifestNode) {
  const packageRoot = packageRoots[manifestNode.package_name];

  if (!packageRoot) {
    throw new Error(`Unknown dbt package root for ${manifestNode.package_name}`);
  }

  return path.join(packageRoot, manifestNode.original_file_path);
}

function patchPathToAbsolute(patchPath) {
  if (!patchPath) {
    return null;
  }

  const [packageName, packageRelativePath] = patchPath.split("://");
  const packageRoot = packageRoots[packageName];

  if (!packageRoot) {
    return null;
  }

  return path.join(packageRoot, packageRelativePath.replace(/\?.*$/, ""));
}

export function isVisibleSupportingSeed(node, target = null) {
  if (!node || node.resource_type !== "seed") {
    return false;
  }

  const seedName = node.name || "";
  const seedPath = normalizePath(node.original_file_path || node.path || "");

  return (
    Boolean(node.tuva_source?.assetPrefix) ||
    seedName.startsWith("terminology__") ||
    seedName.startsWith("value_set__") ||
    seedPath.includes("/terminology/") ||
    seedPath.includes("/value_sets/")
  );
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function formatLabel(value) {
  if (!value) {
    return "";
  }

  if (labelOverrides[value]) {
    return labelOverrides[value];
  }

  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sortTargetCategory(categoryKey) {
  const priorities = {
    overview: 0,
    input_layer: 1,
    normalized_layer: 2,
    claims_preprocessing: 3,
    core: 4,
    data_marts: 5,
    extensions: 6,
    semantic_layer: 7
  };

  return priorities[categoryKey] ?? 99;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (value && typeof value !== "string") {
      return value;
    }
  }

  return "";
}

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function main() {
  const targetKey = parseTargetKeyFromArgv(process.argv.slice(2));
  const payload = await buildLineagePayload({ targetKey });
  const outputPath = await persistLineagePayload(payload);

  process.stdout.write(`Wrote ${outputPath}\n`);
}

function parseTargetKeyFromArgv(argv) {
  const targetIndex = argv.findIndex((argument) => argument === "--target");

  if (targetIndex >= 0 && argv[targetIndex + 1]) {
    return argv[targetIndex + 1];
  }

  if (argv[0] && !argv[0].startsWith("-")) {
    return argv[0];
  }

  return DEFAULT_TARGET_KEY;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
