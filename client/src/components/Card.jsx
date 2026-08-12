// Shared white panel with the design's border/shadow treatment.
export default function Card({ style, children }) {
  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid #E2E8F0',
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(16,24,32,0.04), 0 6px 20px rgba(23,37,60,0.05)',
        padding: 20,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Small uppercase section label at the top of most cards.
 *
 * Renders as a real heading by default so assistive tech can navigate the
 * page by section — the design expresses these as plain styled text, which
 * would leave the app with no heading structure at all.
 */
export function CardLabel({ as: Tag = 'h2', children, style }) {
  return (
    <Tag
      style={{
        margin: 0,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: '#8a99a8',
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

/** Rounded status pill: dot + label on a tinted background. */
export function Pill({ color, bg, border, children, square = false, style }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        borderRadius: square ? 4 : 99,
        padding: square ? '3px 9px' : '3px 10px',
        background: bg,
        color,
        border: border ? `1px solid ${border}` : 'none',
        ...style,
      }}
    >
      {!square && <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />}
      {children}
    </span>
  );
}

// Strips UA button chrome so a real <button> can carry the design's styling.
// Every clickable control uses a button rather than a div, so it is
// tab-reachable and handles Enter/Space without extra key plumbing.
export const buttonReset = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  margin: 0,
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'inherit',
  cursor: 'pointer',
};
