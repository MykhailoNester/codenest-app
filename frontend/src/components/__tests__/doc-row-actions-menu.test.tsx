import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { DocRowActionsMenu } from "../doc-row-actions-menu";

vi.mock("../../lib/ipc", () => ({
  openPath: vi.fn(async () => undefined),
  revealInFinder: vi.fn(async () => undefined),
  openInEditor: vi.fn(async () => undefined),
  readFileText: vi.fn(async () => ({
    contents: "",
    truncated: false,
    sizeBytes: 0,
  })),
}));

const baseProps = {
  docId: 1,
  filePath: "/Users/m/docs/reports/report.md",
  onDelete: vi.fn(),
  onPreview: vi.fn(),
};

beforeEach(() => {
  baseProps.onDelete.mockClear();
  baseProps.onPreview.mockClear();
});

describe("DocRowActionsMenu", () => {
  it("matches snapshot when exists: true", () => {
    const { container } = render(
      <DocRowActionsMenu {...baseProps} exists={true} />,
    );
    expect(container).toMatchSnapshot();
  });

  it("matches snapshot when exists: false", () => {
    const { container } = render(
      <DocRowActionsMenu {...baseProps} exists={false} />,
    );
    expect(container).toMatchSnapshot();
  });
});
