export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const response = await env.ASSETS.fetch(request)
    const r = new Response(response.body, response)
    r.headers.delete('X-Frame-Options')
    const isManual = new URL(request.url).pathname.startsWith('/manual/')
    r.headers.set(
      'Content-Security-Policy',
      isManual
        ? 'frame-ancestors https://relshell.moalaamri23.workers.dev'
        : 'frame-ancestors *',
    )
    return r
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher }>
