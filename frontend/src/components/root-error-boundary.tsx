import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[root] unhandled render error", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "flex-start",
          padding: 32,
          height: "100%",
          overflow: "auto",
          font: "13px/1.6 var(--font-sans, system-ui)",
          color: "var(--fg-0, #e6e8ef)",
          background: "var(--bg-0, #0b0e18)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16 }}>Codenest hit a render error</h1>
        <p style={{ margin: 0, color: "var(--fg-2, #8b91a3)", maxWidth: 560 }}>
          The window would otherwise have gone blank. Your data is untouched —
          this is the frontend only.
        </p>
        <pre
          style={{
            margin: 0,
            padding: 12,
            maxWidth: "100%",
            overflow: "auto",
            borderRadius: 8,
            background: "rgba(255,255,255,0.04)",
            font: "12px/1.5 var(--font-mono, ui-monospace, monospace)",
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ""}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            cursor: "pointer",
            color: "inherit",
            border: "1px solid var(--line-1, rgba(255,255,255,0.12))",
            background: "rgba(255,255,255,0.06)",
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
