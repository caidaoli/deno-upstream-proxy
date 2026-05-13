# deno-upstream-proxy

[English](./README.md) | 简体中文

一个为 Deno Deploy 设计的轻量级 Deno HTTP/WebSocket 上游代理。

它将进入的请求转发到一个配置好的上游源站，保留原始请求的路径与查询字符串，
为响应注入宽松的 CORS 头，并可选地将 `GET /` 重定向到管理页面。

## 功能特性

- 标准 HTTP 请求代理转发。
- 针对 `Upgrade: websocket` 请求的 WebSocket 代理。
- 对 `OPTIONS` 请求处理 CORS 预检。
- 为代理响应注入 CORS 头。
- 可选的 `GET /` 重定向，由环境变量控制。
- 可选的上游 `Origin` 与 `User-Agent` 请求头覆写。
- 未启用根路径重定向时，本地对 `GET /` 与 `HEAD /` 返回健康检查响应。

## 配置项

| 变量名                       | 是否必需 | 说明                                                                                         |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `UPSTREAM_URL`               | 是       | 上游 HTTP 或 HTTPS 源站。代理会保留进入请求的路径与查询字符串。该 URL 中携带的路径会被忽略。 |
| `ROOT_REDIRECT_PATH`         | 否       | 非空时，`GET /` 返回 `302`，并以该值作为 `Location` 响应头。例：`/management.html`。         |
| `UPSTREAM_ORIGIN_HEADER`     | 否       | 覆写发送到上游的 `Origin` 请求头。适用于要求特定 origin 的上游。                             |
| `UPSTREAM_USER_AGENT_HEADER` | 否       | 覆写发送到上游的 `User-Agent` 请求头。                                                       |

`Host` 不可配置。Deno 的 `fetch` 会从 `UPSTREAM_URL` 自动派生真实的上游 `Host`
头，对外暴露伪造的 host 覆写只会造成误导。

## 本地开发

本地启动代理：

```sh
UPSTREAM_URL=https://example.com \
ROOT_REDIRECT_PATH=/management.html \
deno task dev
```

Deno 默认监听 `http://localhost:8000/`。

请求示例：

```sh
curl -i http://localhost:8000/v1/models
```

## HuggingFace Space 示例

```sh
UPSTREAM_URL=https://caidao78-a.hf.space \
ROOT_REDIRECT_PATH=/management.html \
UPSTREAM_ORIGIN_HEADER=https://caidao78-a.hf.space \
UPSTREAM_USER_AGENT_HEADER="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
deno task dev
```

## 任务命令

```sh
deno task check
deno task test
deno task deploy
```

`deno task test` 会运行单元测试与本地集成测试，覆盖 WebSocket
代理及真实上游请求头行为。

## 部署

在 Deno Deploy 控制台设置所需环境变量后执行部署：

```sh
deno task deploy
```

已配置的 Deno Deploy 应用为 `caidaoli` 组织下的 `deno-upstream-proxy`。
