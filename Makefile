.PHONY: all build-backend build-ui build-app docker clean

all: build-app

build-backend:
	go build -mod=vendor ./backend ./monitoring

build-ui:
	cd frontend && npm install && npm run build
	rm -rf ui/build
	cp -r frontend/build ui/

build-app: build-ui
	cd cmd/miniflightradar && go build -mod=vendor -o ../../bin/mini-flightradar

docker:
	docker build -t mini-flightradar .

clean:
	rm -rf bin/
	rm -rf ui/build