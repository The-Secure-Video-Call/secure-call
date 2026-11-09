#!/bin/sh
# Copies the message contract (JSON Schema + valid/invalid example messages) from the
# backend's protocol/ folder into packages/protocol/contract/, pinned to one backend commit.
#
#   pnpm protocol:sync                 # latest commit on the backend's main branch
#   pnpm protocol:sync <commit-sha>    # a specific backend commit
#
# The backend's Pydantic models are the source of truth (PLAN.md section 6). Never edit the
# copied files by hand: change the backend, merge it, then run this again.
set -eu

BACKEND_REPOSITORY_URL="https://github.com/The-Secure-Video-Call/secure-call-backend"
CONTRACT_FOLDER="$(cd "$(dirname "$0")/.." && pwd)/contract"
BACKEND_COMMIT_SHA="${1:-$(git ls-remote "$BACKEND_REPOSITORY_URL.git" refs/heads/main | cut -f1)}"

DOWNLOAD_FOLDER="$(mktemp -d)"
trap 'rm -rf "$DOWNLOAD_FOLDER"' EXIT

curl -fsSL "$BACKEND_REPOSITORY_URL/archive/$BACKEND_COMMIT_SHA.tar.gz" | tar -xz -C "$DOWNLOAD_FOLDER"

rm -rf "$CONTRACT_FOLDER"
mkdir -p "$CONTRACT_FOLDER"
cp -R "$DOWNLOAD_FOLDER"/*/protocol/. "$CONTRACT_FOLDER"/
{
  echo "Copied by 'pnpm protocol:sync'. Do not edit these files by hand."
  echo "repository: $BACKEND_REPOSITORY_URL"
  echo "commit: $BACKEND_COMMIT_SHA"
} > "$CONTRACT_FOLDER/SOURCE"

echo "Synced the protocol contract from $BACKEND_REPOSITORY_URL at $BACKEND_COMMIT_SHA"
