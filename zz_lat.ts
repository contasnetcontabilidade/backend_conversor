import "dotenv/config";
import * as Ably from "ably";
import { getValidAccessToken } from "./src/services/gotoAuth";
const API = "https://api.goto.com";
function isRecord(v:any){return typeof v==="object"&&v!==null&&!Array.isArray(v);}
function temAnswererLine(rep:any){const p=rep.participants;if(!Array.isArray(p))return false;return p.some((x:any)=>isRecord(x)&&isRecord(x.type)&&x.type.value==="LINE"&&x.type.extensionNumber&&Array.isArray(x.recordings)&&x.recordings.length>0);}
let medido=0;
const rt=new Ably.Realtime(process.env.ABLY_API_KEY!);
rt.channels.get("debug:webhook").subscribe("raw", async (m:any)=>{
  const d=m.data||{}, st=d.content&&d.content.state, meta=d.content&&d.content.metadata;
  if(!(st&&st.type==="ENDING"&&meta&&meta.direction==="INBOUND"))return;
  if(medido>=2)return; medido++;
  const conv=meta.conversationSpaceId; const t0=Date.now();
  console.log(new Date().toLocaleTimeString(),"ENTRADA encerrou, medindo relatorio de", conv.slice(0,8));
  const at=await getValidAccessToken();
  for(let i=0;i<40;i++){
    const r=await fetch(`${API}/call-events-report/v1/reports/${conv}`,{headers:{Authorization:`Bearer ${at}`}});
    if(r.status===200){const rep=await r.json(); if(temAnswererLine(rep)){console.log("  >> relatorio com answerer PRONTO em", ((Date.now()-t0)/1000).toFixed(1),"s");break;} else console.log("  ..",i,"200 mas sem answerer ("+((Date.now()-t0)/1000).toFixed(0)+"s)");}
    else console.log("  ..",i,"status",r.status,"("+((Date.now()-t0)/1000).toFixed(0)+"s)");
    await new Promise(r=>setTimeout(r,1500));
  }
});
rt.channels.get("debug:webhook").attach().then(()=>console.log("medindo latencia do relatorio nas proximas 2 entradas..."));
