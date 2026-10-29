#!/bin/sh
# Keeps a Docker Closedhand up to date by itself, as the Mac app keeps itself.
# install.sh runs this once a day (a LaunchAgent on a Mac, cron elsewhere; a
# computer asleep at that hour runs it on waking). It looks for newer code and
# images and, when there are any, waits until Closedhand is between replies and
# runs install.sh again: the same update a person would run by hand, which also
# clears out the replaced images. A Closedhand someone has stopped is left
# stopped. The last run's output is in update.log, beside install.sh.
set -u
cd "$(dirname "$0")/.." || exit 1
exec > update.log 2>&1
date

docker info >/dev/null 2>&1 || { echo "Docker isn't running. Trying again tomorrow."; exit 0; }
running=$(docker compose ps -q 2>/dev/null)
[ -n "$running" ] || { echo "Closedhand isn't running, so it is left as it is."; exit 0; }

# Newer code: fetched now, put in place only once it is going in. Local edits
# are left alone, as install.sh leaves them.
code=0
if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null && git fetch -q 2>/dev/null; then
  head=$(git rev-parse HEAD 2>/dev/null)
  upstream=$(git rev-parse '@{u}' 2>/dev/null)
  if [ -n "$upstream" ] && [ "$head" != "$upstream" ] && git merge-base --is-ancestor HEAD '@{u}' 2>/dev/null; then code=1; fi
fi

# Newer images: pulled now, so the restart below is quick. A container running
# on anything but its image's newest pull is behind. A pull whose connection
# dropped can hang for good, and this job never starts again while it runs, so
# a pull gets three hours; layers it finished are kept for tomorrow's.
# A connection lost for a moment (a name that didn't resolve) is common at
# home, so a failed pull is tried once more a minute later.
pulled=0
for attempt in 1 2; do
  docker compose pull -q &
  pull=$!
  ( trap 'kill $! 2>/dev/null; exit 0' TERM; sleep 10800 & wait $!; kill "$pull" 2>/dev/null ) &
  limit=$!
  if wait "$pull"; then kill "$limit" 2>/dev/null; pulled=1; break; fi
  kill "$limit" 2>/dev/null
  [ "$attempt" = 2 ] || sleep 60
done
[ "$pulled" = 1 ] || { echo "Couldn't fetch the images. Trying again tomorrow."; exit 0; }
images=0
for c in $running; do
  ref=$(docker inspect --format '{{.Config.Image}}' "$c" 2>/dev/null) || continue
  [ "$(docker inspect --format '{{.Image}}' "$c")" = "$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null)" ] || images=1
done

if [ "$code" = 0 ] && [ "$images" = 0 ]; then echo "Already the newest."; exit 0; fi

# Between replies: the bot's health says when it is busy, looked at once a
# minute for up to an hour. A bot that doesn't answer isn't busy, and an update
# may be what it needs.
port=$(sed -n 's/^BOT_PORT=\([0-9][0-9]*\).*/\1/p' .env 2>/dev/null | tail -n 1)
waited=0
while curl -fsS --max-time 5 "http://127.0.0.1:${port:-3001}/health" 2>/dev/null | grep -q '"busy": *true'; do
  if [ "$waited" -ge 60 ]; then echo "Busy for an hour. Trying again tomorrow."; exit 0; fi
  sleep 60
  waited=$((waited + 1))
done

[ "$code" = 0 ] || git merge -q --ff-only '@{u}' || echo "Couldn't put the new code in place; updating the images."
CLOSEDHAND_PLAIN=1 CLOSEDHAND_NO_OPEN=1 sh install.sh
