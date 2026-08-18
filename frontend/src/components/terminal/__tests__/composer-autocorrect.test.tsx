// Guards the composer textarea and the "+ context" filter input against
// losing their OS-autocorrect opt-out in a future refactor. jsdom is not
// WebKit, so these specs only pin that the four attributes reach the DOM —
// they cannot prove macOS actually stops rewriting the text (see the commit
// message for the manual verification that does).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentComposer } from "../agent-composer";
import { useComposerStore } from "../../../stores/composer-store";

const { useTasksMock, useLibraryItemsMock, NO_CATALOG } = vi.hoisted(() => ({
  useTasksMock: vi.fn(),
  useLibraryItemsMock: vi.fn(),
  // One stable object, like react-query's `data`: a fresh one per call makes the
  // probe's report-upward effect fire every render and the parent setState it
  // performs loop forever.
  NO_CATALOG: { data: undefined },
}));

vi.mock("../../../lib/api", () => ({
  useTasks: (filters?: unknown) => useTasksMock(filters),
  useLibraryItems: () => useLibraryItemsMock(),
  // A draft that reads as a command line opens the `/` menu, which mounts the
  // probe that calls this. `data: undefined` is the still-loading shape.
  useInvocables: () => NO_CATALOG,
}));

vi.mock("../../../lib/ipc", () => ({
  agentInterrupt: vi.fn(async () => undefined),
  agentSetModel: vi.fn(async () => undefined),
  agentSetPermissionMode: vi.fn(async () => undefined),
}));

const LEAF = "leaf-1";

// Same props as context-picker.test.tsx:43-54.
function renderComposer(): void {
  render(
    <AgentComposer
      leafId={LEAF}
      status="idle"
      providerId={null}
      model={null}
      permissionMode={null}
      onRequestRestart={() => undefined}
    />,
  );
}

/** Open the picker via its trigger, the way a user does. */
function openPicker(): void {
  fireEvent.click(screen.getByText("+ context"));
}

/**
 * `react-dom` emits `autoCorrect`/`autoCapitalize` through `setAttribute`,
 * which lowercases the qualified name for an HTML element — WebKit reads
 * `autocorrect`/`autocapitalize`, not the camelCase spelling. Assert on the
 * lowercase names so the check matches what the browser actually sees.
 */
function expectOptedOut(el: Element): void {
  expect(el.getAttribute("autocorrect")).toBe("off");
  expect(el.getAttribute("autocapitalize")).toBe("off");
  expect(el.getAttribute("spellcheck")).toBe("false");
  expect(el.getAttribute("autocomplete")).toBe("off");
}

beforeEach(() => {
  useComposerStore.setState({ panes: {}, history: [] });
  useLibraryItemsMock.mockReturnValue({ data: { items: [] } });
  useTasksMock.mockReturnValue({ data: [] });
});

afterEach(() => {
  cleanup();
});

describe("composer autocorrect opt-out", () => {
  it("the prompt textarea opts out of OS autocorrect, capitalisation, spellcheck and autofill", () => {
    renderComposer();

    const textarea = document.querySelector("textarea[data-agent-composer]");
    expect(textarea).toBeTruthy();
    expectOptedOut(textarea as Element);
  });

  it("keeps the composer hooks the shortcut layer depends on", () => {
    renderComposer();

    const textarea = document.querySelector("textarea[data-agent-composer]");
    expect(textarea).toBeTruthy();
    expect(textarea?.hasAttribute("data-agent-composer")).toBe(true);
    expect(textarea?.closest("[data-agent-composer]")).toBeTruthy();
  });

  it("the context filter opts out too", () => {
    renderComposer();
    openPicker();

    const filterInput = screen.getByLabelText("Filter context");
    expectOptedOut(filterInput);
  });

  it("a restored draft still renders the opted-out textarea", () => {
    useComposerStore.setState({
      panes: {
        [LEAF]: {
          draft: "zzq teh recieve",
          pills: [],
          queued: [],
          fanoutAll: false,
        },
      },
      history: [],
    });

    renderComposer();

    const textarea = document.querySelector(
      "textarea[data-agent-composer]",
    ) as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();
    expect(textarea?.value).toBe("zzq teh recieve");
    expectOptedOut(textarea as Element);
  });
});
