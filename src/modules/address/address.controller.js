const {
  createAddress,
  getAddressesByUserId,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
} = require("../../models/address.model");

const createAddressController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { phone_number } = req.body;

    if (!phone_number || !String(phone_number).trim()) {
      return res.status(400).json({
        success: false,
        message: "Mobile phone number is required for delivery addresses",
      });
    }

    const address = await createAddress({
      ...req.body,
      user_id: userId,
    });

    return res.status(201).json({
      success: true,
      message: "Address created successfully",
      data: address,
    });
  } catch (error) {
    console.error("Create address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error creating address",
    });
  }
};

const getAddressesController = async (req, res) => {
  try {
    const userId = req.user.id;

    const addresses = await getAddressesByUserId(userId);

    return res.status(200).json({
      success: true,
      data: addresses,
    });
  } catch (error) {
    console.error("Get addresses error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching addresses",
    });
  }
};

const updateAddressController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const address = await updateAddress(
      id,
      userId,
      req.body
    );

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Address updated successfully",
      data: address,
    });
  } catch (error) {
    console.error("Update address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error updating address",
    });
  }
};

const deleteAddressController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const deleted = await deleteAddress(id, userId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Address deleted successfully",
    });
  } catch (error) {
    console.error("Delete address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error deleting address",
    });
  }
};

const setDefaultAddressController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const updated = await setDefaultAddress(id, userId);

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Default address updated",
    });
  } catch (error) {
    console.error("Set default address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error setting default address",
    });
  }
};

module.exports = {
  createAddressController,
  getAddressesController,
  updateAddressController,
  deleteAddressController,
  setDefaultAddressController,
};