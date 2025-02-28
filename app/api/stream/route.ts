import { NextResponse } from "next/server";
import workerpool from "workerpool";
import * as fs from "node:fs"; // Standard fs for streams like createWriteStream
import { promises as fsPromises } from "node:fs"; // fs.promises for async file operations
import { exec } from "child_process"; // Import exec from child_process
import { promisify } from "util"; // For promisifying exec
import { v2 as cloudinary } from "cloudinary";
import { randomUUID } from "crypto";
import path from "path";
import { pipeline } from "stream/promises";
import chokidar from "chokidar"; // To watch for new .ts files in the directory
import { Readable } from "stream"; // Use Node.js Readable stream

const execPromise = promisify(exec); // Promisify exec for async use
const pool = workerpool.pool("./worker-video.ts");

const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/mkv",
  "video/webm",
  "video/avi",
];

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDNAME,
  api_key: process.env.CLOUDAPIKEY,
  api_secret: process.env.CLOUDSECRET,
});

// Function to upload single segment to Cloudinary and then delete
const uploadSegmentToCloudinary = async (filePath: string, folder: string) => {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "raw",
      folder,
      use_filename: true,
      unique_filename: false,
      overwrite: true,
    });
    console.log("uploading segment", filePath);
    await fsPromises.unlink(filePath); // Delete file after successful upload
    return result;
  } catch (error) {
    console.error(`Cloudinary upload failed for ${filePath}:`, error);
    throw new Error(`Failed to upload segment: ${error.message}`);
  }
};

export async function POST(req: Request): Promise<Response> {
  console.log("hello");
  const stream = new ReadableStream({
    async start(controller) {
      const sendStatus = (id: number, message: string, data: object = {}) => {
        controller.enqueue(`${JSON.stringify({ id, message, ...data })}\n\n`);
      };

      const folderUUID = randomUUID();
      const date = new Date();
      const datestr = date
        .toLocaleString("en-GB", { hour12: false })
        .replace(/[ ,:]/g, "");
      const uploadDir = path.join("temp/final", folderUUID + datestr);

      try {
        let evtid = 1;
        sendStatus(evtid++, "Reading...");

        const formData = await req.formData();
        const file = formData.get("file") as File;
        if (!file) throw new Error("No file uploaded.");

        if (!ALLOWED_VIDEO_TYPES.includes(file.type)) {
          throw new Error("Invalid file type. Only video files are allowed.");
        }

        const uniqueFilename = `${path.basename(
          file.name,
          path.extname(file.name)
        )}-${randomUUID()}${path.extname(file.name)}`;
        const inputFilePath = `./temp/uploads/${uniqueFilename}`;

        // Convert web ReadableStream to Node.js Readable stream manually
        const nodeReadableStream = new Readable({
          read() {
            file
              .stream()
              .getReader()
              .read()
              .then(({ value, done }) => {
                if (done) {
                  this.push(null);
                } else {
                  this.push(Buffer.from(value));
                }
              });
          },
        });

        // Stream video file to disk using the Node.js stream
        const writeStream = fs.createWriteStream(inputFilePath);
        await pipeline(nodeReadableStream, writeStream);

        sendStatus(evtid++, "Checking resolution...");

        const getVideoResolution = async (
          filePath: string
        ): Promise<{ width: number; height: number }> => {
          const { stdout } = await execPromise(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${filePath}"`
          );
          const metadata = JSON.parse(stdout);
          return {
            width: metadata.streams[0].width,
            height: metadata.streams[0].height,
          };
        };

        const { width, height } = await getVideoResolution(inputFilePath);
        if (Math.min(height, width) < 360) {
          throw new Error(`Video resolution too low: ${width}x${height}`);
        }

        sendStatus(evtid++, "Processing...");

        await fsPromises.mkdir(uploadDir, { recursive: true });

        const cloudinaryFolder = `hls_videos/${folderUUID}`;

        // Watch for new .ts files and upload them immediately
        const watcher = chokidar.watch(`${uploadDir}/*.ts`, {
          persistent: true,
        });
        watcher.on("add", async (filePath) => {
          try {
            await uploadSegmentToCloudinary(filePath, cloudinaryFolder);
            sendStatus(evtid++, `Uploaded segment: ${path.basename(filePath)}`);
          } catch (error) {
            sendStatus(-1, `Error uploading segment: ${error.message}`);
          }
        });

        // Offload processing to workerpool
        pool
          .exec("processVideo", [inputFilePath, uploadDir])
          .then(async (result) => {
            sendStatus(evtid++, result.message);

            // Wait for FFmpeg to complete and upload M3U8 file
            const playlistFile = `${uploadDir}/index.m3u8`;
            const uploadedPlaylist = await cloudinary.uploader.upload(
              playlistFile,
              {
                resource_type: "raw",
                folder: cloudinaryFolder,
                use_filename: true,
                unique_filename: false,
                overwrite: true,
              }
            );

            sendStatus(evtid++, "Upload completed!", {
              url: uploadedPlaylist.secure_url,
            });
          })
          .catch((error) => {
            sendStatus(-1, "Error", {
              err: `Worker pool error: ${(error as Error).message}`,
            });
          })
          .finally(async () => {
            await watcher.close(); // Stop watching the directory
            await fsPromises.rm(uploadDir, { recursive: true, force: true }); // Cleanup
            await fsPromises.unlink(inputFilePath); // Cleanup original file
            setTimeout(() => controller.close(), 500);
          });
      } catch (error) {
        sendStatus(-1, "Error", {
          err:
            (error as Error).message ||
            "Something went wrong, please upload again",
        });
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
