package main

import (
	"context"
	"log"
	"os"
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
				Name:    "server.listen",
				Aliases: []string{"listen", "l"},
				Value:   ":8080",
				Usage:   "`ADDRESS` to listen on (e.g., ':8080')",
				Sources: cli.EnvVars("LISTEN"),
			},
			&cli.StringFlag{
				Name:    "server.proxy",
				Aliases: []string{"proxy", "x"},
				Usage:   "Proxy URL for API requests (e.g., http://host:port, https://host:port, socks5://host:port)",
			},
			&cli.DurationFlag{
				Name:    "server.retention",
				Aliases: []string{"retention"},
				Value:   168 * time.Hour,
				Usage:   "Retention period for flight history (e.g., 168h for one week)",
				Sources: cli.EnvVars("HISTORY_RETENTION"),
			},
			&cli.DurationFlag{
				Name:    "server.interval",
				Aliases: []string{"interval"},
				Value:   60 * time.Second,
				Usage:   "Polling interval for OpenSky API (e.g., 10s)",
				Sources: cli.EnvVars("SERVER_INTERVAL", "INTERVAL"),
			},
			&cli.BoolFlag{
				Name:    "metrics.enabled",
				Aliases: []string{"metrics", "m"},
				Value:   true,
				Usage:   "Enable Prometheus metrics endpoint",
			},
			&cli.StringFlag{
				Name:    "tracing.endpoint",
				Aliases: []string{"tracing", "t"},
				Value:   "",
				Usage:   "OpenTelemetry collector `ENDPOINT` for traces",
				Sources: cli.EnvVars("OTEL_ENDPOINT"),
			},
			&cli.BoolFlag{
				Name:    "debug",
				Aliases: []string{"d"},
				Usage:   "Enable debug logging",
				Sources: cli.EnvVars("DEBUG"),
			},
		},
		Action: app.Run,
	}

	if err := cmd.Run(context.Background(), os.Args); err != nil {
		log.Fatal(err)
	}
}
