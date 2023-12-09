## Docker Commands

### Running it through just docker

```
docker build -t consultx-docker .
docker run -p 3000:3000 consultx-docker
```

### Running it through docker-compose

```
# Get latest docker
sudo snap refresh docker --channel=latest/edge\n

# Build and run
docker compose up --build
```
