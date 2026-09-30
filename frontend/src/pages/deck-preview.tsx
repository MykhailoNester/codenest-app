import { type ReactElement } from "react";
import { DeckShell } from "../components/deck/deck-shell";
import { DeckGrid, DeckGroup, DeckHead, DeckLine, DECK_COLS } from "../components/deck/deck-grid";

/**
 * Shows the Deck chrome on real data at `/deck`, so the shell can be reviewed
 * beside the old one before any page moves into it. The surfaces themselves
 * land in #281 and #282; this route goes away with them.
 */
export function DeckPreviewPage(): ReactElement {
  return (
    <DeckShell title="deck" crumb="the shell, on real rail and status data">
      <DeckGroup label="what is here" count={3} note="#280">
        <DeckGrid cols={DECK_COLS.simple} label="what is here">
          <DeckHead cells={["part", "r state"]} />
          <DeckLine state="done" cells={["the rail — nine kept surfaces, live counts", "done"]} />
          <DeckLine state="done" cells={["the status line — running, need you, stalled, spend", "done"]} />
          <DeckLine state="done" cells={["the line primitive, composing inside the shell", "done"]} />
        </DeckGrid>
      </DeckGroup>

      <DeckGroup label="what lands next" count={2}>
        <DeckGrid cols={DECK_COLS.simple} label="what lands next">
          <DeckHead cells={["ticket", "r state"]} />
          <DeckLine state="todo" cells={["#281 — convert Needs You, Work, Agents, Projects, Sessions", "todo"]} />
          <DeckLine state="todo" cells={["#282 — the Deck home screen and “since you last looked”", "todo"]} />
        </DeckGrid>
      </DeckGroup>

      <div className="dk-note sans">
        Everything inside this frame carries <code>.deck</code>, which is what scopes the design
        system. The old theme is untouched on every other route — compare this against Mission
        Control in the same window.
      </div>
    </DeckShell>
  );
}
