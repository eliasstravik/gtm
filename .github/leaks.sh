#!/usr/bin/env bash
# One gitleaks scan with gitleaks' default rules (keys, tokens), then with ours (private-data.toml); stdin is read once
# and given to both. Usage: .github/leaks.sh git --log-opts=--all .   |   ... | .github/leaks.sh stdin
set -euo pipefail
gitleaks=${GITLEAKS:-gitleaks}
in=$(mktemp)
trap 'rm -f "$in"' EXIT
[ -t 0 ] || cat > "$in"
"$gitleaks" "$@" --redact --no-banner < "$in"
"$gitleaks" "$@" --config "$(dirname "$0")/private-data.toml" --redact --no-banner < "$in"
