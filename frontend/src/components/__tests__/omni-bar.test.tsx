// Coverage for the OmniBar rewrite: discoverability, the inline results
// dropdown (reusing useSearch()/routeForResult() rather than the old blind
// navigation to the docs page with a search hash), the `/` command registry
// executing in place, the `@` suggestion list, and the explicit capture chip
// replacing the old ends-with-`?`-or-space+len>=4 heuristic. See the OmniBar
// plan for the scope this pins.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { OmniBar } from "../omni-bar";
import type { LibraryItem } from "../../lib/api";

const PLACEHOLDER = "Search, or type / for commands, @ to reference…";

const {
  useProjectsMock,
  useTeamMembersMock,
  useLibraryItemsMock,
  useSearchMock,
  useEnabledFeaturesMock,
  createInboxMutateMock,
  createInboxMutateAsyncMock,
  createAttachmentMutateAsyncMock,
  fetchLibraryItemBySlugMock,
} = vi.hoisted(() => ({
  useProjectsMock: vi.fn(),
  useTeamMembersMock: vi.fn(),
  useLibraryItemsMock: vi.fn(),
  useSearchMock: vi.fn(),
  useEnabledFeaturesMock: vi.fn(),
  createInboxMutateMock: vi.fn(),
  createInboxMutateAsyncMock: vi.fn(),
  createAttachmentMutateAsyncMock: vi.fn(),
  fetchLibraryItemBySlugMock: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  useProjects: () => useProjectsMock(),
  useTeamMembers: () => useTeamMembersMock(),
  useLibraryItems: (...args: unknown[]) => useLibraryItemsMock(...args),
  useSearch: (...args: unknown[]) => useSearchMock(...args),
  useEnabledFeatures: () => useEnabledFeaturesMock(),
  useCreateInboxItem: () => ({
    mutate: createInboxMutateMock,
    mutateAsync: createInboxMutateAsyncMock,
    isPending: false,
  }),
  useCreateAttachment: () => ({
    mutateAsync: createAttachmentMutateAsyncMock,
    isPending: false,
  }),
  fetchLibraryItemBySlug: (slug: string) => fetchLibraryItemBySlugMock(slug),
}));

vi.mock("../../lib/use-voice-dictation", () => ({
  useVoiceDictation: () => ({
    supported: false,
    listening: false,
    transcript: "",
  }),
}));

const {
  toastSuccessMock,
  toastErrorMock,
  toastMessageMock,
} = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastMessageMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    message: toastMessageMock,
  },
}));

function LocationProbe(): ReactElement {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderBar(initialEntries: string[] = ["/"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <OmniBar />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

function libraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 1,
    slug: "dep-scan",
    title: "Dependency Scan",
    body: "run `pip-audit`",
    tags: [],
    source: "manual",
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectsMock.mockReturnValue({ data: [] });
  useTeamMembersMock.mockReturnValue({ data: [] });
  useLibraryItemsMock.mockReturnValue({ data: { items: [] } });
  useSearchMock.mockReturnValue({
    data: undefined,
    isFetching: false,
    isError: false,
  });
  useEnabledFeaturesMock.mockReturnValue({
    work: true,
    snippets: true,
    parallel: true,
  });
  createInboxMutateAsyncMock.mockResolvedValue({ id: 1 });
  createAttachmentMutateAsyncMock.mockResolvedValue({});
  fetchLibraryItemBySlugMock.mockResolvedValue(null);
});

afterEach(() => {
  // Mandatory: `frontend/vite.config.ts` does not set `globals: true`, so
  // Testing Library's auto-cleanup never registers.
  cleanup();
  vi.useRealTimers();
});

describe("OmniBar discoverability", () => {
  it("renders a leading icon, the exact placeholder, and a ⌘K kbd", () => {
    const { container } = renderBar();
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
    const kbd = container.querySelector("kbd");
    expect(kbd?.textContent).toBe("⌘K");
  });

  it("the hint strip is mode-dependent (D8): it swaps per mode and drops the ⌘K kbd once a mode is active", () => {
    const { container } = renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);

    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByText("↑↓ navigate · ↵ run command")).toBeTruthy();
    expect(container.querySelector("kbd")).toBeNull();

    fireEvent.change(input, { target: { value: "@ali" } });
    expect(screen.getByText("↑↓ navigate · ↵ insert or open")).toBeTruthy();

    fireEvent.change(input, { target: { value: "" } });
    expect(container.querySelector("kbd")?.textContent).toBe("⌘K");
  });
});

describe("OmniBar plain text -> results, not /docs", () => {
  it("groups results and Enter navigates to the top result; /docs is never used", () => {
    useSearchMock.mockReturnValue({
      data: {
        results: [
          { type: "task", id: 5, title: "Fix login", snippet: "", score: 1 },
          {
            type: "project",
            id: 9,
            title: "Login Project",
            snippet: "",
            score: 1,
          },
        ],
        query: "login",
        total: 2,
      },
      isFetching: false,
      isError: false,
    });
    vi.useFakeTimers();
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "login" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("Fix login")).toBeTruthy();
    expect(screen.getByText("Login Project")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(locationText()).toBe("/tasks/5");
    expect(locationText()).not.toContain("/docs");
  });
});

