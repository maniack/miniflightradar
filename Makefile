.PHONY: all tidy vet test frontend backend docker clean

all: frontend backend

tidy:
	go mod tidy
	go mod vendor

vet:
	go vet ./...

test:
	go test ./...

frontend:
	cd frontend && npm ci && npm run build
	rm -rf ui/build
	cp -r frontend/build ui/

backend: tidy vet test
	go build -mod=vendor -o bin/mini-flightradar ./cmd/miniflightradar

docker:
	docker build -t miniflightradar .

clean:
	rm -rf bin/
	rm -rf ui/build