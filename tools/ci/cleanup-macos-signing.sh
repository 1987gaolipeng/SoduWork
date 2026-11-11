#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${SODUWORK_MAC_KEYCHAIN:-}" ]]; then
  security delete-keychain "$SODUWORK_MAC_KEYCHAIN" >/dev/null 2>&1 || true
fi
rm -f "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/soduwork-signing-${GITHUB_RUN_ID:-$$}.p12"
rm -f "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/soduwork-notary-${GITHUB_RUN_ID:-$$}.p8"
