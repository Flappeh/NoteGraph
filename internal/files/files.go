// Package files proxies attachment uploads and downloads to object storage,
// so the bucket never has to be reachable from clients.
package files

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flappeh/notegraph/internal/auth"
	"github.com/flappeh/notegraph/internal/httpx"
	"github.com/flappeh/notegraph/internal/storage"
)

// Types safe to render inline on our origin. Anything else (HTML, SVG, ...)
// is served as a download so uploaded files can never run script.
var inlineTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true,
	"application/pdf": true, "video/mp4": true, "video/webm": true, "audio/mpeg": true, "audio/ogg": true,
	"audio/wav": true, "text/plain": true,
}

type Service struct {
	db       *pgxpool.Pool
	store    *storage.Store
	auth     *auth.Service
	maxBytes int64
}

func New(db *pgxpool.Pool, store *storage.Store, a *auth.Service, maxBytes int64) *Service {
	return &Service{db: db, store: store, auth: a, maxBytes: maxBytes}
}

func (s *Service) Routes(mux *http.ServeMux) {
	mux.Handle("PUT /api/files/{id}", s.auth.RequireUser(http.HandlerFunc(s.handleUpload)))
	mux.Handle("GET /api/files/{id}", s.auth.RequireUser(http.HandlerFunc(s.handleDownload)))
	mux.HandleFunc("GET /api/files", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]any{"enabled": s.store != nil, "max_bytes": s.maxBytes})
	})
}

func (s *Service) handleUpload(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		httpx.Error(w, 503, "attachments are not configured on this server")
		return
	}
	ctx := r.Context()
	user := auth.FromContext(ctx)
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Error(w, 400, "invalid id")
		return
	}
	if r.ContentLength <= 0 {
		httpx.Error(w, 411, "Content-Length required")
		return
	}
	if r.ContentLength > s.maxBytes {
		httpx.Error(w, 413, fmt.Sprintf("file is larger than %d MB", s.maxBytes>>20))
		return
	}
	var owner string
	err := s.db.QueryRow(ctx, `SELECT user_id::text FROM blobs WHERE id = $1`, id).Scan(&owner)
	if err == nil && owner != user.ID {
		httpx.Error(w, 403, "forbidden")
		return
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpx.Internal(w, r, err)
		return
	}
	ct := r.Header.Get("Content-Type")
	if mt, _, err := mime.ParseMediaType(ct); err == nil {
		ct = mt
	} else {
		ct = "application/octet-stream"
	}
	body := http.MaxBytesReader(w, r.Body, s.maxBytes)
	if err := s.store.Put(ctx, storage.Key(user.ID, id), body, r.ContentLength, ct); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO blobs (id, user_id, size, mime) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET size = excluded.size, mime = excluded.mime`, id, user.ID, r.ContentLength, ct); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.WriteHeader(204)
}

func (s *Service) handleDownload(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		httpx.Error(w, 503, "attachments are not configured on this server")
		return
	}
	ctx := r.Context()
	user := auth.FromContext(ctx)
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Error(w, 400, "invalid id")
		return
	}
	var ct string
	var filename *string
	err := s.db.QueryRow(ctx, `SELECT b.mime, a.filename FROM blobs b
		LEFT JOIN attachments a ON a.id = b.id AND a.user_id = b.user_id
		WHERE b.id = $1 AND b.user_id = $2`, id, user.ID).Scan(&ct, &filename)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 404, "not found")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	obj, size, err := s.store.Get(ctx, storage.Key(user.ID, id))
	if err != nil {
		httpx.Error(w, 404, "file missing from storage")
		return
	}
	defer obj.Close()

	name := "file"
	if filename != nil && *filename != "" {
		name = *filename
	}
	disp := "attachment"
	if inlineTypes[ct] && r.URL.Query().Get("download") == "" {
		disp = "inline"
	} else if !inlineTypes[ct] {
		ct = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	h.Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": sanitizeName(name)}))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'")
	h.Set("Cache-Control", "private, max-age=31536000, immutable") // ids are never reused
	io.Copy(w, obj)
}

func sanitizeName(n string) string {
	n = strings.Map(func(r rune) rune {
		if r < 32 || r == '"' || r == '\\' || r == '/' {
			return '_'
		}
		return r
	}, n)
	if len(n) > 200 {
		n = n[:200]
	}
	return n
}
