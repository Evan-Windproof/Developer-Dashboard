# Transfer personal tags between D1 databases

This exports tag names, colors, creation times, owner GitHub IDs, and the GitHub repository ID and `full_name` for each assignment. Keep the export private because it can name private repositories. Store transfer files in the ignored `.metadata-transfer` directory. The commands below use Bash or PowerShell 7.

## Export and rehearse locally

```sh
mkdir .metadata-transfer
npx wrangler d1 execute DB --local --file scripts/export-tag-metadata.sql --json > .metadata-transfer/tags.json
node scripts/prepare-tag-import.mjs apply .metadata-transfer/tags.json > .metadata-transfer/apply.sql
node scripts/prepare-tag-import.mjs verify .metadata-transfer/tags.json > .metadata-transfer/verify.sql
```

Review both generated SQL files. An empty export produces empty SQL files and needs no import. The export query reads only user GitHub IDs, personal tags, and the repository identities tied to assignments. Sessions, OAuth state, credentials, repository grants, and other profile data are outside the export.

Use an isolated D1 persistence directory for a rehearsal. Run `npx wrangler d1 migrations apply DB --local --persist-to .metadata-transfer/rehearsal`, then start Wrangler on port 8788 with `npx wrangler dev --local --port 8788 --persist-to .metadata-transfer/rehearsal`. Sign in as the matching GitHub users and sync their repositories. Run the following against that same directory:

```sh
npx wrangler d1 execute DB --local --persist-to .metadata-transfer/rehearsal --file .metadata-transfer/verify.sql
npx wrangler d1 execute DB --local --persist-to .metadata-transfer/rehearsal --file .metadata-transfer/apply.sql
npx wrangler d1 execute DB --local --persist-to .metadata-transfer/rehearsal --file .metadata-transfer/verify.sql
```

## Import into production in Phase 3.2

After authorization and initial deployment, confirm the production database ID and take a D1 snapshot or note its Time Travel bookmark before importing. Have each tag owner sign in using the same GitHub account and sync from their production installation. Run the read-only verification first, then apply and recheck against the explicit production binding:

```sh
npx wrangler d1 execute DB --env production --remote --file .metadata-transfer/verify.sql
npx wrangler d1 execute DB --env production --remote --file .metadata-transfer/apply.sql
npx wrangler d1 execute DB --env production --remote --file .metadata-transfer/verify.sql
```

A successful transfer reports `present` for all tags and assignments. Before apply, a `missing_tag` or `missing_assignment` can indicate an item ready to import. For `missing_owner`, have the matching owner sign in. For `missing_repository` or `sync_required`, verify the installation grant and sync again within 15 minutes before retrying. For `tag_conflict`, review the existing tag's name and color with the owner. The import preserves that tag and skips assignments that would merge into it.

Owners match by stable GitHub user ID. Assignments match by stable GitHub repository ID and require a fresh access grant. The report displays source and target `full_name` values for reviewing renames or transfers. A repo recreated under the old name requires manual review because its GitHub ID differs. Re-running apply is safe after an interrupted import. It inserts missing tags and assignments and leaves existing records and the source database untouched.
