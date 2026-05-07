# Agent Instructions — baseVISION iris-web

This is a fork of [dfir-iris/iris-web](https://github.com/dfir-iris/iris-web) maintained by baseVISION.
The upstream project is a DFIR case-management platform (Python/Flask backend, SvelteKit frontend, PostgreSQL).

---

## Branch Structure

| Branch | Purpose | Push rules |
|---|---|---|
| `bv-main` | Production-stable. Tagged releases deploy to AKS prod. | PR only, 1 approval + CI green |
| `bv-develop` | Integration branch. Pushes auto-deploy to AKS staging. | Direct push allowed; PR preferred |
| `origin/master` | Upstream master mirror — **never modify** | Read-only |
| `origin/develop` | Upstream develop mirror — **never modify** | Read-only |

Short-lived branches (delete after merge):

| Pattern | Target | Purpose |
|---|---|---|
| `fix/<name>` | `bv-develop` | Bug fix |
| `feature/<name>` | `bv-develop` | New feature |
| `release/<version>` | `bv-main` | Release prep |
| `sync/upstream-<date>` | `bv-develop` | Upstream merge |
| `contrib/<name>` | upstream `develop` | Contribution to dfir-iris |

**Preferred:** branch from `bv-develop`, open a PR, merge. Direct pushes to `bv-develop` are allowed but should be reserved for trivial changes. `bv-main` is protected — PRs only. Exception: `contrib/` branches must be branched from `upstream/develop`.

---

## Commit Message Convention

Every commit must start with one of these prefixes:

| Prefix | Meaning | Contribute upstream? |
|---|---|---|
| `[FIX]` | Bug fix | Yes — cherry-pick candidate |
| `[IMP]` | Improvement | Yes — cherry-pick candidate |
| `[ADD]` | New feature | Case by case |
| `[BV]` | baseVISION-internal | **Never** |
| `[BV-FIX]` | Fix specific to BV infra/config | **Never** |

**Rule:** commits without a `[BV]` prefix must be clean enough to open a PR on upstream without modification. Do not mix BV-specific logic with upstream-eligible commits.

---

## Key Workflows

### Normal fix or feature

```bash
git checkout bv-develop && git pull origin bv-develop
git checkout -b fix/<name>
# make changes, commit with [FIX]/[IMP]/[ADD]/[BV] prefix
git push origin fix/<name>
# Open PR → bv-develop
# Delete branch after merge
```

### Release to production

```bash
git checkout bv-develop && git pull
git checkout -b release/<version>   # e.g. release/2.5.0-bv1
# Bump version in:
#   source/app/configuration.py  → IRIS_VERSION = "v<version>"
#   README.md
#   docker-compose.yml
git commit -m "[BV] Bump version to <version>"
git push origin release/<version>
# Open PR → bv-main (requires 1 review + CI)
# After merge: tag vX.Y.Z-bvN and push tag → triggers AKS prod deploy
```

### Syncing upstream bugfixes

```bash
git fetch upstream
git checkout -b sync/upstream-<YYYY-MM> bv-develop
git merge upstream/develop   # resolve conflicts
git push origin sync/upstream-<YYYY-MM>
# Open PR → bv-develop
```

### Contributing a fix back to upstream

```bash
git checkout -b contrib/<name> upstream/develop   # branch from upstream, NOT bv-develop
git cherry-pick <commit-hash>                     # only commits WITHOUT [BV] prefix
git push origin contrib/<name>
# Open PR on github.com/dfir-iris/iris-web targeting their develop branch
# Delete branch after upstream merge
```

---

## Version Numbering

- Format: `vX.Y.Z-bvN` (e.g. `v2.5.0-bv1`)
- `source/app/configuration.py` contains `IRIS_VERSION` — this is the canonical version string
- `.bumpversion.cfg` controls automated bumping across `configuration.py`, `README.md`, and `docker-compose.yml`

---

## CI / GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | All pushes and PRs | Static checks, Docker builds, API tests, DB migration tests, e2e tests |
| `build-webApp.yml` | Manual only (disabled) | GHCR publish — replaced by Azure DevOps + ACR |
| `build-db.yml` | Manual only (disabled) | GHCR publish — replaced by Azure DevOps + ACR |
| `build-nginx.yml` | Manual only (disabled) | GHCR publish — replaced by Azure DevOps + ACR |
| `chart-releaser.yml` | Push to `bv-main` or manual | Helm chart release |

CI must be green before any PR can be merged. The relevant required check is named **"Continuous Integration"**.

---

## Important Files

| File | Purpose |
|---|---|
| `source/app/configuration.py` | App config including `IRIS_VERSION` |
| `source/requirements.txt` | Python dependencies |
| `docker-compose.yml` | Production compose (references version tag) |
| `docker-compose.bv.yml` | Development compose (used by CI and local dev) |
| `docker/webApp/Dockerfile` | App image |
| `docker/db/Dockerfile` | DB image |
| `docker/nginx/Dockerfile` | Nginx image |
| `deploy/kubernetes/` | Helm charts for AKS |
| `.bumpversion.cfg` | Version bump configuration |
| `BV-DEV-CONCEPT.md` | Full fork strategy and open decisions (not committed to branches) |

---

## Do Not

- Do **not** push directly to `bv-main` or `bv-develop` — always use a PR
- Do **not** commit to or rebase `origin/master` or `origin/develop` — they are upstream mirrors
- Do **not** include `[BV]`-prefixed commits in `contrib/` branches
- Do **not** push BV-internal config (secrets, ACR credentials, AKS manifests with cluster details) to any branch
