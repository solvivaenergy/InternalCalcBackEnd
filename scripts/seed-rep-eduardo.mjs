// One-off: provision a single sales rep with an EXPLICIT password.
// Mirrors seed-sales-reps.mjs conventions: role 'rep' in both user_metadata
// and app_metadata (what fetchUserRole reads), 'view' in public.user_roles
// (the production CHECK constraint rejects 'rep'). Unlike the roster script,
// the password here is fixed and is (re)set on every run, including for an
// existing account.
//
//   node scripts/seed-rep-eduardo.mjs
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

const REP = {
  name: "Eduardo Garrovillas",
  email: "eduardo.garrovillas@solvivaenergy.com",
  mobile: "",
};
const PASSWORD = "solviva2026";
const ROLE = "rep";
const TABLE_ROLE = "view";

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

(async () => {
  const userMeta = {
    role: ROLE,
    full_name: REP.name,
    display_name: REP.name,
    mobile: REP.mobile,
  };
  const appMeta = { role: ROLE };

  let user = await findUserByEmail(REP.email);
  let status;

  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: REP.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: userMeta,
      app_metadata: appMeta,
    });
    if (error) throw error;
    user = data.user;
    status = "created";
  } else {
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { ...user.user_metadata, ...userMeta },
      app_metadata: { ...user.app_metadata, ...appMeta },
    });
    if (error) throw error;
    status = "updated (password reset)";
  }

  const { error: roleError } = await supabase.from("user_roles").upsert(
    {
      user_id: user.id,
      role: TABLE_ROLE,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (roleError) throw roleError;

  console.log(
    `${status}: ${REP.email} on ${new URL(url).host} (role '${ROLE}', password '${PASSWORD}')`,
  );
})().catch((err) => {
  console.error("FAILED:", err.message || err);
  process.exit(1);
});
