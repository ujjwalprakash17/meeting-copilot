/**
 * One-time copy of the local SQLite history into Supabase, under the account signed in on this server.
 *
 *   1. Set HISTORY_BACKEND=supabase, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in server/.env.
 *   2. Start the server and sign in from the extension (Settings → Account), then stop the server.
 *   3. npm run history:import -w server            (add --dry-run to only count)
 *
 * Safe to re-run: rows are upserted, and an older card never overwrites a newer one. The SQLite file is
 * left untouched.
 */
/* eslint-disable no-console -- command-line script */
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { SupabaseAccount } from '../src/account/SupabaseAccount.js';
import { SqliteHistoryRepository } from '../src/history/SqliteHistoryRepository.js';
import { SupabaseHistoryRepository } from '../src/history/SupabaseHistoryRepository.js';
import type { HistoryOp } from '../src/history/types.js';

const dryRun = process.argv.includes('--dry-run');
const config = loadConfig();
const h = config.history;
if (!h?.supabase?.url || !h.supabase.publishableKey) {
  console.error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in server/.env first.');
  process.exit(1);
}
if (!existsSync(h.dbPath)) {
  console.log(`No local history database at ${h.dbPath}; nothing to import.`);
  process.exit(0);
}

const sqlite = new SqliteHistoryRepository(h.dbPath);
const account = new SupabaseAccount({ url: h.supabase.url, publishableKey: h.supabase.publishableKey, sessionPath: h.supabase.sessionPath });
const target = new SupabaseHistoryRepository(account);

try {
  const who = await account.status();
  if (!who.signedIn) throw new Error('Not signed in. Start the server, sign in from the extension (Settings → Account), stop the server and re-run.');
  console.log(`Importing ${h.dbPath} → ${h.supabase.url} as ${who.email}${dryRun ? ' (dry run)' : ''}`);

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
  account.close();
}
