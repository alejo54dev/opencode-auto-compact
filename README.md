# Auto Compact (your window, your rules)

![Version](https://img.shields.io/badge/version-0.1.7-blue)
![License](https://img.shields.io/badge/license-AGPL%203.0-blue)
![OpenCode v1](https://img.shields.io/badge/OpenCode-v1-purple)

> Your context hits the ceiling. OpenCode picks the moment and your expensive working model pays for the summary? Not anymore!

## 💡 What it does

> Compaction on your terms: your %, their tokens.

- **Fixed percentage trigger** — compacts when context usage reaches `target_percent` (e.g. 30%), regardless of opencode's internal formula.

- **OpenCode decides the model** — summarization runs on the native `compaction` agent, so the model configured in `agent.compaction.model` (e.g. a cheap one) pays the summary bill; when unset, the session model is the fallback.

- **Native engine, custom trigger** — fires opencode's internal `session.summarize` (the same one behind `/compact`), so the summary, verbatim tail and recovery stay 100% opencode.

- **Terminal notice** — one ignored line per trigger (`▣ auto-compact: 31.2% ≥ 30% — compacting`). UI-only: never sent to the model (`ignored` part + `noReply` prompt).

- **Safe by design** — single-claim `inProgress` guard (synchronous claim, `finally` release), per-session cooldown, errors logged without breaking the session.

## 🧠 Philosophy

Compaction is scheduled maintenance, not an emergency. The working model is for work; summarizing is a cheap job for whichever model you configure on the `compaction` agent.

The % is yours. Native auto decides when; here the threshold is fixed, visible and predictable.

The plugin never blocks you, never pays a summary with your main model, and never breaks a session it cannot first guard.

## 🔄 How it works

```mermaid
flowchart TD
    A["📨 message.updated<br/>(assistant)"] --> B["💾 Cache usage per session<br/>tokens + provider/model"]
    C["💤 session.idle"] --> D{"inProgress or<br/>within cooldown?"}
    D -->|"❌ busy / waiting"| E["⏭️ Skip"]
    D -->|"✅ free"| F{"tokens / limit.context<br/>≥ target_percent?"}
    F -->|"❌ below"| E
    F -->|"✅ reached"| G["🔒 Claim inProgress<br/>(synchronous re-check)"]
    G --> H["🎨 Ignored UI notice<br/>▣ auto-compact: X% ≥ Y% — compacting"]
    H --> I["🧠 session.summarize<br/>model: compaction agent (fallback: session)"]
    I --> J["🔓 finally releases the claim<br/>📝 Log: Compaction triggered"]
    B -.->|"usage read"| F
    J -.-> C

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style B fill:#0f3460,stroke:#53a8b6,color:#fff
    style C fill:#16213e,stroke:#e94560,color:#fff
    style D fill:#16213e,stroke:#e94560,color:#fff
    style E fill:#1a1a2e,stroke:#53a8b6,color:#fff
    style F fill:#16213e,stroke:#e94560,color:#fff
    style G fill:#0f3460,stroke:#53a8b6,color:#fff
    style H fill:#0f3460,stroke:#53a8b6,color:#fff
    style I fill:#0f3460,stroke:#53a8b6,color:#fff
    style J fill:#1a1a2e,stroke:#e94560,color:#fff
```

## 🎯 Use cases

**The daily driver pays less.** Every compaction pays summary tokens with the model configured on the native `compaction` agent. Point it at a cheap model and the bill drops to pocket change.

**No surprise compactions.** Native auto decides *when*. Here 30% means 30%, every session, every project — visible in the config, not in the engine's mood.

**Long unattended runs.** A build-and-fix loop at 2 AM fills the window. The plugin fires at the threshold and the session keeps moving — no manual `/compact` at 3 AM.

**One place to pick the summarizer.** Set `agent.compaction.model` in `opencode.jsonc` once; it applies to this plugin, manual `/compact` and any native path.

## 🚀 Installation

```bash
cp auto-compact.ts ~/.config/opencode/plugins/auto-compact.ts
cp auto-compact.jsonc ~/.config/opencode/auto-compact.jsonc
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively. Restart opencode; the plugin loads on start.

## ⚙️ Configuration

Copy `auto-compact.jsonc` (included in this repo) to `~/.config/opencode/` and edit:

```jsonc
{
	"enabled": true,                // master switch
	"target_percent": 30,           // compact when context usage reaches this %
	"log_level": "info"             // "silent" | "error" | "info" | "debug"
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `target_percent` | `30` | Compact when `tokens / limit.context` reaches this % |
| `log_level` | `"info"` | `"silent"`, `"error"`, `"info"`, `"debug"` |

### Model resolution

The summarizer model is opencode's decision: `processCompaction` resolves the native `compaction` agent first and only falls back to the request model (the plugin passes the session model) when the agent has none. So the **only** place to configure it is `agent.compaction.model` in `opencode.jsonc`.

| `agent.compaction.model` | Summarizer |
|---|---|
| set (e.g. `"poolside/poolside/laguna-s-2.1"`) | That model — for the plugin, manual `/compact` and native paths |
| unset | Model of the compaction request (session model for the plugin path) |

Summary temperature also comes from the `compaction` agent (`temperature: 0.1` recommended).

## 🧩 Native contract (`opencode.jsonc`)

These fields are read by opencode's engine and cannot be passed through the plugin API:

```jsonc
"agent":
{
	"compaction": { "temperature": 0.1, "model": "poolside/poolside/laguna-s-2.1" }   // summarizer model + temperature
},
"compaction":
{
	"auto": false,     // native trigger OFF — the plugin is the only trigger
	"prune": true,     // tool-output pruning (independent of the trigger)
	"tail_turns": 5    // recent turns kept verbatim after compaction
}
```

## 🪵 Logs

`~/.config/opencode/auto-compact.log` (append-only). Format: `[TIMESTAMP] [LEVEL]: message`.

```bash
tail -f ~/.config/opencode/auto-compact.log
```

```log
[2026-09-16T21:08:32] [INFO]: Config loaded
[2026-09-16T21:08:32] [INFO]: Initialized
[2026-09-16T21:17:23] [INFO]: Threshold reached | session: ses_f5346621affe2bfWHSUKv6WeVB | 51.3% >= 50%
[2026-09-16T21:17:23] [INFO]: Summary generated | model: poolside/poolside/laguna-s-2.1
[2026-09-16T21:17:23] [INFO]: Compaction triggered | session: ses_f5346621affe2bfWHSUKv6WeVB | tokens: 7339
[2026-09-16T21:18:10] [INFO]: Disposed
```

## 💬 Notes

- **Single-claim guard** — `inProgress` is claimed synchronously in `evaluate()` (re-checked after every await) and released only in `compact()`'s `finally`. No event may release it, so concurrent idle events can never double-fire.
- **Cooldown** — a fixed 5-minute gap (`COOLDOWN_MS`, not user-configurable) counts from the moment compaction **finishes**. It bounds re-compaction to ≤12/hour/session even when a lazy summarize leaves the context above target, and a slow summarize never consumes the window.
- **Notice is UI-only** — sent as an `ignored` text part with `noReply`; it never reaches the model and never counts as a turn.
- **`tail_turns` stays native** — the plugin only triggers `session.summarize`; the verbatim tail and the real summarizer model live in `opencode.jsonc`.
- **Known tradeoff** — a `summarize` that never settles (no resolve/reject) holds the claim until process restart. Accepted versus a time-based release, which reopens the double-compaction window.
- **Failure policy** — every SDK call is try/caught and logged; the session is never broken by the plugin.
- **Custom summaries later** — `experimental.session.compacting` (custom prompt / tags) is left for a v2.

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- DeepSeek-Flash — assistant model during development

## 📄 License

AGPL-3.0 — version 0.1.7
