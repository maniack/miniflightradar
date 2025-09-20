package backend

import (
	"encoding/json"
	"net/http"

	"github.com/maniack/miniflightradar/monitoring"
)

// FlightData структура OpenSky API response
type FlightData struct {
	States [][]interface{} `json:"states"`
}

// FetchOpenSkyData заглушка для запроса к OpenSky API
func FetchOpenSkyData() (*FlightData, error) {
	// TODO: Реальный запрос к OpenSky API
	return &FlightData{
		States: [][]interface{}{}, // Пример пустого ответа
	}, nil
}

func FlightHandler(w http.ResponseWriter, r *http.Request) {
	callsign := r.URL.Query().Get("callsign")
	if callsign == "" {
		http.Error(w, "callsign is required", http.StatusBadRequest)
		monitoring.FlightErrors.WithLabelValues("unknown").Inc()
		monitoring.LastStatus.WithLabelValues("unknown").Set(400.0)
		return
	}

	data, err := FetchOpenSkyData()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		monitoring.FlightErrors.WithLabelValues(callsign).Inc()
		monitoring.LastStatus.WithLabelValues(callsign).Set(500.0)
		return
	}

	filtered := make([][]interface{}, 0)
	for _, s := range data.States {
		if cs, ok := s[1].(string); ok && cs == callsign {
			filtered = append(filtered, s)
		}
	}

	monitoring.UpdateAircraftCount(callsign, len(filtered))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(filtered)
}
