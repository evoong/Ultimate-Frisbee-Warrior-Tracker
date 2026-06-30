interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
}

async function handleApiRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    try {
      const apiPath = path.slice(5);
      const supabaseUrl = env.SUPABASE_URL;
      const apiUrl = new URL(`${supabaseUrl}/rest/v1/${apiPath}`);

      url.searchParams.forEach((value, key) => {
        apiUrl.searchParams.append(key, value);
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
      };

      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        request.method !== "DELETE"
      ) {
        headers.Authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
      }

      const apiResponse = await fetch(apiUrl.toString(), {
        method: request.method,
        headers,
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
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      const apiResponse = await handleApiRequest(request, env);
      if (apiResponse) return apiResponse;

      const response = await env.ASSETS.fetch(request);

      if (response.status !== 404) {
        return response;
      }

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
