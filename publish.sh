#!/usr/bin/env bash
# Regenerate the market index, publish it to the `dist` branch, and purge the jsDelivr cache.
#
# The artifact is a ~6 MB JSON that changes daily. Publishing it as a single-commit branch keeps
# repository history at exactly one snapshot instead of one copy per day, and jsDelivr serves any branch.
#
# jsDelivr caches a branch reference for 12 hours (s-maxage=43200), and its branch-to-commit resolution
# does not follow a purge. Measured 2026-10-16: with the branch stale, `@<commit-sha>` and
# raw.githubusercontent.com served the current file immediately, and repeated purges kept returning the
# two previous publishes instead. The purge below is still worth issuing because it clears the file
# caches, but a fresh publish can take up to 12 hours to reach every edge; the poll below only reports
# where the CDN stands. The next publish supersedes it.
#
# Usage: ./publish.sh
# Environment: REPO (default realguan/dsh-plugin-market), BRANCH (default dist), INPUT, SKIP_CONVERT=1
set -euo pipefail

REPO=${REPO:-realguan/dsh-plugin-market}
BRANCH=${BRANCH:-dist}
INPUT=${INPUT:-https://awesome-dsh-plugin.com/plugins.json}
INDEX_URL="https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/dsh-index.json"

cd "$(dirname "$0")"
project_dir=$(pwd)

if [ "${SKIP_CONVERT:-0}" != "1" ]; then
  node convert.mjs --input "$INPUT" --output out/dsh-index.json --index-url "$INDEX_URL"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp out/dsh-index.json "$work/dsh-index.json"
# GitHub Pages serves this branch too; without .nojekyll it would run Jekyll over the artifact.
touch "$work/.nojekyll"

cd "$work"
git init -q -b "$BRANCH"
git add dsh-index.json .nojekyll
git -c user.name="index-bot" -c user.email="index-bot@users.noreply.github.com" \
  commit -qm "publish $(date -u +%Y-%m-%dT%H:%M:%SZ) $(du -h dsh-index.json | cut -f1)"
git push -q --force "git@github.com:${REPO}.git" "$BRANCH"

printf 'published %s\n' "$INDEX_URL"

# Let the push reach the edges jsDelivr fetches from before purging, or it re-fills from the old commit.
sleep 15
curl -sS "https://purge.jsdelivr.net/gh/${REPO}@${BRANCH}/dsh-index.json" > /dev/null || true

local_hash=$(shasum -a 256 "$project_dir/out/dsh-index.json" | cut -d' ' -f1)
for _attempt in 1 2 3 4; do
  sleep 15
  served=$(curl -sS -m 60 "$INDEX_URL" | shasum -a 256 | cut -d' ' -f1 || true)
  if [ "$served" = "$local_hash" ]; then
    printf 'jsDelivr is serving the new index\n'
    exit 0
  fi
done

printf 'jsDelivr still serves an earlier revision; its branch cache can take up to 12 hours to expire.\n'
printf 'The branch itself already holds the new index: https://raw.githubusercontent.com/%s/%s/dsh-index.json\n' "$REPO" "$BRANCH"
