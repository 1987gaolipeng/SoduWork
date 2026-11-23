#!/usr/bin/env bash
# Only the hash-pinned OLD baseline in disposable installation acceptance.
set -euo pipefail
test -f /.dockerenv
package=${1:?old RPM baseline}
legacy_digest=${2:--}
if [ "$legacy_digest" = - ]; then
  exec rpm -i "$package"
fi
[[ "$legacy_digest" =~ ^[a-f0-9]{64}$ ]]
actual=$(sha256sum -- "$package")
test "${actual%% *}" = "$legacy_digest"
# The committed baseline explicitly predates RPM signing. Digest verification
# above authorizes this one old artifact; candidates never use this helper.
exec rpm -i --nosignature "$package"
