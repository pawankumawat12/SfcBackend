const {
  getActiveReels,
  getAllReelsAdmin,
  getReelById,
  createReel,
  updateReel,
  deleteReel,
  toggleReelStatus,
  reorderReels,
} = require("./reels.model");
const {
  uploadFile,
  deleteFile,
} = require("../../services/storage/storage.service");

function detectPlatform(url = "") {
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return "youtube";
}

function extractYouTubeId(url = "") {
  if (!url) return null;
  const match = url.match(/(?:shorts\/|v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function resolveThumbnail(videoUrl, platform, customThumbnail) {
  if (customThumbnail && customThumbnail.trim()) {
    return customThumbnail.trim();
  }
  if (platform === "youtube") {
    const ytId = extractYouTubeId(videoUrl);
    if (ytId) {
      return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
    }
  }
  return null;
}

// Public: Get all active reels for frontend slider
async function getPublicReelsHandler(req, res) {
  try {
    const reels = await getActiveReels();
    return res.status(200).json({
      success: true,
      message: "Active reels fetched successfully",
      data: reels,
    });
  } catch (error) {
    console.error("Get active reels error:", error);
    return res.status(500).json({ success: false, message: "Server error fetching reels" });
  }
}

// Admin: Get all reels
async function getAdminReelsHandler(req, res) {
  try {
    const reels = await getAllReelsAdmin();
    return res.status(200).json({
      success: true,
      message: "Admin reels fetched successfully",
      data: reels,
    });
  } catch (error) {
    console.error("Get admin reels error:", error);
    return res.status(500).json({ success: false, message: "Server error fetching reels" });
  }
}

// Admin: Get single reel
async function getReelByIdHandler(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid reel id" });

    const reel = await getReelById(id);
    if (!reel) {
      return res.status(404).json({ success: false, message: "Reel not found" });
    }

    return res.status(200).json({ success: true, data: reel });
  } catch (error) {
    console.error("Get reel error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// Admin: Create new reel
async function createReelHandler(req, res) {
  try {
    const { title, video_url, sort_order, is_active } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }
    if (!video_url || !video_url.trim()) {
      return res.status(400).json({ success: false, message: "Video URL is required" });
    }

    const trimmedUrl = video_url.trim();
    const platform = req.body.platform || detectPlatform(trimmedUrl);

    let thumbnailUrl = null;
    if (req.file) {
      const uploadRes = await uploadFile(req.file, { folder: "reels" });
      thumbnailUrl = uploadRes.url;
    } else if (req.body.thumbnail_url && typeof req.body.thumbnail_url === "string") {
      thumbnailUrl = req.body.thumbnail_url.trim();
    }

    // Fallback to auto YouTube thumbnail if not provided
    if (!thumbnailUrl) {
      thumbnailUrl = resolveThumbnail(trimmedUrl, platform, null);
    }

    const reelData = {
      title: title.trim(),
      video_url: trimmedUrl,
      platform,
      thumbnail_url: thumbnailUrl,
      sort_order: Number(sort_order) || 0,
      is_active: is_active === undefined ? true : Boolean(is_active === true || is_active === "true" || is_active === 1),
    };

    const created = await createReel(reelData);
    return res.status(201).json({
      success: true,
      message: "Reel created successfully",
      data: created,
    });
  } catch (error) {
    console.error("Create reel error:", error);
    return res.status(500).json({ success: false, message: "Server error creating reel" });
  }
}

// Admin: Update reel
async function updateReelHandler(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid reel id" });

    const existing = await getReelById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Reel not found" });
    }

    const { title, video_url, sort_order, is_active } = req.body;
    const trimmedUrl = video_url ? video_url.trim() : existing.video_url;
    const platform = req.body.platform || detectPlatform(trimmedUrl);

    let thumbnailUrl = existing.thumbnail_url;
    if (req.file) {
      const uploadRes = await uploadFile(req.file, { folder: "reels" });
      thumbnailUrl = uploadRes.url;
    } else if (req.body.thumbnail_url !== undefined) {
      thumbnailUrl = req.body.thumbnail_url ? req.body.thumbnail_url.trim() : null;
    }

    if (!thumbnailUrl) {
      thumbnailUrl = resolveThumbnail(trimmedUrl, platform, null);
    }

    const updateData = {
      title: title ? title.trim() : existing.title,
      video_url: trimmedUrl,
      platform,
      thumbnail_url: thumbnailUrl,
      sort_order: sort_order !== undefined ? Number(sort_order) : existing.sort_order,
      is_active: is_active !== undefined ? Boolean(is_active === true || is_active === "true" || is_active === 1) : existing.is_active,
    };

    const updated = await updateReel(id, updateData);
    return res.status(200).json({
      success: true,
      message: "Reel updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update reel error:", error);
    return res.status(500).json({ success: false, message: "Server error updating reel" });
  }
}

// Admin: Toggle reel status
async function toggleReelStatusHandler(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid reel id" });

    const existing = await getReelById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Reel not found" });
    }

    const nextStatus = req.body.is_active !== undefined ? Boolean(req.body.is_active) : !existing.is_active;
    const updated = await toggleReelStatus(id, nextStatus);

    return res.status(200).json({
      success: true,
      message: `Reel ${nextStatus ? "activated" : "deactivated"} successfully`,
      data: updated,
    });
  } catch (error) {
    console.error("Toggle reel status error:", error);
    return res.status(500).json({ success: false, message: "Server error updating status" });
  }
}

// Admin: Delete reel
async function deleteReelHandler(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid reel id" });

    const existing = await getReelById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Reel not found" });
    }

    await deleteReel(id);
    return res.status(200).json({
      success: true,
      message: "Reel deleted successfully",
    });
  } catch (error) {
    console.error("Delete reel error:", error);
    return res.status(500).json({ success: false, message: "Server error deleting reel" });
  }
}

// Admin: Reorder reels
async function reorderReelsHandler(req, res) {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ success: false, message: "orderedIds must be an array" });
    }

    await reorderReels(orderedIds);
    return res.status(200).json({
      success: true,
      message: "Reels reordered successfully",
    });
  } catch (error) {
    console.error("Reorder reels error:", error);
    return res.status(500).json({ success: false, message: "Server error reordering reels" });
  }
}

module.exports = {
  getPublicReelsHandler,
  getAdminReelsHandler,
  getReelByIdHandler,
  createReelHandler,
  updateReelHandler,
  toggleReelStatusHandler,
  deleteReelHandler,
  reorderReelsHandler,
};

