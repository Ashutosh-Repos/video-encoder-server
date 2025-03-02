const { parentPort, workerData } = require("worker_threads");
const chokidar = require("chokidar");
const cloudinary = require("cloudinary").v2;
const fs = require("fs/promises");
const path = require("path");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDNAME,
  api_key: process.env.CLOUDAPIKEY,
  api_secret: process.env.CLOUDSECRET,
});

// Upload file to Cloudinary
const uploadToCloudinary = async (filePath, folder) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      filePath,
      {
        resource_type: "raw",
        folder,
        use_filename: true,
        unique_filename: false,
        overwrite: true,
      },
      (error, result) => {
        if (error) {
          reject(
            new Error(
              `Cloudinary upload error for ${filePath}: ${error.message}`
            )
          );
        } else {
          resolve(result.url);
        }
      }
    );
  });
};

// Watch the folder for .ts and .m3u8 files and upload them to Cloudinary
const watchAndUpload = (uploadDir, cloudFolder) => {
  return new Promise((resolve, reject) => {
    let m3u8Uploaded = false;
    const uploadedSegments = new Set();

    const watcher = chokidar.watch(`${uploadDir}`, { persistent: true });

    watcher.on("add", async (filePath) => {
      const ext = path.extname(filePath);

      // Upload .ts segments as they are generated
      if (ext === ".ts" && !uploadedSegments.has(filePath)) {
        try {
          const tsFile = path.basename(filePath);
          parentPort.postMessage({
            success: true,
            message: `Processing ${tsFile}...`,
          });

          // Upload segment to Cloudinary
          await uploadToCloudinary(filePath, cloudFolder);
          uploadedSegments.add(filePath);

          // Remove the .ts file after successful upload
          await fs.rm(filePath);
          parentPort.postMessage({
            success: true,
            message: `Uploaded and removed ${tsFile}`,
          });
        } catch (error) {
          parentPort.postMessage({
            success: false,
            error: `Failed to process ${filePath}: ${error.message}`,
          });
        }
      }

      // Upload the .m3u8 file after all .ts files are uploaded
      if (ext === ".m3u8" && !m3u8Uploaded) {
        try {
          const m3u8File = path.basename(filePath);
          parentPort.postMessage({
            success: true,
            message: `Processing ${m3u8File}...`,
          });

          // Upload the .m3u8 file
          const m3u8Url = await uploadToCloudinary(filePath, cloudFolder);
          m3u8Uploaded = true;

          // Remove the .m3u8 file after successful upload
          await fs.rm(filePath);
          watcher.close(); // Stop watching once the .m3u8 file is uploaded

          parentPort.postMessage({
            success: true,
            message: `Uploaded and removed ${m3u8File}`,
          });
          resolve(m3u8Url);
        } catch (error) {
          parentPort.postMessage({
            success: false,
            error: `Failed to upload ${filePath}: ${error.message}`,
          });
          reject(error);
        }
      }
    });

    watcher.on("error", (error) => {
      reject(new Error(`Chokidar watcher error: ${error.message}`));
    });

    watcher.on("ready", () => {
      parentPort.postMessage({
        success: true,
        message: `Watcher is ready and monitoring directory: ${uploadDir}`,
      });
    });
  });
};

// Main upload worker logic
(async () => {
  try {
    const { uploadDir, cloudFolder } = workerData;

    // Send message indicating start of processing
    parentPort.postMessage({
      success: true,
      message: `Starting to watch directory: ${uploadDir}`,
    });

    // Start watching the directory and uploading files
    const m3u8Url = await watchAndUpload(uploadDir, cloudFolder);

    // Notify parent with the final m3u8 URL
    parentPort.postMessage({
      success: true,
      m3u8Url,
      message: "All files processed successfully.",
    });
  } catch (error) {
    parentPort.postMessage({
      success: false,
      error: `Worker error: ${error.message}`,
    });
  }
})();
