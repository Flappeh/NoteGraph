// Package httpx holds small JSON/HTTP helpers shared by the API handlers.
package httpx

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"error": msg})
}

// Internal logs err and answers 500 without leaking details.
func Internal(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	Error(w, http.StatusInternalServerError, "internal error")
}

// Decode reads a JSON body of at most maxBytes into v.
func Decode(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			Error(w, http.StatusRequestEntityTooLarge, "request too large")
		} else {
			Error(w, http.StatusBadRequest, "invalid JSON body")
		}
		return false
	}
	return true
}
