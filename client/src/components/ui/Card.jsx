// ─────────────────────────────────────────────────────────────────────────
// Card.jsx — a reusable panel with an optional header (title/subtitle/actions).
//
// Used everywhere to give the dashboard its consistent "framed panel" look.
// Reusable UI primitives like this keep markup DRY and the styling uniform.
// ─────────────────────────────────────────────────────────────────────────

export default function Card({ id, title, subtitle, actions, className = '', children }) {
  const hasHeader = title || subtitle || actions;
  return (
    <section id={id} className={`card ${className}`}>
      {hasHeader && (
        <header className="card__header">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}
