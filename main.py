import os

import uvicorn

from app import create_app

app = create_app()

if __name__ == "__main__":
    # This entrypoint is what the frozen PyInstaller sidecar runs in a packaged
    # release. (Dev never reaches here: the Tauri shell spawns
    # `uvicorn main:app --port 8002` directly — see src-tauri/src/sidecar/mod.rs.)
    #
    # The Rust shell's health-check and the frontend both target :8002
    # (SIDECAR_PORT), so the packaged sidecar MUST bind 8002 on loopback.
    #
    # No reload: uvicorn's StatReload reloader is broken inside a onefile binary
    # (it re-execs sys.executable and watches source dirs that don't exist in the
    # bundle), and it has no purpose in a shipped app.
    port = int(os.environ.get("CODENEST_SIDECAR_PORT", "8002"))
    uvicorn.run(app, host="127.0.0.1", port=port)
