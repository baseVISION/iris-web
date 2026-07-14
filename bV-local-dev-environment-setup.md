# Dev Environment Setup (parallel to stable instance)

## Which compose file to use?

| File | Purpose |
|---|---|
| `docker-compose.yml` | **IRIS Official stable** — pulls pre-built images from ghcr.io (v2.4.27) |
| `docker-compose.bv.yml` | **baseVISION/iris-web development** — builds images locally from source, exposes extra ports (5432, 8000) |

**For contributing fixes: use `docker-compose.bv.yml`** — it builds from your local checkout so your
code changes are reflected in the running container.

---

## One-time setup

```bash
# 1. Clone the BV fork (bv-develop branch)
git clone --branch bv-develop git@github.com:baseVISION/iris-web.git ~/SourceCode/iris-web-bv
cd ~/SourceCode/iris-web-bv

# 2. Create the .env file from the template
cp .env.model .env
```

Edit `.env` — at minimum change these values to avoid port collisions with your stable instance (which uses 8443/5432):

```ini
INTERFACE_HTTPS_PORT=8444
# POSTGRES_PORT only matters if you need direct DB access from the host:
POSTGRES_PORT=5433
```

---

## Starting the dev stack

```bash
cd ~/SourceCode/iris-web-bv

# Build images and start — -p gives the stack a unique project name
# so volumes/networks stay separate from the stable pod_iris-web
podman compose -f docker-compose.bv.yml -p iris-bv up -d --build
```

Access the dev instance at: `https://localhost:8444`

---

## Day-to-day workflow

```bash
# Start
podman compose -f docker-compose.bv.yml -p iris-bv up -d

# Stop (data is preserved in iris-bv_db_data volume)
podman compose -f docker-compose.bv.yml -p iris-bv down

# Rebuild after code changes (Python backend or Dockerfile changes)
podman compose -f docker-compose.bv.yml -p iris-bv up -d --build

# Restart app after Python file changes (always restart nginx too — it caches the app's IP)
podman restart bv-iriswebapp-app bv-iriswebapp-nginx

# View logs
podman compose -f docker-compose.bv.yml -p iris-bv logs -f bv-iriswebapp-app
```

---

## Running the test suite

`tests/*.py` talk to the app container directly on `127.0.0.1:8000` (see `API_URL` in
`tests/iris.py`), so run the stack under its own project name (`iris-test`) and only start the
services the tests need — no nginx, no frontend. Never point this project name at a real dev
stack; treat its volumes as throwaway.

Don't run this alongside a real dev stack (`iris-bv`, `iris-web-bv`, ...) — they'd collide on the
same host ports (8000/5432).

```bash
# Build and start a disposable test stack (no nginx/worker needed to exercise the REST API)
podman compose -f docker-compose.dev.yml -p iris-test up -d --build db rabbitmq app worker

# Wait for the app container to become healthy, then run the suite from the host
# (test files are named tests_*.py, not pytest's default test_*.py pattern)
cd tests
python -m unittest discover -p 'tests_*.py' -v

# Tear down completely when done — safe to delete, this project only ever holds test fixtures
podman compose -f docker-compose.dev.yml -p iris-test down -v
```

---

## Working on UI (JavaScript/Svelte) changes

The `ui/dist` folder is bind-mounted into the container at `/iriswebapp/static`, so you can
iterate on UI changes without rebuilding the container image.

**First time only** — install Node dependencies on your host:
```bash
cd ui
npm install
```

**On every UI change:**
```bash
cd ui
npm run build
```
Then hard-refresh the browser (Ctrl+Shift+R). No container restart needed.

> **Note:** `npm install` is only needed on your host for local builds. The container image
> runs its own `npm ci` + `npm run build` during `docker build`, so a full `--build` always
> produces a self-contained image regardless of your local `node_modules`.

---

## Full cleanup

Remove containers, networks, and all data volumes (⚠ deletes all case data):

```bash
podman compose -f docker-compose.bv.yml -p iris-bv down -v
```

Remove only containers and networks, keep data volumes:

```bash
podman compose -f docker-compose.bv.yml -p iris-bv down
```

Remove leftover local images:

```bash
podman rmi bv-iriswebapp-app:develop bv-iriswebapp-db:develop bv-iriswebapp-nginx:develop
```