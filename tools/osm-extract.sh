#!/usr/bin/env bash
# Our own OpenStreetMap extract, instead of the public Overpass API (which
# asks commercial users to run their own): the Geofabrik regions that hold
# the ski areas (tools/osm-regions.mjs), each cut down with osmium to what
# SkiRouter uses, as one GeoJSON feature per line. tools/lib/osm-local.mjs
# reads it; tools/fetch-pois.mjs and tools/osm-enrich.mjs take it as --osm.
#
#   tools/osm-extract.sh OUT.geojsonseq [AREAS_DIR]
#
# Needs osmium-tool, curl and Node. One region is on disk at a time.

set -euo pipefail
OUT=${1:?usage: tools/osm-extract.sh OUT.geojsonseq [AREAS_DIR]}
AREAS=${2:-build/europe/areas}
UA='SkiRouter/1.0 (github.com/WillemvanOs/SkiRouter)'
FILTERS=(
  nwr/amenity=restaurant,cafe,fast_food,bar,pub,biergarten
  nwr/tourism=alpine_hut,viewpoint
  n/natural=peak
  n/place=town,village,hamlet
  nwr/piste:type=snow_park,downhill
  w/aerialway
  n/highway=bus_stop
)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -A "$UA" -o "$tmp/index-v1.json" https://download.geofabrik.de/index-v1.json
node tools/osm-regions.mjs --index "$tmp/index-v1.json" --areas "$AREAS" > "$tmp/regions.txt"

mkdir -p "$(dirname "$OUT")"
: > "$OUT.part"
while read -r url; do
  [ -n "$url" ] || continue
  echo "→ $url"
  curl -fsSL --retry 3 -A "$UA" -o "$tmp/region.osm.pbf" "$url"
  osmium tags-filter "$tmp/region.osm.pbf" "${FILTERS[@]}" -o "$tmp/kept.osm.pbf" --overwrite
  rm "$tmp/region.osm.pbf"
  osmium export "$tmp/kept.osm.pbf" -f geojsonseq -x print_record_separator=false \
    --add-unique-id=type_id -o "$tmp/kept.geojsonseq" --overwrite
  cat "$tmp/kept.geojsonseq" >> "$OUT.part"
  rm "$tmp/kept.osm.pbf" "$tmp/kept.geojsonseq"
done < "$tmp/regions.txt"
mv "$OUT.part" "$OUT"
date -u +%Y-%m-%d > "$OUT.date"
echo "$(wc -l < "$OUT") features in $OUT ($(du -h "$OUT" | cut -f1))"
