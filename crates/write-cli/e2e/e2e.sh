#!/usr/bin/env bash
# End-to-end run of the `write` CLI against a running Silicon Write service and a local
# Silicon Accounts stack (with its mock email inbox). It signs up two new Carbons (through
# e2e/lib/stack.mjs), signs them in to `write` with the device flow (approved with the
# `silicon-accounts` CLI), creates a Silicon and signs it in with a short-lived token, then exercises
# every command group: library, reading/editing, pull/status/push, comments, suggestions,
# sharing, transfers, versions, import/export, public links and sign-out.
#
# Every state lives in a fresh temp directory; nothing touches ~/.write or ~/.accounts.
#
#   crates/write-cli/e2e/e2e.sh                 # defaults below
#   KEEP=1 crates/write-cli/e2e/e2e.sh          # keep the temp directory for inspection
#
# Exit status: 0 when every check passed, 1 otherwise (each failure is listed at the end).
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
WRITE=${WRITE:-$ROOT/target/cli/debug/write}
ACCOUNTS_CLI=${ACCOUNTS_CLI:-/Users/codanium/Documents/silicon/silicon-accounts/target/integration/debug/silicon-accounts}
ACCOUNTS_URL=${ACCOUNTS_URL:-http://localhost:9890}
WRITE_API_URL=${WRITE_API_URL:-http://127.0.0.1:4371}
INBOX=${INBOX:-http://127.0.0.1:9892}
TING=${TING:-http://127.0.0.1:4372}       # the local Ting stand-in (GET /_tings); skipped when absent

WORK=$(mktemp -d "${TMPDIR:-/tmp}/write-e2e.XXXXXX")
[ -n "${KEEP:-}" ] || trap 'rm -rf "$WORK"' EXIT
export ACCOUNTS_URL WRITE_API_URL
unset SILICON_HOME ACCOUNTS_HOME

PASS=0
FAILED=()
LAST=""

pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAILED+=("$1"); printf '  FAIL  %s\n' "$1"; [ -n "$LAST" ] && printf '        %s\n' "$(printf '%s' "$LAST" | head -c 600 | tr '\n' ' ')"; }

# check "description" command…  — passes when the command exits 0; output kept in $LAST.
check() {
  local desc=$1; shift
  if LAST=$("$@" 2>&1); then pass "$desc"; else fail "$desc (exit $?)"; fi
}
# expect_exit CODE "description" command…
expect_exit() {
  local code=$1 desc=$2; shift 2
  LAST=$("$@" 2>&1); local got=$?
  case "|$code|" in *"|$got|"*) pass "$desc" ;; *) fail "$desc (wanted exit $code, got $got)" ;; esac
}
# contains "description" NEEDLE — checks the last output.
contains() {
  if printf '%s' "$LAST" | grep -qF -- "$2"; then pass "$1"; else fail "$1 (missing “$2”)"; fi
}
lacks() {
  if printf '%s' "$LAST" | grep -qF -- "$2"; then fail "$1 (unexpected “$2”)"; else pass "$1"; fi
}
jqv() { printf '%s' "$LAST" | jq -r "$1" 2>/dev/null; }

C1="$WRITE --home $WORK/carbon"     # Carbon 1 (owner)
C2="$WRITE --home $WORK/carbon2"    # Carbon 2
SI="$WRITE --home $WORK/silicon"    # the Silicon
ANON="$WRITE --home $WORK/anon"     # never signs in
acc() { local home=$1; shift; "$ACCOUNTS_CLI" --url "$ACCOUNTS_URL" --home "$WORK/$home" "$@"; }

section() { printf '\n== %s\n' "$1"; }

# ── preflight ──────────────────────────────────────────────────────────────────────────────
section "Preflight"
[ -x "$WRITE" ] || { echo "Build first: CARGO_TARGET_DIR=$ROOT/target/cli cargo build -p write-cli"; exit 1; }
[ -x "$ACCOUNTS_CLI" ] || { echo "Missing the Silicon Accounts CLI at $ACCOUNTS_CLI (set ACCOUNTS_CLI)."; exit 1; }
curl -fsS -m 3 "$WRITE_API_URL/healthz" >/dev/null || { echo "Silicon Write is not answering at $WRITE_API_URL/healthz."; exit 1; }
curl -fsS -m 3 "$ACCOUNTS_URL/v1/meta" >/dev/null || { echo "Silicon Accounts is not answering at $ACCOUNTS_URL."; exit 1; }
pass "service and Silicon Accounts are up"

check "accounts --json" $C1 --json accounts
[ "$(jqv .app_id)" = write ] && pass "app_id is write" || fail "app_id is write"
check "login status when signed out" $C1 --json login status
[ "$(jqv .authenticated)" = false ] && pass "signed out reports authenticated:false" || fail "signed out reports authenticated:false"
expect_exit 3 "commands need a sign-in (exit 3)" $C1 --json ls
[ "$(jqv .error.code)" = unauthorized ] && pass "error JSON has code unauthorized" || fail "error JSON has code unauthorized"
expect_exit 2 "usage errors are JSON with exit 2" $C1 --json edit
[ "$(jqv .error.code)" = usage ] && pass "usage error code" || fail "usage error code"
for cmd in login logout whoami accounts docs ls tree info link new import export original convert mv rename rm restore purge copy folder search backlinks context join watch cat edit put image asset pull push status share unshare members public transfer transfers comments comment reply resolve reopen react comment-edit comment-rm suggestions suggest accept reject versions version name compare revert undo activity authors; do
  $WRITE $cmd --help >/dev/null 2>&1 || fail "$cmd --help"
done
pass "every command has --help"
check "docs prints the guide" $WRITE docs
contains "guide mentions pull" "write pull"

# ── sign in ────────────────────────────────────────────────────────────────────────────────
section "Sign in"
new_carbon() { # label → prints {"email","id","uuid"}
  (cd "$ROOT" && node crates/write-cli/e2e/carbon.mjs "$1")
}
accounts_carbon_login() { # accounts-home email
  local home=$WORK/$1 email=$2 seq challenge code
  mkdir -p "$home"
  seq=$(curl -fsS "$INBOX/_messages?limit=1" | jq -r '.last_seq // 0')
  challenge=$(acc "$1" --json login --email "$email" </dev/null | jq -r .challenge_id)
  [ -n "$challenge" ] && [ "$challenge" != null ] || return 1
  code=$(curl -fsS "$INBOX/_messages/wait?to=$email&after=$seq&timeout_ms=15000" | jq -r .code)
  [ -n "$code" ] && [ "$code" != null ] || return 1
  acc "$1" --json login --challenge "$challenge" --code "$code" >/dev/null
}
write_device_login() { # write-home accounts-home
  local whome=$1 ahome=$2 code
  $WRITE --home "$WORK/$whome" --json login >"$WORK/$whome.login.out" 2>"$WORK/$whome.login.err" &
  local pid=$!
  for _ in $(seq 1 50); do grep -q user_code "$WORK/$whome.login.err" 2>/dev/null && break; sleep 0.2; done
  code=$(head -1 "$WORK/$whome.login.err" | jq -r .user_code)
  if ! acc "$ahome" --json device approve "$code" >/dev/null; then
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 1
  fi
  wait $pid
}
mkdir -p "$WORK/carbon" "$WORK/carbon2" "$WORK/silicon" "$WORK/anon"
CARBON1=$(new_carbon owner) && pass "signed up Carbon 1 ($(jq -r .id <<<"$CARBON1"))" || { fail "sign up Carbon 1"; exit 1; }
CARBON2=$(new_carbon reader) && pass "signed up Carbon 2 ($(jq -r .id <<<"$CARBON2"))" || { fail "sign up Carbon 2"; exit 1; }
accounts_carbon_login acc-carbon "$(jq -r .email <<<"$CARBON1")" && pass "Carbon 1 signs in to the Silicon Accounts CLI" || fail "Carbon 1 signs in to the Silicon Accounts CLI"
accounts_carbon_login acc-carbon2 "$(jq -r .email <<<"$CARBON2")" && pass "Carbon 2 signs in to the Silicon Accounts CLI" || fail "Carbon 2 signs in to the Silicon Accounts CLI"
write_device_login carbon acc-carbon && pass "Carbon 1: write login (device flow)" || { fail "Carbon 1: write login (device flow)"; exit 1; }
write_device_login carbon2 acc-carbon2 && pass "Carbon 2: write login (device flow)" || { fail "Carbon 2: write login (device flow)"; exit 1; }
LAST=$(cat "$WORK/carbon.login.out")
CID=$(jqv .id); CUUID=$(jqv .uuid)
[ "$(jqv .kind)" = carbon ] && pass "Carbon 1 is $CID" || fail "Carbon 1 session kind"
LAST=$(cat "$WORK/carbon2.login.out"); C2ID=$(jqv .id)

SID="si:writee2e$(date +%s | tail -c 7)"
mkdir -p "$WORK/acc-silicon"
printf 'stk-0123456789abcdef' | acc acc-carbon --json silicon create --id "$SID" --stk-stdin >/dev/null && pass "Carbon 1 creates $SID" || fail "create Silicon"
printf 'stk-0123456789abcdef' | acc acc-silicon --json login --silicon "$SID" --stk-stdin >/dev/null && pass "Silicon signs in to Silicon Accounts" || fail "Silicon signs in to Silicon Accounts"
LAST=$(acc acc-silicon login --app write 2>/dev/null | $SI --json login --token-stdin 2>&1) && pass "Silicon: write login --token-stdin" || fail "Silicon: write login --token-stdin"
[ "$(jqv .kind)" = silicon ] && pass "Silicon session kind" || fail "Silicon session kind"
check "login status --json (Silicon)" $SI --json login status
[ "$(jqv .authenticated)/$(jqv .id)" = "true/$SID" ] && pass "status says authenticated as $SID" || fail "status says authenticated as $SID"
check "whoami" $SI whoami
contains "whoami shows the si:id" "$SID"
expect_exit 5 "login twice without --force (conflict)" $SI --json login --slt slt_x
perm=$(stat -f %Lp "$WORK/silicon/.write/session.json" 2>/dev/null || stat -c %a "$WORK/silicon/.write/session.json")
[ "$perm" = 600 ] && pass "session file is 0600" || fail "session file is 0600 (got $perm)"
if grep -Fq -- "$(jq -r .access_token "$WORK/silicon/.write/session.json")" <<<"$LAST"; then fail "never prints tokens"; else pass "never prints tokens"; fi

# ── token refresh ──────────────────────────────────────────────────────────────────────────
section "Token refresh"
SESSION="$WORK/silicon/.write/session.json"
edit_session() { jq "$1" "$SESSION" >"$SESSION.tmp" && mv "$SESSION.tmp" "$SESSION"; }
rt_before=$(jq -r .refresh_token "$SESSION" | shasum)
edit_session '.expires_at = 0'
check "an expired access token is refreshed before the call" $SI --json whoami
rt_after=$(jq -r .refresh_token "$SESSION" | shasum)
[ "$rt_before" != "$rt_after" ] && pass "the rotated refresh token was saved" || fail "the rotated refresh token was saved"
perm=$(stat -f %Lp "$SESSION" 2>/dev/null || stat -c %a "$SESSION")
[ "$perm" = 600 ] && pass "the refreshed session is still 0600" || fail "the refreshed session is still 0600 (got $perm)"
edit_session '.access_token = "not-a-valid-token"'
check "a refused access token is refreshed after the 401 and the call retried" $SI --json whoami
[ "$(jqv .id)" = "$SID" ] && pass "the retried call answered as $SID" || fail "the retried call answered as $SID"
edit_session '.expires_at = 0'
pids=(); for i in 1 2 3 4 5 6; do $SI --json whoami >"$WORK/par.$i" 2>&1 & pids+=($!); done
par_ok=1; for pid in "${pids[@]}"; do wait "$pid" || par_ok=0; done
[ $par_ok = 1 ] && pass "six parallel commands refresh one expired token" || fail "six parallel commands refresh one expired token ($(cat "$WORK"/par.* | jq -r '.error.message? // empty' | sort -u | tr '\n' ' '))"
check "the sign-in survived the parallel refreshes" $SI --json login status
[ "$(jqv .authenticated)" = true ] && pass "still authenticated" || fail "still authenticated"

# ── library ────────────────────────────────────────────────────────────────────────────────
section "Library"
check "folder new Plans" $C1 --json folder new Plans
FPLANS=$(jqv .id)
check "folder new Q3 --in Plans" $C1 --json folder new Q3 --in Plans
FQ3=$(jqv .id)
printf '# Launch plan\n\nWe ship on Monday.\n\nThe budget is small.\n\nOpen questions remain.\n' >"$WORK/plan.md"
check "new --file --folder" $C1 --json new --title "Launch plan" --folder Plans --file "$WORK/plan.md"
DOC=$(jqv .id); DOC_URL=$(jqv .url)
[[ "$DOC" == d_* ]] && pass "doc id $DOC" || fail "doc id"
check "ls Plans" $C1 ls Plans
contains "ls shows the doc" "Launch plan"
contains "ls shows the subfolder" "Q3/"
check "tree" $C1 tree
contains "tree shows Plans" "Plans/"
check "info by title" $C1 --json info "Launch plan"
[ "$(jqv .id)" = "$DOC" ] && pass "title resolves to the id" || fail "title resolves to the id"
check "info by link" $C1 --json info "$DOC_URL"
[ "$(jqv .id)" = "$DOC" ] && pass "link resolves to the id" || fail "link resolves to the id"
check "cat" $C1 cat "$DOC"
contains "cat prints the Markdown" "We ship on Monday."
printf 'Second copy\n' | $C1 --json new --title "Launch plan" --file - >/dev/null
expect_exit 2 "an ambiguous title is an error" $C1 --json cat "Launch plan"
[ "$(jqv .error.code)" = ambiguous ] && pass "ambiguous lists the matches" || fail "ambiguous code"
DUP=$(jqv '.error.details.matches[]' | grep -v "$DOC" | head -1)
check "rename" $C1 --json rename "$DUP" "Launch plan copy"
check "mv to a folder" $C1 --json mv "$DUP" --to Plans/Q3
[ "$(jqv .folder_id)" = "$FQ3" ] && pass "moved into Q3" || fail "moved into Q3"
check "mv to the top level" $C1 --json mv "$DUP" --to /
check "copy" $C1 --json copy "$DOC" --title "Plan copy"
COPY=$(jqv .id)
check "rm (trash)" $C1 rm "$COPY"
check "ls --trash" $C1 ls --trash
contains "trash lists it" "Plan copy"
check "restore" $C1 --json restore "$COPY"
check "rm again" $C1 rm "$COPY"
expect_exit 2 "purge needs --confirm" $C1 --json purge "$COPY"
check "purge --confirm" $C1 --json purge "$COPY" --confirm
expect_exit 4 "a purged doc is gone" $C1 --json info "$COPY"
check "folder new Scratch" $C1 --json folder new Scratch
check "folder rename" $C1 --json folder rename Scratch Scratchpad
check "folder show" $C1 folder show Scratchpad
check "folder rm" $C1 folder rm Scratchpad
check "folder restore" $C1 folder restore Scratchpad
check "folder mv into Plans" $C1 --json folder mv Scratchpad --to Plans
printf 'See [[Launch plan]] for dates.\n' | $C1 --json new --title "Linker" --file - >/dev/null
sleep 3   # search and backlinks are indexed ~2 s after a change
check "backlinks" $C1 backlinks "$DOC"
contains "backlinks finds Linker" "Linker"
check "link resolves [[title]]" $C1 --json link "launch PLAN"
[ "$(jqv .id)" = "$DOC" ] && pass "link opens the plan" || fail "link opens the plan (got $(jqv .id))"
check "ls --recent" $C1 ls --recent
contains "recent lists the plan" "Launch plan"
check "search" $C1 search "budget"
contains "search finds the plan" "$DOC"

# ── sharing ────────────────────────────────────────────────────────────────────────────────
section "Sharing"
check "share the folder with the Silicon (editor)" $C1 --json share Plans "$SID" --role editor
check "members" $C1 members Plans
contains "members lists the Silicon" "$SID"
check "Silicon sees it in ls --shared" $SI ls --shared
contains "shared folder listed" "Plans/"
check "Silicon opens the doc by title through the folder" $SI --json info "Launch plan"
[ "$(jqv .role)" = editor ] && pass "Silicon's role is editor" || fail "Silicon's role is editor (got $(jqv .role))"
check "share the doc with Carbon 2 as commenter" $C1 --json share "$DOC" "$C2ID" --role commenter
check "share again changes the role" $C1 --json share "$DOC" "$C2ID" --role viewer
[ "$(jqv .role)" = viewer ] && pass "role is now viewer" || fail "role is now viewer"
check "invite by email" $C1 --json share "$DOC" "friend-$RANDOM@example.test" --role viewer
[ "$(jqv .pending)" = true ] && pass "email invite is pending" || fail "email invite is pending"
expect_exit 3 "a viewer can't edit" $C2 --json edit "$DOC" --old "Monday" --new "Friday"

# ── live co-writing ───────────────────────────────────────────────────────────────────────
section "Live co-writing"
check "context, resumable watch, guarded edits and cancellable joined presence" \
  python3 "$ROOT/crates/write-cli/e2e/live.py" --write "$WRITE" \
  --owner-home "$WORK/carbon" --silicon-home "$WORK/silicon" --viewer-home "$WORK/carbon2" \
  --api-url "$WRITE_API_URL" --output "$WORK/live-e2e"

# ── reading and editing (Silicon) ──────────────────────────────────────────────────────────
section "Editing"
check "edit --old --new" $SI --json edit "Launch plan" --old "We ship on Monday." --new "We ship on Tuesday."
SEQ_AFTER_EDIT=$(jqv .seq)
contains "edit returns the new Markdown" "Tuesday"
expect_exit 2 "no_match is exit 2" $SI --json edit "$DOC" --old "not in the doc" --new "x"
[ "$(jqv .error.code)" = no_match ] && pass "no_match code" || fail "no_match code ($(jqv .error.code))"
printf 'one\n\none\n' | $SI --json new --title "Dup words" --folder Plans --file - >/dev/null
expect_exit 2 "not_unique is exit 2" $SI --json edit "Dup words" --old "one" --new "two"
[ "$(jqv .error.code)" = not_unique ] && pass "not_unique code" || fail "not_unique code ($(jqv .error.code))"
check "edit --all" $SI --json edit "Dup words" --old "one" --new "two" --all
printf '[{"old":"The budget is small.","new":"The budget is modest."},{"old":"Open questions remain.","new":"Two questions remain."}]' >"$WORK/edits.json"
check "edit --edits FILE" $SI --json edit "$DOC" --edits "$WORK/edits.json"
check "cat shows both" $SI cat "$DOC"
contains "first edit landed" "The budget is modest."
contains "second edit landed" "Two questions remain."
check "cat --json has seq" $SI --json cat "$DOC"
BASE=$(jqv .seq)
printf '%s' "$(jqv .markdown)" | sed 's/Two questions remain./Two questions remain. We will answer them./' >"$WORK/put.md"
$C1 edit "$DOC" --old "# Launch plan" --new "# Launch plan (v2)" >/dev/null
check "put --base-seq merges with a change made after it" $SI --json put "$DOC" "$WORK/put.md" --base-seq "$BASE"
contains "put kept the other change" "Launch plan (v2)"
contains "put applied its own change" "We will answer them."
check "cat --json for a stdin put" $SI --json cat "$DOC"
BASE=$(jqv .seq)
LAST=$(jqv .markdown | sed 's/We will answer them./We will answer them soon./' | $SI --json put "$DOC" - --base-seq "$BASE" 2>&1) && pass "put - reads stdin" || fail "put - reads stdin"
contains "stdin put applied" "answer them soon."

# ── comments ───────────────────────────────────────────────────────────────────────────────
section "Comments"
check "comment --quote" $SI --json comment "$DOC" --quote "We ship on Tuesday." --body "@$CID is Tuesday ok?"
THREAD=$(jqv .id)
[[ "$THREAD" == t_* ]] && pass "thread $THREAD" || fail "thread id"
check "comments (Carbon)" $C1 comments "$DOC"
contains "Carbon sees the comment" "is Tuesday ok?"
if curl -fsS -m 2 "$TING/_tings" >/dev/null 2>&1; then
  found=0
  for _ in $(seq 1 30); do
    curl -fsS "$TING/_tings" | jq -e --arg t "$THREAD" --arg u "$CUUID" \
      '.items[] | select(.type == "write.mention.received" and .for_uuid == $u and .data.thread_id == $t)' >/dev/null && { found=1; break; }
    sleep 0.3
  done
  [ $found = 1 ] && pass "the mention reached the Carbon as a write.mention.received ting" || fail "mention ting delivered"
fi
check "reply" $C1 --json reply "$THREAD" --body "Yes, Tuesday works."
REPLY=$(jqv .id)
LAST=$(printf 'Noted, thanks.\n' | $SI --json reply "$THREAD" --body - 2>&1) && pass "reply --body - reads stdin" || fail "reply --body - reads stdin"
[ "$(jqv .body)" = "Noted, thanks." ] && pass "stdin body kept" || fail "stdin body kept (got $(jqv .body))"
check "react" $SI --json react "$REPLY" "👍"
check "comment-edit" $C1 --json comment-edit "$REPLY" --body "Yes, Tuesday works for me."
check "cat --comments" $SI cat "$DOC" --comments
contains "inline comment marker" "[!comment $THREAD"
check "resolve" $SI --json resolve "$THREAD"
[ "$(jqv .status)" = resolved ] && pass "thread resolved" || fail "thread resolved"
check "comments --all" $SI --json comments "$DOC" --all
[ "$(jqv '.threads | length')" -ge 1 ] && pass "resolved thread listed with --all" || fail "resolved thread listed with --all"
check "reopen" $C1 --json reopen "$THREAD"
[ "$(jqv .status)" = open ] && pass "thread reopened" || fail "thread reopened"
check "comment-rm" $C1 --json comment-rm "$REPLY"
expect_exit 2 "comment on missing text" $SI --json comment "$DOC" --quote "nowhere in the doc" --body "x"

# ── suggestions ────────────────────────────────────────────────────────────────────────────
section "Suggestions"
check "suggest" $SI --json suggest "$DOC" --old "The budget is modest." --new "The budget is generous."
check "suggestions" $C1 --json suggestions "$DOC"
SUG=$(jqv '.suggestions[0].id')
[ -n "$SUG" ] && [ "$SUG" != null ] && pass "suggestion listed ($SUG)" || fail "suggestion listed"
check "cat --critic" $C1 cat "$DOC" --critic
contains "critic shows the insertion" "{++"
check "cat (current) leaves it out" $C1 cat "$DOC"
contains "the doc still reads modest" "The budget is modest."
check "accept one" $C1 --json accept "$DOC" "$SUG"
check "cat after accept" $C1 cat "$DOC"
contains "accepted text is in" "generous"
check "edit --suggest" $SI --json edit "$DOC" --old "Two questions" --new "Three questions" --suggest
check "reject --all" $C1 --json reject "$DOC" --all
check "cat after reject" $C1 cat "$DOC"
lacks "rejected text is out" "Three questions"

# ── versions ───────────────────────────────────────────────────────────────────────────────
section "Versions"
check "versions" $C1 --json versions "$DOC"
NV=$(jqv '.versions | length'); OLDEST=$(jqv '.versions[-1].seq'); NEWEST=$(jqv '.versions[0].seq')
[ "${NV:-0}" -ge 2 ] && pass "$NV versions" || fail "several versions (got $NV)"
check "version DOC SEQ" $C1 version "$DOC" "$OLDEST"
contains "the oldest version reads Monday" "Monday"
check "name a version" $C1 --json name "$DOC" "$NEWEST" "Before revert"
check "versions shows the name" $C1 versions "$DOC"
contains "named version listed" "Before revert"
check "compare" $C1 compare "$DOC" "$OLDEST" "$NEWEST"
contains "compare shows the word change" "[-Mon-]{+Tues+}day"
check "copy an old version" $C1 --json copy "$DOC" --seq "$OLDEST" --title "Plan as first written"
check "the copy reads like that version" $C1 cat "Plan as first written"
contains "copy has Monday" "We ship on Monday."
check "authors" $C1 authors "$DOC"
contains "authors shows the Silicon" "$SID"
check "undo the Silicon's changes" $C1 --json undo "$DOC" --account "$SID" --since "$SEQ_AFTER_EDIT"
check "revert --blocks" $C1 --json revert "$DOC" "$OLDEST" --blocks 1..1
check "revert to the oldest version" $C1 --json revert "$DOC" "$OLDEST"
check "cat after revert" $C1 cat "$DOC"
contains "Monday is back" "We ship on Monday."
check "name --remove" $C1 --json name "$DOC" "$NEWEST" --remove
check "activity (doc)" $C1 --json activity "$DOC"
check "activity (folder)" $C1 --json activity Plans
EVENT=$(jqv '[.events[] | select(.undoable)][0].id')
if [ -n "$EVENT" ] && [ "$EVENT" != null ]; then check "undo --event" $C1 --json undo --event "$EVENT"; else fail "an undoable folder event exists"; fi

# ── pull / status / push (Silicon) ─────────────────────────────────────────────────────────
section "Pull and push"
D="$WORK/silicon-docs"
check "pull" $SI --json pull "$D"
F="$D/Shared with me/Plans/Launch plan.md"
[ -f "$F" ] && pass "shared doc pulled under Shared with me/Plans" || fail "shared doc pulled at $F ($(cd "$D" && find . -name '*.md' | head -5 | tr '\n' ' '))"
[ -f "$D/.write/state.json" ] && pass "state.json written" || fail "state.json written"
check "status is clean" $SI --json status "$D"
[ "$(jqv .clean)" = true ] && pass "clean after pull" || fail "clean after pull"
printf '\nA paragraph written locally.\n' >>"$F"
$C1 edit "$DOC" --old "The budget is" --new "Our budget is" >/dev/null
check "status sees the change (no network)" $SI --json status "$D"
[ "$(jqv '.modified | length')" = 1 ] && pass "one modified file" || fail "one modified file"
mkdir -p "$D/Shared with me/Plans/Ideas"
printf '# Idea\n\nMade by the Silicon in a file.\n' >"$D/Shared with me/Plans/Ideas/Idea.md"
printf '# Mine\n\nThe Silicon own doc.\n' >"$D/Mine.md"
check "push" $SI --json push "$D"
[ "$(jqv '.pushed | length')" = 1 ] && pass "one doc pushed" || fail "one doc pushed"
[ "$(jqv '.created | length')" = 2 ] && pass "two docs created" || fail "two docs created"
grep -q "Our budget is" "$F" && pass "file refreshed with the Carbon's change" || fail "file refreshed with the Carbon's change"
grep -q "A paragraph written locally." "$F" && pass "local change kept" || fail "local change kept"
check "Carbon sees the Silicon's paragraph" $C1 cat "$DOC"
contains "remote doc has the local paragraph" "A paragraph written locally."
check "the new doc in the shared folder belongs to the folder's owner" $C1 --json info "Idea"
[ "$(jqv .owner.id)" = "$CID" ] && pass "owner is $CID" || fail "owner is $CID (got $(jqv .owner.id))"
[ "$(jqv .created_by.id)" = "$SID" ] && pass "created by $SID" || fail "created by $SID (got $(jqv .created_by.id))"
check "status clean after push" $SI --json status "$D"
[ "$(jqv .clean)" = true ] && pass "clean after push" || fail "clean after push"
mv "$D/Mine.md" "$D/Mine renamed.md"
check "push a renamed file" $SI --json push "$D"
[ "$(jqv '.renamed | length')" = 1 ] && pass "rename pushed" || fail "rename pushed"
check "doc was renamed" $SI --json info "Mine renamed"
rm "$D/Mine renamed.md"
check "push a deleted file" $SI --json push "$D"
[ "$(jqv '.deleted_locally | length')" = 1 ] && pass "deletion only reported" || fail "deletion only reported"
check "the doc still exists" $SI --json info "Mine renamed"
check "pull brings it back" $SI --json pull "$D"
[ -f "$D/Mine renamed.md" ] && pass "deleted file restored by pull" || fail "deleted file restored by pull"
printf '\nLocal edit.\n' >>"$F"
$C1 edit "$DOC" --old "Our budget is" --new "The team budget is" >/dev/null
expect_exit 5 "pull reports a conflict instead of overwriting" $SI --json pull "$D"
grep -q "Local edit." "$F" && pass "local change untouched" || fail "local change untouched"
check "pull --force takes Silicon Write's version" $SI --json pull "$D" --force
grep -q "Local edit." "$F" && fail "forced pull replaced the file" || pass "forced pull replaced the file"
printf '# Same\n' | $C1 --json new --title "Twin" --folder Plans --file - >/dev/null
printf '# Same again\n' | $C1 --json new --title "Twin" --folder Plans --file - >/dev/null
check "pull with duplicate titles" $SI --json pull "$D"
[ -f "$D/Shared with me/Plans/Twin.md" ] && [ -f "$D/Shared with me/Plans/Twin (2).md" ] && pass "duplicates get (2)" || fail "duplicates get (2)"
printf '\nSuggested from a file.\n' >>"$F"
check "push --suggest" $SI --json push "$D" --suggest
[ "$(jqv '.pushed[0].suggested')" = true ] && pass "pushed as a suggestion" || fail "pushed as a suggestion"
grep -q "Suggested from a file." "$F" && fail "file shows the doc as it reads (suggestion pending)" || pass "file shows the doc as it reads (suggestion pending)"
check "the suggestion is listed" $C1 --json suggestions "$DOC"
jqv '.suggestions[].inserted' | grep -q "Suggested from a file." && pass "suggestion carries the file's text" || fail "suggestion carries the file's text"
check "accept --all" $C1 --json accept "$DOC" --all
check "pull after accepting" $SI --json pull "$D"
grep -q "Suggested from a file." "$F" && pass "accepted suggestion pulled" || fail "accepted suggestion pulled"
check "Carbon pulls too" $C1 --json pull "$WORK/carbon-docs"
[ -f "$WORK/carbon-docs/Plans/Launch plan.md" ] && pass "own docs by folder" || fail "own docs by folder"

# ── import / export / images / public ──────────────────────────────────────────────────────
section "Formats and public links"
printf '<h1>Web page</h1><p>Hello <u>underlined</u>.</p>' >"$WORK/page.html"
check "import .html" $C1 --json import "$WORK/page.html" --title "From HTML"
HTMLDOC=$(jqv .id)
check "import .md into a folder" $C1 --json import "$WORK/plan.md" --folder Plans --title "Imported plan"
check "import --into (next version)" $C1 --json import "$WORK/plan.md" --into "$HTMLDOC"
for fmt in md txt html docx doc odt rtf pdf; do
  check "export $fmt" $C1 --json export "$DOC" --format $fmt -o "$WORK/out.$fmt"
  [ -s "$WORK/out.$fmt" ] && pass "out.$fmt is not empty" || fail "out.$fmt is not empty"
done
check "import a PDF" $C1 --json import "$WORK/out.pdf" --title "As PDF"
PDFDOC=$(jqv .id)
[ "$(jqv .kind)" = pdf ] && pass "a PDF opens as a pdf doc" || fail "a PDF opens as a pdf doc (kind $(jqv .kind))"
check "original" $C1 --json original "$PDFDOC" -o "$WORK/original.pdf"
cmp -s "$WORK/out.pdf" "$WORK/original.pdf" && pass "original is the uploaded file" || fail "original is the uploaded file"
check "comment on an area of a PDF page" $C1 --json comment "$PDFDOC" --page 1 --rect 0.1,0.1,0.5,0.2 --body "This area?"
[ "$(jqv .anchor.kind)/$(jqv .anchor.rect.page)" = "pdf/1" ] && pass "PDF anchor kept the page and area" || fail "PDF anchor kept the page and area"
check "convert" $C1 --json convert "$PDFDOC"
[ "$(jqv .kind)" = doc ] && pass "converted to a doc" || fail "converted to a doc (kind $(jqv .kind))"
check "cat the converted doc" $C1 cat "$PDFDOC"
check "export an old version to stdout" $C1 export "$DOC" --format md --seq "$OLDEST" -o -
contains "old version exported" "Monday"
python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))" "$WORK/dot.png"
check "image upload" $SI --json image "$DOC" "$WORK/dot.png"
ASSET=$(jqv .id)
check "asset download" $SI --json asset "$ASSET" -o "$WORK/dot-back.png"
cmp -s "$WORK/dot.png" "$WORK/dot-back.png" && pass "image round-trips" || fail "image round-trips"
expect_exit "3|4" "a private doc needs a sign-in" $ANON --json cat "$DOC"
check "public --access view" $C1 --json public "$DOC" --access view
check "anyone can read a public doc without signing in" $ANON cat "$DOC"
contains "anonymous read works" "Launch plan"
check "public --access none" $C1 --json public "$DOC" --access none
expect_exit "3|4" "private again" $ANON --json cat "$DOC"

