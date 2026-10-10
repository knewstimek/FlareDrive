export async function onRequest(context) {
  const token = context.env.UPLOAD_TEST_TOKEN;
  if (!token) return new Response("Test access is not configured.", { status: 503 });
  const authorization = context.request.headers.get("Authorization") || "";
  const basic = "Basic " + btoa("test:" + token);
  if (authorization !== "Bearer " + token && authorization !== basic) {
    return new Response("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Upload test"' },
    });
  }
  return context.next();
}
