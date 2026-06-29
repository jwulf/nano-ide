// GUI app — a self-contained binary serving a UI for your process application.
// deno compile bundles this + ./public into one binary (deno compile --include public).
const BASE = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
const PORT = Number(Deno.env.get("PORT") ?? 8090);
Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/api/start") {
    const r = await fetch(`${BASE}/v2/process-instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ processDefinitionId: "starter", awaitCompletion: false }),
    });
    return new Response(await r.text(), { headers: { "content-type": "application/json" } });
  }
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    return new Response(await Deno.readTextFile(`./public${path}`), {
      headers: { "content-type": path.endsWith(".html") ? "text/html" : "text/plain" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
console.log(`GUI app serving on :${PORT}`);
