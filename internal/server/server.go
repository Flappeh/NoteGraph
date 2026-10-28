// Package server wires the HTTP routes, middleware and the embedded PWA.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flappeh/notegraph/internal/httpx"
)

type Routable interface{ Routes(*http.ServeMux) }

func New(db *pgxpool.Pool, dist fs.FS, services ...Routable) http.Handler {
	mux := http.NewServeMux()
	for _, s := range services {
		s.Routes(mux)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := db.Ping(r.Context()); err != nil {
			httpx.Error(w, 503, "database unavailable")
			return
		}
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Error(w, 404, "not found")
	})
	mux.Handle("/", spa(dist))
	return logRequests(securityHeaders(csrf(mux)))
}

// csrf requires a custom header on state-changing API calls. Browsers cannot
// send it cross-origin without a CORS preflight, which we never approve.
func csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodHead &&
			r.Header.Get("X-NoteGraph") != "1" {
			httpx.Error(w, 403, "missing X-NoteGraph header")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		// Inline styles are needed for editor formatting (colours, font sizes).
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; "+
			"worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com")
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int)        { s.status = code; s.ResponseWriter.WriteHeader(code) }
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		slog.Info("http", "method", r.Method, "path", r.URL.Path, "status", sw.status, "ms", time.Since(start).Milliseconds())
	})
}

// spa serves the built web app, falling back to index.html for client routes.
func spa(dist fs.FS) http.Handler {
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(dist, p); err != nil {
			if path.Ext(p) != "" {
				http.NotFound(w, r)
				return
			}
			p = "index.html"
		}
		switch {
		case strings.HasPrefix(p, "assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // content-hashed
		default:
			w.Header().Set("Cache-Control", "no-cache") // index.html, sw.js, manifest
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + p
		if p == "index.html" {
			r2.URL.Path = "/" // FileServer redirects explicit /index.html
		}
		files.ServeHTTP(w, r2)
	})
}
