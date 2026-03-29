#!/usr/bin/env bash
# Plugin test launcher — always targets ~/.config/opencode-agenthub
# Usage: ./scripts/run-test.sh [profile] [workspace]
#   profile  : auto (default)
#   workspace: path to workspace (default: current repo root)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROFILE="${1:-auto}"
WORKSPACE="${2:-$REPO_ROOT}"

# Explicitly pin test env to ~/.config/opencode-agenthub — never use vault
export OPENCODE_AGENTHUB_HOME="$HOME/.config/opencode-agenthub"

exec bun "$REPO_ROOT/src/composer/opencode-profile.ts" run "$PROFILE" --workspace "$WORKSPACE"
