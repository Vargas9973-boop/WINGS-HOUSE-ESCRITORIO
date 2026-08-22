const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabaseConfig');

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