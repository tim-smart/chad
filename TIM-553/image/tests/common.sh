# Shared by every test. Each test sets T to its name.
IMG=${IMG:-chad:proto}
LOGS=~/logs
R=$LOGS/results.txt
mkdir -p $LOGS
short() { echo "$1" | tr '\n' ' ' | sed 's/  */ /g' | head -c ${2:-260}; }
pass() { echo "PASS  [$T]  $1${2:+  ($(short "$2"))}" | tee -a $R; }
fail() { echo "FAIL  [$T]  $1${2:+  ($(short "$2" 500))}" | tee -a $R; }
note() { echo "NOTE  [$T]  $1${2:+  ($(short "$2" 400))}" | tee -a $R; }
# expect <description> <actual> <extended regex>
expect() { if echo "$2" | tr '\n' ' ' | sed 's/ *$//' | grep -Eq -- "$3"; then pass "$1" "$2"; else fail "$1" "wanted /$3/, got: $2"; fi; }
# refute <description> <actual> <extended regex>
refute() { if echo "$2" | tr '\n' ' ' | sed 's/ *$//' | grep -Eq -- "$3"; then fail "$1" "did not want /$3/, got: $2"; else pass "$1" "$2"; fi; }
clean() {
  docker rm -f $(docker ps -aq --filter name=chadt-) >/dev/null 2>&1
  docker volume rm -f $(docker volume ls -q --filter name=chadt-) >/dev/null 2>&1
  true
}
# wait_phase <container> <phase> [tries of 0.2 s]
wait_phase() {
  local i
  for i in $(seq 1 ${3:-150}); do
    docker exec chadt-$1 chad status 2>/dev/null | grep -q "phase: $2" && return 0
    sleep 0.2
  done
  return 1
}
now_ms() { date +%s%3N; }
# ev_ms <container> <event>: epoch ms of the first log line with that event
ev_ms() { docker logs chadt-$1 2>/dev/null | grep "\"ev\":\"$2\"" | head -1 | sed 's/.*"t":"\([^"]*\)".*/\1/' | xargs -I{} date -d {} +%s%3N; }
ev() { docker logs chadt-$1 2>/dev/null | grep "\"ev\":\"$2\"" | head -1; }
# start <name> [docker run options...]: a container on a fresh named volume
start() { local n=$1; shift; docker run -d --name chadt-$n -v chadt-$n:/data "$@" $IMG >/dev/null; }
x() { local n=$1; shift; docker exec chadt-$n "$@" 2>&1; }
touch $R; sed -i "/\[$T\]/d; /^## $T\$/d" $R
echo "## $T" >> $R
clean
