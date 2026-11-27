# Evan Developer Dashboard

Evan Developer Dashboard is an open-source workspace for browsing GitHub repositories across personal and organization installations. Each developer signs in with their own GitHub account and sees the repositories they can access through the dashboard's GitHub App.

## Features

- GitHub sign-in and installation verification for personal accounts and organizations.
- Manual repository synchronization with pagination, progress feedback, rate-limit handling, and the last successful sync time.
- Overview with repository counts, stars, forks, and recently updated repositories.
- Search, filters, sorting, pagination, and repository details.
- Personal tags with custom colors, multiple tags per repository, and any/all tag filters.
- Responsive layout with light and dark themes, plus initial system preference detection.

## Architecture

React, TypeScript, Vite, and CSS power the frontend. Cloudflare Workers serves the built assets and runs the same-origin REST API. Cloudflare D1 stores sessions, encrypted GitHub user credentials, repository metadata, and per-user access. The GitHub REST API supplies all repository data.

See [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), and the [REST API](docs/API.md).

## Screenshots

Screenshots will be added after the first configured GitHub App walkthrough.

## Local development

Use Node.js 22.13 or newer, with Node.js 24 recommended, and npm. For a complete local sign-in, [create a development GitHub App](docs/GITHUB-APP-SETUP.md).

```sh
npm ci
cp .env.example .dev.vars
npm run db:local
npm run dev
```

Fill in `.dev.vars` before trying GitHub sign-in. Generate the encryption key with `openssl rand -base64 32`. Open `http://localhost:8788` so the app origin, cookie host, and registered callback match. Rerun `npm run build` to rebuild frontend assets after editing them. Wrangler watches changes to the Worker.

```sh
npm test
npm run build
curl -fsS http://localhost:8788/api/health
```

For an existing local database, run `npm run db:local` to apply the additive tag migration. Restart the app, sign in, and sync your repositories. On **Repositories**, open **Manage tags** to create two tags. Assign both in a repository's details, then use **Filter by tags** to compare any/all results. Sync again and check the badges. Deleting a tag removes its assignments while keeping the repositories.

The test suite uses the real migrations in an isolated local D1 database and mocked GitHub requests. It needs no GitHub credentials. The health check exercises the configured D1 binding after `npm run dev` starts.

## Configuration

| Variable | Purpose | Production storage |
| --- | --- | --- |
| `APP_BASE_URL` | Exact deployment origin, such as `https://dashboard.example.com` | Wrangler `[vars]` |
| `GITHUB_APP_SLUG` | App slug used for the installation URL | Wrangler `[vars]` |
| `GITHUB_CLIENT_ID` | GitHub App OAuth client ID | Wrangler `[vars]` |
| `GITHUB_APP_ID` | Numeric GitHub App ID for signing app JWTs | Wrangler `[vars]` |
| `GITHUB_CLIENT_SECRET` | GitHub App OAuth client secret | Worker secret |
| `GITHUB_PRIVATE_KEY` | GitHub App RSA private key, PEM | Worker secret |
| `SESSION_ENCRYPTION_KEY` | Base64-encoded 32-byte key for GitHub credentials | Worker secret |

Use `.dev.vars` for local values. `GITHUB_PRIVATE_KEY` accepts an unencrypted RSA PEM with matching `RSA PRIVATE KEY` (PKCS#1) or `PRIVATE KEY` (PKCS#8) boundaries. Use actual LF or Windows CRLF line endings, or escaped `\n` or `\r\n` in a single-line variable. Keep the GitHub private key outside the repository.

## Cloudflare Workers production

The `production` environment targets `https://dashboard.evanwindproof.top` and uses a separate D1 database and Worker secrets. The default local environment uses `http://localhost:8788`, the existing local D1 persistence, and `.dev.vars`.

Phase 3.1 prepares the configuration. See the [production runbook](docs/PRODUCTION.md) for required values, domain and GitHub App setup, the migration audit, and the steps for an authorized Phase 3.2 deployment. See the [tag transfer procedure](docs/TAG-TRANSFER.md) to carry over personal tags without transferring sessions or credentials.

## Security

The GitHub App needs only read-only repository Metadata. Sessions use HttpOnly cookies and hashed identifiers. GitHub user credentials are encrypted before they reach D1 and stay server-side. Authorization snapshots expire after 15 minutes. Sync again to verify current repository access. See [security details](docs/SECURITY.md).

## License

[GNU General Public License v3.0](LICENSE).
