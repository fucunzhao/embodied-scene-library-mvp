#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/data}/media"
# Newly mounted persistent volumes can be root-owned. Only touch application paths.
chown node:node "${DATA_DIR:-/data}" "${DATA_DIR:-/data}/media"
for file in "${DATA_DIR:-/data}"/fieldbook.sqlite*; do
  if [ -f "$file" ]; then chown node:node "$file"; fi
done
exec su-exec node "$@"
