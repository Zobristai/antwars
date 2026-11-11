#!/usr/bin/env bash
# Offline regression cases for .github/scripts/history-isolation.sh. SYNTHETIC identifiers only:
# nothing here is, contains or patterns a real private identifier. Needs a full (unshallow) clone
# of this repository, for its initial commit: the clone's single root commit, read from the clone
# rather than written here, and given to the script as ANTWARS_EXPECTED_ROOT. No Actions variable
# or secret and no network is used. Every case builds its commits in a scratch copy, and failures
# are simulated with the git shim in git-shim/.
# Usage: .github/scripts/test/history-isolation-test.sh [script]   (exits non-zero on any mismatch)
set -u
here=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$here" rev-parse --show-toplevel) || exit 2
S=${1:-$REPO/.github/scripts/history-isolation.sh}
SHIM=$here/git-shim
export REAL_GIT; REAL_GIT=$(command -v git)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; mkdir -p $W/out
[ "$(git -C "$REPO" rev-parse --is-shallow-repository)" = false ] || { echo "needs a full clone" >&2; exit 2; }
BASE=$(git -C "$REPO" rev-list --max-parents=0 HEAD) || { echo "could not list the root commits" >&2; exit 2; }
[[ "$BASE" =~ ^[0-9a-f]{40}$ ]] || { echo "needs exactly one root commit, found: $(echo $BASE)" >&2; exit 2; }
export ANTWARS_EXPECTED_ROOT=$BASE
git init -q --bare $W/origin.git
git -C "$REPO" push -q $W/origin.git "$BASE:refs/heads/main"
git clone -q $W/origin.git $W/work 2>/dev/null; cd $W/work
T=$(git rev-parse "$BASE^{tree}")
export ANTWARS_IDENTIFIERS=$'synthid-alpha\nsynthcorp.example\n9876543210'
Z='Zobrist <noreply@zobrist.ai> 1793970000 +0000'
# A clean three-commit synthetic chain on the initial commit: C1 <- C2 <- C.
chain(){ printf 'tree %s\nparent %s\nauthor %s\ncommitter %s\n\n%s\n' "$T" "$1" "$Z" "$Z" "$2" | git hash-object -t commit -w --literally --stdin; }
C1=$(chain $BASE 'chain one'); C2=$(chain $C1 'chain two'); C=$(chain $C2 'chain three')
git push -q $W/origin.git "$C:refs/heads/chain"
raw(){ printf 'tree %s\nparent %s\n%s\n\n%s\n' "$T" "${3:-$C}" "$1" "${2:-case}" | git hash-object -t commit -w --literally --stdin; }
id(){ raw "author $1"$'\n'"committer $2"; }
msg(){ raw "author $Z"$'\n'"committer $Z" "$1"; }
k=0 bad=0
show(){ name=$1 want=$2 rc=$3 out=$4; k=$((k+1)); echo "$out" > $W/out/$k.txt; got=$([ $rc = 0 ] && echo pass || echo fail)
  verdict=OK; [ $want = $got ] || { verdict=MISMATCH; bad=$((bad+1)); }
  printf '%-56s want=%s got=%s %s\n' "$name" $want $got $verdict; echo "$out" | grep -v '^$' | sed 's/^/      /' | head -3; }
