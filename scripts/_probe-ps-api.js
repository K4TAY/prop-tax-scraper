const js = await Bun.file("/tmp/client.e3858089cda0dd35946c.js").text();

for (const needle of [
  "documents.fetch",
  "DOCUMENTS_FETCH",
  "/documents",
  "search-api",
  "api.publicsearch",
  "publicsearch.us/api",
  "createSearch",
  "fetchDocuments",
]) {
  let count = 0;
  let i = 0;
  while ((i = js.indexOf(needle, i)) >= 0 && count < 3) {
    console.log("\n===", needle, i);
    console.log(js.slice(Math.max(0, i - 100), i + 300).replace(/\n/g, " "));
    i += needle.length;
    count++;
  }
}

const pathish = [
  ...js.matchAll(/["'`](\/(?:api|v\d|search|documents|Results)[^"'`]{0,100})["'`]/gi),
].map((m) => m[1]);
console.log("\npaths", [...new Set(pathish)].slice(0, 50));

// websocket?
console.log(
  "ws?",
  [...js.matchAll(/wss?:\/\/[^"'\\\s]+/g)].map((m) => m[0]).slice(0, 10)
);
