const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPABASE_URL = 'https://acvsmyvijzqredqmoxti.supabase.co';

const SUPABASE_ANON_KEY = 'sb_publishable_2p9rJ5x8CQWrC-yIlu99mw_Gn2ZsHl9';

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        },

        realtime: {
            transport: WebSocket
        },

        global: {
            headers: {
                'X-Client-Info': 'sistema-ventas-electron'
            }
        }
    }
);

module.exports = supabase;