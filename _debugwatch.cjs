require("dotenv/config");
const Ably = require("ably");
const fs = require("fs");
const OUT = "C:/Users/CONTAS~1/AppData/Local/Temp/claude/c--Users-Contas-Contabilidade-Desktop-conversor-WAV-txt/0e12a7b2-f31f-40c7-82d5-1f7451222c7d/scratchpad/goto-raw.json";
const rt = new Ably.Realtime(process.env.ABLY_API_KEY);
const ch = rt.channels.get("debug:webhook");
ch.subscribe("raw", (msg) => {
  fs.writeFileSync(OUT, JSON.stringify(msg.data, null, 2));
  console.log("CAPTURADO payload real do GoTo");
  rt.close();
  process.exit(0);
});
ch.attach().then(() => console.log("Ouvindo debug:webhook... faca uma ligacao de teste."));
setTimeout(() => { console.log("timeout sem evento"); process.exit(1); }, 600000);
