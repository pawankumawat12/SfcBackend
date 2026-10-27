const offerModel = require("../../models/offer.model");
const { getCartItems } = require("../../models/cart.model");
const {
  uploadFile,
  deleteFile,
} = require("../../services/storage/storage.service");

async function getActiveOffers(req, res) {
  try {
    const offers = await offerModel.listActiveOffersCustomer();
    return res.status(200).json({
      success: true,
      message: "Active offers fetched successfully",
      data: offers,
    });
  } catch (error) {
    console.error("Get active offers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch offers",
    });
  }
}

async function validateOfferCode(req, res) {
  try {
    const { code, items: clientItems } = req.body;
    const userId = req.user?.id;

    if (!code || !String(code).trim()) {
      return res.status(400).json({
        success: false,
        message: "Please enter a promo code",
      });
    }

    let items = clientItems || [];
    // If no client items provided and user is authenticated, check their cart
    if ((!items || items.length === 0) && userId) {
      items = await getCartItems(userId);
    }

    let subtotal = 0;
    for (const it of items) {
      subtotal += (Number(it.price) || 0) * (Number(it.quantity) || 1);
    }
    subtotal = Math.round(subtotal);

    const evaluation = await offerModel.evaluateCartOffer({
      offerCode: code,
      items,
      rawSubtotal: subtotal,
    });

    if (!evaluation.isEligible) {
      return res.status(400).json({
        success: false,
        message: evaluation.reason || `Promo code "${code.toUpperCase()}" is not applicable to your current cart.`,
        data: evaluation,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Promo code "${evaluation.offer?.code || code.toUpperCase()}" applied successfully! You saved ₹${evaluation.discount}.`,
      data: evaluation,
    });
  } catch (error) {
    console.error("Validate offer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to validate promo code",
    });
  }
}

async function getAdminOffers(req, res) {
  try {
    const { page, limit, search, status, type } = req.query;
    const result = await offerModel.listOffersAdmin({
      page,
      limit,
      search,
      status,
      type,
    });
    return res.status(200).json({
      success: true,
      message: "Admin offers fetched successfully",
      data: result,
    });
  } catch (error) {
    console.error("Get admin offers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch offers",
    });
  }
}

async function getOffer(req, res) {
  try {
    const { id } = req.params;
    const offer = await offerModel.findOfferById(id);
    if (!offer) {
      return res.status(404).json({
        success: false,
        message: "Offer not found",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Offer fetched successfully",
      data: offer,
    });
  } catch (error) {
    console.error("Get offer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch offer",
    });
  }
}

async function createOfferHandler(req, res) {
  let uploadRes = null;
  try {
    let bannerImage = req.body.banner_image || null;
    let storageKey = null;
    let storageProvider = null;

    if (req.file) {
      uploadRes = await uploadFile(req.file, { folder: "offers" });
      bannerImage = uploadRes.url;
      storageKey = uploadRes.key;
      storageProvider = uploadRes.provider;
    }

    const offer = await offerModel.createOffer({
      ...req.body,
      banner_image: bannerImage,
      storage_key: storageKey,
      storage_provider: storageProvider || "cloudinary",
    });
    return res.status(201).json({
      success: true,
      message: `Offer "${offer.title}" created successfully!`,
      data: offer,
    });
  } catch (error) {
    console.error("Create offer error:", error);
    if (uploadRes?.key || uploadRes?.url) {
      deleteFile(uploadRes.key || uploadRes.url).catch(() => {});
    }
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to create offer",
    });
  }
}

async function updateOfferHandler(req, res) {
  let uploadRes = null;
  try {
    const { id } = req.params;
    const existing = await offerModel.findOfferById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Offer not found" });
    }

    let bannerImage = req.body.banner_image;
    let storageKey = undefined;
    let storageProvider = undefined;

    if (req.file) {
      uploadRes = await uploadFile(req.file, { folder: "offers" });
      bannerImage = uploadRes.url;
      storageKey = uploadRes.key;
      storageProvider = uploadRes.provider;

      // Automatically delete old banner image from Cloudinary
      if (existing.storage_key || existing.banner_image) {
        deleteFile(existing.storage_key || existing.banner_image).catch((err) =>
          console.warn("[OfferController] Failed to delete old offer banner:", err.message)
        );
      }
    }

    const offer = await offerModel.updateOffer(id, {
      ...req.body,
      ...(bannerImage !== undefined ? { banner_image: bannerImage } : {}),
      ...(storageKey !== undefined ? { storage_key: storageKey } : {}),
      ...(storageProvider !== undefined ? { storage_provider: storageProvider } : {}),
    });
    return res.status(200).json({
      success: true,
      message: `Offer "${offer.title}" updated successfully!`,
      data: offer,
    });
  } catch (error) {
    console.error("Update offer error:", error);
    if (uploadRes?.key || uploadRes?.url) {
      deleteFile(uploadRes.key || uploadRes.url).catch(() => {});
    }
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to update offer",
    });
  }
}

async function toggleOfferStatusHandler(req, res) {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    const offer = await offerModel.toggleOfferStatus(id, is_active);
    return res.status(200).json({
      success: true,
      message: `Offer is now ${offer.is_active ? "active" : "inactive"}.`,
      data: offer,
    });
  } catch (error) {
    console.error("Toggle offer status error:", error);
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to update offer status",
    });
  }
}

async function deleteOfferHandler(req, res) {
  try {
    const { id } = req.params;
    const existing = await offerModel.findOfferById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Offer not found or already deleted",
      });
    }

    // Automatically remove banner image from Cloudinary
    if (existing.storage_key || existing.banner_image) {
      deleteFile(existing.storage_key || existing.banner_image).catch((err) =>
        console.warn("[OfferController] Failed to delete offer banner on delete:", err.message)
      );
    }

    const deleted = await offerModel.deleteOffer(id);
    return res.status(200).json({
      success: true,
      message: "Offer deleted permanently",
    });
  } catch (error) {
    console.error("Delete offer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete offer",
    });
  }
}

module.exports = {
  getActiveOffers,
  validateOfferCode,
  getAdminOffers,
  getOffer,
  createOfferHandler,
  updateOfferHandler,
  toggleOfferStatusHandler,
  deleteOfferHandler,
};

