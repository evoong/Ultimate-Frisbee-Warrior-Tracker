# Auth email templates (hosted Supabase)

The hosted project does not read these files -- paste them into the dashboard
(Authentication -> Email Templates). They link to the app's own
`/auth/callback?token_hash=...&type=...` route, which verifies the link and sets
the session cookies; Supabase's default `{{ .ConfirmationURL }}` lands on a page
that never reads the tokens.

| Template | File | Subject |
|---|---|---|
| Magic Link | `magic_link.html` | You've been invited to Warrior Tracker |
| Confirm signup | `confirmation.html` | Confirm your Warrior Tracker email |

Also set Authentication -> URL Configuration -> Site URL to the production URL
(`{{ .SiteURL }}` is used in the links).
