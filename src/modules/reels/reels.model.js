const db = require("../../../config/db");

const REEL_COLUMNS = [
  "id",
  "title",
  "video_url",
  "platform",
  "thumbnail_url",
  "sort_order",
  "is_active",
  "created_at",
  "updated_at",
];

async function getActiveReels() {
  return db("reels")
    .select(REEL_COLUMNS)
    .where({ is_active: true })
    .orderBy("sort_order", "asc")
    .orderBy("created_at", "desc");
}

async function getAllReelsAdmin() {
  return db("reels")
    .select(REEL_COLUMNS)
    .orderBy("sort_order", "asc")
    .orderBy("created_at", "desc");
}

async function getReelById(id) {
  return db("reels").where({ id }).first();
}

async function createReel(data) {
  const [created] = await db("reels").insert(data).returning("*");
  if (created) return created;
  // Fallback for drivers where returning is not supported
  const last = await db("reels").orderBy("id", "desc").first();
  return last;
}

async function updateReel(id, data) {
  const [updated] = await db("reels")
    .where({ id })
    .update({ ...data, updated_at: db.fn.now() })
    .returning("*");
  if (updated) return updated;
  return getReelById(id);
}

async function deleteReel(id) {
  return db("reels").where({ id }).del();
}

async function toggleReelStatus(id, isActive) {
  const [updated] = await db("reels")
    .where({ id })
    .update({ is_active: Boolean(isActive), updated_at: db.fn.now() })
    .returning("*");
  if (updated) return updated;
  return getReelById(id);
}

async function reorderReels(orderedIds = []) {
  return db.transaction(async (trx) => {
    for (let index = 0; index < orderedIds.length; index++) {
      const id = orderedIds[index];
      await trx("reels").where({ id }).update({ sort_order: index + 1 });
    }
  });
}

module.exports = {
  getActiveReels,
  getAllReelsAdmin,
  getReelById,
  createReel,
  updateReel,
  deleteReel,
  toggleReelStatus,
  reorderReels,
};

