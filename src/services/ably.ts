import * as Ably from "ably";
import { AppError } from "../lib/errors";
import { CallEndedEvent } from "./store";

// Push em tempo real via Ably. O backend guarda a ROOT key e:
//  - publica o evento de chamada encerrada no canal do ramal (ramal:<ext>);
//  - emite tokens temporarios (escopo: assinar so o proprio ramal) para o app.
// Os apps desktop NUNCA recebem a root key.

const CHANNEL_PREFIX = "ramal:";

let rest: Ably.Rest | null = null;

function getRest(): Ably.Rest {
  if (rest) return rest;
  const key = process.env.ABLY_API_KEY;
  if (!key) {
    throw new AppError({
      statusCode: 503,
      code: "ABLY_NOT_CONFIGURED",
      message: "Ably nao configurado. Defina ABLY_API_KEY.",
    });
  }
  rest = new Ably.Rest(key);
  return rest;
}

export function isAblyConfigured(): boolean {
  return Boolean(process.env.ABLY_API_KEY);
}

export function channelForRamal(ramal: string): string {
  return `${CHANNEL_PREFIX}${ramal}`;
}

// Publica o evento de chamada encerrada para um ramal especifico.
export async function publishCallEnded(
  ramal: string,
  event: CallEndedEvent,
): Promise<void> {
  const channel = getRest().channels.get(channelForRamal(ramal));
  await channel.publish("call-ended", event);
}

// Avisa (em tempo real) que o chamado de uma chamada foi criado, para que os
// OUTROS atendentes (transferencia) desabilitem o botao "abrir chamado".
export async function publishChamadoCriado(
  ramal: string,
  payload: { conversationSpaceId: string },
): Promise<void> {
  const channel = getRest().channels.get(channelForRamal(ramal));
  await channel.publish("chamado-criado", payload);
}

// Pede ao app desktop deste ramal que abra a revisao de um e-mail. Vem do
// botao "Abrir no app" do painel do Gmail: a IA roda no app, que nao tem o
// limite de poucos segundos que o Google impoe ao painel.
export async function publishAbrirEmail(
  ramal: string,
  payload: { conta: string; threadId?: string; messageId?: string },
): Promise<void> {
  const channel = getRest().channels.get(channelForRamal(ramal));
  await channel.publish("abrir-email", payload);
}

// Mesmo pedido, vindo do Google Chat: abrir a conversa na aba Chat do app, com
// a mensagem ja marcada quando a pessoa usou "Abrir chamado" numa mensagem.
export async function publishAbrirChat(
  ramal: string,
  payload: { conta: string; spaceId: string; nome: string; messageId?: string },
): Promise<void> {
  const channel = getRest().channels.get(channelForRamal(ramal));
  await channel.publish("abrir-chat", payload);
}

// Ramais com o app aberto agora -> em quantas maquinas (aba "Online" do /admin).
// Todo app aberto, ate minimizado na bandeja, assina o canal do seu ramal; a
// ocupacao do canal e metadado do Ably, entao isto funciona sem o app mudar.
// Uma chamada so: a versao 2 da API REST com by=value devolve a ocupacao junto
// com a lista (a 3 so devolve os nomes, e ai seria uma chamada por canal).
// Canal ativo com 0 assinantes = o app acabou de sair, ou o backend acabou de
// publicar nele; fica de fora. Timeout: o padrao do cliente REST (10 s).
export async function ramaisConectados(): Promise<Map<string, number>> {
  const resp = await getRest().request("get", "/channels", 2, {
    prefix: CHANNEL_PREFIX,
    by: "value",
    limit: 1000, // o teto da GoTo e 180 ramais: cabe numa pagina
  });
  if (!resp.success) {
    throw new Error(
      `Ably respondeu ${resp.statusCode} ao listar os canais: ${resp.errorMessage || "sem detalhe"}`,
    );
  }
  const conectados = new Map<string, number>();
  for (const canal of resp.items || []) {
    const nome = String(canal?.channelId || canal?.name || "");
    const assinantes = Number(canal?.status?.occupancy?.metrics?.subscribers) || 0;
    if (nome.startsWith(CHANNEL_PREFIX) && assinantes > 0) {
      conectados.set(nome.slice(CHANNEL_PREFIX.length), assinantes);
    }
  }
  return conectados;
}

// Gera um TokenRequest com capacidade limitada a assinar o canal do ramal.
// O desktop usa isso (via authUrl) para conectar sem ver a root key.
export async function createRamalTokenRequest(
  ramal: string,
): Promise<Ably.TokenRequest> {
  const capability = { [channelForRamal(ramal)]: ["subscribe"] };
  return getRest().auth.createTokenRequest({
    clientId: `ramal-${ramal}`,
    capability: JSON.stringify(capability),
  });
}
