# Repository instructions

## Scope and structure

This is a trusted local Paseo plugin for workspace apps and SSH forwarding. Prefer the smallest complete change and reuse existing helpers and public Paseo SDK operations.

- `index.client.tsx`: workspace panel, Command Center, and slash-command registrations.
- `client/`: React Native UI, connection settings, and viewer-host tunnel terminals.
- `index.server.ts`: settings and RPC registrations.
- `server/`: workspace service control, logs, and macOS listener discovery.
- `shared/`: validated RPC contracts and pairing settings.
- `tests/`: unit tests and explicitly enabled live integration fixtures.

## Conventions

- Use TypeScript and absolute `#client/`, `#server/`, and `#shared/` imports for project code.
- Use npm and the committed lockfile. Avoid dependencies for a few lines of code.
- Check installed SDK types and official documentation before using APIs. Use Context7 when available; if unavailable, verify pinned source rather than inventing APIs.
- Keep React Native UI themed and accessible. Never import server code or Node runtime modules into client code.
- Preserve validation, error handling, workspace ownership checks, and cleanup. Stop only owned tunnel terminals or explicitly selected configured Paseo services.
- Keep tunnel disconnect separate from application stop. Never add process-killing controls for detected listeners based only on working directory.
- Preserve loopback forwarding, strict host-key checking, noninteractive SSH authentication, and private control sockets.
- Never commit credentials, keys, account configuration, personal paths or hostnames, private screenshots, or dependency directories.
- Always use `trash` for deletions. If unavailable, ask before deleting.
- Use Conventional Commit messages, for example `fix: preserve app after tunnel disconnect`.

## Verification and permissions

Run `npm ci --ignore-scripts`, `npm run typecheck`, and `npm test`. Add meaningful regression coverage for non-trivial changes. Live tests require explicit opt-in; see [CONTRIBUTING.md](CONTRIBUTING.md) for their side effects.

For UI changes, inspect wide and narrow desktop layouts and theme colors. For forwarding changes, distinguish fixture tests from real SSH and desktop checks. Report unverified behavior without claiming completion.

Install or reload only an authorized development installation. Do not restart daemons, modify SSH configuration or keys, change global plugin trust, or publish changes without authorization. Keep README.md, OVERVIEW.md, and docs/verification.md accurate; do not claim compatibility beyond what was checked.
