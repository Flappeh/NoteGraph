# NoteGraph

Offline-first notes with a bit of project management and an Obsidian-style graph.

- **Topics → notes → child notes** (unlimited depth), each with a colour
- **Statuses** grouped in user-defined categories (e.g. *Progress*: Not Yet / On Progress / Completed); pick a category on the note, then a status in it. Topic list + drag-and-drop status board.
- **Dates** (single day or range), upcoming / past-due overview on Home
- **WYSIWYG editor** with view/edit mode: headings, fonts, sizes, colours, highlight, alignment, lists, checklists, tables, code, links
- **Images inline** (paste, drop or toolbar) and **file attachments** listed per note
- **`[[note links]]`** with autocomplete (or create a note on the fly), backlinks
- **Graph**: note cards show title, date and status; parent→child, topic and link edges; force or tree layout
- **PWA**: installable on phone/desktop, works offline, syncs when back online; conflicting edits are shown side by side and you choose which version to keep
- **Auth**: email/password and Google; per-user private data

## Architecture

```
Browser (PWA) ── IndexedDB (Dexie) ── sync engine ──►  Go server (stateless, N replicas)
                                                         ├── Postgres  (all data, sessions, settings)
                                                         └── S3/MinIO  (attachment bytes, proxied)
```

- The UI only reads and writes the local database. Changes are pushed and pulled in the background (`web/src/sync.ts`).
- Every synced row has a `rev` (the owner's change counter). A push carries the rev it was based on; if the server has a newer rev the row is returned as a **conflict** instead of being overwritten (`internal/sync/sync.go`).
- The server keeps no state: sessions, settings and data live in Postgres, so any replica can serve any request.
- Attachment uploads/downloads go through the server, so the bucket stays private and only needs to be reachable from the swarm.
- Single static binary with the web app embedded; image ≈ 16 MB, ≈ 10 MB RAM per replica at idle.

## Configuration

Every variable can also be given as a file via `NAME_FILE` (Docker secrets).

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — (required) | `postgres://notegraph:…@host:5432/notegraph?sslmode=disable` |
| `PG_HOST` `PG_PORT` `PG_USER` `PG_PASSWORD` `PG_DATABASE` `PG_SSLMODE` | — / 5432 / … / `prefer` | Alternative to `DATABASE_URL` (e.g. from `.env.database`) |
| `APP_URL` | `http://localhost:8080` | Public URL; used for the Google redirect and secure cookies |
| `LISTEN_ADDR` | `:8080` | |
| `ADMIN_EMAIL` | — | This email becomes admin (the first account always does) |
| `ALLOW_SIGNUP` | `true` | *Seed only* — change later in Settings → Server |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | *Seed only* — editable in Settings → Server |
| `S3_ENDPOINT` | — | `host:port` or URL. Without it attachments are disabled |
| `S3_BUCKET` | `notegraph` | Created on start if missing |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | Dedicated key limited to this bucket |
| `S3_REGION` / `S3_USE_SSL` | `us-east-1` / `true` | |
| `MAX_UPLOAD_MB` | `50` | Per file |

"Seed only" settings are written to the `settings` table the first time the app starts; after that the values in the app win.

**Google sign-in:** create an OAuth client (Web application) in Google Cloud Console and add `APP_URL/api/auth/google/callback` as an authorised redirect URI (Settings → Server shows the exact value).

## Local development

```bash
docker compose -p notegraph-dev -f deploy/docker-compose.dev.yml up -d   # Postgres + S3 (SeaweedFS)

cd web && npm ci && npm run build && cd ..                               # build the PWA (embedded into the binary)
DATABASE_URL="postgres://notegraph:notegraph@localhost:5432/notegraph?sslmode=disable" \
APP_URL=http://localhost:8787 LISTEN_ADDR=:8787 \
S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=notegraph S3_SECRET_KEY=notegraph-dev-secret \
go run .
```

For frontend work run `npm run dev` in `web/`; Vite proxies `/api` to `http://localhost:8787` (override with `API_URL`).

## Deploying to the swarm

1. Create the database and a dedicated role (as a Postgres superuser):
   `psql -h <host> -U postgres -v pw="'<password>'" -f deploy/init-db.sql`
2. Create a bucket key limited to the `notegraph` bucket on your S3/MinIO.
3. Create the secrets: `notegraph_database_url`, `notegraph_s3_secret_key`, `notegraph_google_client_secret` (use an empty value if unused).
4. Build and push the image: `docker build -t <registry>/notegraph:<version> .`
5. `NOTEGRAPH_IMAGE=<registry>/notegraph:<version> NOTEGRAPH_S3_ENDPOINT=<host:port> docker stack deploy -c deploy/stack.yml notegraph`

Migrations run automatically on start (guarded by a Postgres advisory lock, so replicas can start together).

## Project layout

```
main.go                     entrypoint (also `notegraph healthcheck`)
internal/auth               accounts, sessions, Google OAuth, admin settings API
internal/sync               pull/push replication + conflict detection
internal/files              attachment upload/download proxy
internal/storage            S3 client
internal/db/migrations      SQL schema
web/src/db.ts               local IndexedDB schema and write helpers
web/src/sync.ts             client sync engine + conflict resolution
web/src/editor              TipTap editor, [[note link]] and attachment-image extensions
web/src/pages               Home, Topic (list/board), Note, Graph, Statuses, Conflicts, Settings
```
