import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { exec, execSync } from "child_process";
import { v2 as cloudinary } from "cloudinary";
import { promisify } from "util";
import { randomUUID } from "crypto";
import path from "path";

const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/mkv",
  "video/webm",
  "video/avi",
];
const execPromise = promisify(exec);

//  Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDNAME,
  api_key: process.env.CLOUDAPIKEY,
  api_secret: process.env.CLOUDSECRET,
});

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
//  Function to Upload a File to Cloudinary
const uploadToCloudinary = async (
  filePath: string,
  folder: string
): Promise<string> => {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "raw",
      folder,
      use_filename: true,
      unique_filename: false,
      overwrite: true,
    });
    return result.secure_url;
  } catch (error) {
    console.error(`Cloudinary upload failed: ${error}`);
    throw new Error("Failed to upload to Cloudinary");
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: Request): Promise<Response> {
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
      const uploadDir = path.join("temp/final", folderUUID + date);
      try {
        let evtid = 1;
        sendStatus(evtid, "Reading...");
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
        //file uploading on server from buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);
        const inputFilePath = `./temp/uploads/${uniqueFilename}`;
        await fs.writeFile(inputFilePath, buffer);

        try {
          await delay(500);
          sendStatus(evtid++, "Checking resolution...");

          const { width, height } = await getVideoResolution(inputFilePath);
          if (Math.min(height, width) < 360) {
            throw new Error(`Video resolution too low: ${width}x${height}`);
          }

          await delay(500);
          sendStatus(evtid++, "Processing...");

          await fs.mkdir(uploadDir, { recursive: true });

          //  Run FFmpeg to generate HLS files
          const hlsCommand = `ffmpeg -i "${inputFilePath}" \
          -vf "scale=w=iw*min(1920/iw\\,1080/ih):h=ih*min(1920/iw\\,1080/ih),pad=1920:1080:(1920-iw*min(1920/iw\\,1080/ih))/2:(1080-ih*min(1920/iw\\,1080/ih))/2" \
          -c:v libx264 -preset veryfast -crf 23 \
          -g 48 -keyint_min 48 -sc_threshold 0 -hls_time 4 -hls_playlist_type vod \
          -c:a aac -b:a 128k -hls_segment_filename "${uploadDir}/%03d.ts" \
          "${uploadDir}/index.m3u8"`;

          await execPromise(hlsCommand);
          await delay(500);
          sendStatus(evtid++, "Uploading to Cloud...");

          //  Upload the .m3u8 file and all .ts files
          const files = await fs.readdir(uploadDir);
          const cloudinaryFolder = `hls_videos/${folderUUID}`;
          let playlistUrl = "";

          for (const file of files) {
            const filePath = path.join(uploadDir, file);
            const cloudinaryUrl = await uploadToCloudinary(
              filePath,
              cloudinaryFolder
            );
            if (file.endsWith(".m3u8")) {
              console.log(cloudinaryUrl);
              playlistUrl = cloudinaryUrl;
            }
          }
          await delay(500);
          sendStatus(0, "Upload completed!", { url: playlistUrl });

          // Cleanup: Delete local files
        } catch (e) {
          await delay(500);
          sendStatus(-1, "Error", {
            err:
              (e as Error)?.message ||
              "something went wrong , please upload again",
          });
        } finally {
          await fs.unlink(inputFilePath);
        }
      } catch (error) {
        await delay(500);
        sendStatus(-1, "Error", {
          err:
            (error as Error)?.message ||
            "something went wrong , please upload again",
        });
      } finally {
        await fs.rm(uploadDir, { recursive: true, force: true });
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
