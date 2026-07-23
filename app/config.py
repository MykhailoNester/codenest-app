import os
import sys
from pathlib import Path

import platformdirs

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
APP_SUPPORT = Path.home() / "Library" / "Application Support" / "com.codenest.dashboard"


def _is_frozen() -> bool:
    # PyInstaller sets sys.frozen on the bundled release sidecar.
    return bool(getattr(sys, "frozen", False))


def _resolve_env() -> str:
    # Packaged (frozen) builds serve real users → prod. Every dev run defaults
    # to demo so day-to-day work can never touch the real database.
    default_env = "prod" if _is_frozen() else "demo"
    return os.environ.get("CODENEST_ENV", default_env).strip().lower()


def _resolve_app_data_dir() -> Path:
    # 1. Explicit env var set by the Tauri shell at launch (release + debug builds).
    raw = os.environ.get("CODENEST_APP_DATA_DIR")
    if raw:
        return Path(raw)
    # 2. Cross-platform user-data dir via platformdirs (standalone dev / tests).
    return Path(platformdirs.user_data_dir("Codenest", "Codenest"))


def _resolve_db_path() -> Path:
    # 1. Explicit absolute override always wins (tests, CI, power users).
    env_path = os.environ.get("CODENEST_DB_PATH")
    if env_path:
        return Path(env_path)

    # 2. Named environment selects between the demo and prod databases.
    if _resolve_env() == "demo":
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        return DATA_DIR / "codenest.demo.db"

    # prod
    if _is_frozen():
        # Production (Tauri .app): ~/Library/Application Support/com.codenest.dashboard/
        APP_SUPPORT.mkdir(parents=True, exist_ok=True)
        return APP_SUPPORT / "codenest.db"
    # Dev prod: the real working DB lives in the repo data dir.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR / "codenest.db"


class Settings:
    PROJECT_ROOT = PROJECT_ROOT
    ENV: str = _resolve_env()
    DATABASE_PATH: Path = _resolve_db_path()
    # The sidecar serves on loopback :8002 — matches SIDECAR_PORT in the Rust
    # shell and the frontend's API base URL. Overridable via env for ad-hoc runs.
    PORT = int(os.environ.get("CODENEST_SIDECAR_PORT", "8002"))
    HOST = "127.0.0.1"

    # Command Center — Phase 1.
    # APP_DATA_DIR is either injected by the Tauri shell (CODENEST_APP_DATA_DIR)
    # or resolved cross-platform via platformdirs for dev / test runs.
    APP_DATA_DIR: Path = _resolve_app_data_dir()
    WORKSPACE_ROOT: Path = APP_DATA_DIR / "workspace"
    ORG_AGENTS_DIR: Path = APP_DATA_DIR / "org-agents"
    # BUNDLE_RESOURCES is set by the Tauri shell to <app>.app/Contents/Resources/org-agents.
    # Unset in dev: fall back to the checked-in source directory.
    BUNDLE_RESOURCES: Path = Path(
        os.environ.get("CODENEST_BUNDLE_RESOURCES")
        or str(PROJECT_ROOT / "src-tauri" / "resources" / "org-agents")
    )


settings = Settings()
