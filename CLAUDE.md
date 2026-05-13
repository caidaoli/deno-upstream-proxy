# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

单文件 Deno HTTP/WebSocket 反向代理，部署到 Deno Deploy。整个核心实现只有 `proxy.ts`（约 260 行）和 `main.ts`（入口 9 行）。修改时优先保持代码量与依赖的克制。

## 常用命令

```sh
deno task check    # 类型检查 main.ts proxy.ts main_test.ts
deno task dev      # 本地启动（--watch 热重载，默认 :8000）
deno task test     # 单元 + 本地集成测试
deno task deploy   # 部署到 Deno Deploy (org=caidaoli, app=deno-upstream-proxy)
deno fmt           # 格式化（提交前必跑，CI 等价于 deno fmt --check）
deno lint          # 静态分析
```

运行单个测试：`deno test --allow-env=UPSTREAM_URL,ROOT_REDIRECT_PATH,UPSTREAM_ORIGIN_HEADER,UPSTREAM_USER_AGENT_HEADER --allow-net=127.0.0.1 --filter "<name 子串>"`

`dev` 任务的 `--allow-env` 是**白名单形式**，新增环境变量配置项时必须同步更新 `deno.json` 中 `dev` 与 `test` 两个任务的 `--allow-env` 列表，否则运行时读取会被 Deno 权限系统拦截。

## 架构要点

### 请求分发顺序（`createHandler` 内）

1. `OPTIONS` → CORS preflight（204）。
2. `Upgrade: websocket` → 走 WS 代理路径（`proxyWebSocketRequest`）。
3. 根路径 `/` 的 `GET`/`HEAD`：配置了 `ROOT_REDIRECT_PATH` 时返回 302，否则返回 `ok` 健康响应。
4. 其余请求 → `proxyRequest`（标准 fetch 转发，CORS 头注入到响应）。

任何返回都会经过 `withCors()` 注入 CORS 头，包括错误响应。新增分支时遵循同一约定。

### 配置加载（`loadConfig`）

只从环境变量读取，不接受文件或命令行参数：

- `UPSTREAM_URL`（必需，http/https）
- `ROOT_REDIRECT_PATH`、`UPSTREAM_ORIGIN_HEADER`、`UPSTREAM_USER_AGENT_HEADER`（可选）

`readOptionalEnv` 把空字符串当作未设置（Deno Deploy 控制台无法填 undefined，必须靠空串语义模拟）。

### WebSocket 桥接

`bridgeWebSockets` 处理一个关键时序问题：客户端可能在 `serverSocket` 完成握手前就发送消息。实现用 `pendingMessages` 缓冲，并在 `serverSocket.onopen` 时一次性刷出。修改这里要保留该缓冲逻辑——曾被验证为必要。

### 不可改写的 Host 头

`upstreamRequestHeadersFor` 主动 `delete("host")`，但**不接受**通过环境变量覆盖 host。Deno 的 `fetch` 从 `UPSTREAM_URL` 自动派生真实 Host，外层伪造 host 头不会生效，反而让测试与现实行为分歧——这是历史教训，不要重新引入 `UPSTREAM_HOST_HEADER` 之类的配置。

## 测试约定

- 测试通过替换 `globalThis.fetch` 隔离上游；记得 `finally` 中恢复 `originalFetch`。
- 涉及 `loadConfig` 的测试必须在 `finally` 调用 `restoreEnv()`，否则会污染后续测试用例。
- 真实集成测试用 `Deno.serve({ hostname: "127.0.0.1", port: 0 })` 绑定随机端口，`--allow-net=127.0.0.1` 就是为这类测试存在的，**不要**放宽到 `--allow-net`。
- 用 `withTimeout`/`waitForWebSocket*` 辅助避免 WS 测试挂死。

## 部署

`deno.json` 已固化 `deploy.org=caidaoli` 与 `deploy.app=deno-upstream-proxy`。生产环境变量在 Deno Deploy 控制台维护，本地仅用于开发与测试。
