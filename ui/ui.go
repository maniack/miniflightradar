package ui

import (
	"embed"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"strings"
)

//go:embed build
var embeddedUI embed.FS

var buildFS fs.FS

func init() {
	// Prepare sub FS rooted at build/
	var err error
	buildFS, err = fs.Sub(embeddedUI, "build")
	if err != nil {
		// If not present (e.g., developer didn't build UI), keep nil and log
		log.Printf("ui: embedded build not found: %v", err)
	}
	// Common MIME types
	_ = mime.AddExtensionType(".js", "application/javascript")
	_ = mime.AddExtensionType(".css", "text/css")
	_ = mime.AddExtensionType(".map", "application/json")
	_ = mime.AddExtensionType(".svg", "image/svg+xml")
	_ = mime.AddExtensionType(".json", "application/json")
}

func Handler() http.Handler {
	if buildFS == nil {
		// Fall back to serving from disk if available (dev mode)
		fsys := http.Dir(filepath.Join("ui", "build"))
		return http.StripPrefix("/", spaHandler{fsys: fsys})
	}
	return http.StripPrefix("/", spaHandler{fsys: http.FS(buildFS)})
}

type spaHandler struct {
	fsys http.FileSystem
}

func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Try to serve the requested file
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}

	setCacheHeaders := func(name string) {
		nameLower := strings.ToLower(name)
		if nameLower == "index.html" || strings.HasSuffix(nameLower, "/index.html") {
			// Always revalidate the SPA shell
			w.Header().Set("Cache-Control", "no-cache")
			return
		}
		// Long cache for fingerprinted assets and static files
		if strings.HasSuffix(nameLower, ".js") || strings.HasSuffix(nameLower, ".css") || strings.HasSuffix(nameLower, ".map") ||
			strings.HasSuffix(nameLower, ".png") || strings.HasSuffix(nameLower, ".jpg") || strings.HasSuffix(nameLower, ".jpeg") ||
			strings.HasSuffix(nameLower, ".svg") || strings.HasSuffix(nameLower, ".ico") || strings.HasSuffix(nameLower, ".json") ||
			strings.HasSuffix(nameLower, ".txt") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
	}

	f, err := h.fsys.Open(p)
	if err == nil {
		defer f.Close()
		fi, err := f.Stat()
		if err == nil && !fi.IsDir() {
			setCacheHeaders(p)
			http.FileServer(h.fsys).ServeHTTP(w, r)
			return
		}
		// If directory, try index.html inside it
		idx := path.Join(p, "index.html")
		if ff, err := h.fsys.Open(idx); err == nil {
			ff.Close()
			setCacheHeaders(idx)
			r.URL.Path = "/" + idx
			http.FileServer(h.fsys).ServeHTTP(w, r)
			return
		}
	}

	// Fallback: serve root index.html (SPA)
	setCacheHeaders("index.html")
	r.URL.Path = "/index.html"
	http.FileServer(h.fsys).ServeHTTP(w, r)
}
