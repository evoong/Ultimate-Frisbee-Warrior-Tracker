import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SECRET_KEY || ""
);

export async function getOrgEffectiveTier(orgId: number): Promise<'free' | 'plus' | 'premium'> {
  const { data, error } = await supabase.rpc('effective_tier', { p_org_id: orgId });
  if (error) throw error;
  return (data as 'free' | 'plus' | 'premium') || 'free';
}

export async function checkMemberLimit(orgId: number): Promise<boolean> {
  const tier = await getOrgEffectiveTier(orgId);
  if (tier === 'premium') return true;

  const limit = tier === 'plus' ? 35 : 15;
  const { count, error } = await supabase
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('team_id', orgId);

  if (error) throw error;
  return (count ?? 0) < limit;
}

export async function checkAiMessageLimit(orgId: number): Promise<boolean> {
  const tier = await getOrgEffectiveTier(orgId);
  if (tier === 'premium') return true;

  const limit = tier === 'plus' ? 100 : 5;
  const monthKey = new Date().toISOString().slice(0, 7);

  const { data, error } = await supabase
    .from('ai_usage_logs')
    .select('message_count')
    .eq('organization_id', orgId)
    .eq('month_key', monthKey)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  const count = data?.message_count ?? 0;
  return count < limit;
}

export async function incrementAiUsage(orgId: number): Promise<void> {
  const { error } = await supabase.rpc('increment_ai_usage', { p_org_id: orgId });
  if (error) throw error;
}