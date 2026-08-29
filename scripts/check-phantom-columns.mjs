// Auditoría de esquema -- busca en TODAS las funciones plpgsql de public
// referencias UPDATE/INSERT INTO a columnas que no existen en la tabla real.
// Es la misma clase de bug que causó, en producción, "column discount of
// relation sales does not exist" (close_table) y "column cerrado_at of
// relation cash_cuts does not exist" (close_cash_cut) -- Postgres no valida
// eso al crear la función (CREATE OR REPLACE FUNCTION no revienta), solo al
// ejecutarla, así que puede quedar dormido hasta que alguien lo dispara en
// producción.
//
// Corre con: node scripts/check-phantom-columns.mjs
// Requiere el Supabase CLI ya autenticado y con el proyecto enlazado
// (mismo `supabase db query --linked` que usa el resto del repo para
// introspección -- ver README/onboarding). Solo lectura -- no modifica nada.
//
// Heurística basada en regex, no un parser SQL real: pensada para dar una
// lista corta de sospechosos a revisar a mano (o descartar por falso
// positivo -- p.ej. una tabla con nombre distinto entre paréntesis, un CTE),
// no un veredicto absoluto.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// --file en vez de pasar el SQL como argumento posicional: en Windows,
// execFileSync con shell:true vuelve a tokenizar el string por espacios
// (cmd.exe), partiendo la query en varios "argumentos inesperados". Un
// archivo temporal evita por completo el problema de quoting entre shells.
function dbQueryJson(sql) {
  const tmpFile = path.join(os.tmpdir(), `phantom-cols-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf8');
  try {
    const out = execFileSync('supabase', ['db', 'query', '--linked', '--file', tmpFile, '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      shell: true
    });
    return JSON.parse(out).rows;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function main() {
  console.log('Descargando funciones plpgsql y columnas reales del remoto enlazado...\n');

  const funcs = dbQueryJson(
    `select p.proname, pg_get_functiondef(p.oid) as def
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.prolang = (select oid from pg_language where lanname='plpgsql');`
  );
  const cols = dbQueryJson(
    `select table_name, column_name from information_schema.columns where table_schema='public';`
  );

  const columnsByTable = {};
  for (const { table_name, column_name } of cols) {
    (columnsByTable[table_name] ||= new Set()).add(column_name);
  }

  const suspects = [];

  for (const { proname, def } of funcs) {
    const updateRe = /UPDATE\s+public\.(\w+)\s+(?:AS\s+\w+\s+)?SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;)/gi;
    let m;
    while ((m = updateRe.exec(def))) {
      const table = m[1];
      const known = columnsByTable[table];
      if (!known) continue;
      let depth = 0, cur = '', parts = [];
      for (const ch of m[2]) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      for (const part of parts) {
        const colMatch = /^\s*(\w+)\s*=/.exec(part);
        if (!colMatch) continue;
        const col = colMatch[1];
        if (!known.has(col)) {
          suspects.push({ func: proname, table, col, kind: 'UPDATE SET', snippet: part.trim().slice(0, 80) });
        }
      }
    }

    const insertRe = /INSERT\s+INTO\s+public\.(\w+)\s*\(([\s\S]*?)\)/gi;
    while ((m = insertRe.exec(def))) {
      const table = m[1];
      const known = columnsByTable[table];
      if (!known) continue;
      const colList = m[2].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
      for (const col of colList) {
        if (/^\w+$/.test(col) && !known.has(col)) {
          suspects.push({ func: proname, table, col, kind: 'INSERT INTO cols' });
        }
      }
    }
  }

  console.log(`Funciones analizadas: ${funcs.length}. Tablas conocidas: ${Object.keys(columnsByTable).length}.\n`);
  if (suspects.length === 0) {
    console.log('✅ Ningún sospechoso de columna fantasma encontrado.');
  } else {
    console.log(`⚠️  ${suspects.length} sospechoso(s):\n`);
    for (const s of suspects) {
      console.log(`- ${s.func}(): ${s.kind} public.${s.table}.${s.col}${s.snippet ? '  -- ' + s.snippet : ''}`);
    }
    process.exitCode = 1;
  }
}

main();
