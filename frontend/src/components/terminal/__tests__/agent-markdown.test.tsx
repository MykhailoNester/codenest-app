// Coverage for the assistant-text renderer. The fixtures are the shapes that
// were visibly broken when the pane printed markdown verbatim — a GFM pipe
// table arriving as rows of `|---|---|` above all — plus the two rules that
// make rendering model output inside the app's own webview safe: no raw HTML,
// and no link that navigates the app away.
//
// `react-markdown` and `remark-gfm` are used for real here (not mocked as in
// `doc-preview-modal.test.tsx`): the whole point is what the parser produces.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentMarkdown } from "../agent-markdown";
import { AgentConversation } from "../agent-conversation";
import {
  appendUserTurn,
  emptyConversation,
  type ConversationState,
} from "../../../lib/agent-conversation";

const { openPathMock } = vi.hoisted(() => ({ openPathMock: vi.fn() }));

vi.mock("../../../lib/ipc", () => ({
  openPath: (path: string) => openPathMock(path),
}));

beforeEach(() => {
  openPathMock.mockReset();
  openPathMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function noop(): void {
  /* conversation callback stub */
}

function assistantState(text: string): ConversationState {
  return {
    ...emptyConversation(),
    status: "idle",
    turns: [
      {
        id: "t1",
        role: "assistant",
        at: 0,
        blocks: [{ type: "text", text }],
      },
    ],
  };
}

describe("AgentMarkdown", () => {
  it("renders a GFM pipe table as a table, not as rows of pipes", () => {
    render(
      <AgentMarkdown
        text={[
          "| Project | Path | What it is |",
          "|---|---|---|",
          "| **CodeNest** | `~/Documents/Work/CodeNest` | The umbrella directory |",
          "| **miragold** | `…/CodeNest/miragold` | Jewelry inventory app |",
        ].join("\n")}
      />,
    );

    const table = document.querySelector("table");
    expect(table).not.toBeNull();
    expect(
      Array.from(table!.querySelectorAll("th")).map((th) => th.textContent),
    ).toEqual(["Project", "Path", "What it is"]);
    expect(table!.querySelectorAll("tbody tr")).toHaveLength(2);
    // The delimiter row is structure, never content.
    expect(screen.queryByText(/\|---\|/)).toBeNull();
    expect(document.body.textContent).not.toContain("| Project |");
  });

  it("renders emphasis and inline code as elements instead of their markers", () => {
    render(<AgentMarkdown text="**31 °C**, sunny — run `make check-all`" />);

    expect(screen.getByText("31 °C").tagName).toBe("STRONG");
    expect(screen.getByText("make check-all").tagName).toBe("CODE");
    expect(document.body.textContent).not.toContain("**");
    expect(document.body.textContent).not.toContain("`");
  });

  it("renders a bullet list as list items", () => {
    render(
      <AgentMarkdown text={"- Humidity 34%\n- UV index 7\n- Range 17 → 33"} />,
    );

    const items = Array.from(document.querySelectorAll("li")).map(
      (li) => li.textContent,
    );
    expect(items).toEqual(["Humidity 34%", "UV index 7", "Range 17 → 33"]);
  });

  it("opens a link through the system opener instead of navigating the webview", () => {
    render(<AgentMarkdown text="Sources: [wttr.in](https://wttr.in/Lviv)" />);

    const link = screen.getByText("wttr.in");
    expect(link.tagName).toBe("A");
    const clicked = fireEvent.click(link);

    expect(openPathMock).toHaveBeenCalledWith("https://wttr.in/Lviv");
    // `false` from fireEvent means the default action was prevented — the pane
    // must not be replaced by the fetched page.
    expect(clicked).toBe(false);
  });

  it("does not render embedded HTML", () => {
    render(
      <AgentMarkdown text={'Text <img src="x" onerror="boom"> and <b>more</b>'} />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("renders a fenced code block as a pre, keeping its own line breaks", () => {
    render(<AgentMarkdown text={"```sh\nmake check-all\nls -la\n```"} />);

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("make check-all\nls -la\n");
    expect(document.body.textContent).not.toContain("```");
  });
});

describe("conversation text blocks", () => {
  it("renders an assistant turn as markdown", () => {
    render(
      <AgentConversation
        state={assistantState("**Four projects** are registered")}
        isFocusedPane
        onAllowPermission={noop}
        onAllowPermissionSession={noop}
        onDenyPermission={noop}
      />,
    );

    expect(screen.getByText("Four projects").tagName).toBe("STRONG");
  });

  it("shows a user turn exactly as typed", () => {
    // The user's own text is never re-parsed: this message would otherwise lose
    // its asterisks to emphasis and its pipes to a table.
    const typed = "keep **literal** and | pipes | intact";
    render(
      <AgentConversation
        state={appendUserTurn(emptyConversation(), typed, 0)}
        isFocusedPane
        onAllowPermission={noop}
        onAllowPermissionSession={noop}
        onDenyPermission={noop}
      />,
    );

    expect(screen.getByText(typed)).toBeTruthy();
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });
});
