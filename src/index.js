const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ytdl = require("ytdl-core");
// Optional fallback: yt-dlp via youtube-dl-exec (more resilient to YouTube changes)
let ytdlp;
try {
  ytdlp = require("youtube-dl-exec");
} catch (_) {
  ytdlp = null; // will use only if available
}
const ffmpeg = require("fluent-ffmpeg");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph } = require("docx");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const Groq = require("groq-sdk");
require("dotenv").config();

// Configure ffmpeg binary path (works on Windows via ffmpeg-static)
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend
app.use(express.static(path.join(__dirname, "../public")));

// Ensure tmp directory exists
const TMP_DIR = path.join(__dirname, "../tmp");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Multer storage for uploaded audio
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TMP_DIR);
  },
  filename: function (req, file, cb) {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || ".wav";
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage });

// Initialize Groq client securely via env var
const groqApiKey = process.env.GROQ_API_KEY;
if (!groqApiKey) {
  console.warn("[WARN] GROQ_API_KEY is missing. Set it in server/.env");
}
const groq = new Groq({ apiKey: groqApiKey });

// Utility: Convert any audio/video file to mono 16k WAV
function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vn",
        "-sn",
        "-y",
        "-ac 1", // mono
        "-ar 16000", // 16kHz
        "-f wav",
        "-acodec pcm_s16le"
      ])
      .save(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err));
  });
}

// Utility: Download YouTube audio/video. Prefer ytdl-core, fallback to yt-dlp if available.
async function downloadYoutube(url, id) {
  if (!ytdl.validateURL(url)) {
    throw new Error("Invalid YouTube URL");
  }

  // Try ytdl-core first
  const mp4Path = path.join(TMP_DIR, `${id}.mp4`);
  try {
    // Preflight to catch decipher issues early
    await ytdl.getInfo(url);

    await new Promise((resolve, reject) => {
      const stream = ytdl(url, { quality: "highestaudio" });
      const writeStream = fs.createWriteStream(mp4Path);
      stream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      stream.on("error", reject);
    });
    return mp4Path;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const decipherIssue = /Could not extract functions/i.test(msg);
    if (!decipherIssue) {
      // If it failed for another reason and we don't have a fallback, bubble up
      if (!ytdlp) throw new Error(`YouTube download failed: ${msg}`);
    }

    // Fallback to yt-dlp (if installed)
    if (ytdlp) {
      const outTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
      try {
        await ytdlp(url, {
          output: outTemplate,
          extractAudio: true,
          audioFormat: "mp3",
          audioQuality: 0,
          format: "bestaudio/best",
          noCheckCertificates: true,
          preferFreeFormats: true,
          // reduce noise
          noWarnings: true,
        });
        // Find created file (mp3/m4a/webm)
        const files = fs.readdirSync(TMP_DIR);
        const found = files.find((f) => f.startsWith(`${id}.`));
        if (!found) throw new Error("yt-dlp did not produce an output file");
        return path.join(TMP_DIR, found);
      } catch (e) {
        throw new Error(`yt-dlp fallback failed: ${(e && e.message) || String(e)}`);
      }
    }

    // If no fallback available, instruct user to upgrade ytdl-core
    throw new Error(
      "ytdl-core failed to download (signature change). Install/upgrade ytdl-core or add youtube-dl-exec (yt-dlp) as fallback."
    );
  }
}

// Utility: Call Groq Whisper transcription
async function transcribeWithGroq(wavPath) {
  const fileStream = fs.createReadStream(wavPath);
  const result = await groq.audio.transcriptions.create({
    file: fileStream,
    model: "whisper-large-v3-turbo",
    prompt: "Transcribe clearly with correct spelling.",
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
    language: "en",
    temperature: 0.0
  });
  return result;
}

// Cleanup helper
function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn("Failed to remove", filePath, e.message);
  }
}

