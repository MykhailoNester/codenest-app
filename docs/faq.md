# FAQ

## Is Codenest signed / notarized?

No. Releases are **ad-hoc signed (effectively unsigned)** and are not notarized.
macOS Gatekeeper will block the first launch; see
[install.md](install.md) for the `xattr -cr` step and the **Open Anyway** flow.

## Is it Apple Silicon only?

For now, yes. Development targets Apple Silicon (arm64), and releases are shipped
as `aarch64` (arm64) DMGs — the sidecar is packaged for the host architecture at
build time. There are no Intel (x86_64) or universal builds today.

## Where is my data? Is anything sent anywhere?

Everything is local. State lives in a SQLite database under
`~/Library/Application Support/com.codenest.dashboard/`. The sidecar that owns
that database binds `127.0.0.1` only and is unreachable from the network. The
app sends **no telemetry** — no analytics, no crash reporting, nothing leaves
your machine.

## How do I back up my data?

Quit Codenest, then copy the app-data directory somewhere safe:

```bash
cp -R ~/Library/Application\ Support/com.codenest.dashboard ~/codenest-backup
```

Restore by copying it back while the app is not running.

## Why does the first launch take a moment?

The app bundles its Python sidecar as a compressed archive. On first launch (and
after each version update) that archive is extracted once into the app-data
directory. Subsequent launches reuse the extracted copy and start quickly.

## Where are the logs for a bug report?

Release builds do not write to a dedicated log file — the file logger is enabled
in development builds only. To capture output for a bug report, launch the app
from Terminal so the shell and sidecar print their logs to the console:

```bash
/Applications/Codenest.app/Contents/MacOS/Codenest
```

Reproduce the issue, then copy the relevant console output into your report. You
can also filter for the `Codenest` process in **Console.app** while the app is
running.
