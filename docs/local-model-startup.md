# Start-up Lesson: Running Vellum on a Local Model

How to go from a bare checkout of this repo to a hatched assistant instance running
entirely on a local Ollama model, no Anthropic/OpenAI key required. Written up after
doing this for the first time on a fresh machine — every gotcha below is a thing that
actually failed, not a hypothetical.

**Hardware used for this write-up:** Apple M5 Pro, 48GB unified memory. Model and
hardware choices below assume a machine in that range; scale the model size down on
less RAM.

## 1. Pick a local model

Vellum's tools (recall, memory, actions) all go through function-calling, so the model
must support tool use — not every small model does. On 48GB of unified memory, a good
default is a mixture-of-experts model: large total capacity, small active-parameter
count per token, so it stays fast.

```bash
ollama pull qwen3:30b-a3b     # ~19GB, MoE (3B active params), 256K context — recommended default
ollama pull qwen3:32b         # ~20GB, dense, slower, marginally higher quality
ollama pull gpt-oss:20b       # ~13GB, OpenAI's open-weight model, smallest footprint
```

Sanity-check before going further:

```bash
ollama run qwen3:30b-a3b "reply with one word: ok"
```

## 2. Bootstrap the repo

This repo needs Bun 1.3.11, not npm/pnpm. If `bun` isn't on `PATH`, `setup.sh` installs
it (via `curl -fsSL https://bun.sh/install | bash`), runs `bun install` across the whole
workspace, and links the `vellum` / `assistant` binaries globally:

```bash
./setup.sh
```

This also appends `BUN_INSTALL`/`PATH` exports to `~/.zshrc` — **open a new terminal
tab** (or `source ~/.zshrc`) afterward so the shell picks up the new `PATH`. Confirm:

```bash
vellum --version
assistant --version
```

## 3. Hatch a local instance

```bash
vellum hatch -d --config llm.default.provider=ollama --config llm.default.model=qwen3:30b-a3b
```

The `--config llm.default.*` flags skip the "no API key configured" warning at
hatch-time, but **they do not actually wire the model in** — they only affect the
bootstrap credential check. The seeded profiles (`balanced`, `quality-optimized`,
`cost-optimized`, `latency-optimized`) are all Anthropic and all come up
`missing_connection` until Section 5. Don't skip Section 5 on the assumption that hatch
already did it.

```bash
vellum ps        # confirm it shows up healthy
vellum use <name-from-ps>
```

## 4. Point `assistant` at the hatched instance

This is the step that isn't obvious from `--help` output. `assistant` (the low-level CLI
that `vellum` wraps) defaults to a single fixed workspace path
(`~/.vellum/workspace/assistant.sock`). A **named, hatched** instance lives somewhere
else entirely: `~/.local/share/vellum/assistants/<name>/.vellum/workspace`.

Worse: that path is long enough that it exceeds macOS's 103-byte `AF_UNIX` socket path
limit, so the daemon silently falls back to a per-instance temp directory for its IPC
socket instead of using the workspace path. `assistant status` will report `down` and
every `assistant inference ...` command will fail with
`Could not connect to the assistant at <wrong path>` until both env vars are set
correctly.

Find the real socket from the running daemon, then export both variables:

```bash
# Get the daemon PID from the workspace
cat ~/.local/share/vellum/assistants/<name>/.vellum/workspace/vellum.pid

# Find its actual IPC socket
lsof -p <pid> | grep sock
# -> /var/folders/.../T/vellum-ipc-<hash>/assistant.sock

export VELLUM_WORKSPACE_DIR=~/.local/share/vellum/assistants/<name>/.vellum/workspace
export ASSISTANT_IPC_SOCKET_DIR=/var/folders/.../T/vellum-ipc-<hash>
```

Confirm the fix:

```bash
assistant status                     # should report the instance, not "down"
assistant inference profiles active  # should print "balanced" (the seeded default)
```

## 5. Register Ollama as a provider connection

This is the second non-obvious step. Ollama being "keyless" only means it skips the
*credential prompt* — the daemon still requires a named **provider connection** to
exist before any profile can use it. Skipping this gets you
`No dispatchable provider is configured for this profile`.

```bash
assistant inference providers create ollama-local \
  --provider ollama \
  --base-url http://127.0.0.1:11434/v1
```

Note: the connection name can't be the literal string `ollama` — that's reserved as the
provider-type id and will be rejected (`"ollama" is reserved as a provider id`). Use
`ollama-local`, `ollama-home`, etc.

## 6. Create and activate a profile

```bash
assistant inference profiles create qwen-local \
  --provider ollama \
  --model qwen3:30b-a3b \
  --allow-unlisted            # qwen3:30b-a3b isn't in the bundled catalog's suggested list

assistant inference profiles update qwen-local --connection ollama-local

# Verify before making it the default
assistant inference send --profile qwen-local "Reply with one word: ok"
# -> ok

# Make it the default for normal conversations
assistant inference profiles active qwen-local
```

Confirm everything lines up:

```bash
assistant inference profiles list
# qwen-local | ollama | qwen3:30b-a3b | active | SOURCE: user | AVAIL: ok
```

## 7. End-to-end check

```bash
vellum message "Reply with one word: ok"
# -> Message accepted (id: ...)
```

## What's untested after this

Confirming a plain chat reply only proves the model answers — it does not prove
tool-calling works. Vellum's memory/recall/action system depends on reliable
function-calling, so before trusting a local model for real use, run something that
forces a tool call (not just a chat reply) and check the result, not just the HTTP
status.

## Quick reference: the two env vars every `assistant` command needs for a hatched instance

```bash
export VELLUM_WORKSPACE_DIR=~/.local/share/vellum/assistants/<name>/.vellum/workspace
export ASSISTANT_IPC_SOCKET_DIR=$(lsof -p "$(cat "$VELLUM_WORKSPACE_DIR/vellum.pid")" | grep -o '/var/folders/[^ ]*vellum-ipc-[^/]*')
```
