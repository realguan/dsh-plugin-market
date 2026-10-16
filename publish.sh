#!/usr/bin/env bash
# Regenerate the market index, publish it to the `dist` branch, and purge the jsDelivr cache.
#
# The artifact is a ~6 MB JSON that changes daily. Publishing it as a single-commit branch keeps
# repository history at exactly one snapshot instead of one copy per day, and jsDelivr serves any branch.
#
# Usage: ./publish.sh
# Environment: REPO (default realguan/dsh-plugin-market), BRANCH (default dist), INPUT, SKIP_CONVERT=1
set -euo pipefail

REPO=${REPO:-realguan/dsh-plugin-market}
BRANCH=${BRANCH:-dist}
INPUT=${INPUT:-https://awesome-dsh-plugin.com/plugins.json}
INDEX_URL="https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/dsh-index.json"

cd "$(dirname "$0")"

if [ "${SKIP_CONVERT:-0}" != "1" ]; then
  node convert.mjs --input "$INPUT" --output out/dsh-index.json --index-url "$INDEX_URL"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp out/dsh-index.json "$work/dsh-index.json"

cd "$work"
git init -q -b "$BRANCH"
git add dsh-index.json
git -c user.name="index-bot" -c user.email="index-bot@users.noreply.github.com" \
  commit -qm "publish $(date -u +%Y-%m-%dT%H:%M:%SZ) $(du -h dsh-index.json | cut -f1)"
git push -q --force "git@github.com:${REPO}.git" "$BRANCH"

printf 'published %s\n' "$INDEX_URL"

# A branch ref is cached at the edge for 12 hours (s-maxage=43200); purge makes a new index visible at once.
curl -sS "https://purge.jsdelivr.net/gh/${REPO}@${BRANCH}/dsh-index.json" || true
printf '\n'
