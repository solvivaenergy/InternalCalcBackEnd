// Provisioning for internal staff admin accounts (Management / Engineering /
// Consumer Finance). Uses the Supabase Admin API (service-role key from .env).
// Role is written to public.user_roles.role (admin|engineering|product are all
// permitted by the user_roles_role_check constraint). display_name goes in
// user_metadata for the admin header.
//
//   node scripts/seed-admin-staff.mjs
//
// IDEMPOTENT: an existing account keeps its password (NOT rotated); only role +
// display_name are refreshed. New accounts get a strong random password,
// printed ONCE — copy it before closing the terminal; it is not stored.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// role: 'admin' = all tabs (Management), 'engineering' = Inventory+Engineering,
// 'product' = Product tab only, 'inventory' = Inventory tab only.
// NOTE: the 'inventory' role requires migration 20260731_add_inventory_role.sql
// applied first, else that row is rejected by user_roles_role_check.
const ACCOUNTS = [
  {
    name: "Kevin Cobankiat",
    email: "kevin.cobankiat@aboitizpower.com",
    role: "admin",
  },
  {
    name: "Cristopher Tangpep",
    email: "cristopher.tangpep@aboitizpower.com",
    role: "admin",
  },
  {
    name: "Anjon Perote",
    email: "anjon.perote@aboitizpower.com",
    role: "engineering",
  },
  {
    name: "Christopher Santos",
    email: "christopher.santos@aboitizpower.com",
    role: "product",
  },
  {
    name: "Nabeel Gatchalian",
    email: "nabeel.gatchalian@aboitizpower.com",
    role: "product",
  },
  {
    name: "Rowell Bautista",
    email: "rowell.bautista@aboitizpower.com",
    role: "inventory",
  },
];

function generatePassword() {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digit = "23456789";
  const symbol = "!@#$%^&*";
  const all = upper + lower + digit + symbol;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)];
  for (let i = chars.length; i < 16; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function findUserByEmail(email) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    const hit = data.users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function upsertAccount({ name, email, role }) {
  let user = await findUserByEmail(email);
  let password = null;
  let status;

  if (!user) {
    password = generatePassword();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: name },
    });
    if (error) throw error;
    user = data.user;
    status = "created";
  } else {
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      email_confirm: true,
      user_metadata: { ...user.user_metadata, display_name: name },
    });
    if (error) throw error;
    status = "existing (password unchanged)";
  }

  const { error: roleError } = await supabase
    .from("user_roles")
    .upsert(
      { user_id: user.id, role, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (roleError) throw roleError;

  return { email, name, role, status, password };
}

(async () => {
  console.log(
    `Seeding ${ACCOUNTS.length} staff accounts on ${new URL(url).host}\n`,
  );
  const results = [];
  for (const acct of ACCOUNTS) {
    try {
      const r = await upsertAccount(acct);
      results.push(r);
      console.log(`  ${r.status.padEnd(28)} ${r.email}  ->  ${r.role}`);
    } catch (err) {
      results.push({
        email: acct.email,
        status: "FAILED",
        error: err.message || String(err),
      });
      console.error(`  FAILED  ${acct.email}: ${err.message || err}`);
      process.exitCode = 1;
    }
  }

  const withPassword = results.filter((r) => r.password);
  if (withPassword.length) {
    console.log("\n─── NEW ACCOUNT PASSWORDS (copy now — not stored) ───");
    for (const r of withPassword) console.log(`${r.email}\t${r.password}`);
  }

  const failed = results.filter((r) => r.status === "FAILED");
  const unchanged = results.filter(
    (r) => r.status === "existing (password unchanged)",
  );
  console.log(
    `\nDone. ${withPassword.length} created, ${unchanged.length} existing, ${failed.length} failed.`,
  );
})();
