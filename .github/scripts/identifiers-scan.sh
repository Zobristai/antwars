#!/usr/bin/env bash
# The gitleaks workflow's `identifiers` scan (.github/workflows/gitleaks.yml).
# Usage: identifiers-scan.sh <workdir> <candidate> [<range-start>]
#   Scans the candidate commit's tree and every commit in <range-start>..<candidate> (all
#   history reachable from <candidate> when no start is given), twice each: once with the
#   private identifier rules and once with gitleaks' default rules. Each scan's findings go to
#   <workdir>/reports/<scan>.json, and each scan that ran is named in <workdir>/reports/ran.txt.
#   The identifier list comes from the ANTWARS_IDENTIFIERS environment variable (one literal
#   identifier per line, LF, with or without a final LF; blank lines skipped; CONTRIBUTING.md).
#   A missing or empty secret, or one with no identifiers, fails the scan.
#
# Everything this script runs or loads comes from the checkout it lives in, the trusted base:
# this script, .githooks/identifier-config and .gitleaks-defaults.toml (the workflow and the
# gitleaks install are the base's too). The candidate is data only: it is read as git objects
# (rev-list, ls-tree, cat-file, log) and its files are never checked out, executed, sourced,
# installed or loaded as config. When the candidate changes one of those trusted files, a
# notice names the file; the scan still uses the base's copy.
#
# No identifier value is printed or written anywhere but the private config and gitleaks' own
# reports in <workdir>, which are deleted when the script ends, however it ends. gitleaks
# redacts only the matched text, so its reports still carry file paths and commit authors,
# emails and messages, any of which could hold an identifier. Each finding is therefore kept
# only as its rule, commit SHA, line and the sha256 of its path (CONTRIBUTING.md says how to
# find the file); nothing else from a finding is printed or kept.
set -euo pipefail
umask 077

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <workdir> <candidate> [<range-start>]" >&2
  exit 2
