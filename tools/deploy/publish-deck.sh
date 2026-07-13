#!/usr/bin/env bash
# Publishes a slidey deck to kitsoki-test.slothattax.me as a self-contained
# single-file build, stamped with a pre-chosen git tag as its deck version
# (never a SHA derived from the build's own output — see
# .context/feedback-e2e-plan.md, architecture decision 7).
#
# Usage: tools/deploy/publish-deck.sh <spec.slidey.json> [--slug <slug>]
#
# Refuses to run on a dirty working tree: a deck version that doesn't map to
# a real, pushed commit defeats the point of pull-feedback.sh's
# `git show <tag>:<spec>` reproducibility guarantee.
set -euo pipefail

REMOTE="${SLIDEY_FEEDBACK_VM_REMOTE:-root@kitsoki-test.slothattax.me}"
DECKS_DIR="${SLIDEY_FEEDBACK_VM_DECKS_DIR:-/srv/slidey-decks}"
SITE="${SLIDEY_FEEDBACK_SITE:-https://kitsoki-test.slothattax.me}"
FEEDBACK_ENDPOINT="${SLIDEY_FEEDBACK_ENDPOINT:-/api/feedback}"
FEEDBACK_ENVIRONMENT="${SLIDEY_FEEDBACK_ENVIRONMENT:-public}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

spec=""
slug=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) slug="$2"; shift 2 ;;
    -*) echo "publish-deck: unknown flag $1" >&2; exit 1 ;;
    *) spec="$1"; shift ;;
  esac
done
if [ -z "$spec" ]; then
  echo "Usage: tools/deploy/publish-deck.sh <spec.slidey.json> [--slug <slug>]" >&2
  exit 1
fi
if [ ! -f "$spec" ]; then
  echo "publish-deck: spec not found: $spec" >&2
  exit 1
fi
if [ -z "$slug" ]; then
  slug="$(basename "$spec" | sed -E 's/\.slidey\.json$//; s/\.json$//')"
fi
if ! [[ "$slug" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "publish-deck: slug '$slug' must be lowercase alphanumeric with hyphens (URL path-safe)" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "publish-deck: working tree is dirty — commit or stash before publishing" >&2
  echo "  (a deck version must point at a real commit; see architecture decision 7 in feedback-e2e-plan.md)" >&2
  git status --short >&2
  exit 1
fi

# Next sequential version for this slug: deck/<slug>/v<n>.
last_n=0
while IFS= read -r existing_tag; do
  [ -z "$existing_tag" ] && continue
  n="${existing_tag##*/v}"
  if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt "$last_n" ]; then last_n="$n"; fi
done < <(git tag -l "deck/$slug/v*")
next_n=$((last_n + 1))
tag="deck/$slug/v$next_n"

echo "publish-deck: tagging HEAD as $tag"
git tag -a "$tag" -m "Publish deck '$slug' ($spec)"
git push origin "$tag"

outfile="$(mktemp -t slidey-publish-XXXXXX).html"
echo "publish-deck: building single-file bundle…"
node web/build-single.mjs "$spec" "$outfile"

echo "publish-deck: stamping deck version + feedback sinks"
DECK_VERSION_TAG="$tag" FEEDBACK_ENDPOINT_URL="$FEEDBACK_ENDPOINT" FEEDBACK_ENVIRONMENT_NAME="$FEEDBACK_ENVIRONMENT" PROJECT_ROOT="$ROOT" node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const outfile = process.argv[1];
const tag = process.env.DECK_VERSION_TAG;
const endpoint = process.env.FEEDBACK_ENDPOINT_URL;
const environment = process.env.FEEDBACK_ENVIRONMENT_NAME;
let sinks = [{ id: 'default', label: 'Send feedback', endpoint }];
try {
  const config = JSON.parse(readFileSync(join(process.env.PROJECT_ROOT, '.slidey', 'feedback.json'), 'utf8'));
  const ids = config?.publishing?.environments?.[environment]?.sinks;
  if (Array.isArray(ids) && ids.length) sinks = ids.map((id) => ({ id, ...config.sinks?.[id] })).filter((sink) => sink.type === 'http' && typeof sink.endpoint === 'string');
} catch (err) { console.warn('publish-deck: no project feedback config:', err.message); }
if (!sinks.length) throw new Error('publish-deck: selected feedback environment has no HTTP sinks');
let html = readFileSync(outfile, 'utf8');
const inject = \`<script>window.__SLIDEY_DECK_VERSION__ = \${JSON.stringify(tag)}; window.__SLIDEY_FEEDBACK__ = { environment: \${JSON.stringify(environment)}, sinks: \${JSON.stringify(sinks)} };</script>\n\`;
const patched = html.replace(/(<script type=\"module\">)/, \`\${inject}\$1\`);
if (patched === html) throw new Error('publish-deck: could not find injection point in built HTML');
writeFileSync(outfile, patched);
" "$outfile"

echo "publish-deck: publishing to $REMOTE:$DECKS_DIR/$slug/"
ssh "$REMOTE" "mkdir -p '$DECKS_DIR/$slug'"
rsync -az "$outfile" "$REMOTE:$DECKS_DIR/$slug/index.html"
rm -f "$outfile"

echo
echo "Published: $SITE/constructor-studio/decks/$slug/"
echo "Deck version: $tag"
