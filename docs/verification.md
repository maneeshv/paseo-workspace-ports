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

- Installation from the final public Git commit in a clean checkout and GitHub Actions results remain pending publication checks.
- Compact layouts and alternate themes have not been visually checked.
- A physical connection from another Wi-Fi network has not been tested.
- No registry submission or approval has been performed. Registry review is separate from these checks.
- This is functional verification, not an independent security audit. Network changes can end a tunnel; automatic reconnection is not implemented.
