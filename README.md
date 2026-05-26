# Context Topics

Context Topics lets one OpenClaw agent carry many lives without mixing them
together.

Put on the Amber hat, and the agent remembers the robot, the family-facing
rules, the source-of-truth files, and the decisions already made. Switch to a
client, research thread, home project, or half-started idea, and that work gets
its own room too: a working pin, memory, decisions, artifacts, notes, and
closeout ritual.

It is meant to feel like project continuity, not a prompt trick. You can start
a topic intentionally with `/topic new`, retroactively capture a conversation
with `/topic capture`, close a topic when the session is done, and come back
later with the context still waiting. All of it lives in simple files under
`~/openclaw-soul/topics/`, using OpenClaw's plugin hooks instead of patching
the gateway or drifting away from upstream updates.

## What It Does

- `/topic list` shows available topic rooms.
- `/topic new <name>` creates a new topic room and activates it.
- `/topic capture <name>` turns the current no-hat conversation into a new
  topic room, then asks the agent to fill the initial pin, memory, decisions,
  and artifact index from the current session.
- `/topic <name>` loads an existing topic into the current session.
- `/topic status` shows the active topic.
- `/topic panel [name]` renders a chat-stream topic panel.
- `/topic close [reason]` asks the agent to close out topic memory, decisions,
  and artifacts.
- `/topic refresh [name]` asks the agent to refresh the topic pin from room
  state.
- `/topic doctor [name]` validates structure, pin quality, files, probes, and
  review age.
- `/topic clear` removes the active hat without cleanup.

## Topic Room Shape

New topics use this folder shape under `~/openclaw-soul/topics/`:

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
recent-memory rules, live probes, and metadata. Large non-sensitive files are
deferred and read on demand. Sensitive-looking paths such as `.env`, private
keys, tokens, and secrets are blocked from prompt injection and their absolute
paths are not exposed in the bundle.

## Install From A Local Checkout

```bash
openclaw plugins install /path/to/context-topics
openclaw gateway restart
```

Then type:

```text
/topic
```

### Retroactive Capture

Use capture when you have been working normally and realize the conversation
should become its own topic:

```text
/topic capture my-new-project
```

The plugin creates `topics/my-new-project/`, activates that hat, and queues a
one-time capture request. On the next agent turn, the agent should update:

- `topic.md` with a useful starter pin
- `memory.md` with a concise session summary
- `decisions.md` with durable decisions only
- `artifacts/index.md` with important files, docs, links, or generated artifacts

`/topic capture` is meant for sessions with no active hat. If another hat is
already active, close or clear it first so topic memory does not get mixed.

## Upstream Safety

This plugin uses OpenClaw's public plugin SDK:

- `registerCommand` for `/topic`
- `before_prompt_build` for per-turn context injection
- `registerSessionExtension` as an optional session metadata probe

It does not patch the gateway or Control UI bundle.

## License

MIT-0. Free to use, modify, and redistribute.
