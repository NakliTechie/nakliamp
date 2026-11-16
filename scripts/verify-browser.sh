#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
verify_host=${NAKLIAMP_VERIFY_HOST:-127.0.0.1}
verify_port=${NAKLIAMP_VERIFY_PORT:-8878}
python_bin=${PYTHON:-python3}
browser_bin=${NAKLIAMP_BROWSER:-}
verify_repeats=${NAKLIAMP_VERIFY_REPEATS:-2}

case "$verify_repeats" in
  ''|*[!0-9]*|0) echo "NAKLIAMP_VERIFY_REPEATS must be a positive integer." >&2; exit 2 ;;
esac

if [ -z "$browser_bin" ]; then
  if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    browser_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif command -v google-chrome >/dev/null 2>&1; then
    browser_bin=$(command -v google-chrome)
  elif command -v chromium >/dev/null 2>&1; then
    browser_bin=$(command -v chromium)
  else
    echo "No supported Chromium browser found. Set NAKLIAMP_BROWSER to its executable." >&2
    exit 2
  fi
fi

profile_root=$(mktemp -d "${TMPDIR:-/tmp}/nakliamp-browser-verify.XXXXXX")
server_pid=

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  case "$profile_root" in
    */nakliamp-browser-verify.*) rm -rf -- "$profile_root" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

cd "$repo_root"
node "$repo_root/scripts/verify-source-hygiene.mjs"
node "$repo_root/scripts/verify-vendor.mjs"
node "$repo_root/scripts/verify-fixtures.mjs"
node "$repo_root/scripts/verify-boundary.mjs"
node "$repo_root/scripts/verify-r2-sessions.mjs"
node "$repo_root/scripts/verify-delivery.mjs"
node "$repo_root/scripts/build-single-file.mjs"
node "$repo_root/scripts/build-single-file.mjs" --full
node "$repo_root/scripts/verify-single-file.mjs"
node "$repo_root/scripts/verify-single-file.mjs" --full
node --test "$repo_root"/test/*.test.mjs
"$python_bin" -m http.server "$verify_port" --bind "$verify_host" >"$profile_root/server.log" 2>&1 &
server_pid=$!

attempt=0
until curl --fail --silent --output /dev/null "http://$verify_host:$verify_port/index.html"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo "NakliAmp verification server did not become available." >&2
    cat "$profile_root/server.log" >&2
    exit 1
  fi
  sleep 0.1
done

diagnostic_log="$profile_root/runner-diagnostics.log"
if node "$repo_root/scripts/run-browser-harness.mjs" \
  "$browser_bin" \
  "http://$verify_host:$verify_port/test/runner-failure.html?runner=cli" \
  "$profile_root/chrome-runner-diagnostics" >"$diagnostic_log" 2>&1; then
  echo "Runner diagnostic fixture did not fail as required." >&2
  exit 1
fi
for diagnostic_marker in L7_DECLARED_FAILURE L7_CONSOLE_SENTINEL l7-network-sentinel.bin l7-remote-sentinel.example.com; do
  if ! grep -F "$diagnostic_marker" "$diagnostic_log" >/dev/null; then
    echo "Runner diagnostics omitted $diagnostic_marker." >&2
    cat "$diagnostic_log" >&2
    exit 1
  fi
done

for harness in golden-audio ui-smoke library library-e2e universal analyser wasm-decode single-file v1-features v1x-features; do
  profile_path="$profile_root/chrome-$harness"
  verify_run=1
  while [ "$verify_run" -le "$verify_repeats" ]; do
    if ! node "$repo_root/scripts/run-browser-harness.mjs" \
      "$browser_bin" \
      "http://$verify_host:$verify_port/test/$harness.html?runner=cli&run=$verify_run" \
      "$profile_path"; then
      echo "$harness run $verify_run/$verify_repeats: fail" >&2
      exit 1
    fi
    verify_run=$((verify_run + 1))
  done
done
