# AI Visibility Pipeline Fixes — Phase 5

## Findings

- Gemini text generation worked in the standalone connection check, but response extraction failed because the parser's Zod schema emitted an `exclusiveMinimum` constraint unsupported by Google's function declaration schema.
- The generic LangChain structured-output wrapper was also incompatible with the rotating Gemini model's returned message type, causing `Input is not an AIMessageChunk`.
- The live test's one-query override hid the configured tier query volumes.
- Tier 3 scoring used a hardcoded competitive-fairness value instead of benchmark evidence.
- Report confidence inputs were constants, and the output nested score internals in `findings.metrics` rather than separating public metrics from scoring details.

## Changes

- Kept tier startup-query caps at 3, 5, and 7. Confidence query coverage now compares emitted startup queries against those limits.
- Changed the parser's positive integer constraint to `.min(1)` and delegated structured output to Google's native implementation while retaining per-request API-key rotation.
- Tier 3 benchmarking now issues comparable direct prompts for the startup and competitors. Fairness is derived from parsed mention-rate gaps; it is `null` with an explicit limitation when there is no comparable evidence.
- Ground-truth completeness counts the four required fields and three optional fields. Report confidence uses measured provider success, parsing success, ground-truth completeness, and query coverage.
- `findings.metrics` now contains flat display metrics, including mention rate by model. Detailed component scores, weights, coverage, scoring version, and scoring limitations are preserved under `scoring_details`.
- Parse failures are represented in flags and limitations; when every successful provider response fails parsing, the flag severity is critical. Summary grammar handles a single parsed response.
- Longitudinal comparison and persistence fixtures were updated for the new output shape.

## Verification

- `npm run typecheck`
- `npm run test:ai-visibility-tools` — 58 tests passed.
- `npm run test:ai-visibility-live` — all three Gemini-backed tiers passed; the runs parsed 3, 5, and 9 responses respectively. Their status was partial only because parsed evidence had incomplete confidence, not because Gemini requests or parsing failed.