# ── transfers and unsharing ────────────────────────────────────────────────────────────────
section "Transfers"
printf '# Gift\n' | $SI --json new --title "Gift" --file - >/dev/null
check "transfer" $SI --json transfer "Gift" "$CID"
XFER=$(jqv .id)
check "transfers (Carbon)" $C1 transfers
contains "incoming transfer listed" "Gift"
check "transfers accept" $C1 --json transfers accept "$XFER"
check "the Carbon owns it now" $C1 --json info "Gift"
[ "$(jqv .owner.id)" = "$CID" ] && pass "owner changed" || fail "owner changed"
printf '# Gift 2\n' | $SI --json new --title "Gift 2" --file - >/dev/null
check "transfer then cancel" $SI --json transfer "Gift 2" "$CID"
check "transfers cancel" $SI --json transfers cancel "$(jqv .id)"
check "unshare" $C1 --json unshare Plans "$SID"
expect_exit 4 "the Silicon lost access" $SI --json info "$DOC"

# ── sign out ───────────────────────────────────────────────────────────────────────────────
section "Sign out"
check "logout (Silicon)" $SI --json logout
[ "$(jqv .revoked)" = true ] && pass "sign-in revoked at Silicon Accounts" || fail "sign-in revoked"
check "status after logout" $SI --json login status
[ "$(jqv .authenticated)" = false ] && pass "signed out" || fail "signed out"
check "logout (Carbon 1)" $C1 --json logout
check "logout (Carbon 2)" $C2 --json logout

printf '\n%d checks passed, %d failed.\n' "$PASS" "${#FAILED[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  printf 'Failed:\n'; printf '  - %s\n' "${FAILED[@]}"
  [ -n "${KEEP:-}" ] && echo "State kept in $WORK"
  exit 1
fi
