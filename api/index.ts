interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
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

      // Return 404 for missing API routes
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
