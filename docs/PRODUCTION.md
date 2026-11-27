# Cloudflare Workers production runbook

Phase 3.1 prepares the Worker and its configuration. Run remote write commands below only in authorized Phase 3.2.

| Setting | Local default | Production environment |
| --- | --- | --- |
| Worker | `evan-developer-dashboard` via `npm run dev` | `evan-developer-dashboard-prod` via `--env production` |
| Origin | `http://localhost:8788` | `https://dashboard.evanwindproof.top` |
| D1 binding | `DB` with existing `.wrangler/state/v3/d1` | `DB` bound to `evan-developer-dashboard-prod` |
| Secrets | `.dev.vars` | Independent Worker secrets |
| Assets | Local Vite `dist` | Workers Static Assets from Vite `dist` |

Wrangler sends `/api` and `/api/*` to the Worker before static asset handling. Other paths serve the Vite app with SPA fallback. Production disables `workers.dev` and preview URLs. Local configuration keeps the existing database name, binding, ID and default persistence path.

## Phase 3.2 order of operations

1. Authenticate with `npx wrangler login`. Run `npx wrangler d1 info evan-developer-dashboard-prod --env production` to confirm the Cloudflare account and the existing APAC database. Its ID is `0e6ddcb9-9340-4613-8773-6331ba97844b`.
2. Confirm that the returned ID matches the `DB` binding under `[[env.production.d1_databases]]` in `wrangler.toml`. Under `[env.production.vars]`, set the GitHub App's `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, and numeric `GITHUB_APP_ID` as strings. Keep `APP_BASE_URL` set to the exact HTTPS origin. `OAUTH_DIAGNOSTICS` is optional and defaults to disabled.
3. Review the custom domain and GitHub App settings below. Apply the schema with `npx wrangler d1 migrations apply DB --env production --remote`, then confirm the migration list with `npx wrangler d1 migrations list DB --env production --remote`.
4. Provision the production Worker and configure its secrets using the commands below. Confirm the deployed Worker has all three secrets before attempting sign-in.
5. Run `npm run build`, then `npx wrangler deploy --env production`. Verify the domain's TLS certificate, load the dashboard, call `/api/health`, and exercise sign-in, installation and sync. Confirm an account with no grant cannot access another user's private repositories. Use the [tag transfer procedure](TAG-TRANSFER.md) if retaining local tags.

## GitHub App setup

Set the production **Homepage URL** to `https://dashboard.evanwindproof.top` and register the exact **Callback URL** `https://dashboard.evanwindproof.top/api/auth/github/callback`. Keep `http://localhost:8788/api/auth/github/callback` registered if using the same App for local OAuth. The dashboard always sends the callback derived from its configured origin. Keep expiring user tokens and repository Metadata read-only.

GitHub's **Setup URL** is separate from the OAuth callback and an App has one setup URL. Set a production App's **Setup URL** to `https://dashboard.evanwindproof.top/api/github/installation/callback`. Keeping full local installation callbacks requires a separate development App configured with `http://localhost:8788/api/github/installation/callback`. With one shared App, an existing authorized installation can still be discovered by **Sync Repositories** in local development. See the [GitHub App setup guide](GITHUB-APP-SETUP.md).

## Secret checklist

Run these interactively from your own authenticated terminal. Keep the GitHub values associated with the selected App and generate a separate 32-byte Base64 encryption key for production. Back up the encryption key securely for future use.

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
npx wrangler secret put GITHUB_PRIVATE_KEY --env production
npx wrangler secret put SESSION_ENCRYPTION_KEY --env production
npx wrangler secret list --env production
```

The RSA key accepts full PEM text with real or escaped line breaks. Wrangler can offer to create a missing Worker when storing a secret. Accept only in Phase 3.2 and confirm the name shown is `evan-developer-dashboard-prod`. Use `openssl rand -base64 32` locally to generate the production encryption key. Enter it only at the Wrangler prompt.

## Custom domain

In the Cloudflare account that owns the active `evanwindproof.top` zone, review **DNS → Records**, **Workers Routes**, and existing Workers' **Domains & Routes** for the exact hostname and any overlapping route. Check for an existing Pages custom domain on the hostname as well. Resolve any conflict with the service owner before deployment. The configured Worker Custom Domain lets Cloudflare provision the required DNS record and TLS. Verify attachment and certificate readiness under the production Worker's **Domains & Routes**.

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
