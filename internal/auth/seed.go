package auth

import (
	"context"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedDefaults gives a new account a starter status category so the status
// picker is useful straight away. Users can rename or delete it.
func seedDefaults(ctx context.Context, db *pgxpool.Pool, userID string) {
	tx, err := db.Begin(ctx)
	if err != nil {
		slog.Warn("seed defaults", "err", err)
		return
	}
	defer tx.Rollback(ctx)

	var rev int64
	if err := tx.QueryRow(ctx, `UPDATE users SET sync_rev = sync_rev + 1 WHERE id = $1 RETURNING sync_rev`, userID).Scan(&rev); err != nil {
		slog.Warn("seed defaults", "err", err)
		return
	}
	catID := uuid.NewString()
	tx.Exec(ctx, `INSERT INTO status_categories (id, user_id, name, color, sort, rev) VALUES ($1, $2, 'Progress', '#6366f1', 0, $3)`,
		catID, userID, rev)
	for i, s := range []struct {
		name, color string
		done        bool
	}{
		{"Not Yet", "#94a3b8", false},
		{"On Progress", "#f59e0b", false},
		{"Completed", "#22c55e", true},
	} {
		tx.Exec(ctx, `INSERT INTO statuses (id, user_id, category_id, name, color, done, sort, rev)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, uuid.NewString(), userID, catID, s.name, s.color, s.done, i, rev)
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Warn("seed defaults", "err", err)
	}
}
