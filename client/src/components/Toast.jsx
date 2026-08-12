// Bottom-center toast, matching the design's dark pill with a colored dot.
export default function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 26,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 80,
        background: '#1f2c38',
        color: '#ffffff',
        borderRadius: 8,
        padding: '11px 20px',
        fontSize: 13,
        fontWeight: 500,
        boxShadow: '0 8px 24px rgba(16,24,32,0.3)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        animation: 'fadeUp .25s ease',
      }}
    >
      <span style={{ color: toast.accent }}>●</span> {toast.msg}
    </div>
  );
}
