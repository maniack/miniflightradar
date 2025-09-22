package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// === Minimal JWT (HS256) + CSRF + CORS helpers ===

var (
	jwtSecret         []byte
	jwtSecretFromCLI  string
	jwtSecretFilePath string
)

// ConfigureJWT sets CLI-provided secret or persistent file path for JWT secret management.
// If secret is non-empty, it will be used directly. Otherwise, secret will be loaded from file (or generated and persisted).
func ConfigureJWT(secret, file string) {
	jwtSecretFromCLI = strings.TrimSpace(secret)
	jwtSecretFilePath = strings.TrimSpace(file)
	// reset current secret; next InitAuth will re-evaluate
	jwtSecret = nil
}

// InitAuth initializes JWT secret from CLI configuration or a persistent file.
// If neither is present, it generates a new one and stores it under ./data/jwt.secret
// so that sessions survive application restarts.
func InitAuth() {
	if len(jwtSecret) != 0 {
		return
	}
	// 1) CLI-provided secret has priority
	if sec := strings.TrimSpace(jwtSecretFromCLI); sec != "" {
		jwtSecret = []byte(sec)
		return
	}
	// 2) Persistent file (path may be provided via CLI)
	path := strings.TrimSpace(jwtSecretFilePath)
	if path == "" {
		path = filepath.Join(".", "data", "jwt.secret")
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		jwtSecret = []byte(strings.TrimSpace(string(b)))
		return
	}
	// 3) Generate and persist
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err == nil {
		// store hex string for readability
		secHex := make([]byte, 64)
		const hexdigits = "0123456789abcdef"
		for i, v := range buf {
			secHex[i*2] = hexdigits[v>>4]
			secHex[i*2+1] = hexdigits[v&0x0f]
		}
		_ = os.WriteFile(path, secHex, 0o600)
		jwtSecret = secHex
		return
	}
	// Fallback (very unlikely)
	jwtSecret = []byte("miniflightradar-dev-secret")
}

func base64urlEncode(b []byte) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "=")
}

func base64urlDecode(s string) ([]byte, error) {
	// restore padding
	if m := len(s) % 4; m != 0 {
		s += strings.Repeat("=", 4-m)
	}
	return base64.URLEncoding.DecodeString(s)
}

// signJWT creates HS256 JWT with given subject and ttl.
func signJWT(sub string, ttl time.Duration) (string, error) {
	h := map[string]interface{}{"alg": "HS256", "typ": "JWT"}
	now := time.Now().Unix()
	exp := time.Now().Add(ttl).Unix()
	p := map[string]interface{}{"sub": sub, "iat": now, "exp": exp, "iss": "miniflightradar"}
	hb, _ := json.Marshal(h)
	pb, _ := json.Marshal(p)
	head := base64urlEncode(hb)
	pay := base64urlEncode(pb)
	mac := hmac.New(sha256.New, jwtSecret)
	mac.Write([]byte(head + "." + pay))
	sig := base64urlEncode(mac.Sum(nil))
	return head + "." + pay + "." + sig, nil
}

// validateJWT validates HS256 JWT and checks exp.
func validateJWT(tok string) bool {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || len(parts[0]) == 0 || len(parts[1]) == 0 {
		return false
	}
	mac := hmac.New(sha256.New, jwtSecret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expected := mac.Sum(nil)
	sigBytes, err := base64urlDecode(parts[2])
	if err != nil || !hmac.Equal(expected, sigBytes) {
		return false
	}
	// check exp
	payloadBytes, err := base64urlDecode(parts[1])
	if err != nil {
		return false
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return false
	}
	if v, ok := payload["exp"]; ok {
		exp := int64(0)
		switch t := v.(type) {
		case float64:
			exp = int64(t)
		case string:
			if n, err := strconv.ParseInt(t, 10, 64); err == nil {
				exp = n
			}
		}
		if exp > 0 && time.Now().Unix() > exp {
			return false
		}
	}
	return true
}

// randomHex returns n random bytes hex-encoded (2n-length string).
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	const hexdigits = "0123456789abcdef"
	out := make([]byte, n*2)
	for i, v := range b {
		out[i*2] = hexdigits[v>>4]
		out[i*2+1] = hexdigits[v&0x0f]
	}
	return string(out)
}

