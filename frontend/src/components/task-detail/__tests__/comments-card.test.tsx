// `react-markdown` and `remark-gfm` run for real here: the raw-HTML case is
// the acceptance criterion, and a mocked renderer would prove nothing about
// what a comment body actually does in the DOM.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CommentsCard, type CommentsCardProps } from "../comments-card";
import type { TaskComment } from "../../../lib/api";

vi.mock("../../../lib/ipc", () => ({ openExternalUrl: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(cleanup);

function makeComment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: 1,
    task_id: 9,
    author_id: null,
    author_kind: "operator",
    author_name: null,
    body: "looks good",
    created_at: "2026-08-11 13:34:21",
    updated_at: "2026-08-11 13:34:21",
    ...overrides,
  };
}

function renderCard(overrides: Partial<CommentsCardProps> = {}) {
  const props: CommentsCardProps = {
    comments: [],
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    onPost: vi.fn().mockResolvedValue(undefined),
    onSaveEdit: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CommentsCard {...props} />) };
}

describe("CommentsCard", () => {
  it("cannot submit an empty draft", () => {
    const { props } = renderCard();
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Write a comment"), {
      target: { value: "   " },
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(props.onPost).not.toHaveBeenCalled();
  });

  it("a failed post keeps the draft", async () => {
    const onPost = vi.fn().mockRejectedValue(new Error("sidecar down"));
    renderCard({ onPost });
    const textarea = screen.getByLabelText("Write a comment");

    fireEvent.change(textarea, { target: { value: "worth keeping" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(onPost).toHaveBeenCalledWith("worth keeping"));
    expect((textarea as HTMLTextAreaElement).value).toBe("worth keeping");
  });

  it("a successful post clears the draft", async () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    renderCard({ onPost });
    const textarea = screen.getByLabelText("Write a comment");

    fireEvent.change(textarea, { target: { value: "shipped" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("renders markdown but does not execute raw HTML", () => {
    const { container } = renderCard({
      comments: [
        makeComment({
          body: "**bold** <img src=x onerror=alert(1)><script>alert(2)</script>",
        }),
      ],
    });

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    // `react-markdown` runs without `rehype-raw`, so raw HTML never becomes a
    // node: no <script> to run, no <img> to fire onerror or hit the network.
    // It survives as inert text, which is what these two assertions pin.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("attributes a human, an agent and the operator distinctly", () => {
    const { container } = renderCard({
      comments: [
        makeComment({ id: 1 }),
        makeComment({
          id: 2,
          author_id: 5,
          author_kind: "human",
          author_name: "Dana",
        }),
        makeComment({
          id: 3,
          author_id: 6,
          author_kind: "agent",
          author_name: "Orion",
        }),
      ],
    });

    screen.getByText("Operator");
    screen.getByText("Dana");
    screen.getByText("Orion");
    // Exactly one row carries the agent marks.
    expect(container.querySelectorAll(".td-kind").length).toBe(1);
    expect(container.querySelectorAll(".td-av--agent").length).toBe(1);
  });
});
