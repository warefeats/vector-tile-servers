set dotenv-load

check:
    bun run check

test:
    bun test

# Full benchmark: every engine, full protocol. Brings the database up and loads the corpus if needed.
bench *ARGS:
    bun run src/run.ts {{ARGS}}

# Short protocol, every engine.
smoke *ARGS:
    bun run src/run.ts --smoke {{ARGS}}

# Build the BBOX image from the pinned source tag (the published image is amd64-only).
build-bbox:
    docker build -f Dockerfile.bbox -t vts-bbox:0.6.2 .

db-up:
    docker compose -f compose/docker-compose.db.yml -p vts-db up -d db --wait --wait-timeout 120

db-load:
    bun run src/db.ts

db-psql *ARGS:
    docker compose -f compose/docker-compose.db.yml -p vts-db exec db psql -U postgres -d bench {{ARGS}}

db-down:
    docker compose -f compose/docker-compose.db.yml -p vts-db down -v --remove-orphans

# Stop every engine container (and the database) this runner may have left behind.
clean:
    #!/usr/bin/env bash
    set -euo pipefail
    for engine in martin tegola bbox pg-tileserv tipg ldproxy ldproxy-pgis; do
        docker compose -f "compose/docker-compose.${engine}.yml" -p "vts-${engine}" down --remove-orphans 2>/dev/null || true
    done
    docker compose -f compose/docker-compose.db.yml -p vts-db down --remove-orphans 2>/dev/null || true
    echo "cleaned up all vector-tile-servers containers (database volume kept; use db-down to drop it)"

import RESULTS="results.json":
    bun run src/import.ts --results={{RESULTS}}
