export interface ProxyConfig {
  upstreamUrl: URL;
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

function parseUpstreamUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("UPSTREAM_URL must use http or https");
  }

  return url;
}

export function loadConfig(): ProxyConfig {
  return {
    upstreamUrl: parseUpstreamUrl(readRequiredEnv("UPSTREAM_URL")),
  };
}

function targetUrlFor(req: Request, upstreamUrl: URL): URL {
  const incomingUrl = new URL(req.url);
  return new URL(incomingUrl.pathname + incomingUrl.search, upstreamUrl.origin);
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

function isRootHealthRequest(req: Request): boolean {
  const url = new URL(req.url);
  return (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/" && url.search === "";
}

async function proxyRequest(
  req: Request,
  config: ProxyConfig,
): Promise<Response> {
  const targetUrl = targetUrlFor(req, config.upstreamUrl);
  const headers = new Headers(req.headers);
  headers.delete("host");

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

    if (isRootHealthRequest(req)) {
      return healthResponse();
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
