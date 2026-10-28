package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/oauth2"

	"github.com/flappeh/notegraph/internal/httpx"
	"github.com/flappeh/notegraph/internal/settings"
)

const smallBody = 64 << 10

// Routes registers the auth endpoints on mux.
func (s *Service) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/providers", s.handleProviders)
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/google/start", s.handleGoogleStart)
	mux.HandleFunc("GET /api/auth/google/callback", s.handleGoogleCallback)
	mux.Handle("GET /api/auth/me", s.RequireUser(http.HandlerFunc(s.handleMe)))
	mux.Handle("PATCH /api/auth/me", s.RequireUser(http.HandlerFunc(s.handleUpdateMe)))
	mux.Handle("POST /api/auth/password", s.RequireUser(http.HandlerFunc(s.handlePassword)))
	mux.Handle("GET /api/admin/settings", s.RequireAdmin(http.HandlerFunc(s.handleGetSettings)))
	mux.Handle("PUT /api/admin/settings", s.RequireAdmin(http.HandlerFunc(s.handlePutSettings)))
}

func (s *Service) handleProviders(w http.ResponseWriter, r *http.Request) {
	st, err := s.settings.Get(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var hasUsers bool
	s.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM users)`).Scan(&hasUsers)
	httpx.JSON(w, 200, map[string]bool{
		"google":     st.GoogleReady(),
		"signup":     st.AllowSignup || !hasUsers,
		"first_user": !hasUsers,
	})
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

func (s *Service) handleRegister(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !httpx.Decode(w, r, &in, smallBody) {
		return
	}
	in.Email = strings.TrimSpace(in.Email)
	if _, err := mail.ParseAddress(in.Email); err != nil {
		httpx.Error(w, 400, "enter a valid email address")
		return
	}
	if len(in.Password) < minPassword {
		httpx.Error(w, 400, fmt.Sprintf("password must be at least %d characters", minPassword))
		return
	}
	if !s.limiter.allow("reg:" + clientIP(r)) {
		httpx.Error(w, 429, "too many attempts, try again in a minute")
		return
	}
	ok, err := s.canSignUp(r.Context(), in.Email)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !ok {
		httpx.Error(w, 403, "sign-up is disabled on this server")
		return
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = strings.Split(in.Email, "@")[0]
	}
	u, err := s.createUser(r.Context(), in.Email, name, hash, "")
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		httpx.Error(w, 409, "an account with this email already exists")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if err := s.startSession(r.Context(), w, r, u.ID); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, 201, u)
}

func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !httpx.Decode(w, r, &in, smallBody) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if !s.limiter.allow("login:"+clientIP(r)) || !s.limiter.allow("login:"+email) {
		httpx.Error(w, 429, "too many attempts, try again in a minute")
		return
	}
	var id string
	var hash *string
	err := s.db.QueryRow(r.Context(), `SELECT id::text, password_hash FROM users WHERE lower(email) = $1`, email).Scan(&id, &hash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpx.Internal(w, r, err)
		return
	}
	if hash == nil || bcrypt.CompareHashAndPassword([]byte(*hash), []byte(in.Password)) != nil {
		httpx.Error(w, 401, "wrong email or password")
		return
	}
	if err := s.startSession(r.Context(), w, r, id); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	u, err := scanUser(s.db.QueryRow(r.Context(), `SELECT `+userCols("")+` FROM users WHERE id = $1`, id))
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, 200, u)
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		s.db.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash = $1`, hashToken(c.Value))
	}
	s.clearCookie(w)
	w.WriteHeader(204)
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, FromContext(r.Context()))
}

func (s *Service) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if !httpx.Decode(w, r, &in, smallBody) {
		return
	}
	u := FromContext(r.Context())
	u.Name = strings.TrimSpace(in.Name)
	if _, err := s.db.Exec(r.Context(), `UPDATE users SET name = $2 WHERE id = $1`, u.ID, u.Name); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, 200, u)
}

func (s *Service) handlePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !httpx.Decode(w, r, &in, smallBody) {
		return
	}
	u := FromContext(r.Context())
	if len(in.New) < minPassword {
		httpx.Error(w, 400, fmt.Sprintf("password must be at least %d characters", minPassword))
		return
	}
	if u.HasPassword {
		if !s.limiter.allow("pw:" + u.ID) {
			httpx.Error(w, 429, "too many attempts, try again in a minute")
			return
		}
		var hash string
		if err := s.db.QueryRow(r.Context(), `SELECT password_hash FROM users WHERE id = $1`, u.ID).Scan(&hash); err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Current)) != nil {
			httpx.Error(w, 401, "current password is wrong")
			return
		}
	}
	hash, err := hashPassword(in.New)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// Changing the password signs out every other session.
	cur, _ := r.Cookie(cookieName)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `UPDATE users SET password_hash = $2 WHERE id = $1`, u.ID, hash); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, u.ID, hashToken(cur.Value)); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.WriteHeader(204)
}

// --- Google OAuth --------------------------------------------------------

const oauthCookie = "ng_oauth"

func (s *Service) oauthConfig(st settings.Settings) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     st.GoogleClientID,
		ClientSecret: st.GoogleClientSecret,
		RedirectURL:  s.cfg.AppURL + "/api/auth/google/callback",
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL: "https://oauth2.googleapis.com/token",
		},
	}
}

