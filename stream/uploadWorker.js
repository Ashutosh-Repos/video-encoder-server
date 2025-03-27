const { parentPort, workerData } = require("worker_threads");
const chokidar = require("chokidar");
const fs = require("fs/promises");
const cloudinary = require("cloudinary").v2;
const path = require("path");
const { setTimeout } = require("timers/promises");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDNAME,
  api_key: process.env.CLOUDAPIKEY,
  api_secret: process.env.CLOUDSECRET,
});

// Function to upload file to Cloudinary
const uploadToCloudinary = async (filePath, folder) => {
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
    throw new Error(`Failed to upload ${filePath}: ${error.message}`);
  }
};

// Function to delete file after upload
const deleteFile = async (filePath) => {
  try {
    await fs.unlink(filePath);
    return `Deleted: ${filePath}`;
  } catch (error) {
    throw new Error(`Error deleting file ${filePath}: ${error.message}`);
  }
};

// Function to handle batch file uploads
const uploadFilesInBatch = async (filePaths, folder) => {
  const uploadPromises = filePaths.map(async (filePath) => {
    try {
      const uploadUrl = await uploadToCloudinary(filePath, folder);
      await deleteFile(filePath);
      parentPort.postMessage({ success: true, filePath, uploadUrl });
    } catch (error) {
      parentPort.postMessage({
        success: false,
        filePath,
        error: error.message,
      });
    }
  });

  await Promise.all(uploadPromises);
};

// Function to handle file watching and batching uploads
const watchAndHandleFiles = async (uploadDir, folder) => {
  const fileBatch = new Set(); // Track files for batch upload
  const batchSize = 5; // Number of files to upload in each batch

  // Process files when a batch is full or when the upload is complete
  const processBatch = async () => {
    if (fileBatch.size > 0) {
      const filesToUpload = Array.from(fileBatch);
      await uploadFilesInBatch(filesToUpload, folder);
      fileBatch.clear(); // Clear the batch after upload
    }
  };

  // Watch for new `.ts` files in the directory
  const watcher = chokidar.watch(uploadDir, {
    ignored: /(^|[\/\\])\../, // Ignore dotfiles
    persistent: true,
    depth: 1, // Limit depth to just the folder
    awaitWriteFinish: true, // Wait for file to be fully written
    usePolling: true, // Optionally use polling for better support
  });

  watcher.on("add", async (filePath) => {
    if (filePath.endsWith(".ts")) {
      fileBatch.add(filePath);
    } else if (filePath.endsWith(".m3u8")) {
      await processBatch();
      delay(100);
      const uploadUrl = await uploadToCloudinary(filePath, folder);
      parentPort.postMessage({ success: true, filePath, uploadUrl });
    }
    if (fileBatch.size >= batchSize) {
      await processBatch(); // Upload if batch size reached
    }
  });

  watcher.on("error", (error) => {
    parentPort.postMessage({ success: false, error: error.message });
  });

  // Listen for messages to upload the `.m3u8` playlist file
  //   parentPort.on("message", async (message) => {
  //     const { type, filePath, folder } = message;

  //     if (type === "upload-m3u8") {
  //       try {
  //         await processBatch(); // Upload any remaining segments before playlist
  //         const uploadUrl = await uploadToCloudinary(filePath, folder);
  //         parentPort.postMessage({ success: true, filePath, uploadUrl });
  //       } catch (error) {
  //         parentPort.postMessage({
  //           success: false,
  //           filePath,
  //           error: error.message,
  //         });
  //       }
  //     } else if (type === "upload-complete") {
  //       // Ensure any remaining files are uploaded
  //       await processBatch();
  //       parentPort.postMessage({ success: true, message: "Upload complete" });
  //     }
  //   });
};

// Start the worker
watchAndHandleFiles(workerData.uploadDir, workerData.folder);
