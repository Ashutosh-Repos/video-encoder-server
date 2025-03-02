import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { Worker } from "worker_threads";
import { randomUUID } from "crypto";
import path from "path";
import { promisify } from "util";
import { exec, execSync } from "child_process";

const execPromise = promisify(exec);
// Allowed video types
const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/mkv",
  "video/webm",
  "video/avi",
];

const getVideoResolution = async (
  filePath: string
): Promise<{ width: number; height: number }> => {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${filePath}"`
    );

    const metadata = JSON.parse(stdout);
    return {
      width: metadata.streams[0].width,
      height: metadata.streams[0].height,
    };
  } catch (error) {
    throw new Error("Failed to extract video resolution.");
  }
};
// Function to run FFmpeg in a worker thread
const runFFmpegWorker = (
  inputFilePath: string,
  uploadDir: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve("./app/api/up/ffmpegWorker.js"), {
      workerData: { inputFilePath, uploadDir },
    });

    worker.on("message", (message) => {
      if (message.success) {
        resolve();
      } else {
        reject(new Error(message.error));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0)
        reject(new Error(`FFmpeg worker exited with code ${code}`));
    });
  });
};

const runUploadWorker = (
  uploadDir: string,
  cloudFolder: string
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve("./app/api/up/uploadWorker.js"), {
      workerData: { uploadDir, cloudFolder },
    });

    worker.on("message", (message) => {
      if (message.success && message.m3u8Url) {
        resolve(message.m3u8Url);
      } else if (message.error) {
        reject(new Error(message.error));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0)
        reject(new Error(`Upload worker exited with code ${code}`));
    });
  });
};

// Main handler function
export async function POST(req: Request): Promise<Response> {
  const stream = new ReadableStream({
    async start(controller) {
      // Helper function to format SSE messages
      const sendStatus = (id: number, message: string, data: object = {}) => {
        controller.enqueue(
          `id: ${id}\n` +
            `event: status\n` +
            `data: ${JSON.stringify({ message, ...data })}\n\n`
        );
      };

      const folderUUID = randomUUID();
      const date = new Date().toISOString().replace(/[:.-]/g, "");
      const uploadDir = path.join("temp/final", `${folderUUID}_${date}`);
      const evtid = { id: 1 }; // Use a mutable object to track the event id

      let inputFilePath: string | null;

      try {
        sendStatus(evtid.id++, "Reading file...");
        const formData = await req.formData();
        const file = formData.get("file") as File;

        // Validate file input
        if (!file || !ALLOWED_VIDEO_TYPES.includes(file.type)) {
          throw new Error("Invalid file type. Only video files are allowed.");
        }

        const uniqueFilename = `${path.basename(
          file.name,
          path.extname(file.name)
        )}-${randomUUID()}${path.extname(file.name)}`;
        inputFilePath = path.join("temp/uploads", uniqueFilename);
        const arrayBuffer = await file.arrayBuffer();
        await fs.writeFile(inputFilePath, Buffer.from(arrayBuffer));

        sendStatus(evtid.id++, "Checking resolution...");
        const { width, height } = await getVideoResolution(inputFilePath);
        if (Math.min(height, width) < 360) {
          throw new Error(`Video resolution too low: ${width}x${height}`);
        }
        sendStatus(evtid.id++, "Processing the video...");

        // Ensure the upload directory exists
        await fs.mkdir(uploadDir, { recursive: true });

        // Run FFmpeg in a worker thread
        const ffmpegPromise = runFFmpegWorker(inputFilePath, uploadDir);
        console.log("ffmpeg started");
        const uploadPromise = runUploadWorker(uploadDir, folderUUID);
        console.log("uploader started");

        await ffmpegPromise;
        console.log("ffmpeg done");
        const m3u8Url = await uploadPromise;
        console.log(m3u8Url);
        console.log("upload done");

        sendStatus(
          evtid.id++,
          "Video processing completed, uploading playlist...",
          { url: m3u8Url }
        );

        sendStatus(0, "Upload completed!");
      } catch (error) {
        console.error("Error:", error.message);
        sendStatus(-1, "Error", { error: error.message });
      } finally {
        // Clean up
        if (inputFilePath) {
          await fs.rm(inputFilePath, { force: true });
          console.log(`Deleted input file: ${inputFilePath}`);
        }
        await fs.rm(uploadDir, { recursive: true, force: true });
        console.log(`Cleaned up directory: ${uploadDir}`);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
