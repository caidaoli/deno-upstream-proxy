export interface ProxyConfig {
  rootRedirectPath?: string;
  upstreamHeaders?: UpstreamHeaders;
  upstreamUrl: URL;
}

export interface UpstreamHeaders {
  origin?: string;
  userAgent?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    result.set(key, value);
  }

  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value === undefined || value === "" ? undefined : value;
}

function parseUpstreamUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("UPSTREAM_URL must use http or https");
  }

  return url;
}

export function loadConfig(): ProxyConfig {
  return {
    rootRedirectPath: readOptionalEnv("ROOT_REDIRECT_PATH"),
    upstreamHeaders: loadUpstreamHeaders(),
    upstreamUrl: parseUpstreamUrl(readRequiredEnv("UPSTREAM_URL")),
  };
}

function loadUpstreamHeaders(): UpstreamHeaders | undefined {
  const upstreamHeaders = {
    origin: readOptionalEnv("UPSTREAM_ORIGIN_HEADER"),
    userAgent: readOptionalEnv("UPSTREAM_USER_AGENT_HEADER"),
  };

  return Object.values(upstreamHeaders).some((value) => value !== undefined)
    ? upstreamHeaders
    : undefined;
}

function targetUrlFor(req: Request, upstreamUrl: URL): URL {
  const incomingUrl = new URL(req.url);
  return new URL(incomingUrl.pathname + incomingUrl.search, upstreamUrl.origin);
}

function targetWebSocketUrlFor(req: Request, upstreamUrl: URL): URL {
  const targetUrl = targetUrlFor(req, upstreamUrl);
  targetUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  return targetUrl;
}

function requestBodyFor(req: Request): BodyInit | undefined {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  return req.body ?? undefined;
}

function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: withCors({
      "Access-Control-Max-Age": "86400",
    }),
  });
}

function healthResponse(): Response {
  return new Response("ok", {
    status: 200,
    headers: withCors({ "content-type": "text/plain; charset=utf-8" }),
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: withCors({ location }),
  });
}

function isRootRequest(req: Request): boolean {
  const url = new URL(req.url);
  return url.pathname === "/" && url.search === "";
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function upstreamRequestHeadersFor(
  requestHeaders: Headers,
  config: ProxyConfig,
): Headers {
  const headers = new Headers(requestHeaders);
  headers.delete("host");

  if (config.upstreamHeaders?.origin) {
    headers.set("origin", config.upstreamHeaders.origin);
  }
  if (config.upstreamHeaders?.userAgent) {
    headers.set("user-agent", config.upstreamHeaders.userAgent);
  }

  return headers;
}

function sendWhenOpen(
  socket: WebSocket,
  data: string | ArrayBufferLike | Blob | ArrayBufferView,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(data);
  return true;
}

function closeSocket(socket: WebSocket): void {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

function bridgeWebSockets(clientSocket: WebSocket, serverSocket: WebSocket) {
  const pendingMessages: Array<
    string | ArrayBufferLike | Blob | ArrayBufferView
  > = [];

  clientSocket.onmessage = (event) => {
    if (!sendWhenOpen(serverSocket, event.data)) {
      pendingMessages.push(event.data);
    }
  };
  serverSocket.onopen = () => {
    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      if (message !== undefined) {
        sendWhenOpen(serverSocket, message);
      }
    }
  };
  serverSocket.onmessage = (event) => {
    sendWhenOpen(clientSocket, event.data);
  };

  clientSocket.onerror = () => closeSocket(serverSocket);
  serverSocket.onerror = () => closeSocket(clientSocket);
  clientSocket.onclose = () => closeSocket(serverSocket);
  serverSocket.onclose = () => closeSocket(clientSocket);
}

function proxyWebSocketRequest(req: Request, config: ProxyConfig): Response {
  const targetUrl = targetWebSocketUrlFor(req, config.upstreamUrl);
  console.log(`[proxy] WS ${targetUrl}`);

  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);
  const serverSocket = new WebSocket(targetUrl);
  bridgeWebSockets(clientSocket, serverSocket);

  return response;
}

async function proxyRequest(
  req: Request,
  config: ProxyConfig,
): Promise<Response> {
  const targetUrl = targetUrlFor(req, config.upstreamUrl);
  const headers = upstreamRequestHeadersFor(req.headers, config);

  console.log(`[proxy] ${req.method} ${targetUrl}`);

  const upstreamResponse = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: requestBodyFor(req),
    redirect: "follow",
  });

  console.log(
    `[proxy] ${upstreamResponse.status} ${upstreamResponse.statusText} ${req.method} ${targetUrl}`,
  );

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: withCors(upstreamResponse.headers),
  });
}

export function createHandler(
  config: ProxyConfig,
): (req: Request) => Promise<Response> {
  return async function handleRequest(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return preflightResponse();
    }

    if (isWebSocketUpgrade(req)) {
      return proxyWebSocketRequest(req, config);
    }

    if (isRootRequest(req)) {
      if (req.method === "GET" && config.rootRedirectPath) {
        return redirectResponse(config.rootRedirectPath);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return healthResponse();
      }
    }

    try {
      return await proxyRequest(req, config);
    } catch (error) {
      const message = errorMessage(error);
      console.error("proxy request failed:", message);

      return new Response(`代理错误: ${message}`, {
        status: 500,
        headers: withCors({ "content-type": "text/plain; charset=utf-8" }),
      });
    }
  };
}
