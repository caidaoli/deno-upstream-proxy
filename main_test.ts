import { assertEquals, assertStringIncludes } from "@std/assert";
import { createHandler, loadConfig } from "./proxy.ts";

const originalFetch = globalThis.fetch;
const ENV_NAMES = [
  "UPSTREAM_URL",
  "ROOT_REDIRECT_PATH",
  "UPSTREAM_ORIGIN_HEADER",
  "UPSTREAM_USER_AGENT_HEADER",
] as const;
const originalEnv = new Map(
  ENV_NAMES.map((name) => [name, Deno.env.get(name)]),
);

function restoreEnv(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) {
      Deno.env.delete(name);
    } else {
      Deno.env.set(name, value);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), 1000);
  });

  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timeoutId)
  );
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return withTimeout(
    new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("websocket open failed"));
      socket.onclose = () =>
        reject(new Error("websocket closed before opening"));
    }),
    "timed out waiting for websocket open",
  );
}

function waitForWebSocketMessage(socket: WebSocket): Promise<unknown> {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.onmessage = (event) => resolve(event.data);
      socket.onerror = () => reject(new Error("websocket message failed"));
      socket.onclose = () =>
        reject(new Error("websocket closed before receiving a message"));
    }),
    "timed out waiting for websocket message",
  );
}

Deno.test("OPTIONS requests return CORS preflight response", async () => {
  const handleRequest = createHandler({
    upstreamUrl: new URL("https://api.example"),
  });
  const response = await handleRequest(
    new Request("https://proxy.example/v1/models", { method: "OPTIONS" }),
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "Content-Type, Authorization",
  );
});

Deno.test("root path returns local health response", async () => {
  const handleRequest = createHandler({
    upstreamUrl: new URL("https://api.example"),
  });

  const response = await handleRequest(new Request("https://proxy.example/"));

  assertEquals(response.status, 200);
  assertEquals(await response.text(), "ok");
});

Deno.test("GET root redirects to configured root path", async () => {
  try {
    Deno.env.set("UPSTREAM_URL", "https://api.example");
    Deno.env.set("ROOT_REDIRECT_PATH", "/management.html");

    const handleRequest = createHandler(loadConfig());

    const response = await handleRequest(new Request("https://proxy.example/"));

    assertEquals(response.status, 302);
    assertEquals(response.headers.get("location"), "/management.html");
    assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    restoreEnv();
  }
});

Deno.test("empty root redirect path keeps local health response", async () => {
  try {
    Deno.env.set("UPSTREAM_URL", "https://api.example");
    Deno.env.set("ROOT_REDIRECT_PATH", "");

    const handleRequest = createHandler(loadConfig());

    const response = await handleRequest(new Request("https://proxy.example/"));

    assertEquals(response.status, 200);
    assertEquals(await response.text(), "ok");
  } finally {
    restoreEnv();
  }
});

Deno.test("proxy requests use the configured upstream origin", async () => {
  const handleRequest = createHandler({
    upstreamUrl: new URL("https://upstream.example/base"),
  });

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);

    assertEquals(request.url, "https://upstream.example/v1/chat?q=1");
    assertEquals(request.method, "POST");
    assertEquals(request.headers.get("authorization"), "Bearer test");
    assertEquals(await request.text(), "payload");

    return new Response("upstream", {
      status: 201,
      headers: { "content-type": "text/plain" },
    });
  };

  try {
    const response = await handleRequest(
      new Request("https://proxy.example/v1/chat?q=1", {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body: "payload",
      }),
    );

    assertEquals(response.status, 201);
    assertEquals(await response.text(), "upstream");
    assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("proxy requests apply configured upstream header overrides", async () => {
  const handleRequest = createHandler({
    upstreamHeaders: {
      origin: "https://caidao78-a.hf.space",
      userAgent: "test-agent",
    },
    upstreamUrl: new URL("https://upstream.example"),
  });

  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);

    assertEquals(
      request.headers.get("origin"),
      "https://caidao78-a.hf.space",
    );
    assertEquals(request.headers.get("user-agent"), "test-agent");

    return Promise.resolve(new Response("upstream"));
  };

  try {
    await handleRequest(new Request("https://proxy.example/v1/models"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("real upstream receives configured header overrides", async () => {
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (req) => {
    return new Response(
      JSON.stringify({
        host: req.headers.get("host"),
        origin: req.headers.get("origin"),
        userAgent: req.headers.get("user-agent"),
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const handleRequest = createHandler({
    upstreamHeaders: {
      origin: "https://caidao78-a.hf.space",
      userAgent: "test-agent",
    },
    upstreamUrl: new URL(`http://127.0.0.1:${upstream.addr.port}`),
  });

  try {
    const response = await handleRequest(
      new Request("https://proxy.example/v1/models"),
    );

    assertEquals(await response.json(), {
      host: `127.0.0.1:${upstream.addr.port}`,
      origin: "https://caidao78-a.hf.space",
      userAgent: "test-agent",
    });
  } finally {
    await upstream.shutdown();
  }
});

Deno.test("upstream fetch failures return a 500 response", async () => {
  const handleRequest = createHandler({
    upstreamUrl: new URL("https://api.example"),
  });

  globalThis.fetch = () => {
    throw new Error("network down");
  };

  try {
    const response = await handleRequest(
      new Request("https://proxy.example/v1/models"),
    );

    assertEquals(response.status, 500);
    assertStringIncludes(await response.text(), "network down");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("websocket upgrade proxies messages to upstream", async () => {
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (req) => {
    const url = new URL(req.url);
    assertEquals(url.pathname, "/socket");
    assertEquals(url.search, "?q=1");

    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (event) => socket.send(`echo:${event.data}`);
    return response;
  });
  const proxy = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    },
    createHandler({
      upstreamUrl: new URL(`http://127.0.0.1:${upstream.addr.port}`),
    }),
  );
  const client = new WebSocket(
    `ws://127.0.0.1:${proxy.addr.port}/socket?q=1`,
  );

  try {
    await waitForWebSocketOpen(client);
    const message = waitForWebSocketMessage(client);

    client.send("ping");

    assertEquals(await message, "echo:ping");
  } finally {
    client.close();
    await proxy.shutdown();
    await upstream.shutdown();
  }
});

Deno.test("loadConfig requires UPSTREAM_URL", () => {
  try {
    Deno.env.delete("UPSTREAM_URL");

    try {
      loadConfig();
    } catch (error) {
      assertEquals(error instanceof Error, true);
      assertStringIncludes(String(error), "UPSTREAM_URL");
      return;
    }

    throw new Error("loadConfig accepted a missing UPSTREAM_URL");
  } finally {
    restoreEnv();
  }
});

Deno.test("loadConfig reads optional upstream header overrides", () => {
  try {
    Deno.env.set("UPSTREAM_URL", "https://api.example");
    Deno.env.set("UPSTREAM_ORIGIN_HEADER", "https://caidao78-a.hf.space");
    Deno.env.set("UPSTREAM_USER_AGENT_HEADER", "test-agent");

    assertEquals(loadConfig().upstreamHeaders, {
      origin: "https://caidao78-a.hf.space",
      userAgent: "test-agent",
    });
  } finally {
    restoreEnv();
  }
});

Deno.test("loadConfig reads UPSTREAM_URL", () => {
  try {
    Deno.env.set("UPSTREAM_URL", "https://api.example");

    assertEquals(loadConfig().upstreamUrl.href, "https://api.example/");
  } finally {
    restoreEnv();
  }
});
