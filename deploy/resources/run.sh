#!/usr/bin/env bash
# Operator-only: no connection is opened until the caller supplies a psql command.
set -euo pipefail
umask 077
mode=${1:-}
case "$mode" in inspect|activate|verify) ;; *) echo 'Usage: run.sh inspect|activate|verify -- <psql command>' >&2; exit 2;; esac
shift
if [[ ${1:-} == -- ]]; then shift; fi
if [[ $# == 0 ]]; then echo 'Supply the reviewed DEV psql command.' >&2; exit 2; fi
operator_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
args=(-X -q -A -t -v ON_ERROR_STOP=1)
for pair in \
 'organization_id:DAYOTTER_ORG_ID' \
 'energy_service_id:DAYOTTER_ENERGY_SERVICE_ID' \
 'light_service_id:DAYOTTER_LIGHT_SERVICE_ID' \
 'pemf_service_id:DAYOTTER_PEMF_SERVICE_ID' \
 'light_resource_id:DAYOTTER_LIGHT_RESOURCE_ID' \
 'pemf_resource_id:DAYOTTER_PEMF_RESOURCE_ID'; do
  key=${pair%%:*}; variable=${pair#*:}; value=${!variable:-}
  if [[ ! $value =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "$variable must be the exact reviewed UUID." >&2; exit 2
  fi
  args+=(-v "$key=$value")
done
for role in LIGHT PEMF; do
  variable="DAYOTTER_${role}_REQUIRES_HOST"; value=${!variable:-false}
  if [[ $value != true && $value != false ]]; then echo "$variable must be true or false." >&2; exit 2; fi
  key=${role,,}; args+=(-v "${key}_requires_host=$value")
done
args+=(-v "expected_resource_epoch=$([[ $mode == verify ]] && echo 1 || echo 0)")
if [[ $mode == activate ]]; then
  for variable in DAYOTTER_WRITERS_QUIESCED DAYOTTER_LEGACY_BOUNDARY_REVIEWED; do
    if [[ ${!variable:-} != true ]]; then echo "$variable=true requires completed operator review." >&2; exit 2; fi
  done
  case ${DAYOTTER_PAID_READINESS:-} in disabled|test_workflow_reviewed) ;; *)
    echo 'DAYOTTER_PAID_READINESS must be disabled or test_workflow_reviewed after runtime/provider review.' >&2; exit 2;; esac
  reviewed_snapshot=$(python3 - "${DAYOTTER_RESOURCE_REVIEW:?Set the reviewed readiness JSON file}" <<'JSON'
import json,sys
with open(sys.argv[1]) as f: report=json.load(f)
if report.get('ready') is not True or not isinstance(report.get('configuration_snapshot'),dict):
    raise SystemExit('The reviewed report must be ready=true with a configuration snapshot.')
print(json.dumps(report['configuration_snapshot'],separators=(',',':')))
JSON
  )
  args+=(-v "reviewed_snapshot=$reviewed_snapshot")
fi
# The shared state query is identical for read-only inspection and locked activation.
# Send source over stdin: nothing is copied into or installed in the running stack.
{
  cat "$operator_dir/${mode}-begin.sql" "$operator_dir/readiness-state.sql" "$operator_dir/${mode}-end.sql"
} | "$@" "${args[@]}"
