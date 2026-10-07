function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  return null;
}

const PRODUCT_SORT_COLUMNS = {
  name: "products.name",
  category: "categories.name",
  price: "products.price",
  stock: "products.stock",
  availabilityType: "products.availability_type",
  status: "products.is_active",
  createdAt: "products.created_at",
};

const VALID_AVAILABILITY_TYPES = ["IN_STOCK", "MADE_TO_ORDER"];

function validatePrice(price) {
  const parsed = Number(price);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.round(parsed);
}

function validateProductCreate({
  name,
  description,
  price,
  images,
  stock,
  availabilityType,
  categoryId,
  isActive,
  isPosOnly,
}) {
  const errors = {};
  const safeImages = Array.isArray(images) ? images : [];

  if (!name || typeof name !== "string" || name.trim().length < 2) {
    errors.name = "Name is required and must be at least 2 characters.";
  } else if (name.trim().length > 200) {
    errors.name = "Name must not exceed 200 characters.";
  }

  if (description !== undefined && description !== null) {
    if (typeof description !== "string") {
      errors.description = "Description must be a string.";
    } else if (description.length > 5000) {
      errors.description = "Description must not exceed 5000 characters.";
    }
  }

  if (!isPosOnly && (!Array.isArray(images) || images.length === 0)) {
    errors.images = "At least one image is required.";
  }

  const parsedPrice = validatePrice(price);
  if (parsedPrice === null) {
    errors.price = "Price is required and must be a non-negative number.";
  }

  const normalizedAvailType = availabilityType
    ? String(availabilityType).toUpperCase().trim()
    : "IN_STOCK";

  if (!VALID_AVAILABILITY_TYPES.includes(normalizedAvailType)) {
    errors.availabilityType = `Invalid availability type. Allowed values: ${VALID_AVAILABILITY_TYPES.join(", ")}`;
  }

  let parsedStock = 0;
  if (normalizedAvailType === "IN_STOCK") {
    if (stock === undefined || stock === null || stock === "") {
      errors.stock = "Available stock quantity is required for in-stock products.";
    } else {
      parsedStock = Number(stock);
      if (!Number.isInteger(parsedStock) || parsedStock < 0) {
        errors.stock = "Stock must be a non-negative integer.";
      }
    }
  } else {
    // MADE_TO_ORDER does not require a stock quantity
    parsedStock = 0;
  }

  const parsedCategoryId = Number(categoryId);
  if (!Number.isInteger(parsedCategoryId) || parsedCategoryId <= 0) {
    errors.categoryId =
      "Category ID is required and must be a positive integer.";
  }

  const parsedIsActive = parseOptionalBoolean(isActive);
  if (parsedIsActive === null) {
    errors.isActive = "isActive must be a boolean value.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    data: {
      name: typeof name === "string" ? name.trim() : name,
      description:
        description === undefined || description === null
          ? null
          : String(description).trim(),
      price: parsedPrice,
      stock: parsedStock,
      availability_type: normalizedAvailType,
      images: safeImages,
      category_id: parsedCategoryId,
      is_active: parsedIsActive === undefined ? true : parsedIsActive,
    },
  };
}

