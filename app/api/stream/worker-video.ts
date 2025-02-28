import { exec } from "child_process";
import { promisify } from "util";
import workerpool from "workerpool";
import fs from "fs/promises";

const execPromise = promisify(exec);

const processVideo = async (inputFilePath: string, outputDir: string) => {
  try {
    const hlsCommand = `ffmpeg -i "${inputFilePath}" \
      -vf "scale=w=iw*min(1920/iw\\,1080/ih):h=ih*min(1920/iw\\,1080/ih),pad=1920:1080:(1920-iw*min(1920/iw\\,1080/ih))/2:(1080-ih*min(1920/iw\\,1080/ih))/2" \
      -c:v libx264 -preset veryfast -crf 23 \
      -g 48 -keyint_min 48 -sc_threshold 0 -hls_time 4 -hls_playlist_type vod \
      -c:a aac -b:a 128k -hls_segment_filename "${outputDir}/%03d.ts" \
      "${outputDir}/index.m3u8"`;

    await execPromise(hlsCommand);
    return { status: "success", message: "Processing completed", outputDir };
  } catch (error) {
    throw new Error(`FFmpeg processing failed: ${(error as Error).message}`);
  }
};

// Register the worker function with workerpool
workerpool.worker({
  processVideo,
});
