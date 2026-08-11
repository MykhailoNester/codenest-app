// The honest derivation layer for the task detail Activity tab: phrase
// mapping, glyphs, actor naming, and local-time stamp formatting.

import { describe, it, expect } from "vitest";
import {
  ACTIVITY_STAMP_OPTIONS,
  TASK_ACTIVITY_ACTIONS,
  activityActorName,
  activityStampMs,
  formatActivityStamp,
  taskActivityGlyph,
  taskActivityPhrase,
} from "../task-activity";

describe("taskActivityPhrase", () => {
  const cases: Record<
    (typeof TASK_ACTIVITY_ACTIONS)[number],
    { entry: { old_value: string | null; new_value: string | null }; expected: string }
  > = {
    created: { entry: { old_value: null, new_value: null }, expected: "created this task" },
    deleted: { entry: { old_value: "Old title", new_value: null }, expected: "deleted this task" },
    status_changed: {
      entry: { old_value: "todo", new_value: "done" },
      expected: "moved this task to Done",
    },
    blocker_added: {
      entry: { old_value: null, new_value: "12" },
      expected: "added blocker #12",
    },
    label_added: {
      entry: { old_value: null, new_value: "bug" },
      expected: 'added label "bug"',
    },
    label_removed: {
      entry: { old_value: "bug", new_value: null },
      expected: 'removed label "bug"',
    },
    labels_set: {
      entry: { old_value: null, new_value: "" },
      expected: "cleared all labels",
    },
  };

  it("every known action renders a phrase that is not the raw action", () => {
    for (const action of TASK_ACTIVITY_ACTIONS) {
      const { entry, expected } = cases[action];
      const phrase = taskActivityPhrase({ action, ...entry });
      expect(phrase).toBe(expected);
      expect(phrase).not.toBe(action);
    }
  });

  it("labels_set with a non-empty new_value joins the slugs with commas", () => {
    const phrase = taskActivityPhrase({
      action: "labels_set",
      old_value: null,
      new_value: "bug,feature,chore",
    });
    expect(phrase).toBe("set labels to bug, feature, chore");
  });

  it("an unknown action renders verbatim and does not throw", () => {
    expect(
      taskActivityPhrase({
        action: "quantum_tunnelled",
        old_value: null,
        new_value: null,
      }),
    ).toBe("quantum_tunnelled");
  });

  it("a mapped action with a missing value falls back to the raw action", () => {
    expect(
      taskActivityPhrase({ action: "status_changed", old_value: "todo", new_value: null }),
    ).toBe("status_changed");
    expect(
      taskActivityPhrase({ action: "blocker_added", old_value: null, new_value: null }),
    ).toBe("blocker_added");
    expect(
      taskActivityPhrase({ action: "label_added", old_value: null, new_value: null }),
    ).toBe("label_added");
    expect(
      taskActivityPhrase({ action: "label_removed", old_value: null, new_value: null }),
    ).toBe("label_removed");
    expect(
      taskActivityPhrase({ action: "labels_set", old_value: null, new_value: null }),
    ).toBe("labels_set");
  });

  it("status labels come from the vocab, not a hardcoded list", () => {
    const withVocab = taskActivityPhrase(
      { action: "status_changed", old_value: "todo", new_value: "todo" },
      { statusLabels: { todo: "To do" } },
    );
    expect(withVocab).toBe("moved this task to To do");

    const withoutVocab = taskActivityPhrase({
      action: "status_changed",
      old_value: "todo",
      new_value: "todo",
    });
    expect(withoutVocab).toBe("moved this task to Todo");
  });
});

describe("taskActivityGlyph", () => {
  it("maps every known action to a plain, non-emoji glyph", () => {
    expect(taskActivityGlyph("created")).toBe("+");
    expect(taskActivityGlyph("status_changed")).toBe("→");
    expect(taskActivityGlyph("deleted")).toBe("×");
    expect(taskActivityGlyph("blocker_added")).toBe("!");
    expect(taskActivityGlyph("label_added")).toBe("#");
    expect(taskActivityGlyph("label_removed")).toBe("#");
    expect(taskActivityGlyph("labels_set")).toBe("#");
  });

  it("falls back to a neutral bullet for an unknown action", () => {
    expect(taskActivityGlyph("frobnicated")).toBe("•");
  });
});

describe("activityActorName", () => {
  it("a null or blank actor renders Someone", () => {
    expect(activityActorName(null)).toBe("Someone");
    expect(activityActorName("  ")).toBe("Someone");
  });

  it("any other actor, including the cascade actor, renders verbatim", () => {
    expect(activityActorName("cascade from task #3")).toBe("cascade from task #3");
    expect(activityActorName("system")).toBe("system");
  });
});

describe("activityStampMs / formatActivityStamp", () => {
  it("naive sidecar stamps are read as UTC", () => {
    expect(activityStampMs("2026-08-11T14:00:00")).toBe(
      Date.UTC(2026, 7, 11, 14, 0, 0),
    );
    expect(activityStampMs("2026-08-11 14:00:00")).toBe(
      Date.UTC(2026, 7, 11, 14, 0, 0),
    );
  });

  it("renders in the viewer's local time with the pinned options", () => {
    const iso = "2026-08-11 14:00:00";
    expect(formatActivityStamp(iso)).toBe(
      new Date(Date.UTC(2026, 7, 11, 14, 0, 0)).toLocaleString(
        undefined,
        ACTIVITY_STAMP_OPTIONS,
      ),
    );
  });
});
