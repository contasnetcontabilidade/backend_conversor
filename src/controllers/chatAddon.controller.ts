// O complemento do Workspace dentro do Google Chat — o mesmo do painel do
// Gmail, numa instalacao so.
//
// Faz no Chat o que o "Abrir no app" faz no Gmail: pede ao app desktop da
// pessoa (pelo canal em tempo real do ramal dela) que abra a conversa na aba
// Chat, onde ela marca as mensagens e cria o chamado como sempre. Nada de IA
// aqui: o Chat so dispara.
//
// Dois jeitos de acionar (configurados na pagina do Chat no Console):
//  - comando `/chamado` (id 1): abre a conversa sem nada marcado;
//  - acao "Abrir chamado" no menu de uma mensagem (id 2): abre a conversa com
//    aquela mensagem ja marcada.
// A resposta ao comando e PRIVADA (so quem acionou ve): numa conversa com
// cliente ou colegas, um "abrindo no app" publico seria ruido.

import type { Request, Response } from "express";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { publishAbrirChat } from "../services/ably";
import { identificar, ramalDaConta } from "./gmailAddon.controller";

const CMD_CONVERSA = 1;
const CMD_MENSAGEM = 2;

// Resposta de complemento no Chat: uma mensagem nova, privada para quem acionou.
function mensagemPrivada(texto: string, usuario: string) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: {
            text: texto,
            ...(usuario ? { privateMessageViewer: { name: usuario } } : {}),
          },
        },
      },
    },
  };
}

const AJUDA =
  'Para abrir um chamado, use o menu ⋮ de uma mensagem > "Abrir chamado", ' +
  "ou digite /chamado na conversa. O Assistente de Reuniões abre a conversa " +
  "para você marcar as mensagens.";

const SEM_APP =
  "Não achei o seu Assistente de Reuniões. Abra o app neste computador, na " +
  "versão mais nova e com esta conta ativa, e tente de novo.";

function campo(obj: unknown, nome: string): Record<string, unknown> {
  return isRecord(obj) && isRecord(obj[nome]) ? (obj[nome] as Record<string, unknown>) : {};
}
const texto = (v: unknown) => (typeof v === "string" ? v : "");

// POST /api/addon/chat — todo evento do Chat cai aqui (um endereco so para
// todos os gatilhos, como configurado no Console).
export async function chatAddonController(req: Request, res: Response) {
  const evento = isRecord(req.body) ? req.body : {};
  const chat = campo(evento, "chat");
  const usuario = texto(campo(chat, "user").name);

  let conta: string;
  try {
    conta = await identificar(req, { usuarioDoChat: true });
  } catch (error) {
    const e = error instanceof AppError ? error : null;
    console.warn(
      `[addon:chat] identidade recusada: ${e?.code || "sem code"} ` +
        `${JSON.stringify(e?.details ?? getErrorMessage(error))}`,
    );
    if (e?.code === "ADDON_TOKEN_INVALIDO") {
      res.status(401).json({ ok: false, error: { code: e.code, message: e.message } });
      return;
    }
    res.status(200).json(mensagemPrivada(e?.message || "Não foi possível abrir.", usuario));
    return;
  }

  try {
    const comando = campo(chat, "appCommandPayload");
    if (Object.keys(comando).length) {
      res.status(200).json(await tratarComando(conta, usuario, comando));
      return;
    }
    // Mensagem direta para o app ou @mencao: explica como usar.
    if (Object.keys(campo(chat, "messagePayload")).length) {
      res.status(200).json(mensagemPrivada(AJUDA, usuario));
      return;
    }
    // Adicionado/removido de uma conversa e o resto: nada a dizer. Uma mensagem
    // aqui sairia PUBLICA na conversa ("fulano adicionou o app" ja basta).
    res.status(200).json({});
  } catch (error) {
    console.error(
      `[addon:chat] conta=${conta} falhou: ` +
        `${error instanceof AppError ? error.code : "sem code"} ${getErrorMessage(error)}`,
    );
    res
      .status(200)
      .json(mensagemPrivada("Algo deu errado ao abrir no app. Tente de novo.", usuario));
  }
}

async function tratarComando(
  conta: string,
  usuario: string,
  comando: Record<string, unknown>,
) {
  const meta = campo(comando, "appCommandMetadata");
  const id = Number(meta.appCommandId);
  const space = campo(comando, "space");
  const spaceId = texto(space.name);
  if (!spaceId || (id !== CMD_CONVERSA && id !== CMD_MENSAGEM)) {
    return mensagemPrivada(AJUDA, usuario);
  }

  const mensagem = campo(comando, "message");
  // Na acao de mensagem, `message` e a mensagem escolhida; no /chamado, e o
  // proprio comando digitado — que nao deve ir marcado.
  const messageId = id === CMD_MENSAGEM ? texto(mensagem.name) : "";
  // Conversa a dois nao tem nome: usa o nome de quem mandou a mensagem
  // escolhida, que e o que a pessoa reconhece na tela.
  const remetente = texto(campo(mensagem, "sender").displayName);
  const nome = texto(space.displayName) || (messageId && remetente) || "Conversa do Chat";

  const ramal = await ramalDaConta(conta);
  if (!ramal) {
    console.warn(`[addon:chat] conta=${conta} sem app registrado`);
    return mensagemPrivada(SEM_APP, usuario);
  }
  await publishAbrirChat(ramal, {
    conta,
    spaceId,
    nome,
    ...(messageId ? { messageId } : {}),
  });
  console.log(
    `[addon:chat] conta=${conta} ramal=${ramal} conversa=${spaceId}` +
      (messageId ? ` mensagem=${messageId}` : ""),
  );
  return mensagemPrivada(
    messageId
      ? "Abrindo no Assistente de Reuniões, com esta mensagem já marcada."
      : "Abrindo esta conversa no Assistente de Reuniões.",
    usuario,
  );
}
