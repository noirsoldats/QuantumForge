#!/bin/bash

# Quantum Forge — Migration Parity Golden Manager
#
# Regenerate and promote the migration-parity golden schema snapshot after an
# intentional schema change (new numbered migration).
#
# Two steps, on purpose:
#   regenerate  — guard against a stale temp file, capture a fresh candidate
#                 golden into a temp file, then tell you how to verify it.
#   promote     — show the diff one more time, copy the verified candidate over
#                 the committed golden, and delete the temp file.
#
# Why two steps: the test only WRITES a golden when the target file is absent.
# A leftover stale temp file silently makes "regeneration" compare against old
# data — so we refuse to reuse an existing temp file and make promotion explicit.

set -e

# Resolve repo root (this script lives in <root>/bin).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GOLDEN="$ROOT/tests/integration/migration-parity.golden.json"
CANDIDATE="/tmp/qf-migration-golden.candidate.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info()    { echo -e "${BLUE}$1${NC}"; }
print_success() { echo -e "${GREEN}$1${NC}"; }
print_warn()    { echo -e "${YELLOW}$1${NC}"; }
print_error()   { echo -e "${RED}$1${NC}"; }

usage() {
    cat <<EOF
Quantum Forge — Migration Parity Golden Manager

Usage: bin/migration-golden.sh <command>

Commands:
  regenerate   Capture a fresh candidate golden into a temp file (fails if a
               temp file already exists) and print verification instructions.
  promote      Show the diff, copy the verified candidate over the committed
               golden, and remove the temp file.
  diff         Show the diff between the committed golden and the candidate.
  status       Show whether a candidate exists and how it compares.
  help         Show this help.

Typical flow after adding a numbered migration:
  1) bin/migration-golden.sh regenerate
  2) review the diff it prints (only your intended schema change should appear)
  3) bin/migration-golden.sh promote
EOF
}

require_candidate() {
    if [[ ! -f "$CANDIDATE" ]]; then
        print_error "No candidate golden found at:"
        echo "  $CANDIDATE"
        echo ""
        print_info "Run 'bin/migration-golden.sh regenerate' first."
        exit 1
    fi
}

show_diff() {
    # Prefer a structured JSON diff via python if available; fall back to diff.
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$GOLDEN" "$CANDIDATE" <<'PY'
import json, sys, difflib
a, b = sys.argv[1], sys.argv[2]
def load(p):
    try:
        return json.dumps(json.load(open(p)), indent=2, sort_keys=True).splitlines()
    except FileNotFoundError:
        return ["<missing>"]
al, bl = load(a), load(b)
diff = list(difflib.unified_diff(al, bl, fromfile="committed golden", tofile="candidate", lineterm=""))
if not diff:
    print("(no differences)")
else:
    print("\n".join(diff))
PY
    else
        diff -u "$GOLDEN" "$CANDIDATE" || true
    fi
}

cmd_regenerate() {
    print_info "== Regenerating migration-parity golden =="
    echo ""

    # Stale-file guard: the test only writes a golden when the target is ABSENT,
    # so a leftover candidate would silently compare against old data.
    if [[ -f "$CANDIDATE" ]]; then
        print_error "A candidate golden already exists at:"
        echo "  $CANDIDATE"
        echo ""
        print_warn "Refusing to reuse it (it may be stale). Remove it and re-run, or promote it:"
        echo "  rm '$CANDIDATE'   # discard"
        echo "  bin/migration-golden.sh promote   # if you already verified it"
        exit 1
    fi

    print_info "Running migration-parity tests with MIGRATION_GOLDEN_PATH → temp file..."
    echo "  (the test captures the current schema into the temp file, then asserts against it)"
    echo ""

    # With the target absent, the test writes it fresh then compares — so it passes.
    MIGRATION_GOLDEN_PATH="$CANDIDATE" npm test --silent -- migration-parity

    if [[ ! -f "$CANDIDATE" ]]; then
        print_error "Test run completed but no candidate golden was written."
        print_warn "Check the test output above for errors."
        exit 1
    fi

    echo ""
    print_success "Candidate golden captured:"
    echo "  $CANDIDATE"
    echo ""
    print_info "== Diff vs the committed golden =="
    show_diff
    echo ""
    print_warn "VERIFY the diff above shows ONLY your intended schema change."
    print_info "When it looks correct, promote it:"
    echo "  bin/migration-golden.sh promote"
}

cmd_promote() {
    require_candidate

    print_info "== Promoting candidate golden =="
    echo ""
    print_info "Diff being promoted (committed → candidate):"
    show_diff
    echo ""

    cp "$CANDIDATE" "$GOLDEN"
    rm -f "$CANDIDATE"

    print_success "Promoted candidate → $GOLDEN"
    print_success "Removed temp file."
    echo ""
    print_info "Now confirm the committed golden is green:"
    echo "  npm test -- migration-parity"
}

cmd_diff() {
    require_candidate
    show_diff
}

cmd_status() {
    print_info "Committed golden: $GOLDEN"
    [[ -f "$GOLDEN" ]] && print_success "  present" || print_error "  MISSING"
    echo ""
    print_info "Candidate golden: $CANDIDATE"
    if [[ -f "$CANDIDATE" ]]; then
        print_warn "  present (regenerate will refuse; run 'diff' or 'promote')"
        echo ""
        print_info "Diff (committed → candidate):"
        show_diff
    else
        print_success "  none (clean — 'regenerate' is safe to run)"
    fi
}

case "${1:-help}" in
    regenerate|regen) cmd_regenerate ;;
    promote)          cmd_promote ;;
    diff)             cmd_diff ;;
    status)           cmd_status ;;
    help|-h|--help)   usage ;;
    *)
        print_error "Unknown command: $1"
        echo ""
        usage
        exit 1
        ;;
esac