func (s *Service) loginRedirect(w http.ResponseWriter, r *http.Request, msg string) {
	http.Redirect(w, r, "/login?error="+url.QueryEscape(msg), http.StatusFound)
}

func (s *Service) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	st, err := s.settings.Get(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !st.GoogleReady() {
		s.loginRedirect(w, r, "Google sign-in is not configured")
		return
	}
	state, verifier := randomToken(), oauth2.GenerateVerifier()
	mode := "login"
	if r.URL.Query().Get("link") == "1" {
		mode = "link"
	}
	http.SetCookie(w, &http.Cookie{
		Name: oauthCookie, Value: state + "." + verifier + "." + mode, Path: "/api/auth/google",
		HttpOnly: true, Secure: s.cfg.SecureCookie, SameSite: http.SameSiteLaxMode, MaxAge: 600,
	})
	authURL := s.oauthConfig(st).AuthCodeURL(state, oauth2.S256ChallengeOption(verifier),
		oauth2.SetAuthURLParam("prompt", "select_account"))
	http.Redirect(w, r, authURL, http.StatusFound)
}

type googleUser struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}

func (s *Service) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := r.Cookie(oauthCookie)
	http.SetCookie(w, &http.Cookie{Name: oauthCookie, Path: "/api/auth/google", MaxAge: -1})
	parts := []string{}
	if err == nil {
		parts = strings.SplitN(c.Value, ".", 3)
	}
	if len(parts) != 3 || r.URL.Query().Get("state") != parts[0] {
		s.loginRedirect(w, r, "Sign-in expired, please try again")
		return
	}
	if e := r.URL.Query().Get("error"); e != "" {
		s.loginRedirect(w, r, "Google sign-in was cancelled")
		return
	}
	st, err := s.settings.Get(ctx)
	if err != nil || !st.GoogleReady() {
		s.loginRedirect(w, r, "Google sign-in is not configured")
		return
	}
	cfg := s.oauthConfig(st)
	exCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tok, err := cfg.Exchange(exCtx, r.URL.Query().Get("code"), oauth2.VerifierOption(parts[1]))
	if err != nil {
		slog.Warn("google token exchange failed", "err", err)
		s.loginRedirect(w, r, "Google sign-in failed")
		return
	}
	resp, err := cfg.Client(exCtx, tok).Get("https://openidconnect.googleapis.com/v1/userinfo")
	if err != nil {
		s.loginRedirect(w, r, "Google sign-in failed")
		return
	}
	defer resp.Body.Close()
	var g googleUser
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&g) != nil || g.Sub == "" {
		s.loginRedirect(w, r, "Google sign-in failed")
		return
	}
	if !g.EmailVerified {
		s.loginRedirect(w, r, "Your Google email is not verified")
		return
	}

	// Linking Google to the account that is currently signed in.
	if parts[2] == "link" {
		cur, _ := s.userFromRequest(r)
		if cur == nil {
			s.loginRedirect(w, r, "Sign in first, then link Google")
			return
		}
		_, err := s.db.Exec(ctx, `UPDATE users SET google_sub = $2 WHERE id = $1`, cur.ID, g.Sub)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			http.Redirect(w, r, "/settings?error="+url.QueryEscape("That Google account is linked to another user"), http.StatusFound)
			return
		}
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		http.Redirect(w, r, "/settings", http.StatusFound)
		return
	}

	var id string
	err = s.db.QueryRow(ctx, `SELECT id::text FROM users WHERE google_sub = $1`, g.Sub).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		// Same verified email as an existing account: link it.
		err = s.db.QueryRow(ctx, `UPDATE users SET google_sub = $2 WHERE lower(email) = lower($1) AND google_sub IS NULL
			RETURNING id::text`, g.Email, g.Sub).Scan(&id)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		ok, cerr := s.canSignUp(ctx, g.Email)
		if cerr != nil {
			httpx.Internal(w, r, cerr)
			return
		}
		if !ok {
			s.loginRedirect(w, r, "Sign-up is disabled on this server")
			return
		}
		u, cerr := s.createUser(ctx, g.Email, g.Name, "", g.Sub)
		if cerr != nil {
			httpx.Internal(w, r, cerr)
			return
		}
		id, err = u.ID, nil
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if err := s.startSession(ctx, w, r, id); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

// --- Admin settings ------------------------------------------------------

func (s *Service) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.settings.Get(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"allow_signup":      st.AllowSignup,
		"google_enabled":    st.GoogleEnabled,
		"google_client_id":  st.GoogleClientID,
		"google_secret_set": st.GoogleClientSecret != "",
		"google_redirect":   s.cfg.AppURL + "/api/auth/google/callback",
	})
}

func (s *Service) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var in settings.Settings
	if !httpx.Decode(w, r, &in, smallBody) {
		return
	}
	in.GoogleClientID = strings.TrimSpace(in.GoogleClientID)
	in.GoogleClientSecret = strings.TrimSpace(in.GoogleClientSecret)
	if err := s.settings.Update(r.Context(), in); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.handleGetSettings(w, r)
}
