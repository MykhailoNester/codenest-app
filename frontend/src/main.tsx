import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/d3-creative.css";
import "./styles/d3-taskboard.css";
// Scoped to .deck — inert until a surface opts in (#277).
import "./styles/deck.css";
import "./index.css";

import { App } from "./App";
import { RootErrorBoundary } from "./components/root-error-boundary";
import { installViewportLock } from "./lib/viewport-lock";
import { installTauriWebMock } from "./lib/tauri-web-mock";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

// Outside Tauri there is no __TAURI_INTERNALS__, so every @tauri-apps call
// throws and the startup splash never clears. Must run before the first
// render; a no-op in the packaged app.
if (installTauriWebMock()) {
  console.info("[codenest] Tauri web mock installed — native shell is faked.");
}

// Before the first render, and never torn down: the root has to track the
// window even when the window changes size under a reload (#43).
installViewportLock(rootEl);

createRoot(rootEl).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
