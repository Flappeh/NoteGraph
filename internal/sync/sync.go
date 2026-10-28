// Package sync implements the offline-first replication protocol.
//
// Every synced row carries `rev`, the owner's users.sync_rev at the time it
// was written. Clients pull everything with rev > cursor, and push full rows
// together with the rev they last saw (base_rev). A push whose base_rev does
// not match the stored rev is a conflict: nothing is written and the server
// copy is returned so the user can choose which version to keep.
package sync

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flappeh/notegraph/internal/auth"
	"github.com/flappeh/notegraph/internal/httpx"
	"github.com/flappeh/notegraph/internal/storage"
)

type colKind int

const (
	kText colKind = iota
	kNum
	kBool
	kTime
	kUUID  // nullable reference
	kDate  // nullable
	kJSON  // nullable
	kUUIDs // uuid[]
)

// tables lists synced tables and their client-writable columns.
// id, user_id and rev are always controlled by the server.
var tables = map[string][]struct {
	name string
	kind colKind
}{
	"status_categories": {{"name", kText}, {"color", kText}, {"sort", kNum}, {"created_at", kTime}, {"updated_at", kTime}, {"deleted", kBool}},
	"statuses":          {{"category_id", kUUID}, {"name", kText}, {"color", kText}, {"done", kBool}, {"sort", kNum}, {"created_at", kTime}, {"updated_at", kTime}, {"deleted", kBool}},
	"topics":            {{"name", kText}, {"color", kText}, {"icon", kText}, {"default_category_id", kUUID}, {"sort", kNum}, {"created_at", kTime}, {"updated_at", kTime}, {"deleted", kBool}},
	"notes": {{"topic_id", kUUID}, {"parent_id", kUUID}, {"title", kText}, {"content", kJSON}, {"content_text", kText}, {"links", kUUIDs},
		{"color", kText}, {"status_category_id", kUUID}, {"status_id", kUUID}, {"date_start", kDate}, {"date_end", kDate},
		{"sort", kNum}, {"created_at", kTime}, {"updated_at", kTime}, {"deleted", kBool}},
	"attachments": {{"note_id", kUUID}, {"filename", kText}, {"mime", kText}, {"size", kNum}, {"inline", kBool}, {"created_at", kTime}, {"updated_at", kTime}, {"deleted", kBool}},
}

// tableOrder keeps pull output deterministic.
var tableOrder = []string{"status_categories", "statuses", "topics", "notes", "attachments"}

const maxPushBytes = 32 << 20

type Service struct {
	db    *pgxpool.Pool
	files *storage.Store
	auth  *auth.Service
}

func New(db *pgxpool.Pool, files *storage.Store, a *auth.Service) *Service {
	return &Service{db: db, files: files, auth: a}
}

func (s *Service) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/sync", s.auth.RequireUser(http.HandlerFunc(s.handlePull)))
	mux.Handle("POST /api/sync", s.auth.RequireUser(http.HandlerFunc(s.handlePush)))
}

// --- Pull ----------------------------------------------------------------

func (s *Service) handlePull(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := auth.FromContext(ctx)
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)

	// One snapshot so the cursor and rows agree. Pushes of a user are
	// serialised on their users row, so no lower rev can commit later.
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	defer tx.Rollback(ctx)

	var rev int64
	if err := tx.QueryRow(ctx, `SELECT sync_rev FROM users WHERE id = $1`, user.ID).Scan(&rev); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if since > rev { // server data was reset; make the client start over
		since = 0
	}
	changes := map[string][]json.RawMessage{}
	for _, t := range tableOrder {
		rows, err := tx.Query(ctx, `SELECT to_jsonb(t) - 'user_id' FROM `+t+` t WHERE user_id = $1 AND rev > $2 ORDER BY rev`, user.ID, since)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		list := []json.RawMessage{}
		for rows.Next() {
			var b []byte
			if err := rows.Scan(&b); err != nil {
				rows.Close()
				httpx.Internal(w, r, err)
				return
			}
			list = append(list, b)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			httpx.Internal(w, r, err)
			return
		}
		changes[t] = list
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	var out interface{ Write([]byte) (int, error) } = w
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		out = gz
	}
	json.NewEncoder(out).Encode(map[string]any{"rev": rev, "full": since == 0, "changes": changes})
}

// --- Push ----------------------------------------------------------------

type change struct {
	Table   string                     `json:"table"`
	ID      string                     `json:"id"`
	BaseRev int64                      `json:"base_rev"`
	Data    map[string]json.RawMessage `json:"data"`
}

type result struct {
	Table  string          `json:"table"`
	ID     string          `json:"id"`
	Rev    int64           `json:"rev,omitempty"`
	Server json.RawMessage `json:"server,omitempty"` // conflicts: current server row
	Error  string          `json:"error,omitempty"`  // rejected
}

