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

const { openExternalUrlMock, toastErrorMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("../../../lib/ipc", () => ({
  openExternalUrl: (url: string) => openExternalUrlMock(url),
}));

vi.mock("sonner", () => ({ toast: { error: (m: string) => toastErrorMock(m) } }));

beforeEach(() => {
  openExternalUrlMock.mockReset().mockResolvedValue(undefined);
  toastErrorMock.mockReset();
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
          "| **workspace** | `~/code/workspace` | The umbrella directory |",
          "| **mercury** | `…/code/mercury` | Inventory app |",
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

    expect(openExternalUrlMock).toHaveBeenCalledWith("https://wttr.in/Lviv");
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

  it("offers markdown images as a click instead of fetching them", () => {
    // `![](…)` is markdown, so it survives the no-raw-HTML rule and would
    // otherwise hit the network the moment the reply renders — no CSP stands in
    // the way. A tracking pixel in a page the model just quoted back would then
    // report the user's address with nothing clicked.
    render(
      <AgentMarkdown text="![a chart](https://tracker.example/pixel.gif)" />,
    );

    expect(document.querySelector("img")).toBeNull();
    const link = screen.getByText(/a chart/);
    expect(link.tagName).toBe("A");

    fireEvent.click(link);
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://tracker.example/pixel.gif",
    );
  });

  it("labels an image with no alt text rather than rendering an empty link", () => {
    render(<AgentMarkdown text="![](https://example.com/x.png)" />);

    expect(screen.getByText(/image/).tagName).toBe("A");
  });

  it("renders a fenced code block as a pre, keeping its own line breaks", () => {
    render(<AgentMarkdown text={"```sh\nmake check-all\nls -la\n```"} />);

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("make check-all\nls -la\n");
    expect(document.body.textContent).not.toContain("```");
  });

  // `.dk-prose` has no `pre` rule at all, so the Deck conversion (#283) had to
  // supply one through react-markdown's `components` map. These pin what that
  // rule is for: a long unbroken line must stay inside the frame — scrolling
  // the fence, not widening the pane and dragging the whole transcript
  // sideways with it.
  it("scrolls a fence rather than letting a long line widen the pane", () => {
    render(
      <AgentMarkdown
        text={"```\n/a/very/long/path/that/keeps/going/and/going/and/going.ts\n```"}
      />,
    );
    const pre = document.querySelector("pre")!;
    expect(pre.style.overflowX).toBe("auto");
    const code = pre.querySelector("code")!;
    // `pre`, not `pre-wrap`: a wrapped command line or diff is harder to read
    // than one the reader scrolls.
    expect(code.style.whiteSpace).toBe("pre");
    expect(code.style.wordBreak).toBe("normal");
    // The fenced `code` must not keep the inline chip's background.
    expect(code.style.background).toBe("none");
  });

  it("keeps the inline code chip distinct from a fenced block", () => {
    render(<AgentMarkdown text={"a `chip` here"} />);
    const code = document.querySelector("code")!;
    expect(document.querySelector("pre")).toBeNull();
    expect(code.style.background).toBe("var(--sel)");
    // Inline code breaks mid-token so a long symbol cannot widen the reply.
    expect(code.style.wordBreak).toBe("break-word");
  });

  it("scrolls a wide table inside its own wrapper", () => {
    render(
      <AgentMarkdown
        text={["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n")}
      />,
    );
    const table = document.querySelector("table")!;
    expect((table.parentElement as HTMLElement).style.overflowX).toBe("auto");
    // The header rules below itself and body cells rule above themselves, so
    // no hairline is drawn after the last row — the old `tbody tr:last-child`
    // reset, carried over without needing to know which row is last.
    expect(document.querySelector("th")!.style.borderBottom).toBe("1px solid var(--line)");
    const cells = Array.from(document.querySelectorAll("td"));
    expect(cells.length).toBe(4);
    for (const td of cells) {
      expect(td.style.borderTop).toBe("1px solid var(--line)");
      expect(td.style.borderBottom).toBe("");
    }
  });

  it("drops the bullet from a GFM task list, keeping the checkbox as the marker", () => {
    render(<AgentMarkdown text={"- [x] done\n- [ ] todo"} />);
    const list = document.querySelector("ul")!;
    expect(list.style.listStyle).toBe("none");
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect((box as HTMLInputElement).disabled).toBe(true);
      expect((box as HTMLInputElement).style.pointerEvents).toBe("none");
    }
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
        onAnswerQuestion={noop}
        onOpenSubagent={noop}
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
        onAnswerQuestion={noop}
        onOpenSubagent={noop}
      />,
    );

    expect(screen.getByText(typed)).toBeTruthy();
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });
});

describe("link failures are visible", () => {
  it("reports a refused open instead of leaving the click looking dead", async () => {
    // A swallowed rejection is why a link that opened nothing read as a dead
    // element rather than a refused call.
    openExternalUrlMock.mockRejectedValue(new Error("refusing to open"));
    render(<AgentMarkdown text="[site](https://example.com)" />);

    fireEvent.click(screen.getByText("site"));
    await vi.waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));

    expect(String(toastErrorMock.mock.calls[0]?.[0])).toContain("refusing to open");
  });

  it("opens on \u2318-click too, since the default is prevented either way", () => {
    render(<AgentMarkdown text="[site](https://example.com)" />);

    fireEvent.click(screen.getByText("site"), { metaKey: true });

    expect(openExternalUrlMock).toHaveBeenCalledWith("https://example.com");
  });
});
