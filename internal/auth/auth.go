// Package auth implements accounts, password and Google sign-in, and
// cookie sessions stored in Postgres (so any replica can serve any request).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/flappeh/notegraph/internal/config"
	"github.com/flappeh/notegraph/internal/httpx"
	"github.com/flappeh/notegraph/internal/settings"
)

const (
	cookieName  = "ng_session"
	sessionTTL  = 180 * 24 * time.Hour // long-lived so offline devices stay signed in
	minPassword = 8
)

type User struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	Name        string `json:"name"`
	IsAdmin     bool   `json:"is_admin"`
	HasPassword bool   `json:"has_password"`
	HasGoogle   bool   `json:"has_google"`
}

type ctxKey struct{}

// FromContext returns the signed-in user set by RequireUser.
func FromContext(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKey{}).(*User)
	return u
}

type Service struct {
	db       *pgxpool.Pool
	cfg      *config.Config
	settings *settings.Store
	limiter  *limiter
}

func New(db *pgxpool.Pool, cfg *config.Config, st *settings.Store) *Service {
	return &Service{db: db, cfg: cfg, settings: st, limiter: newLimiter(10, time.Minute)}
}

func randomToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

// userCols lists the columns scanUser expects; p is an optional table alias like "u.".
func userCols(p string) string {
	return p + "id::text, " + p + "email, " + p + "name, " + p + "is_admin, " +
		p + "password_hash IS NOT NULL, " + p + "google_sub IS NOT NULL"
}

func scanUser(row pgx.Row) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.HasPassword, &u.HasGoogle)
	return u, err
}

func (s *Service) startSession(ctx context.Context, w http.ResponseWriter, r *http.Request, userID string) error {
	tok := randomToken()
	ua := r.UserAgent()
	if len(ua) > 300 {
		ua = ua[:300]
	}
	_, err := s.db.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
		hashToken(tok), userID, ua, time.Now().Add(sessionTTL))
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: tok, Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds()),
	})
	return nil
}

func (s *Service) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", HttpOnly: true,
		Secure: s.cfg.SecureCookie, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

func (s *Service) userFromRequest(r *http.Request) (*User, error) {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" {
		return nil, nil
	}
	ctx := r.Context()
	row := s.db.QueryRow(ctx, `SELECT `+userCols("u.")+`
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now()`, hashToken(c.Value))
	u, err := scanUser(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Sliding expiry, at most once a day per session to keep writes cheap.
	s.db.Exec(ctx, `UPDATE sessions SET expires_at = $2 WHERE token_hash = $1 AND expires_at < $3`,
		hashToken(c.Value), time.Now().Add(sessionTTL), time.Now().Add(sessionTTL-24*time.Hour))
	return u, nil
}

// RequireUser rejects requests without a valid session.
func (s *Service) RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := s.userFromRequest(r)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if u == nil {
			httpx.Error(w, http.StatusUnauthorized, "not signed in")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

func (s *Service) RequireAdmin(next http.Handler) http.Handler {
	return s.RequireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !FromContext(r.Context()).IsAdmin {
			httpx.Error(w, http.StatusForbidden, "admin only")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

// createUser inserts a user. The very first account, or one matching
// ADMIN_EMAIL, becomes admin.
func (s *Service) createUser(ctx context.Context, email, name, pwHash, googleSub string) (*User, error) {
	id := uuid.NewString()
	var ph, gs *string
	if pwHash != "" {
		ph = &pwHash
	}
	if googleSub != "" {
		gs = &googleSub
	}
	row := s.db.QueryRow(ctx, `INSERT INTO users (id, email, name, password_hash, google_sub, is_admin)
		VALUES ($1, $2, $3, $4, $5, (NOT EXISTS (SELECT 1 FROM users)) OR lower($2) = $6)
		RETURNING `+userCols(""), id, email, name, ph, gs, s.cfg.AdminEmail)
	u, err := scanUser(row)
	if err != nil {
		return nil, err
	}
	seedDefaults(ctx, s.db, u.ID)
	return u, nil
}

func (s *Service) canSignUp(ctx context.Context, email string) (bool, error) {
	st, err := s.settings.Get(ctx)
	if err != nil {
		return false, err
	}
	if st.AllowSignup || (s.cfg.AdminEmail != "" && strings.ToLower(email) == s.cfg.AdminEmail) {
		return true, nil
	}
	var hasUsers bool
	err = s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&hasUsers)
	return !hasUsers, err // the first account can always be created
}

func hashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	return string(b), err
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

// limiter is a per-replica fixed-window limiter for login attempts. It is
// best-effort only and deliberately not shared between replicas.
type limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{max: max, window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.hits) > 10000 {
		l.hits = map[string][]time.Time{}
	}
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}
