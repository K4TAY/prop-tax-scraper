// Probe Bexar publicsearch websocket for document search protocol
const parties = {
  parties: [{ term: "FORTE KEVIN", types: ["grantor", "grantee"] }],
};
const query = {
  department: "RP",
  parties,
  recordedDateRange: "20100101,20260922",
  searchType: "advancedSearch",
};

const ws = new WebSocket("wss://bexar.tx.publicsearch.us/ws");
const msgs = [];
ws.addEventListener("open", () => {
  console.log("open");
  // try a few likely payloads
  const candidates = [
    { type: "documents.fetch", payload: { query } },
    { type: "documents/search", payload: { query } },
    { action: "documents.fetch", query },
    ["documents.fetch", { query }],
    { listenFor: "documents", query },
  ];
  for (const c of candidates) {
    const s = JSON.stringify(c);
    console.log("send", s.slice(0, 200));
    ws.send(s);
  }
});
ws.addEventListener("message", (e) => {
  const t = String(e.data);
  msgs.push(t.slice(0, 500));
  console.log("msg", t.slice(0, 400));
  if (msgs.length >= 8) {
    ws.close();
  }
});
ws.addEventListener("error", (e) => console.log("err", e));
ws.addEventListener("close", () => {
  console.log("closed", msgs.length);
  process.exit(0);
});
setTimeout(() => {
  console.log("timeout");
  ws.close();
  process.exit(1);
}, 8000);
