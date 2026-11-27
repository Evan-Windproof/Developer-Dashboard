# Architecture

Cloudflare Workers serves the Vite build from static assets. Requests for `/api` and `/api/*` run the Worker at `server/worker.ts`, which delegates to the same-origin REST API. D1 holds persistent data. The React client uses the dashboard API for all account and repository data.

| Module | Responsibility |
| --- | --- |
| `server/api.ts` | Routing, method validation, request checks, responses |
| `server/auth.ts` | Browser-bound OAuth state, sessions, logout, credential refresh |
| `server/github.ts` | GitHub OAuth token exchange, App JWT signing, REST pagination, rate-limit errors |
| `server/repositories.ts` | Installation association, atomic sync, scoped queries, overview aggregates |

## Database

| Table | Stores |
| --- | --- |
| `users` | Stable GitHub account IDs, profiles, sync timestamps and locks |
| `sessions` | Hashed random session identifiers, user IDs, and expirations |
| `github_credentials` | Encrypted token sets per user and a refresh lease |
| `oauth_states` | Hashed expiring login or installation state |
| `installations` and `user_installations` | GitHub App installations and associations confirmed by the user's token |
| `repositories` and `installation_repositories` | Shared metadata keyed by immutable GitHub IDs and installation mappings |
| `user_repository_access` | Per-user repository access through a specific installation |

Foreign keys ensure per-user grants refer to both a user-installation association and an installation-repository association. A user can reach the same repository through multiple installations. The query deduplicates its ID before joining repository metadata. Users and repositories have stable IDs. Future preferences can use `(user_id, repository_id)`, and tags can use user-owned tag records plus a repository join table. Sync only replaces access links and updates GitHub metadata.

## Synchronization

1. Acquire a database-backed lease for the user. Concurrent attempts receive an error and recent attempts have a short cooldown.
2. Refresh the user access token if needed. Page through the installations visible to that user.
3. For each installation, page through the user's visible repository IDs. If the list has entries, mint a Metadata-only installation token and page through the installation's repository metadata. Keep the intersection.
4. Commit changes in one D1 batch. Replace grants for successful installations and remove installations omitted by a complete discovery response. A completed user repository listing can confirm narrower revocations even if a later installation request fails. Keep remaining grants for failed installations at their prior expiry. Account-wide credential failures can clear all access grants. Guard snapshot writes with the lease ID.
5. Report complete or partial results independently from the client's follow-up refreshes. The UI can retry a failed Overview, GitHub installations, or Tags read separately. Server logs record a run ID, installation outcomes, counts, durations, and sanitized error codes.

Cached grants expire after 15 minutes. D1 has one freshness timestamp per user. If a partial run retains unverified grants, the old expiry still applies to that user's snapshot, including healthy installations. A partial run can advance the timestamp when no unverified grants are retained. Tags and repository metadata remain stored when access is removed or expires.

Sync still runs in one request. Large installations can reach Cloudflare or GitHub limits. Rate limits stop further upstream requests during that run and set a retry delay.

## Personal tags

Migration `0002_repository_tags.sql` adds `tags` and `repository_tags` to the existing D1 database. A composite foreign key ties each assignment to a tag owned by the same user. Tag deletion cascades to assignments. Repository reads and assignment writes still require the caller's current repository grant.

Sync updates GitHub metadata and replaces access grants. Tag assignments point to stable repository IDs, so syncing or temporarily losing access leaves the assignments intact. The dashboard shows those assignments again if access returns.
