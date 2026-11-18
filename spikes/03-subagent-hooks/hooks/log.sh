#!/bin/sh
# append hook stdin (one JSON per line) to the spike log
cat | tr -d '\n' >> "$(dirname "$0")/../hook-log.jsonl"; echo >> "$(dirname "$0")/../hook-log.jsonl"
