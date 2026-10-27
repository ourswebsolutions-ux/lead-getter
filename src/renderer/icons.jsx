// Small line icons drawn for Lead Finder (16px grid, 1.6 stroke).
const paths = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></>,
  tag: <><path d="M2.5 8.6V3.2c0-.4.3-.7.7-.7h5.4l5.1 5.1c.3.3.3.7 0 1L8.7 13.6c-.3.3-.7.3-1 0Z" /><circle cx="5.5" cy="5.5" r="1" /></>,
  play: <path d="M5 3.5v9l7-4.5Z" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  download: <><path d="M8 2.5v7.5M5 7l3 3 3-3" /><path d="M3 12.5h10" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c0 .5.5.8 1 .8h3.8c.5 0 .9-.4 1-.8l.6-8.2" /></>,
  external: <><path d="M9 3h4v4M13 3 7.5 8.5" /><path d="M11.5 9.5v3c0 .3-.2.5-.5.5H3.5a.5.5 0 0 1-.5-.5V5c0-.3.2-.5.5-.5h3" /></>,
  chat: <><path d="M8 2.5a5.5 5.5 0 0 0-4.8 8.2L2.5 13.5l2.9-.7A5.5 5.5 0 1 0 8 2.5Z" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  alert: <><path d="M8 2.5 14 13H2Z" /><path d="M8 6.5v3M8 11.2v.1" /></>,
  calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></>,
  inbox: <><path d="M2.5 9.5 4 4h8l1.5 5.5v3c0 .3-.2.5-.5.5H3a.5.5 0 0 1-.5-.5Z" /><path d="M2.5 9.5h3l.8 1.5h3.4l.8-1.5h3" /></>,
  refresh: <><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /></>,
  chevron: <path d="m5 6.5 3 3 3-3" />,
  edit: <><path d="M9.8 3.7 12.3 6.2" /><path d="M3 13l.6-2.8 7.6-7.6c.4-.4 1-.4 1.4 0l1.1 1.1c.4.4.4 1 0 1.4l-7.6 7.6Z" /></>,
  sun: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" /></>,
  moon: <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6Z" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5c0-.6-.4-1-1-1h-6c-.6 0-1 .4-1 1v6c0 .6.4 1 1 1h2" /></>,
  send: <><path d="M13.5 2.5 7 9" /><path d="M13.5 2.5 9.5 13.5 7 9 2.5 6.5Z" /></>,
  pause: <><path d="M5.5 3.5v9M10.5 3.5v9" /></>,
  users: <><circle cx="6" cy="5.5" r="2.2" /><path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" /><path d="M10.5 3.6a2.2 2.2 0 0 1 0 4M12 9.8c1 .5 1.8 1.6 2 3.2" /></>,
};

export default function Icon({ name, size = 16, className = '' }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
