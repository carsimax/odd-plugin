#!/usr/bin/env bash
# Measures RAM with Claude Code + Docker open. One model at a time; aborts on critical pressure or swap > +2 GB.
# Usage: measure.sh [embedder] [llm]   (models must already be pulled)
set -u
EMB=${1:-nomic-embed-text}; LLM=${2:-qwen2.5:7b}
OLLAMA=/usr/local/bin/ollama
swap_mb() { sysctl -n vm.swapusage | awk '{gsub("M","",$6); print int($6)}'; }
readings() {
  echo "--- $1"
  memory_pressure | grep -E 'free percentage|System-wide'
  vm_stat | grep -E 'Pages (free|active|inactive|wired down|occupied by compressor)'
  sysctl vm.swapusage
  echo "ollama ps:"; $OLLAMA ps
  echo "docker:"; docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
  echo "claude RSS MB: $(ps -axo rss,comm | awk '/claude/ {s+=$1} END {print int(s/1024)}')"
}
$OLLAMA list
readings baseline
BASE=$(swap_mb)
measure() { # name, request-cmd
  echo "=== $1"; eval "$2" >/dev/null || echo "request failed"
  readings "$1 loaded"
  if memory_pressure | grep -qi critical || [ $(( $(swap_mb) - BASE )) -gt 2048 ]; then echo "ABORT: critical pressure or swap +2GB"; fi
  $OLLAMA stop "$1"; sleep 3
}
measure "$EMB" "curl -s localhost:11434/api/embeddings -d '{\"model\":\"$EMB\",\"prompt\":\"hello world\",\"keep_alive\":\"5m\"}'"
measure "$LLM" "curl -s localhost:11434/api/generate -d '{\"model\":\"$LLM\",\"prompt\":\"Say hi in five words.\",\"stream\":false,\"keep_alive\":\"5m\"}'"
readings after-unload
