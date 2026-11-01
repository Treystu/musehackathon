# Golden corpus coverage

Generated from `tests/ai/golden-corpus.json` and the registry by
`tests/ai/golden-eval.test.ts`. Denominator is the registry itself
(15 metrics), not a hand-maintained fixture list.

- Corpus version: 1
- Intent cases: 91
- Explain fixtures: 15
- Intent coverage: 69 of 69 supported metric x mode x geography combinations (100.0%)
- Explain coverage: 15 of 15 metrics (100.0%)
- Explain validator fixtures: 15/15 good prose pass; 15/15 invented-numeral prose withheld

| Metric | Intent covered | Explain fixture | Missing combinations |
| --- | --- | --- | --- |
| median_gross_rent | 6/6 | yes | - |
| median_rent_burden_pct | 6/6 | yes | - |
| median_home_value | 6/6 | yes | - |
| median_household_income | 5/5 | yes | - |
| households | 6/6 | yes | - |
| population | 4/4 | yes | - |
| renter_occupied | 4/4 | yes | - |
| owner_occupied | 4/4 | yes | - |
| vacant_units | 4/4 | yes | - |
| no_internet_access | 4/4 | yes | - |
| average_household_size | 4/4 | yes | - |
| median_age | 4/4 | yes | - |
| below_poverty_count | 4/4 | yes | - |
| bachelors_count | 4/4 | yes | - |
| commuting_workers | 4/4 | yes | - |
