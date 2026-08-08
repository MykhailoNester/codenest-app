"""Database/app-data path resolution per CODENEST_ENV.

These pin the guarantee the `work` profile exists for: the persistent dev
workboard must resolve to a root outside the repo and outside the packaged
app's directory, and no other profile may ever resolve to it.
"""

import sys

import pytest

from app import config

_ENV_VARS = ("CODENEST_ENV", "CODENEST_DB_PATH", "CODENEST_APP_DATA_DIR")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Resolve from a known-empty environment, whatever the runner exported."""
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)


def test_dev_default_is_the_demo_db(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    assert config._resolve_env() == "demo"
    assert config._resolve_db_path() == config.DATA_DIR / "codenest.demo.db"


def test_packaged_default_is_the_app_support_db(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    # Redirected so resolution can't create the real app-support directory.
    monkeypatch.setattr(config, "APP_SUPPORT", tmp_path / "com.codenest.dashboard")
    monkeypatch.setattr(config, "_is_frozen", lambda: True)

    assert config._resolve_env() == "prod"
    assert config._resolve_db_path() == config.APP_SUPPORT / "codenest.db"


def test_work_db_lives_in_the_injected_app_data_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    monkeypatch.setenv("CODENEST_ENV", "work")
    monkeypatch.setenv("CODENEST_APP_DATA_DIR", str(tmp_path))

    assert config._resolve_db_path() == tmp_path / "codenest.db"


def test_work_falls_back_to_its_own_root_when_nothing_is_injected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Standalone runs must land where the shell would have pointed them."""
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    monkeypatch.setenv("CODENEST_ENV", "work")

    app_data = config._resolve_app_data_dir()
    assert app_data.name == config.DEV_APP_DATA_DIR_NAME
    # Never the repo, and never the packaged app's directory.
    assert config.PROJECT_ROOT not in app_data.parents
    assert app_data != config.APP_SUPPORT


@pytest.mark.skipif(sys.platform != "darwin", reason="APP_SUPPORT is the macOS layout")
def test_work_root_is_a_sibling_of_the_packaged_app_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The Rust shell derives its root as `<parent of app_data_dir>/<name>`;
    both sides must agree or the shell and sidecar open different directories."""
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    monkeypatch.setenv("CODENEST_ENV", "work")

    expected = config.APP_SUPPORT.parent / config.DEV_APP_DATA_DIR_NAME
    assert config._resolve_app_data_dir() == expected


@pytest.mark.parametrize("env", ["demo", "prod"])
def test_other_profiles_never_touch_the_work_root(
    monkeypatch: pytest.MonkeyPatch, env: str
) -> None:
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    monkeypatch.setenv("CODENEST_ENV", env)

    assert config.DEV_APP_DATA_DIR_NAME not in str(config._resolve_db_path())


def test_unknown_env_falls_back_to_the_default_not_prod(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo must not silently open a different database."""
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    monkeypatch.setenv("CODENEST_ENV", "wrok")

    assert config._resolve_env() == "demo"
    assert config._resolve_db_path() == config.DATA_DIR / "codenest.demo.db"


def test_env_value_is_case_and_whitespace_insensitive(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    monkeypatch.setenv("CODENEST_ENV", "  WORK ")
    monkeypatch.setenv("CODENEST_APP_DATA_DIR", str(tmp_path))

    assert config._resolve_env() == "work"
    assert config._resolve_db_path() == tmp_path / "codenest.db"


def test_explicit_db_path_wins_over_the_profile(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(config, "_is_frozen", lambda: False)
    monkeypatch.setenv("CODENEST_ENV", "work")
    monkeypatch.setenv("CODENEST_DB_PATH", str(tmp_path / "explicit.db"))

    assert config._resolve_db_path() == tmp_path / "explicit.db"
