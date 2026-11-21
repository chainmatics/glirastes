#!/bin/sh
# Installs a packed glirastes tarball and sherpa-onnx-node into a scratch
# consumer and copies the local STT smoke scripts next to it, so they import
# `glirastes/server/stt-local` through the package's `exports`, as an app would.
#
#   scripts/stt-local-consumer.sh <glirastes-*.tgz> <consumer dir> <sherpa-onnx-node version|latest> [npm install flags…]
#
# Extra flags go to `npm install`. Only the weekly `latest` job passes
# --legacy-peer-deps: glirastes pins the optional peer exactly, so npm refuses a
# newer sherpa-onnx-node next to it (ERESOLVE). The pinned jobs stay strict.
# Used by .github/workflows/stt-local-addon.yml and stt-local-smoke.yml, on the
# host (macOS) and inside node:22 containers.
set -eu
tarball=$1
consumer=$2
sherpa=$3
shift 3
here=$(cd "$(dirname "$0")" && pwd)
case "$tarball" in /*) ;; *) tarball="$(pwd)/$tarball" ;; esac

# Resolve a tag such as `latest` to the exact version, so the check below can compare.
requested=$(npm view "sherpa-onnx-node@$sherpa" version | tail -n 1)

mkdir -p "$consumer"
cd "$consumer"
[ -f package.json ] || npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund "$@" "$tarball" "sherpa-onnx-node@$requested"
cp "$here/stt-local-addon-smoke.mjs" "$here/stt-local-smoke.mjs" .

installed=$(node -p "require('./node_modules/sherpa-onnx-node/package.json').version")
if [ "$installed" != "$requested" ]; then
  echo "stt-local consumer: installed sherpa-onnx-node $installed != requested $requested" >&2
  exit 1
fi
node -p "['glirastes', 'sherpa-onnx-node'].map((name) => name + ' ' + require('./node_modules/' + name + '/package.json').version).join(', ')"
