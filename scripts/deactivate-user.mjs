// One-off: deactivate a user's credentials via the Supabase Admin API.
// Bans the account (ban_duration) so the login stops working WITHOUT deleting
// the user — fully reversible by setting ban_duration: 'none'. Prints the full
// user roster before and after the change.
//
//   node scripts/deactivate-user.mjs
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

// Target: Raymond Wade Nicolas.
const TARGET_EMAIL = "raymond.nicolas@solvivaenergy.com";
// Effectively permanent ban (~100 years). Reverse with ban_duration: 'none'.
const BAN_DURATION = "876000h";

async function listAllUsers() {
  const users = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 200) break;
  }
  return users;
}

function printRoster(label, users) {
  console.log(`\n─── ${label} (${users.length} users) ───`);
  const rows = users
    .slice()
    .sort((a, b) => (a.email || "").localeCompare(b.email || ""))
    .map((u) => {
      const name =
        u.user_metadata?.display_name || u.user_metadata?.full_name || "";
      const banned =
        u.banned_until && new Date(u.banned_until) > new Date()
          ? "DEACTIVATED"
          : "active";
      return { email: u.email, name, status: banned };
    });
  for (const r of rows) {
    console.log(
      `  ${r.status.padEnd(12)} ${(r.email || "").padEnd(45)} ${r.name}`,
    );
  }
}

(async () => {
  console.log(`Target Supabase host: ${new URL(url).host}`);

  const before = await listAllUsers();
  printRoster("BEFORE", before);

  const target = before.find(
    (u) => u.email?.toLowerCase() === TARGET_EMAIL.toLowerCase(),
  );
  if (!target) {
    console.error(`\nUser not found: ${TARGET_EMAIL}. No changes made.`);
    process.exit(1);
  }

  const { error } = await supabase.auth.admin.updateUserById(target.id, {
    ban_duration: BAN_DURATION,
  });
  if (error) throw error;
  console.log(`\nDeactivated credentials for ${target.email} (${target.id}).`);

  const after = await listAllUsers();
  printRoster("AFTER", after);
})().catch((err) => {
  console.error("\nFAILED:", err.message || err);
  process.exit(1);
});
