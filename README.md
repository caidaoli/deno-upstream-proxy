# deno-upstream-proxy

A small Deno HTTP/WebSocket upstream proxy designed for Deno Deploy.

It forwards incoming requests to a single configured upstream origin, preserves
the request path and query string, adds permissive CORS response headers, and
can optionally redirect `GET /` to a management page.

## Features

- HTTP proxying for standard requests.
- WebSocket proxying for `Upgrade: websocket` requests.
- CORS preflight handling for `OPTIONS` requests.
- CORS headers on proxied responses.
- Optional `GET /` redirect, controlled by an environment variable.
- Optional upstream `Origin` and `User-Agent` header overrides.
- Local `GET /` and `HEAD /` health response when root redirect is disabled.

## Configuration

| Variable                     | Required | Description                                                                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM_URL`               | Yes      | Upstream HTTP or HTTPS origin. The proxy preserves the incoming request path and query string. Any path in this URL is ignored. |
| `ROOT_REDIRECT_PATH`         | No       | When non-empty, `GET /` returns `302` with this value as the `Location` header. Example: `/management.html`.                    |
| `UPSTREAM_ORIGIN_HEADER`     | No       | Overrides the upstream `Origin` request header. Useful for upstreams that require a specific origin.                            |
| `UPSTREAM_USER_AGENT_HEADER` | No       | Overrides the upstream `User-Agent` request header.                                                                             |

`Host` is not configurable. Deno's `fetch` derives the real upstream `Host`
header from `UPSTREAM_URL`, so exposing a fake host override would be
misleading.

## Local Development

Run the proxy locally:

```sh
UPSTREAM_URL=https://example.com \
ROOT_REDIRECT_PATH=/management.html \
deno task dev
```

Deno serves on `http://localhost:8000/` by default.

Example request:

```sh
curl -i http://localhost:8000/v1/models
```

## HuggingFace Space Example

```sh
UPSTREAM_URL=https://caidao78-a.hf.space \
ROOT_REDIRECT_PATH=/management.html \
UPSTREAM_ORIGIN_HEADER=https://caidao78-a.hf.space \
UPSTREAM_USER_AGENT_HEADER="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
deno task dev
```

## Tasks

```sh
deno task check
deno task test
deno task deploy
```

`deno task test` runs unit and local integration tests, including WebSocket
proxying and real upstream header behavior.

## Deploy

Set the required environment variables in Deno Deploy, then deploy:

```sh
deno task deploy
```

The configured Deno Deploy app is `deno-upstream-proxy` under the `caidaoli`
organization.
