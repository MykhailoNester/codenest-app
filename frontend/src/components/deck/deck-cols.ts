/** Column templates, so a list's shape is named rather than inlined. */
export const DECK_COLS = {
  default: "14px minmax(0, 1fr) 110px 150px 62px 96px",
  tasks: "14px 50px minmax(0, 1fr) 100px 118px 52px 80px",
  simple: "14px minmax(0, 1fr) 90px",
  wide: "14px minmax(0, 1fr) 118px 68px 80px 90px",
  /** The navigator tree: state, indented name, whatever the row trails with. */
  tree: "14px minmax(0, 1fr) auto",
} as const;
