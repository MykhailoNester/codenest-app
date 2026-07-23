# Security Policy

## Supported versions

Only the latest published release receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub Security Advisories:
open the repository's **Security** tab and choose **Report a vulnerability**.
Please do not open a public issue for a suspected vulnerability, and do not send
reports by email.

## Trust model

Codenest is a **local-first, single-user desktop app**. Several behaviors that
would be concerning in a networked service are intentional here — knowing the
model helps you use and audit the app correctly.

- **The sidecar is loopback-only and unauthenticated.** The FastAPI sidecar
  binds `127.0.0.1:8002` and has no authentication layer. It is consumed
  exclusively by the local Tauri shell running as the same user. The bind
  address and CORS allowlist must never be widened — the rest of this trust
  model depends on the sidecar being unreachable from the network.

- **MCP server management is a hidden, work-in-progress feature.** It is
  disabled by default under **Settings → Features** and not yet generally
  available. Its sidecar backend still ships in every build, though, and the
  sidecar is unauthenticated — so the two caveats below already apply whenever
  the feature is enabled or the local API is called directly:

  - **Registering or testing an MCP server executes a local command by design.**
    MCP server entries store a `command` and `args`, and testing a server runs
    them directly on your machine. The author of an MCP config *is* the person
    who can execute it, so this is treated as trusted local input. The command
    is run in argv form (no shell) with a timeout and capped output as
    defence-in-depth, but it is **not sandboxed**. Only register MCP servers you
    trust.

  - **MCP server environment values are stored in plaintext.** Any `env` values
    attached to an MCP server are persisted in the local SQLite database as
    plain text. **Do not put production secrets there.** OS Keychain support is
    on the roadmap.

- **No telemetry.** The app collects and transmits no usage data, crash
  reports, or analytics. All state stays in the local database.
