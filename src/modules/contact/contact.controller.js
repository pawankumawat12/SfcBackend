const ContactModel = require("../../models/contact.model");
const { normalizeIndianPhone } = require("../../utils/phone.util");
const {
  validateContactSubmission,
  validateStatusUpdate,
} = require("./contact.validation");

/**
 * 1. Submit contact query (Public or Authenticated Customer)
 */
async function submitContactQuery(req, res) {
  try {
    const validation = validateContactSubmission(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.errors[0] || "Validation failed",
        errors: validation.errors,
      });
    }

    const { name, email, phone, subject, message } = req.body;
    const userId = req.user?.id || null;
    const cleanPhone = phone ? normalizeIndianPhone(phone) : null;

    const newQuery = await ContactModel.createQuery({
      user_id: userId,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: cleanPhone,
      subject: subject.trim(),
      message: message.trim(),
    });

    // Notify admins in real-time
    const notificationModel = require("../../models/notification.model");
    notificationModel.createNotification({
      role: "admin",
      type: "contact_inquiry",
      title: "New Customer Inquiry 📩",
      message: `${name.trim()} sent a message: "${subject.trim()}"`,
      dataJson: {
        queryId: newQuery.id,
        email: email.trim().toLowerCase(),
        phone: cleanPhone,
      },
    }).catch((err) => console.error("Admin contact notification error:", err));

    return res.status(201).json({
      success: true,
      message: "Thank you for reaching out! Your message has been sent successfully. We'll get back to you soon.",
      data: newQuery,
    });
  } catch (error) {
    console.error("Submit contact query error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit your message. Please try again later.",
    });
  }
}

/**
 * 2. Get all contact queries for Admin (Paginated, filtered, searchable)
 */
async function getAdminContactQueries(req, res) {
  try {
    const { page, limit, status, search } = req.query;

    const result = await ContactModel.getQueries({
      page,
      limit,
      status,
      search,
    });

    return res.status(200).json({
      success: true,
      data: result.queries,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Get admin contact queries error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve contact queries",
    });
  }
}

/**
 * 3. Get Contact Stats for Admin
 */
async function getAdminContactStats(req, res) {
  try {
    const stats = await ContactModel.getStats();

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Get admin contact stats error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve contact statistics",
    });
  }
}

/**
 * 4. Update query status, admin notes, and admin reply (Admin)
 */
async function updateAdminContactQuery(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid query ID",
      });
    }

    const existing = await ContactModel.getQueryById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Contact query not found",
      });
    }

    const validation = validateStatusUpdate(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.errors[0] || "Validation failed",
        errors: validation.errors,
      });
    }

    const { status, admin_notes, admin_reply } = req.body;
    const adminId = req.user?.id || null;

    const updatePayload = {
      admin_notes,
    };

    if (admin_reply !== undefined && admin_reply !== null && admin_reply.trim() !== "") {
      updatePayload.admin_reply = admin_reply.trim();
      updatePayload.replied_at = new Date();
      updatePayload.admin_id = adminId;
      if (!status || status === "pending") {
        updatePayload.status = "resolved";
      } else {
        updatePayload.status = status;
      }
    } else if (status) {
      updatePayload.status = status;
    }

    const updated = await ContactModel.updateQuery(id, updatePayload);

    // If an admin replied, notify customer via socket, notification, and email
    if (updatePayload.admin_reply) {
      try {
        const socketService = require("../../socket/socket.service");
        if (existing.user_id) {
          socketService.emitToUser(existing.user_id, "contact_query_replied", updated);
        }
      } catch (err) {
        console.error("Socket emit error for contact query reply:", err);
      }

      if (existing.user_id) {
        try {
          const notificationModel = require("../../models/notification.model");
          notificationModel
            .createNotification({
              userId: existing.user_id,
              role: "customer",
              type: "contact_reply",
              title: "Response to your inquiry",
              message: `Admin replied to your message "${existing.subject}": ${updatePayload.admin_reply.slice(0, 100)}...`,
              dataJson: {
                queryId: updated.id,
                subject: updated.subject,
                adminReply: updated.admin_reply,
              },
            })
            .catch((err) => console.error("Customer contact notification error:", err));
        } catch (err) {
          console.error("Notification creation error for contact reply:", err);
        }
      }

      if (existing.email) {
        try {
          const { sendTemplatedMail } = require("../../services/emailTemplate.service");
          sendTemplatedMail({
              to: existing.email,
              templateSlug: "contact-reply",
              emailType: "contact_reply",
              userId: existing.user_id,
              variables: {
                userName: existing.name,
                inquirySubject: existing.subject,
                adminReply: updatePayload.admin_reply,
                originalMessage: existing.message,
              },
            })
            .catch((mailErr) => console.error("Contact reply email send error:", mailErr));
        } catch (err) {
          console.error("Mail setup error in contact reply:", err);
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Contact query updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update admin contact query error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update contact query",
    });
  }
}

/**
 * 5. Delete query (Admin)
 */
async function deleteAdminContactQuery(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid query ID",
      });
    }

    const existing = await ContactModel.getQueryById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Contact query not found",
      });
    }

    await ContactModel.deleteQuery(id);

    return res.status(200).json({
      success: true,
      message: "Contact query deleted successfully",
    });
  } catch (error) {
    console.error("Delete admin contact query error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete contact query",
    });
  }
}

/**
 * 6. Get queries submitted by the logged-in customer
 */
async function getMyContactQueries(req, res) {
  try {
    const userId = req.user?.id;
    const email = req.user?.email;

    if (!userId && !email) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const queries = await ContactModel.getUserQueries({ userId, email });

    return res.status(200).json({
      success: true,
      data: queries,
    });
  } catch (error) {
    console.error("Get my contact queries error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve your contact messages",
    });
  }
}

module.exports = {
  submitContactQuery,
  getAdminContactQueries,
  getAdminContactStats,
  updateAdminContactQuery,
  deleteAdminContactQuery,
  getMyContactQueries,
};

