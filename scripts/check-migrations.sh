#!/usr/bin/env bash
# check-migrations.sh — applied-migration guard for CI.
#
# Every file already committed under supabase/migrations/ is a pulled baseline or an applied
# migration. Never modify or delete one — a schema change is a NEW file only. This script FAILS if a
# PR modifies, deletes or renames any supabase/migrations/ file that already exists on the base
# branch. Adding new files is fine.
#
# Usage:
#   scripts/check-migrations.sh [BASE_REF]
# BASE_REF defaults to origin/main. In GitHub Actions we pass the PR base (the merge base is computed
# here from it), so the diff is exactly "what this PR changes vs where it will merge".

set -euo pipefail

MIG_DIR="supabase/migrations"
BASE_REF="${1:-origin/main}"

# A missing base ref must not pass silently: with nothing to compare against, the guard proves nothing.
if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  echo "check-migrations: base ref '${BASE_REF}' not found; fetch it first (e.g. git fetch origin main)." >&2
  exit 1
fi

# Nothing to guard if the folder was never introduced on the base.
if ! git cat-file -e "${BASE_REF}:${MIG_DIR}" 2>/dev/null && [ ! -d "$MIG_DIR" ]; then
  echo "check-migrations: no ${MIG_DIR} on ${BASE_REF} or working tree — nothing to guard."
  exit 0
fi

# Merge base = the commit this branch forked from. Diffing against it (not the tip) avoids flagging
# migrations that landed on main *after* this branch started.
if MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null)"; then
  DIFF_BASE="$MERGE_BASE"
else
  # Shallow/unrelated history (e.g. a fresh CI checkout): fall back to the base ref directly.
  DIFF_BASE="$BASE_REF"
fi

echo "check-migrations: comparing $MIG_DIR against ${DIFF_BASE} ..."

# --diff-filter=MD → only files Modified (M) or Deleted (D) relative to the base. Renames (R) count
# too: a rename is a delete+add of a tracked migration, which is exactly what we forbid.
VIOLATIONS="$(git diff --name-status --diff-filter=MDR "$DIFF_BASE" -- "$MIG_DIR" || true)"

if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "❌ Applied migrations were modified, deleted, or renamed. This is not allowed."
  echo "   A schema change must be a NEW file in $MIG_DIR."
  echo ""
  echo "$VIOLATIONS" | while IFS=$'\t' read -r status path rest; do
    echo "   $status  $path${rest:+  -> $rest}"
  done
  exit 1
fi

# Report the additions (informational — these are allowed).
ADDED="$(git diff --name-status --diff-filter=A "$DIFF_BASE" -- "$MIG_DIR" || true)"
if [ -n "$ADDED" ]; then
  echo "✓ new migration file(s) added (allowed):"
  echo "$ADDED" | sed 's/^/   /'
else
  echo "✓ no changes under $MIG_DIR."
fi
echo "✓ no applied migration was modified or deleted."
exit 0
