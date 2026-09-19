#!/bin/bash
# poll-scans.sh — Wrapper for Rooster's venture-poll-scans recurring job.
# Invokes the real poll-scans.js from venture/tools with --once mode
# against prod Firestore (default).
set -euo pipefail
cd <<REPLACE: your home dir, e.g. /Users/you>>/code/covered-bridge
node <<REPLACE: your home dir, e.g. /Users/you>>/.homestead/stewards/venture/tools/poll-scans.js --once
