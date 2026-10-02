import { useEffect, type ReactElement } from "react";
import { DeckGrid, DeckHead, DeckLine } from "../../components/deck/deck-grid";
import { StepHead, StepNote } from "./step-chrome";

interface Props {
  registerCommit: (fn: () => Promise<void>) => void;
}

/** The two launch modes, as rows rather than the pair of cards they were. */
const MODE_COLS = "14px 64px minmax(0, 1fr) 190px";

export function WelcomeStep({ registerCommit }: Props): ReactElement {
  // Purely informational — no commit work needed.
  useEffect(() => {
    registerCommit(() => Promise.resolve());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <StepHead kicker="initialize" title="Your command center workspace">
        Codenest runs every AI session from a single{" "}
        <strong>app-managed workspace</strong> — a control room that knows about
        all your projects, agents, and skills. We&apos;ll set it up in a few
        steps. The workspace is one unit today, built to grow into many later.
      </StepHead>

      <div className="dk-group">
        <h2 className="dk-group__h">
          <span>Session modes</span>
          <span className="n">2</span>
        </h2>
        <DeckGrid cols={MODE_COLS} label="Session modes">
          <DeckHead cells={["mode", "scope", "cwd"]} />
          <DeckLine
            state="run"
            cells={[
              "01",
              {
                v: "Workspace session — every imported project, all promoted agents, the full path registry",
                cls: "sub",
              },
              "/workspace · all agents",
            ]}
          />
          <DeckLine
            state="todo"
            cells={[
              "02",
              {
                v: "Project session — scoped to one project; only that project's agents load",
                cls: "sub",
              },
              "/project · scoped agents",
            ]}
          />
        </DeckGrid>
      </div>

      <StepNote glyph="◇">
        Your projects are treated as <strong>read-only sources</strong>. Nothing
        is ever written into their folders — their git history stays clean. All
        links live inside the workspace.
      </StepNote>
    </>
  );
}
