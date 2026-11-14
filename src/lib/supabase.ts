import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
export const supabaseConfigured = Boolean(url && publishableKey);
export const supabase = supabaseConfigured ? createClient(url!, publishableKey!) : null;
