#!/usr/bin/env bash
# Checks that securevideocall.com, its signaling server and its TURN server answer, and opens or
# closes the downtime issue (.github/workflows/uptime.yml). Each check gets three tries,
# RETRY_SECONDS apart, so a single slow answer is not an alert. A second issue opens when the TURN
# certificate expires within 21 days (scripts/check-turn.mjs). Reads only public endpoints; writes
# no personal data anywhere. The issues name roles ("the main Pi"), not machines, as the
# repository is public (docs/architecture.md).
#
# Needs: curl, node, gh (with GH_TOKEN and GH_REPO set). Optional: RUN_URL (linked in the issue),
# UPTIME_DRY_RUN=1 (print what it would do on the issues, change nothing),
# UPTIME_RETRY_SECONDS (default 30).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly ISSUE_TITLE='Uptime: securevideocall.com is down'
readonly CERTIFICATE_ISSUE_TITLE='Uptime: the TURN certificate expires within 21 days'
# Only issues this workflow opened count: the repository is public, so anyone can open an issue
# with the same title, and that must not hide an outage or be closed by us.
readonly ISSUE_AUTHOR='app/github-actions'
readonly RETRY_SECONDS="${UPTIME_RETRY_SECONDS:-30}"
# Each check: a URL and text its body must contain (so a hosting error page does not count).
readonly CHECKS=(
  'https://securevideocall.com/|<div id="root"></div>'
  'https://signal.securevideocall.com/healthz|{"status": "ok"}'
)
# The two targets check-turn.mjs must report, each exactly once.
readonly TURN_TARGETS=(
  'turn:turn.securevideocall.com:3478'
  'turns:turn.securevideocall.com:5349'
)
readonly HELP_URL='https://github.com/The-Secure-Video-Call/secure-call-backend/blob/main/deploy/raspberry-pi/README.md#turn'

# TURN runs in the background while the URLs are checked, so the worst case (every check
# timing out on every try) stays well inside the job's timeout.
turn_output_file="$(mktemp)"
trap 'rm -f "$turn_output_file"' EXIT
node "$SCRIPT_DIR/check-turn.mjs" >"$turn_output_file" &
turn_pid=$!

# curl's own error (DNS, TLS, timeout, HTTP status) goes to the log; it names only our URLs.
answers_correctly() {
  local url="$1" expected_text="$2" attempt body
  for attempt in 1 2 3; do
    if body="$(curl -q -fsS --proto '=https' --max-time 20 "$url")"; then
      if [[ "$body" == *"$expected_text"* ]]; then return 0; fi
      echo "try $attempt: $url answered without the expected text"
    fi
    if [ "$attempt" -lt 3 ]; then sleep "$RETRY_SECONDS"; fi
  done
  return 1
}

failed_urls=()
for check in "${CHECKS[@]}"; do
  url="${check%%|*}"
  expected_text="${check#*|}"
  if answers_correctly "$url" "$expected_text"; then
    echo "up:   $url"
  else
    echo "DOWN: $url"
    failed_urls+=("$url")
  fi
done

# TURN: STUN over UDP on 3478 and over TLS on 5349, and the certificate's days left. The lines
# it prints are described at the top of check-turn.mjs. If the check broke (a non-zero exit, or
# not exactly one result line per target), that is no evidence about TURN: the issues are left
# as they are, except that a failing URL can still open the downtime issue, and the run fails, so
# GitHub reports a failed workflow instead.
wait "$turn_pid"
turn_status=$?
turn_output="$(cat "$turn_output_file")"
if [ -n "$turn_output" ]; then printf '%s\n' "$turn_output"; fi
turn_check_broke=0
if [ "$turn_status" -ne 0 ]; then
  echo "The TURN check did not run (exit code $turn_status)."
  turn_check_broke=1
else
  for target in "${TURN_TARGETS[@]}"; do
    count="$(grep -c -E "^(up:   |DOWN: )${target//./\\.} " <<<"$turn_output")"
    if [ "$count" != 1 ]; then
      echo "The TURN check reported $target $count times instead of once."
      turn_check_broke=1
    fi
  done
fi

certificate_state='unknown'
certificate_days=''
if [ "$turn_check_broke" = 0 ]; then
  while IFS= read -r line; do
    case "$line" in
      'DOWN: '*)
        target="${line#DOWN: }"
        failed_urls+=("${target%% *}")
        ;;
      'certificate ok: '*)
        certificate_state='ok'
        certificate_days="${line#certificate ok: }"
        certificate_days="${certificate_days%% *}"
        ;;
      'CERTIFICATE EXPIRES SOON: '*)
        certificate_state='soon'
        certificate_days="${line#CERTIFICATE EXPIRES SOON: }"
        certificate_days="${certificate_days%% *}"
        ;;
    esac
  done <<<"$turn_output"
