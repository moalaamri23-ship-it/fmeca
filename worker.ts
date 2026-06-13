export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const response = await env.ASSETS.fetch(request)
    const r = new Response(response.body, response)
    r.headers.delete('X-Frame-Options')
    r.headers.set('Content-Security-Policy', "frame-ancestors *")
    return r
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher }>
