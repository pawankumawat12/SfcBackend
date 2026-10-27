const {
  normalizeIndianPhone,
  isValidIndianPhone,
} = require("../../utils/phone.util");

function validateEmail(email) {
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(String(email).toLowerCase());
}

function validatePhone(phone) {
  return isValidIndianPhone(phone);
}

function validatePassword(password) {
  if (typeof password !== "string") return false;
  const lengthOk = password.length >= 8 && password.length <= 128;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  return lengthOk && hasUpper && hasLower && hasNumber && hasSpecial;
}
function validateRegister({ name, email, phone, password }) {
  const errors = {};
  if (!name || typeof name !== "string" || name.trim().length < 3) {
    errors.name = "Name is required and must be at least 3 characters.";
  }

  const hasEmail = typeof email === "string" && email.trim() !== "";
  if (!hasEmail || !validateEmail(email.trim())) {
    errors.email = "A valid email address is required.";
  }

  const hasPhone = typeof phone === "string" && phone.trim() !== "";
  if (!hasPhone) {
    errors.phone = "Mobile number is required.";
  } else if (!validatePhone(phone.trim())) {
    errors.phone = "A valid 10-digit mobile number (starting with 6-9) is required.";
  }

  if (!password || !validatePassword(password)) {
    errors.password =
      "Password must be 8+ chars and include upper, lower, number, and special character.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}
function validateLogin({ email, password, phone }) {
  const errors = {};

  
  const hasEmail = typeof email === "string" && email.trim() !== "";
  const hasPhone = typeof phone === "string" && phone.trim() !== "";

  if (!hasEmail && !hasPhone) {
    errors.email = "Either email or phone number is required.";
    errors.phone = "Either email or phone number is required.";
  }

  if (hasEmail && !validateEmail(email.trim())) {
    errors.email = "A valid email address is required.";
  }

  if (hasPhone && !validatePhone(phone.trim())) {
    errors.phone = "A valid 10-digit phone number is required.";
  }


  if (!password || typeof password !== "string" || password.length < 8) {
    errors.password = "Password is required and must be at least 8 characters.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

function validateUpdateProfile({ name, email, phone }) {
  const errors = {};
  if (!name || typeof name !== "string" || name.trim().length < 3) {
    errors.name = "Name is required and must be at least 3 characters.";
  }

  const hasEmail = typeof email === "string" && email.trim() !== "";
  const hasPhone = typeof phone === "string" && phone.trim() !== "";

  if (hasEmail && !validateEmail(email.trim())) {
    errors.email = "A valid email address is required.";
  }

  if (hasPhone && !validatePhone(phone.trim())) {
    errors.phone = "A valid 10-digit phone number is required.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

module.exports = {
  validateRegister,
  validateLogin,
  validatePassword,
  validateUpdateProfile,
  validateEmail,
  validatePhone,
  normalizePhone: normalizeIndianPhone,
  normalizeIndianPhone,
  isValidIndianPhone,
};
