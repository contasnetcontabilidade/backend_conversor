import { test } from "node:test";
import assert from "node:assert/strict";
import { partesDoAnexo } from "./chatApi";

test("id de anexo do Chat vira espaco e mensagem", () => {
  assert.deepEqual(
    partesDoAnexo(
      "spaces/AAAAMpdlehY/messages/UzbfKbAjr40.UzbfKbAjr40/attachments/ClwKFm-x_Y=",
    ),
    {
      espaco: "spaces/AAAAMpdlehY",
      mensagem: "spaces/AAAAMpdlehY/messages/UzbfKbAjr40.UzbfKbAjr40",
    },
  );
});

// O id vem da tela e vira caminho na API do Chat com o token da pessoa: nada
// fora do formato de anexo pode passar.
test("id fora do formato de anexo nao passa", () => {
  for (const id of [
    "",
    "spaces/AAAA/members",
    "spaces/AAAA/messages/BBBB",
    "spaces/AAAA/messages/BBBB/attachments/",
    "spaces/AAAA/messages/BBBB/attachments/CCCC/extra",
    "spaces/../messages/BBBB/attachments/CCCC",
    "spaces/AAAA/messages/../attachments/CCCC",
    "spaces/AAAA/messages/.BBBB/attachments/CCCC",
    "/spaces/AAAA/messages/BBBB/attachments/CCCC",
    "spaces/AAAA/messages/BB?x=1/attachments/CCCC",
  ]) {
    assert.equal(partesDoAnexo(id), null, id);
  }
});
