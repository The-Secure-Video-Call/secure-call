#!/usr/bin/env bash
# Checks that securevideocall.com, its signaling server and its TURN server answer, and opens or
# closes the downtime issue (.github/workflows/uptime.yml). Each check gets three tries,
# RETRY_SECONDS apart, so a single slow answer is not an alert. A second issue opens when the TURN
# certificate expires within 21 days (scripts/check-turn.mjs). Reads only public endpoints; writes
# no personal data anywhere.
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
# it prints are described at the top of check-turn.mjs. If the check itself breaks (exit code not
# 0), that is no evidence about TURN: the issues are left as they are and the run fails, so
# GitHub reports a failed workflow instead.
certificate_state='unknown'
certificate_days=''
turn_check_broke=0
turn_output="$(node "$SCRIPT_DIR/check-turn.mjs")"
turn_status=$?
if [ -n "$turn_output" ]; then printf '%s\n' "$turn_output"; fi
if [ "$turn_status" -ne 0 ]; then
  echo "The TURN check did not run (exit code $turn_status)."
  turn_check_broke=1
else
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
sync_issue() {
  local title="$1" failing="$2" body="$3" close_comment="$4" open_numbers issue_number
  open_numbers="$(open_issues_titled "$title")" || {
    echo "Could not read the issues."
    return 1
  }
  if [ "$failing" = 1 ]; then
    if [ -z "$open_numbers" ]; then
      run_or_print gh issue create --title "$title" --body "$body" || return 1
    else
      echo "Still failing; issue #${open_numbers%%$'\n'*} is already open."
    fi
  else
    for issue_number in $open_numbers; do
      run_or_print gh issue close "$issue_number" --comment "$close_comment" || return 1
    done
  fi
}

# The downtime issue. While the TURN check is broken, TURN's state is unknown: a failing URL can
# still open the issue, but it is never closed on the strength of the URLs alone.
down=0
down_body=''
if [ "${#failed_urls[@]}" -gt 0 ]; then
  down=1
  down_body="Detected at $now$run_note, after three tries $RETRY_SECONDS s apart:"$'\n'
  for url in "${failed_urls[@]}"; do down_body+=$'\n'"- $url"; done
  down_body+=$'\n\n'"This issue closes itself when everything answers again. If only the signaling server is down, check the proxy on the Pi Zero first. If only TURN is down, check coturn on the Pi 5 (\`docker compose ps coturn\`) and the router's forwards for 3478 and 5349."
fi
if [ "$down" = 1 ] || [ "$turn_check_broke" = 0 ]; then
  sync_issue "$ISSUE_TITLE" "$down" "$down_body" "Everything answers again at $now$run_note." || exit 1
fi

# The certificate issue: changed only when the TLS handshake told us the expiry date.
if [ "$certificate_state" != 'unknown' ]; then
  expiring=0
  if [ "$certificate_state" = 'soon' ]; then expiring=1; fi
  certificate_body="Detected at $now$run_note: the certificate served on turn.securevideocall.com:5349 expires in $certificate_days days."$'\n\n'"Nginx Proxy Manager renews it 30 days ahead, and the Pi 5 refreshes coturn's copy twice a day (secure-call-backend#91), so one of those has stopped. On the Pi 5: \`systemctl status secure-call-turn-certificate.timer\` and \`journalctl -u secure-call-turn-certificate.service\`; in Nginx Proxy Manager, the certificate's renewal. This issue closes itself once a certificate with 21 or more days left is served."
  sync_issue "$CERTIFICATE_ISSUE_TITLE" "$expiring" "$certificate_body" \
    "A certificate with $certificate_days days left is served at $now$run_note." || exit 1
fi

if [ "$turn_check_broke" = 1 ]; then exit 1; fi
exit 0
