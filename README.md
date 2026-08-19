# Tuva DAG Viewer

Static DAG viewer for the Tuva dbt package.

The production site should be configured in Netlify as a separate site with:

- Repository: `tuva-health/dag-viewer`
- Base directory: repository root
- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- Custom domain: `dagviewer.thetuvaproject.com`
- Branch: `agent/dag-core-cutover-bridge`

Keep Netlify auto-publishing locked to the reviewed deploy. Rebuild this branch
only when intentionally validating the same immutable compatibility snapshot.

This deployment-only compatibility branch clones `tuva-health/tuva-core` at
`9b59760465c757e94a41b4ac2cede7c40c2e9086`, builds a lightweight
dbt manifest from the model YAML, seed YAML, SQL, and CSV files, then exports
static lineage JSON for every DAG target. The immutable source pin preserves the
current production DAG while Tuva Core's `main` branch is replaced by the 1.0
candidate. This branch must not be merged into the standalone repository's
`main` branch.

For local development against a sibling Tuva Core checkout:

```bash
npm install
npm run build:local
npm run serve
```

For local editing mode, use the dev server instead:

```bash
npm install
npm run dev
```

The dev server listens on `127.0.0.1:8000`, serves the app in live mode, and
enables the modal `Edit`/`Save` controls. Saves write back to the checked-out dbt
SQL and YAML files and run `scripts/dbt-local parse` so the local DAG reflects
dependency changes. The committed `public/index.html` remains hard-coded to
static mode, and the Netlify build publishes only `dist`, so edit mode is not
available on the public site.

To build against a local source checkout:

```bash
TUVA_DAG_SOURCE_ROOT=/path/to/tuva-core npm run build
```

The production-style build intentionally rejects repository or ref overrides so
the hosted compatibility artifact cannot drift from the reviewed snapshot.