run(){ name=$1 want=$2; shift 2; out=$(bash $S "$@" 2>&1); show "$name" $want $? "$out"; }
runenv(){ name=$1 want=$2; shift 2; out=$(env "$@" 2>&1); show "$name" $want $? "$out"; }
run "1 clean, push mode (root)" pass $BASE
run "1b clean, push mode (synthetic chain)" pass $C
SIG=$(raw "author $Z"$'\n'"committer $Z"$'\n'"gpgsig -----BEGIN PGP SIGNATURE-----"$'\n'" "$'\n'" AAAA"$'\n'" -----END PGP SIGNATURE-----")
run "1c signed-commit header shape" pass $SIG
run "1d GitHub noreply author" pass $(id 'Octo <12345678+octo-user@users.noreply.github.com> 1 +0000' "$Z")
O=$(printf 'tree %s\nauthor %s\ncommitter %s\n\norphan\n' "$T" "$Z" "$Z" | git hash-object -t commit -w --literally --stdin)
M=$(printf 'tree %s\nparent %s\nparent %s\nauthor %s\ncommitter %s\n\nm\n' "$T" "$C" "$O" "$Z" "$Z" | git hash-object -t commit -w --literally --stdin)
run "2 wrong root" fail $M
run "3 author name" fail $(id 'Synthid-Alpha Dev <noreply@zobrist.ai> 1 +0000' "$Z")
run "4 author email" fail $(id 'Dev <dev@synthcorp.example> 1 +0000' "$Z")
run "5 committer name" fail $(id "$Z" 'ops 9876543210 <noreply@zobrist.ai> 1 +0000')
run "6 committer email" fail $(id "$Z" 'Ops <ops@synthcorp.example> 1 +0000')
run "7 mixed-case value" fail $(id 'Dev <dev@SynthCorp.EXAMPLE> 1 +0000' "$Z")
runenv "7b mixed-case id in the LIST vs lower-case value" fail ANTWARS_IDENTIFIERS='SynthID-ALPHA' bash $S $(id 'synthid-alpha <noreply@zobrist.ai> 1 +0000' "$Z")
runenv "7c list without final LF, hit on LAST line" fail ANTWARS_IDENTIFIERS=$'none-such-id\nsynthcorp.example' bash $S $(id "$Z" 'Ops <ops@synthcorp.example> 1 +0000')
runenv "7d list without trailing LF, no hit" pass ANTWARS_IDENTIFIERS=$'none-such-id\nsynthcorp.example' bash $S $C
run "8a tab then id: author name" fail $(id $'Dev\tsynthid-alpha <noreply@zobrist.ai> 1 +0000' "$Z")
run "8b tab then id: author email" fail $(id $'Dev <dev\tx@synthcorp.example> 1 +0000' "$Z")
run "8c tab then id: committer name" fail $(id "$Z" $'Ops\t9876543210 <noreply@zobrist.ai> 1 +0000')
run "8d tab then id: committer email" fail $(id "$Z" $'Ops <ops\tbot@synthcorp.example> 1 +0000')
run "8e control: tabs in all four fields, no id" pass $(id $'Dev\tPlain <dev\tp@example.org> 1 +0000' $'Ops\tPlain <ops\tp@example.org> 1 +0000')
run "9 newline then id in a name" fail $(raw "author Dev"$'\n'"synthid-alpha <noreply@zobrist.ai> 1 +0000"$'\n'"committer $Z")
run "9b NUL in a name" fail $(printf 'tree %s\nparent %s\nauthor Dev\0x <n@example.org> 1 +0000\ncommitter %s\n\nc\n' "$T" "$C" "$Z" | git hash-object -t commit -w --literally --stdin)
run "9c continuation line after author" fail $(raw "author $Z"$'\n'" synthid-alpha"$'\n'"committer $Z")
run "9d extra header line" fail $(raw "author $Z"$'\n'"committer $Z"$'\n'"x-extra synthid-alpha")
run "9e non-UTF-8 encoding header" fail $(raw "author $Z"$'\n'"committer $Z"$'\n'"encoding ISO-8859-1")
run "10 id in the message subject" fail $(msg 'Fix the synthid-alpha thing')
run "10b id deep in the message body, mixed case" fail $(msg $'Subject\n\nSome text\nmore\nreach SynthCorp.EXAMPLE here\n')
run "10c id after a tab in the body" fail $(msg $'Subject\n\nx\t9876543210')
run "10d id in the body after a NUL byte" fail $(printf 'tree %s\nparent %s\nauthor %s\ncommitter %s\n\nsubj\n\nbody\0synthid-alpha\n' "$T" "$C" "$Z" "$Z" | git hash-object -t commit -w --literally --stdin)
run "10e clean message passes" pass $(msg $'Clean subject\n\nA clean body\nwith lines\tand tabs\n')
sec(){ name=$1; shift; out=$(env "$@" bash $S $C 2>&1); show "$name" fail $? "$out"; }
sec "11 secret missing" -u ANTWARS_IDENTIFIERS
sec "11b secret empty" ANTWARS_IDENTIFIERS=
sec "11c secret only a newline" ANTWARS_IDENTIFIERS=$'\n'
sec "11d whitespace-only secret (spaces)" ANTWARS_IDENTIFIERS='   '
sec "11d2 whitespace-only secret (tabs, blank lines, spaces)" ANTWARS_IDENTIFIERS=$'\t\n\n  \n\t \n'
runenv "11f blank line in the middle: id BEFORE it caught" fail ANTWARS_IDENTIFIERS=$'synthid-alpha\n\n   \nsynthcorp.example' bash $S $(id 'synthid-alpha <noreply@zobrist.ai> 1 +0000' "$Z")
runenv "11g blank line in the middle: id AFTER it caught" fail ANTWARS_IDENTIFIERS=$'synthid-alpha\n\n   \nsynthcorp.example' bash $S $(id "$Z" 'Ops <ops@synthcorp.example> 1 +0000')
runenv "11h blank lines in the list, clean history passes" pass ANTWARS_IDENTIFIERS=$'synthid-alpha\n\n \t\nsynthcorp.example\n' bash $S $C
runenv "11i line kept as written: ' synthid-alpha' (leading space) vs value without it" pass ANTWARS_IDENTIFIERS=' synthid-alpha' bash $S $(id 'Dev <synthid-alpha@noreply.example> 1 +0000' "$Z")
runenv "11j line kept as written: ' synthid-alpha' vs value with it" fail ANTWARS_IDENTIFIERS=' synthid-alpha' bash $S $(id 'Dev synthid-alpha <noreply@zobrist.ai> 1 +0000' "$Z")
sec "11e CRLF" ANTWARS_IDENTIFIERS=$'synthid-alpha\r'
# Pull-request mode: refs in a bare origin; runner checked out at base main.
H_OK=$(id 'Octo <12345678+octo-user@users.noreply.github.com> 1 +0000' "$Z")
H_BAD=$(id 'Dev <dev@synthcorp.example> 1 +0000' "$Z")
H_MSG=$(msg 'touches synthid-alpha')
mg(){ printf 'tree %s\nparent %s\nparent %s\nauthor %s\ncommitter %s\n\nm\n' "$T" "$BASE" "$1" "$Z" "${2:-$Z}" | git hash-object -t commit -w --literally --stdin; }
MG_OK=$(mg $H_OK); MG_BAD=$(mg $H_OK 'Dev <x@synthcorp.example> 1 +0000'); H2=$(id 'Other <o@example.org> 1 +0000' "$Z"); MG_STALE=$(mg $H2)
git push -q $W/origin.git $H_OK:refs/pull/1/head $MG_OK:refs/pull/1/merge $H_BAD:refs/pull/2/head $H_OK:refs/pull/3/head $MG_BAD:refs/pull/3/merge \
  $H_OK:refs/pull/4/head $H_OK:refs/pull/5/head $MG_STALE:refs/pull/5/merge $H_MSG:refs/pull/6/head $(mg $H_MSG):refs/pull/6/merge \
  $H_OK:refs/heads/decoy/refs/pull/1/merge $H_OK:refs/pull/7/head $H_OK:refs/heads/decoy/refs/pull/7/merge 2>&1 | grep -v '^$'
