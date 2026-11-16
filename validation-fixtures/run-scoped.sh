#!/usr/bin/env bash
# Scoped test runner for the validation/org-packages-node fixture branch.
#
# Usage: bash validation-fixtures/run-scoped.sh <operand>...
#
# Accepts only the literal fixture operands listed below. There is no
# catch-all and no full-suite fallback: no operands, or any other operand,
# exits 2 before anything runs. Each accepted operand runs its own command;
# every command's exit status is printed, and the runner exits non-zero if
# any of them failed.
set -u

usage() {
  echo "run-scoped.sh: accepted operands: validation-fixtures/node/smoke.test.ts" >&2
}

if [ "$#" -eq 0 ]; then
  echo "run-scoped.sh: no operand given; refusing to run anything" >&2
  usage
  exit 2
fi

for operand in "$@"; do
  case "$operand" in
    validation-fixtures/node/smoke.test.ts) ;;
    *)
      echo "run-scoped.sh: unsupported operand: $operand" >&2
      usage
      exit 2
      ;;
  esac
done

failed=0
for operand in "$@"; do
  case "$operand" in
    validation-fixtures/node/smoke.test.ts)
      echo "run-scoped.sh: pnpm exec vitest run $operand"
      pnpm exec vitest run "$operand"
      status=$?
      ;;
  esac
  echo "run-scoped.sh: exit $status for $operand"
  if [ "$status" -ne 0 ]; then
    failed=1
  fi
done

exit "$failed"
