import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { DocPreviewModal } from "../doc-preview-modal";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="md">{children}</div>
  ),
}));

vi.mock("remark-gfm", () => ({
  default: () => undefined,
}));

const readFileTextMock = vi.fn();

vi.mock("../../lib/ipc", () => ({
  readFileText: (...args: unknown[]) => readFileTextMock(...args),
}));

const baseProps = {
  filePath: "/Users/m/docs/reports/report.md",
  title: "REPORT-001",
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DocPreviewModal", () => {
  it("renders markdown content when readFileText resolves", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "# Hello",
      truncated: false,
      sizeBytes: 7,
    });

    await act(async () => {
      render(<DocPreviewModal {...baseProps} />);
    });

    expect(screen.getByText("# Hello")).toBeTruthy();
  });

  it("shows truncation banner when truncated: true", async () => {
    readFileTextMock.mockResolvedValue({
      contents: "some content",
      truncated: true,
      sizeBytes: 2_000_000,
    });

    await act(async () => {
      render(<DocPreviewModal {...baseProps} />);
    });

    expect(screen.getByText(/File truncated at 1 MB/)).toBeTruthy();
  });

  it("shows error message when readFileText rejects", async () => {
    readFileTextMock.mockRejectedValue(
      new Error("binary file type; open in external viewer"),
    );

    await act(async () => {
      render(<DocPreviewModal {...baseProps} />);
    });

    expect(
      screen.getByText("binary file type; open in external viewer"),
    ).toBeTruthy();
  });
});
