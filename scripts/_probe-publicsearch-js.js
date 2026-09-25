const urls = [
  "https://bexar.tx.publicsearch.us/Search.419a2cf434025c939c8e.js",
  "https://bexar.tx.publicsearch.us/client.e3858089cda0dd35946c.js",
  "https://bexar.tx.publicsearch.us/runtime.119e85a3e239824c3edf.js",
];
for (const url of urls) {
  const js = await (await fetch(url)).text();
  const name = url.split("/").pop();
  await Bun.write(`/tmp/${name}`, js);
  console.log("\n===", name, js.length);
  const paths = [
    ...js.matchAll(/["'`](\/(?:api|search|Results|Document|Department)[^"'`]{0,100})["'`]/gi),
  ].map((m) => m[1]);
  console.log("paths", [...new Set(paths)].slice(0, 40));
  const abs = [...js.matchAll(/https?:\\?\/\\?\/[^"'\\\s]{8,140}/g)].map((m) =>
    m[0].replace(/\\\//g, "/")
  );
  console.log("abs", [...new Set(abs)].slice(0, 20));
  // common govos patterns
  for (const pat of [
    /AdvancedSearch/g,
    /documentTypes/g,
    /PublicSearch/g,
    /\/Results/g,
    /tenantId/g,
    /48029/g,
  ]) {
    const n = [...js.matchAll(pat)].length;
    if (n) console.log(pat, n);
  }
}
