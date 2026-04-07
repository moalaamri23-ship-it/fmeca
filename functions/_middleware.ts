export const onRequest: PagesFunction = async (ctx) => {
  const res = await ctx.next()
  const r = new Response(res.body, res)
  r.headers.delete('X-Frame-Options')
  r.headers.set('Content-Security-Policy', "frame-ancestors *")
  return r
}