git clone -q $W/origin.git $W/runner 2>/dev/null; git -C $W/runner checkout -q --detach $BASE
pr(){ name=$1 want=$2; shift 2; out=$(cd $W/runner && env "$@" 2>&1); show "$name" $want $? "$out"; }
P="PATH=$SHIM:$PATH"
pr "12 PR clean (head + merge ref)" pass bash $S --pull-request 1 $H_OK
pr "12b PR clean, decoy branch ending in refs/pull/1/merge ignored" pass bash $S --pull-request 1 $H_OK
pr "13 PR head on origin != event head" fail bash $S --pull-request 1 $H_BAD
pr "14 PR merge ls-remote exits 2 (absent), bad head fails" fail bash $S --pull-request 2 $H_BAD
pr "14b PR merge ls-remote exits 2 (absent), clean head passes" pass bash $S --pull-request 4 $H_OK
pr "15 PR bad identity only on the merge ref" fail bash $S --pull-request 3 $H_OK
pr "15b PR id only in the head's message" fail bash $S --pull-request 6 $H_MSG
pr "16 PR stale merge ref (does not merge the head)" fail bash $S --pull-request 5 $H_OK
pr "17 REGRESSION ls-remote error (merge-ref lookup)" fail $P FAIL_LSREMOTE=1 bash $S --pull-request 4 $H_OK
pr "17b ls-remote error, PR that has a merge ref" fail $P FAIL_LSREMOTE=1 bash $S --pull-request 1 $H_OK
pr "18 REGRESSION head fetch fails" fail $P FAIL_FETCH=refs/pull/1/head bash $S --pull-request 1 $H_OK
pr "18b merge-ref fetch fails" fail $P FAIL_FETCH=refs/pull/1/merge bash $S --pull-request 1 $H_OK
pr "18c origin unreachable" fail bash -c "git remote set-url origin /nonexistent && bash $S --pull-request 1 $H_OK; rc=\$?; git remote set-url origin $W/origin.git; exit \$rc"
pr "20 simulated merge exit 2, clean head passes" pass $P LSREMOTE_EXIT=2 LSREMOTE_REF=refs/pull/1/merge bash $S --pull-request 1 $H_OK
pr "20b simulated merge exit 2, bad head fails" fail $P LSREMOTE_EXIT=2 LSREMOTE_REF=refs/pull/2/merge bash $S --pull-request 2 $H_BAD
pr "20c simulated merge exit 2, id only in head message fails" fail $P LSREMOTE_EXIT=2 LSREMOTE_REF=refs/pull/6/merge bash $S --pull-request 6 $H_MSG
pr "21 merge ls-remote exits 1 fails" fail $P LSREMOTE_EXIT=1 LSREMOTE_REF=refs/pull/4/merge bash $S --pull-request 4 $H_OK
pr "21b merge ls-remote exits 128 fails" fail $P LSREMOTE_EXIT=128 LSREMOTE_REF=refs/pull/4/merge bash $S --pull-request 4 $H_OK
pr "21c merge ls-remote exits 3 fails (PR with a merge ref)" fail $P LSREMOTE_EXIT=3 LSREMOTE_REF=refs/pull/1/merge bash $S --pull-request 1 $H_OK
pr "21d head ls-remote exits 1 fails" fail $P LSREMOTE_EXIT=1 LSREMOTE_REF=refs/pull/1/head bash $S --pull-request 1 $H_OK
pr "21e head ls-remote exits 2 (no head) fails" fail $P LSREMOTE_EXIT=2 LSREMOTE_REF=refs/pull/1/head bash $S --pull-request 1 $H_OK
pr "22 only a decoy ref ending in refs/pull/7/merge fails" fail bash $S --pull-request 7 $H_OK
pr "19 PR number not a number" fail bash $S --pull-request '1;x' $H_OK
pr "19b PR head not a full SHA" fail bash $S --pull-request 1 HEAD
pr "19c PR number with no refs" fail bash $S --pull-request 99 $H_OK
# Fail-closed git reads (push mode): a read failing at the start or partway through fails the check.
gs(){ name=$1 want=$2; shift 2; rm -f $W/shim.state; out=$(env PATH="$SHIM:$PATH" GIT_SHIM_STATE=$W/shim.state "$@" bash $S $C 2>&1); show "$name" $want $? "$out"; }
gs "24 shim passthrough, clean chain passes" pass
# The identifiers file is mode 0600 (its directory 0700) even under a permissive umask.
mkdir -p $W/idtmp; rm -f $W/idmodes
out=$(umask 022; env PATH="$SHIM:$PATH" TMPDIR=$W/idtmp GIT_SHIM_STAT_IDS=$W/idmodes bash $S $C 2>&1); rc=$?
modes=$(sort -u $W/idmodes | grep -v '^$'); out="$out"$'\n'"modes seen (dir file): $modes"
[ "$rc" = 0 ] && [ "$modes" = "700 600 " ] && rc=0 || rc=1
show "26 identifiers file is mode 0600 under umask 022" pass $rc "$out"
gs "24b history listing (rev-list) fails" fail GIT_SHIM_FAIL='rev-list [!-]*'
gs "24c history listing prints one commit then fails" fail GIT_SHIM_FAIL='rev-list [!-]*' GIT_SHIM_PARTIAL=1
gs "24d commit count (rev-list --count) fails" fail GIT_SHIM_FAIL='rev-list --count *'
gs "24e commit count disagrees with the listing" fail GIT_SHIM_COUNT=99
gs "24f root listing (rev-list --max-parents=0) fails" fail GIT_SHIM_FAIL='rev-list --max-parents=0 *'
gs "24g shallow probe (rev-parse) fails" fail GIT_SHIM_FAIL='rev-parse --is-shallow-repository'
gs "25 object read fails on the first commit" fail GIT_SHIM_FAIL='cat-file commit *'
gs "25b object read fails partway (2nd of 4)" fail GIT_SHIM_FAIL='cat-file commit *' GIT_SHIM_AFTER=1
gs "25c object read fails on the last commit (4th of 4)" fail GIT_SHIM_FAIL='cat-file commit *' GIT_SHIM_AFTER=3
gs "25d object read prints part of the 2nd commit then fails" fail GIT_SHIM_FAIL='cat-file commit *' GIT_SHIM_AFTER=1 GIT_SHIM_PARTIAL=2
# Fail-closed git reads (pull-request mode).
pr "27 PR merge-parent read (rev-list --parents) fails" fail $P GIT_SHIM_STATE=$W/shim.pr27 GIT_SHIM_FAIL='rev-list --parents *' bash $S --pull-request 1 $H_OK
pr "27b PR object read fails partway through head and merge" fail $P GIT_SHIM_STATE=$W/shim.pr27b GIT_SHIM_FAIL='cat-file commit *' GIT_SHIM_AFTER=2 bash $S --pull-request 1 $H_OK
pr "27c PR shim passthrough, clean" pass $P GIT_SHIM_STATE=$W/shim.pr27c bash $S --pull-request 1 $H_OK
# Carriage returns are rejected before blank lines are skipped.
sec "23 valid id plus a CR-only line" ANTWARS_IDENTIFIERS=$'synthid-alpha\n\r'
sec "23b CR-only line between valid ids" ANTWARS_IDENTIFIERS=$'synthid-alpha\n\r\nsynthcorp.example'
sec "23c secret is a single CR" ANTWARS_IDENTIFIERS=$'\r'
sec "23d CR with spaces on its own line" ANTWARS_IDENTIFIERS=$'synthid-alpha\n  \r  '
# Expected root (ANTWARS_EXPECTED_ROOT): unset, empty or malformed fails closed, and a root
# other than the expected one is caught. Each case must fail with its own message: a failure for
# another reason is reported as got=pass, a mismatch.
why(){ name=$1 msg=$2; shift 2; out=$(env "$@" 2>&1); rc=$?
  if [ $rc != 0 ] && [[ "$out" != *"$msg"* ]]; then out="$out"$'\n'"(failed, but not with: $msg)"; rc=0; fi
  show "$name" fail $rc "$out"; }
