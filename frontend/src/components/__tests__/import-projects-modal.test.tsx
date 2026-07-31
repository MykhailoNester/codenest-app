import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImportProjectsModal } from "../import-projects-modal";
import type { DiscoveryCandidate } from "../../lib/api";

const {
  mockScanMutate,
  mockPickDirectory,
  mockUseSystemInfo,
  mockRichImportMutate,
} = vi.hoisted(() => ({
  mockScanMutate: vi.fn(),
  mockPickDirectory: vi.fn(),
  mockUseSystemInfo: vi.fn(),
  mockRichImportMutate: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  pickDirectory: (...args: unknown[]) => mockPickDirectory(...args),
}));

vi.mock("../../lib/api", () => ({
  useScanProjects: () => ({
    mutate: mockScanMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useRichImportProjects: () => ({
    mutate: mockRichImportMutate,
    isPending: false,
  }),
  useProfiles: () => ({ data: [] }),
  useSystemInfo: () => mockUseSystemInfo(),
}));

/** The scan response queued for the *next* `mockScanMutate` call. */
let nextCandidates: DiscoveryCandidate[] = [];

function repo(
  path: string,
  overrides: Partial<DiscoveryCandidate> = {},
): DiscoveryCandidate {
  return {
    name: path.split("/").filter(Boolean).pop() ?? path,
    path,
    stack: "node",
    git: true,
    tools: ["claude"],
    git_remote: null,
    already_imported: false,
    ...overrides,
  };
}

function noop(): void {
  // intentionally empty — modal callback stubs
}

function scanRootsOf(call: unknown[] | undefined): unknown {
  const vars = call?.[0] as { roots?: unknown } | undefined;
  return vars?.roots;
}

beforeEach(() => {
  vi.clearAllMocks();
  nextCandidates = [];
  mockScanMutate.mockImplementation(
    (
      _vars: unknown,
      opts?: { onSuccess?: (data: { candidates: DiscoveryCandidate[] }) => void },
    ) => {
      opts?.onSuccess?.({ candidates: nextCandidates });
    },
  );
  mockUseSystemInfo.mockReturnValue({
    data: { home: "/Users/test", platform: "darwin" },
  });
});

afterEach(() => {
  cleanup();
});

describe("ImportProjectsModal", () => {
  it("auto-scans the home root from /api/v1/system/info on open", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });

    expect(mockScanMutate).toHaveBeenCalledTimes(1);
    expect(mockScanMutate.mock.calls[0]?.[0]).toEqual({
      roots: ["/Users/test"],
      git_only: true,
      max_depth: 4,
    });
  });

  it("does not scan before the home root is known", async () => {
    mockUseSystemInfo.mockReturnValue({ data: undefined });

    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });

    expect(mockScanMutate).not.toHaveBeenCalled();
    expect(
      (screen.getByText("Rescan") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("Pick folder... sets the scan root and scans that folder", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });
    mockScanMutate.mockClear();
    mockPickDirectory.mockResolvedValue("/Users/test/Code");

    await act(async () => {
      fireEvent.click(screen.getByText("Pick folder..."));
    });

    const lastCall = mockScanMutate.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual({
      roots: ["/Users/test/Code"],
      git_only: true,
      max_depth: 4,
    });
    expect(screen.getByTitle("/Users/test/Code")).toBeTruthy();
  });

  it("Rescan re-scans the picked root, never the sidecar defaults", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });
    mockPickDirectory.mockResolvedValue("/Users/test/Code");
    await act(async () => {
      fireEvent.click(screen.getByText("Pick folder..."));
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Rescan"));
    });

    const lastCall = mockScanMutate.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual({
      roots: ["/Users/test/Code"],
      git_only: true,
      max_depth: 4,
    });
    expect(
      mockScanMutate.mock.calls.every((call) =>
        Array.isArray(scanRootsOf(call)),
      ),
    ).toBe(true);
  });

  it("a manually added folder survives a rescan and stays selected", async () => {
    nextCandidates = [repo("/Users/test/repo-a")];
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });

    mockPickDirectory.mockResolvedValue("/Users/test/notes");
    await act(async () => {
      fireEvent.click(screen.getByText("Add folder..."));
    });

    // Rescan still returns only repo-a; the manual "notes" folder is not a
    // git repo and the scan never surfaces it.
    await act(async () => {
      fireEvent.click(screen.getByText("Rescan"));
    });

    expect(screen.getByText("/Users/test/notes")).toBeTruthy();
    expect(screen.getByText("2 of 2 selected")).toBeTruthy();
  });

  it("a manually added folder that the next scan also finds is not duplicated", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });

    mockPickDirectory.mockResolvedValue("/Users/test/repo-a");
    await act(async () => {
      fireEvent.click(screen.getByText("Add folder..."));
    });

    nextCandidates = [repo("/Users/test/repo-a")];
    await act(async () => {
      fireEvent.click(screen.getByText("Rescan"));
    });

    expect(screen.getAllByText("/Users/test/repo-a")).toHaveLength(1);
    expect(screen.getByText("git")).toBeTruthy();
  });

  it("shows the active scan root instead of the default-roots subtitle", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });

    expect(screen.queryByText(/Scanned common folders/)).toBeNull();
  });
});
