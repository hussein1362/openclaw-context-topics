# Context Topics

Project continuity for one OpenClaw agent.

Context Topics lets one agent move between different bodies of work without
mixing them together. Put on a product-launch hat, and the agent remembers the
launch plan, source-of-truth files, decisions already made, and what should not
be re-litigated. Switch to a client engagement, research thread, open-source
project, or half-started idea, and that work gets its own room too.

It is meant to feel like project memory, not a prompt trick. You can start a
topic intentionally, capture a conversation after you realize it matters, close
the topic with durable notes, and come back later with the context still
waiting.

Context Topics stores everything as plain files under
`~/openclaw-soul/topics/` and uses OpenClaw's public plugin hooks. No gateway
fork. No Control UI patch. No drifting away from upstream updates.

## Why This Exists

One good agent can help with many things, but conversations blur together.
Project A has different rules than Project B. Decisions made last week get
forgotten. A useful chat becomes hard to resume because it was never promoted
into a durable workspace.

Context Topics gives each project a small, file-backed memory room:

- a working pin for what the agent should know immediately
- topic-local memory
- decisions
- artifact index
- notes
- validation through `/topic doctor`

The goal is simple: one agent, many hats, each with its own continuity.

## Quick Start

Install from ClawHub:

```bash
openclaw plugins install clawhub:openclaw-context-topics
openclaw gateway restart
```

Then open a chat and type:

```text
/topic
```

Create a new topic:

```text
/topic new product-launch
```

Load it later:

```text
/topic product-launch
```

Close it when the work is done:

```text
/topic close
```

## The One-Minute Demo

You are chatting normally and realize the conversation should become a project:

```text
/topic capture whatsapp-research
```

Context Topics creates:

```text
~/openclaw-soul/topics/whatsapp-research/
  topic.md
  memory.md
  decisions.md
  artifacts/
    README.md
    index.md
  notes/
```

On the next agent turn, the agent is asked to fill the starter pin, memory,
decisions, and artifact index from the current conversation.

Later:

```text
/topic whatsapp-research
```

The agent gets the topic room back as working context.

## Commands

| Command | What it does |
| --- | --- |
| `/topic` | Show command help. |
| `/topic list` | Show available topic rooms. |
| `/topic new <name>` | Create a folder-backed topic room and activate it. |
| `/topic capture <name>` | Turn the current no-hat conversation into a new topic room. |
| `/topic <name>` | Load an existing topic into the current session. |
| `/topic status` | Show the active topic. |
| `/topic panel [name]` | Render a chat-stream topic panel. |
| `/topic close [reason]` | Run one final cleanup turn, update topic files, then clear the hat. |
| `/topic refresh [name]` | Ask the agent to refresh `topic.md` from topic memory and decisions. |
| `/topic doctor [name]` | Validate structure, pin quality, file references, probes, and review date. |
| `/topic clear` | Take the current hat off without cleanup. |

## Topic Room Shape

New topics use this folder shape:

```text
topics/<name>/
  topic.md
  memory.md
  decisions.md
  artifacts/
    README.md
    index.md
  notes/
```

`topic.md` contains YAML code blocks for the always-loaded pin, file references,
recent-memory rules, live probes, and metadata.

Topic-local files are intentionally plain Markdown so they can be read, edited,
backed up, diffed, and committed like any other project artifact.

## Example Pin

```yaml
pin:
  title: "Product Launch"
  summary: "Launch planning for the next release."
  current_state:
    - "Launch date is not final."
    - "Pricing copy is still under review."
  operating_rules:
    - "Keep recommendations practical and release-oriented."
    - "Do not reopen settled positioning unless new evidence appears."
  settled_decisions:
    - "Use the existing landing page instead of creating a new microsite."
  open_work:
    - "Draft launch checklist."
    - "Confirm owner for customer announcement."
  avoid:
    - "Do not suggest paid ads until budget is approved."
```

## Privacy And Safety

Context Topics is local-first.

- Topic rooms live under `~/openclaw-soul/topics/`.
- Plugin session state lives under `~/openclaw-soul/state/`.
- The plugin does not execute shell commands.
- Live probes are listed for the agent to run manually when needed.
- Sensitive-looking files are not inlined.
- Sensitive-looking absolute paths are redacted from prompt bundles.
- Session identifiers are hashed before persistence or logging.

You still control what goes into each topic. Do not put secrets, tokens,
private keys, or credential material in topic memory.

## Upstream Safety

This plugin uses OpenClaw's public plugin SDK:

- `registerCommand` for `/topic`
- `before_prompt_build` for per-turn context injection
- `registerSessionExtension` as an optional session metadata probe

It does not patch the gateway or Control UI bundle.

## Feedback Wanted

This plugin is young. The most useful feedback is specific:

- Did `/topic capture` feel natural?
- Did `/topic close` write the right amount of memory?
- Did the topic pin help on the next session?
- Did anything feel too heavy, too magical, or too manual?
- What would make this safer for a team or shared machine?

Please open an issue with the command you ran, what you expected, what happened,
and whether the topic files ended up useful.

## Roadmap

Ideas being considered:

- richer file tiers and source-of-truth references
- better artifact indexing
- optional team/shared-topic conventions
- import/export of topic rooms
- stronger schema validation for topic manifests
- more polished chat-stream topic status

## Links

- ClawHub: https://clawhub.ai/plugins/openclaw-context-topics
- Source: https://github.com/hussein1362/openclaw-context-topics

## License

MIT-0. Free to use, modify, and redistribute.
