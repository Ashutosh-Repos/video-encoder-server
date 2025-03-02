import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { Worker } from "worker_threads";
import { randomUUID } from "crypto";
import path from "path";

// Allowed video types
const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/mkv",
  "video/webm",
  "video/avi",
];

// Function to run FFmpeg in a worker thread
const runFFmpegWorker = (
  inputFilePath: string,
  uploadDir: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.resolve("./app/api/stream/ffmpegWorker.js"),
      {
        workerData: { inputFilePath, uploadDir },
      }
    );

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
        reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
};

// Main handler function
export async function POST(req: Request): Promise<Response> {
  const stream = new ReadableStream({
    async start(controller) {
      const sendStatus = (id: number, message: string, data: object = {}) => {
        controller.enqueue(`${JSON.stringify({ id, message, ...data })}\n\n`);
      };

      const folderUUID = randomUUID();
      const date = new Date().toISOString().replace(/[:.-]/g, "");
      const uploadDir = path.join("temp/final", `${folderUUID}_${date}`);
      const evtid = { id: 1 }; // Use a mutable object to track the event id

      try {
        sendStatus(evtid.id++, "Reading input data...");
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
        const inputFilePath = path.join("temp/uploads", uniqueFilename);
        const arrayBuffer = await file.arrayBuffer();
        await fs.writeFile(inputFilePath, Buffer.from(arrayBuffer));

        sendStatus(evtid.id++, "Processing the video...");

        // Ensure the upload directory exists
        await fs.mkdir(uploadDir, { recursive: true });

        // Set up worker for watching, uploading, and deleting
        const uploadWorker = new Worker("./app/api/stream/uploadWorker.js", {
          workerData: { uploadDir, folder: `hls_videos/${folderUUID}` },
        });

        // Handle worker messages
        uploadWorker.on("message", (message) => {
          if (message?.success) {
            console.log(`Uploaded and deleted: ${message.filePath}`);
          } else {
            console.error(
              `Error with file ${message?.filePath}: ${message?.error}`
            );
          }
        });

        // Run FFmpeg in a worker thread
        await runFFmpegWorker(inputFilePath, uploadDir);

        // Once FFmpeg processing is done, notify the worker to upload the .m3u8 file
        const playlistFilePath = path.join(uploadDir, "index.m3u8");
        // uploadWorker.postMessage({
        //   type: "upload-m3u8",
        //   filePath: playlistFilePath,
        //   folder: `hls_videos/${folderUUID}`,
        // });

        // Notify the worker that all files have been processed
        uploadWorker.postMessage({
          type: "upload-complete",
        });

        sendStatus(
          evtid.id++,
          "Video processing completed, uploading playlist..."
        );

        sendStatus(0, "Upload completed!");
      } catch (error) {
        console.error("Error:", error.message);
        sendStatus(-1, "Error", { error: error.message });
      } finally {
        // Clean up
        try {
          await fs.rm(uploadDir, { recursive: true, force: true });
          console.log(`Cleaned up directory: ${uploadDir}`);
        } catch (cleanupError) {
          console.error(
            `Failed to clean up directory: ${uploadDir}`,
            cleanupError
          );
        }

        setTimeout(() => controller.close(), 500);
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
