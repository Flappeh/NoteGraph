-- Accounts ------------------------------------------------------------------

CREATE TABLE users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL,
    name          text NOT NULL DEFAULT '',
    password_hash text,
    google_sub    text UNIQUE,
    is_admin      boolean NOT NULL DEFAULT false,
    -- Per-user change counter: every sync push bumps it and stamps the rows it
    -- writes. Updating this row also serialises concurrent pushes of one user.
    sync_rev      bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
    token_hash  text PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- App-wide settings editable by admins. Env vars only provide initial values.
CREATE TABLE settings (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
);

-- Synced entities ----------------------------------------------------------
-- Every synced table has: id (client generated), user_id, rev (user's
-- sync_rev at last write), deleted (tombstone), created_at, updated_at.

CREATE TABLE status_categories (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       text NOT NULL DEFAULT '',
    color      text NOT NULL DEFAULT '',
    sort       double precision NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    rev        bigint NOT NULL DEFAULT 0,
    deleted    boolean NOT NULL DEFAULT false
);
CREATE INDEX status_categories_sync_idx ON status_categories (user_id, rev);

CREATE TABLE statuses (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id uuid,
    name        text NOT NULL DEFAULT '',
    color       text NOT NULL DEFAULT '',
    done        boolean NOT NULL DEFAULT false,
    sort        double precision NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    rev         bigint NOT NULL DEFAULT 0,
    deleted     boolean NOT NULL DEFAULT false
);
CREATE INDEX statuses_sync_idx ON statuses (user_id, rev);

CREATE TABLE topics (
    id                  uuid PRIMARY KEY,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                text NOT NULL DEFAULT '',
    color               text NOT NULL DEFAULT '',
    icon                text NOT NULL DEFAULT '',
    default_category_id uuid,
    sort                double precision NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    rev                 bigint NOT NULL DEFAULT 0,
    deleted             boolean NOT NULL DEFAULT false
);
CREATE INDEX topics_sync_idx ON topics (user_id, rev);

-- Foreign keys between synced rows are intentionally soft (no REFERENCES):
-- offline clients may push children before parents, and tombstones keep ids.
CREATE TABLE notes (
    id                 uuid PRIMARY KEY,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id           uuid,
    parent_id          uuid,
    title              text NOT NULL DEFAULT '',
    content            jsonb,
    content_text       text NOT NULL DEFAULT '',
    links              uuid[] NOT NULL DEFAULT '{}',
    color              text NOT NULL DEFAULT '',
    status_category_id uuid,
    status_id          uuid,
    date_start         date,
    date_end           date,
    sort               double precision NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    rev                bigint NOT NULL DEFAULT 0,
    deleted            boolean NOT NULL DEFAULT false
);
CREATE INDEX notes_sync_idx ON notes (user_id, rev);
CREATE INDEX notes_topic_idx ON notes (user_id, topic_id);

CREATE TABLE attachments (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id    uuid,
    filename   text NOT NULL DEFAULT '',
    mime       text NOT NULL DEFAULT 'application/octet-stream',
    size       bigint NOT NULL DEFAULT 0,
    inline     boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    rev        bigint NOT NULL DEFAULT 0,
    deleted    boolean NOT NULL DEFAULT false
);
CREATE INDEX attachments_sync_idx ON attachments (user_id, rev);

-- Uploaded objects, written by the file endpoint (not synced). Lets the
-- server authorise downloads before the metadata row has been pushed.
CREATE TABLE blobs (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size       bigint NOT NULL,
    mime       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
