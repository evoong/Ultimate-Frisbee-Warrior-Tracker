import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://pyqngqyqwevfpaxcmfnd.supabase.co'
const supabaseAnonKey = 'sb_publishable_oUie8kxlAp6DD0UPMSG-ZQ_QBEWo3vT'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
