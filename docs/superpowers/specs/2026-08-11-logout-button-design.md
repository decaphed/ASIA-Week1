# Logout Button — Design Spec

**Date:** 2026-08-11
**Status:** Approved design, pending implementation

## Problem

The dashboard is gated by Authentik forward-auth (`authentik-auth` middleware, `authentik/traefik/dynamic/dynamic.yml`), but there's no way to log out from the UI — sessions only end on expiry.

## Scope

**In scope:** a logout control in `client/src/components/layout/Topbar.jsx` that ends the Authentik session and returns the user to the login page.

**Out of scope:** any change to Authentik/Traefik config, app-level session/token handling (there is none — auth is entirely proxy-level), confirmation dialogs, or a user menu/dropdown.

## Design

Authentik's forward_single (proxy) outpost exposes a standard sign-out path at `/outpost.goauthentik.io/sign_out` on the protected host, already routed with no auth middleware via the `outpost` router (`dynamic.yml:92-103`) so it's reachable pre- and post-login.

Replace the static, non-interactive avatar placeholder at `Topbar.jsx:49` (`<div className="topbar__avatar" aria-hidden="true">OP</div>`) with a real anchor:

```jsx
<a
  href="/outpost.goauthentik.io/sign_out?rd=/"
  className="topbar__avatar"
  aria-label="Log out"
  title="Log out"
>
  OP
</a>
```

- A plain `<a href>` triggers a real full-page navigation (required — this leaves the SPA and hits a different, non-React path), not a JS click handler.
- The relative path (not `https://dashboard.home/...`) means it works the same regardless of which gated host serves the page.
- `?rd=/` tells the outpost where to send the browser after sign-out; since `/` is itself gated by `authentik-auth`, the immediate next request re-triggers the login flow, landing the user on the login page. Whether that's instant or passes through a brief Authentik-rendered interstitial first is controlled by the invalidation flow configured in Authentik (server-side, not app code) — out of scope here.
- `aria-hidden="true"` is removed since this is now a real interactive, keyboard-focusable element; `aria-label`/`title` replace it for accessibility.
- No new CSS — the existing `.topbar__avatar` class already styles this as a filled circle; browser default anchor styling (underline/color) is expected to be overridden by that same class same as any other styled link in this app.

## Testing

Manual only: log in, click the avatar, confirm the browser lands back on the Authentik login page and that a subsequent request to the dashboard requires login again (session actually ended, not just a client-side redirect).
