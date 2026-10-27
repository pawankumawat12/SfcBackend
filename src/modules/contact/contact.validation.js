const { isValidIndianPhone } = require("../../utils/phone.util");

/**
 * Validate customer contact form submission
 */
function validateContactSubmission(body) {
  const errors = [];
  const { name, email, phone, subject, message } = body || {};

  // Name
  if (!name || typeof name !== "string" || !name.trim()) {
    errors.push("Your name is required");
  } else if (name.trim().length < 2) {
    errors.push("Name must be at least 2 characters");
  } else if (name.trim().length > 100) {
    errors.push("Name cannot exceed 100 characters");
  }

  // Email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || typeof email !== "string" || !email.trim()) {
    errors.push("Email address is required");
  } else if (!emailRegex.test(email.trim())) {
    errors.push("Please provide a valid email address");
  } else if (email.trim().length > 150) {
    errors.push("Email cannot exceed 150 characters");
  }

  // Phone (optional or valid format)
  if (phone && typeof phone === "string" && phone.trim()) {
    if (!isValidIndianPhone(phone)) {
      errors.push("Please provide a valid 10-digit Indian phone number");
    }
  }

  // Subject
  if (!subject || typeof subject !== "string" || !subject.trim()) {
    errors.push("Subject is required");
  } else if (subject.trim().length < 2) {
    errors.push("Subject must be at least 2 characters");
  } else if (subject.trim().length > 200) {
    errors.push("Subject cannot exceed 200 characters");
  }

  // Message
  if (!message || typeof message !== "string" || !message.trim()) {
    errors.push("Message is required");
  } else if (message.trim().length < 5) {
    errors.push("Message must be at least 5 characters");
  } else if (message.trim().length > 3000) {
    errors.push("Message cannot exceed 3000 characters");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate admin query update
 */
function validateStatusUpdate(body) {
  const errors = [];
  const { status, admin_notes } = body || {};

  const allowedStatuses = ["pending", "in_progress", "resolved"];
  if (status && !allowedStatuses.includes(status)) {
    errors.push(`Status must be one of: ${allowedStatuses.join(", ")}`);
  }

  if (admin_notes !== undefined && typeof admin_notes === "string" && admin_notes.length > 2000) {
    errors.push("Admin notes cannot exceed 2000 characters");
  }

  const reply = body.admin_reply || body.reply;
  if (reply !== undefined && typeof reply === "string" && reply.length > 5000) {
    errors.push("Admin reply cannot exceed 5000 characters");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

module.exports = {
  validateContactSubmission,
  validateStatusUpdate,
};

