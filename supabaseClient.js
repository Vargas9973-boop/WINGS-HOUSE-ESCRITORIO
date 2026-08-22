const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabaseConfig');

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: false,
            // true desde que db.js.login() establece una sesión real (ver
            // supabase/functions/login) -- sin esto, el access_token expira
            // a la hora (default de Supabase) y las llamadas siguientes
            // quedan silenciosamente como anon en vez de authenticated.
            autoRefreshToken: true,
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