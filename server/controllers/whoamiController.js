// ─────────────────────────────────────────────────────────────────────────
// whoamiController.js — handles GET /api/whoami. Echoes back the identity
// authentikIdentity middleware already attached to the request (see
// middleware/authentikIdentity.js), so the frontend can show/auto-fill the
// signed-in user — e.g. the fault review form's "Reviewed by" field —
// without re-deriving it from headers itself. All fields are null when the
// request carries no Authentik identity (dev/local access).
// ─────────────────────────────────────────────────────────────────────────

export function getWhoami(req, res) {
  res.json({ success: true, data: req.identity });
}
