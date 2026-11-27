# REST API

All endpoints use the dashboard origin. JSON successes use `{ "data": ... }`. JSON errors use `{ "error": { "code": "...", "message": "..." } }`. Browser authorization endpoints redirect. Authenticated calls use the dashboard cookie. No API response contains GitHub user or installation tokens.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Checks the D1 binding and returns `{"data":{"status":"ok"}}`. |
| GET | `/api/auth/github/start` | Starts browser authorization and sets the login state cookie. |
| GET | `/api/auth/github/callback` | Consumes state, exchanges the code, and establishes a session. Redirects to the dashboard. |
| POST | `/api/auth/logout` | Deletes the current session and expires its cookie. |
| GET | `/api/me` | Returns the signed-in GitHub user ID, login, display name, and avatar URL. |
| GET | `/api/github/installations` | Lists confirmed installations associated with the signed-in account. |
| GET | `/api/github/installations/install-url` | Creates installation state and returns a GitHub installation URL. Requires `X-Dashboard-Request: 1`. |
| GET | `/api/github/installation/callback` | Consumes state and verifies the installation ID with GitHub. Redirects to the dashboard. |
| GET | `/api/overview` | Returns counts, star and fork totals, five recently updated repos, languages, `lastSync`, and `accessExpired`. |
| GET | `/api/repositories` | Returns `repositories`, `total`, `page`, and `pageSize`. |
| GET | `/api/repositories/:id` | Returns metadata for the GitHub repository ID when accessible. |
| POST | `/api/repositories/sync` | Refreshes access and metadata. Returns `lastSync` and `total`. |

All mutations require an `Origin` matching `APP_BASE_URL`. Tag creation and updates accept JSON. Other mutations accept no request body. Stale access snapshots return empty lists and 404 for details until a successful sync.

## Repository list parameters

| Parameter | Values |
| --- | --- |
| `q` | Search name, full name, or description. Maximum 200 characters. |
| `visibility` | `public`, `private`, or `internal` |
| `archived` | `true` or `false` |
| `fork` | `true` or `false` |
| `language` | Case-insensitive language name. Maximum 80 characters. |
| `sort` | `updated` (default), `created`, `name`, `stars`, or `forks` |
| `page` | 1-based page number. Default 1. |
| `pageSize` | 1 through 100. Default 20. |

Repository metadata includes the immutable GitHub `id`, owner, name, full name, description, GitHub URL, visibility, language, stars, forks, issue count, default branch, GitHub timestamps, archived and fork flags, and the metadata sync timestamp. GitHub's open issue count can include open pull requests.

Common error statuses include 400 for invalid input, 401 for missing or expired authorization, 403 for denied access or an origin check, 404 for missing or inaccessible repository IDs, 405 for unsupported methods, 409 for concurrent sync or refresh, 429 for throttling, and 503 for temporary GitHub errors. A 429 response includes `Retry-After` in seconds.

## Personal repository tags

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/tags` | Lists the signed-in user's tags. |
| POST | `/api/tags` | Creates a tag and returns HTTP 201. |
| PATCH | `/api/tags/:id` | Updates an owned tag's name and color. |
| DELETE | `/api/tags/:id` | Deletes an owned tag and its assignments. |
| PUT | `/api/repositories/:id/tags/:tagId` | Assigns an owned tag to an accessible repository. |
| DELETE | `/api/repositories/:id/tags/:tagId` | Removes that assignment. |

Tag creation and updates accept JSON with `name` (1–60 characters after trimming) and `color` (`#RRGGBB`). Names must be unique per user after Unicode normalization and lowercasing. Duplicate names return HTTP 409. All mutations require the configured origin. Tag operations on an inaccessible repository or another user's tag return HTTP 404.

Repository list, detail, and overview results include each repository's `tags` array with `id`, `name`, `color`, and `created_at`. To filter the repository list, repeat the `tag` query parameter for each selected ID. Use `tagMode=any` (default) or `tagMode=all`. Tag filtering combines with search and other filters before pagination. Up to 100 tag IDs may be supplied.
