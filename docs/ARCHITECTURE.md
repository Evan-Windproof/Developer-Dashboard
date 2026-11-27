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
4. In one D1 batch, replace the user's links, upsert metadata, and record the successful sync time. Guard writes with the lease ID. A failed batch leaves the previous snapshot intact. A definitive GitHub access denial clears the user's access links.
5. Return the repository count. The client shows an in-progress state during the request and reloads the overview and repository list when sync finishes.

Cached grants expire after 15 minutes to bound stale visibility. A successful sync revalidates the grant list. Temporary network errors can leave the previous snapshot accessible through the rest of its lifetime.

The sync runs in one request with a deadline. Accounts spanning many installations or pages may reach Cloudflare invocation, D1 query, or GitHub limits. App installations that return a confirmed access denial can cause a sync to fail until access is corrected. Phase 1 keeps synchronization user-initiated. Queue-based sync and revocation events are candidates for later work.

## Personal tags

Migration `0002_repository_tags.sql` adds `tags` and `repository_tags` to the existing D1 database. A composite foreign key ties each assignment to a tag owned by the same user. Tag deletion cascades to assignments. Repository reads and assignment writes still require the caller's current repository grant.

Sync updates GitHub metadata and replaces access grants. Tag assignments point to stable repository IDs, so syncing or temporarily losing access leaves the assignments intact. The dashboard shows those assignments again if access returns.