fi
work=$1
candidate_ref=$2
start=${3:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
git() { command git -C "$root" "$@"; }

if [ -z "${ANTWARS_IDENTIFIERS:-}" ]; then
  echo "::error title=identifiers::The ANTWARS_IDENTIFIERS secret is missing or empty, so the private identifier scan cannot run." >&2
  exit 1
fi

if ! candidate=$(git rev-parse -q --verify "$candidate_ref^{commit}"); then
  echo "::error title=identifiers::The candidate commit $candidate_ref is not in this clone." >&2
  exit 1
fi
range=$candidate
if [ -n "$start" ]; then
  if ! start=$(git rev-parse -q --verify "$start^{commit}"); then
    echo "::error title=identifiers::The range start $3 is not in this clone." >&2
    exit 1
  fi
  range="$start..$candidate"
fi
count=$(git rev-list --count "$range")

mkdir -p "$work"
work=$(cd "$work" && pwd)
# The generated identifier config is deleted however this script ends: success, failure or a
# signal.
trap 'rm -rf "$work/identifiers.toml" "$work/raw"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
rm -rf "$work/identifiers.toml" "$work/raw" "$work/reports" "$work/tree.list" "$work/candidate" "$work/gitleaksignore" "$work/objects.git" "$work/noignore"
mkdir -p "$work/raw" "$work/reports" "$work/candidate" "$work/gitleaksignore" "$work/noignore"
: > "$work/reports/ran.txt"

# The identifier config, built from the secret by the base's generator. It is never printed.
if ! printf '%s' "$ANTWARS_IDENTIFIERS" | sh "$root/.githooks/identifier-config" > "$work/identifiers.toml"; then
  echo "::error title=identifiers::The ANTWARS_IDENTIFIERS secret is not a valid identifier list (CONTRIBUTING.md)." >&2
  exit 1
fi
unset ANTWARS_IDENTIFIERS
cp "$root/.gitleaks-defaults.toml" "$work/defaults.toml"

# Trusted files the candidate cannot change for this scan, compared with where it branched
# from the base checkout.
fork=$(git merge-base HEAD "$candidate" || git rev-parse HEAD)
for f in .github/scripts/identifiers-scan.sh .githooks/identifier-config .githooks/pre-commit \
  .gitleaks-defaults.toml .github/workflows/gitleaks.yml; do
  if [ "$(git rev-parse -q --verify "$fork:$f" || true)" != "$(git rev-parse -q --verify "$candidate:$f" || true)" ]; then
    echo "::notice title=identifiers::This change modifies $f. The scan uses the base branch's copy; the change takes effect only once it is on main."
  fi
done
# The candidate's .gitleaks-defaults.toml must still match its own pin in .githooks/pre-commit.
pin_status=0
pin=$(git cat-file blob "$candidate:.githooks/pre-commit" 2>/dev/null | sed -n 's/^defaults_baseline=\([0-9a-f]\{40\}\)$/\1/p' || true)
if [ "$(printf '%s\n' "$pin" | grep -c .)" != 1 ] || [ "$(git rev-parse -q --verify "$candidate:.gitleaks-defaults.toml" || true)" != "$pin" ]; then
  echo "::error title=identifiers::This change's .gitleaks-defaults.toml does not match the defaults_baseline line in its .githooks/pre-commit. A change to the config must update that line in the same reviewed change." >&2
  pin_status=1
fi

# The candidate tree, written from git objects as plain data: no filters, no symlinks
# (a symlink is written as its target text), submodules skipped, unsafe paths refused.
git ls-tree -r -z --full-tree "$candidate" > "$work/tree.list"
while IFS= read -r -d '' entry; do
  meta=${entry%%$'\t'*}
  path=${entry#*$'\t'}
  read -r _ type sha <<< "$meta"
  [ "$type" = blob ] || continue
  case "/$path/" in
    //*|*/../*|*/./*|*//*)
      echo "::error title=identifiers::The candidate tree has an unsafe path; refusing to scan it." >&2
      exit 1 ;;
  esac
  mkdir -p "$work/candidate/$(dirname "$path")"
  git cat-file blob "$sha" > "$work/candidate/$path"
done < "$work/tree.list"
# gitleaks applies a .gitleaksignore at the scan root; move it out and scan it as a file.
if [ -e "$work/candidate/.gitleaksignore" ]; then
  mv "$work/candidate/.gitleaksignore" "$work/gitleaksignore/"
fi
# The commit scan reads a bare object view of this clone: gitleaks would otherwise apply the
# checkout's own .gitleaksignore.
command git init -q --bare "$work/objects.git"
echo "$(git rev-parse --path-format=absolute --git-common-dir)/objects" > "$work/objects.git/objects/info/alternates"

# Moves one raw gitleaks report to reports/, keeping only each finding's rule, commit SHA, line
# and path sha256. A missing raw report stays missing; an unreadable one becomes "unreadable".
redact() {
  python3 - "$work/raw/$1.json" "$work/reports/$1.json" <<'PY'
import hashlib, json, re, sys
raw, out = sys.argv[1], sys.argv[2]
try:
    with open(raw, encoding="utf-8") as f:
        items = json.load(f)
except FileNotFoundError:
    sys.exit(0)
except (OSError, ValueError):
    items = None
if isinstance(items, list):
    kept = []
    for item in items:
        item = item if isinstance(item, dict) else {}
        rule, commit, line, path = item.get("RuleID"), item.get("Commit"), item.get("StartLine"), item.get("File")
        if isinstance(path, str) and path:
            path = path[2:] if path.startswith("./") else path
            path = hashlib.sha256(path.encode("utf-8", "surrogatepass")).hexdigest()
        else:
            path = "path redacted"
        kept.append({
            "RuleID": rule if isinstance(rule, str) and re.fullmatch(r"[A-Za-z0-9._-]+", rule) else "rule redacted",
            "Commit": commit if isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit) else "",
            "StartLine": line if isinstance(line, int) and not isinstance(line, bool) else 0,
            "PathSHA256": path,
        })
else:
    kept = "unreadable"
with open(out, "w", encoding="utf-8") as f:
    json.dump(kept, f, indent=1)
PY
  rm -f "$work/raw/$1.json"
}

echo "identifiers: scanning the tree of $candidate and git log $range ($count commits)"
status=$pin_status
cd "$work/noignore"
for set in "identifiers:" "defaults:-defaults"; do
  config="$work/${set%%:*}.toml"
  suffix=${set#*:}
  gl=(--no-banner --redact --ignore-gitleaks-allow --gitleaks-ignore-path "$work/noignore" --config "$config" --report-format json)
  echo "tree$suffix" >> "$work/reports/ran.txt"
  (cd "$work/candidate" && gitleaks dir . "${gl[@]}" --report-path "$work/raw/tree$suffix.json") || status=1
  redact "tree$suffix"
  if [ -e "$work/gitleaksignore/.gitleaksignore" ]; then
    echo "ignore$suffix" >> "$work/reports/ran.txt"
    (cd "$work/gitleaksignore" && gitleaks dir .gitleaksignore "${gl[@]}" --report-path "$work/raw/ignore$suffix.json") || status=1
    redact "ignore$suffix"
  fi
  echo "commits$suffix" >> "$work/reports/ran.txt"
  gitleaks git "$work/objects.git" "${gl[@]}" --report-path "$work/raw/commits$suffix.json" \
    --log-opts="$range --text --diff-merges=first-parent" || status=1
  redact "commits$suffix"
done
exit $status
