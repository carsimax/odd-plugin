# py-05 RAM budget on 16 GB

Machine: 16 GB Apple Silicon Mac (16 KB pages), Claude Code and Docker (6 containers, VM limit 5.85 GiB) running, Ollama at `/usr/local/bin/ollama`.
Models: `nomic-embed-text` (embedder, 274 MB on disk) and `qwen2.5:7b` (7B instruct, default Q4_K_M, 4.7 GB on disk; chosen because it is a widely used 7B instruct with the default Q4 tag and strong structured-output behavior for a curator role). One model loaded at a time, unloaded with `ollama stop` after reading. Nothing was removed (`ollama rm` never run).

Caveat: other writers ran in parallel during the measurement (CPU/RAM noise), and the baseline already had 2.8 GB of swap in use, so deltas are indicative, not exact.

## Result

| State | `ollama ps` SIZE | Free % (`memory_pressure`) | Wired (GB) | Compressor (GB) | Swap used | Claude Code RSS |
|---|---|---|---|---|---|---|
| Baseline (no model) | - | 42% | 3.1 | 5.7 | 2817 MB / 4096 MB | 438 MB |
| `nomic-embed-text` loaded | 335 MB (100% GPU, ctx 2048) | 38% | 3.6 | 5.8 | 2809 MB | 432 MB |
| `qwen2.5:7b` loaded | 5.0 GB (100% GPU, ctx 16384) | 20% | 7.8 | 4.3 | 4543 MB / 5120 MB | 175 MB |
| After unload | - | 54% | 3.2 | 3.7 | 4603 MB | 211 MB |

- Wired memory (what Metal weights pin) rose about 4.7 GB with the 7B model; the embedder added about 0.5 GB.
- Docker containers stayed flat (about 0.9 GB total); Docker is not the pressure source.
- The 7B load pushed swap up 1726 MB (under the 2 GB abort limit, so no abort), macOS grew the swap file to 5120 MB, and free swap fell to 577 MB. Claude Code RSS dropped from 438 to 175 MB, i.e. its pages were compressed or swapped out. Swap did not shrink after unload.
- `memory_pressure` never reported critical.

Verdict for 16 GB: the embedder alone is cheap (about 0.3-0.5 GB) and fits comfortably next to Claude Code and Docker. A 7-8B Q4 curator fits but only by evicting other memory to swap on this machine (+1.7 GB swap, free swap down to 0.6 GB, 20% free); it is usable as an on-demand, unload-after-use process, not as an always-resident one. Embedder and 7B resident together were not measured (one at a time by rule); the sum is about 5.3 GB of model memory and, extrapolating, would exceed the 2 GB swap-growth limit on this machine. Recommendation: embedder resident, curator loaded on demand with a short `keep_alive`, and a smaller `num_ctx` (the default 16384 context inflated the 7B to 5.0 GB).

## Rerun

```sh
ollama pull nomic-embed-text
ollama pull qwen2.5:7b
spikes/py-05-ram/measure.sh            # baseline, embedder, 7B, after-unload; prints an ABORT line on critical pressure or swap > +2 GB
```

The script runs `memory_pressure`, `vm_stat`, `sysctl vm.swapusage`, `ollama ps`, `docker stats --no-stream` and Claude Code RSS (`ps`), sending one embedding request (`/api/embeddings`) and one generation (`/api/generate`) via `curl`. Cleanup of the models (`ollama rm`) is left to the human.
