# Live Questions: Quarto revealjs extension + Cloudflare / Docker backend

default:
    @just --list

# Install dependencies
install:
    bun install

# Build the deck plugin, the audience page bundle and the Node server
build:
    bun run build

# Type-check browser, Node and Worker code
typecheck:
    bun run typecheck

# Unit tests
test:
    bun test

# Run the Node server locally (PRESENTER_KEY defaults to "dev")
dev-node: build
    PRESENTER_KEY=${PRESENTER_KEY:-dev} DATA_DIR=./data PORT=8787 node dist/server.js

# Run the Worker locally with wrangler (key comes from .dev.vars)
dev-cf:
    bunx wrangler dev

# Protocol smoke test against a running server
smoke base="http://localhost:8787" key="dev":
    bun scripts/smoke.ts {{base}} {{key}}

# Deploy the Worker to Cloudflare, optionally on a custom domain
# (e.g. `just deploy live-questions.example.org`; the zone must be on your
# Cloudflare account). Kept out of wrangler.jsonc so forks don't inherit it.
deploy domain="":
    bunx wrangler deploy {{ if domain != "" { "--domain " + domain } else { "" } }}

# Build the Docker image
docker-build:
    docker build -t quarto-revealjs-live-questions .

# Run the Docker image (PRESENTER_KEY defaults to "dev")
docker-run:
    docker run --rm -p 8787:8787 -e PRESENTER_KEY=${PRESENTER_KEY:-dev} -v live-questions-data:/data quarto-revealjs-live-questions

# Render the example deck
render: build
    quarto render example.qmd

# Preview the example deck with live reload
preview: build
    quarto preview example.qmd
