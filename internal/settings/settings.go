// Package settings stores admin-editable, app-wide settings in Postgres.
// Nothing is cached in memory so every replica sees changes immediately.
package settings

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flappeh/notegraph/internal/config"
)

type Settings struct {
	AllowSignup        bool   `json:"allow_signup"`
	GoogleEnabled      bool   `json:"google_enabled"`
	GoogleClientID     string `json:"google_client_id"`
	GoogleClientSecret string `json:"google_client_secret,omitempty"`
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

// Seed writes env-provided defaults for settings that were never stored.
func (s *Store) Seed(ctx context.Context, c *config.Config) error {
	seeds := map[string]any{
		"allow_signup":         c.SeedAllowSignup,
		"google_enabled":       c.SeedGoogleClientID != "" && c.SeedGoogleClientSecret != "",
		"google_client_id":     c.SeedGoogleClientID,
		"google_client_secret": c.SeedGoogleClientSecret,
	}
	for k, v := range seeds {
		b, _ := json.Marshal(v)
		if _, err := s.db.Exec(ctx,
			`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, k, b); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Get(ctx context.Context) (Settings, error) {
	var out Settings
	rows, err := s.db.Query(ctx, `SELECT key, value FROM settings`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return out, err
		}
		switch k {
		case "allow_signup":
			json.Unmarshal(v, &out.AllowSignup)
		case "google_enabled":
			json.Unmarshal(v, &out.GoogleEnabled)
		case "google_client_id":
			json.Unmarshal(v, &out.GoogleClientID)
		case "google_client_secret":
			json.Unmarshal(v, &out.GoogleClientSecret)
		}
	}
	return out, rows.Err()
}

// GoogleReady reports whether Google sign-in can actually be offered.
func (s Settings) GoogleReady() bool {
	return s.GoogleEnabled && s.GoogleClientID != "" && s.GoogleClientSecret != ""
}

// Update stores the given settings. An empty client secret keeps the old one,
// so the admin UI never needs to read the secret back.
func (s *Store) Update(ctx context.Context, in Settings) error {
	vals := map[string]any{
		"allow_signup":     in.AllowSignup,
		"google_enabled":   in.GoogleEnabled,
		"google_client_id": in.GoogleClientID,
	}
	if in.GoogleClientSecret != "" {
		vals["google_client_secret"] = in.GoogleClientSecret
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for k, v := range vals {
		b, _ := json.Marshal(v)
		if _, err := tx.Exec(ctx, `INSERT INTO settings (key, value) VALUES ($1, $2)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value`, k, b); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
