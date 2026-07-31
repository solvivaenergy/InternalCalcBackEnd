// One-off provisioning for the two non-Management admin demo accounts (v3-143).
// Uses the Supabase Admin API (service-role key from .env) — more reliable than
// raw auth.users inserts. Idempotent: re-running updates the password + role.
//
//   node scripts/seed-admin-accounts.mjs
//
// SECURITY: shared demo credentials. Rotate/disable before production use.
import "dotenv/config";
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

const ACCOUNTS = [
  {
    email: "engineering.demo@aboitizpower.com",
    password: "Engr#Solviva2026",
    role: "engineering",
    name: "Engineering Demo",
  },
  {
    email: "consumerfinance.demo@aboitizpower.com",
    password: "Finance#Solviva2026",
    role: "product",
    name: "Consumer Finance Demo",
  },
];

async function findUserByEmail(email) {
  // Paginate defensively in case the project grows past one page.
  for (let page = 1; page <= 20; page++) {
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

async function upsertAccount({ email, password, role, name }) {
  let user = await findUserByEmail(email);

  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: name },
    });
    if (error) throw error;
    user = data.user;
    console.log(`created  ${email}  (${user.id})`);
  } else {
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
    });
    if (error) throw error;
    console.log(`updated  ${email}  (${user.id})`);
  }

  const { error: roleError } = await supabase
    .from("user_roles")
    .upsert(
      { user_id: user.id, role, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (roleError) throw roleError;
  console.log(`  role -> ${role}`);
}

(async () => {
  for (const acct of ACCOUNTS) {
    try {
      await upsertAccount(acct);
    } catch (err) {
      console.error(`FAILED ${acct.email}:`, err.message || err);
      process.exitCode = 1;
    }
  }
})();