// EnsureAuthCookies sets JWT and CSRF cookies when missing, or refreshes JWT if invalid/expired.
func EnsureAuthCookies(w http.ResponseWriter, r *http.Request) {
	if len(jwtSecret) == 0 {
		InitAuth()
	}
	// JWT cookie: create if missing or invalid; refresh if close to expiry (<3 days)
	needNew := false
	var expUnix int64 = 0
	if ck, err := r.Cookie("mfr_jwt"); err == nil && ck != nil && ck.Value != "" {
		// parse and validate
		parts := strings.Split(ck.Value, ".")
		if len(parts) == 3 && validateJWT(ck.Value) {
			if payload, err := base64urlDecode(parts[1]); err == nil {
				var p map[string]interface{}
				if json.Unmarshal(payload, &p) == nil {
					if v, ok := p["exp"]; ok {
						switch t := v.(type) {
						case float64:
							expUnix = int64(t)
						case string:
							if n, e := strconv.ParseInt(t, 10, 64); e == nil {
								expUnix = n
							}
						}
					}
				}
			}
			if expUnix > 0 && time.Until(time.Unix(expUnix, 0)) < 72*time.Hour {
				needNew = true
			}
		} else {
			needNew = true
		}
	} else {
		needNew = true
	}
	if needNew {
		uid := randomHex(16)
		if tok, err := signJWT(uid, 30*24*time.Hour); err == nil {
			secure := isSecureRequest(r)
			setCookie(w, r, &http.Cookie{Name: "mfr_jwt", Value: tok, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secure, MaxAge: int((30 * 24 * time.Hour) / time.Second)})
		}
	}
	// CSRF cookie (create if missing)
	if _, err := r.Cookie("mfr_csrf"); err != nil {
		token := randomHex(16)
		secure := isSecureRequest(r)
		setCookie(w, r, &http.Cookie{Name: "mfr_csrf", Value: token, Path: "/", HttpOnly: false, SameSite: http.SameSiteLaxMode, Secure: secure, MaxAge: int((30 * 24 * time.Hour) / time.Second)})
	}
}

func setCookie(w http.ResponseWriter, r *http.Request, c *http.Cookie) {
	// we use Set-Cookie directly, leave defaults
	http.SetCookie(w, c)
}

// ValidateJWTFromRequest returns true if mfr_jwt cookie is present and valid.
func ValidateJWTFromRequest(r *http.Request) bool {
	if len(jwtSecret) == 0 {
		InitAuth()
	}
	ck, err := r.Cookie("mfr_jwt")
	if err != nil || ck == nil || ck.Value == "" {
		return false
	}
	return validateJWT(ck.Value)
}

// GetCSRFFromRequest returns the CSRF cookie value (may be empty).
func GetCSRFFromRequest(r *http.Request) string {
	ck, err := r.Cookie("mfr_csrf")
	if err != nil || ck == nil {
		return ""
	}
	return ck.Value
}

// SecurityMiddleware applies CORS headers, handles OPTIONS, ensures auth cookies, and enforces CSRF+JWT on /api/*.
func SecurityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// CORS headers (reflect origin if present)
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Authorization")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Initialize auth secret on first use if not already
		if len(jwtSecret) == 0 {
			InitAuth()
		}
		// Set cookies if missing
		EnsureAuthCookies(w, r)

		// Enforce CSRF and JWT only for API routes (skip metrics)
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/metrics" {
			csrfHeader := r.Header.Get("X-CSRF-Token")
			csrfCookie := GetCSRFFromRequest(r)
			if csrfHeader == "" || csrfCookie == "" || csrfHeader != csrfCookie {
				log.Printf("csrf_denied path=%s", r.URL.Path)
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if !ValidateJWTFromRequest(r) {
				log.Printf("jwt_denied path=%s", r.URL.Path)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

// isSecureRequest reports whether the request is made over HTTPS, including when behind a reverse proxy.
// It honors standard proxy headers used by nginx/Envoy/Traefik and RFC 7239 Forwarded.
func isSecureRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	// RFC 7239 Forwarded header may contain proto=https
	if fwd := r.Header.Get("Forwarded"); fwd != "" {
		if strings.Contains(strings.ToLower(fwd), "proto=https") {
			return true
		}
	}
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		return true
	}
	if strings.EqualFold(r.Header.Get("X-Forwarded-Ssl"), "on") {
		return true
	}
	return false
}