// POST /api/transcribe — handles either YouTube URL or file upload
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const { youtubeUrl } = req.body || {};
  const uploadedFilePath = req.file ? req.file.path : null;

  let workingInputPath = null;
  let mp4Path = null;
  let wavPath = null;
  const id = uuidv4();
  try {
    if (youtubeUrl) {
      // Download video/audio from YouTube
      workingInputPath = await downloadYoutube(youtubeUrl, id);
    } else if (uploadedFilePath) {
      workingInputPath = uploadedFilePath;
    } else {
      return res.status(400).json({ error: "Provide a YouTube URL or upload an audio file." });
    }

    // Convert to WAV 16k mono
    wavPath = path.join(TMP_DIR, `${id}.wav`);
    await convertToWav(workingInputPath, wavPath);

    // Transcribe via Groq Whisper
    const transcription = await transcribeWithGroq(wavPath);

    const text = transcription?.text || "";
    res.json({
      id,
      text,
      transcription
    });
  } catch (err) {
    console.error("/api/transcribe error:", err);
    const details = err?.message || String(err);
    const hint = /ytdl-core failed/.test(details)
      ? "Try: npm i ytdl-core@latest. If it persists, install yt-dlp fallback: npm i youtube-dl-exec and rerun."
      : undefined;
    res.status(500).json({ error: "Transcription failed", details, hint });
  } finally {
    // Cleanup tmp files
    safeUnlink(mp4Path);
    safeUnlink(wavPath);
    safeUnlink(uploadedFilePath);
  }
});

// POST /api/qa — ask questions based on transcript
app.post("/api/qa", async (req, res) => {
  try {
    const { question, transcript } = req.body || {};
    if (!question || !transcript) {
      return res.status(400).json({ error: "Missing 'question' or 'transcript' in body." });
    }

    // Build prompt grounding on transcript
    const messages = [
      {
        role: "system",
        content: "You are a professional teaching assistant. Answer strictly based on the provided transcript. If the transcript does not contain the answer, say: 'I don't know based on the transcript.' Produce a polished, executive-style response using GitHub-flavored markdown with a clear structure:\n\n# Title\n## Executive Summary\n- 3–6 bullets\n\n## Key Insights\n- Bulleted points\n\n## Actionable Recommendations\n1. Numbered steps\n\n## Notes\n- Assumptions, constraints, or caveats\n\nTone: concise, professional, and objective. No chit-chat."
      },
      {
        role: "user",
        content: `Transcript:\n${transcript}\n\nQuestion: ${question}`
      }
    ];

    const completion = await groq.chat.completions.create({
      messages,
      model: "openai/gpt-oss-20b"
    });

    const answer = completion?.choices?.[0]?.message?.content || "";
    res.json({ answer });
  } catch (err) {
    console.error("/api/qa error:", err);
    res.status(500).json({ error: "QA failed", details: err?.message || String(err) });
  }
});

// POST /api/export — export text to various formats
app.post("/api/export", async (req, res) => {
  try {
    const { type, content, filename } = req.body || {};
    if (!type || !content) {
      return res.status(400).json({ error: "Missing 'type' or 'content'" });
    }
    const base = filename || "export";
    if (type === "txt") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=${base}.txt`);
      return res.send(content);
    }
    if (type === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename=${base}.json`);
      return res.send(JSON.stringify({ content }));
    }
    if (type === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=${base}.csv`);
      const lines = content.split(/\r?\n/).map((l) => `"${l.replace(/"/g, '""')}"`);
      return res.send(lines.join("\n"));
    }
    if (type === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${base}.pdf`);
      const doc = new PDFDocument({ margin: 40 });
      doc.pipe(res);
      doc.fontSize(16).text(base, { underline: true });
      doc.moveDown();
      doc.fontSize(12).text(content);
      doc.end();
      return;
    }
    if (type === "docx") {
      const paragraphs = content.split(/\r?\n/).map((line) => new Paragraph(line));
      const docx = new Document({ sections: [{ properties: {}, children: paragraphs }] });
      const buffer = await Packer.toBuffer(docx);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename=${base}.docx`);
      return res.send(buffer);
    }
    return res.status(400).json({ error: "Unsupported type" });
  } catch (err) {
    console.error("/api/export error:", err);
    res.status(500).json({ error: "Export failed", details: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
