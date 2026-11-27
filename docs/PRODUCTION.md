# Cloudflare Workers production runbook

Cloudflare Workers Builds builds from `main` and deploys the default Wrangler configuration to the existing `developer-dashboard` Worker.

| Setting | Local development | Production |
| --- | --- | --- |
| Worker | `npm run dev` with `--config wrangler.local.toml --local` | `developer-dashboard` |
| Origin | `http://localhost:8788` in `.dev.vars` | `https://dashboard.evanwindproof.top` in `[vars]` |
| D1 binding | `DB` with existing `.wrangler/state/v3/d1` | `DB` bound to `evan-developer-dashboard-prod` |
| Secrets | `.dev.vars` | Existing Worker secrets |
| Assets | Local Vite `dist` | Workers Static Assets from Vite `dist` |

Wrangler sends `/api` and `/api/*` to the Worker before static asset handling. Other paths serve the Vite app with SPA fallback. Production disables `workers.dev` and preview URLs.

## Workers Builds

The build command is `npm run build`. The deploy command for the existing Builds project is `npx wrangler deploy`. The top-level Worker name matches the Builds project. The default binding uses production database ID `0e6ddcb9-9340-4613-8773-6331ba97844b`. This configuration release uses the existing D1 schema and data.

Keep `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, and `GITHUB_APP_ID` in the existing Worker's runtime variables. `keep_vars = true` preserves dashboard-defined variables during deployment. The committed HTTPS `APP_BASE_URL` takes precedence for that variable. Local npm commands use `--config wrangler.local.toml --local` and the ignored `.dev.vars` file.

After a successful build, verify HTTPS and assets, call `/api/health`, and exercise sign-in, installation, and sync. Confirm an account without a grant cannot access another user's private repositories.

## GitHub App setup

Set the production **Homepage URL** to `https://dashboard.evanwindproof.top` and register the exact **Callback URL** `https://dashboard.evanwindproof.top/api/auth/github/callback`. Keep `http://localhost:8788/api/auth/github/callback` registered if using the same App for local OAuth. The dashboard always sends the callback derived from its configured origin. Keep expiring user tokens and repository Metadata read-only.

GitHub's **Setup URL** is separate from the OAuth callback and an App has one setup URL. Set a production App's **Setup URL** to `https://dashboard.evanwindproof.top/api/github/installation/callback`. Keeping full local installation callbacks requires a separate development App configured with `http://localhost:8788/api/github/installation/callback`. With one shared App, an existing authorized installation can still be discovered by **Sync Repositories** in local development. See the [GitHub App setup guide](GITHUB-APP-SETUP.md).

## Secret checklist

Verify the existing `developer-dashboard` Worker lists these secret names under **Settings → Variables and Secrets**:

- `GITHUB_CLIENT_SECRET`
- `GITHUB_PRIVATE_KEY`
- `SESSION_ENCRYPTION_KEY`

From an authenticated terminal, `npx wrangler secret list` also lists names. The configuration fix uses the existing secret bindings. The RSA secret accepts a full PEM with real or escaped line breaks. The encryption key is Base64 for 32 bytes.

## Custom domain

In the Cloudflare account that owns the active `evanwindproof.top` zone, review **DNS → Records**, **Workers Routes**, and existing Workers' **Domains & Routes** for the exact hostname and any overlapping route. Check for an existing Pages custom domain on the hostname as well. Resolve any conflict with the service owner before deployment. The configured Worker Custom Domain lets Cloudflare provision the required DNS record and TLS. Verify attachment and certificate readiness under the `developer-dashboard` Worker's **Domains & Routes**.

Cloudflare authentication was unavailable during preparation. The local resolver returned no address and the external DNS-over-HTTPS query was blocked, so the DNS record and Cloudflare route inventory still require an authenticated preflight.

## Migration audit

| Migration | Data impact |
| --- | --- |
| `0001_initial.sql` | Creates accounts, sessions, encrypted credentials, installations, repository metadata, and access grants with foreign keys and indexes. |
| `0002_repository_tags.sql` | Adds user-scoped tags and repository assignments with uniqueness and cascading deletion constraints. It leaves Phase 1 tables and records in place. |

For a fresh database, apply both migrations in order. On an existing database, use Wrangler's migration tracking to apply only pending files. The automated suite tests the additive migration against Phase 1 data and verifies tenant isolation, tags and sync behavior. An isolated local Wrangler database also exercises the production binding and migrations without contacting remote D1.

## Security review

- Protected routes validate an unexpired server-side session. HTTPS uses host-only secure HTTP-only cookies with SameSite=Lax. State-changing requests check the exact configured Origin.
- OAuth uses PKCE and short-lived, single-use state tied to the browser. Installation callbacks verify ownership. GitHub tokens remain server-side, encrypted at rest with user-bound authenticated encryption. Upstream redirects are handled without forwarding credentials.
- Repository reads and tag writes enforce user ownership and current GitHub access grants. Sync snapshots may retain access until resync or the existing 15-minute expiry. No change to that policy was made in preparation.
- Error responses are sanitized. OAuth diagnostics are opt-in and log fixed classifications. Production secrets belong in Wrangler Secrets and static assets retain the CSP and other browser headers.
