# Contributing

Thanks for taking a look at Context Topics.

The best contributions are grounded in real use. If a topic felt confusing,
too heavy, too magical, or not durable enough after a later reload, that is
useful signal.

## Good First Issues

- Improve README examples.
- Add topic-room examples that do not include private information.
- Tighten `/topic doctor` checks.
- Improve the generated `topic.md` starter template.
- Add small tests or smoke scripts for parser behavior.

## Development

Clone the repo, then run basic checks:

```bash
node --check src/index.js
node --check src/bundler.js
node --check src/manifest.js
node --check src/state.js
node --check src/doctor.js
node --check src/topic-room.js
jq empty package.json openclaw.plugin.json
npm pack --json
```

Install a local checkout into OpenClaw:

```bash
openclaw plugins install /path/to/openclaw-context-topics --force
openclaw gateway restart
```

## Design Constraints

- Stay upstream-safe: no gateway forks and no Control UI bundle patches.
- Keep topic rooms plain-file based.
- Do not inline sensitive-looking files.
- Do not execute shell commands from the plugin.
- Keep lifecycle behavior predictable: `close` means one final cleanup turn,
  then hat off.

## Pull Requests

Please include:

- what changed
- why it matters
- commands you ran to verify it
- any privacy/security implications

Small, focused PRs are easiest to review.
