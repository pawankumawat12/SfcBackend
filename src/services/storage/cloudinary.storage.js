const { Readable } = require("stream");
const path = require("path");
const fs = require("fs");
const cloudinary = require("../../../config/cloudinary");

function extractPublicIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const cleanUrl = url.split("?")[0].split("#")[0];
    // Match /upload/(optional transforms/)(optional v12345/)(public_id.ext)
    const uploadIndex = cleanUrl.indexOf("/upload/");
    if (uploadIndex === -1) return null;

    let postUpload = cleanUrl.substring(uploadIndex + "/upload/".length);

    // Strip version prefix if present, e.g. "v1725789123/"
    postUpload = postUpload.replace(/^v\d+\//, "");

    // Strip file extension
    const lastDot = postUpload.lastIndexOf(".");
    if (lastDot > 0) {
      postUpload = postUpload.substring(0, lastDot);
    }

    return decodeURIComponent(postUpload);
  } catch (err) {
    console.warn(
      "[CloudinaryStorage] Failed to extract public_id from URL:",
      err.message
    );
    return null;
  }
}

function uploadFile(file, options = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !file.buffer) {
      return reject(new Error("File buffer is required for upload"));
    }

    const folderName = options.folder ? `sfc/${options.folder}` : "sfc/general";
    const resourceType = options.resourceType || "auto";

    const uploadOptions = {
      folder: folderName,
      resource_type: resourceType,
      use_filename: false,
      unique_filename: true,
      overwrite: false,
    };

    if (options.public_id) {
      uploadOptions.public_id = options.public_id;
    }

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error("Cloudinary upload error:", error);
          return reject(error);
        }

      resolve({
        url: result.secure_url || result.url,
        key: result.public_id,
        provider: "cloudinary",
        format: result.format,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
      });
    });

    Readable.from(file.buffer).pipe(stream);
    });
}

async function deleteFile(keyOrUrl, options = {}) {
  if (!keyOrUrl || typeof keyOrUrl !== "string") {
    return { success: false, message: "No key or URL provided" };
  }

  const trimmed = keyOrUrl.trim();
  if (!trimmed) {
    return { success: false, message: "Empty key or URL" };
  }

  // Backward compatibility: If the asset is a legacy local file in /uploads/
  if (trimmed.startsWith("/uploads/") || trimmed.startsWith("uploads/")) {
    try {
      const relative = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
      const localFilePath = path.join(__dirname, "../../../", relative);
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
        return { success: true, result: "local_deleted" };
      }
      return { success: true, result: "local_not_found" };
    } catch (localErr) {
      console.warn(
        "[CloudinaryStorage] Could not delete legacy local file:",
        localErr.message
      );
      return { success: false, message: localErr.message };
    }
  }

  // Resolve Cloudinary public_id
  let publicId = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    publicId = extractPublicIdFromUrl(trimmed);
  }

  if (!publicId) {
    return {
      success: false,
      message: "Could not resolve Cloudinary public_id",
    };
  }

  try {
    const resourceType = options.resourceType || "image";
    const res = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });

    const isOk = res.result === "ok" || res.result === "not found";
    return { success: isOk, result: res.result };
  } catch (err) {
    console.error(
      `[CloudinaryStorage] Delete error for public_id "${publicId}":`,
      err.message
    );
    return { success: false, message: err.message };
  }
}

module.exports = {
  uploadFile,
  deleteFile,
  extractPublicIdFromUrl,
};
