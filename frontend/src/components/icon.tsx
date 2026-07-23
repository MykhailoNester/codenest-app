import type { ReactElement } from "react";

interface IconProps {
  name: string;
  size?: number;
  stroke?: number;
  className?: string;
}

const PATHS: Record<string, ReactElement> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  command: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 6h8M8 18h8M6 8v8M18 8v8" />
    </>
  ),
  projects: (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  ),
  tasks: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 9l2 2 4-4M8 16h8" />
    </>
  ),
  sprint: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13h5l1 3h6l1-3h5" />
      <path d="M21 13l-2.5-7A2 2 0 0 0 16.6 5H7.4a2 2 0 0 0-1.9 1L3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6Z" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14.5a4.5 4.5 0 0 1 5.5 4.5" />
    </>
  ),
  docs: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
      <path d="M14 3v6h6M8 13h8M8 17h6" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0v5l1.5 3h-15L6 13V8Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  camera: (
    <>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </>
  ),
  zap: <path d="m13 2-9 12h7l-2 8 9-12h-7l2-8Z" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-5" />
    </>
  ),
  chevronLeft: <path d="m15 6-6 6 6 6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  play: <path d="M6 4v16l14-8L6 4Z" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </>
  ),
  expand: <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />,
  maximize: (
    <>
      <path d="M21 21h-6m6 0v-6" />
      <path d="M3 3h6M3 3v6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </>
  ),
  minimize: (
    <>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="M14 10l7-7" />
      <path d="M3 21l7-7" />
    </>
  ),
  popout: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  marketplace: (
    <>
      <path d="M3 7h18l-2 13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L3 7Z" />
      <path d="M8 7V5a4 4 0 0 1 8 0v2" />
    </>
  ),
  parallel: (
    <>
      <path d="M4 6h6M14 6h6M4 12h6M14 12h6M4 18h6M14 18h6" />
      <circle cx="11" cy="6" r="1" />
      <circle cx="11" cy="12" r="1" />
      <circle cx="11" cy="18" r="1" />
    </>
  ),
  review: (
    <>
      <path d="M9 11l3 3 6-6" />
      <path d="M21 12a9 9 0 1 1-3.5-7.1" />
    </>
  ),
  mcp: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10v4M12 10v4M17 10v4" />
      <circle cx="7" cy="14" r="0.8" />
      <circle cx="12" cy="14" r="0.8" />
      <circle cx="17" cy="14" r="0.8" />
    </>
  ),
  schedules: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  preview: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
      <circle cx="6" cy="7" r="0.6" />
      <circle cx="8" cy="7" r="0.6" />
      <circle cx="10" cy="7" r="0.6" />
    </>
  ),
  library: (
    <>
      <path d="M4 4v16M9 4v16M14 4l3 16M19 4l1 16" />
    </>
  ),
  budget: (
    <>
      <path d="M12 1v22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </>
  ),
  feed: (
    <>
      <path d="M4 4h16M4 10h16M4 16h10" />
      <circle cx="19" cy="16" r="2" />
    </>
  ),
  plugin: (
    <>
      <path d="M9 3v4M15 3v4M5 11h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-3Z" />
    </>
  ),
  integration: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M9 6h6M9 18h6M6 9v6M18 9v6" />
    </>
  ),
  sync: (
    <>
      <path d="M21 12a9 9 0 0 1-14.4 7.2L3 16" />
      <path d="M3 12a9 9 0 0 1 14.4-7.2L21 8" />
      <path d="M21 4v4h-4M3 20v-4h4" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  stroke = 1.5,
  className = "",
}: IconProps): ReactElement | null {
  const paths = PATHS[name];
  if (!paths) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}
