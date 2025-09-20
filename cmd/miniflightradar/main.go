package main

import (
	"context"
	"log"
	"os"

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
		},
		Action: app.Run,
	}

	if err := cmd.Run(context.Background(), os.Args); err != nil {
		log.Fatal(err)
	}
}
