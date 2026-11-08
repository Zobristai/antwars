#!/usr/bin/env bash
# History isolation: refuses history that has any root commit other than this repository's
# initial commit, and any commit whose author name, author email, committer name, committer
# email or message contains one of the private identifiers. The identifiers are never in the repository:
# they come from the ANTWARS_IDENTIFIERS environment variable (the Actions secret of that name),
# one literal identifier per line, matched case-insensitively as a fixed substring of each whole
# field. Neither identifiers nor matching values are ever printed.
#
# The initial commit is never in the repository either (a commit cannot carry its own id): it
# comes from the ANTWARS_EXPECTED_ROOT environment variable, the full 40-character lower-case SHA.
# In CI that is the repository Actions variable of the same name; a local run sets the
# environment variable of the same name. Unset, empty or not exactly such a SHA fails.
#
# Usage:
#   history-isolation.sh <commit>...
#       checks the history reachable from each commit (push to main).
#   history-isolation.sh --pull-request <number> <head-sha>
#       lists refs/pull/<number>/head and refs/pull/<number>/merge on origin with
#       ls-remote --exit-code, fetches the listed refs as git objects only (into refs/candidate/*),
#       requires the head to be <head-sha> and each fetched ref to equal its listing, then checks
#       both. The merge ref is treated as absent only when its ls-remote exits 2 (GitHub creates
#       none for a conflicting pull request); then the head alone is checked. Any other ls-remote
#       exit and any fetch error fails. Nothing from the pull request is checked out or run.
#       FETCH_TOKEN, when set, authenticates the fetch; it is passed to git through the
#       environment, never on a command line or in the repository configuration.
set -euo pipefail
export LC_ALL=C.UTF-8 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0
err() { echo "::error title=history-isolation::$1"; }
die() { err "$1"; exit 1; }

# Expected root: required, exactly one full lower-case SHA, nothing trimmed or defaulted.
if [ -z "${ANTWARS_EXPECTED_ROOT+set}" ]; then die "the ANTWARS_EXPECTED_ROOT variable is not set"; fi
if [ -z "$ANTWARS_EXPECTED_ROOT" ]; then die "the ANTWARS_EXPECTED_ROOT variable is empty"; fi
[[ "$ANTWARS_EXPECTED_ROOT" =~ ^[0-9a-f]{40}$ ]] ||
  die "the ANTWARS_EXPECTED_ROOT variable is not a full 40-character lower-case commit SHA"
root=$ANTWARS_EXPECTED_ROOT
status=0 merge_absent=''
fail() { err "$1"; status=1; }

# Identifiers: required, read once into a private file, then dropped from the environment.
# Every line is read, including a last line with no LF. Blank lines (empty or whitespace only)
# are skipped; every other line is kept exactly as written, lower-cased. No identifier fails.
if [ -z "${ANTWARS_IDENTIFIERS+set}" ]; then die "the ANTWARS_IDENTIFIERS secret is not set"; fi
if [ -z "$ANTWARS_IDENTIFIERS" ]; then die "the ANTWARS_IDENTIFIERS secret is empty"; fi
tmp=$(umask 077; mktemp -d) || die "could not create a private temporary directory"
trap 'rm -rf "$tmp"' EXIT
idfile=$tmp/ids
# The file itself is created under umask 077, so it is mode 0600 whatever umask the job has.
(umask 077 && printf '%s' "$ANTWARS_IDENTIFIERS" > "$idfile") || die "could not write the identifiers to a private file"
unset ANTWARS_IDENTIFIERS
ids=()
while IFS= read -r line || [ -n "$line" ]; do
  # A carriage return is rejected before blank lines are skipped: a CR-only line is not blank.
  case "$line" in *$'\r'*) die "ANTWARS_IDENTIFIERS has a carriage return; use LF line endings" ;; esac
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  ids+=("${line,,}")
done < "$idfile"
[ "${#ids[@]}" -gt 0 ] || die "the ANTWARS_IDENTIFIERS secret has no identifiers (only blank or whitespace lines)"

remote_git() {
  if [ -n "${FETCH_TOKEN:-}" ]; then
    local auth
    auth=$(printf 'x-access-token:%s' "$FETCH_TOKEN" | base64 -w0) || die "could not encode FETCH_TOKEN"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
      git "$@"
  else
    git "$@"
  fi
}

