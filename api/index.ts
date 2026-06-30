interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  DATABASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
  GEMINI_API_KEY: string;
}

async function handleApiRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Proxy API calls to backend or handle directly
  if (path.startsWith("/api/")) {
    try {
      // Get the path relative to /api
      const apiPath = path.slice(5);

      // Forward the request with Supabase credentials
      const apiUrl = new URL(
        `https://pyqngqyqwevfpaxcmfnd.supabase.co/rest/v1/${apiPath}`
      );

      // Copy query parameters
      url.searchParams.forEach((value, key) => {
        apiUrl.searchParams.append(key, value);
      });

      const apiResponse = await fetch(apiUrl.toString(), {
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers),
          Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
        },
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
      });

      return new Response(apiResponse.body, {
        status: apiResponse.status,
        headers: {
          ...Object.fromEntries(apiResponse.headers),
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Unknown error";
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      // Handle API requests
      const apiResponse = await handleApiRequest(request, env);
      if (apiResponse) return apiResponse;

      // Serve static assets from the assets directory
      const response = await env.ASSETS.fetch(request);

      // If the asset exists, return it
      if (response.status !== 404) {
        return response;
      }

      // For 404s on non-API routes, serve index.html for SPA routing
      if (!url.pathname.startsWith("/api")) {
        const indexResponse = await env.ASSETS.fetch(
          new Request(new URL("/index.html", url).toString())
        );
        return new Response(indexResponse.body, {
          status: 200,
          headers: {
            ...Object.fromEntries(indexResponse.headers),
            "Cache-Control": "public, max-age=3600",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
