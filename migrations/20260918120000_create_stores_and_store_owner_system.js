/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // 1. Create stores table
  const hasStores = await knex.schema.hasTable("stores");
  if (!hasStores) {
    await knex.schema.createTable("stores", (table) => {
      table.increments("id").primary();
      table.string("name").notNullable();
      table.string("slug").unique().notNullable();
      table.integer("owner_id").unsigned().nullable().references("id").inTable("users").onDelete("CASCADE");
      table.string("phone").nullable();
      table.string("email").nullable();
      table.text("address").nullable();
      table.string("city").nullable();
      table.string("state").nullable();
      table.string("pincode").nullable();
      table.decimal("latitude", 10, 8).nullable();
      table.decimal("longitude", 11, 8).nullable();
      table.boolean("is_open").defaultTo(true).notNullable();
      table.boolean("is_active").defaultTo(true).notNullable();
      table.timestamps(true, true);
    });
  } else {
    const hasOwnerId = await knex.schema.hasColumn("stores", "owner_id");
    if (!hasOwnerId) {
      await knex.schema.alterTable("stores", (table) => {
        table.integer("owner_id").unsigned().nullable().references("id").inTable("users").onDelete("CASCADE");
      });
    }
    const hasSlug = await knex.schema.hasColumn("stores", "slug");
    if (!hasSlug) {
      await knex.schema.alterTable("stores", (table) => {
        table.string("slug").nullable();
      });
    }
    const hasIsOpen = await knex.schema.hasColumn("stores", "is_open");
    if (!hasIsOpen) {
      await knex.schema.alterTable("stores", (table) => {
        table.boolean("is_open").defaultTo(true).notNullable();
      });
    }
    const hasIsActive = await knex.schema.hasColumn("stores", "is_active");
    if (!hasIsActive) {
      await knex.schema.alterTable("stores", (table) => {
        table.boolean("is_active").defaultTo(true).notNullable();
      });
    }
  }

  // 2. Create store_categories junction table
  const hasStoreCategories = await knex.schema.hasTable("store_categories");
  if (!hasStoreCategories) {
    await knex.schema.createTable("store_categories", (table) => {
      table.increments("id").primary();
      table.integer("store_id").unsigned().notNullable().references("id").inTable("stores").onDelete("CASCADE");
      table.integer("category_id").unsigned().notNullable().references("id").inTable("categories").onDelete("CASCADE");
      table.unique(["store_id", "category_id"]);
      table.timestamps(true, true);
    });
  }

  // 3. Update users table (add store_id, update role check constraint, allow null password)
  const hasStoreIdInUsers = await knex.schema.hasColumn("users", "store_id");
  if (!hasStoreIdInUsers) {
    await knex.schema.alterTable("users", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }

  // Allow password to be nullable in users table for pending store owners
  await knex.raw(`
    ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
  `);

  // Update check constraint on role to allow 'store_owner'
  await knex.raw(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN 
        SELECT conname 
        FROM pg_constraint 
        WHERE conrelid = 'users'::regclass 
          AND contype = 'c' 
          AND conname LIKE '%role%'
      LOOP
        EXECUTE 'ALTER TABLE users DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
      END LOOP;
    END $$;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'store_owner'));
  `);

  // 4. Create store_login_requests table
  const hasRequests = await knex.schema.hasTable("store_login_requests");
  if (!hasRequests) {
    await knex.schema.createTable("store_login_requests", (table) => {
      table.increments("id").primary();
      table.integer("store_id").unsigned().notNullable().references("id").inTable("stores").onDelete("CASCADE");
      table.integer("user_id").unsigned().notNullable().references("id").inTable("users").onDelete("CASCADE");
      table.string("email").notNullable();
      table.string("status").defaultTo("pending").notNullable(); // 'pending', 'approved', 'rejected'
      table.integer("approved_by").unsigned().nullable().references("id").inTable("users").onDelete("SET NULL");
      table.string("setup_token", 255).nullable();
      table.timestamp("setup_token_expires_at").nullable();
      table.timestamps(true, true);
    });
  }

  // 5. Add store_id to products
  const hasStoreIdInProducts = await knex.schema.hasColumn("products", "store_id");
  if (!hasStoreIdInProducts) {
    await knex.schema.alterTable("products", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }

  // 6. Add store_id to order_items
  const hasStoreIdInOrderItems = await knex.schema.hasColumn("order_items", "store_id");
  if (!hasStoreIdInOrderItems) {
    await knex.schema.alterTable("order_items", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }

  // 7. Add store_id to notifications
  const hasStoreIdInNotifications = await knex.schema.hasColumn("notifications", "store_id");
  if (!hasStoreIdInNotifications) {
    await knex.schema.alterTable("notifications", (table) => {
      table.integer("store_id").unsigned().nullable().references("id").inTable("stores").onDelete("SET NULL");
    });
  }

  // 8. Seed Store Invitation and Access Approval Email Templates
  const hasEmailTemplates = await knex.schema.hasTable("email_templates");
  if (hasEmailTemplates) {
    const storeTemplates = [
      {
        name: "Store Owner Invitation",
        slug: "store-invitation",
        subject: "Welcome to SFC Bakers! Your Store {{storeName}} Has Been Created",
        description: "Official invitation dispatched to a Store Owner upon branch creation.",
        body: `<div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h2 style="color: #166534; margin: 0 0 6px; font-size: 22px;">SFC Bakers Partner Portal</h2>
    <span style="display: inline-block; background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; font-size: 12px; font-weight: 700; padding: 3px 12px; border-radius: 9999px;">Store Registered</span>
  </div>
  <p style="font-size: 14px; color: #334155; line-height: 1.6;">Hello <strong>{{ownerName}}</strong>,</p>
  <p style="font-size: 14px; color: #555; line-height: 1.6;">Congratulations! The Administrator has officially registered your branch on the <strong>SFC Bakers</strong> platform.</p>
  <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 20px; margin: 20px 0;">
    <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Assigned Store Branch</div>
    <div style="font-size: 18px; font-weight: 800; color: #166534; margin-top: 4px;">{{storeName}}</div>
  </div>
  <p style="font-size: 14px; color: #334155; font-weight: 600;">Next Steps to Access Your Account:</p>
  <ol style="font-size: 13.5px; color: #475569; padding-left: 20px; line-height: 1.7;">
    <li>Open the Partner Portal using the button below.</li>
    <li>Click <em>"Store Owner? Request Login Approval"</em> and enter your email: <strong>{{email}}</strong>.</li>
    <li>Once Admin approves your request, you will receive a password setup email.</li>
  </ol>
  <div style="text-align: center; margin: 28px 0;">
    <a href="{{loginUrl}}" style="background: #166534; color: #ffffff; padding: 13px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px; display: inline-block;">Open Partner Portal</a>
  </div>
  <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; margin-top: 24px; text-align: center;">This is an automated notification from SFC Bakers. If you are not the intended recipient, please disregard this email.</p>
