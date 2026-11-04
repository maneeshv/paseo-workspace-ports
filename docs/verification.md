# Verification

Target: Workspace Ports 0.1.0 with Paseo Desktop and daemons 0.14.0 on macOS. These results describe development checks; they do not establish compatibility with other platforms or Paseo releases.

## Completed checks

- TypeScript checking passed locally and on the second Mac.
- `PASEO_PORTS_INTEGRATION=1 npm test` passed all **23 tests**, including two opt-in integration tests, with no skips during development.
- Unit tests cover listener parsing, canonical workspace containment, managed-service readiness and result validation, CLI routing, SSH input validation, tunnel ownership, concurrent operations, stale readiness, failed-start cleanup, and tunnel recovery.
- Shell lifecycle tests execute the production wrapper with a fake SSH executable. These are separate from real SSH tests.
- The local Paseo integration fixture creates a disposable workspace and HTTP service, checks listing, start, HTTP response, logs, and stop, then archives the workspace and moves fixture files to Trash.
- The local SSH integration fixture uses a temporary loopback SSH server and fixture keys. HTTP forwarding works; terminating the tunnel releases its local listener while the fixture app remains running.
- Live listener discovery identified an owned ephemeral HTTP process, handled a symlinked workspace, and excluded an unrelated directory.
- A real two-Mac check used the production controller and an owned remote HTTP fixture. Opening forwarded HTTP, reopening reused the existing terminal, and disconnect removed the terminal and local listener without stopping the remote app.
- Both development installations reached `running` on Paseo 0.14.0.
- Desktop checks covered Command Center opening, the workspace Ports panel, wide dark-theme rendering, connection settings save, local discovery, and the remote Start & Open flow. The confirmation appeared, the expected page opened in the original workspace, logs displayed fixture output, disconnect left the remote app running, and Stop app stopped it separately.
- Disposable test apps, tunnels, and workspaces were cleaned up after verification.

## Public release checks

Workspace Ports is [published in the Paseo plugin store](https://paseo.sh/plugins/maneeshv/workspace-ports); listing availability was verified on 2026-11-04.

- A clean Git installation of commit [`57a3cc5`](https://github.com/maneeshv/paseo-workspace-ports/commit/57a3cc5abe79449ecc10d0a40e845541deedb813) passed in a disposable Paseo home with a separate loopback-only daemon and relay disabled. The declared locked dependency preparation ran, the installed revision matched, and the plugin reached `running` with only loading/ready log entries. The temporary daemon was stopped and its home moved to Trash; the existing desktop daemon was untouched.
- A fresh local dependency installation, type checking, and default tests passed: 21 passed, 2 live integration cases skipped as intended. `npm audit` reported zero vulnerabilities on 2026-11-03; this is a point-in-time dependency check.
- The public screenshot was captured from the current desktop interface with sample data and private workspace navigation hidden. Its public URL returned HTTP 200 with PNG content type.
- GitHub Actions runs the locked install, type checking, and default tests on macOS with Node.js 22. See the [CI results](https://github.com/maneeshv/paseo-workspace-ports/actions/workflows/ci.yml) for each commit's status.

## Tailnet sharing (0.2.0, in development)

Design and evidence: [docs/specs/tailnet-sharing.md](specs/tailnet-sharing.md).

- **Tailscale behavior (Phase 0):** measured on 2026-11-04 with Tailscale 1.102.2 (Standalone) on macOS, using a disposable loopback fixture and a client on the same Mac.
  - A foreground `serve` mapping was removed within 3 s after SIGTERM, SIGHUP, and SIGKILL.
  - Foreground mappings appear under `Foreground` in `serve status --json`.
  - A second `serve` on a served port fails without affecting the first.
  - The backend received `Host: <dnsName>:<port>`, `X-Forwarded-For`, and `Tailscale-User-Login`, and WebSocket upgrades passed through.
  - The first TLS handshake took about 32 s while the certificate was issued; later handshakes took about 16 ms.
  - The Serve configuration was empty before and after the checks.
- **Default tests:** type checking and the default tests passed, 35 passed and 2 live cases skipped. The share tests run the real `execFile` path against a fake Tailscale CLI. They cover:
  - status and Serve config parsing, including foreground sessions
  - share-name ownership
  - wrapper validity and positional arguments
  - absence of Funnel, `reset`, `--bg`, and `off`
  - concurrent start deduplication, including per-port serialization across apps
  - startup before the wrapper prints its start marker
  - rejection of stopped, non-listening, or IPv6-only apps and of already served ports
  - failed-start cleanup limited to the share's own terminal
  - list status derivation
  - stop limited to owned terminals

- **Live test:** on 2026-11-04 the opt-in managed-service test passed against the local Paseo 0.14.0 daemon and Tailscale 1.102.2, run as `PASEO_PORTS_INTEGRATION=1 PASEO_PORTS_TAILSCALE=1`, selected with `--test-name-pattern="managed app listing"`.
  - A share terminal created through Paseo reached `running`, and the fixture responded over its tailnet HTTPS link.
  - Stopping the share removed the Serve mapping, and the fixture app kept responding.
  - The test reported this with its own diagnostic line.
  - The Serve configuration was `{}` before and after.
  - The disposable workspace was archived by the test. The certificate had already been issued during Phase 0, so this run did not exercise the slow first handshake.

## Paseo 0.15 compatibility (Workspace Ports 0.2.0)

The manifest range is `>=0.14.0 <0.16.0`.
- **0.14.0:** the earlier default and live checks above passed.
- **0.15.0** (2026-11-04):
  - Type checking passed against `@getpaseo/plugin` and `@getpaseo/client` 0.15.0.
  - The default tests passed: 35 passed, 2 live cases skipped.
  - The plugin, installed from a local directory, reached `running` on a 0.15.0 daemon.
  - The opt-in live managed-service and tailnet-share test passed against that daemon. The Serve configuration was `{}` before and after.
- **Version skew:** a 0.14.0 daemon left running after the Paseo app updated to 0.15.0 rejects newly started plugin processes ("invalid message", path `hooks`). Restart the daemon after updating Paseo.

Not yet established for tailnet sharing:
- The panel UI has not been inspected in a Paseo client on desktop (wide or compact) or on a phone. A bundled web client could not connect to the local daemon directly.
- No phone on another network (V9), no tailnet with HTTPS certificates disabled (V4), and no App Store Tailscale variant have been checked.

## Reproduction

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Default tests skip the live integration cases. On an authorized development Mac, use:

```sh
PASEO_PORTS_INTEGRATION=1 node --import tsx --test tests/integration.test.ts
```

The live suite changes a local Paseo daemon by creating and archiving a fixture workspace. See [CONTRIBUTING.md](../CONTRIBUTING.md) for prerequisites and effects. The checked-in integration suite does not reproduce the physical two-Mac or desktop interaction checks.

## Not yet established

- Compact layouts and alternate themes have not been visually checked.
- A physical connection from another Wi-Fi network has not been tested.
- This is functional verification, not an independent security audit. Network changes can end a tunnel; automatic reconnection is not implemented.
