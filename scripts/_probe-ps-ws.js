const js = await Bun.file("/tmp/client.e3858089cda0dd35946c.js").text();
const i = js.indexOf("wss://${window.location.host}/ws");
console.log(js.slice(i - 500, i + 800));

for (const needle of [
  "listenFor",
  "documents.search",
  "SEARCH_DOCUMENTS",
  "searchDocuments",
  '"search"',
  "forceReconnect",
  "BroadcastChannel",
]) {
  let n = 0;
  let p = 0;
  while ((p = js.indexOf(needle, p)) >= 0 && n < 2) {
    console.log("\n---", needle, p);
    console.log(js.slice(Math.max(0, p - 60), p + 200).replace(/\n/g, " "));
    p += needle.length;
    n++;
  }
}
