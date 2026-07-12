export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const response = await env.ASSETS.fetch(request)
    const r = new Response(response.body, response)
    const pathname = new URL(request.url).pathname

    r.headers.delete('X-Frame-Options')
    const isManual = pathname === '/manual' || pathname.startsWith('/manual/')
    r.headers.set(
      'Content-Security-Policy',
      isManual
        ? 'frame-ancestors https://relshell.moalaamri23.workers.dev'
        : 'frame-ancestors *',
    )

    if (pathname === '/manual/index.html') {
      r.headers.set('Content-Type', 'text/html; charset=utf-8')
      r.headers.set(
        'Content-Disposition',
        'attachment; filename="user-manual.html"',
      )
    } else if (pathname === '/manual/manual.pdf') {
      r.headers.set('Content-Type', 'application/pdf')
      r.headers.set(
        'Content-Disposition',
        'attachment; filename="user-manual.pdf"',
      )
    } else if (pathname === '/manual/' || pathname === '/manual') {
      // Reliability Shell embeds this route; keep it browser-viewable.
      r.headers.delete('Content-Disposition')
      r.headers.set('Content-Type', 'text/html; charset=utf-8')
    }

    return r
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher }>
