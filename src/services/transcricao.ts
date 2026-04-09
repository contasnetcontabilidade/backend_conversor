﻿import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { nodewhisper } from "nodejs-whisper";
import { AppError, getErrorMessage } from "../lib/errors";
import { resolveFromProjectRoot } from "../utils/paths";

const DEFAULT_AUDIO_FILE =
  process.env.DEFAULT_AUDIO_FILE ?? "audio_reuniao.WAV";
const DEFAULT_MODEL_NAME = process.env.WHISPER_MODEL ?? "base";

const MODELS_LIST = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v1",
  "large",
  "large-v3-turbo",
] as const;

type WhisperModel = (typeof MODELS_LIST)[number];

export type TranscricaoInput = {
  audioPath?: string;
  modelName?: string;
  autoDownloadModelName?: string;
  withCuda?: boolean;
};

export type TranscricaoResultado = {
  audioPath: string;
  srtPath: string;
  transcript: string;
};

let transcriptionQueue: Promise<void> = Promise.resolve();

// Garante que apenas uma transcrição rode por vez.
// Isso evita conflitos porque o pacote nodejs-whisper altera o diretório atual.
function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = transcriptionQueue.then(operation, operation);
  transcriptionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function resolveAudioPath(inputPath?: string): string {
  const candidate = inputPath?.trim() || DEFAULT_AUDIO_FILE;
  return path.isAbsolute(candidate)
    ? candidate
    : resolveFromProjectRoot(candidate);
}

function resolveWhisperCppDir() {
  try {
    const packageJsonPath = require.resolve("nodejs-whisper/package.json");
    return path.resolve(path.dirname(packageJsonPath), "cpp", "whisper.cpp");
  } catch {
    // Fallback for environments where require.resolve cannot locate the package.
    return resolveFromProjectRoot(
      "node_modules",
      "nodejs-whisper",
      "cpp",
      "whisper.cpp",
    );
  }
}

function resolveModelName(inputModel?: string): WhisperModel {
  const candidate = (inputModel?.trim() || DEFAULT_MODEL_NAME) as WhisperModel;

  if (!MODELS_LIST.includes(candidate)) {
    throw new AppError({
      statusCode: 400,
      code: "INVALID_MODEL",
      message: `Modelo invalido: ${candidate}`,
      details: { supportedModels: MODELS_LIST },
    });
  }

  return candidate;
}

function hasFfmpegInPath() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function findWingetFfmpegBinDir() {
  if (process.platform !== "win32") {
    return null;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  const packagesRoot = path.join(
    localAppData,
    "Microsoft",
    "WinGet",
    "Packages",
  );
  if (!fs.existsSync(packagesRoot)) {
    return null;
  }

  const packageDirs = fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("Gyan.FFmpeg"),
    )
    .map((entry) => path.join(packagesRoot, entry.name));

  for (const packageDir of packageDirs) {
    const buildDirs = fs
      .readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    for (const buildDir of buildDirs) {
      const binDir = path.join(packageDir, buildDir.name, "bin");
      const ffmpegExe = path.join(binDir, "ffmpeg.exe");
      if (fs.existsSync(ffmpegExe)) {
        return binDir;
      }
    }
  }

  return null;
}

function ensureFfmpegInPath() {
  if (hasFfmpegInPath()) {
    return;
  }

  const ffmpegBinDir = findWingetFfmpegBinDir();
  if (!ffmpegBinDir) {
    throw new AppError({
      statusCode: 503,
      code: "FFMPEG_NOT_AVAILABLE",
      message: "ffmpeg nao encontrado no PATH do processo.",
    });
  }

  const pathList = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  if (!pathList.includes(ffmpegBinDir)) {
    process.env.PATH = [...pathList, ffmpegBinDir].join(path.delimiter);
  }

  if (!hasFfmpegInPath()) {
    throw new AppError({
      statusCode: 503,
      code: "FFMPEG_NOT_EXECUTABLE",
      message: `ffmpeg localizado em ${ffmpegBinDir}, mas nao foi possivel executar.`,
    });
  }
}

