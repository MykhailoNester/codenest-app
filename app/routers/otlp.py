"""OTLP/HTTP receiver routes — Lane B ingest (epic #153 / #175).

Thin, like every router here: parse the request, hand the bytes to
`otlp_receiver_service`, render its answer. All the policy — which instruments
are stored, what a single export may assert, what this endpoint does and does
not trust — lives in that module's header and not here.

Why these routes are not under `/api/v1`
========================================
Because the protocol chooses the path, not us. An OTLP/HTTP exporter appends
`v1/metrics` to whatever `OTEL_EXPORTER_OTLP_ENDPOINT` names, so a user who
sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8002` posts to
`/v1/metrics` and nothing else. Mounting it at `/api/v1/otlp/...` would work
only for someone who knew to set `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to the
full path by hand, which is the configuration nobody has. The deviation from
the app's convention is the protocol's; `/health` is already the other route
that sits outside `/api/v1` for an equivalent reason.

Why `/v1/logs` and `/v1/traces` exist and answer 501
====================================================
So the refusal is legible. A user who turns on `OTEL_LOGS_EXPORTER=otlp`
against this sidecar would otherwise get FastAPI's bare 404 "Not Found" and no
way to tell a wrong port from an unsupported signal. 501 also tells an OTLP
exporter the batch is permanently rejected, so it drops it instead of retrying
on a timer forever. Neither handler reads its request body: the logs signal is
the one carrying prompt and response text, and there is no reason for it to
enter this process even transiently.

`/v1/traces` is refused today for a narrower reason than `/v1/logs` — see the
receiver's docstring on `claude_code.hook`. Spans are where hook, tool and
LLM-request latency actually live. #178 owns that surface and owns the
question of whether this route should become real.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import otlp_receiver_service, otlp_reconcile_service

router = APIRouter()
log = logging.getLogger(__name__)

# OTLP/HTTP carries either protobuf or JSON. We read only JSON — see the
# service docstring on taking zero new dependencies — so a protobuf body is
# refused with the one-line fix rather than parsed badly.
_JSON_CONTENT_TYPES = ("application/json",)
_PROTOBUF_HINT = (
    "this receiver reads OTLP JSON only; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json"
)


def _status(code: int, message: str) -> JSONResponse:
    """An OTLP error response.

    The spec asks for a `google.rpc.Status`; its JSON mapping is an object with
    `code` and `message`, which is what this returns. Exporters log the
    message, which is the only reason to be careful about its wording — it is
    the one place a misconfigured user will actually read.
    """
    return JSONResponse({"code": code, "message": message}, status_code=code)


@router.post("/v1/metrics")
async def otlp_metrics(request: Request) -> JSONResponse:
    """Accept one OTLP/HTTP JSON metrics export.

    Always answers; never raises into the app's generic 500 handler. The
    success body is an `ExportMetricsServiceResponse`: `{"partialSuccess": {}}`
    when everything landed, and a populated `partialSuccess` when some points
    did not. That block is the protocol's own channel for "I took your export
    but not all of it", and it is how an unjoinable export gets reported back
    to the thing that sent it instead of disappearing — the receiver also
    counts it and logs it (rate-limited), but this is the half the sender sees.

    A rejected *point* is a 200 with `rejectedDataPoints`. A rejected
    *request* — unreadable body, wrong protocol, too large — is a 4xx, because
    there is no partial anything to report.
    """
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip()
    if content_type and not content_type.lower().startswith(_JSON_CONTENT_TYPES):
        return _status(
            415, f"unsupported Content-Type {content_type!r}: {_PROTOBUF_HINT}"
        )

    # Cheap pre-check before the body is materialised, mirroring
    # `routers/_http.read_json_body`. The service re-checks the real length,
    # since Content-Length is a claim by the sender.
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > otlp_receiver_service.MAX_BODY_BYTES:
                return _status(413, f"body too large ({declared} bytes)")
        except ValueError:
            pass

    try:
        raw = await request.body()
    except Exception:
        log.exception("otlp receiver: request body could not be read")
        return _status(400, "request body could not be read")

    db = await get_db()
    try:
        result = await otlp_receiver_service.ingest(
            db, raw, request.headers.get("content-encoding")
        )
    except otlp_receiver_service.OtlpRejected as exc:
        return _status(exc.status_code, exc.detail)
    except Exception:
        # Deliberately broad, and deliberately not re-raised. This is the only
        # route whose input is written by something outside the app; a shape we
        # failed to anticipate must cost the exporter one dropped batch, not a
        # 500 in the app's error log and a retry storm on a five-second timer.
        log.exception("otlp receiver: ingest failed")
        return JSONResponse(
            {
                "partialSuccess": {
                    "rejectedDataPoints": 0,
                    "errorMessage": "receiver error; export dropped",
                }
            }
        )

    # Lane B's observations are stored; now let them supersede the app's own
    # estimate (#176). Deliberately *after* `ingest` has committed and outside
    # its try block, for two separate reasons: the export is already durable, so
    # a reconciliation fault must not be reported to the exporter as a dropped
    # batch; and the service swallows its own failures, so there is nothing
    # here to catch. All the policy — which fields, what a missing observation
    # means, what happens to a late figure that disagrees — lives in that
    # module's header, not in this router.
    #
    # Runs even when some points were rejected: an export of forty points with
    # one bad attribute stored thirty-nine, and those thirty-nine are as
    # reconcilable as a clean export's would be.
    await otlp_reconcile_service.reconcile_recent(db)

    if not result.rejected_points:
        return JSONResponse({"partialSuccess": {}})

    reasons = ", ".join(
        f"{reason}={count}" for reason, count in sorted(result.rejections.items())
    )
    return JSONResponse(
        {
            "partialSuccess": {
                # OTLP renders int64 as a string in JSON. Exporters accept both;
                # the string spelling is the one the spec's mapping asks for.
                "rejectedDataPoints": str(result.rejected_points),
                "errorMessage": f"rejected data points: {reasons}",
            }
        }
    )


@router.post("/v1/logs")
async def otlp_logs() -> JSONResponse:
    """Refuse the logs signal without reading the body. See the module header."""
    return _status(
        501,
        "OTLP logs are not accepted by this receiver: the logs signal carries"
        " prompt and response content this app does not store, and nothing"
        " downstream reads it. Metrics are accepted at /v1/metrics.",
    )


@router.post("/v1/traces")
async def otlp_traces() -> JSONResponse:
    """Refuse the traces signal. See the module header."""
    return _status(
        501,
        "OTLP traces are not accepted by this receiver yet. Metrics are"
        " accepted at /v1/metrics.",
    )
