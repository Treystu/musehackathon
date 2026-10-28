import { describe, expect, it } from 'vitest';
import {
  GOLDEN_CASES,
  createGoldenProvider,
  registryFixtures,
  runGolden,
} from '../../src/core/ai/harness';
import { DISPLAYABLE_KEYS, FILTER_LEGAL_KEYS, validateIntent } from '../../src/core/ai/intent-schema';
import { METRIC_KEYS } from '../../src/core/civicscope-registry';

/**
 * Item 4a committed no-shift pin (replaces the removed temp probe).
 * Fails if a future registry hand-edit shifts a corpus verdict — it asserts
 * on corpus verdicts themselves, not merely "suite green".
 */
describe('no-shift pin (corpus 12/12 exact, derivation shifted nothing)', () => {
  it('corpus is still 12/12 exact', async () => {
    expect(GOLDEN_CASES).toHaveLength(12);
    const golden = await runGolden(createGoldenProvider());
    expect(golden).toHaveLength(12);
    expect(golden.filter((g) => g.exact)).toHaveLength(12);
    expect(golden.every((g) => g.valid)).toBe(true);
    for (const c of GOLDEN_CASES) {
      const check = validateIntent(c.cannedIntent);
      expect(check.ok, `${c.id} cannedIntent must validate`).toBe(true);
    }
  });

  it('derivation shifted nothing: fixtures track the registry verdicts', () => {
    expect(METRIC_KEYS).toHaveLength(15);
    expect(DISPLAYABLE_KEYS).toHaveLength(15);
    expect(FILTER_LEGAL_KEYS).toHaveLength(5);
    const fixtures = registryFixtures();
    expect(fixtures).toHaveLength(DISPLAYABLE_KEYS.length);
    expect(fixtures.filter((f) => f.kind === 'filter-legal-accept')).toHaveLength(
      FILTER_LEGAL_KEYS.length,
    );
    for (const f of fixtures) {
      const r = validateIntent(f.raw);
      expect(r.ok, `${f.id} verdict`).toBe(f.expectedOk);
      if (!f.expectedOk && !r.ok) {
        expect(r.error).toBe('proxy_metric_blocked');
      }
    }
  });
});
