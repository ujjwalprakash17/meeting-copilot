/**
 * One-time copy of a local SQLite history into Supabase, under your Meeting Copilot account.
 *
 *   SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… npm run history:import -w server   (add -- --dry-run to only count)
 *
 * Asks for your account email and password in this terminal (sent only to Supabase Auth). Safe to re-run:
 * rows are upserted and an older card never overwrites a newer one. The SQLite file is left untouched.
 */
/* eslint-disable no-console -- command-line script */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../src/config.js';
import { SqliteHistoryRepository } from '../src/history/SqliteHistoryRepository.js';
import { SupabaseHistoryRepository } from '../src/history/SupabaseHistoryRepository.js';
import type { HistoryOp } from '../src/history/types.js';

const dryRun = process.argv.includes('--dry-run');
const config = loadConfig();
const h = config.history;
if (!h?.supabase?.url || !h.supabase.publishableKey) {
  console.error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (server/.env or the environment) first.');
  process.exit(1);
}
if (!existsSync(h.dbPath)) {
  console.log(`No local history database at ${h.dbPath}; nothing to import.`);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = (await rl.question('Meeting Copilot account email: ')).trim();
const password = await rl.question('Password: ');
rl.close();

const client = createClient(h.supabase.url, h.supabase.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
if (signInError || !signIn.user) {
  console.error(`Sign-in failed: ${signInError?.message ?? 'unknown error'}`);
  process.exit(1);
}
const userId = signIn.user.id;
const sqlite = new SqliteHistoryRepository(h.dbPath);
const target = new SupabaseHistoryRepository({ client, requireUserId: async () => userId });

try {
  console.log(`Importing ${h.dbPath} → ${h.supabase.url} as ${email}${dryRun ? ' (dry run)' : ''}`);
  let conversations = 0;
  let cards = 0;
  let before: number | undefined;
  for (;;) {
    const page = await sqlite.listConversations({ limit: 50, before });
    if (page.length === 0) break;
    for (const summary of page) {
      const full = await sqlite.getConversation(summary.id);
      if (!full) continue;
      const ops: HistoryOp[] = [
        { kind: 'conversation', value: { id: summary.id, at: summary.startedAt, simulated: summary.simulated } },
        ...full.cards.map((value) => ({ kind: 'card' as const, value })),
      ];
      if (!dryRun) {
        await target.applyBatch(ops);
        // Carry over last-activity time and any custom title.
        if (summary.updatedAt > summary.startedAt) await target.applyBatch([{ kind: 'conversation', value: { id: summary.id, at: summary.updatedAt, simulated: summary.simulated } }]);
        if (summary.title) await target.renameConversation(summary.id, summary.title);
      }
      conversations += 1;
      cards += full.cards.length;
    }
    before = page.at(-1)?.updatedAt;
  }
  console.log(`${dryRun ? 'Would import' : 'Imported'} ${conversations} conversation(s) and ${cards} card(s).`);
} catch (err) {
  console.error(`Import failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  sqlite.close();
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
}
