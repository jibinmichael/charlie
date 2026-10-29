// lib/talent-pool.mjs — read the talent pool for the board (GET /voice/api/pool). READ-ONLY.
//
// Lives outside voice/ on purpose: voice/isolation.test.mjs forbids anything under voice/ from
// touching the email product's tables, and talent_pool is one of them. The columns the board shows
// and the ones the record explains itself with; never the assessment layer (a design score means
// nothing to the board). The table holds nobody who unsubscribed.
//
// Paged: Supabase answers at most 1,000 rows per request, and a single-request read would return
// the first thousand and report nothing missing. The pages run until one comes back short.
export const TALENT_POOL_COLUMNS = "id, email, full_name, phone, linkedin_url, portfolio_url, current_title, current_company, previous_title, previous_company, headline, total_years, roles_count, current_tenure_months, seniority, role_family, city, country, willing_to_relocate, work_mode_pref, notice_period_raw, notice_days, seeking_status, available_from, comp_current, comp_expected, comp_currency, mobility_profile, top_skills, domains, consent_process, consent_share, consent_pool, source_form, source_role, applied_at, completeness, enriched_at";
export const TALENT_POOL_PAGE = 1000;

/**
 * @param {{client:object, limit?:number, page?:number}} p the Supabase client (service role, or the test fake)
 * @returns {Promise<Array<object>>} every row, newest application first
 */
export async function listTalentPool({ client, limit = 5000, page = TALENT_POOL_PAGE }) {
  if (!client) throw new Error("listTalentPool: a client is required");
  const out = [];
  for (let from = 0; from < limit; from += page) {
    const to = Math.min(from + page, limit) - 1;
    const { data, error } = await client.from("talent_pool").select(TALENT_POOL_COLUMNS).order("applied_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
    if (error) throw new Error(`talent_pool read: ${error.message}`);
    out.push(...(data || []));
    if ((data || []).length < to - from + 1) break;
  }
  return out;
}
