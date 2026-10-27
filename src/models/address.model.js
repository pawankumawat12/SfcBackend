const knex = require("../../config/db");
const { geocodeAddress } = require("../utils/geocoding.util");

const TABLE = "addresses";

const createAddress = async (addressData) => {
  // If coordinates are missing or zero, auto-resolve via free geocoding
  const numLat = Number(addressData.latitude);
  const numLng = Number(addressData.longitude);
  if (!numLat || isNaN(numLat) || numLat === 0 || !numLng || isNaN(numLng) || numLng === 0) {
    const resolved = await geocodeAddress(addressData);
    addressData.latitude = resolved.latitude;
    addressData.longitude = resolved.longitude;
  } else {
    addressData.latitude = numLat;
    addressData.longitude = numLng;
  }

  // Check if this is user's first address
  const existingCount = await knex(TABLE)
    .where({ user_id: addressData.user_id })
    .count("id as count")
    .first();

  const isFirstAddress = !existingCount || Number(existingCount.count) === 0;

  if (isFirstAddress || addressData.is_default) {
    addressData.is_default = true;
    await knex(TABLE)
      .where({ user_id: addressData.user_id })
      .update({ is_default: false });
  } else {
    addressData.is_default = Boolean(addressData.is_default);
  }

  const [id] = await knex(TABLE)
    .insert(addressData)
    .returning("id");

  const addressId = typeof id === "object" && id !== null ? (id.id || id) : id;
  return getAddressById(addressId, addressData.user_id);
};

const getAddressById = async (id, userId = null) => {
  let query = knex(TABLE).where({ id });

  if (userId) {
    query = query.where({ user_id: userId });
  }

  return query.first();
};

const getAddressesByUserId = async (userId) => {
  return knex(TABLE)
    .where({ user_id: userId })
    .orderBy("is_default", "desc")
    .orderBy("created_at", "desc");
};

const updateAddress = async (id, userId, updateData) => {
  // Clean up data
  const data = { ...updateData };
  delete data.id;
  delete data.user_id;
  delete data.created_at;

  const numLat = Number(data.latitude);
  const numLng = Number(data.longitude);
  if (!numLat || isNaN(numLat) || numLat === 0 || !numLng || isNaN(numLng) || numLng === 0) {
    if (data.formatted_address || data.city || data.pincode) {
      const existing = await getAddressById(id, userId);
      const merged = { ...existing, ...data };
      const resolved = await geocodeAddress(merged);
      if (resolved.latitude !== 0 && resolved.longitude !== 0) {
        data.latitude = resolved.latitude;
        data.longitude = resolved.longitude;
      }
    }
  } else {
    data.latitude = numLat;
    data.longitude = numLng;
  }

  if (data.is_default) {
    await knex(TABLE)
      .where({ user_id: userId })
      .update({ is_default: false });
  }

  await knex(TABLE)
    .where({ id, user_id: userId })
    .update({
      ...data,
      updated_at: knex.fn.now(),
    });

  return getAddressById(id, userId);
};

const deleteAddress = async (id, userId) => {
  const addressToDelete = await knex(TABLE)
    .where({ id, user_id: userId })
    .first();

  const count = await knex(TABLE)
    .where({ id, user_id: userId })
    .del();

  // If deleted address was default, promote the newest remaining address as default
  if (addressToDelete?.is_default) {
    const nextDefault = await knex(TABLE)
      .where({ user_id: userId })
      .orderBy("created_at", "desc")
      .first();

    if (nextDefault) {
      await knex(TABLE)
        .where({ id: nextDefault.id, user_id: userId })
        .update({ is_default: true, updated_at: knex.fn.now() });
    }
  }

  return count;
};

const setDefaultAddress = async (id, userId) => {
  await knex(TABLE)
    .where({ user_id: userId })
    .update({ is_default: false });

  await knex(TABLE)
    .where({ id, user_id: userId })
    .update({ is_default: true, updated_at: knex.fn.now() });

  return getAddressById(id, userId);
};

module.exports = {
  createAddress,
  getAddressById,
  getAddressesByUserId,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};