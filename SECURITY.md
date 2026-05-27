# Security

Context Topics is a local context-management plugin. It can make local project
context more visible to an OpenClaw agent, so topic manifests should be treated
as trusted local configuration.

## Security Model

- Topic rooms are local files under `~/openclaw-soul/topics/`.
- Plugin state is local under `~/openclaw-soul/state/`.
- The plugin does not execute shell commands.
- Live probes are listed as instructions for the agent; they are not run by the
  plugin.
- Sensitive-looking files are not inlined into prompt context.
- Sensitive-looking absolute paths are redacted from prompt bundles.
- Session identifiers are hashed before being persisted or logged.

## What Not To Put In Topics

Do not put these in `topic.md`, `memory.md`, `decisions.md`, or artifact
indexes:

- API keys
- passwords
- OAuth tokens
- private keys
- `.env` contents
- production credentials
- private personal data that is not required for the work

## Reporting A Security Issue

Please do not open a public issue for a vulnerability involving credential
exposure or private data. Contact the maintainer privately through the GitHub
profile associated with this repository, or use GitHub's private vulnerability
reporting if it is enabled.

For scanner false positives or trust-model questions that do not expose private
data, a public issue is fine.
