# baseVISION — iris-web Fork Dev Concept

## Context

- Upstream: [dfir-iris/iris-web](https://github.com/dfir-iris/iris-web)
- Fork: [baseVISION/iris-web](https://github.com/baseVISION/iris-web)
- Upstream `develop` is **1,502 commits ahead** of `master` (unreleased, includes security patches)
- Upstream `master` is frozen — maintainer is working on a v2 rewrite with no ETA
- Production runs on AKS, built via Azure DevOps

---

## Branch Structure

```
upstream/master   ──────────────────────────────  (read-only reference, frozen)
upstream/develop  ──────────────────────────────  (read-only reference, active upstream)
        │
        │ initial base + periodic merges via PR
        ▼
    bv-main     ◄── production-stable, protected, tagged releases → AKS prod
        │
        │ PR from release/ branch only
        ▼
   bv-develop   ◄── integration branch → AKS staging (manual deploy trigger)
        │
   ┌────┴────────────────────┐
   ▼                         ▼
fix/<name>           feature/<name>     → PR to bv-develop (short-lived, delete after merge)
contrib/<name>                          → PR to upstream/develop (cherry-picks only, short-lived)
release/<version>                       → PR to bv-main (short-lived, delete after merge)
sync/upstream-<date>                    → PR to bv-develop (short-lived, delete after merge)
```

### Permanent Branches

| Branch | Purpose | Azure DevOps trigger |
|---|---|---|
| `bv-main` | Production-stable, tagged releases | Tag `v*-bv*` → deploy AKS prod (manual approval) |
| `bv-develop` | Integration, always deployable | Push → deploy AKS staging (manual trigger) |
| `origin/master` | Upstream master mirror — do not modify | None |
| `origin/develop` | Upstream develop mirror — do not modify | None |

### Short-lived Branches (delete after merge)

| Branch | Purpose |
|---|---|
| `fix/<name>` | Bug fix — PR to `bv-develop` |
| `feature/<name>` | New feature — PR to `bv-develop` |
| `release/<version>` | Release prep — PR to `bv-main` |
| `sync/upstream-<date>` | Upstream sync — PR to `bv-develop` |
| `contrib/<name>` | Upstream contribution — PR to upstream `develop` |

---

## Initial Migration (one-time)

```bash
# 1. Create bv-develop from upstream/develop (includes all 1502 unreleased fixes)
git checkout develop
git checkout -b bv-develop
git push origin bv-develop

# 2. Create bv-main from bv-develop (same starting point)
git checkout -b bv-main
git push origin bv-main

# 3. On GitHub:
#    - Set bv-main as default branch
#    - Enable branch protection on bv-main (require PR + 1 review + CI green, no direct push)
#    - Enable branch protection on bv-develop (require PR + CI green, no direct push)

# 4. Leave origin/master and origin/develop untouched as upstream mirrors
```

---

## Day-to-Day Workflows

### Working on a fix or feature

```bash
git checkout bv-develop && git pull origin bv-develop
git checkout -b fix/alert-permissions

# work and commit — see Commit Convention below

git push origin fix/alert-permissions
# Open PR → bv-develop on GitHub
# On Github approve → merge → delete branch
```

### Releasing to production

```bash
git checkout bv-develop && git pull
git checkout -b release/2.5.0-bv1

# Bump version in:
#   source/app/configuration.py  → IRIS_VERSION = "v2.5.0-bv1"
#   README.md
#   docker-compose.yml
git commit -m "[BV] Bump version to 2.5.0-bv1"
git push origin release/2.5.0-bv1

# Open PR: release/2.5.0-bv1 → bv-main
# Requires: 1 review + CI green
# After merge:
git checkout bv-main && git pull
git tag v2.5.0-bv1
git push origin v2.5.0-bv1
# Tag triggers Azure DevOps → build → push to ACR → deploy AKS prod (manual approval gate)
# Delete release/ branch
```

### Syncing upstream bugfixes

Recommended cadence: monthly, or immediately on upstream security fixes.

```bash
git fetch upstream
git checkout -b sync/upstream-2026-05 bv-develop
git merge upstream/develop        # resolve conflicts here
git push origin sync/upstream-2026-05
# Open PR → bv-develop (same process as any other PR)
# Delete branch after merge
```

### Contributing a fix back to upstream

Only cherry-pick commits **without** a `[BV]` prefix.

```bash
# Branch from upstream/develop — NOT from bv-develop
git checkout -b contrib/fix-alert-permissions upstream/develop
git cherry-pick <commit-hash>
git push origin contrib/fix-alert-permissions
# Open PR on github.com/dfir-iris/iris-web targeting their develop branch
# Delete branch after upstream merge
```

---

## Commit Message Convention

| Prefix | Meaning | Contribute upstream? |
|---|---|---|
| `[FIX]` | Generic bug fix | Yes — cherry-pick candidate |
| `[IMP]` | Generic improvement | Yes — cherry-pick candidate |
| `[ADD]` | Generic new feature | Case by case |
| `[BV]` | baseVISION-internal | Never |
| `[BV-FIX]` | Fix specific to BV infra/config | Never |

Rule: **if a commit has no `[BV]` prefix, it must be clean enough to open a PR on upstream without modification.**

---

## Azure DevOps Pipeline Structure

| Trigger | Jobs | Gate |
|---|---|---|
| PR to `bv-develop` | Build, static checks, unit tests | Auto — must pass before merge |
| Push to `bv-develop` | Build, push to ACR (`:develop` tag) | Auto |
| Deploy AKS staging | Deploy latest `:develop` image | Manual trigger |
| Tag `v*-bv*` | Build, push to ACR (`:version` + `:latest` tags), deploy AKS prod | Manual approval |

### Docker image naming in ACR

Rename from upstream defaults to avoid confusion:

| Upstream name | BV name in ACR |
|---|---|
| `iriswebapp_app` | `bv-iriswebapp-app` |
| `iriswebapp_db` | `bv-iriswebapp-db` |
| `iriswebapp_nginx` | `bv-iriswebapp-nginx` |

---

## GitHub Actions — Keep or Disable

The upstream `.github/workflows/` contains five workflows. Review before first push:

| Workflow | Action |
|---|---|
| `ci.yml` | **Keep** — runs static checks + API + DB migration + e2e tests on every PR. Useful as a free first gate. |
| `build-webApp.yml` | **Adapt or disable** — currently triggers on PRs to `main` and semver tags, pushes to `ghcr.io/dfir-iris/...`. In the fork it would push to `ghcr.io/basevision/...`. Since ACR + Azure DevOps is your publish path, disable this or adapt registry/image name. |
| `build-db.yml` | **Adapt or disable** — same reasoning as above. |
| `build-nginx.yml` | **Adapt or disable** — same reasoning as above. |
| `chart-releaser.yml` | **Adapt or disable** — triggers on push to `main` (not `bv-main`), so currently inactive. Adapt trigger if you use the Helm chart, otherwise disable. |

---

## Open Issues to Resolve

1. **Version numbering**: `.bumpversion.cfg` currently supports `2.5.0-beta.1` style. Decide BV version format (`2.5.0-bv.1` or `2.5.0-bv1`?) and update `.bumpversion.cfg` accordingly before the first release.

2. **GitHub Actions publish path**: Keep GHCR publishing in parallel with ACR, or disable GitHub Actions publish workflows and use only ACR via Azure DevOps? Decide before first tag.

3. **`origin/master` and `origin/develop` retention**: These currently mirror upstream exactly. Recommended: keep them as passive upstream mirrors, never push to them manually. Add a note in this document or a GitHub branch description.

4. **Upstream sync cadence and ownership**: Who opens the `sync/upstream-<date>` PR? Manual or scheduled (Azure DevOps scheduled pipeline that runs `git merge upstream/develop` and opens a PR automatically)?

5. **AKS manifests**: `deploy/kubernetes/` (Helm) and `deploy/eks_manifest/` both exist. Confirm which is used for your AKS cluster and clean up the other to reduce confusion.

6. **`.deepsource.toml`**: Upstream uses DeepSource for static analysis. Keep it (free for open source, runs on GitHub) or remove since Azure DevOps handles your gates?

7. **`CONTRIBUTING.md`**: Currently says "submit PRs to `develop`". Should be updated: internal contributors → `bv-develop`; upstream contributions → `contrib/` branch targeting upstream `develop`.
