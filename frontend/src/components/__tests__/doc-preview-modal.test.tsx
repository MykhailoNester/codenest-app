import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { DocPreviewModal } from "../doc-preview-modal";

/**
 * The real renderer is not what these assertions are about, but the props it
 * is handed are: #283 moved this modal onto `.dk-prose`, which has no `pre`
 * rule, so the `components.pre` override is the only thing keeping a fenced
 * block inside the dialog. Capturing the props is how that stays checkable
 * without mounting a markdown parser.
 */
const markdownProps: Array<Record<string, unknown>> = [];

vi.mock("react-markdown", () => ({
  default: (props: { children: string }) => {
    markdownProps.push(props as Record<string, unknown>);
    return <div data-testid="md">{props.children}</div>;
  },
}));

vi.mock("remark-gfm", () => ({
  default: () => undefined,
}));

const readFileTextMock = vi.fn();

vi.mock("../../lib/ipc", () => ({
  readFileText: (...args: unknown[]) => readFileTextMock(...args),
}));

const baseProps = {
  filePath: "/docs/reports/report.md",
  title: "REPORT-001",
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  markdownProps.length = 0;
  cleanup();
});

async function mount(props = baseProps): Promise<void> {
  await act(async () => {
    render(<DocPreviewModal {...props} />);
  });
}

describe("DocPreviewModal", () => {
  it("renders markdown content when readFileText resolves", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "# Hello",
      truncated: false,
      sizeBytes: 7,
    });

    await mount();

    expect(screen.getByText("# Hello")).toBeTruthy();
  });

  it("shows truncation banner when truncated: true", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "some content",
      truncated: true,
      sizeBytes: 2_000_000,
    });

    await mount();

    expect(screen.getByText(/File truncated at 1 MB/)).toBeTruthy();
    // The warning now carries Deck's "stalled" glyph rather than being colour
    // alone, so it survives with colour switched off.
    expect(screen.getByLabelText("stalled")).toBeTruthy();
  });

  it("shows error message when readFileText rejects", async () => {
    readFileTextMock.mockRejectedValue(
      new Error("binary file type; open in external viewer"),
    );

    await mount();

    expect(
      screen.getByText("binary file type; open in external viewer"),
    ).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("gives the markdown renderer a `pre` override, because `.dk-prose` has none", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "```\nfenced\n```",
      truncated: false,
      sizeBytes: 12,
    });

    await mount();

    const components = markdownProps[0]?.["components"] as
      | { pre?: ComponentType<{ children?: ReactNode }> }
      | undefined;
    expect(typeof components?.pre).toBe("function");

    // And the override is the wrapping one: `.dk-out` frames and caps it,
    // `.dk-term__b` inside wraps long lines. Without both, a fence runs out
    // of the dialog.
    const Pre = components!.pre!;
    const { container } = render(<Pre>fenced</Pre>);
    const out = container.querySelector(".dk-out");
    expect(out).toBeTruthy();
    expect(out?.querySelector(".dk-term__b")?.textContent).toBe("fenced");
  });

  it("wraps a non-markdown file in the same block rather than a bare pre", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "a very long line of plain text",
      truncated: false,
      sizeBytes: 30,
    });

    const { container } = await act(async () =>
      render(<DocPreviewModal {...baseProps} filePath="/docs/notes.txt" />),
    );

    expect(screen.queryByTestId("md")).toBeNull();
    const body = container.querySelector(".dk-out .dk-term__b");
    expect(body?.textContent).toBe("a very long line of plain text");
  });

  it("closes on Escape, on the close button, and on the scrim", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "x",
      truncated: false,
      sizeBytes: 1,
    });
    const onClose = vi.fn();

    const { container } = await act(async () =>
      render(<DocPreviewModal {...baseProps} onClose={onClose} />),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(container.querySelector(".dk-scrim")!);
    expect(onClose).toHaveBeenCalledTimes(3);

    // …but a click inside the panel is not a click on the scrim.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("names the dialog from its own title", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "x",
      truncated: false,
      sizeBytes: 1,
    });

    await mount();

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "REPORT-001" })).toBeTruthy();
    expect(dialog.getAttribute("aria-labelledby")).toBe("doc-preview-title");
  });
});
