/**
 * Step 03's validation and its error surfaces. This is the one required step
 * and the only one with per-field validation, and all four of its states —
 * checking, valid, not found, and a save error — were CSS-module-coloured
 * paragraphs that the conversion re-pointed. None of them is reachable in
 * review, so each is asserted here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockValidate = vi.fn();
const mockCreateProvider = vi.fn();
const mockUpdateProvider = vi.fn();
const mockSetModels = vi.fn();
const mockPickDirectory = vi.fn();
const mockFetchSidecar = vi.fn();

vi.mock("../../../lib/api", () => ({
  useCreateProvider: () => ({ mutateAsync: mockCreateProvider }),
  useUpdateProvider: () => ({ mutateAsync: mockUpdateProvider }),
  useSetProviderModels: () => ({ mutateAsync: mockSetModels }),
  useValidateProjectPath: () => ({ mutateAsync: mockValidate }),
  updateProfile: vi.fn(),
  fetchProfiles: vi.fn().mockResolvedValue([]),
  fetchSidecar: (...args: unknown[]) => mockFetchSidecar(...args),
}));

vi.mock("../../../lib/ipc", () => ({
  pickDirectory: () => mockPickDirectory(),
}));

// The step wraps its provider lookup in useQuery; a tiny stub keeps the suite
// free of a QueryClientProvider while preserving the two states it branches on.
const queryState: { isError: boolean; data: unknown } = {
  isError: false,
  data: [],
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { ProviderSetupStep } = await import("../provider-setup-step");

function renderStep(): { commit: () => Promise<void> } {
  const ref: { fn: () => Promise<void> } = { fn: async () => undefined };
  render(<ProviderSetupStep registerCommit={(f) => (ref.fn = f)} />);
  return { commit: () => ref.fn() };
}

function configHomeInput(): HTMLInputElement {
  return screen.getByLabelText("Config home") as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  queryState.isError = false;
  queryState.data = [];
  mockCreateProvider.mockResolvedValue({ id: 1 });
  mockUpdateProvider.mockResolvedValue(undefined);
  mockSetModels.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("ProviderSetupStep", () => {
  it("offers one usable provider and marks the rest as unavailable", () => {
    renderStep();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("Claude · tested")).toBeTruthy();
    expect(screen.getAllByText("coming soon")).toHaveLength(3);
  });

  it("starts with one blank account entry and no Remove button", () => {
    renderStep();
    expect((screen.getByLabelText("Alias / command") as HTMLInputElement).value).toBe(
      "",
    );
    expect(configHomeInput().value).toBe("");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("adds and removes further accounts", () => {
    renderStep();
    fireEvent.click(
      screen.getByRole("button", { name: /Add another Anthropic account/ }),
    );
    expect(screen.getAllByLabelText("Alias / command")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(screen.getAllByLabelText("Alias / command")).toHaveLength(1);
    // Back to one — the last entry can never be removed.
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("reports a config home that does not exist", async () => {
    mockValidate.mockResolvedValue({ exists: false, is_dir: false });
    renderStep();
    fireEvent.change(configHomeInput(), { target: { value: "/nope" } });
    expect(screen.getByText("Checking…")).toBeTruthy();
    await screen.findByText("Path not found — the directory must exist.");
  });

  it("reports a path that exists but is a file, not a directory", async () => {
    mockValidate.mockResolvedValue({ exists: true, is_dir: false });
    renderStep();
    fireEvent.change(configHomeInput(), { target: { value: "/a/file" } });
    await screen.findByText("Path not found — the directory must exist.");
  });

  it("confirms a config home that exists", async () => {
    mockValidate.mockResolvedValue({ exists: true, is_dir: true });
    renderStep();
    fireEvent.change(configHomeInput(), { target: { value: "/config/claude" } });
    await screen.findByText("Path exists.");
    expect(screen.queryByText(/Path not found/)).toBeNull();
  });

  it("clears the verdict when the field is emptied again", async () => {
    mockValidate.mockResolvedValue({ exists: true, is_dir: true });
    renderStep();
    fireEvent.change(configHomeInput(), { target: { value: "/config/claude" } });
    await screen.findByText("Path exists.");

    fireEvent.change(configHomeInput(), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText("Path exists.")).toBeNull());
    expect(screen.queryByText(/Path not found/)).toBeNull();
  });

  it("says nothing either way when the validation request itself fails", async () => {
    mockValidate.mockRejectedValue(new Error("sidecar down"));
    renderStep();
    fireEvent.change(configHomeInput(), { target: { value: "/config/claude" } });
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());
    // Neither verdict — an unanswered check must not read as "not found".
    expect(screen.queryByText(/Path not found/)).toBeNull();
    expect(screen.queryByText("Path exists.")).toBeNull();
  });

  it("validates immediately after the directory picker, with no debounce", async () => {
    mockPickDirectory.mockResolvedValue("/config/picked");
    mockValidate.mockResolvedValue({ exists: true, is_dir: true });
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(configHomeInput().value).toBe("/config/picked"));
    await screen.findByText("Path exists.");
  });

  it("seeds the four model tiers with Opus as the default", () => {
    renderStep();
    for (const tier of ["Fable", "Opus", "Sonnet", "Haiku"]) {
      expect(screen.getByLabelText(`${tier} model ID for account 1`)).toBeTruthy();
    }
    const opus = screen.getByRole("button", {
      name: "Set Opus as default for account 1",
    });
    expect(opus.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Set Haiku as default for account 1" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("moves the default tier when another star is pressed", () => {
    renderStep();
    fireEvent.click(
      screen.getByRole("button", { name: "Set Sonnet as default for account 1" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Set Sonnet as default for account 1" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Set Opus as default for account 1" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("warns, without blocking, when existing providers cannot be loaded", () => {
    queryState.isError = true;
    renderStep();
    expect(
      screen.getByText(/Could not load existing providers/),
    ).toBeTruthy();
  });

  it("names the clash on a duplicate alias, and rethrows so the shell stays put", async () => {
    mockCreateProvider.mockRejectedValue(
      Object.assign(new Error("conflict"), { status: 409, path: "/providers" }),
    );
    const { commit } = renderStep();
    fireEvent.change(screen.getByLabelText("Alias / command"), {
      target: { value: "work" },
    });

    await expect(commit()).rejects.toBeTruthy();
    await screen.findByText(
      'Alias "work" is already taken — choose a different name.',
    );
  });

  it("surfaces any other save failure verbatim", async () => {
    mockCreateProvider.mockRejectedValue(
      Object.assign(new Error("sidecar down"), {
        status: 500,
        path: "/providers",
      }),
    );
    const { commit } = renderStep();
    fireEvent.change(screen.getByLabelText("Alias / command"), {
      target: { value: "work" },
    });

    await expect(commit()).rejects.toBeTruthy();
    await screen.findByText('Failed to save "work": sidecar down');
  });

  it("defaults the alias to `claude` when the field is left blank", async () => {
    const { commit } = renderStep();
    await commit();
    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "claude",
        display_name: "Anthropic (claude)",
        // No config home entered, so no CLAUDE_CONFIG_DIR is invented for one.
        default_env: {},
      }),
    );
  });
});
