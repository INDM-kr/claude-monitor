# L0 golden fixtures

`observed-*.jsonl` contains a content-free projection of observed Claude Code log shapes. Numeric usage, version and stop reason are retained; identities, model, timestamps and paths are replaced. Content is always empty. Each file is an independent scenario; shared example identifiers do not indicate a relationship between different fixtures.

`synthetic-cases.json` defines ten deliberately constructed edge cases. `acceptedIndexes` identifies the expected canonical records, including filtering and conflict exclusions. This is an explicit oracle, not a production normalizer. In L1, run real normalization against each case and compare request count, token totals and diagnostics to the manifest.

`synthetic-stream.part1.txt` ends in partial JSON, after a valid row and one malformed complete row. Append part 2 to complete the next valid row. The expected checkpoint remains before the incomplete row until it completes. A malformed complete row must not permanently block later rows.

`manifest.json` records source provenance, expected values and future crash/restart acceptance conditions. File rotation, source replays and crash atomicity still require real ingestion tests in L1.

Verify the committed fixture data with `python3 scripts/verify-l0-fixtures.py` from the repository root. Re-run the audit into `.scratch/` when investigating new logs, and review any fixture/expectation changes together.
