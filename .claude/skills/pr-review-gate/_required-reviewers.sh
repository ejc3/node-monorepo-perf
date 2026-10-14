#!/bin/bash
# Sourced by check-review-threads.sh and merge-pr.sh: the one rule for the required-reviewer
# list. REQUIRE_HEAD_REVIEW_FROM, when SET, must name at least one login. A value that is
# set but empty (or only spaces and commas) used to read as "nobody is required":
# `${VAR-default}` keeps an empty value, so `make merge-pr PR=7 REVIEW_GATE_REQUIRED=` ran
# the gate with no required reviewer and merged without either bot. An unset variable is
# not this case; each caller says what unset means.
#
# required_reviewers_ok <caller>: returns 0 when the list is unset or names a login, else
# prints why to stderr and returns 2.
required_reviewers_ok() {
  [ -n "${REQUIRE_HEAD_REVIEW_FROM+set}" ] || return 0
  local logins=${REQUIRE_HEAD_REVIEW_FROM//[[:space:],]/}
  [ -n "$logins" ] && return 0
  echo "$1: REQUIRE_HEAD_REVIEW_FROM is set but names no reviewer ('$REQUIRE_HEAD_REVIEW_FROM')." >&2
  echo "An empty list would require nobody. Name the reviewers, or unset it for the default." >&2
  return 2
}
