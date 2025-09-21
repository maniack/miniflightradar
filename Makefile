.PHONY: all frontend backend docker clean

all: frontend backend

frontend:
	cd frontend && npm ci && npm run build
	rm -rf ui/build
	cp -r frontend/build ui/

backend:
	cd cmd/miniflightradar && go build -mod=vendor -o ../../bin/mini-flightradar

docker:
	docker build -t miniflightradar .

clean:
	rm -rf bin/
	rm -rf ui/build