</div>`,
        is_active: true,
      },
      {
        name: "Store Owner Access Approval",
        slug: "store-approval",
        subject: "Your Access Request Approved - Set Password for {{storeName}}",
        description: "Dispatches the 24-hour secure password setup link upon admin approval.",
        body: `<div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h2 style="color: #166534; margin: 0 0 6px; font-size: 22px;">Access Request Approved</h2>
    <span style="display: inline-block; background: #dcfce7; color: #15803d; border: 1px solid #86efac; font-size: 12px; font-weight: 700; padding: 3px 12px; border-radius: 9999px;">✓ Admin Approved</span>
  </div>
  <p style="font-size: 14px; color: #334155; line-height: 1.6;">Hello <strong>{{ownerName}}</strong>,</p>
  <p style="font-size: 14px; color: #555; line-height: 1.6;">Great news! The Administrator has reviewed and approved your access request for <strong>{{storeName}}</strong>.</p>
  <p style="font-size: 14px; color: #555; line-height: 1.6;">Please click the button below to set your permanent login password and access your Store Owner Dashboard:</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{setupUrl}}" style="background: #166534; color: #ffffff; padding: 13px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px; display: inline-block;">Set Password &amp; Login</a>
  </div>
  <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 14px; text-align: center; font-size: 12px; color: #991b1b; font-weight: 600;">
    ⏳ This setup link is valid for 24 hours only.
  </div>
  <p style="font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; margin-top: 24px; text-align: center;">If you did not request this access, please contact the administrator immediately.</p>
</div>`,
        is_active: true,
      },
    ];

    for (const t of storeTemplates) {
      const exists = await knex("email_templates").where({ slug: t.slug }).first();
      if (!exists) {
        await knex("email_templates").insert(t);
      }
    }
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  // Drop store_id columns
  if (await knex.schema.hasColumn("notifications", "store_id")) {
    await knex.schema.alterTable("notifications", (table) => table.dropColumn("store_id"));
  }
  if (await knex.schema.hasColumn("order_items", "store_id")) {
    await knex.schema.alterTable("order_items", (table) => table.dropColumn("store_id"));
  }
  if (await knex.schema.hasColumn("products", "store_id")) {
    await knex.schema.alterTable("products", (table) => table.dropColumn("store_id"));
  }
  if (await knex.schema.hasTable("store_login_requests")) {
    await knex.schema.dropTableIfExists("store_login_requests");
  }
  if (await knex.schema.hasColumn("users", "store_id")) {
    await knex.schema.alterTable("users", (table) => table.dropColumn("store_id"));
  }

  // Restore role constraint to user, admin
  await knex.raw(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN 
        SELECT conname 
        FROM pg_constraint 
        WHERE conrelid = 'users'::regclass 
          AND contype = 'c' 
          AND conname LIKE '%role%'
      LOOP
        EXECUTE 'ALTER TABLE users DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
      END LOOP;
    END $$;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  `);

  if (await knex.schema.hasTable("store_categories")) {
    await knex.schema.dropTableIfExists("store_categories");
  }
  if (await knex.schema.hasTable("stores")) {
    await knex.schema.dropTableIfExists("stores");
  }
};

