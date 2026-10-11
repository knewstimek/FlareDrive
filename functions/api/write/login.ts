export async function onRequestGet(context) {
  const { request } = context;
  // This route is covered by the same Access application as object writes.
  if (request.headers.get("X-Requested-With") === "XMLHttpRequest") {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  const requestUrl = new URL(request.url);
  const destination = new URL("/", requestUrl.origin);
  const folder = requestUrl.searchParams.get("p");
  if (folder) destination.searchParams.set("p", folder);
  return new Response(null, {
    status: 302,
    headers: { Location: destination.toString(), "Cache-Control": "no-store" },
  });
}
