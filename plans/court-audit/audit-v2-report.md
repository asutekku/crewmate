# Court rubric v2 - P1 report

*Generated from immutable raw labels; adjudication is not included.*

## Result

**PASS**

- act boundary F1: 0.852
- act type F1: 0.835
- whole-message exact: 4/15 (secondary only)
- original-15 regression: PASS

## Per-dimension agreement

| dimension | applicable | raw | kappa |
|---|---:|---:|---:|
| priority | 15 | 80.0% | 0.700 |
| author | 49 | 100.0% | 1.000 |
| recipients | 49 | 100.0% | 1.000 |
| responsibility | 49 | 100.0% | 1.000 |
| commitmentMode | 9 | 88.9% | 0.769 |
| conditionHandling | 49 | 95.9% | 0.916 |
| constraintsPresence | 49 | 95.9% | 0.484 |
| anchorPresence | 49 | 55.1% | 0.250 |
| correctionType | 4 | 75.0% | 0.600 |
| evidenceConfidence | 49 | 95.9% | 0.000 |
| clearancePresence | 15 | 100.0% | 1.000 |
| hazardPresence | 15 | 86.7% | 0.706 |
| provenancePresence | 15 | 86.7% | 0.000 |
| declarationPresence | 15 | 100.0% | n/a (both reviewers have no variance) |
| responsePresence | 15 | 93.3% | 0.857 |
| outcomePresence | 15 | 100.0% | 1.000 |

## Gate findings

- No failures.

Provisional for low holdout support: correctionType.
Explicitly deferred from P2: constraintsPresence, anchorPresence, evidenceConfidence, provenancePresence. See audit-v2-manifest.json for reasons.

Support counts for the full 45-message primary corpus are preserved in `audit-v2-regression.json`.
