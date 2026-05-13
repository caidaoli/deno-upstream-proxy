import { createHandler, loadConfig } from "./proxy.ts";

let handler: ((req: Request) => Promise<Response>) | undefined;

Deno.serve((req) => {
  handler ??= createHandler(loadConfig());
  return handler(req);
});
