package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/maniack/miniflightradar/app"
	"github.com/urfave/cli/v3"
)

func main() {
	cmd := &cli.Command{
		Name:  "mini-flight-radar",
		Usage: "Track flights via OpenSky API with PWA frontend",
		Flags: []cli.Flag{
			&cli.StringFlag{
				Category: "net",
				Name:     "net.http_proxy",
				Usage:    "Proxy for HTTP requests (Linux-style HTTP_PROXY)",
				Sources:  cli.EnvVars("HTTP_PROXY", "http_proxy"),
				Hidden:   true,
			},
			&cli.StringFlag{
				Category: "net",
				Name:     "net.https_proxy",
				Usage:    "Proxy for HTTPS requests (Linux-style HTTPS_PROXY)",
				Sources:  cli.EnvVars("HTTPS_PROXY", "https_proxy"),
				Hidden:   true,
			},
			&cli.StringFlag{
				Category: "net",
				Name:     "net.all_proxy",
				Usage:    "Proxy for all protocols (Linux-style ALL_PROXY)",
				Sources:  cli.EnvVars("ALL_PROXY", "all_proxy"),
				Hidden:   true,
			},
			&cli.StringFlag{
				Category: "net",
				Name:     "net.no_proxy",
				Usage:    "Comma-separated NO_PROXY list for bypassing proxy (Linux-style NO_PROXY)",
				Sources:  cli.EnvVars("NO_PROXY", "no_proxy"),
				Hidden:   true,
			},
			&cli.StringFlag{
				Category: "server",
				Name:     "server.listen",
				Aliases:  []string{"listen", "l"},
				Value:    ":8080",
				Usage:    "`ADDRESS` to listen on (e.g., ':8080')",
			},
			&cli.StringFlag{
				Category: "server",
				Name:     "server.proxy",
				Aliases:  []string{"proxy", "x"},
				Usage:    "Proxy URL override for all requests (e.g., http://host:port). If empty, per-scheme env/flags may apply",
			},
			&cli.StringFlag{
				Category: "monitoring",
				Name:     "tracing.endpoint",
				Aliases:  []string{"tracing", "t"},
				Value:    "",
				Usage:    "OpenTelemetry collector `ENDPOINT` for traces",
			},
			&cli.StringFlag{
				Category: "monitoring",
				Name:     "security.jwt.secret",
				Usage:    "JWT secret for signing cookies (HS256). If empty, load/generate from file",
				Hidden:   true,
			},
			&cli.StringFlag{
				Category: "security",
				Name:     "security.jwt.file",
				Value:    "./data/jwt.secret",
				Usage:    "Path to file to load/store JWT secret (used if security.jwt.secret is empty)",
				Hidden:   true,
			},
			&cli.StringFlag{
				Category: "storage",
				Name:     "storage.path",
				Aliases:  []string{"db"},
				Value:    "./data/flight.buntdb",
				Usage:    "Path to BuntDB database file (will be created if missing)",
			},
			&cli.DurationFlag{
				Category: "opensky",
				Name:     "opensky.interval",
				Aliases:  []string{"interval", "i"},
				Value:    60 * time.Second,
				Usage:    "Polling interval for OpenSky API (e.g., 10s)",
			},
			&cli.DurationFlag{
				Category: "opensky",
				Name:     "opensky.retention",
				Aliases:  []string{"retention", "r"},
				Value:    7 * 24 * time.Hour,
				Usage:    "Retention period for flight history (e.g., 1w for one week)",
			},
			&cli.StringFlag{
				Category: "opensky",
				Name:     "opensky.user",
				Usage:    "OpenSky API username for Basic Auth (optional)",
			},
			&cli.StringFlag{
				Category: "opensky",
				Name:     "opensky.pass",
				Usage:    "OpenSky API password for Basic Auth (optional)",
			},
			&cli.BoolFlag{
				Category: "monitoring",
				Name:     "debug",
				Aliases:  []string{"d"},
				Usage:    "Enable debug logging",
			},
		},
		Action: app.Run,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := cmd.Run(ctx, os.Args); err != nil {
		log.Fatal(err)
	}
}
