# Registry port manifest (PORT step — pre-existing, not contest-built)

- **Source:** public `Sovereign-Communication/civicscope`
- **Pinned SHA:** `3aa7e10dc59e764a8636aa273d4ff86714a3e782` (verified: scratch clone
  `git rev-parse HEAD` equals the pin exactly; scratch lives at
  `/tmp/civicscope-scratch`, outside the workbench, never committed)
- **Ported file:** `src/core/civicscope-registry.ts` (new, ~210 lines)
- **Composed mechanically** (`sed` line ranges, no retyping):
  - `src/core/types.ts` lines 33–50 → `MetricCategory`, `MetricUnit` (byte-identical)
  - `src/core/plugins/acs.ts` lines 250–383 → 15-key `METRIC_DEFS` (with `unit` /
    `category` / `betterWhen` / `note` field annotations), `METRIC_DEFS_BY_KEY`,
    `METRIC_KEYS`
  - `src/core/sortable-surface.ts` lines 38–64 → doc comment, 5-key
    `SORTABLE_METRIC_KEYS`, `SortableMetricKey`, `isSortableMetricKey`
- **Two value-preserving adaptations** (types/visibility only, zero data change):
  1. `METRIC_DEFS` is `export`ed (bare `const` in source) so the workbench can
     consume it as the single source of truth.
  2. The inline anonymous row annotation is named `MetricDef`, with
     `MetricValue['unit'/'category']` spelled as the copied unions.
- **Intentionally NOT ported:** `VARS` / `SCREEN_VARS` / `DETAIL_VARS`, Census fetch
  paths (`fetchAreas`, `fetchCached`), sentinel logic, `TABLE_OF` /
  `tableOfMetric`, plugin wiring (`acsHousingPlugin`, incl. the `legal` block),
  `PluginRegistry` / `DRILLDOWN_PLUGIN_IDS`, executor, remaining types. The
  `legal: { suppressBelow: 20 }` notice stays with the unported plugin wiring;
  suppression behavior is unchanged.
- **Isolation check passed:** the defs block is pure data (only type-level
  dependency on the copied unions); the sortable guard depends only on
  `METRIC_DEFS_BY_KEY`. No runtime import from outside the file.
- **Status:** DERIVE landed — `src/core/ai/intent-schema.ts` re-exports
  `SORTABLE_METRIC_KEYS` / `METRIC_KEYS` as the allowlists (same reference),
  and `registryFixtures()` in `src/core/ai/harness.ts` builds from the
  registry with optional source overrides (defaults = the ported sets).
  Derivation shifted nothing: post-derive arrays are element-wise identical
  to the pre-derive hand lists (temp probe, passed then removed).
- **Triage note:** filter-legal == sortable because the sortable surface is the audited fair-housing gate; `figure-filters.ts`'s 4-filter subset was deliberately not modeled (fewer fixed filters, same allowlist).