func (s *Service) handlePush(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := auth.FromContext(ctx)
	var in struct {
		Changes []change `json:"changes"`
	}
	if !httpx.Decode(w, r, &in, maxPushBytes) {
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	defer tx.Rollback(ctx)

	var rev int64
	if err := tx.QueryRow(ctx, `UPDATE users SET sync_rev = sync_rev + 1 WHERE id = $1 RETURNING sync_rev`, user.ID).Scan(&rev); err != nil {
		httpx.Internal(w, r, err)
		return
	}

	applied, conflicts, rejected := []result{}, []result{}, []result{}
	var deletedFiles []string
	for _, c := range in.Changes {
		res, kind, wasDeleted, err := s.apply(ctx, tx, user.ID, rev, c)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		switch kind {
		case "applied":
			applied = append(applied, res)
			if wasDeleted && c.Table == "attachments" {
				deletedFiles = append(deletedFiles, c.ID)
			}
		case "conflict":
			conflicts = append(conflicts, res)
		default:
			rejected = append(rejected, res)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(deletedFiles) > 0 {
		go s.removeFiles(user.ID, deletedFiles)
	}
	httpx.JSON(w, 200, map[string]any{"rev": rev, "applied": applied, "conflicts": conflicts, "rejected": rejected})
}

// apply writes one change inside a savepoint. kind is applied, conflict or
// rejected; wasDeleted reports a live row turning into a tombstone.
func (s *Service) apply(ctx context.Context, tx pgx.Tx, userID string, rev int64, c change) (res result, kind string, wasDeleted bool, err error) {
	res = result{Table: c.Table, ID: c.ID}
	cols, ok := tables[c.Table]
	if !ok {
		res.Error = "unknown table"
		return res, "rejected", false, nil
	}
	if _, perr := uuid.Parse(c.ID); perr != nil {
		res.Error = "invalid id"
		return res, "rejected", false, nil
	}

	var owner string
	var curRev int64
	var curDeleted bool
	qerr := tx.QueryRow(ctx, `SELECT user_id::text, rev, deleted FROM `+c.Table+` WHERE id = $1 FOR UPDATE`, c.ID).Scan(&owner, &curRev, &curDeleted)
	exists := qerr == nil
	if qerr != nil && !errors.Is(qerr, pgx.ErrNoRows) {
		return res, "", false, qerr
	}
	if exists && owner != userID {
		res.Error = "not found"
		return res, "rejected", false, nil
	}
	if exists && curRev != c.BaseRev {
		var row []byte
		if err := tx.QueryRow(ctx, `SELECT to_jsonb(t) - 'user_id' FROM `+c.Table+` t WHERE id = $1`, c.ID).Scan(&row); err != nil {
			return res, "", false, err
		}
		res.Server = row
		return res, "conflict", false, nil
	}

	record, newDeleted := normalise(cols, c.Data)
	record["id"], _ = json.Marshal(c.ID)
	record["user_id"], _ = json.Marshal(userID)
	record["rev"], _ = json.Marshal(rev)
	payload, _ := json.Marshal(record)

	set := make([]string, 0, len(cols))
	for _, col := range cols {
		if col.name != "created_at" {
			set = append(set, col.name+" = excluded."+col.name)
		}
	}
	set = append(set, "rev = excluded.rev")
	sql := `INSERT INTO ` + c.Table + ` SELECT * FROM jsonb_populate_record(NULL::` + c.Table + `, $1)
		ON CONFLICT (id) DO UPDATE SET ` + strings.Join(set, ", ")

	sp, err := tx.Begin(ctx) // savepoint: a bad row must not abort the batch
	if err != nil {
		return res, "", false, err
	}
	if _, werr := sp.Exec(ctx, sql, payload); werr != nil {
		sp.Rollback(ctx)
		slog.Warn("sync row rejected", "table", c.Table, "id", c.ID, "err", werr)
		res.Error = "invalid data"
		return res, "rejected", false, nil
	}
	if err := sp.Commit(ctx); err != nil {
		return res, "", false, err
	}
	res.Rev = rev
	return res, "applied", newDeleted && !(exists && curDeleted), nil
}

// normalise fills missing columns with defaults and turns empty strings in
// nullable uuid/date columns into nulls, so jsonb_populate_record never
// violates NOT NULL or fails to cast.
func normalise(cols []struct {
	name string
	kind colKind
}, data map[string]json.RawMessage) (map[string]json.RawMessage, bool) {
	out := make(map[string]json.RawMessage, len(cols)+3)
	now, _ := json.Marshal(time.Now().UTC())
	null := json.RawMessage("null")
	deleted := false
	for _, col := range cols {
		v, ok := data[col.name]
		if ok && string(v) == "null" && (col.kind < kUUID || col.kind == kUUIDs) {
			ok = false // NOT NULL column: fall back to default
		}
		if ok && (col.kind == kUUID || col.kind == kDate) && string(v) == `""` {
			v = null
		}
		if !ok {
			switch col.kind {
			case kText:
				v = json.RawMessage(`""`)
			case kNum:
				v = json.RawMessage("0")
			case kBool:
				v = json.RawMessage("false")
			case kTime:
				v = now
			case kUUIDs:
				v = json.RawMessage("[]")
			default:
				v = null
			}
		}
		if col.name == "deleted" {
			deleted = string(v) == "true"
		}
		out[col.name] = v
	}
	return out, deleted
}

func (s *Service) removeFiles(userID string, ids []string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for _, id := range ids {
		if s.files != nil {
			if err := s.files.Delete(ctx, storage.Key(userID, id)); err != nil {
				slog.Warn("delete object", "id", id, "err", err)
				continue
			}
		}
		s.db.Exec(ctx, `DELETE FROM blobs WHERE id = $1 AND user_id = $2`, id, userID)
	}
}
