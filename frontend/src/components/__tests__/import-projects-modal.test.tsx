import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImportProjectsModal } from "../import-projects-modal";
import type { DiscoveryCandidate } from "../../lib/api";

const { mockScanMutate, mockPickDirectory, mockRichImportMutate } = vi.hoisted(
  () => ({
    mockScanMutate: vi.fn(),
    mockPickDirectory: vi.fn(),
    mockRichImportMutate: vi.fn(),
  }),
);

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

/** Pick `path` as the scan root, then run the scan the user has to click. */
async function pickAndScan(path: string): Promise<void> {
  mockPickDirectory.mockResolvedValue(path);
  await act(async () => {
    fireEvent.click(screen.getByText("Pick folder..."));
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Scan this folder"));
  });
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
});

afterEach(() => {
  cleanup();
});

describe("ImportProjectsModal", () => {
  it("scans nothing on open — no root, no home directory walk", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });

    expect(mockScanMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/No folder selected/)).toBeTruthy();
    expect(
      (screen.getByText("Scan this folder") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("Pick folder... arms the root but does not scan it yet", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });
    mockPickDirectory.mockResolvedValue("/Users/test/Code");

    await act(async () => {
      fireEvent.click(screen.getByText("Pick folder..."));
    });

    expect(mockScanMutate).not.toHaveBeenCalled();
    expect(screen.getByTitle("/Users/test/Code")).toBeTruthy();
    expect(screen.getByText(/Ready to scan/)).toBeTruthy();
    expect(
      (screen.getByText("Scan this folder") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("Scan this folder scans exactly the picked root", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });

    await pickAndScan("/Users/test/Code");

    expect(mockScanMutate).toHaveBeenCalledTimes(1);
    expect(mockScanMutate.mock.calls[0]?.[0]).toEqual({
      roots: ["/Users/test/Code"],
      git_only: true,
      max_depth: 4,
    });
  });

  it("Rescan re-scans the picked root, never a default root", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });
    await pickAndScan("/Users/test/Code");

    // The button becomes "Rescan" only once the current root has been scanned.
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
      mockScanMutate.mock.calls.every(
        (call) => scanRootsOf(call) === undefined || Array.isArray(scanRootsOf(call)),
      ),
    ).toBe(true);
  });

  it("picking a different root drops the previous results and re-arms the scan", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });
    nextCandidates = [repo("/Users/test/Code/repo-a")];
    await pickAndScan("/Users/test/Code");
    expect(screen.getByText("/Users/test/Code/repo-a")).toBeTruthy();

    mockScanMutate.mockClear();
    mockPickDirectory.mockResolvedValue("/Users/test/Other");
    await act(async () => {
      fireEvent.click(screen.getByText("Pick folder..."));
    });

    expect(mockScanMutate).not.toHaveBeenCalled();
    expect(screen.queryByText("/Users/test/Code/repo-a")).toBeNull();
    expect(screen.getByText("Scan this folder")).toBeTruthy();
  });

  it("a manually added folder survives a rescan and stays selected", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });
    nextCandidates = [repo("/Users/test/repo-a")];
    await pickAndScan("/Users/test");

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
    mockPickDirectory.mockResolvedValue("/Users/test");
    await act(async () => {
      fireEvent.click(screen.getByText("Pick folder..."));
    });

    mockPickDirectory.mockResolvedValue("/Users/test/repo-a");
    await act(async () => {
      fireEvent.click(screen.getByText("Add folder..."));
    });

    nextCandidates = [repo("/Users/test/repo-a")];
    await act(async () => {
      fireEvent.click(screen.getByText("Scan this folder"));
    });

    expect(screen.getAllByText("/Users/test/repo-a")).toHaveLength(1);
    expect(screen.getByText("git")).toBeTruthy();
  });

  it("an unscanned root reads as unscanned, not as nothing-new-to-import", async () => {
    await act(async () => {
      render(<ImportProjectsModal onClose={noop} onImported={noop} />);
    });
    mockPickDirectory.mockResolvedValue("/Users/test/Code");
    await act(async () => {
      fireEvent.click(screen.getByText("Pick folder..."));
    });

    expect(screen.queryByText("Nothing new to import.")).toBeNull();
    expect(screen.getByText("Nothing to import yet.")).toBeTruthy();
    expect(screen.getByText(/Press "Scan this folder"/)).toBeTruthy();
  });
});
