import fs from "fs";
import path from "path";
import multer from "multer";
import { resolveFromProjectRoot } from "../utils/paths";

function resolveUploadDir() {
  const fromEnv = process.env.UPLOAD_DIR?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : resolveFromProjectRoot(fromEnv);
  }

  return resolveFromProjectRoot("uploads");
}

const uploadDir = resolveUploadDir();
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
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
  destination: (_req, _file, cb) => cb(null, uploadDir),
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

