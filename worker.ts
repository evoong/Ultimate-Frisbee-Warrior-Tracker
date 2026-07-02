import { createGateway } from './gateway/index'

interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_JWKS_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      const gateway = createGateway({
        supabaseUrl: env.SUPABASE_URL,
        publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
        jwksUrl: env.SUPABASE_JWKS_URL,
      });

      const gatewayResponse = await gateway(request);
      if (gatewayResponse) return gatewayResponse;

      const response = await env.ASSETS.fetch(request);

      if (response.status !== 404) {
        return response;
      }

      const isSpaPath =
        !url.pathname.startsWith("/api") &&
        !url.pathname.startsWith("/auth") &&
        !url.pathname.startsWith("/db");

      if (isSpaPath) {
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
