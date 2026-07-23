"""Guards the sidecar readiness contract the Rust shell depends on.

The Tauri shell polls ``GET /health`` and treats an HTTP 200 as "the sidecar is
ready" (see src-tauri/src/sidecar/mod.rs `health_ok`). For that contract to
hold, ``/health`` MUST:

  * return 200 as soon as the HTTP server is up, and
  * NOT depend on the DB / the startup hook / the deferred bootstrap.

uvicorn opens the listening socket only after the lifespan startup hook
(``init_db``) completes, so a 200 implies the schema is applied and the REST
API — including ``GET /api/v1/command-center/onboarding`` — will answer. This
test asserts ``/health`` itself is trivial and DB-free by hitting it WITHOUT
running the lifespan (TestClient outside a context manager does not fire
startup/shutdown), so a regression that makes ``/health`` touch the DB would
fail here.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import create_app


def test_health_returns_200_without_startup_or_db() -> None:
    """/health answers 200 with a static body and no lifespan/DB access."""
    app = create_app()
    # No `with` block -> Starlette does NOT run the lifespan (startup/shutdown),
    # so init_db never fires and there is no DB connection. A /health handler
    # that reached for the DB would raise here.
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body
