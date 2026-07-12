export const onRequest: PagesFunction = async (ctx) => {
  const res = await ctx.next()
  const r = new Response(res.body, res)
  r.headers.delete('X-Frame-Options')
  const isManual = new URL(ctx.request.url).pathname.startsWith('/manual/')
  r.headers.set(
    'Content-Security-Policy',
    isManual
      ? 'frame-ancestors https://relshell.moalaamri23.workers.dev'
      : 'frame-ancestors *',
  )
  return r
}