fi

now="$(date -u +%Y-%m-%dT%H:%MZ)"
run_note=''
if [ -n "${RUN_URL:-}" ]; then run_note=" ([run]($RUN_URL))"; fi

run_or_print() {
  if [ "${UPTIME_DRY_RUN:-0}" = 1 ]; then
    echo "DRY RUN: $*"
  else
    "$@"
  fi
}

# Our open issues with this exact title, newest first (normally one; a second can slip in while
# search indexing lags). Exact title and author match, not just a search hit.
open_issues_titled() {
  local title="$1"
  gh issue list --state open \
    --search "in:title \"$title\" author:$ISSUE_AUTHOR" --json number,title,author \
    --jq "map(select(.title == \"$title\" and .author.login == \"$ISSUE_AUTHOR\")) | .[].number"
}

# Opens the issue if something fails and none is open; closes every open one once nothing does.
# While one is open, ADD_TO_OPEN_ISSUE (a function name, or empty) reports what is new.
sync_issue() {
  local title="$1" failing="$2" body="$3" close_comment="$4" add_to_open_issue="$5"
  local open_numbers issue_number
  open_numbers="$(open_issues_titled "$title")" || {
    echo "Could not read the issues."
    return 1
  }
  if [ "$failing" = 1 ]; then
    if [ -z "$open_numbers" ]; then
      run_or_print gh issue create --title "$title" --body "$body" || return 1
    else
      issue_number="${open_numbers%%$'\n'*}"
      echo "Still failing; issue #$issue_number is already open."
      if [ -n "$add_to_open_issue" ]; then "$add_to_open_issue" "$issue_number" || return 1; fi
    fi
  else
    for issue_number in $open_numbers; do
      run_or_print gh issue close "$issue_number" --comment "$close_comment" || return 1
    done
  fi
}

# A target that fails while the downtime issue is already open would otherwise go unnoticed:
# comment (which notifies the watchers) and add it to the issue's body, which only this workflow
# and the maintainers can edit, so outsiders' comments can never mark a target as reported.
add_new_failures_to_issue() {
  local issue_number="$1" issue_body new_targets=() url comment
  issue_body="$(gh issue view "$issue_number" --json body --jq .body)" || {
    echo "Could not read issue #$issue_number."
    return 1
  }
  for url in "${failed_urls[@]}"; do
    if ! grep -qxF -- "- $url" <<<"$issue_body"; then new_targets+=("$url"); fi
  done
  if [ "${#new_targets[@]}" -eq 0 ]; then return 0; fi
  comment="Also failing since $now$run_note:"$'\n'
  for url in "${new_targets[@]}"; do
    comment+=$'\n'"- $url"
    issue_body+=$'\n'"- $url"
  done
  run_or_print gh issue comment "$issue_number" --body "$comment" || return 1
  run_or_print gh issue edit "$issue_number" --body "$issue_body" || return 1
}

# The downtime issue. While the TURN check is broken, TURN's state is unknown: a failing URL can
# still open the issue, but it is never closed on the strength of the URLs alone.
down=0
down_body=''
if [ "${#failed_urls[@]}" -gt 0 ]; then
  down=1
  down_body="Detected at $now$run_note, after three tries $RETRY_SECONDS s apart:"$'\n'
  for url in "${failed_urls[@]}"; do down_body+=$'\n'"- $url"; done
  down_body+=$'\n\n'"This issue closes itself when everything answers again; targets that fail later are added below. If only the signaling server is down, check the proxy machine first. If only TURN is down, check coturn on the main Pi and the router's forwards for 3478 and 5349 ([TURN setup]($HELP_URL))."
fi
if [ "$down" = 1 ] || [ "$turn_check_broke" = 0 ]; then
  sync_issue "$ISSUE_TITLE" "$down" "$down_body" "Everything answers again at $now$run_note." \
    add_new_failures_to_issue || exit 1
fi

# The certificate issue: changed only when coturn's own TLS answer told us the expiry date.
if [ "$certificate_state" != 'unknown' ]; then
  expiring=0
  if [ "$certificate_state" = 'soon' ]; then expiring=1; fi
  certificate_body="Detected at $now$run_note: the certificate served on turn.securevideocall.com:5349 expires in $certificate_days days."$'\n\n'"Nginx Proxy Manager renews it 30 days ahead, and the main Pi refreshes coturn's copy twice a day, so one of those has stopped: see the certificate refresh in the [TURN setup]($HELP_URL). This issue closes itself once a certificate with 21 or more days left is served."
  sync_issue "$CERTIFICATE_ISSUE_TITLE" "$expiring" "$certificate_body" \
    "A certificate with $certificate_days days left is served at $now$run_note." '' || exit 1
fi

if [ "$turn_check_broke" = 1 ]; then exit 1; fi
exit 0
