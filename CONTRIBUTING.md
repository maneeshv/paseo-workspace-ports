# Contributing

Small, focused issues and pull requests are welcome. For larger changes, open an issue describing the user problem first. Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Local development

Use Node.js 22.13 or newer and the committed npm lockfile:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

The default tests exercise discovery, service validation, and tunnel management with fixtures. They do not connect to your SSH hosts or require a running Paseo daemon. The live integration tests are skipped unless explicitly enabled. Paseo supplies runtime SDK modules; the packages here support development. `private: true` prevents accidental npm publication; this plugin is distributed through Git.

To test live behavior on a trusted development Mac with Paseo running:

```sh
PASEO_PORTS_INTEGRATION=1 npm test
```

These tests create and archive a disposable local Paseo workspace, start and stop a fixture service, and run a temporary loopback SSH server with fixture keys. They require the Paseo CLI, macOS SSH tools, and `trash`. Only run them against a daemon you are authorized to change. They do not test a real remote Mac or desktop interaction.

For manual testing, install this checkout on your development host using the setup in [README.md](README.md). Reload only your development installation after changes. Do not restart a daemon as a substitute for reloading the plugin.

## Before submitting

- Run type checking and tests; add a small regression test for non-trivial behavior.
- Describe the problem, resulting behavior, and verification performed.
- For UI changes, inspect wide and narrow layouts and theme colors. Remove private information from screenshots.
- For SSH changes, check that failure releases owned resources, disconnect leaves the remote app running, and unrelated SSH sessions remain untouched.
- Distinguish mocked tests, local integration tests, and real two-Mac or desktop checks.
- Keep documentation and the manifest's Paseo compatibility range accurate.
- Follow the runtime boundaries and absolute imports in [AGENTS.md](AGENTS.md).
- Use Conventional Commit titles, such as `fix: release a disconnected tunnel`.

Do not include SSH keys, credentials, account configuration, personal hostnames or paths, or unredacted logs. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Contributions are licensed under this repository's MIT License. No separate contributor agreement is required.
