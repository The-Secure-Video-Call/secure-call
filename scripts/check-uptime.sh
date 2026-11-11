#!/usr/bin/env bash
# Checks that securevideocall.com and its signaling server answer, and opens or closes the
# downtime issue (.github/workflows/uptime.yml). Each URL gets three tries, RETRY_SECONDS apart,
# so a single slow answer is not an alert. Reads only public URLs; writes no personal data anywhere.
#
# Needs: curl, gh (with GH_TOKEN and GH_REPO set). Optional: RUN_URL (linked in the issue),
# UPTIME_DRY_RUN=1 (print what it would do on the issue, change nothing),
# UPTIME_RETRY_SECONDS (default 30).
set -uo pipefail

readonly ISSUE_TITLE='Uptime: securevideocall.com is down'
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

now="$(date -u +%Y-%m-%dT%H:%MZ)"
run_note=''
if [ -n "${RUN_URL:-}" ]; then run_note=" ([run]($RUN_URL))"; fi

# Our open downtime issues, newest first (normally one; a second can slip in while search
# indexing lags). Exact title and author match, not just a search hit.
open_issue_numbers="$(gh issue list --state open \
  --search "in:title \"$ISSUE_TITLE\" author:$ISSUE_AUTHOR" --json number,title,author \
  --jq "map(select(.title == \"$ISSUE_TITLE\" and .author.login == \"$ISSUE_AUTHOR\")) | .[].number")" || {
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
  if [ -z "$open_issue_numbers" ]; then
    body="Detected at $now$run_note, after three tries $RETRY_SECONDS s apart:"$'\n'
    for url in "${failed_urls[@]}"; do body+=$'\n'"- $url"; done
    body+=$'\n\n'"This issue closes itself when everything answers again. If only the signaling server is down, check the proxy on the Pi Zero first."
    run_or_print gh issue create --title "$ISSUE_TITLE" --body "$body" || exit 1
  else
    echo "Still down; issue #${open_issue_numbers%%$'\n'*} is already open."
  fi
else
  for issue_number in $open_issue_numbers; do
    run_or_print gh issue close "$issue_number" --comment "Everything answers again at $now$run_note." || exit 1
  done
fi
exit 0
