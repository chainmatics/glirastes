#!/bin/sh
# Installs a packed glirastes tarball and sherpa-onnx-node into a scratch
# consumer and copies the local STT smoke scripts next to it, so they import
# `glirastes/server/stt-local` through the package's `exports`, as an app would.
#
#   scripts/stt-local-consumer.sh <glirastes-*.tgz> <consumer dir> <sherpa-onnx-node version>
#
# Used by .github/workflows/stt-local-addon.yml and stt-local-smoke.yml, on the
# host (macOS) and inside node:22 containers.
set -eu
tarball=$1
consumer=$2
sherpa=$3
here=$(cd "$(dirname "$0")" && pwd)
case "$tarball" in /*) ;; *) tarball="$(pwd)/$tarball" ;; esac

mkdir -p "$consumer"
cd "$consumer"
[ -f package.json ] || npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund "$tarball" "sherpa-onnx-node@$sherpa"
cp "$here/stt-local-addon-smoke.mjs" "$here/stt-local-smoke.mjs" .
node -p "['glirastes', 'sherpa-onnx-node'].map((name) => name + ' ' + require('./node_modules/' + name + '/package.json').version).join(', ')"
