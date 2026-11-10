#!/usr/bin/env bash
# Checks that securevideocall.com and its signaling server answer, and opens or closes the
# downtime issue (.github/workflows/uptime.yml). Each URL gets three tries 30 s apart, so a single
# slow answer is not an alert. Reads only public URLs; writes no personal data anywhere.
#
# Needs: curl, gh (with GH_TOKEN and GH_REPO set). Optional: RUN_URL (linked in the issue),
# UPTIME_DRY_RUN=1 (print what it would do on the issue, change nothing),
# UPTIME_RETRY_SECONDS (default 30).
set -uo pipefail

readonly ISSUE_TITLE='Uptime: securevideocall.com is down'
readonly RETRY_SECONDS="${UPTIME_RETRY_SECONDS:-30}"
# Each check: a URL and text its body must contain (so a hosting error page does not count).
readonly CHECKS=(
  'https://securevideocall.com/|<div id="root"></div>'
  'https://signal.securevideocall.com/healthz|{"status": "ok"}'
)

answers_correctly() {
  local url="$1" expected_text="$2" attempt body
  for attempt in 1 2 3; do
    if body="$(curl -fsS --proto '=https' --max-time 20 "$url" 2>/dev/null)" &&
      [[ "$body" == *"$expected_text"* ]]; then
      return 0
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

now="$(date -u +%Y-%m-%dT%H:%MZ)"
run_note=''
if [ -n "${RUN_URL:-}" ]; then run_note=" ([run]($RUN_URL))"; fi

# The open downtime issue, if any: exact title match, not just a search hit.
open_issue_number="$(gh issue list --state open --search "in:title \"$ISSUE_TITLE\"" \
  --json number,title --jq "map(select(.title == \"$ISSUE_TITLE\")) | .[0].number // empty")" || {
  echo "Could not read the issues."
  exit 1
}

run_or_print() {
  if [ "${UPTIME_DRY_RUN:-0}" = 1 ]; then
    echo "DRY RUN: $*"
  else
    "$@"
  fi
}

if [ "${#failed_urls[@]}" -gt 0 ]; then
  if [ -z "$open_issue_number" ]; then
    body="Not answering since $now$run_note, after three tries 30 s apart:"$'\n'
    for url in "${failed_urls[@]}"; do body+=$'\n'"- $url"; done
    body+=$'\n\n'"This issue closes itself when everything answers again. If only the signaling server is down, check the proxy on the Pi Zero first."
    run_or_print gh issue create --title "$ISSUE_TITLE" --body "$body" || exit 1
  else
    echo "Still down; issue #$open_issue_number is already open."
  fi
elif [ -n "$open_issue_number" ]; then
  run_or_print gh issue close "$open_issue_number" --comment "Everything answers again at $now$run_note." || exit 1
fi
exit 0
