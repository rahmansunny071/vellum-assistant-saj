# Benchmarking Personal AI Assistants

Notes on how to evaluate and benchmark personal AI assistants, specifically for comparing our security-focused assistant against OpenClaw.

## Why Assistant Benchmarking Is Different

Standard LLM benchmarks (MMLU, HumanEval, etc.) measure raw model capabilities. Assistants are end-to-end agent systems operating in real environments, so evaluation must cover task execution, safety, autonomy, and user experience — not just answer quality.

## Proposed Dimensions

### 1. Task Completion

- Can it accomplish real-world tasks end-to-end?
- Categories: file management, scheduling, web research, communication drafting, data analysis, system administration, multi-step workflows
- Metrics: success rate, partial completion scoring, number of human interventions needed

### 2. Security & Safety (our differentiator)

- **Prompt injection resistance** — adversarial inputs via web pages, emails, documents it ingests
- **Privilege escalation** — does it stay within its authorized scope?
- **Data exfiltration** — can it be tricked into leaking private data to external services?
- **Action confirmation** — does it appropriately gate destructive/irreversible actions?
- **Attack persistence** — the PASB paper (https://arxiv.org/html/2602.08412) found OpenClaw vulnerabilities compound over extended interactions; test across long sessions

### 3. Autonomy vs. Control

- How much can it do without hand-holding vs. how much does it appropriately check in?
- Over-autonomy is dangerous (doing things it shouldn't), under-autonomy is annoying (asking permission for everything)
- This is a spectrum, not a single score — interesting tradeoffs live here

### 4. Reliability & Consistency

- Same task, same context — does it produce the same quality result across N runs?
- Error recovery — when something fails mid-task, does it adapt or bail?
- Idempotency — if run twice, does it cause problems?

### 5. Latency & Resource Efficiency

- Time-to-completion for standard task suites
- Compute/token cost per task
- Especially relevant for the self-hosted audience

### 6. Context & Personalization

- How well does it learn and retain user preferences over time?
- Does it correctly use contextual information (calendar, files, past conversations)?

#### 6a. Long-horizon memory: a ConvoMem bridge

[convomem-arena](https://github.com/PrimeIntellect-ai/verifiers) packages Salesforce's ConvoMem dataset as a `verifiers` taskset with three delivery modes (`context`, `tools`, `files`) and official LLM judges per category (user facts, changing facts, preferences, implicit connections, abstention). It's built for agents that receive a prompt and tools — not for a product with its own persistent, product-owned memory pipeline, which is what we have. Reusing its **data and judges** while bypassing its `Task`/`Toolset` machinery is the right split:

1. **Generate test cases with convomem-arena's own mixing code** (`HubSource`, `EvidenceStream`, `mix()`), seeded with `random.Random(f"{seed}:{task_id}")` — identical evidence+filler histories to whatever other system is being compared, so results are apples-to-apples on the *data* even though they can't be apples-to-apples on the *interface* (see caveat below).
2. **Spin up a clean instance per eval run**: `vellum hatch --name <eval-id> --remote local --disable-platform` (or `--remote docker` for isolation). No cross-contamination between runs, and `--disable-platform` keeps it from making outbound platform calls during the benchmark.
3. **Replay the scripted history as real turns, not a system prompt.** There's no REST "create message" endpoint — turns go in via the signal-file IPC that the CLI itself uses (`assistant/src/cli.ts`'s `sendUserMessage`, consumed by `assistant/src/ipc/routes/conversation-sync-ipc-routes.ts`). Each ConvoMem conversation becomes a sequence of signal-file writes with a stable `conversationKey`.
4. **Wait for extraction to drain before asking the question — there is no built-in "done" event.** The `MemoryJobsWorker` (`assistant/src/plugins/defaults/memory/jobs-worker.ts:186-187`) polls on a 1.5s–30s backoff. The only way to know extraction has settled is to poll `hasActiveJobOfType()` (`assistant/src/persistence/jobs-store.ts:642`) across the relevant job types (`graph_extract`, `memory_v2_consolidate`, `embed_segment`, `embed_summary`, …) until none are `pending`/`running`. A fixed sleep will under- or over-wait depending on context size (ConvoMem goes up to 300 turns of padding).
5. **Ask the ConvoMem question as a normal new turn**, then capture two SSE events instead of inventing new instrumentation:
   - `memory_recalled` (`assistant/src/api/events/memory-recalled.ts`) — `semanticHits`, `tier1Count`/`tier2Count`, and `topCandidates[].key/type/finalScore` per turn.
   - `tool_result` for the `recall` tool (`assistant/src/api/events/tool-result.ts:131-195`) — `evidence[].locator/conversationId/messageId`, i.e. which memory items were actually used to answer.
6. **Grade with convomem-arena's own judge mapping** (`judge_for(category, evidence_count, judge_config)` — exact-match never works here; three of the six categories are rubric- or abstention-graded, not string-comparable), so the correctness number is comparable to any other system scored the same way.
7. **Compute a recall-style diagnostic from provenance, not from a custom reward.** Cross-reference `tool_result.evidence[].locator` against the memory nodes' `sourceConversations` (`assistant/src/persistence/schema/memory-graph.ts:54`) to get "was the evidence conversation actually surfaced" — the same low-recall-vs-high-recall split convomem-arena uses to separate search failures from reasoning failures.

**Honest caveat to state up front in any writeup:** this is not a fourth interchangeable mode alongside `context`/`tools`/`files`. Those three hold the *agent* constant and vary only how memory is delivered; here the *system* changes — Vellum's extraction, consolidation, and hybrid Qdrant recall are structurally different from a BM25 tool or raw context. A score comparison is "best current memory pipeline" across two different programs, not "same program, different interface." State that distinction before using the number in any comparison against Claude Code (`files` mode, prime-envs harness) or OpenClaw.

## Methodology Ideas

- **Standardized task suites** — 50-100 concrete tasks across categories with clear pass/fail criteria. Run both systems against the same suite.
- **Red-team security scenarios** — Attack scenarios targeting PASB-style vulnerabilities. Our security focus controls the narrative here.
- **Sandboxed environments** — Identical VMs/containers with the same filesystem, mock APIs, and user profiles for reproducibility.
- **Human-in-the-loop scoring** — Blind evaluators score outputs from both systems for subjective quality (tone, judgment calls).
- **Long-horizon sessions** — Test 20-task sessions where context accumulates. This surfaces security compounding and personalization quality.

## Marketing Report Strategy

- Lean into security comparisons — task completion parity + security superiority is a compelling story
- Build scenarios around OpenClaw's documented PASB vulnerabilities (published, fair game)
- Open-source the benchmark suite alongside the report for credibility and community adoption
- Include failure cases for both systems — honesty builds trust, "we win everywhere" reads as fluff
