import fs from "fs";
import os from "os";
import path from "path";
import multer from "multer";
import { resolveFromProjectRoot } from "../utils/paths";

function resolveUploadDirPreference() {
  const fromEnv = process.env.UPLOAD_DIR?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : resolveFromProjectRoot(fromEnv);
  }

  return resolveFromProjectRoot("uploads");
}

function ensureDirectoryExists(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let cachedUploadDir: string | null = null;

function getUploadDir() {
  if (cachedUploadDir) {
    return cachedUploadDir;
  }

  const preferredDir = resolveUploadDirPreference();
  try {
    ensureDirectoryExists(preferredDir);
    cachedUploadDir = preferredDir;
    return cachedUploadDir;
  } catch (error) {
    const fallbackDir = path.join(os.tmpdir(), "uploads");
    ensureDirectoryExists(fallbackDir);
    console.warn(
      `[upload] nao foi possivel usar diretorio "${preferredDir}", usando fallback "${fallbackDir}".`,
      error,
    );
    cachedUploadDir = fallbackDir;
    return cachedUploadDir;
  }
}

function safeFileName(originalName: string) {
  const ext = path.extname(originalName || "").toLowerCase();
  const base = path
    .basename(originalName || "arquivo", ext)
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${base}_${stamp}_${random}${ext}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      cb(null, getUploadDir());
    } catch (error) {
      cb(error as Error, "");
    }
  },
  filename: (_req, file, cb) => cb(null, safeFileName(file.originalname)),
});

const upload = multer({
  storage,
  limits: {
    fileSize: 300 * 1024 * 1024, // 300 MB
  },
});

// Campo esperado no form-data: audioFile
export const uploadAudioMiddleware = upload.single("audioFile");
