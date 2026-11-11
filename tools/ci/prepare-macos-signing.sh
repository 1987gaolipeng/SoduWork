#!/usr/bin/env bash
set -euo pipefail

: "${SODUWORK_MAC_CERTIFICATE_B64:?SODUWORK_MAC_CERTIFICATE_B64 is required}"
: "${SODUWORK_MAC_CERTIFICATE_PASSWORD:?SODUWORK_MAC_CERTIFICATE_PASSWORD is required}"
: "${SODUWORK_MAC_KEYCHAIN_PASSWORD:?SODUWORK_MAC_KEYCHAIN_PASSWORD is required}"
: "${SODUWORK_MAC_SIGN_IDENTITY:?SODUWORK_MAC_SIGN_IDENTITY is required}"
: "${SODUWORK_MAC_NOTARY_KEY_ID:?SODUWORK_MAC_NOTARY_KEY_ID is required}"
: "${SODUWORK_MAC_NOTARY_ISSUER:?SODUWORK_MAC_NOTARY_ISSUER is required}"
: "${SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64:?SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64 is required}"

profile="${SODUWORK_MAC_NOTARY_PROFILE:-SODUWORK_NOTARY}"
keychain="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/soduwork-signing-${GITHUB_RUN_ID:-$$}.keychain-db"
certificate="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/soduwork-signing-${GITHUB_RUN_ID:-$$}.p12"
notary_key="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/soduwork-notary-${GITHUB_RUN_ID:-$$}.p8"

cleanup_partial() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -f "$certificate" "$notary_key"
}
trap cleanup_partial ERR

printf '%s' "$SODUWORK_MAC_CERTIFICATE_B64" | base64 --decode > "$certificate"
printf '%s' "$SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64" | base64 --decode > "$notary_key"
security create-keychain -p "$SODUWORK_MAC_KEYCHAIN_PASSWORD" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$SODUWORK_MAC_KEYCHAIN_PASSWORD" "$keychain"
security import "$certificate" -k "$keychain" -P "$SODUWORK_MAC_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple: -s \
  -k "$SODUWORK_MAC_KEYCHAIN_PASSWORD" "$keychain"
security list-keychains -d user -s "$keychain"
xcrun notarytool store-credentials "$profile" --key "$notary_key" \
  --key-id "$SODUWORK_MAC_NOTARY_KEY_ID" --issuer "$SODUWORK_MAC_NOTARY_ISSUER" \
  --keychain "$keychain" --validate

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    printf 'SODUWORK_MAC_KEYCHAIN=%s\n' "$keychain"
    printf 'SODUWORK_MAC_NOTARY_KEYCHAIN=%s\n' "$keychain"
    printf 'SODUWORK_MAC_NOTARY_PROFILE=%s\n' "$profile"
  } >> "$GITHUB_ENV"
fi
trap - ERR