function normalizeTranscriptionError(
  error: unknown,
  audioPath: string,
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = getErrorMessage(error);

  if (/audio file not found|no such file|enoent/i.test(message)) {
    return new AppError({
      statusCode: 404,
      code: "AUDIO_NOT_FOUND",
      message: `Arquivo de audio nao encontrado: ${audioPath}`,
      details: { cause: message },
    });
  }

  if (
    /ffmpeg/i.test(message) &&
    /not recognized|nao.*reconhecido|not found|failed/i.test(message)
  ) {
    return new AppError({
      statusCode: 503,
      code: "FFMPEG_ERROR",
      message: "Falha ao executar ffmpeg para conversao do audio.",
      details: { cause: message },
    });
  }

  if (
    /cmake/i.test(message) &&
    /not recognized|nao.*reconhecido|failed/i.test(message)
  ) {
    return new AppError({
      statusCode: 503,
      code: "CMAKE_NOT_AVAILABLE",
      message: "CMake nao encontrado para build do whisper.cpp.",
      details: { cause: message },
    });
  }

  return new AppError({
    statusCode: 500,
    code: "TRANSCRICAO_FALHOU",
    message: "Falha interna ao transcrever o audio.",
    details: { cause: message },
  });
}

export async function transcreverAudio(
  input: TranscricaoInput = {},
): Promise<TranscricaoResultado> {
  // 1) Resolve caminho e modelo.
  const audioPath = resolveAudioPath(input.audioPath);
  const modelName = resolveModelName(input.modelName);
  const autoDownloadModelName = resolveModelName(
    input.autoDownloadModelName ?? modelName,
  );
  const withCuda = Boolean(input.withCuda);

  if (!fs.existsSync(audioPath)) {
    throw new AppError({
      statusCode: 404,
      code: "AUDIO_NOT_FOUND",
      message: `Arquivo de audio nao encontrado: ${audioPath}`,
    });
  }

  // 2) Roda a transcrição de forma exclusiva e segura.
  return runExclusive(async () => {
    const originalCwd = process.cwd();

    try {
      // 3) Confere ffmpeg e executa whisper.
      ensureFfmpegInPath();

      const transcript = await nodewhisper(audioPath, {
        modelName,
        autoDownloadModelName,
        removeWavFileAfterTranscription: false,
        withCuda,
        logger: console,
        whisperOptions: {
          outputInCsv: false,
          outputInJson: false,
          outputInJsonFull: false,
          outputInLrc: false,
          outputInSrt: true,
          outputInText: false,
          outputInVtt: false,
          outputInWords: false,
          translateToEnglish: false,
          wordTimestamps: false,
          timestamps_length: 20,
          splitOnWord: false,
        },
      });

      const parsedAudioPath = path.parse(audioPath);
      const audioDir = parsedAudioPath.dir;
      const audioName = parsedAudioPath.name;
      const audioBase = parsedAudioPath.base;

      const whisperCppDir = resolveWhisperCppDir();

      const candidates = [
        `${audioPath}.srt`,
        `${audioPath}.wav.srt`,
        path.join(audioDir, `${audioName}.srt`),
        path.join(audioDir, `${audioName}.wav.srt`),
        path.join(whisperCppDir, `${audioName}.srt`),
        path.join(whisperCppDir, `${audioName}.wav.srt`),
        path.join(whisperCppDir, `${audioBase}.srt`),
        path.join(whisperCppDir, `${audioBase}.wav.srt`),
      ];

      let srtPath = candidates.find((p) => fs.existsSync(p));

      // Busca na mesma pasta por qualquer arquivo .srt que contenha o nome do arquivo original
      if (!srtPath) {
        try {
          const filesInDir = fs.readdirSync(audioDir);
          const srtFile = filesInDir.find(
            (f) => f.includes(audioName) && f.endsWith(".srt"),
          );
          if (srtFile) {
            srtPath = path.join(audioDir, srtFile);
          }
        } catch {
          // ignora falha de leitura e segue para a validação final
        }
      }

      if (!srtPath || !fs.existsSync(srtPath)) {
        throw new AppError({
          statusCode: 500,
          code: "SRT_NOT_GENERATED",
          message: "Transcricao finalizada, mas arquivo .srt nao foi gerado.",
        });
      }

      // 4) Retorna os caminhos principais e o texto transcrito.
      return {
        audioPath,
        srtPath,
        transcript: String(transcript ?? ""),
      };
    } catch (error) {
      throw normalizeTranscriptionError(error, audioPath);
    } finally {
      process.chdir(originalCwd);
    }
  });
}
