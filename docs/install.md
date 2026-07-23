# Installing Codenest

Codenest ships as a macOS `.dmg` for Apple Silicon (arm64).

## Install from the DMG

1. Download the latest `.dmg` from the
   [Releases page](https://github.com/MykhailoNester/codenest-app/releases).
2. Open the `.dmg`.
3. Drag **Codenest.app** into your `/Applications` folder.

## First launch (unsigned app)

Codenest releases are **ad-hoc signed / unsigned** — there is no paid Apple
Developer identity behind them. macOS Gatekeeper will therefore block the first
launch. Clear the quarantine attribute, then allow the app:

```bash
xattr -cr /Applications/Codenest.app
```

Then launch the app. If macOS still refuses to open it:

- **macOS 15 (Sequoia) and newer:** open **System Settings → Privacy &
  Security**, scroll to the Security section, and click **Open Anyway** next to
  the Codenest message. Confirm the prompt.
- **Older macOS:** right-click (or Control-click) **Codenest.app** in
  `/Applications`, choose **Open**, and confirm the dialog. You only need to do
  this once.

The first launch takes a few extra seconds while the bundled sidecar is
extracted (see the [FAQ](faq.md)); later launches are fast.

## Where your data lives

All app data is stored under:

```
~/Library/Application Support/com.codenest.dashboard/
```

This directory holds:

- `codenest.db` — the SQLite database (all your state).
- `sidecar/` — the extracted Python sidecar for this app version.
- `workspace/` — the Command Center workspace.
- `org-agents/` — the installed bundled agents.

This directory **persists across DMG reinstalls** — reinstalling or updating the
app does not touch your data.

## Fully resetting the app

To wipe all state and start from a clean first-run:

1. Quit Codenest.
2. Delete the data directory:

   ```bash
   rm -rf ~/Library/Application\ Support/com.codenest.dashboard
   ```

3. Launch the app again — it will re-bootstrap from scratch.
