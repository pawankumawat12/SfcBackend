const { sendTemplatedMail } = require("./emailTemplate.service");
const { sendMail } = require("./resend.service");

/**
 * Send welcome invitation email when admin creates a new store owner
 * Dispatched using the 'store-invitation' database email template
 */
async function sendStoreInvitationEmail({ email, ownerName, storeName, loginUrl }) {
  const url = loginUrl || `${process.env.ADMIN_URL || "http://localhost:5173"}/login`;

  try {
    return await sendTemplatedMail({
      to: email,
      templateSlug: "store-invitation",
      variables: {
        ownerName: ownerName || "Partner",
        storeName,
        email,
        loginUrl: url,
      },
      emailType: "store-invitation",
    });
  } catch (err) {
    console.warn(`[Store Email] Template "store-invitation" lookup failed, falling back to direct email:`, err.message);
    const subject = `Welcome to SFC Bakers! Your Store "${storeName}" Has Been Created`;
    const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
          .header { background: #166534; padding: 32px 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
          .content { padding: 32px 28px; line-height: 1.6; }
          .highlight-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 18px 20px; margin: 24px 0; }
          .highlight-title { font-weight: 600; color: #15803d; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
          .store-name { font-size: 20px; font-weight: 700; color: #166534; }
          .btn-container { text-align: center; margin: 32px 0; }
          .btn { background-color: #166534; color: #ffffff !important; padding: 14px 32px; border-radius: 10px; font-weight: 600; text-decoration: none; display: inline-block; font-size: 15px; }
          .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
          .steps-list { padding-left: 20px; margin: 16px 0; color: #334155; }
          .steps-list li { margin-bottom: 8px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>SFC Bakers Partner Portal</h1>
          </div>
          <div class="content">
            <p>Dear <strong>${ownerName || "Partner"}</strong>,</p>
            <p>Congratulations! The Administrator has officially registered your store on the <strong>SFC Bakers</strong> platform.</p>
            
            <div class="highlight-card">
              <div class="highlight-title">Your Assigned Store</div>
              <div class="store-name">${storeName}</div>
            </div>

            <p><strong>Next Steps to Activate Your Portal:</strong></p>
            <ol class="steps-list">
              <li>Click the button below to visit the Portal.</li>
              <li>Enter your registered email (<strong>${email}</strong>) to request access.</li>
              <li>Once Admin approves your live request, you will receive a secure link to set your password.</li>
            </ol>

            <div class="btn-container">
              <a href="${url}" class="btn" target="_blank" rel="noopener noreferrer">Go to Partner Portal</a>
            </div>

            <p style="font-size: 13px; color: #64748b;">If the button above does not work, copy and paste this link into your browser:<br><a href="${url}" target="_blank" rel="noopener noreferrer" style="color: #166534;">${url}</a></p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} SFC Bakers. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

    return await sendMail({
      to: email,
      subject,
      html,
      text: `Welcome to SFC Bakers! Your store "${storeName}" has been created. Visit ${url} with email ${email} to activate your access.`,
      emailType: "store-invitation",
    });
  }
}

/**
 * Send password setup link when admin approves the store owner's login request
 * Dispatched using the 'store-approval' database email template
 */
async function sendStoreApprovalEmail({ email, ownerName, storeName, setupToken }) {
  const adminBaseUrl = process.env.ADMIN_URL || "http://localhost:5173";
  const setupUrl = `${adminBaseUrl}/store/set-password?token=${encodeURIComponent(setupToken)}&email=${encodeURIComponent(email)}`;

  try {
    return await sendTemplatedMail({
      to: email,
      templateSlug: "store-approval",
      variables: {
        ownerName: ownerName || "Partner",
        storeName,
        setupUrl,
        email,
      },
      emailType: "store-approval",
    });
  } catch (err) {
    console.warn(`[Store Email] Template "store-approval" lookup failed, falling back to direct email:`, err.message);
    const subject = `Welcome to SFC Bakers! Set Password for Your Store "${storeName}"`;
    const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
          .header { background: #166534; padding: 32px 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
          .content { padding: 32px 28px; line-height: 1.6; }
          .success-badge { display: inline-block; background: #dcfce7; color: #15803d; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 13px; margin-bottom: 16px; }
          .btn-container { text-align: center; margin: 32px 0; }
          .btn { background-color: #166534; color: #ffffff !important; padding: 14px 32px; border-radius: 10px; font-weight: 600; text-decoration: none; display: inline-block; font-size: 15px; }
          .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
          .expiry-note { font-size: 13px; color: #64748b; font-weight: 500; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to SFC Bakers!</h1>
          </div>
          <div class="content">
            <div style="text-align: center;">
              <span class="success-badge">&#10003; Store Owner Access Ready</span>
            </div>
            <p>Dear <strong>${ownerName || "Partner"}</strong>,</p>
            <p>Congratulations! Your store <strong>${storeName}</strong> has been registered on the <strong>SFC Bakers</strong> platform.</p>
            <p>Please click the button below to set your permanent login password and access your Store Owner Dashboard directly:</p>

            <div class="btn-container">
              <a href="${setupUrl}" class="btn" target="_blank" rel="noopener noreferrer">Set My Password &amp; Access Store</a>
            </div>

            <p class="expiry-note">This secure password setup link is valid for 7 days.</p>
            <p style="font-size: 13px; color: #64748b;">If the button does not work, copy and paste this link into your browser:<br><a href="${setupUrl}" target="_blank" rel="noopener noreferrer" style="color: #166534;">${setupUrl}</a></p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} SFC Bakers. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

    return await sendMail({
      to: email,
      subject,
      html,
      text: `Welcome to SFC Bakers! Your store "${storeName}" has been created. Please set your password using this link: ${setupUrl}`,
      emailType: "store-approval",
    });
  }
}

/**
 * Send password setup link when admin creates a new manager with specific sidebar tab permissions
 */
async function sendManagerInvitationEmail({ email, managerName, permissions = [], setupToken }) {
  const adminBaseUrl = process.env.ADMIN_URL || "http://localhost:5173";
  const setupUrl = `${adminBaseUrl}/store/set-password?token=${encodeURIComponent(setupToken)}&email=${encodeURIComponent(email)}`;

  const TAB_LABELS = {
    dashboard: "Dashboard",
    pos: "POS Counter",
    products: "Products",
    categories: "Categories",
    orders: "All Orders",
    offers: "Offers & Deals",
    stores: "Stores & Partners",
    inventory_ingredients: "Raw Materials",
    inventory_recipes: "Product Recipes",
    inventory_suppliers: "Suppliers & Vendors",
    inventory_logs: "Stock Movement Logs",
    hero_sliders: "Hero Sliders",
    why_choose_us: "Why Choose Us",
    testimonials: "Customer Love",
    reels: "Reels & Videos",
    cms_pages: "CMS Pages",
    customers: "Customer Accounts",
    reviews: "Customer Reviews",
    messages: "Contact Messages",
    email_templates: "Email Templates",
    email_logs: "Email Logs",
    settings: "General Settings",
    favourites: "Favourites",
  };

  const assignedLabels = (Array.isArray(permissions) ? permissions : [])
    .map((key) => TAB_LABELS[key] || key)
    .filter(Boolean);

  const badgesHtml = assignedLabels.length
    ? assignedLabels
        .map(
          (label) =>
            `<span style="display:inline-block;background:#dcfce7;color:#166534;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;margin:3px;">${label}</span>`
        )
        .join(" ")
    : `<span style="font-size:13px;color:#475569;">Assigned Portal Modules</span>`;

  const subject = `Welcome to SFC Bakers! Set Password for Your Manager Account`;
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
          .header { background: #166534; padding: 32px 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
          .content { padding: 32px 28px; line-height: 1.6; }
          .success-badge { display: inline-block; background: #dcfce7; color: #15803d; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 13px; margin-bottom: 16px; }
          .highlight-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px 18px; margin: 20px 0; }
          .highlight-title { font-weight: 700; color: #15803d; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
          .btn-container { text-align: center; margin: 32px 0; }
          .btn { background-color: #166534; color: #ffffff !important; padding: 14px 32px; border-radius: 10px; font-weight: 600; text-decoration: none; display: inline-block; font-size: 15px; }
          .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
          .expiry-note { font-size: 13px; color: #64748b; font-weight: 500; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>SFC Bakers Admin Portal</h1>
          </div>
          <div class="content">
            <div style="text-align: center;">
              <span class="success-badge">&#10003; Manager Account Created</span>
            </div>
            <p>Dear <strong>${managerName || "Manager"}</strong>,</p>
            <p>The Administrator has invited you as a <strong>Manager</strong> on the <strong>SFC Bakers</strong> Admin Portal with access to the following modules:</p>

            <div class="highlight-card">
              <div class="highlight-title">Your Assigned Sidebar Tabs</div>
              <div>${badgesHtml}</div>
            </div>

            <p>Please click the button below to set your login password and access your workspace directly:</p>

            <div class="btn-container">
              <a href="${setupUrl}" class="btn" target="_blank" rel="noopener noreferrer">Set My Password &amp; Sign In</a>
            </div>

            <p class="expiry-note">This secure password setup link is valid for 7 days.</p>
            <p style="font-size: 13px; color: #64748b;">If the button does not work, copy and paste this link into your browser:<br><a href="${setupUrl}" target="_blank" rel="noopener noreferrer" style="color: #166534;">${setupUrl}</a></p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} SFC Bakers. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  return await sendMail({
    to: email,
    subject,
    html,
    text: `Welcome to SFC Bakers! You have been invited as a Manager (${assignedLabels.join(", ")}). Please set your password using this link: ${setupUrl}`,
    emailType: "manager-invitation",
  });
}

module.exports = {
  sendStoreInvitationEmail,
  sendStoreApprovalEmail,
  sendManagerInvitationEmail,
};

