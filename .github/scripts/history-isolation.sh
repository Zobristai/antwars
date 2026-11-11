#!/usr/bin/env bash
# History isolation: refuses history that has any root commit other than this repository's
# initial commit, and any commit whose author name, author email, committer name, committer
# email or message contains one of the private identifiers. The identifiers are never in the repository:
# they come from the ANTWARS_IDENTIFIERS environment variable (the Actions secret of that name),
# one literal identifier per line, matched case-insensitively as a fixed substring of each whole
# field. Neither identifiers nor matching values are ever printed.
#
# What is matched. The root check always covers the whole history. The identity and message
# checks cover only the commits that are not already on main (see --since and <base-sha> below):
# a commit already on main is public and cannot be changed without rewriting history, so checking
# it again would only turn every later push red when the list grows. Two GitHub addresses in an
# author or committer email are not matched: noreply@github.com, and the no-reply addresses
# (<id>+<login>@users.noreply.github.com and <login>@users.noreply.github.com) of the event's own
# accounts, given in ANTWARS_EVENT_ACCOUNTS (below). GitHub builds those from the account's public
# id and login, and they are on every pull request and merge. Every other address, including any
# other of no-reply form, is matched. In the whole-header view, the base64 and checksum lines
# between the BEGIN and END lines of a PGP or SSH signature in a gpgsig or gpgsig-sha256 header
# (for PGP, after the armor's blank line) are not matched either, since they are encoded bytes,
# not text; any other line of a signature, and every other header line, is.
#
# ANTWARS_EVENT_ACCOUNTS (optional): one account per line, "<id> <login>", with "-" for an account
# whose id the event does not give. In CI these are the push's sender and pusher, or the pull
# request's sender and author, taken from the event. A line whose id is not digits only, or whose
# login is not in GitHub's form (letters, digits and single inner hyphens, at most 39 characters),
# gives no exemption. Unset, only noreply@github.com is exempt.
#
# The initial commit is never in the repository either (a commit cannot carry its own id): it
# comes from the ANTWARS_EXPECTED_ROOT environment variable, the full 40-character lower-case SHA.
# In CI that is the repository Actions variable of the same name; a local run sets the
# environment variable of the same name. Unset, empty or not exactly such a SHA fails.
#
# Usage:
#   history-isolation.sh --push <previous-tip> <commit>
#       a push to main: as --since <previous-tip> when that is a full SHA of a commit in this
#       clone; otherwise (empty, all zeros, or not in the clone) the whole history is checked.
#   history-isolation.sh [--since <sha>] <commit>...
#       checks the history reachable from each commit (push to main). With --since (the full
#       SHA of the previous main tip), the identity and message checks leave out the commits
#       reachable from it; the root check still covers the whole history.
#   history-isolation.sh --pull-request <number> <head-sha> [<base-sha>]
#       lists refs/pull/<number>/head and refs/pull/<number>/merge on origin with
#       ls-remote --exit-code, fetches the listed refs as git objects only (into refs/candidate/*),
#       requires the head to be <head-sha> and each fetched ref to equal its listing, then checks
#       both. The merge ref is treated as absent only when its ls-remote exits 2 (GitHub creates
#       none for a conflicting pull request); then the head alone is checked. Any other ls-remote
#       exit and any fetch error fails. Nothing from the pull request is checked out or run.
#       With <base-sha> (the full SHA of the pull request's base, which must be in the clone),
#       the identity and message checks leave out the commits reachable from the base and from
#       the merge ref's first parent, which is main as GitHub merged it.
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

# The exempt addresses: noreply@github.com and the no-reply addresses of the event's accounts.
# An account line that is not "<digits or -> <GitHub login>" is skipped, so its address is matched.
noreply_ok=(noreply@github.com)
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^(-|[0-9]*)?\ ?$ ]] && continue   # blank, or an account the event does not have
  if [[ "$line" =~ ^(-|[0-9]{1,20})\ ([A-Za-z0-9]([A-Za-z0-9]|-[A-Za-z0-9])*)$ ]] && [ "${#BASH_REMATCH[2]}" -le 39 ]; then
    acct_id=${BASH_REMATCH[1]} login=${BASH_REMATCH[2],,}
    noreply_ok+=("$login@users.noreply.github.com")
    [ "$acct_id" = - ] || noreply_ok+=("$acct_id+$login@users.noreply.github.com")
  else
    echo "history-isolation: an event account is not a GitHub id and login; its addresses are matched like any other"
  fi
done <<< "${ANTWARS_EVENT_ACCOUNTS:-}"

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

# Commits already on main, whose identities and messages are not checked again (root check aside).
exclude=()
if [ "${1:-}" = --push ]; then
  [ "$#" -eq 3 ] || { echo "usage: $0 --push <previous-tip> <commit>" >&2; exit 2; }
  if [[ "$2" =~ ^[0-9a-f]{40}$ ]] && [[ ! "$2" =~ ^0+$ ]] && git rev-parse --verify --quiet "$2^{commit}" >/dev/null; then
    exclude+=("$2")
  else
    echo "history-isolation: no previous main tip in this clone; the whole history is checked"
  fi
  shift 2
elif [ "${1:-}" = --since ]; then
  [ "$#" -ge 3 ] || { echo "usage: $0 [--since <sha>] <commit>..." >&2; exit 2; }
  [[ "$2" =~ ^[0-9a-f]{40}$ ]] || die "--since is not a full commit SHA"
  git rev-parse --verify --quiet "$2^{commit}" >/dev/null || die "--since commit $2 is not in this clone"
  [ "$3" != --pull-request ] || die "--since cannot be combined with --pull-request"
  exclude+=("$2")
  shift 2
fi

