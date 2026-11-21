// Creates .env.core from .env.core.example with freshly generated secrets.
//   node scripts/gen-secrets.mjs            → writes .env.core (refuses to overwrite)
//   node scripts/gen-secrets.mjs --print    → prints the tokens only
// Tokens are shown ONCE here; store them in your password manager.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const hex = (n) => randomBytes(n).toString('hex');
const secrets = { admin: `sa_${hex(24)}`, reviewer: `sr_${hex(24)}`, operator: `so_${hex(24)}`, viewer: `sv_${hex(24)}` };
const pg = hex(24);

if (!process.argv.includes('--print')) {
  if (existsSync('.env.core')) {
    console.error('.env.core already exists — not overwriting. Delete it first if you really want new secrets.');
    process.exit(1);
  }
  const t = readFileSync('.env.core.example', 'utf8')
    .replace('__GENERATE__', pg)
    .replace('__ADMIN__', secrets.admin)
    .replace('__REVIEWER__', secrets.reviewer)
    .replace('__OPERATOR__', secrets.operator)
    .replace('__VIEWER__', secrets.viewer);
  writeFileSync('.env.core', t, { mode: 0o600 });
  console.log('Wrote .env.core (edit DOMAIN, ANTHROPIC_API_KEY, R2_* next).');
}
console.log('\nOps web login tokens (shown once):');
for (const [role, tok] of Object.entries(secrets)) console.log(`  ${role.padEnd(9)} ${tok}`);
