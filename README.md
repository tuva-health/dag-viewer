# Tuva DAG Viewer

Static lineage catalog for Tuva Core and all eight standalone packages.

The production site should be configured in Netlify as a separate site with:

- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- Custom domain: `dagviewer.thetuvaproject.com`
- Branch: `main`

Do not configure an ignore rule that skips builds when an approved Tuva source
changes. The viewer intentionally rebuilds from the explicit multi-repository
contract in `dag-sources.json`.

The production build resolves Tuva Core and the eight accepted Tuva 1.0
standalone packages at their configured refs, scans each package's model YAML,
seed YAML, SQL, and CSV metadata, and exports one package-namespaced lightweight
manifest. Repository identity and dbt package identity are tracked explicitly;
the `ccsr` repository currently declares the `ccsr` dbt package. Literal one-
and two-argument `ref()` calls are resolved across the source set. Core
connector roots and declared optional package overrides are represented as
external inputs rather than false missing nodes.

Every build writes `dist/data/source-provenance.json` and embeds the same source
set in each lineage payload. Provenance includes the repository URL, configured
ref, exact Git commit, dirty state, and SHA-256 fingerprint of every scanned
input. The required `semantic-layer` repository declares dbt package `semantic_layer`.
The checked-in source contract pins all nine repositories to exact commits.
Update that reviewed lock to refresh the production catalog; the build does not
implicitly follow `main`. The Sources page exposes every code version, commit,
asset version, and scanned-content fingerprint. Downloadable provenance also
records the exact SHA-256 of each asset manifest used for previews.

This is an architecture catalog across configurations, not the enabled graph of
one dbt invocation. Data Quality catalog loops use the union of their declared
Input Layer/flag sources; provenance records those expanded dynamic refs.
Unknown dynamic refs and missing literal refs fail the build. Shared domain
switches and user overrides may select a subset at runtime.

Seed previews follow the package's independent asset-version default and actual
loader path. Every downloaded gzip is streamed, counted, and checked against
its public asset-manifest SHA-256 before the preview is cached. Missing or
inconsistent previews fail the build; large provider files do not have to fit
in memory. Builds never alter package data assets.

For local development against the current checkout:

```bash
npm ci
npm run build:local
npm run serve
```

`build:local` explicitly opts into the sibling paths listed in
`dag-sources.json`. Use `npm run build` for production-style detached checkouts
at configured refs.

For local editing mode, use the dev server instead:

```bash
npm ci
npm run dev
```

The dev server listens on `127.0.0.1:8000`, serves the app in live mode, and
enables the modal `Edit`/`Save` controls. Saves write back to the checked-out dbt
SQL and YAML files and run `scripts/dbt-local parse` so the local DAG reflects
dependency changes. The committed `public/index.html` remains hard-coded to
static mode, and the Netlify build publishes only `dist`, so edit mode is not
available on the public site.

Edit mode currently uses one aggregate dbt manifest rooted in Tuva Core. Use
the static multi-source build for release review; extending write-back and dbt
parse safely across multiple repositories is separate work.

To force Core to a different checkout, override any source path, or pin source
refs (branch, tag, or exact commit SHA):

```bash
TUVA_CORE_PATH=/path/to/tuva-core npm run build
TUVA_DAG_SOURCE_ROOT=/path/to/tuva-core npm run build
TUVA_DAG_GITHUB_REF=main npm run build
TUVA_DAG_SOURCE_PATHS='{"quality_measures":"/path/to/quality_measures"}' npm run build
TUVA_DAG_SOURCE_REFS='{"tuva-core":"<sha>","quality_measures":"<sha>"}' npm run build
```

`TUVA_DAG_SOURCE_PATHS` and `TUVA_DAG_SOURCE_REFS` are JSON objects keyed by
repository id or dbt package name. Local paths are never selected implicitly in
production mode; provenance identifies configured paths and warns during the
source audit when scanned content is dirty or its revision differs from the
configured ref.

A prepared local asset snapshot can be reviewed before publication by serving
its directory over HTTP and selecting its bundle root explicitly:

```bash
TUVA_DAG_ASSET_BASE_URLS='{"tuva-core":"http://127.0.0.1:18416"}' npm run build
```

This root must include `_manifest.json` and the complete payload paths. Hash,
row-count, and checked-in CSV header checks remain required. The Sources page
and provenance identify the override. Such a build is a local review artifact;
rebuild against the public defaults after the reviewed assets are published
before deploying the viewer.

`npm run build` also runs all three generated graph audits.

Validation:

```bash
npm test
npm run audit:sources
npm run audit:overview
npm run audit:edges
```
