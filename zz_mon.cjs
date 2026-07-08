require("dotenv/config");
const Ably = require("ably");
const rt = new Ably.Realtime(process.env.ABLY_API_KEY);
function deepExt(n, o) {
  if (!n) return;
  if (Array.isArray(n)) { n.forEach((x) => deepExt(x, o)); return; }
  if (typeof n === "object") for (const k of Object.keys(n)) { if (/^extensionNumber$/i.test(k) && n[k]) o.add(String(n[k])); else deepExt(n[k], o); }
}
rt.channels.get("ramal:258").subscribe("call-ended", (m) => {
  console.log("ENTREGOU no ramal:258 -> " + JSON.stringify(m.data));
});
rt.channels.get("debug:webhook").subscribe("raw", (m) => {
  const d = m.data || {}, st = d.content && d.content.state, meta = d.content && d.content.metadata, o = new Set();
  deepExt(d, o);
  // so notifica ligacao de ENTRADA (o caso que estamos testando)
  if (st && st.type === "ENDING" && meta && meta.direction === "INBOUND") {
    console.log("ENTRADA encerrada: conv=" + String(meta.conversationSpaceId || "").slice(0, 8) + " ext_no_evento=" + ([...o].join(",") || "nenhum"));
  }
});
Promise.all([rt.channels.get("ramal:258").attach(), rt.channels.get("debug:webhook").attach()]).then(() => console.log("monitor ativo: ramal:258 + entradas"));
