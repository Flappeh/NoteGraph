// Package config reads process configuration from the environment.
//
// Every variable can also be supplied as a file (Docker/Swarm secrets) by
// setting NAME_FILE to a path instead of NAME.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	ListenAddr   string
	DatabaseURL  string
	AppURL       string // public base URL, e.g. https://notegraph.example.com
	SecureCookie bool

	// Seeds for the in-app settings table. Only used when a setting has never
	// been stored; afterwards admins change them in the app.
	SeedAllowSignup        bool
	SeedGoogleClientID     string
	SeedGoogleClientSecret string
	AdminEmail             string

	S3Endpoint  string
	S3Bucket    string
	S3AccessKey string
	S3SecretKey string
	S3Region    string
	S3UseSSL    bool

	MaxUploadBytes int64
}

func get(name, def string) string {
	if path := os.Getenv(name + "_FILE"); path != "" {
		if b, err := os.ReadFile(path); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return def
}

func getBool(name string, def bool) bool {
	v, err := strconv.ParseBool(get(name, strconv.FormatBool(def)))
	if err != nil {
		return def
	}
	return v
}

func Load() (*Config, error) {
	c := &Config{
		ListenAddr:             get("LISTEN_ADDR", ":8080"),
		DatabaseURL:            get("DATABASE_URL", ""),
		AppURL:                 strings.TrimRight(get("APP_URL", "http://localhost:8080"), "/"),
		SeedAllowSignup:        getBool("ALLOW_SIGNUP", true),
		SeedGoogleClientID:     get("GOOGLE_CLIENT_ID", ""),
		SeedGoogleClientSecret: get("GOOGLE_CLIENT_SECRET", ""),
		AdminEmail:             strings.ToLower(strings.TrimSpace(get("ADMIN_EMAIL", ""))),
		S3Endpoint:             get("S3_ENDPOINT", ""),
		S3Bucket:               get("S3_BUCKET", "notegraph"),
		S3AccessKey:            get("S3_ACCESS_KEY", ""),
		S3SecretKey:            get("S3_SECRET_KEY", ""),
		S3Region:               get("S3_REGION", "us-east-1"),
		S3UseSSL:               getBool("S3_USE_SSL", true),
	}
	mb, err := strconv.ParseInt(get("MAX_UPLOAD_MB", "50"), 10, 64)
	if err != nil || mb <= 0 {
		return nil, fmt.Errorf("MAX_UPLOAD_MB must be a positive integer")
	}
	c.MaxUploadBytes = mb << 20

	if c.DatabaseURL == "" && get("PG_HOST", "") != "" {
		// Alternative to DATABASE_URL: discrete PG_* variables.
		u := url.URL{
			Scheme:   "postgres",
			User:     url.UserPassword(get("PG_USER", "notegraph"), get("PG_PASSWORD", "")),
			Host:     get("PG_HOST", "") + ":" + get("PG_PORT", "5432"),
			Path:     "/" + get("PG_DATABASE", "notegraph"),
			RawQuery: "sslmode=" + url.QueryEscape(get("PG_SSLMODE", "prefer")),
		}
		c.DatabaseURL = u.String()
	}
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL (or PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE) is required")
	}
	u, err := url.Parse(c.AppURL)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("APP_URL must be an absolute URL")
	}
	c.SecureCookie = u.Scheme == "https"
	// S3 endpoint is host[:port]; tolerate a scheme prefix.
	if strings.HasPrefix(c.S3Endpoint, "https://") {
		c.S3Endpoint, c.S3UseSSL = strings.TrimPrefix(c.S3Endpoint, "https://"), true
	} else if strings.HasPrefix(c.S3Endpoint, "http://") {
		c.S3Endpoint, c.S3UseSSL = strings.TrimPrefix(c.S3Endpoint, "http://"), false
	}
	return c, nil
}
