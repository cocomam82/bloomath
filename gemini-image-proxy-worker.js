/**
 * gemini-image-proxy-worker.js
 *
 * Cloudflare Worker that proxies image-generation requests to the
 * Gemini 2.5 Flash Image API, keeping the real API key hidden on the
 * server side. The bloommath textbook.html page calls THIS worker's
 * URL instead of calling Google directly, so the key never appears
 * in the page source.
 *
 * ── DEPLOY STEPS ──────────────────────────────────────────────────
 * 1. Go to https://dash.cloudflare.com → sign up free (no credit card
 *    needed for the free plan).
 * 2. Left sidebar → "Workers & Pages" → "Create" → "Create Worker".
 * 3. Give it a name, e.g. "bloommath-image-proxy" → Deploy.
 * 4. Click "Edit code", delete the sample code, paste this whole file
 *    in, then click "Deploy" again.
 * 5. Go to the worker's "Settings" → "Variables and Secrets" →
 *    "Add" → name: GEMINI_API_KEY, value: (your real key from
 *    https://aistudio.google.com/apikey), type: Secret → Save.
 * 6. Also add ALLOWED_ORIGIN (type: plain text) set to your real
 *    website's origin, e.g. https://bloommath.co.kr — this stops
 *    other sites from using your proxy.
 * 7. Copy the worker's URL (looks like
 *    https://bloommath-image-proxy.YOUR-SUBDOMAIN.workers.dev).
 * 8. Paste that URL into PROXY_URL in textbook.html (see the
 *    accompanying instructions).
 * ──────────────────────────────────────────────────────────────────
 */

export default {
  async fetch(request, env) {
    // Allow the browser's CORS preflight request through.
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, env);
    }

    // Basic origin check so random sites can't ride on your quota.
    const origin = request.headers.get("Origin") || "";
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, env);
    }

    const prompt = (body && body.prompt || "").toString().trim();
    if (!prompt) {
      return json({ error: "Missing 'prompt'" }, 400, env);
    }
    // Keep prompts short and bounded to control cost/abuse.
    if (prompt.length > 500) {
      return json({ error: "Prompt too long" }, 400, env);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return json({ error: "Server is missing GEMINI_API_KEY" }, 500, env);
    }

    try {
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (!upstream.ok) {
        return json({ error: `Upstream error ${upstream.status}` }, 502, env);
      }

      const result = await upstream.json();
      const parts = result?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inlineData?.data);

      if (!imagePart) {
        return json({ error: "No image returned" }, 502, env);
      }

      return json(
        {
          mimeType: imagePart.inlineData.mimeType || "image/png",
          data: imagePart.inlineData.data,
        },
        200,
        env
      );
    } catch (err) {
      return json({ error: "Proxy request failed" }, 500, env);
    }
  },
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}
