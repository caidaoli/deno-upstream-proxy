import { assertEquals, assertStringIncludes } from "@std/assert";
import { createHandler, loadConfig } from "./proxy.ts";

const originalFetch = globalThis.fetch;
const originalEnv = Deno.env.get("UPSTREAM_URL");

function restoreEnv(): void {
  if (originalEnv === undefined) {
    Deno.env.delete("UPSTREAM_URL");
    return;
  }

  Deno.env.set("UPSTREAM_URL", originalEnv);
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

Deno.test("loadConfig reads UPSTREAM_URL", () => {
  try {
    Deno.env.set("UPSTREAM_URL", "https://api.example");

    assertEquals(loadConfig().upstreamUrl.href, "https://api.example/");
  } finally {
    restoreEnv();
  }
});
