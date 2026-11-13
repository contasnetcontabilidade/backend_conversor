import { test } from "node:test";
import assert from "node:assert/strict";
import { arquivosDoDrive, linkDoDrive, partesDoAnexo } from "./chatApi";

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

const ID_DRIVE = "1QwV_10B5exPOptpXO3GAHJVRXGTOWmka";

test("link do Drive abre no editor certo de cada tipo", () => {
  assert.equal(
    linkDoDrive(ID_DRIVE, "application/vnd.google-apps.spreadsheet"),
    `https://docs.google.com/spreadsheets/d/${ID_DRIVE}/edit`,
  );
  assert.equal(
    linkDoDrive(ID_DRIVE, "application/vnd.google-apps.document"),
    `https://docs.google.com/document/d/${ID_DRIVE}/edit`,
  );
  assert.equal(
    linkDoDrive(ID_DRIVE, "application/pdf"),
    `https://drive.google.com/file/d/${ID_DRIVE}/view`,
  );
  // O id vai para uma URL que o app abre no navegador.
  assert.equal(linkDoDrive("../../evil", "application/pdf"), "");
  assert.equal(linkDoDrive("abc", "application/pdf"), "");
});

test("arquivos do Drive vao a parte dos anexos enviados", () => {
  const drive = arquivosDoDrive([
    {
      name: "spaces/A/messages/B/attachments/C",
      contentName: "Lista de empresas",
      contentType: "application/vnd.google-apps.spreadsheet",
      source: "DRIVE_FILE",
      driveDataRef: { driveFileId: ID_DRIVE },
    },
    // Anexo enviado: nao e do Drive.
    { name: "x", contentName: "image.png", attachmentDataRef: { resourceName: "r" } },
  ]);
  assert.deepEqual(drive, [
    {
      id: "spaces/A/messages/B/attachments/C",
      nome: "Lista de empresas",
      mime: "application/vnd.google-apps.spreadsheet",
      link: `https://docs.google.com/spreadsheets/d/${ID_DRIVE}/edit`,
    },
  ]);
});