describe("OmniBar `/` executes inline", () => {
  it("bare / lists New Task and Launch Project among the first rows (D5a)", () => {
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByText("New Task")).toBeTruthy();
    expect(screen.getByText("Launch Project")).toBeTruthy();
  });

  it('"/sched" lists Schedules; Enter navigates to /schedules without opening the palette', () => {
    const paletteListener = vi.fn();
    document.addEventListener("omni:open-palette", paletteListener);
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/sched" } });
    expect(screen.getByText("Schedules")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(locationText()).toBe("/schedules");
    expect(paletteListener).not.toHaveBeenCalled();
    document.removeEventListener("omni:open-palette", paletteListener);
  });

  it('"/new task" + Enter navigates to /tasks?new=1 without opening the palette', () => {
    const paletteListener = vi.fn();
    document.addEventListener("omni:open-palette", paletteListener);
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/new task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(locationText()).toBe("/tasks?new=1");
    expect(paletteListener).not.toHaveBeenCalled();
    document.removeEventListener("omni:open-palette", paletteListener);
  });

  it('"/launch" + Enter dispatches omni:open-launch on document', () => {
    const launchListener = vi.fn();
    document.addEventListener("omni:open-launch", launchListener);
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/launch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(launchListener).toHaveBeenCalledTimes(1);
    document.removeEventListener("omni:open-launch", launchListener);
  });
});

describe("OmniBar `@` suggests and navigates", () => {
  it('"@ali" lists a member row; mouseDown navigates to /team/Alice', () => {
    useTeamMembersMock.mockReturnValue({
      data: [{ id: 1, name: "Alice", type: "human" }],
    });
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "@ali" } });
    const row = screen.getByText("Alice");
    fireEvent.mouseDown(row);
    expect(locationText()).toBe("/team/Alice");
  });

  it('"@library:dep-scan" + Enter fetches and inserts the snippet body', async () => {
    fetchLibraryItemBySlugMock.mockResolvedValue(libraryItem());
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "@library:dep-scan" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(fetchLibraryItemBySlugMock).toHaveBeenCalledWith("dep-scan");
    await waitFor(() => expect(input.value).toBe("run `pip-audit`"));
  });
});

describe("OmniBar capture is explicit", () => {
  it("a prompt-shaped query renders the chip; plain Enter does not capture; the chip and ⌘Enter do", () => {
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ship the login fix" } });

    const chip = screen.getByText("Save as inbox item ⌘↵");
    expect(chip).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(createInboxMutateMock).not.toHaveBeenCalled();

    fireEvent.mouseDown(chip);
    expect(createInboxMutateMock).toHaveBeenCalledWith(
      { title: "ship the login fix", source: "omni-bar", type: "prompt" },
      expect.anything(),
    );

    createInboxMutateMock.mockClear();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(createInboxMutateMock).toHaveBeenCalledWith(
      { title: "ship the login fix", source: "omni-bar", type: "prompt" },
      expect.anything(),
    );
  });

  it('a single word ("login") renders no capture chip', () => {
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "login" } });
    expect(screen.queryByText("Save as inbox item ⌘↵")).toBeNull();
  });
});

describe("OmniBar empty Enter still opens the palette", () => {
  it("focus + Enter on an empty input dispatches omni:open-palette", () => {
    const paletteListener = vi.fn();
    document.addEventListener("omni:open-palette", paletteListener);
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(paletteListener).toHaveBeenCalledTimes(1);
    document.removeEventListener("omni:open-palette", paletteListener);
  });
});

describe("OmniBar zero/empty states", () => {
  it('zero search results renders "No matches"; Enter does not navigate', () => {
    useSearchMock.mockReturnValue({
      data: { results: [], query: "loginx", total: 0 },
      isFetching: false,
      isError: false,
    });
    vi.useFakeTimers();
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "loginx" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("No matches")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(locationText()).toBe("/");
  });

  it('a one-character query shows "Keep typing to search…" (useSearch never ran)', () => {
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.getByText("Keep typing to search…")).toBeTruthy();
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it('useSearch isError renders "Search unavailable" while / commands still work', () => {
    useSearchMock.mockReturnValue({
      data: undefined,
      isFetching: false,
      isError: true,
    });
    vi.useFakeTimers();
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "login" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Search unavailable")).toBeTruthy();

    fireEvent.change(input, { target: { value: "/sched" } });
    expect(screen.getByText("Schedules")).toBeTruthy();
  });
});

describe("OmniBar Escape is two-stage", () => {
  it("first Escape hides the panel keeping the text; second clears the input", () => {
    useSearchMock.mockReturnValue({
      data: {
        results: [{ type: "task", id: 1, title: "Fix it", snippet: "", score: 1 }],
        query: "abcd",
        total: 1,
      },
      isFetching: false,
      isError: false,
    });
    vi.useFakeTimers();
    renderBar();
    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "abcd" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText("Fix it")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("Fix it")).toBeNull();
    expect(input.value).toBe("abcd");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });
});