if [ "${1:-}" = --pull-request ]; then
  [ "$#" -eq 3 ] || { echo "usage: $0 --pull-request <number> <head-sha>" >&2; exit 2; }
  number=$2 head=$3
  [[ "$number" =~ ^[1-9][0-9]{0,9}$ ]] || die "pull request number is not a number"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "pull request head is not a full commit SHA"
  pr=refs/pull/$number
  # Each ref is listed with ls-remote --exit-code: exit 0 means listed, exit 2 means no matching
  # ref on origin, and any other exit is a lookup error. Only the merge ref may be absent.
  list_ref() { # <remote ref>; sets listed to its SHA, or to nothing when origin has no such ref
    local out rc=0 sha ref found=''
    listed=''
    out=$(remote_git ls-remote --exit-code origin "$1") || rc=$?
    case "$rc" in
      0) ;;
      2) return 0 ;;
      *) die "could not list $1 on origin (ls-remote exited $rc)" ;;
    esac
    while read -r sha ref; do
      [ -n "$sha$ref" ] || continue
      [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "ls-remote returned a malformed line for $1"
      [ "$ref" = "$1" ] || continue   # ls-remote matches ref tails; only the exact ref counts.
      [ -z "$found" ] || die "ls-remote listed $1 twice"
      found=$sha
    done <<< "$out"
    [ -n "$found" ] || die "ls-remote listed only other refs ending in $1, not $1 itself"
    listed=$found
  }
  list_ref "$pr/head"; listed_head=$listed
  [ -n "$listed_head" ] || die "$pr/head is not on origin"
  [ "$listed_head" = "$head" ] || die "$pr/head on origin is $listed_head, not the event's head $head"
  list_ref "$pr/merge"; listed_merge=$listed
  fetch_ref() { # <remote ref> <local ref> <expected sha>
    remote_git fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head origin "+$1:$2" || die "could not fetch $1"
    local got
    got=$(git rev-parse --verify --quiet "$2^{commit}") || die "fetched $1 is not a commit"
    [ "$got" = "$3" ] || die "fetched $1 is $got, not the listed $3"
  }
  fetch_ref "$pr/head" refs/candidate/pr-head "$head"
  set -- refs/candidate/pr-head
  if [ -n "$listed_merge" ]; then
    fetch_ref "$pr/merge" refs/candidate/pr-merge "$listed_merge"
    merge_line=$(git rev-list --parents -n 1 refs/candidate/pr-merge) || die "could not read the parents of $pr/merge (git rev-list failed)"
    read -r -a merge_ids <<< "$merge_line"
    merges_head=0
    for p in "${merge_ids[@]:1}"; do [ "$p" != "$head" ] || merges_head=1; done
    [ "$merges_head" = 1 ] ||
      die "$pr/merge is stale: it does not merge the head $head; re-run once GitHub has updated it"
    set -- "$@" refs/candidate/pr-merge
  else
    merge_absent="$pr/merge is absent on origin (ls-remote --exit-code exited 2); the head alone was checked"
  fi
fi

if [ "$#" -eq 0 ]; then echo "usage: $0 <commit>... | --pull-request <number> <head-sha>" >&2; exit 2; fi
# Every git read below has its output captured and its exit status checked; a failed read fails.
shallow=$(git rev-parse --is-shallow-repository) || die "could not tell whether the clone is shallow (git rev-parse failed)"
[ "$shallow" = false ] || die "the clone is shallow; full history is required"
for c in "$@"; do
  git rev-parse --verify --quiet "$c^{commit}" >/dev/null || die "commit $c is not in this clone"
done

roots=$(git rev-list --max-parents=0 "$@") || die "could not list the root commits (git rev-list failed)"
[ -n "$roots" ] || fail "no root commit found"
for r in $roots; do
  [ "$r" = "$root" ] || fail "root commit $r is not the initial commit $root"
done