if [ "${1:-}" = --pull-request ]; then
  [ "$#" -eq 3 ] || [ "$#" -eq 4 ] || { echo "usage: $0 --pull-request <number> <head-sha> [<base-sha>]" >&2; exit 2; }
  number=$2 head=$3 base=${4:-}
  [[ "$number" =~ ^[1-9][0-9]{0,9}$ ]] || die "pull request number is not a number"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "pull request head is not a full commit SHA"
  if [ "$#" -eq 4 ]; then
    [[ "$base" =~ ^[0-9a-f]{40}$ ]] || die "pull request base is not a full commit SHA"
    git rev-parse --verify --quiet "$base^{commit}" >/dev/null || die "pull request base $base is not in this clone"
    exclude+=("$base")
  fi
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
    # The merge ref's first parent is main as GitHub merged it; with a base, it is left out too.
    # Only a two-parent merge whose first parent is not the head counts; anything else is checked.
    if [ -n "$base" ] && [ "${#merge_ids[@]}" -eq 3 ] && [ "${merge_ids[1]}" != "$head" ]; then
      exclude+=("${merge_ids[1]}")
    fi
    set -- "$@" refs/candidate/pr-merge
  else
    merge_absent="$pr/merge is absent on origin (ls-remote --exit-code exited 2); the head alone was checked"
  fi
fi

if [ "$#" -eq 0 ]; then echo "usage: $0 --push <previous-tip> <commit> | [--since <sha>] <commit>... | --pull-request <number> <head-sha> [<base-sha>]" >&2; exit 2; fi
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
# An exempt address is one of noreply_ok, compared whole (case-insensitively); anything else,
# including any other address of no-reply form, is an ordinary email and is matched.
noreply() { # <email>
  local e=${1,,} a
  for a in "${noreply_ok[@]}"; do [ "$e" != "$a" ] || return 0; done
  return 1
}
fields_hit=0
match() { # <sha> <field> <value>
  local v=${3,,} id
  for id in "${ids[@]}"; do
    if [[ "$v" == *"$id"* ]]; then fail "commit $1: $2 matches a private identifier"; fields_hit=1; return; fi
  done
}
# The commits to check: those reachable from the targets but not from any already-on-main commit.
range=("$@")
for e in "${exclude[@]}"; do range+=("^$e"); done
expected=$(git rev-list --count "${range[@]}") || die "could not count the history (git rev-list --count failed)"
[[ "$expected" =~ ^[0-9]+$ ]] || die "git rev-list --count returned no count"
listing=$(git rev-list "${range[@]}") || die "could not list the history (git rev-list failed)"
commits=()
while read -r sha; do
  [ -n "$sha" ] || [ "$expected" != 0 ] || continue   # nothing new to check: an empty listing
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
  # Signature state: sig is none, armor (PGP armor headers, before its blank line), body
  # (between the armor and the END line) or done; sigend is the END line awaited; held keeps
  # the body's base64 and checksum lines, which are dropped only once that END line is seen.
  sig=none sigend='' held=''
  for line in "${lines[@]}"; do
    [ -n "$line" ] || break
    if [ "${line:0:1}" = ' ' ]; then
      case "$prev" in
        gpgsig|gpgsig-sha256)
          case "$sig" in
            armor) [ "$line" != ' ' ] || sig=body; header+="${line,,}"$'\n' ;;
            body)
              if [ "$line" = "$sigend" ]; then
                sig=done held=''; header+="${line,,}"$'\n'
              elif [[ "$line" =~ ^\ [A-Za-z0-9+/]+={0,2}$ || "$line" =~ ^\ =[A-Za-z0-9+/]{4}$ ]]; then
                held+="${line,,}"$'\n'
              else
                header+="${line,,}"$'\n'
              fi ;;
            *) header+="${line,,}"$'\n' ;;
          esac ;;
        mergetag) header+="${line,,}"$'\n' ;;
        *) header+="${line,,}"$'\n'; bad="a continuation line in an unexpected place" ;;
      esac
      continue
    fi
    view=$line
    key=${line%% *} rest=${line#* } prev=$key
    # A signature with no END line keeps every line in the header view.
    header+=$held; held='' sig=none
    case "$key" in
      tree|parent) [[ "$rest" =~ ^[0-9a-f]{40}$ ]] || bad="a malformed $key line" ;;
      author|committer)
        if [ "$key" = author ]; then authors=$((authors + 1)); else committers=$((committers + 1)); fi
        if [[ "$rest" =~ ^([^\<\>]*)\ \<([^\<\>]*)\>\ ([0-9]+\ [+-][0-9]{4})$ ]]; then
          name=${BASH_REMATCH[1]} email=${BASH_REMATCH[2]} when=${BASH_REMATCH[3]}
          match "$sha" "$key-name" "$name"
          # A GitHub no-reply address is public: neither matched nor kept in the header view.
          if noreply "$email"; then
            view="$key $name <> $when"
          else
            match "$sha" "$key-email" "$email"
          fi
        else
          bad="a malformed $key line"
        fi ;;
      encoding) [[ "${rest,,}" =~ ^utf-?8$ ]] || bad="an encoding other than UTF-8" ;;
      gpgsig|gpgsig-sha256)
        case "$rest" in
          '-----BEGIN PGP SIGNATURE-----') sig=armor sigend=' -----END PGP SIGNATURE-----' ;;
          '-----BEGIN SSH SIGNATURE-----') sig=body sigend=' -----END SSH SIGNATURE-----' ;;
        esac ;;
      mergetag) ;;
      *) bad="an unrecognised header line" ;;
    esac
    header+="${view,,}"$'\n'
  done
  header+=$held
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
  echo "history-isolation: only root $root; $n commits not already on main checked; no author, committer or message matches a private identifier"
fi
exit "$status"
