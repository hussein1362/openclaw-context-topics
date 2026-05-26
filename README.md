# Context Topics

Context Topics is an OpenClaw plugin that gives one agent many project "hats".

It adds a `/topic` command that loads a curated, folder-backed context room into
the current OpenClaw session. Each topic can keep its own working pin, memory,
decisions, artifacts, notes, and validation state without patching OpenClaw
itself.

## What It Does

- `/topic list` shows available topic rooms.
- `/topic new <name>` creates a new topic room and activates it.
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
recent-memory rules, live probes, and metadata. Large files are deferred and
read on demand. Sensitive-looking paths such as `.env`, private keys, tokens,
and secrets are never inlined automatically.

## Install From A Local Checkout

```bash
openclaw plugins install /path/to/context-topics
openclaw gateway restart
```

Then type:

```text
/topic
```

## Upstream Safety

This plugin uses OpenClaw's public plugin SDK:

- `registerCommand` for `/topic`
- `before_prompt_build` for per-turn context injection
- `registerSessionExtension` as an optional session metadata probe

It does not patch the gateway or Control UI bundle.

## License

MIT-0. Free to use, modify, and redistribute.