NOTSET='ANTWARS_EXPECTED_ROOT variable is not set' EMPTY='ANTWARS_EXPECTED_ROOT variable is empty'
BADSHA='ANTWARS_EXPECTED_ROOT variable is not a full 40-character lower-case commit SHA'
why "28 expected root unset" "$NOTSET" -u ANTWARS_EXPECTED_ROOT bash $S $C
why "28b expected root empty" "$EMPTY" ANTWARS_EXPECTED_ROOT= bash $S $C
why "28c expected root only spaces" "$BADSHA" ANTWARS_EXPECTED_ROOT='   ' bash $S $C
why "28d expected root with a trailing newline" "$BADSHA" ANTWARS_EXPECTED_ROOT="$BASE"$'\n' bash $S $C
why "28e expected root with a leading space" "$BADSHA" ANTWARS_EXPECTED_ROOT=" $BASE" bash $S $C
why "28f expected root abbreviated to 12" "$BADSHA" ANTWARS_EXPECTED_ROOT="${BASE:0:12}" bash $S $C
why "28g expected root upper-case" "$BADSHA" ANTWARS_EXPECTED_ROOT="$(echo $BASE | tr a-f A-F)" bash $S $C
why "28h expected root a ref name" "$BADSHA" ANTWARS_EXPECTED_ROOT=HEAD bash $S $C
why "28i expected root unset, identifiers unset too" "$NOTSET" -u ANTWARS_EXPECTED_ROOT -u ANTWARS_IDENTIFIERS bash $S $C
why "29 expected root another real commit, clean chain caught" "root commit $BASE is not the initial commit $C1" ANTWARS_EXPECTED_ROOT=$C1 bash $S $C
why "29b expected root the orphan, real root caught" "root commit $BASE is not the initial commit $O" ANTWARS_EXPECTED_ROOT=$O bash $S $C
why "29c expected root the orphan, two-root merge caught" "root commit $BASE is not the initial commit $O" ANTWARS_EXPECTED_ROOT=$O bash $S $M
why "29d expected root right, orphan root still caught" "root commit $O is not the initial commit $BASE" bash $S $M
run "29e control: expected root right, clean chain passes" pass $C
why "30 PR mode, expected root unset" "$NOTSET" -u ANTWARS_EXPECTED_ROOT bash -c "cd $W/runner && bash $S --pull-request 1 $H_OK"
why "30b PR mode, expected root empty" "$EMPTY" ANTWARS_EXPECTED_ROOT= bash -c "cd $W/runner && bash $S --pull-request 1 $H_OK"
why "30c PR mode, expected root another commit, caught" "is not the initial commit $C1" ANTWARS_EXPECTED_ROOT=$C1 bash -c "cd $W/runner && bash $S --pull-request 1 $H_OK"
# GitHub no-reply addresses are public: not matched, even when the list holds the login or id.
NR='9876543210+synthid-alpha@users.noreply.github.com'
run "31 no-reply author <id>+<login>, both listed" pass $(id "Octo <$NR> 1 +0000" "$Z")
run "31b no-reply author <login> form, login listed" pass $(id 'Octo <synthid-alpha@users.noreply.github.com> 1 +0000' "$Z")
run "31c no-reply committer, mixed case" pass $(id "$Z" 'Octo <9876543210+Synthid-Alpha@Users.NoReply.GitHub.com> 1 +0000')
runenv "31d noreply@github.com committer, listed" pass ANTWARS_IDENTIFIERS='noreply@github.com' bash $S $(id "$Z" 'GitHub <noreply@github.com> 1 +0000')
run "32 no-reply email, listed text in the name still caught" fail $(id "Synthid-Alpha <$NR> 1 +0000" "$Z")
run "32b look-alike: listed text as a subdomain" fail $(id 'Dev <x@synthid-alpha.users.noreply.github.com> 1 +0000' "$Z")
run "32c look-alike: no-reply form with a suffix" fail $(id 'Dev <1+x@users.noreply.github.com.synthcorp.example> 1 +0000' "$Z")
run "32d look-alike: wrong top-level domain" fail $(id 'Dev <synthid-alpha@users.noreply.github.co> 1 +0000' "$Z")
run "32e look-alike: login with a double hyphen" fail $(id 'Dev <synthid-alpha--x@users.noreply.github.com> 1 +0000' "$Z")
run "32f look-alike: login with an underscore" fail $(id 'Dev <synthid_alpha_9876543210@users.noreply.github.com> 1 +0000' "$Z")
# A signature's base64 and checksum lines are not matched; any other text in it, and mergetag, is.
sig(){ raw "author $Z"$'\n'"committer $Z"$'\n'"$1 -----BEGIN PGP SIGNATURE-----"$'\n'" "$'\n'"$2"$'\n'" =ab12"$'\n'" -----END PGP SIGNATURE-----"; }
K='ANTWARS_IDENTIFIERS=synthkey9'
runenv "33 listed text inside a signature's base64 line" pass $K bash $S $(sig gpgsig ' AAAAsynthkey9BBBB+/==')
runenv "33b listed text inside a gpgsig-sha256 base64 line" pass $K bash $S $(sig gpgsig-sha256 ' SynthKey9AAAA')
runenv "33c listed text in a signature's armor header line" fail $K bash $S $(sig gpgsig ' Comment: synthkey9')
runenv "33d listed text in a mergetag continuation" fail $K bash $S $(raw "author $Z"$'\n'"committer $Z"$'\n'"mergetag object $C"$'\n'" tagger synthkey9 <t@example.org> 1 +0000")
# Commits already on main (--since, or a pull request's base) are not checked again; the root is.
B1=$(id 'Dev <dev@synthcorp.example> 1 +0000' "$Z"); B2=$(chain $B1 'after the old commit')
run "34 --since the old commit: its identity is not checked again" pass --since $B1 $B2
run "34b --since before the old commit: it is checked" fail --since $C $B2
run "34c no --since: the whole history is checked" fail $B2
run "34d --since the commit itself: nothing new, passes" pass --since $B2 $B2
run "34e --since: a listed text after it is caught" fail --since $C2 $(msg 'adds synthid-alpha')
M2=$(chain $M 'after the two-root merge')
run "34f --since past a wrong root: the root is still caught" fail --since $M $M2
run "34g --since not a full SHA" fail --since HEAD $B2
run "34h --since not in this clone" fail --since 0123456789abcdef0123456789abcdef01234567 $B2
run "34i --since with --pull-request" fail --since $C --pull-request 1 $H_OK
HB=$(chain $B1 'pull request change')
MGB=$(printf 'tree %s\nparent %s\nparent %s\nauthor %s\ncommitter %s\n\nm\n' "$T" "$B1" "$HB" "$Z" "$Z" | git hash-object -t commit -w --literally --stdin)
git push -q $W/origin.git $B1:refs/heads/main-old $HB:refs/pull/8/head $MGB:refs/pull/8/merge 2>&1 | grep -v '^$'
git clone -q $W/origin.git $W/runner2 2>/dev/null; git -C $W/runner2 checkout -q --detach $B1
pr2(){ name=$1 want=$2; shift 2; out=$(cd $W/runner2 && env "$@" 2>&1); show "$name" $want $? "$out"; }
pr2 "35 PR with base: a commit already on the base not checked again" pass bash $S --pull-request 8 $HB $B1
pr2 "35b PR without base: the whole history is checked" fail bash $S --pull-request 8 $HB
pr2 "35c PR with an older base: the merge ref's first parent is left out" pass bash $S --pull-request 8 $HB $C
pr2 "35d PR with base: a listed text in the head's message still caught" fail bash $S --pull-request 6 $H_MSG $B1
pr2 "35e PR with base: a bad identity on the merge ref still caught" fail bash $S --pull-request 3 $H_OK $B1
pr2 "35f PR base not a full SHA" fail bash $S --pull-request 8 $HB HEAD
pr2 "35g PR base not in this clone" fail bash $S --pull-request 8 $HB 0123456789abcdef0123456789abcdef01234567
echo "== runner: worktree changes $(git -C $W/runner status --porcelain | wc -l), HEAD $(git -C $W/runner rev-parse HEAD)"
leaks=$(cat $W/out/*.txt | grep -ciE 'synth|9876543210|none-such')
echo "== outputs containing a synthetic identifier or its text: $leaks"
[ "$leaks" = 0 ] || bad=$((bad+1))
echo "== $k cases, $((k-bad)) as intended, $bad not"
[ "$bad" = 0 ]
