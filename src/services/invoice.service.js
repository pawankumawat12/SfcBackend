const PDFDocument = require("pdfkit");
const { getFooterSettings, getOrderPricingSettings } = require("../models/settings.model");
const { roundCurrency } = require("../utils/pricing.util");

/**
 * Generates a professional PDF invoice for an order.
 * Pipes the resulting PDF stream to the provided writable stream (e.g. Express res).
 *
 * @param {Object} order - Full order object including items and parsed JSON fields.
 * @param {import("stream").Writable} res - The Express response stream.
 */
async function generateInvoicePdf(order, res) {
  const [footerSettings, pricingSettings] = await Promise.all([
    getFooterSettings().catch(() => ({})),
    getOrderPricingSettings().catch(() => ({})),
  ]);

  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    info: {
      Title: `Invoice #${order.order_number || order.id}`,
      Author: "SFC BAKERS",
      Subject: `Order Invoice ${order.order_number || order.id}`,
    },
  });

  doc.pipe(res);

  const primaryColor = "#1e293b"; // slate-800
  const secondaryColor = "#64748b"; // slate-500
  const borderColor = "#e2e8f0"; // slate-200
  const tableHeaderBg = "#f8fafc"; // slate-50

  const formatCurrency = (amount) => {
    const num = roundCurrency(amount);
    return `Rs. ${Math.round(num)}`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "N/A";
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(dateStr);
    }
  };

  // Header Banner
  doc
    .rect(40, 40, 515, 60)
    .fill(primaryColor);

  doc
    .fontSize(22)
    .font("Helvetica-Bold")
    .fillColor("#ffffff")
    .text("SFC BAKERS", 60, 52);

  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#cbd5e1")
    .text("Fresh & Delicious Food Delivery", 60, 78);

  doc
    .fontSize(16)
    .font("Helvetica-Bold")
    .fillColor("#ffffff")
    .text("TAX INVOICE", 400, 52, { align: "right" });

  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#cbd5e1")
    .text(`Invoice #: ${order.order_number || `ORD-${order.id}`}`, 300, 78, {
      align: "right",
      width: 235,
    });

  let currentY = 115;

  // Cafe details (left) & Invoice metadata (right)
  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(secondaryColor)
    .text("FROM:", 45, currentY);

  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("SFC BAKERS", 45, currentY + 12);

  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#334155")
    .text(footerSettings?.location || "Jaipur, Rajasthan, India", 45, currentY + 26, {
      width: 220,
    })
    .text(`Phone: ${footerSettings?.phone_number || "+91 9876543210"}`, 45, currentY + 48)
    .text(`Email: ${footerSettings?.email || "support@sfcbakers.com"}`, 45, currentY + 60);

  // Metadata block on right
  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(secondaryColor)
    .text("ORDER & PAYMENT DETAILS:", 330, currentY);

  const orderDate = formatDate(order.created_at);
  const paymentMethod = order.payment_method || "Online Payment";
  const paymentStatus = (order.payment_status || "Pending").toUpperCase();
  const orderStatus = (order.status || "placed").toUpperCase();

  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#334155")
    .text("Date Placed:", 330, currentY + 14)
    .font("Helvetica-Bold")
    .text(orderDate, 410, currentY + 14, { align: "right", width: 145 })
    .font("Helvetica")
    .text("Payment Mode:", 330, currentY + 28)
    .font("Helvetica-Bold")
    .text(paymentMethod, 410, currentY + 28, { align: "right", width: 145 })
    .font("Helvetica")
    .text("Payment Status:", 330, currentY + 42)
    .font("Helvetica-Bold")
    .fillColor(paymentStatus === "COMPLETED" || paymentStatus === "PAID" ? "#16a34a" : "#dc2626")
    .text(paymentStatus, 410, currentY + 42, { align: "right", width: 145 })
    .fillColor("#334155")
    .font("Helvetica")
    .text("Order Status:", 330, currentY + 56)
    .font("Helvetica-Bold")
    .text(orderStatus, 410, currentY + 56, { align: "right", width: 145 });

  currentY = 200;

  // Bill To / Delivery Address
  doc
    .rect(40, currentY, 515, 65)
    .fill("#f8fafc")
    .stroke(borderColor);

  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(secondaryColor)
    .text("BILL TO / DELIVER TO:", 52, currentY + 10);

  const customerName = order.customer_name || "Customer";
  const customerPhone = order.customer_phone || "N/A";
  const customerEmail = order.customer_email || "N/A";
  const shippingAddress = order.shipping_address || "Store Pickup";

  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text(customerName, 52, currentY + 22);

  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#334155")
    .text(`Phone: ${customerPhone}  |  Email: ${customerEmail}`, 52, currentY + 36)
    .text(`Address: ${shippingAddress}`, 52, currentY + 48, { width: 490, lineBreak: false });

  currentY = 280;

  // Table Headers
  doc
    .rect(40, currentY, 515, 24)
    .fill(tableHeaderBg)
    .stroke(borderColor);

  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("#", 48, currentY + 7, { width: 25 })
    .text("ITEM DESCRIPTION", 75, currentY + 7, { width: 250 })
    .text("QTY", 330, currentY + 7, { width: 45, align: "center" })
    .text("RATE", 385, currentY + 7, { width: 75, align: "right" })
    .text("AMOUNT", 470, currentY + 7, { width: 75, align: "right" });

  currentY += 24;

  // Items List
  const items = Array.isArray(order.items) ? order.items : [];
  let itemIndex = 1;

  items.forEach((item) => {
    const itemHeight = 22;
    const name = item.name || item.product_name || "Bakery Item";
    const qty = Number(item.quantity) || 1;
    const price = roundCurrency(item.price);
    const itemTotal = item.total != null ? roundCurrency(item.total) : roundCurrency(qty * price);

    doc
      .rect(40, currentY, 515, itemHeight)
      .fill(itemIndex % 2 === 0 ? "#ffffff" : "#fcfcfd")
      .stroke(borderColor);

    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#334155")
      .text(String(itemIndex), 48, currentY + 6, { width: 25 })
      .font("Helvetica-Bold")
      .text(name, 75, currentY + 6, { width: 250, ellipsis: true })
      .font("Helvetica")
      .text(String(qty), 330, currentY + 6, { width: 45, align: "center" })
      .text(formatCurrency(price), 385, currentY + 6, { width: 75, align: "right" })
      .font("Helvetica-Bold")
      .text(formatCurrency(itemTotal), 470, currentY + 6, { width: 75, align: "right" });

    currentY += itemHeight;
    itemIndex += 1;
  });

  currentY += 12;

  // Pricing Calculation Summary Box on right
  const summaryBoxX = 310;
  const summaryWidth = 245;

  const subtotal = roundCurrency(order.subtotal ?? order.subtotal_amount ?? items.reduce((acc, it) => acc + (Number(it.price) * (Number(it.quantity) || 1)), 0));
  const discount = roundCurrency(order.discount ?? order.discount_amount ?? 0);
  const delivery = roundCurrency(order.delivery_fee ?? order.delivery_charge ?? 0);
  const packaging = roundCurrency(order.packaging_fee ?? 0);
  const platform = roundCurrency(order.platform_fee ?? 0);
  const codFee = roundCurrency(order.cod_fee ?? 0);
  const tax = roundCurrency(order.tax_amount ?? 0);
  const grandTotal = roundCurrency(order.total_amount ?? (subtotal - discount + delivery + packaging + platform + codFee + tax));

  const drawSummaryLine = (label, val, isBold = false, color = "#334155") => {
    doc
      .fontSize(8.5)
      .font(isBold ? "Helvetica-Bold" : "Helvetica")
      .fillColor(color)
      .text(label, summaryBoxX, currentY, { width: 140 })
      .text(val, summaryBoxX + 140, currentY, { width: 100, align: "right" });
    currentY += 16;
  };

  drawSummaryLine("Items Subtotal:", formatCurrency(subtotal));

  if (discount > 0) {
    const offerLabel = order.offer_code ? `Discount (${order.offer_code}):` : "Discount:";
    drawSummaryLine(offerLabel, `-${formatCurrency(discount)}`, false, "#16a34a");
  }

  if (delivery > 0) {
    drawSummaryLine("Delivery Charge:", formatCurrency(delivery));
  } else {
    drawSummaryLine("Delivery Charge:", "FREE");
  }

  if (packaging > 0) {
    drawSummaryLine("Packaging & Handling:", formatCurrency(packaging));
  }

  if (tax > 0) {
    const gstRate = pricingSettings?.gst_percent ? ` (${pricingSettings.gst_percent}% GST)` : " (GST)";
    drawSummaryLine(`Taxes & GST${gstRate}:`, formatCurrency(tax));
  }

  // Divider line
  doc
    .moveTo(summaryBoxX, currentY)
    .lineTo(summaryBoxX + summaryWidth, currentY)
    .strokeColor(borderColor)
    .stroke();

  currentY += 6;

  // Grand Total Box
  doc
    .rect(summaryBoxX - 5, currentY, summaryWidth + 10, 26)
    .fill("#fef3c7") // amber-100
    .stroke("#f59e0b");

  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor("#92400e")
    .text("TOTAL AMOUNT:", summaryBoxX + 5, currentY + 7, { width: 130 })
    .fontSize(11)
    .text(formatCurrency(grandTotal), summaryBoxX + 130, currentY + 6, {
      width: 110,
      align: "right",
    });

  // Footer section at bottom
  const footerY = 740;

  doc
    .moveTo(40, footerY)
    .lineTo(555, footerY)
    .strokeColor(borderColor)
    .stroke();

  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor(primaryColor)
    .text("Thank you for ordering with SFC BAKERS!", 40, footerY + 10, {
      align: "center",
      width: 515,
    });

  doc
    .fontSize(7.5)
    .font("Helvetica")
    .fillColor(secondaryColor)
    .text(
      "This is a computer-generated invoice and requires no physical signature. For queries, contact us at " +
        (footerSettings?.email || "support@sfcbakers.com") +
        " or call " +
        (footerSettings?.phone_number || "+91 9876543210"),
      40,
      footerY + 22,
      { align: "center", width: 515 }
    );

  doc.end();
}

module.exports = {
  generateInvoicePdf,
};

