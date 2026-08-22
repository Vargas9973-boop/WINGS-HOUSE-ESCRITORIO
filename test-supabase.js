const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabaseConfig');

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

async function probar() {
    console.log('\nProbando conexión con Supabase...\n');
    console.log('URL:', SUPABASE_URL);

    const { data, error } = await supabase
        .from('users')
        .select('id, username, role, active')
        .eq('username', 'admin');

    if (error) {
        console.log('\nERROR SUPABASE:\n');
        console.log(error);
        return;
    }

    console.log('\nCONEXIÓN CORRECTA\n');
    console.log('Usuarios encontrados:', data);
}

probar();