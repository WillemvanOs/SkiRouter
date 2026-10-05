#!/usr/bin/env bash
# One-off probe: where does OpenSkiData publish its downloads, how big are
# they, and what does a KitzSki run / lift / ski area look like?
# Writes its findings to probe/ (committed back to the branch).
set -u
mkdir -p probe
UA='SkiRouter/1.0 (github.com/WillemvanOs/SkiRouter)'
{
  echo "== openskidata.org links"
  curl -sSL -A "$UA" https://openskidata.org/ | grep -oE 'href="[^"]+"' | sort -u
} > probe/links.txt 2>&1
cat probe/links.txt

{
  echo "== sizes"
  for u in $(grep -oE 'https?://[^"]+\.(geojson|json|csv|gpkg|zip|gz)[^"]*' probe/links.txt | sed 's/^href="//' | sort -u); do
    echo "$u $(curl -sSIL -A "$UA" "$u" | grep -i '^content-length' | tail -1)"
  done
} > probe/sizes.txt 2>&1
cat probe/sizes.txt
