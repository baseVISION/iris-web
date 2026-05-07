<!-- GitHub Copilot reads this file automatically for workspace context. -->
<!-- For full details see AGENTS.md at the repo root. -->

This is **baseVISION/iris-web**, a fork of dfir-iris/iris-web (DFIR case-management platform).

## Branches
- `bv-develop` — integration branch, branch from here for fixes/features; direct push allowed but PR is preferred
- `bv-main` — production, PR only from `release/*` branches
- `origin/master`, `origin/develop` — upstream mirrors, never modify

## Commit prefixes
`[FIX]`, `[IMP]`, `[ADD]` = upstream-eligible | `[BV]`, `[BV-FIX]` = BV-internal only (never contribute upstream)

## Branch naming
`fix/<name>` · `feature/<name>` · `release/<version>` · `sync/upstream-<date>` · `contrib/<name>`

`contrib/` branches must be created from `upstream/develop`, not `bv-develop`. Only cherry-pick commits without a `[BV]` prefix.

## Version string
`source/app/configuration.py` → `IRIS_VERSION`. Format: `vX.Y.Z-bvN`. Managed by `.bumpversion.cfg`.

See [AGENTS.md](../AGENTS.md) for full workflow details.
