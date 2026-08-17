import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/d3-creative.css";
import "./styles/d3-taskboard.css";
import "./styles/d3-taskdetail.css";
import "./styles/d3-launch.css";
import "./index.css";

import { App } from "./App";
import { installViewportLock } from "./lib/viewport-lock";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

// Before the first render, and never torn down: the root has to track the
// window even when the window changes size under a reload (#43).
installViewportLock(rootEl);

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
