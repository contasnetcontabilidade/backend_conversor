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

// Publica o payload cru do webhook num canal de debug (para inspecionar o
// formato real do evento do GoTo durante os testes). Removivel depois.
export async function publishDebug(payload: unknown): Promise<void> {
  if (!isAblyConfigured()) return;
  const channel = getRest().channels.get("debug:webhook");
  await channel.publish("raw", payload as Record<string, unknown>);
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