function validateProductUpdate({
  name,
  description,
  price,
  stock,
  availabilityType,
  images,
  categoryId,
  isActive,
}) {
  const errors = {};
  const data = {};

  // No uploaded files means retain the existing product images on update.
  if (!Array.isArray(images)) {
    errors.images = "Images must be an array.";
  } else if (images.length > 0) {
    data.images = images;
  }

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length < 2) {
      errors.name = "Name must be at least 2 characters.";
    } else if (name.trim().length > 200) {
      errors.name = "Name must not exceed 200 characters.";
    } else {
      data.name = name.trim();
    }
  }

  if (description !== undefined) {
    if (description !== null && typeof description !== "string") {
      errors.description = "Description must be a string.";
    } else if (description && description.length > 5000) {
      errors.description = "Description must not exceed 5000 characters.";
    } else {
      data.description = description === null ? null : description.trim();
    }
  }

  if (price !== undefined) {
    const parsedPrice = validatePrice(price);
    if (parsedPrice === null) {
      errors.price = "Price must be a non-negative number.";
    } else {
      data.price = parsedPrice;
    }
  }

  if (availabilityType !== undefined) {
    const normalizedAvailType = String(availabilityType).toUpperCase().trim();
    if (!VALID_AVAILABILITY_TYPES.includes(normalizedAvailType)) {
      errors.availabilityType = `Invalid availability type. Allowed values: ${VALID_AVAILABILITY_TYPES.join(", ")}`;
    } else {
      data.availability_type = normalizedAvailType;
      if (normalizedAvailType === "MADE_TO_ORDER") {
        data.stock = 0;
      }
    }
  }

  if (stock !== undefined && data.availability_type !== "MADE_TO_ORDER") {
    const parsedStock = Number(stock);
    if (!Number.isInteger(parsedStock) || parsedStock < 0) {
      errors.stock = "Stock must be a non-negative integer.";
    } else {
      data.stock = parsedStock;
    }
  }

  if (categoryId !== undefined) {
    const parsedCategoryId = Number(categoryId);
    if (!Number.isInteger(parsedCategoryId) || parsedCategoryId <= 0) {
      errors.categoryId = "Category ID must be a positive integer.";
    } else {
      data.category_id = parsedCategoryId;
    }
  }

  if (isActive !== undefined) {
    const parsedIsActive = parseOptionalBoolean(isActive);
    if (parsedIsActive === null) {
      errors.isActive = "isActive must be a boolean value.";
    } else {
      data.is_active = parsedIsActive;
    }
  }

  if (Object.keys(data).length === 0 && Object.keys(errors).length === 0) {
    errors._general = "At least one field is required to update.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    data,
  };
}

function validateProductListQuery({
  categoryId,
  isActive,
  availabilityType,
  search,
  sortBy,
  sortOrder,
}) {
  const errors = {};
  const filters = {};

  if (categoryId !== undefined) {
    const parsed = Number(categoryId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.categoryId = "Category ID must be a positive integer.";
    } else {
      filters.categoryId = parsed;
    }
  }

  if (isActive !== undefined) {
    const parsedIsActive = parseOptionalBoolean(isActive);
    if (parsedIsActive === null) {
      errors.isActive = "isActive must be a boolean value.";
    } else {
      filters.isActive = parsedIsActive;
    }
  }

  if (availabilityType !== undefined) {
    const normalized = String(availabilityType).toUpperCase().trim();
    if (!VALID_AVAILABILITY_TYPES.includes(normalized)) {
      errors.availabilityType = `Invalid availability type. Allowed values: ${VALID_AVAILABILITY_TYPES.join(", ")}`;
    } else {
      filters.availabilityType = normalized;
    }
  }

  if (search !== undefined && search !== "") {
    if (typeof search !== "string") {
      errors.search = "Search must be a string.";
    } else if (search.trim().length > 100) {
      errors.search = "Search must not exceed 100 characters.";
    } else if (search.trim().length > 0) {
      filters.search = search.trim();
    }
  }

  if (sortBy !== undefined) {
    if (!PRODUCT_SORT_COLUMNS[sortBy]) {
      errors.sortBy = "Invalid sort field.";
    } else {
      filters.sortBy = PRODUCT_SORT_COLUMNS[sortBy];
    }
  }

  if (sortOrder !== undefined) {
    if (sortOrder !== "asc" && sortOrder !== "desc") {
      errors.sortOrder = "Sort order must be asc or desc.";
    } else {
      filters.sortOrder = sortOrder;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    filters,
  };
}

module.exports = {
  validateProductCreate,
  validateProductUpdate,
  validateProductListQuery,
};
