// Single source of truth for the sidecar base URL.
//
// Kept in its own dependency-free module so that BOTH `api.ts` and
// `sse-registry.ts` can import it without forming an import cycle. Previously
// `sse-registry.ts` imported this constant from `api.ts` while `api.ts` imports
// `sse-registry.ts` — at app load that cycle put the constant in the temporal
// dead zone and threw a ReferenceError before React could mount (black screen).
//
// In dev this targets the local FastAPI uvicorn process on 127.0.0.1:8002; in
// production it targets the embedded PyInstaller sidecar on the same loopback
// URL. `VITE_SIDECAR_URL` overrides it.
export const SIDECAR_BASE_URL =
  import.meta.env.VITE_SIDECAR_URL ?? "http://127.0.0.1:8002";
