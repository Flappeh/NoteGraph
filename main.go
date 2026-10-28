// Command notegraph runs the NoteGraph API and serves the PWA.
package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flappeh/notegraph/internal/auth"
	"github.com/flappeh/notegraph/internal/config"
	"github.com/flappeh/notegraph/internal/db"
	"github.com/flappeh/notegraph/internal/files"
	"github.com/flappeh/notegraph/internal/server"
	"github.com/flappeh/notegraph/internal/settings"
	"github.com/flappeh/notegraph/internal/storage"
	"github.com/flappeh/notegraph/internal/sync"
	"github.com/flappeh/notegraph/web"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		healthcheck()
		return
	}
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}
	st := settings.NewStore(pool)
	if err := st.Seed(ctx, cfg); err != nil {
		return err
	}
	objects, err := storage.New(ctx, cfg)
	if err != nil {
		return err
	}
	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		return err
	}

	authSvc := auth.New(pool, cfg, st)
	go cleanupSessions(ctx, pool)

	srv := &http.Server{
		Addr: cfg.ListenAddr,
		Handler: server.New(pool, dist,
			authSvc,
			sync.New(pool, objects, authSvc),
			files.New(pool, objects, authSvc, cfg.MaxUploadBytes),
		),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	slog.Info("listening", "addr", cfg.ListenAddr, "app_url", cfg.AppURL)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// cleanupSessions prunes expired sessions. Safe to run on every replica.
func cleanupSessions(ctx context.Context, pool *pgxpool.Pool) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`); err != nil && ctx.Err() == nil {
			slog.Warn("session cleanup", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// healthcheck is used by the container HEALTHCHECK (the image has no curl).
func healthcheck() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if addr[0] == ':' {
		addr = "127.0.0.1" + addr
	}
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		os.Exit(1)
	}
}