# Whole identities, read from each commit's raw header rather than from parsed log fields, so a
# crafted value (a tab, a newline, a NUL, an extra header line) cannot move an identifier out of
# view. A header that is not plainly well formed fails closed. Every id is matched against the
# author and committer names and emails, against the whole header as well, and against the full
# message (everything after the header's blank line; NUL bytes are dropped first).
fields_hit=0
match() { # <sha> <field> <value>
  local v=${3,,} id
  for id in "${ids[@]}"; do
    if [[ "$v" == *"$id"* ]]; then fail "commit $1: $2 matches a private identifier"; fields_hit=1; return; fi
  done
}
expected=$(git rev-list --count "$@") || die "could not count the history (git rev-list --count failed)"
[[ "$expected" =~ ^[0-9]+$ ]] || die "git rev-list --count returned no count"
listing=$(git rev-list "$@") || die "could not list the history (git rev-list failed)"
commits=()
while read -r sha; do
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "git rev-list returned a malformed line"
  commits+=("$sha")
done <<< "$listing"
[ "${#commits[@]}" = "$expected" ] || die "git rev-list listed ${#commits[@]} commits but counted $expected"
obj=$tmp/commit hdr=$tmp/header body=$tmp/body
checked=0
for sha in "${commits[@]}"; do
  git cat-file commit "$sha" > "$obj" || die "could not read commit $sha (git cat-file failed)"
  sed -n '1,/^$/p' "$obj" > "$hdr" || die "could not split the header of commit $sha"
  nul_rc=0; LC_ALL=C grep -qaP '\x00' "$hdr" || nul_rc=$?
  case "$nul_rc" in
    0) fail "commit $sha: its header contains a NUL byte"; checked=$((checked + 1)); continue ;;
    1) ;;
    *) die "could not scan the header of commit $sha for NUL bytes (grep exited $nul_rc)" ;;
  esac
  mapfile -t lines < "$hdr" || die "could not read the header of commit $sha"
  header='' prev='' authors=0 committers=0 bad='' fields_hit=0
  for line in "${lines[@]}"; do
    [ -n "$line" ] || break
    header+="${line,,}"$'\n'
    if [ "${line:0:1}" = ' ' ]; then
      case "$prev" in gpgsig|gpgsig-sha256|mergetag) ;; *) bad="a continuation line in an unexpected place" ;; esac
      continue
    fi
    key=${line%% *} rest=${line#* } prev=$key
    case "$key" in
      tree|parent) [[ "$rest" =~ ^[0-9a-f]{40}$ ]] || bad="a malformed $key line" ;;
      author|committer)
        if [ "$key" = author ]; then authors=$((authors + 1)); else committers=$((committers + 1)); fi
        if [[ "$rest" =~ ^([^\<\>]*)\ \<([^\<\>]*)\>\ [0-9]+\ [+-][0-9]{4}$ ]]; then
          name=${BASH_REMATCH[1]} email=${BASH_REMATCH[2]}
          match "$sha" "$key-name" "$name"
          match "$sha" "$key-email" "$email"
        else
          bad="a malformed $key line"
        fi ;;
      encoding) [[ "${rest,,}" =~ ^utf-?8$ ]] || bad="an encoding other than UTF-8" ;;
      gpgsig|gpgsig-sha256|mergetag) ;;
      *) bad="an unrecognised header line" ;;
    esac
  done
  [ "$authors" = 1 ] && [ "$committers" = 1 ] || bad=${bad:-"not exactly one author and one committer line"}
  [ -z "$bad" ] || fail "commit $sha: its header has $bad"
  sed '1,/^$/d' "$obj" > "$body" || die "could not split the message of commit $sha"
  message=$(tr -d '\000' < "$body") || die "could not read the message of commit $sha"
  match "$sha" message "$message"
  if [ "$fields_hit" = 0 ]; then
    for id in "${ids[@]}"; do
      if [[ "$header" == *"$id"* ]]; then fail "commit $sha: its header matches a private identifier"; break; fi
    done
  fi
  checked=$((checked + 1))
done
[ "$checked" = "$expected" ] || die "checked $checked commits but git rev-list counted $expected"
n=$checked
[ -z "$merge_absent" ] || echo "history-isolation: $merge_absent"

if [ "$status" = 0 ]; then
  echo "history-isolation: $n commits; only root $root; no author, committer or message matches a private identifier"
fi
exit "$status"
