# Security

## Public demo boundary

`GET /api/public/repositories` is the only unauthenticated data endpoint. It reads the fixed public GitHub account `Evan-Windproof`, filters out private repositories, and returns an allowlist of public repository metadata only. It does not query D1, access GitHub App credentials, or return personal tags. All personal dashboard endpoints remain session-protected.

## Authentication and sessions

Login and installation callbacks require a random state value, the matching HttpOnly browser cookie, and an unexpired hash in D1. Each callback consumes its state with a single conditional delete. Installation state is also bound to the current session. GitHub's user installations endpoint verifies access to the installation before D1 associates it with the user. GitHub sign-in also uses an S256 PKCE challenge with a verifier held in the login cookie.

A signed-in user receives a seven-day opaque cookie. D1 stores its SHA-256 hash. Every protected API request checks the session and its expiration in D1. Sessions are rotated on successful sign-in and deleted on logout. Cookies use SameSite=Lax, HttpOnly, and a root path. HTTPS deployments also use Secure and the host-only `__Host-` prefix. HTTP is supported only for a loopback origin.

State-changing API requests require an exact configured `Origin`. The installation URL requires a same-origin JavaScript request with the dashboard header. Callback POSTs are disallowed. API responses use no-store, a restrictive CSP, and no CORS grants.

## GitHub credentials

Grant the GitHub App repository Metadata read-only and leave other permissions unset. Use a public GitHub App so independent users can install it. An organization may require admin approval.

The API receives GitHub user tokens and uses AES-256-GCM with a fresh random nonce for each write. The internal user ID is authenticated as additional data. D1 stores ciphertext and nonce. A database lease serializes expiring token refreshes, and a conditional write protects against replacing newer credentials. GitHub installation tokens stay in memory for one sync. App signing keys and client secrets stay in Cloudflare secrets and local ignored config files.

Back up the encryption key securely. Changing it requires a credential migration or invalidation of the previous encrypted credentials and new GitHub sign-ins. Revoke a compromised GitHub private key or client secret in GitHub and update the corresponding Worker secret.

## Authorization

A shared organization installation can expose different repositories to different members. Sync intersects the user access token's repository list with the installation token's list and stores grants per user. All reads, including details and aggregates, require a grant for the authenticated user. Repository details outside the user's scope return 404.

Phase 1 detects removals on sync and stops serving snapshots after 15 minutes. Changes on GitHub can take up to that window to affect a previously cached snapshot. Logout ends the dashboard session without revoking GitHub authorization. Users can revoke authorization or change repository selection on GitHub. D1 retains shared metadata and encrypted credentials for resynchronization. Restrict access to the database and its backups to trusted operators.

Manual sync has a per-user cooldown and concurrency guard. GitHub throttle responses set a backoff period. Production operators can add edge rate limits for public OAuth entry points if needed.
