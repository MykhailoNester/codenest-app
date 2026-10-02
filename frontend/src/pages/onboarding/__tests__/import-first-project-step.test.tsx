/**
 * Step 02 — scan, select, import. The only step with a directory picker and
 * the only one whose commit sends a payload built from user selection, so its
 * validation, its default selection and its disabled/enabled transitions are
 * asserted here: on a once-per-install flow there is no second chance to
 * notice that Scan silently did nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DiscoveryCandidate } from "../../../lib/api";

const mockScan = vi.fn();
const mockImport = vi.fn();
const mockScanState = { isPending: false };

vi.mock("../../../lib/api", () => ({
  useScanProjects: () => ({
    mutateAsync: mockScan,
    get isPending() {
      return mockScanState.isPending;
    },
  }),
  useRichImportProjects: () => ({ mutateAsync: mockImport }),
}));

const mockOpenDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toastError(m),
    success: (m: string) => toastSuccess(m),
    info: (m: string) => toastInfo(m),
  },
}));

const { ImportFirstProjectStep } = await import("../import-first-project-step");

// Paths here are deliberately fictional placeholders — this file ships in a
// public repo and a first-run fixture is exactly where a real home directory
// gets baked in.
function candidate(
  overrides: Partial<DiscoveryCandidate> = {},
): DiscoveryCandidate {
  return {
    path: "/src/alpha",
    name: "alpha",
    stack: null,
    git: true,
    tools: ["claude"],
    agents: 0,
    skills: 0,
    already_imported: false,
    ...overrides,
  } as DiscoveryCandidate;
}

/** Captures the commit the step registers, so Continue can be simulated. */
function renderStep(): { commit: () => Promise<void> } {
  const ref: { fn: () => Promise<void> } = { fn: async () => undefined };
  render(<ImportFirstProjectStep registerCommit={(f) => (ref.fn = f)} />);
  return { commit: () => ref.fn() };
}

function rootInput(): HTMLInputElement {
  return screen.getByLabelText(/Root folder to scan/) as HTMLInputElement;
}

function scanBtn(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Scan/ }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScanState.isPending = false;
});

afterEach(() => {
  cleanup();
});

describe("ImportFirstProjectStep", () => {
  it("leaves the root empty so the first Scan cannot walk the whole home tree", () => {
    renderStep();
    expect(rootInput().value).toBe("");
  });

  it("keeps Scan disabled until a root is entered", () => {
    renderStep();
    expect(scanBtn().disabled).toBe(true);
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    expect(scanBtn().disabled).toBe(false);
  });

  it("treats a whitespace-only root as empty", () => {
    renderStep();
    fireEvent.change(rootInput(), { target: { value: "   " } });
    expect(scanBtn().disabled).toBe(true);
  });

  it("fills the root from the directory picker", async () => {
    mockOpenDialog.mockResolvedValue("/src/picked");
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(rootInput().value).toBe("/src/picked"));
    expect(mockOpenDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
    });
  });

  it("leaves the root alone when the picker is cancelled", async () => {
    mockOpenDialog.mockResolvedValue(null);
    renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src/kept" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(mockOpenDialog).toHaveBeenCalled());
    expect(rootInput().value).toBe("/src/kept");
  });

  it("reports a failed scan instead of showing an empty result list", async () => {
    mockScan.mockRejectedValue(new Error("permission denied"));
    renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Scan failed: permission denied",
      ),
    );
    expect(screen.queryByText(/Discovered repositories/)).toBeNull();
  });

  it("says so when a scan finds nothing", async () => {
    mockScan.mockResolvedValue({ candidates: [] });
    renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        "No git repositories found under that folder",
      ),
    );
  });

  it("pre-selects Claude repos that are not already imported, and nothing else", async () => {
    mockScan.mockResolvedValue({
      candidates: [
        candidate({ path: "/src/a", name: "a" }),
        candidate({ path: "/src/b", name: "b", tools: [] }),
        candidate({ path: "/src/c", name: "c", already_imported: true }),
      ],
    });
    renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await screen.findByText(/Discovered repositories/);
    // Only /src/a qualifies: b has no Claude tooling, c is already imported.
    expect(screen.getByText(/2 with Claude · 1 selected for import/)).toBeTruthy();
  });

  it("toggles one row, and toggles all on then all off", async () => {
    mockScan.mockResolvedValue({
      candidates: [
        candidate({ path: "/src/a", name: "a", tools: [] }),
        candidate({ path: "/src/b", name: "b", tools: [] }),
      ],
    });
    renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await screen.findByText(/Discovered repositories/);
    expect(screen.getByText(/0 selected for import/)).toBeTruthy();

    fireEvent.click(screen.getByText("a"));
    expect(screen.getByText(/1 selected for import/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Toggle all" }));
    expect(screen.getByText(/2 selected for import/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Toggle all" }));
    expect(screen.getByText(/0 selected for import/)).toBeTruthy();
  });

  it("imports only the selected repos on Continue", async () => {
    mockScan.mockResolvedValue({
      candidates: [
        candidate({ path: "/src/a", name: "a", stack: "node" }),
        candidate({ path: "/src/b", name: "b", tools: [] }),
      ],
    });
    mockImport.mockResolvedValue({ imported: 1, skipped: 0, errors: [] });
    const { commit } = renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await screen.findByText(/Discovered repositories/);

    await commit();
    expect(mockImport).toHaveBeenCalledWith([
      { path: "/src/a", name: "a", stack: "node" },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("Imported 1 project");
  });

  it("advances without calling the import API when nothing is selected", async () => {
    mockScan.mockResolvedValue({
      candidates: [candidate({ path: "/src/b", name: "b", tools: [] })],
    });
    const { commit } = renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await screen.findByText(/Discovered repositories/);

    // Skipping the step must be a no-op, not an empty import.
    await expect(commit()).resolves.toBeUndefined();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("surfaces per-repo import warnings alongside the success toast", async () => {
    mockScan.mockResolvedValue({ candidates: [candidate()] });
    mockImport.mockResolvedValue({
      imported: 1,
      skipped: 1,
      errors: ["bad symlink"],
    });
    const { commit } = renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await screen.findByText(/Discovered repositories/);

    await commit();
    expect(toastSuccess).toHaveBeenCalledWith("Imported 1 project · 1 skipped");
    expect(toastError).toHaveBeenCalledWith("Import warnings: bad symlink");
  });

  it("lets a commit failure reach the shell so it can stay on the step", async () => {
    mockScan.mockResolvedValue({ candidates: [candidate()] });
    mockImport.mockRejectedValue(new Error("sidecar down"));
    const { commit } = renderStep();
    fireEvent.change(rootInput(), { target: { value: "/src" } });
    fireEvent.click(scanBtn());
    await screen.findByText(/Discovered repositories/);

    await expect(commit()).rejects.toThrow("sidecar down");
  });
});
