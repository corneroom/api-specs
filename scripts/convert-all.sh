#!/bin/bash
# DEPRECATED: This script is no longer used. Please use scripts/convert-all.js instead.
# Retained for reference and rollback only.
set -e

# Ensure js-yaml is installed (required by api-spec-converter for YAML support)
npm install js-yaml

for f in gateway/*.yaml; do
  if grep -q 'openapi: 3.0' "$f"; then
    base=$(basename "$f" .yaml)
    npx api-spec-converter -f openapi_3 -t swagger_2 -s yaml "$f" > "gateway/${base}-swagger.yaml"
    npx swagger-cli validate "gateway/${base}-swagger.yaml"
  else
    echo "Skipping $f (not OpenAPI 3.0)"
  fi
done
