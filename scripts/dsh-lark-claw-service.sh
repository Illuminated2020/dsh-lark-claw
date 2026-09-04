#!/usr/bin/env bash

# Small deployment adapter for a long-lived `dsh --profile feishu` process.
# It owns only the supervisor lifecycle; Gateway State and Session JSONL remain
# in the configured DSH_HOME / workspace directories.

set -euo pipefail

SERVICE_ROOT="${DSH_LARK_CLAW_SERVICE_ROOT:-${DSH_FEISHU_SERVICE_ROOT:-${PWD}/.dsh-lark-claw}}"
PID_FILE="${DSH_LARK_CLAW_PID_FILE:-${DSH_FEISHU_PID_FILE:-${SERVICE_ROOT}/lark-claw.pid}}"
LOG_FILE="${DSH_LARK_CLAW_LOG_FILE:-${DSH_FEISHU_LOG_FILE:-${SERVICE_ROOT}/lark-claw.log}}"
RESTART_DELAY="${DSH_LARK_CLAW_RESTART_DELAY_SECONDS:-${DSH_FEISHU_RESTART_DELAY_SECONDS:-5}}"
DSH_BIN="${DSH_BIN:-dsh}"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

is_running() {
  [[ -s "${PID_FILE}" ]] || return 1
  local pid
  pid="$(<"${PID_FILE}")"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  local command
  command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  [[ "${command}" == *"${SCRIPT_NAME} run"* ]]
}

read_pid() {
  [[ -s "${PID_FILE}" ]] || return 1
  cat "${PID_FILE}"
}

run_supervisor() {
  local stopping=0
  local child_pid=''

  on_signal() {
    stopping=1
    if [[ -n "${child_pid}" ]]; then
      kill -TERM "${child_pid}" 2>/dev/null || true
    fi
  }
  trap on_signal INT TERM
  printf '%s\n' "$$" >"${PID_FILE}"

  while (( stopping == 0 )); do
    "${DSH_BIN}" --profile feishu &
    child_pid="$!"
    set +e
    wait "${child_pid}"
    local exit_code="$?"
    set -e
    child_pid=''
    (( stopping == 1 )) && break
    printf '%s dsh exited with code %s; restarting in %ss\n' "$(date -Is)" "${exit_code}" "${RESTART_DELAY}"
    sleep "${RESTART_DELAY}" &
    local sleeper="$!"
    wait "${sleeper}" || true
  done

  rm -f "${PID_FILE}"
}

start() {
  if is_running; then
    printf 'dsh-lark-claw service is already running (pid %s)\n' "$(read_pid)"
    return 0
  fi
  mkdir -p "${SERVICE_ROOT}"
  nohup "${BASH_SOURCE[0]}" run >>"${LOG_FILE}" 2>&1 < /dev/null &
  local pid="$!"
  printf '%s\n' "${pid}" >"${PID_FILE}"
  sleep 1
  if ! is_running; then
    printf 'dsh-lark-claw service failed to start; inspect %s\n' "${LOG_FILE}" >&2
    return 1
  fi
  printf 'dsh-lark-claw service started (pid %s)\n' "${pid}"
}

stop() {
  if ! is_running; then
    rm -f "${PID_FILE}"
    printf 'dsh-lark-claw service is not running\n'
    return 0
  fi
  local pid
  pid="$(read_pid)"
  kill -TERM "${pid}"
  for _ in {1..30}; do
    is_running || { printf 'dsh-lark-claw service stopped\n'; return 0; }
    sleep 1
  done
  if is_running; then
    kill -KILL "${pid}" 2>/dev/null || true
    rm -f "${PID_FILE}"
    printf 'dsh-lark-claw service stopped forcefully after graceful shutdown timed out\n'
  else
    printf 'dsh-lark-claw service stopped\n'
  fi
}

status() {
  if is_running; then
    printf 'dsh-lark-claw service is running (pid %s)\n' "$(read_pid)"
  else
    printf 'dsh-lark-claw service is stopped\n'
    return 1
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status) status ;;
  logs) exec tail -f "${LOG_FILE}" ;;
  run) run_supervisor ;;
  *) printf 'usage: %s {start|stop|restart|status|logs}\n' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac
