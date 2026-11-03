# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/maneeshv/paseo-workspace-ports/security/advisories/new). Do not put vulnerabilities, credentials, or private workspace data in public issues. If private reporting is unavailable, use a contact method listed on [@maneeshv's profile](https://github.com/maneeshv) to request a private channel before sharing details.

Include the affected commit, Paseo app and daemon versions, operating systems, reproduction steps using non-sensitive fixtures, and expected versus actual behavior. This is a community project with no guaranteed response time. Fixes target the latest main branch; older snapshots are not maintained separately.

## Trust model

Paseo plugins are trusted, unsandboxed code. This plugin's backend inspects processes and controls configured workspace services. Its client can create SSH tunnel terminals on the selected viewing host. Install it only on hosts and Paseo connections you trust; it is not a separate multi-tenant authorization layer.

Connection settings identify one viewing host, a helper workspace, and an SSH target. Settings are host-scoped and shared by that host's authorized Paseo clients. The SSH target is resolved using the viewing host's SSH configuration, which must also be trusted. The plugin does not store passwords or private keys, configure SSH authentication, or accept unknown host keys. Existing key authentication and host-key trust are prerequisites.

Forwarding binds to `127.0.0.1` on the viewing host and targets loopback on the workspace host. Each tunnel uses a private SSH control socket; disconnect closes the owned tunnel and leaves the application running. Loopback binding prevents LAN exposure through this forward, but does not authenticate other applications or users on the same viewing host. Keep sensitive applications protected appropriately.

Detected ports are scoped by process working directory. This does not prove that an agent started a process or that its listener is a website. Only configured Paseo services receive start/stop controls; detected processes are not killed. Application logs and terminal diagnostics may contain secrets; review and redact them before sharing.

The plugin does not configure Tailscale, public access, or application authentication. Its loopback forwarding does not change how the remote application itself is bound or exposed. Network loss can end a tunnel; reopening is manual.
