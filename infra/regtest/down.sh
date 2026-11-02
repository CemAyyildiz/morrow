#!/usr/bin/env bash
# Stops regtest and deletes its chain, so the next run starts from block 0.
set -euo pipefail

cd "$(dirname "$0")"
docker compose down --volumes --remove-orphans
