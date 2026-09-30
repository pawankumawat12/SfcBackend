const multer = require("multer");
const path = require("path");

// Allowed extensions whitelist
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
]);

const ALLOWED_DOC_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".txt",
  ".csv",
  ".zip",
]);

// Multer memory storage: files are kept as in-memory buffers (file.buffer)
// and never written to local disk.
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/jpg",
  ];
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (allowedMimeTypes.includes(file.mimetype) && ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, JPEG, PNG, and WEBP image files are allowed."));
  }
};

const chatFileFilter = (req, file, cb) => {
  const allowedImageMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/jpg",
    "image/gif",
  ];
  const allowedDocMimeTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/x-zip-compressed",
  ];

  const ext = path.extname(file.originalname || "").toLowerCase();
  const isImage =
    allowedImageMimeTypes.includes(file.mimetype) &&
    ALLOWED_IMAGE_EXTENSIONS.has(ext);
  const isDoc =
    allowedDocMimeTypes.includes(file.mimetype) &&
    ALLOWED_DOC_EXTENSIONS.has(ext);

  if (isImage || isDoc) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Supported file formats: JPG, PNG, WEBP, GIF, PDF, DOC, DOCX, XLS, XLSX, TXT, CSV, ZIP"
      )
    );
  }
};

const uploadImage = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max
  },
});

const uploadChatAttachment = multer({
  storage,
  fileFilter: chatFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max
  },
});

const uploadReelMedia = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (file.fieldname === "video") {
      const allowedVideoExts = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
      if (file.mimetype?.startsWith("video/") || allowedVideoExts.has(ext)) {
        return cb(null, true);
      }
      return cb(new Error("Only video files (MP4, WEBM, MOV) are allowed."));
    }
    // thumbnail
    const allowedImgExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
    if (file.mimetype?.startsWith("image/") || allowedImgExts.has(ext)) {
      return cb(null, true);
    }
    return cb(new Error("Only image files (JPG, PNG, WEBP) are allowed for thumbnails."));
  },
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB max for reel videos
  },
});

module.exports = {
  uploadImage,
  uploadChatAttachment,
  uploadReelMedia,
};
