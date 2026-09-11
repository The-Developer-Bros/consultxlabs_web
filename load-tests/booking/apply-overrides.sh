#!/usr/bin/env bash
# Sourced (not executed) by every load-gate step that reads a fixture. It
# exports the KEY=VALUE lines the dispatcher typed into `fixture_overrides`
# over the job-level defaults.
#
# Why a file and not $GITHUB_ENV: a job-level `env:` entry beats a $GITHUB_ENV
# write of the same name, and every fixture the input is meant to override is
# declared at job level, so the input used to be a silent no-op. Setting the
# variables inside the step's own shell is unambiguous.
#
# `export -- "$line"` assigns the literal text. Nothing on the line is
# evaluated, so `X=$(id)` exports the five characters `$(id)`.
overrides_file="${RUNNER_TEMP:-/tmp}/load-gate-overrides.env"
if [ -f "$overrides_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      export -- "$line"
    else
      echo "::warning::ignoring malformed override: $line"
    fi
  done <"$overrides_file"
fi
unset overrides_file
