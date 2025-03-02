const { parentPort, workerData } = require("worker_threads");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

// Run FFmpeg to generate HLS segments
const runFFmpeg = async (inputFilePath, uploadDir) => {
  const hlsCommand = `ffmpeg -i "${inputFilePath}" \
    -vf "scale=w=iw*min(1920/iw\\,1080/ih):h=ih*min(1920/iw\\,1080/ih),pad=1920:1080:(1920-iw*min(1920/iw\\,1080/ih))/2:(1080-ih*min(1920/iw\\,1080/ih))/2" \
    -c:v libx264 -preset veryfast -crf 23 \
    -g 48 -keyint_min 48 -sc_threshold 0 -hls_time 4 -hls_playlist_type vod \
    -c:a aac -b:a 128k -hls_segment_filename "${uploadDir}/%03d.ts" \
    "${uploadDir}/index.m3u8"`;

  await execAsync(hlsCommand);
};

// Main FFmpeg worker logic
(async () => {
  try {
    const { inputFilePath, uploadDir } = workerData;

    // Run FFmpeg to generate .ts segments and the .m3u8 file
    await runFFmpeg(inputFilePath, uploadDir);

    // Notify parent that processing is complete
    parentPort.postMessage({
      success: true,
      message: "FFmpeg processing completed",
    });
  } catch (error) {
    parentPort.postMessage({ success: false, error: error.message });
  }
})();
