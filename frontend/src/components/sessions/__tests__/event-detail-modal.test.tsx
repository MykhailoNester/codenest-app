// Coverage for the "body not stored" affordance (#159).
//
// From the sidecar trim on, a tool event's payload_json carries only the
// provenance fields and a per-tool allowlisted tool_input slice — never
// tool_response, never a Bash/file body. The modal's renderers were already
// null-safe against a missing anchor key (they fall back to
// GenericJsonRenderer), so this is an affordance that explains a trimmed
// row reads as policy, not a crash-avoidance test.

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EventDetailModal, type EventLike } from "../event-detail-modal";

afterEach(() => {
  cleanup();
});

function makeEvent(overrides: Partial<EventLike> = {}): EventLike {
  return {
    id: 1,
    session_id: "session-1",
    event_type: "PostToolUse",
    tool_name: "Bash",
    summary: "Bash done",
    payload_json: null,
    created_at: "2026-07-31T10:00:00Z",
    ...overrides,
  };
}

describe("EventDetailModal", () => {
  it("shows the body-not-stored note for a trimmed PostToolUse", () => {
    const ev = makeEvent({
      payload_json: JSON.stringify({
        session_id: "session-1",
        cwd: "/tmp/proj",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        truncated: true,
      }),
      summary: "Bash done",
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText(/body not stored/i)).toBeTruthy();
    expect(screen.getByText("Bash done")).toBeTruthy();
  });

  it("does not show the note for a legacy event that still has a body", () => {
    const ev = makeEvent({
      payload_json: JSON.stringify({
        tool_input: { command: "ls -la" },
        tool_response: { stdout: "a\nb\n", stderr: "" },
      }),
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.queryByText(/body not stored/i)).toBeNull();
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("shows the note for a trimmed PreToolUse with an empty tool_input", () => {
    const ev = makeEvent({
      event_type: "PreToolUse",
      tool_name: "Edit",
      payload_json: JSON.stringify({ tool_input: {} }),
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText(/body not stored/i)).toBeTruthy();
  });

  it("keeps the Task tool_input visible instead of the note", () => {
    const ev = makeEvent({
      event_type: "PreToolUse",
      tool_name: "Task",
      payload_json: JSON.stringify({
        tool_input: {
          subagent_type: "planner-agent",
          name: "Plan the release",
          description: "Work out the rollout order",
        },
      }),
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.queryByText(/body not stored/i)).toBeNull();
    expect(screen.getByText(/subagent_type/)).toBeTruthy();
  });

  it("a trimmed UserPromptSubmit falls back to the no-prompt hint under its summary strip", () => {
    const ev = makeEvent({
      event_type: "UserPromptSubmit",
      tool_name: null,
      payload_json:
        '{"session_id":"s1","hook_event_name":"UserPromptSubmit","truncated":true}',
      summary: "refactor the trim",
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText("(no prompt text)")).toBeTruthy();
    expect(screen.getByText("refactor the trim")).toBeTruthy();
    expect(screen.queryByText(/body not stored/i)).toBeNull();
  });

  it("still renders the prompt for a legacy UserPromptSubmit that has one", () => {
    const ev = makeEvent({
      event_type: "UserPromptSubmit",
      tool_name: null,
      payload_json: '{"prompt": "hello"}',
      summary: "hello (legacy row)",
    });

    render(<EventDetailModal event={ev} onClose={() => {}} />);

    expect(screen.getByText("hello")).toBeTruthy();
  });
});

// ─── Capability inventory, pinned (#283) ──────────────────────────────────────
//
// The conversion to Deck deleted event-detail-modal.module.css, so every
// assertion below is keyed on what the modal *renders* — labels, text, roles —
// and never on a class name a later restyle can take away. The three exceptions
// are deliberate and commented: the `.deck` scope wrapper, the semantic frame
// colours and the wrap style on a code frame are what fail silently.

describe("EventDetailModal — shell", () => {
  it("renders inside a .deck scope so Deck tokens resolve through the portal", () => {
    // The modal portals to document.body, outside the .deck the page draws
    // inside. Without this wrapper every var() resolves to nothing and the
    // dialog ships as an unstyled white box — invisible to a text assertion.
    render(<EventDetailModal event={makeEvent()} onClose={() => {}} />);

    expect(document.querySelector(".deck .dk-modal")).toBeTruthy();
  });

  it("shows the event title", () => {
    render(
      <EventDetailModal
        event={makeEvent({ event_type: "PostToolUse", tool_name: "Bash" })}
        onClose={() => {}}
      />,
    );

    // Deck's modal header uppercases via CSS; the text content is unchanged.
    expect(screen.getByRole("heading", { name: "Post: Bash" })).toBeTruthy();
  });

  it("titles a UserPromptSubmit as User Prompt", () => {
    render(
      <EventDetailModal
        event={makeEvent({ event_type: "UserPromptSubmit", tool_name: null })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "User Prompt" })).toBeTruthy();
  });

  it("closes from the close button", () => {
    const onClose = vi.fn();
    render(<EventDetailModal event={makeEvent()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<EventDetailModal event={makeEvent()} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the jump action only when a handler is given", () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <EventDetailModal
        event={makeEvent()}
        onClose={onClose}
        onJumpToSession={onJump}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /jump to session/i }));
    expect(onJump).toHaveBeenCalledWith("session-1");
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    render(<EventDetailModal event={makeEvent()} onClose={() => {}} />);
    expect(
      screen.queryByRole("button", { name: /jump to session/i }),
    ).toBeNull();
  });
});

describe("EventDetailModal — Bash renderer", () => {
  function bashEvent(
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown> | null = null,
  ): EventLike {
    return makeEvent({
      payload_json: JSON.stringify(
        toolResponse === null
          ? { tool_input: toolInput }
          : { tool_input: toolInput, tool_response: toolResponse },
      ),
    });
  }

  it("renders the command, its description, stdout and stderr", () => {
    render(
      <EventDetailModal
        event={bashEvent(
          { command: "pnpm test", description: "Run the suite" },
          { stdout: "2 passed", stderr: "1 warning" },
        )}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("command")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("Run the suite")).toBeTruthy();
    expect(screen.getByText("stdout")).toBeTruthy();
    expect(screen.getByText("2 passed")).toBeTruthy();
    expect(screen.getByText("stderr")).toBeTruthy();
    expect(screen.getByText("1 warning")).toBeTruthy();
  });

  it("frames stderr in --err and leaves stdout neutral", () => {
    // Deck's terminal colour vocabulary is the point of the restyle, and a
    // token regression here is invisible to a text assertion.
    render(
      <EventDetailModal
        event={bashEvent({ command: "x" }, { stdout: "ok", stderr: "boom" })}
        onClose={() => {}}
      />,
    );

    const stderrFrame = screen.getByText("stderr").closest(".dk-out");
    const stdoutFrame = screen.getByText("stdout").closest(".dk-out");

    expect((stderrFrame as HTMLElement).style.borderColor).toBe("var(--err)");
    expect((stdoutFrame as HTMLElement).style.borderColor).toBe("");
  });

  it("collapses and restores the output section", () => {
    render(
      <EventDetailModal
        event={bashEvent({ command: "ls" }, { stdout: "total 0" })}
        onClose={() => {}}
      />,
    );

    const toggle = screen.getByRole("button", { name: /output/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("total 0")).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("total 0")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText("total 0")).toBeTruthy();
  });

  it("badges an interrupted command", () => {
    render(
      <EventDetailModal
        event={bashEvent(
          { command: "sleep 99" },
          { stdout: "", interrupted: true },
        )}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("interrupted")).toBeTruthy();
  });

  it("does not badge a command that ran to completion", () => {
    render(
      <EventDetailModal
        event={bashEvent({ command: "sleep 1" }, { stdout: "done" })}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText("interrupted")).toBeNull();
  });

  it("shows the no-output hint when both streams came back empty", () => {
    render(
      <EventDetailModal
        event={bashEvent({ command: "true" }, { stdout: "", stderr: "" })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("(no output)")).toBeTruthy();
  });

  it("falls back to the payload view when there is no command", () => {
    render(
      <EventDetailModal
        event={bashEvent({ timeout: 5000 })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /payload/i })).toBeTruthy();
  });

  it("wraps a long unbroken command inside its frame", () => {
    // A real transcript command runs past any dialog width. `pre-wrap` breaks
    // on whitespace only, so without overflow-wrap this stretches the dialog.
    const long = `git log --format=${"a".repeat(400)}`;
    render(
      <EventDetailModal
        event={bashEvent({ command: long })}
        onClose={() => {}}
      />,
    );

    expect((screen.getByText(long) as HTMLElement).style.overflowWrap).toBe(
      "anywhere",
    );
  });
});

describe("EventDetailModal — file renderers", () => {
  function fileEvent(
    tool: string,
    toolInput: Record<string, unknown>,
  ): EventLike {
    return makeEvent({
      event_type: "PreToolUse",
      tool_name: tool,
      payload_json: JSON.stringify({ tool_input: toolInput }),
    });
  }

  it("shows the tool and the file path", () => {
    render(
      <EventDetailModal
        event={fileEvent("Read", { file_path: "/workspace/app/main.py" })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("read")).toBeTruthy();
    expect(screen.getByText("/workspace/app/main.py")).toBeTruthy();
  });

  it("shows Read's offset and limit", () => {
    render(
      <EventDetailModal
        event={fileEvent("Read", {
          file_path: "/workspace/app/main.py",
          offset: 10,
          limit: 50,
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/offset: 10/)).toBeTruthy();
    expect(screen.getByText(/limit: 50/)).toBeTruthy();
  });

  it("shows Write's content", () => {
    render(
      <EventDetailModal
        event={fileEvent("Write", {
          file_path: "/workspace/app/new.py",
          content: "print('hi')",
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.getByText("print('hi')")).toBeTruthy();
  });

  it("shows both Edit halves and colours them --err and --ok", () => {
    render(
      <EventDetailModal
        event={fileEvent("Edit", {
          file_path: "/workspace/app/main.py",
          old_string: "was here",
          new_string: "is here now",
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("was here")).toBeTruthy();
    expect(screen.getByText("is here now")).toBeTruthy();

    // Deleted half is --err, added half is --ok. Tokens, never hex.
    const oldFrame = screen.getByText("old").closest(".dk-out");
    const newFrame = screen.getByText("new").closest(".dk-out");
    expect((oldFrame as HTMLElement).style.borderColor).toBe("var(--err)");
    expect((newFrame as HTMLElement).style.borderColor).toBe("var(--ok)");
  });

  it("falls back to the payload view when there is no file path", () => {
    render(
      <EventDetailModal
        event={fileEvent("Write", { content: "orphaned" })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /payload/i })).toBeTruthy();
  });
});

describe("EventDetailModal — prompt renderer", () => {
  function promptEvent(prompt: string): EventLike {
    return makeEvent({
      event_type: "UserPromptSubmit",
      tool_name: null,
      payload_json: JSON.stringify({ prompt }),
    });
  }

  it("renders markdown emphasis as markup, not literal asterisks", () => {
    render(
      <EventDetailModal
        event={promptEvent("make it **fast**")}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("fast").tagName).toBe("STRONG");
  });

  it("puts a fenced code block in a wrapping frame", () => {
    // A prompt is mostly pasted code. `.dk-prose` has no rule for `pre`, so
    // without the override a fenced block runs straight out of the dialog.
    render(
      <EventDetailModal
        event={promptEvent("```\nnpm run build -- --out " + "x".repeat(300) + "\n```")}
        onClose={() => {}}
      />,
    );

    const pre = document.querySelector(".dk-out pre") as HTMLElement | null;
    expect(pre).toBeTruthy();
    expect((pre as HTMLElement).style.overflowWrap).toBe("anywhere");
  });
});

describe("EventDetailModal — copy", () => {
  it("puts the command on the clipboard", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(
      <EventDetailModal
        event={makeEvent({
          payload_json: JSON.stringify({ tool_input: { command: "echo hi" } }),
        })}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith("echo hi");
    vi.unstubAllGlobals();
  });
});
